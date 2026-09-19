"""Shared public directory/board service for personal and social hosts.

The on-disk schema is the existing Common schema rooted at
``<data_dir>/common``:

* ``directory.json``
* ``board/<post-id>.json``
* ``board-media/<post-id>.{jpg,png,webp}``
* ``peers/*.json`` (bounded remote actor-key cache)

No post, reply, directory entry, or media object is expired or pruned.  The
only short-lived data is replay metadata embedded in a post record so an exact
reaction retry cannot reverse the first request. Mutations use local and
cross-process file locks, and every installed file is written atomically.
"""

from __future__ import annotations

import hashlib
import json
import fcntl
import sqlite3
import threading
import time
from collections.abc import Callable
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from common_protocol import (
  ATTACHMENT_MIME_EXT,
  CLOCK_SKEW_S,
  MAX_BOARD_ATTACHMENTS,
  MAX_BIO_CHARS,
  MAX_NAME_CHARS,
  MAX_REPLY_TEXT_CHARS,
  ActorVerifier,
  canonical,
  read_envelope,
  valid_host,
  valid_id,
  validate_attachment,
  validate_attachments,
  validate_text_or_attachment,
)
from service_io import atomic_write

BOARD_PAGE_LIMIT = 50
BOARD_REPLY_LIMIT = 200
BOARD_LIKE_LIMIT = 2000
DIRECTORY_LIMIT = 2000
# A host never silently deletes public/user data.  These admission ceilings
# bound durable abuse instead: an operator can raise them after provisioning
# more storage, while existing imported records remain readable at any size.
BOARD_POST_LIMIT = 10_000
# Verification accepts timestamps up to one skew window in the future and
# one in the past. Retain a token for both windows from first receipt, so it
# cannot expire while that same signed envelope is still admissible.
REACTION_REPLAY_TTL_S = 2 * CLOCK_SKEW_S
# Bound per-post metadata; saturation rejects new reactions rather than
# discarding live tokens and making earlier requests replayable.
REACTION_REPLAY_LIMIT = 2048


class CommonPublicStore:
  """The canonical Common public-store implementation."""

  def __init__(self, data_dir: str | Path | Callable[[], str | Path]):
    self._data_dir = data_dir
    self._directory_lock = threading.Lock()
    self._board_lock = threading.Lock()
    self._board_index_lock = threading.Lock()
    self._board_index_ready = False

  def data_dir(self) -> Path:
    value = self._data_dir() if callable(self._data_dir) else self._data_dir
    return Path(value)

  def common_dir(self) -> Path:
    path = self.data_dir() / "common"
    path.mkdir(parents=True, exist_ok=True)
    return path

  def initialize(self) -> None:
    """Create only public storage directories; no network or owner state."""
    self.board_dir()
    self.board_media_dir()
    (self.common_dir() / "peers").mkdir(parents=True, exist_ok=True)

  @contextmanager
  def _mutation_lock(self, local_lock: threading.Lock, name: str):
    """Serialize both threads and the personal/sidecar process boundary."""
    with local_lock:
      lock_dir = self.common_dir() / ".locks"
      lock_dir.mkdir(parents=True, exist_ok=True)
      with (lock_dir / f"{name}.lock").open("a+b") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
          yield
        finally:
          fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

  def directory_path(self) -> Path:
    return self.common_dir() / "directory.json"

  def board_dir(self) -> Path:
    path = self.common_dir() / "board"
    path.mkdir(parents=True, exist_ok=True)
    return path

  def board_index_path(self) -> Path:
    return self.common_dir() / "board-index.sqlite3"

  def board_index_dirty_path(self) -> Path:
    return self.common_dir() / "board-index.dirty"

  def _mark_board_index_dirty(self) -> bool:
    """Invalidate the disposable index before source JSON can change."""
    if self.board_index_dirty_path().is_file():
      # A prior mutation still needs a full scan.  This writer may mirror its
      # own row but must not clear the inherited invalidation.
      return False
    atomic_write(self.board_index_dirty_path(), str(time.time()))
    return True

  def _clear_board_index_dirty(self) -> None:
    try:
      self.board_index_dirty_path().unlink(missing_ok=True)
    except OSError:
      # A retained marker only causes another conservative reconciliation.
      pass

  @contextmanager
  def _board_index(self):
    connection = sqlite3.connect(self.board_index_path(), timeout=5.0)
    try:
      connection.row_factory = sqlite3.Row
      connection.execute("PRAGMA journal_mode=WAL")
      connection.execute("PRAGMA synchronous=NORMAL")
      connection.execute("PRAGMA busy_timeout=5000")
      connection.execute(
        """
        CREATE TABLE IF NOT EXISTS board_posts (
          id TEXT PRIMARY KEY,
          created_at REAL NOT NULL,
          record_json TEXT NOT NULL,
          source_mtime_ns INTEGER NOT NULL,
          source_size INTEGER NOT NULL
        ) WITHOUT ROWID
        """
      )
      connection.execute(
        """
        CREATE INDEX IF NOT EXISTS board_posts_feed
        ON board_posts(created_at DESC, id DESC)
        """
      )
      yield connection
      connection.commit()
    except Exception:
      connection.rollback()
      raise
    finally:
      connection.close()

  @staticmethod
  def _board_record_values(record: dict, stat) -> tuple:
    created_at = record.get("created_at", 0)
    if not isinstance(created_at, (int, float)) or isinstance(created_at, bool):
      created_at = 0
    return (
      str(record.get("id") or ""), float(created_at),
      json.dumps(record, separators=(",", ":")),
      int(stat.st_mtime_ns), int(stat.st_size),
    )

  @staticmethod
  def _upsert_board_record(connection: sqlite3.Connection, values: tuple) -> None:
    connection.execute(
      """
      INSERT INTO board_posts(
        id, created_at, record_json, source_mtime_ns, source_size
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        created_at=excluded.created_at,
        record_json=excluded.record_json,
        source_mtime_ns=excluded.source_mtime_ns,
        source_size=excluded.source_size
      """,
      values,
    )

  def _ensure_board_index(self) -> None:
    """Reconcile the fast read model with the rollback-safe JSON records.

    Reconciliation runs once per service process. The long-lived community
    host therefore scans on startup rather than on every feed request, while a
    rollback to a file-only release can still accept posts and have them
    imported automatically on the next start.
    """
    if self._board_index_ready and not self.board_index_dirty_path().is_file():
      return
    with self._board_index_lock:
      if self._board_index_ready and not self.board_index_dirty_path().is_file():
        return
      # Reconciliation and file mutations share the cross-process board lock,
      # so a late startup scan can never overwrite a newer mirrored mutation.
      with self._mutation_lock(self._board_lock, "board"):
        with self._board_index() as connection:
          existing = {
            row["id"]: (row["source_mtime_ns"], row["source_size"])
            for row in connection.execute(
              "SELECT id, source_mtime_ns, source_size FROM board_posts"
            )
          }
          seen = set()
          invalid = set()
          for path in self.board_dir().glob("*.json"):
            post_id = path.stem
            seen.add(post_id)
            try:
              stat = path.stat()
            except OSError:
              continue
            if existing.get(post_id) == (stat.st_mtime_ns, stat.st_size):
              continue
            try:
              record = self._load_object(path)
            except HTTPException:
              invalid.add(post_id)
              continue
            if record.get("id") != post_id:
              invalid.add(post_id)
              continue
            self._upsert_board_record(
              connection, self._board_record_values(record, stat),
            )
          stale = (set(existing) - seen) | invalid
          connection.executemany(
            "DELETE FROM board_posts WHERE id = ?",
            ((post_id,) for post_id in stale),
          )
        self._clear_board_index_dirty()
      self._board_index_ready = True

  def _refresh_board_index(self, record: dict, path: Path) -> bool:
    """Mirror one committed JSON record; a rebuild repairs cache failures."""
    if not self._board_index_ready:
      return False
    try:
      stat = path.stat()
      with self._board_index() as connection:
        self._upsert_board_record(
          connection, self._board_record_values(record, stat),
        )
      return True
    except (OSError, sqlite3.Error):
      self._board_index_ready = False
      return False

  def _remove_from_board_index(self, post_id: str) -> bool:
    if not self._board_index_ready:
      return False
    try:
      with self._board_index() as connection:
        connection.execute("DELETE FROM board_posts WHERE id = ?", (post_id,))
      return True
    except sqlite3.Error:
      self._board_index_ready = False
      return False

  @staticmethod
  def _present_board_record(raw: dict, viewer: str | None) -> dict:
    post = dict(raw)
    likes = post.pop("likes", {})
    if not isinstance(likes, dict):
      likes = {}
    post["like_count"] = len(likes)
    if viewer is not None:
      post["liked"] = viewer in likes
    replies = post.pop("replies", [])
    if not isinstance(replies, list):
      replies = []
    post["reply_count"] = len(replies)
    post.pop("_reaction_replays", None)
    return post

  def _read_board_files(
    self, limit: int, before: float | None, viewer: str | None,
  ) -> list[dict]:
    """Availability fallback used only when the disposable index is broken."""
    posts = []
    for file in self.board_dir().glob("*.json"):
      try:
        raw = self._load_object(file)
      except HTTPException:
        continue
      if before is not None and raw.get("created_at", 0) >= before:
        continue
      posts.append(self._present_board_record(raw, viewer))
    posts.sort(key=lambda post: post.get("created_at", 0), reverse=True)
    return posts[:limit]

  def _board_count(self) -> int:
    if not self._board_index_ready:
      return sum(1 for _ in self.board_dir().glob("*.json"))
    try:
      with self._board_index() as connection:
        row = connection.execute("SELECT COUNT(*) AS count FROM board_posts").fetchone()
      return int(row["count"])
    except sqlite3.Error:
      self._board_index_ready = False
      return sum(1 for _ in self.board_dir().glob("*.json"))

  def board_media_dir(self) -> Path:
    path = self.common_dir() / "board-media"
    path.mkdir(parents=True, exist_ok=True)
    return path

  def board_media_path(self, post_id: str, mime: str) -> Path:
    return self.board_media_dir() / f"{post_id}.{ATTACHMENT_MIME_EXT[mime]}"

  @staticmethod
  def find_image(directory: Path, stem: str) -> tuple[Path, str] | None:
    for mime, extension in ATTACHMENT_MIME_EXT.items():
      path = directory / f"{stem}.{extension}"
      if path.is_file():
        return path, mime
    return None

  @staticmethod
  def serve_image(found: tuple[Path, str] | None) -> FileResponse:
    if found is None:
      raise HTTPException(status_code=404, detail="Board image not found.")
    path, mime = found
    return FileResponse(
      str(path), media_type=mime,
      headers={"X-Content-Type-Options": "nosniff"},
    )

  @staticmethod
  def _load_object(path: Path) -> dict:
    if not path.is_file():
      return {}
    try:
      value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
      raise HTTPException(status_code=500, detail="Public data record is invalid.") from exc
    if not isinstance(value, dict):
      raise HTTPException(status_code=500, detail="Public data record is invalid.")
    return value

  def search_directory(self, query: str = "") -> dict:
    entries = self._load_object(self.directory_path())
    needle = query.strip().lower()
    results = []
    for host, entry in entries.items():
      if not isinstance(host, str) or not isinstance(entry, dict):
        continue
      handle = entry.get("handle") if isinstance(entry.get("handle"), str) else ""
      bio = entry.get("bio") if isinstance(entry.get("bio"), str) else ""
      if needle and needle not in f"{handle} {host} {bio}".lower():
        continue
      result = {"host": host}
      if "handle" in entry:
        result["handle"] = handle
      if "bio" in entry:
        result["bio"] = bio
      results.append(result)
    results.sort(key=lambda entry: (entry.get("handle") or entry["host"]).lower())
    return {"users": results[:200]}

  def register(self, host: str, handle: str, bio: str) -> dict:
    with self._mutation_lock(self._directory_lock, "directory"):
      path = self.directory_path()
      entries = self._load_object(path)
      if host not in entries and len(entries) >= DIRECTORY_LIMIT:
        raise HTTPException(status_code=507, detail="Directory is full.")
      entries[host] = {
        "handle": handle,
        "bio": bio,
        "registered_at": time.time(),
      }
      atomic_write(path, json.dumps(entries, indent=2))
    return {"status": "registered"}

  def read_board(
    self, limit: int, before: float | None, viewer: str | None = None,
  ) -> list[dict]:
    try:
      self._ensure_board_index()
      where = "WHERE created_at < ?" if before is not None else ""
      parameters = (before, limit) if before is not None else (limit,)
      with self._board_index() as connection:
        rows = connection.execute(
          f"""
          SELECT record_json FROM board_posts
          {where}
          ORDER BY created_at DESC, id DESC
          LIMIT ?
          """,
          parameters,
        ).fetchall()
      return [
        self._present_board_record(json.loads(row["record_json"]), viewer)
        for row in rows
      ]
    except (json.JSONDecodeError, sqlite3.Error):
      self._board_index_ready = False
      return self._read_board_files(limit, before, viewer)

  def board_media_index_path(self, post_id: str, index: int, mime: str) -> Path:
    return self.board_media_dir() / f"{post_id}-{index}.{ATTACHMENT_MIME_EXT[mime]}"

  def board_image(self, post_id: str, index: int | None = None) -> tuple[Path, str] | None:
    """Locate one stored board image. index=None means the first/legacy image."""
    directory = self.board_media_dir()
    if index is None:
      return self.find_image(directory, f"{post_id}-0") or self.find_image(directory, post_id)
    return self.find_image(directory, f"{post_id}-{index}")

  def store_post(
    self, post: dict, attachment: tuple[dict, bytes] | None = None,
    attachments: list[tuple[dict, bytes]] | None = None,
  ) -> bool:
    """Store once by stable id; return False without changing a duplicate.

    A post may carry a small gallery (`attachments`) written as
    ``<id>-<index>.<ext>``; a legacy single `attachment` is written as
    ``<id>.<ext>``. `attachments` also records a single `attachment` (its first
    image) so a reader that only understands one image still shows something.
    """
    try:
      self._ensure_board_index()
    except sqlite3.Error:
      self._board_index_ready = False
    with self._mutation_lock(self._board_lock, "board"):
      path = self.board_dir() / f"{post['id']}.json"
      if path.is_file():
        return False
      if self._board_count() >= BOARD_POST_LIMIT:
        raise HTTPException(status_code=507, detail="Board is full.")
      record = dict(post)
      if attachments:
        metas = []
        for index, (wire, data) in enumerate(attachments):
          atomic_write(self.board_media_index_path(post["id"], index, wire["mime"]), data)
          metas.append({"mime": wire["mime"], "w": wire["w"], "h": wire["h"]})
        record["attachments"] = metas
        record["attachment"] = metas[0]
      elif attachment is not None:
        wire, data = attachment
        atomic_write(self.board_media_path(post["id"], wire["mime"]), data)
        record["attachment"] = {
          "mime": wire["mime"], "w": wire["w"], "h": wire["h"],
        }
      owns_dirty_marker = self._mark_board_index_dirty()
      atomic_write(path, json.dumps(record))
      if self._refresh_board_index(record, path) and owns_dirty_marker:
        self._clear_board_index_dirty()
      return True

  def toggle_like(
    self, post_id: str, host: str, *, replay_token: str | None = None,
  ) -> dict:
    """Toggle a like once, making an exact signed-envelope retry idempotent."""
    try:
      self._ensure_board_index()
    except sqlite3.Error:
      self._board_index_ready = False
    with self._mutation_lock(self._board_lock, "board"):
      path = self.board_dir() / f"{post_id}.json"
      if not path.is_file():
        raise HTTPException(status_code=404, detail="Unknown post.")
      post = self._load_object(path)
      likes = post.setdefault("likes", {})
      if not isinstance(likes, dict):
        likes = {}
        post["likes"] = likes
      author_host = post.get("host")
      now = time.time()
      if replay_token is not None:
        journal = post.setdefault("_reaction_replays", {})
        if not isinstance(journal, dict):
          journal = {}
          post["_reaction_replays"] = journal
        live = {
          token: expiry for token, expiry in journal.items()
          if isinstance(token, str)
          and isinstance(expiry, (int, float)) and not isinstance(expiry, bool)
          and expiry >= now
        }
        if replay_token in live:
          return {
            "status": "ok", "likes": len(likes), "liked": host in likes,
            "author_host": author_host, "activity": False,
          }
        if len(live) >= REACTION_REPLAY_LIMIT:
          raise HTTPException(status_code=429, detail="Reaction replay journal is full.")
        live[replay_token] = now + REACTION_REPLAY_TTL_S
        post["_reaction_replays"] = live
      if host not in likes and len(likes) >= BOARD_LIKE_LIMIT:
        raise HTTPException(status_code=507, detail="Post reaction limit reached.")
      added = host not in likes
      if host in likes:
        del likes[host]
      else:
        likes[host] = now
      owns_dirty_marker = self._mark_board_index_dirty()
      atomic_write(path, json.dumps(post))
      if self._refresh_board_index(post, path) and owns_dirty_marker:
        self._clear_board_index_dirty()
      # `activity` is True only for a genuine new like (not an unlike or a
      # replay), so the router notifies the post's author exactly once.
      return {
        "status": "ok", "likes": len(likes), "liked": host in likes,
        "author_host": author_host, "activity": added,
      }

  def add_reply(
    self, post_id: str, reply_id: str, host: str, handle: str,
    text: str, created_at: float,
  ) -> dict:
    try:
      self._ensure_board_index()
    except sqlite3.Error:
      self._board_index_ready = False
    with self._mutation_lock(self._board_lock, "board"):
      path = self.board_dir() / f"{post_id}.json"
      if not path.is_file():
        raise HTTPException(status_code=404, detail="Unknown post.")
      post = self._load_object(path)
      author_host = post.get("host")
      replies = post.get("replies")
      if not isinstance(replies, list):
        replies = []
        post["replies"] = replies
      if any(isinstance(reply, dict) and reply.get("id") == reply_id for reply in replies):
        return {
          "status": "ok", "reply_count": len(replies),
          "author_host": author_host, "activity": False,
        }
      if len(replies) >= BOARD_REPLY_LIMIT:
        raise HTTPException(status_code=507, detail="Post reply limit reached.")
      replies.append({
        "id": reply_id,
        "host": host,
        "handle": handle,
        "text": text,
        "created_at": created_at,
      })
      owns_dirty_marker = self._mark_board_index_dirty()
      atomic_write(path, json.dumps(post))
      if self._refresh_board_index(post, path) and owns_dirty_marker:
        self._clear_board_index_dirty()
      return {
        "status": "ok", "reply_count": len(replies),
        "author_host": author_host, "activity": True,
      }

  def get_replies(self, post_id: str) -> dict:
    path = self.board_dir() / f"{post_id}.json"
    if not path.is_file():
      raise HTTPException(status_code=404, detail="Unknown post.")
    post = self._load_object(path)
    replies = post.get("replies")
    if not isinstance(replies, list):
      replies = []
    return {
      "replies": sorted(
        replies,
        key=lambda reply: reply.get("created_at", 0) if isinstance(reply, dict) else 0,
      )
    }

  def delete_post(self, post_id: str, host: str) -> dict:
    """Delete one post its own author asked to remove, and its media.

    This is a deliberate author action, not the silent expiry/pruning the module
    invariant forbids: only the host that authored the post may remove it, and a
    repeat of the same delete is idempotent so a retry cannot error. Replies from
    other hosts live inside the post record and are removed with it.
    """
    try:
      self._ensure_board_index()
    except sqlite3.Error:
      self._board_index_ready = False
    with self._mutation_lock(self._board_lock, "board"):
      path = self.board_dir() / f"{post_id}.json"
      if not path.is_file():
        return {"status": "deleted"}
      post = self._load_object(path)
      if post.get("host") != host:
        raise HTTPException(
          status_code=403,
          detail="Only the author host may delete this post.",
        )
      # Remove the legacy single image and every gallery image (<id>-<n>.<ext>).
      stems = [post_id] + [f"{post_id}-{i}" for i in range(MAX_BOARD_ATTACHMENTS)]
      for stem in stems:
        found = self.find_image(self.board_media_dir(), stem)
        if found is not None:
          try:
            found[0].unlink()
          except OSError:
            pass
      try:
        owns_dirty_marker = self._mark_board_index_dirty()
        path.unlink()
      except OSError as exc:
        raise HTTPException(
          status_code=500, detail="The post could not be deleted."
        ) from exc
      if self._remove_from_board_index(post_id) and owns_dirty_marker:
        self._clear_board_index_dirty()
      return {"status": "deleted"}


def create_public_router(
  store: CommonPublicStore, verifier: ActorVerifier, *, prefix: str = "",
  on_activity=None,
) -> tuple[APIRouter, None]:
  """Build the exact public-host surface shared by both runtimes.

  ``on_activity(kind, author_host, actor_host, actor_handle, post_id)`` is an
  optional awaitable the host calls after a genuine new like or reply, so it can
  tell the post's author (locally or via federation) that their post got
  activity. It never changes the peer-facing response.
  """
  router = APIRouter(prefix=prefix, tags=["common-public"])

  @router.get("/directory")
  def search_directory(q: str = ""):
    return store.search_directory(q)

  @router.post("/directory")
  async def register_in_directory(request: Request):
    envelope = await read_envelope(request)
    if envelope.get("v") != 0 or envelope.get("type") != "register":
      raise HTTPException(status_code=400, detail="Unsupported envelope type.")
    actor = await verifier.verify_envelope(envelope)
    handle = envelope.get("handle") or actor.get("handle") or ""
    bio = envelope.get("bio") or ""
    if (
      not isinstance(handle, str) or len(handle) > MAX_NAME_CHARS
      or not isinstance(bio, str) or len(bio) > MAX_BIO_CHARS
    ):
      raise HTTPException(status_code=400, detail="Directory profile is invalid.")
    return store.register(envelope["from"], handle, bio)

  @router.get("/board")
  def get_board(
    limit: int = 30, before: float | None = None, viewer: str | None = None,
  ):
    if viewer is not None and not valid_host(viewer):
      viewer = None
    return {
      "posts": store.read_board(
        min(max(limit, 1), BOARD_PAGE_LIMIT), before, viewer,
      )
    }

  @router.get("/board/media/{post_id}")
  def get_board_media(post_id: str):
    if not valid_id(post_id):
      raise HTTPException(status_code=400, detail="Post id is invalid.")
    return store.serve_image(store.board_image(post_id))

  @router.get("/board/media/{post_id}/{index}")
  def get_board_media_at(post_id: str, index: int):
    if not valid_id(post_id):
      raise HTTPException(status_code=400, detail="Post id is invalid.")
    if not 0 <= index < MAX_BOARD_ATTACHMENTS:
      raise HTTPException(status_code=400, detail="Image index is invalid.")
    return store.serve_image(store.board_image(post_id, index))

  @router.get("/board/{post_id}/replies")
  def get_board_replies(post_id: str):
    if not valid_id(post_id):
      raise HTTPException(status_code=400, detail="Post id is invalid.")
    return store.get_replies(post_id)

  @router.post("/board/react")
  async def react_to_board(request: Request):
    envelope = await read_envelope(request)
    if envelope.get("v") != 0 or envelope.get("type") != "board_react":
      raise HTTPException(status_code=400, detail="Unsupported envelope type.")
    post_id = envelope.get("post_id")
    if not valid_id(post_id):
      raise HTTPException(status_code=400, detail="Post id is invalid.")
    actor = await verifier.verify_envelope(envelope)
    replay_token = hashlib.sha256(canonical(envelope)).hexdigest()
    result = store.toggle_like(
      post_id, envelope["from"], replay_token=replay_token,
    )
    author_host = result.pop("author_host", None)
    if on_activity and result.pop("activity", False) and author_host:
      await on_activity(
        "like", author_host, envelope["from"], actor.get("handle") or "", post_id,
      )
    return result

  @router.post("/board/reply")
  async def reply_to_board(request: Request):
    envelope = await read_envelope(request)
    if envelope.get("v") != 0 or envelope.get("type") != "board_reply":
      raise HTTPException(status_code=400, detail="Unsupported envelope type.")
    post_id = envelope.get("post_id")
    reply_id = envelope.get("id")
    if not valid_id(post_id):
      raise HTTPException(status_code=400, detail="Post id is invalid.")
    if not valid_id(reply_id):
      raise HTTPException(status_code=400, detail="Reply id is invalid.")
    text = envelope.get("text")
    if (
      not isinstance(text, str) or not text.strip()
      or len(text) > MAX_REPLY_TEXT_CHARS
    ):
      raise HTTPException(status_code=400, detail="Reply text is invalid.")
    actor = await verifier.verify_envelope(envelope)
    result = store.add_reply(
      post_id, reply_id, envelope["from"], actor.get("handle") or "",
      text, envelope["sent_at"],
    )
    author_host = result.pop("author_host", None)
    if on_activity and result.pop("activity", False) and author_host:
      await on_activity(
        "reply", author_host, envelope["from"], actor.get("handle") or "", post_id,
      )
    return result

  @router.post("/board/delete")
  async def delete_from_board(request: Request):
    envelope = await read_envelope(request)
    if envelope.get("v") != 0 or envelope.get("type") != "board_delete":
      raise HTTPException(status_code=400, detail="Unsupported envelope type.")
    post_id = envelope.get("post_id")
    if not valid_id(post_id):
      raise HTTPException(status_code=400, detail="Post id is invalid.")
    await verifier.verify_envelope(envelope)
    return store.delete_post(post_id, envelope["from"])

  @router.post("/board")
  async def post_to_board(request: Request):
    envelope = await read_envelope(request)
    if envelope.get("v") != 0 or envelope.get("type") != "board_post":
      raise HTTPException(status_code=400, detail="Unsupported envelope type.")
    attachment = validate_attachment(envelope.get("attachment"))
    attachments = validate_attachments(envelope.get("attachments"))
    text = envelope.get("text")
    first = attachment or (attachments[0] if attachments else None)
    validate_text_or_attachment(text, first, "Post text is invalid.")
    post_id = envelope.get("id")
    if not valid_id(post_id):
      raise HTTPException(status_code=400, detail="Post id is invalid.")
    actor = await verifier.verify_envelope(envelope)
    store.store_post({
      "id": post_id,
      "host": envelope["from"],
      "handle": actor.get("handle") or "",
      "text": text,
      "created_at": envelope["sent_at"],
      "replies": [],
    }, attachment, attachments)
    return {"status": "posted"}

  return router, None


__all__ = [
  "BOARD_LIKE_LIMIT", "BOARD_PAGE_LIMIT", "BOARD_POST_LIMIT", "BOARD_REPLY_LIMIT",
  "CommonPublicStore", "DIRECTORY_LIMIT", "REACTION_REPLAY_LIMIT",
  "REACTION_REPLAY_TTL_S", "create_public_router",
]
