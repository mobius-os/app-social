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

import base64
import binascii
import hashlib
import io
import json
import fcntl
import math
import sqlite3
import threading
import time
from collections.abc import Callable
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from PIL import Image, ImageOps

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
BOARD_REACTION_EMOJIS = (
  "❤️", "👍", "👎", "😂", "😮", "😢", "😡", "🎉", "🚀", "👀", "🙌", "🔥",
  "✅", "💯", "🤔", "👏", "🙏", "💪", "🤝", "✨", "😍", "🤯", "🫡", "🫶",
)
BOARD_THUMBNAIL_MAX_SIDE = 640
BOARD_THUMBNAIL_MAX_PIXELS = 24_000_000
IMAGE_FORMAT_MIME = {
  "JPEG": "image/jpeg",
  "PNG": "image/png",
  "WEBP": "image/webp",
}


class BoardImageTooLarge(ValueError):
  """A raster must be rejected before decoding or storing its media."""


def _open_board_image(data: bytes) -> Image.Image:
  try:
    return Image.open(io.BytesIO(data))
  except Image.DecompressionBombError as exc:
    # Pillow can reject the header before our stricter pixel limit runs.
    raise BoardImageTooLarge("Board image dimensions are too large.") from exc


def _validate_image_header(
  image: Image.Image, max_pixels: int = BOARD_THUMBNAIL_MAX_PIXELS,
) -> None:
  if image.format not in IMAGE_FORMAT_MIME:
    raise ValueError("Board image format is unsupported.")
  if image.width * image.height > max_pixels:
    raise BoardImageTooLarge("Board image dimensions are too large.")


def image_thumbnail_bytes(
  data: bytes, max_side: int = BOARD_THUMBNAIL_MAX_SIDE,
  max_pixels: int = BOARD_THUMBNAIL_MAX_PIXELS,
) -> tuple[str, bytes]:
  """Create a small, display-ready, header-validated rendition.

  `max_side` bounds the long edge (board timelines use the default; avatars pass
  a smaller cap). The same header/decompression-bomb guards run either way, so
  every caller re-encodes untrusted image bytes through one validated path.
  """
  with _open_board_image(data) as opened:
    # Reject oversized inputs from their header before EXIF transposition or
    # decoding can allocate the full raster.
    _validate_image_header(opened, max_pixels)
    image = ImageOps.exif_transpose(opened)
    image.thumbnail(
      (max_side, max_side),
      Image.Resampling.LANCZOS,
    )
    has_alpha = image.mode in ("RGBA", "LA") or (
      image.mode == "P" and "transparency" in image.info
    )
    prepared = image.convert("RGBA" if has_alpha else "RGB")
    output = io.BytesIO()
    prepared.save(output, format="WEBP", quality=72, method=4)
    return "image/webp", output.getvalue()


def validate_thumbnail_bytes(wire: dict, data: bytes) -> None:
  """Verify a client-made thumbnail before it becomes served media."""
  with _open_board_image(data) as image:
    _validate_image_header(image)
    if max(image.size) > BOARD_THUMBNAIL_MAX_SIDE:
      raise ValueError("Board thumbnail dimensions are too large.")
    if IMAGE_FORMAT_MIME[image.format] != wire["mime"]:
      raise ValueError("Board thumbnail media type does not match its data.")
    if image.size != (wire["w"], wire["h"]):
      raise ValueError("Board thumbnail dimensions do not match its data.")
    image.verify()


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
  def _board_index(self, *, initialize: bool = False):
    connection = sqlite3.connect(self.board_index_path(), timeout=5.0)
    try:
      connection.row_factory = sqlite3.Row
      connection.execute("PRAGMA synchronous=NORMAL")
      connection.execute("PRAGMA busy_timeout=5000")
      if initialize:
        connection.execute("PRAGMA journal_mode=WAL")
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
        with self._board_index(initialize=True) as connection:
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
    reactions = CommonPublicStore._reaction_hosts(post)
    post.pop("likes", None)
    post.pop("reactions", None)
    heart = reactions.get("❤️", {})
    post["like_count"] = len(heart)
    if viewer is not None:
      post["liked"] = viewer in heart
    post["reactions"] = [
      {
        "emoji": emoji,
        "count": len(reactions.get(emoji, {})),
        "reacted": bool(viewer and viewer in reactions.get(emoji, {})),
      }
      for emoji in BOARD_REACTION_EMOJIS
      if reactions.get(emoji)
    ]
    replies = post.pop("replies", [])
    if not isinstance(replies, list):
      replies = []
    post["reply_count"] = len(replies)
    seen_hosts = set()
    reply_authors = []
    for reply in reversed(replies):
      if not isinstance(reply, dict):
        continue
      host = str(reply.get("host") or "")
      if not host or host in seen_hosts:
        continue
      seen_hosts.add(host)
      reply_authors.append({
        "host": host,
        "handle": str(reply.get("handle") or ""),
      })
      if len(reply_authors) == 3:
        break
    post["reply_authors"] = reply_authors
    post.pop("_reaction_replays", None)
    return post

  def _read_board_files(
    self, limit: int, before: tuple[float, str] | None, viewer: str | None,
  ) -> list[dict]:
    """Availability fallback used only when the disposable index is broken."""
    posts = []
    for file in self.board_dir().glob("*.json"):
      try:
        raw = self._load_object(file)
      except HTTPException:
        continue
      created_at = raw.get("created_at", 0)
      if not isinstance(created_at, (int, float)) or isinstance(created_at, bool):
        created_at = 0
      position = (float(created_at), str(raw.get("id") or ""))
      if before is not None and position >= before:
        continue
      posts.append((position, self._present_board_record(raw, viewer)))
    posts.sort(key=lambda item: item[0], reverse=True)
    return [post for _position, post in posts[:limit]]

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

  def board_thumbnail_dir(self) -> Path:
    path = self.common_dir() / "board-thumbnails"
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
    self, limit: int, before: tuple[float, str] | None,
    viewer: str | None = None,
  ) -> list[dict]:
    try:
      self._ensure_board_index()
      where = "WHERE (created_at, id) < (?, ?)" if before is not None else ""
      parameters = (*before, limit) if before is not None else (limit,)
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

  def board_thumbnail(self, post_id: str, index: int | None = None) -> tuple[Path, str] | None:
    """Return a cached thumbnail, lazily backfilling older image posts."""
    stem = f"{post_id}-{0 if index is None else index}"
    found = self.find_image(self.board_thumbnail_dir(), stem)
    if found is not None:
      return found
    source = self.board_image(post_id, index)
    if source is None:
      return None
    try:
      mime, data = image_thumbnail_bytes(source[0].read_bytes())
      target = self.board_thumbnail_dir() / f"{stem}.{ATTACHMENT_MIME_EXT[mime]}"
      atomic_write(target, data)
      return target, mime
    except BoardImageTooLarge as exc:
      # Do not let owner serving fall back to this oversized original.
      raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (OSError, ValueError, SyntaxError, Image.UnidentifiedImageError):
      return None

  def _write_board_thumbnail(self, post_id: str, index: int, data: bytes) -> None:
    try:
      mime, thumbnail = image_thumbnail_bytes(data)
      target = self.board_thumbnail_dir() / f"{post_id}-{index}.{ATTACHMENT_MIME_EXT[mime]}"
      atomic_write(target, thumbnail)
    except (OSError, ValueError, SyntaxError, Image.UnidentifiedImageError):
      # The durable full image remains valid even if its optional rendition
      # cannot be generated; the serving path falls back to that original.
      return

  def store_post(
    self, post: dict, attachment: tuple[dict, bytes] | None = None,
    attachments: list[tuple[dict, bytes]] | None = None,
    thumbnails: list[tuple[dict, bytes]] | None = None,
  ) -> bool:
    """Store once by stable id; return False without changing a duplicate.

    A post may carry a small gallery (`attachments`) written as
    ``<id>-<index>.<ext>``; a legacy single `attachment` is written as
    ``<id>.<ext>``. `attachments` also records a single `attachment` (its first
    image) so a reader that only understands one image still shows something.
    """
    # Inspect all original headers before writing any media. Optional
    # thumbnail failures still preserve ordinary legacy image posts, but an
    # oversized raster must not leave an orphan image or become a fallback.
    for _wire, data in attachments or ([attachment] if attachment else []):
      try:
        with _open_board_image(data) as image:
          _validate_image_header(image)
      except BoardImageTooLarge as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
      except (OSError, ValueError, SyntaxError, Image.UnidentifiedImageError):
        pass
    image_count = len(attachments) if attachments else (1 if attachment else 0)
    if thumbnails and len(thumbnails) != image_count:
      raise HTTPException(status_code=400, detail="Post thumbnails are invalid.")
    try:
      for wire, data in thumbnails or []:
        validate_thumbnail_bytes(wire, data)
    except (OSError, ValueError, Image.UnidentifiedImageError) as exc:
      raise HTTPException(status_code=400, detail="Post thumbnail is invalid.") from exc
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
          if thumbnails and index < len(thumbnails):
            thumb_wire, thumb_data = thumbnails[index]
            target = self.board_thumbnail_dir() / (
              f"{post['id']}-{index}.{ATTACHMENT_MIME_EXT[thumb_wire['mime']]}"
            )
            atomic_write(target, thumb_data)
          else:
            self._write_board_thumbnail(post["id"], index, data)
          metas.append({"mime": wire["mime"], "w": wire["w"], "h": wire["h"]})
        record["attachments"] = metas
        record["attachment"] = metas[0]
      elif attachment is not None:
        wire, data = attachment
        atomic_write(self.board_media_path(post["id"], wire["mime"]), data)
        if thumbnails:
          thumb_wire, thumb_data = thumbnails[0]
          target = self.board_thumbnail_dir() / f"{post['id']}-0.{ATTACHMENT_MIME_EXT[thumb_wire['mime']]}"
          atomic_write(target, thumb_data)
        else:
          self._write_board_thumbnail(post["id"], 0, data)
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
    """Compatibility wrapper for the original single-heart reaction."""
    result = self.toggle_reaction(
      post_id, host, "❤️", replay_token=replay_token,
    )
    return {
      "status": result["status"],
      "likes": result["reaction_counts"].get("❤️", 0),
      "liked": "❤️" in result["reacted"],
      "author_host": result.get("author_host"),
      "activity": result.get("activity", False),
    }

  @staticmethod
  def _reaction_hosts(post: dict) -> dict[str, dict]:
    reactions = post.get("reactions")
    reactions = dict(reactions) if isinstance(reactions, dict) else {}
    normalized = {
      emoji: dict(hosts) for emoji, hosts in reactions.items()
      if emoji in BOARD_REACTION_EMOJIS and isinstance(hosts, dict)
    }
    likes = post.get("likes")
    if isinstance(likes, dict) and likes:
      heart = normalized.setdefault("❤️", {})
      for host, created_at in likes.items():
        if isinstance(host, str):
          heart.setdefault(host, created_at)
    return normalized

  def toggle_reaction(
    self, post_id: str, host: str, emoji: str,
    *, replay_token: str | None = None,
  ) -> dict:
    """Toggle one standard emoji reaction with idempotent envelope retries."""
    if emoji not in BOARD_REACTION_EMOJIS:
      raise HTTPException(status_code=400, detail="Reaction is not supported.")
    try:
      self._ensure_board_index()
    except sqlite3.Error:
      self._board_index_ready = False
    with self._mutation_lock(self._board_lock, "board"):
      path = self.board_dir() / f"{post_id}.json"
      if not path.is_file():
        raise HTTPException(status_code=404, detail="Unknown post.")
      post = self._load_object(path)
      reactions = self._reaction_hosts(post)
      hosts = reactions.setdefault(emoji, {})
      post["reactions"] = reactions
      post.pop("likes", None)
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
            "status": "ok",
            "reaction_counts": {key: len(value) for key, value in reactions.items()},
            "reacted": [key for key, value in reactions.items() if host in value],
            "author_host": author_host, "activity": False,
          }
        if len(live) >= REACTION_REPLAY_LIMIT:
          raise HTTPException(status_code=429, detail="Reaction replay journal is full.")
        live[replay_token] = now + REACTION_REPLAY_TTL_S
        post["_reaction_replays"] = live
      if host not in hosts and len(hosts) >= BOARD_LIKE_LIMIT:
        raise HTTPException(status_code=507, detail="Post reaction limit reached.")
      added = host not in hosts
      if host in hosts:
        del hosts[host]
      else:
        hosts[host] = now
      owns_dirty_marker = self._mark_board_index_dirty()
      atomic_write(path, json.dumps(post))
      if self._refresh_board_index(post, path) and owns_dirty_marker:
        self._clear_board_index_dirty()
      # `activity` is True only for a genuine new like (not an unlike or a
      # replay), so the router notifies the post's author exactly once.
      return {
        "status": "ok",
        "reaction_counts": {key: len(value) for key, value in reactions.items()},
        "reacted": [key for key, value in reactions.items() if host in value],
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
        thumb = self.find_image(self.board_thumbnail_dir(), stem)
        if thumb is not None:
          try:
            thumb[0].unlink()
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


def _decode_board_cursor(cursor: str | None) -> tuple[float, str] | None:
  """Decode a stable Board position, while accepting legacy timestamps."""
  if not cursor:
    return None
  try:
    legacy_timestamp = float(cursor)
    if math.isfinite(legacy_timestamp):
      # An empty id preserves the old strict `created_at < timestamp` boundary.
      return legacy_timestamp, ""
  except (TypeError, ValueError):
    pass
  try:
    padded = cursor + "=" * (-len(cursor) % 4)
    created_at, post_id = json.loads(base64.urlsafe_b64decode(padded).decode())
    if (
      not isinstance(created_at, (int, float))
      or isinstance(created_at, bool)
      or not math.isfinite(created_at)
      or not isinstance(post_id, str)
      or not post_id
    ):
      raise ValueError
    return float(created_at), post_id
  except (
    ValueError, TypeError, OverflowError, UnicodeDecodeError, json.JSONDecodeError,
    binascii.Error,
  ) as exc:
    raise ValueError("Board cursor is invalid.") from exc


def _encode_board_cursor(created_at: float, post_id: str) -> str:
  payload = json.dumps([created_at, post_id], separators=(",", ":")).encode()
  return base64.urlsafe_b64encode(payload).decode().rstrip("=")


def read_board_page(
  store: CommonPublicStore, limit: int, before: str | None,
  viewer: str | None = None,
) -> dict:
  """Return one stable page shared by public and owner-facing Board routes."""
  try:
    cursor = _decode_board_cursor(before)
  except ValueError as exc:
    raise HTTPException(status_code=400, detail=str(exc)) from exc
  page_size = min(max(limit, 1), BOARD_PAGE_LIMIT)
  posts = store.read_board(page_size + 1, cursor, viewer)
  has_more = len(posts) > page_size
  posts = posts[:page_size]
  next_cursor = None
  if has_more and posts:
    last = posts[-1]
    next_cursor = _encode_board_cursor(last["created_at"], last["id"])
  return {
    "capabilities": {"emoji_reactions": True, "image_thumbnails": True},
    "posts": posts,
    "next_cursor": next_cursor,
  }


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
    limit: int = 30, before: str | None = None, viewer: str | None = None,
  ):
    if viewer is not None and not valid_host(viewer):
      viewer = None
    return read_board_page(store, limit, before, viewer)

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

  @router.get("/board/thumbnail/{post_id}")
  def get_board_thumbnail(post_id: str):
    if not valid_id(post_id):
      raise HTTPException(status_code=400, detail="Post id is invalid.")
    return store.serve_image(store.board_thumbnail(post_id))

  @router.get("/board/thumbnail/{post_id}/{index}")
  def get_board_thumbnail_at(post_id: str, index: int):
    if not valid_id(post_id):
      raise HTTPException(status_code=400, detail="Post id is invalid.")
    if not 0 <= index < MAX_BOARD_ATTACHMENTS:
      raise HTTPException(status_code=400, detail="Image index is invalid.")
    return store.serve_image(store.board_thumbnail(post_id, index))

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
    emoji = envelope.get("emoji")
    result = (
      store.toggle_like(post_id, envelope["from"], replay_token=replay_token)
      if emoji is None
      else store.toggle_reaction(
        post_id, envelope["from"], emoji, replay_token=replay_token,
      )
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
    thumbnails = validate_attachments(envelope.get("thumbnails"))
    image_count = len(attachments) if attachments else (1 if attachment else 0)
    if thumbnails and len(thumbnails) != image_count:
      raise HTTPException(status_code=400, detail="Post thumbnails are invalid.")
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
    }, attachment, attachments, thumbnails)
    return {"status": "posted"}

  return router, None


__all__ = [
  "BOARD_LIKE_LIMIT", "BOARD_PAGE_LIMIT", "BOARD_POST_LIMIT", "BOARD_REPLY_LIMIT",
  "CommonPublicStore", "DIRECTORY_LIMIT", "REACTION_REPLAY_LIMIT",
  "REACTION_REPLAY_TTL_S", "create_public_router", "read_board_page",
]
