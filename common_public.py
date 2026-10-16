"""The members-only directory and public board on the central Social host.

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

import asyncio
import base64
import binascii
import email.utils
import hashlib
import io
import json
import fcntl
import logging
import math
import re
import sqlite3
import threading
import time
from collections.abc import Callable
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response
from fastapi.routing import APIRoute
from starlette.middleware.errors import ServerErrorMiddleware
from PIL import Image, ImageOps

from common_protocol import (
  ATTACHMENT_MIME_EXT,
  CLOCK_SKEW_S,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_ENVELOPE_BYTES,
  MAX_STATIC_ATTACHMENT_BYTES,
  MAX_THUMBNAIL_BYTES,
  MAX_BOARD_TOTAL_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_DIMENSION,
  MAX_AVATAR_BYTES,
  MAX_BOARD_ATTACHMENTS,
  MAX_BIO_CHARS,
  MAX_ENVELOPE_BYTES,
  MAX_NAME_CHARS,
  MAX_POST_TEXT_CHARS,
  MAX_REPLY_TEXT_CHARS,
  NEEDS_USERNAME,
  OUTBOUND_TIMEOUT_S,
  ActorVerifier,
  CheckedAttachment,
  canonical,
  peer_service_url,
  read_envelope,
  sign,
  valid_host,
  valid_id,
  validate_attachment,
  validate_gif_bytes,
  validate_attachment_envelope_size,
  validate_attachments,
  validate_text_or_attachment,
)
from common_transport import federation_request
from service_io import atomic_write

BOARD_PAGE_LIMIT = 50
BOARD_REPLY_LIMIT = 200
BOARD_LIKE_LIMIT = 2000
DIRECTORY_LIMIT = 2000
MAX_PUBLIC_CONTENT_REQUESTS = 2
MAX_PUBLIC_CONTROL_REQUESTS = 8
# Named-member verification can fetch five times when a key/handle changes and
# the cache is full: two initial, one named-card refresh, two re-verification.
# 12s receiving + five existing 10s fetch grants leaves 13s for bounded local
# validation and response sending. Do not shorten any existing network grant.
MAX_PUBLIC_REQUEST_SECONDS = 75.0
# A member avatar URL is its content hash, so it never changes. A board image
# never changes either, but its post can be deleted or moderated: a browser may
# keep what it already showed for a day, while shared caches such as the site's
# CDN, which answer anyone, keep it for at most an hour.
IMMUTABLE_PUBLIC = "public, max-age=31536000, immutable"
BOARD_IMAGE_CACHE = "public, max-age=86400, s-maxage=3600"
# A missing image may appear moments later (a post still being stored, an
# avatar switched back), so no cache may hold on to its absence.
NOT_FOUND_UNCACHED = {"Cache-Control": "no-store"}
MEMBER_AVATAR_MAX_SIDE = 128
MEMBER_AVATAR_MAX_PIXELS = 8_000_000
# The host re-copies each member's avatar at least this often, so a member
# whose instance never re-registers still shows a current picture.
MEMBER_AVATAR_MAX_AGE_S = 24 * 3600
AVATAR_DIGEST = re.compile(r"[0-9a-f]{64}")
# A host never silently deletes public/user data.  These admission ceilings
# bound durable abuse instead: an operator can raise them after provisioning
# more storage, while existing imported records remain readable at any size.
BOARD_POST_LIMIT = 10_000
# The SQLite index is disposable, but unchanged file metadata can otherwise
# preserve rows written with obsolete canonical-position semantics.
BOARD_INDEX_NORMALIZATION_VERSION = 1
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
  "GIF": "image/gif",
}


class BoardImageTooLarge(ValueError):
  """A raster must be rejected before decoding or storing its media."""


def _board_record_position(record: dict) -> tuple[float, str] | None:
  """Return the one stable feed position for a readable Board record."""
  post_id = record.get("id")
  if not isinstance(post_id, str) or not post_id:
    return None
  created_at = record.get("created_at", 0)
  if not isinstance(created_at, (int, float)) or isinstance(created_at, bool):
    return 0.0, post_id
  try:
    created_at = float(created_at)
  except OverflowError:
    return 0.0, post_id
  return (created_at if math.isfinite(created_at) else 0.0), post_id


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
  data: bytes | CheckedAttachment, max_side: int = BOARD_THUMBNAIL_MAX_SIDE,
  max_pixels: int = BOARD_THUMBNAIL_MAX_PIXELS,
) -> tuple[str, bytes]:
  """Create a small, display-ready, header-validated rendition.

  `max_side` bounds the long edge (board timelines use the default; avatars pass
  a smaller cap). The same header/decompression-bomb guards run either way, so
  every caller re-encodes untrusted image bytes through one validated path.
  A CheckedAttachment renders from the GIF decode view its check already made;
  raw bytes, such as a stored original being backfilled, are checked here.
  """
  if isinstance(data, CheckedAttachment):
    original = CheckedAttachment.of(data)
    data = original.gif_view or original[1]
  elif data[:6] in (b"GIF87a", b"GIF89a") and len(data) >= 10:
    # Pillow concatenates comment metadata quadratically for a large legal
    # comment chain. Validate the original, then render a comment-free view;
    # the stored original and its signed bytes are never rewritten.
    data = validate_gif_bytes({
      "mime": "image/gif",
      "w": int.from_bytes(data[6:8], "little"),
      "h": int.from_bytes(data[8:10], "little"),
    }, data)
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
    while True:
      output = io.BytesIO()
      prepared.save(output, format="WEBP", quality=72, method=4)
      if output.tell() <= MAX_THUMBNAIL_BYTES:
        return "image/webp", output.getvalue()
      if max(prepared.size) <= 96:
        raise ValueError("Board thumbnail is too detailed.")
      prepared.thumbnail(
        (max(1, int(prepared.width * 0.84)), max(1, int(prepared.height * 0.84))),
        Image.Resampling.LANCZOS,
      )


def validate_thumbnail_bytes(wire: dict, data: bytes) -> None:
  """Verify a client-made thumbnail before it becomes served media."""
  if len(data) > MAX_THUMBNAIL_BYTES:
    raise HTTPException(status_code=413, detail="Board thumbnail is too large.")
  with _open_board_image(data) as image:
    _validate_image_header(image)
    if image.format == "GIF":
      raise ValueError("GIF originals need a static thumbnail.")
    if max(image.size) > BOARD_THUMBNAIL_MAX_SIDE:
      raise ValueError("Board thumbnail dimensions are too large.")
    if IMAGE_FORMAT_MIME[image.format] != wire["mime"]:
      raise ValueError("Board thumbnail media type does not match its data.")
    if image.size != (wire["w"], wire["h"]):
      raise ValueError("Board thumbnail dimensions do not match its data.")
    image.verify()


def check_reply_original(original: tuple[dict, bytes]) -> CheckedAttachment:
  """Admit only a complete image whose bytes agree with its reply metadata.

  A GIF (or GIF bytes behind a static MIME) gets the shared protocol check,
  reused when validate_attachment already ran it; a static photo is fully
  decoded here because the wire check does not inspect its raster.
  """
  checked = CheckedAttachment.of(original)
  if checked.gif_view is not None:
    return checked
  wire, data = checked
  if len(data) > MAX_STATIC_ATTACHMENT_BYTES:
    raise HTTPException(status_code=413, detail="Reply photo is too large.")
  try:
    with _open_board_image(data) as image:
      # The header guard must precede either verification or raster decoding.
      _validate_image_header(image)
      if (max(image.size) > MAX_ATTACHMENT_DIMENSION
          or IMAGE_FORMAT_MIME[image.format] != wire["mime"]
          or image.size != (wire["w"], wire["h"])):
        raise ValueError("Reply photo metadata does not match its data.")
      image.verify()
    # verify() checks the container without decoding pixels; load() also
    # rejects a truncated or otherwise undecodable raster before persistence.
    with _open_board_image(data) as image:
      image.load()
  except BoardImageTooLarge as exc:
    raise HTTPException(status_code=400, detail=str(exc)) from exc
  except (OSError, ValueError, SyntaxError, EOFError, Image.UnidentifiedImageError) as exc:
    raise HTTPException(status_code=400, detail="Reply photo is invalid.") from exc
  return checked


def optional_rendition(source: bytes | CheckedAttachment) -> bytes | None:
  """Render a WebP poster, or None when this optional rendition fails.

  The durable original stays valid without it: serving falls back to the
  original and later requests backfill the rendition from stored bytes.
  """
  try:
    return image_thumbnail_bytes(source)[1]
  except (OSError, ValueError, SyntaxError, Image.UnidentifiedImageError):
    return None


class CommonPublicStore:
  """The canonical Common public-store implementation."""

  def __init__(self, data_dir: str | Path | Callable[[], str | Path]):
    self._data_dir = data_dir
    self._directory_lock = threading.Lock()
    self._board_lock = threading.Lock()
    self._board_index_lock = threading.Lock()
    self._board_index_ready = False
    self._member_index_cache: (
      tuple[tuple[int, int], tuple[dict[str, str], dict[str, str]]] | None
    ) = None

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
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version != BOARD_INDEX_NORMALIZATION_VERSION:
          connection.execute("DELETE FROM board_posts")
          connection.execute(
            f"PRAGMA user_version = {BOARD_INDEX_NORMALIZATION_VERSION}"
          )
      yield connection
      connection.commit()
    except Exception:
      connection.rollback()
      raise
    finally:
      connection.close()

  @staticmethod
  def _board_record_values(record: dict, stat) -> tuple | None:
    position = _board_record_position(record)
    if position is None:
      return None
    created_at, post_id = position
    return (
      post_id, created_at,
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

  def _reconcile_board_index_locked(self) -> None:
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
        values = self._board_record_values(record, stat)
        if values is None:
          invalid.add(post_id)
          continue
        self._upsert_board_record(connection, values)
      stale = (set(existing) - seen) | invalid
      connection.executemany(
        "DELETE FROM board_posts WHERE id = ?",
        ((post_id,) for post_id in stale),
      )

  def _discard_board_index_locked(self) -> None:
    path = self.board_index_path()
    for candidate in (path, Path(f"{path}-wal"), Path(f"{path}-shm")):
      candidate.unlink(missing_ok=True)

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
        try:
          self._reconcile_board_index_locked()
        except sqlite3.DatabaseError:
          # The index is disposable. Rebuild it once under the same
          # cross-process lock instead of scanning every JSON file forever.
          self._discard_board_index_locked()
          self._reconcile_board_index_locked()
        self._clear_board_index_dirty()
      self._board_index_ready = True

  def _refresh_board_index(self, record: dict, path: Path) -> bool:
    """Mirror one committed JSON record; a rebuild repairs cache failures."""
    if not self._board_index_ready:
      return False
    try:
      stat = path.stat()
      with self._board_index() as connection:
        values = self._board_record_values(record, stat)
        if values is None:
          return False
        self._upsert_board_record(connection, values)
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
    position = _board_record_position(raw)
    if position is None:
      raise ValueError("Board record has no stable position.")
    created_at, post_id = position
    post = dict(raw)
    post["id"] = post_id
    post["created_at"] = created_at
    reactions = CommonPublicStore._reaction_hosts(post)
    post.pop("likes", None)
    post.pop("reactions", None)
    heart = reactions.get("❤️", {})
    post["like_count"] = len(heart)
    if viewer is not None:
      post["liked"] = viewer in heart
    post["reactions"] = CommonPublicStore._public_reactions(reactions, viewer)
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
    post.pop("_deleted_replies", None)
    post.pop("_edit_clock", None)
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
      if raw.get("id") != file.stem:
        continue
      position = _board_record_position(raw)
      if position is None:
        continue
      if before is not None and position >= before:
        continue
      posts.append((position, self._present_board_record(raw, viewer)))
    posts.sort(key=lambda item: item[0], reverse=True)
    return [post for _position, post in posts[:limit]]

  def _board_count(self) -> int:
    if not self._board_index_ready or self.board_index_dirty_path().is_file():
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

  def reply_media_dir(self) -> Path:
    path = self.common_dir() / "reply-media"
    path.mkdir(parents=True, exist_ok=True)
    return path

  def reply_thumbnail_dir(self) -> Path:
    path = self.common_dir() / "reply-thumbnails"
    path.mkdir(parents=True, exist_ok=True)
    return path

  def reply_image(self, post_id: str, reply_id: str, *, thumbnail: bool = False):
    post_path = self.board_dir() / f"{post_id}.json"

    def committed_attachment():
      if not post_path.is_file():
        return None
      replies = self._load_object(post_path).get("replies", [])
      return next((reply["attachment"] for reply in replies
                   if isinstance(reply, dict) and reply.get("id") == reply_id
                   and isinstance(reply.get("attachment"), dict)), None)

    attachment = committed_attachment()
    if attachment is None:
      return None
    directory = self.reply_thumbnail_dir() if thumbnail else self.reply_media_dir()
    mime = "image/webp" if thumbnail else attachment["mime"]
    target = directory / post_id / f"{reply_id}.{ATTACHMENT_MIME_EXT[mime]}"
    if target.is_file():
      return target, mime
    if not thumbnail:
      return None
    # Recheck under the deletion lock before recovering a missing rendition.
    # The committed metadata, not leftover files, owns the original's type.
    with self._mutation_lock(self._board_lock, "board"):
      attachment = committed_attachment()
      if attachment is None:
        return None
      if target.is_file():
        return target, mime
      source = self.reply_media_dir() / post_id / f"{reply_id}.{ATTACHMENT_MIME_EXT[attachment['mime']]}"
      if not source.is_file():
        return None
      try:
        mime, data = image_thumbnail_bytes(source.read_bytes())
        atomic_write(target, data)
        return target, mime
      except BoardImageTooLarge as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
      except (OSError, ValueError, SyntaxError, Image.UnidentifiedImageError):
        return None

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
  def serve_image(
    found: tuple[Path, str] | None, request: Request | None = None, *,
    cache_control: str = BOARD_IMAGE_CACHE,
  ) -> Response:
    if found is None:
      raise HTTPException(
        status_code=404, detail="Board image not found.", headers=NOT_FOUND_UNCACHED,
      )
    path, mime = found
    return immutable_file_response(path, mime, request, cache_control=cache_control)

  @staticmethod
  def _load_object(path: Path) -> dict:
    if not path.is_file():
      return {}
    try:
      value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
      return {}  # A concurrent deletion is ordinary absence, not corrupt data.
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
      raise HTTPException(status_code=500, detail="Public data record is invalid.") from exc
    if not isinstance(value, dict):
      raise HTTPException(status_code=500, detail="Public data record is invalid.")
    return value

  def member_avatar_dir(self) -> Path:
    path = self.common_dir() / "member-avatars"
    path.mkdir(parents=True, exist_ok=True)
    return path

  def member_avatar_file(self, name: str) -> Path | None:
    digest, _dot, extension = name.partition(".")
    if extension != "webp" or not AVATAR_DIGEST.fullmatch(digest):
      return None
    path = self.member_avatar_dir() / f"{digest}.webp"
    return path if path.is_file() else None

  def _member_index(self) -> tuple[dict[str, str], dict[str, str]]:
    """Each directory member's current (avatar hash, handle), by host."""
    path = self.directory_path()
    try:
      stat = path.stat()
    except FileNotFoundError:
      return {}, {}
    version = (stat.st_mtime_ns, stat.st_size)
    cached = self._member_index_cache
    if cached is not None and cached[0] == version:
      return cached[1]
    try:
      entries = self._load_object(path)
    except HTTPException:
      # Directory overlays are an optimization; a damaged directory must not
      # take board reads down with it.
      return {}, {}
    members = [
      (host, entry) for host, entry in entries.items()
      if isinstance(host, str) and isinstance(entry, dict)
    ]
    avatars = {
      host: entry["avatar"] for host, entry in members
      if isinstance(entry.get("avatar"), str) and AVATAR_DIGEST.fullmatch(entry["avatar"])
    }
    handles = {
      host: entry["handle"] for host, entry in members
      if isinstance(entry.get("handle"), str) and entry["handle"]
    }
    self._member_index_cache = (version, (avatars, handles))
    return avatars, handles

  def member_avatars(self) -> dict[str, str]:
    """Map each directory member's host to its avatar content hash."""
    return self._member_index()[0]

  def is_member(self, host: str) -> bool:
    """Registration grants access even for legacy members still choosing a handle."""
    return isinstance(self._load_object(self.directory_path()).get(host), dict)

  def set_member_handle(self, host: str, handle: str) -> None:
    """Record the handle a registered member's own actor card now shows."""
    if self._member_index()[1].get(host) == handle:
      return
    with self._mutation_lock(self._directory_lock, "directory"):
      path = self.directory_path()
      entries = self._load_object(path)
      entry = entries.get(host)
      if not isinstance(entry, dict) or entry.get("handle") == handle:
        return
      entry["handle"] = handle
      atomic_write(path, json.dumps(entries, indent=2))

  def set_member_avatar(self, host: str, rendition: bytes | None) -> str | None:
    """Record a registered member's avatar copy (None: they have none).

    A copy is stored under its content hash, so its URL can be cached forever;
    a changed avatar gets a new URL and a file no member uses any more is
    removed. Files change under the directory lock, so two members sharing one
    image never race.
    """
    return self._record_member_avatar_check(host, rendition, replace=True)

  def keep_member_avatar(self, host: str) -> None:
    """Record a failed check: keep the current copy and retry in a day."""
    self._record_member_avatar_check(host, None, replace=False)

  def _record_member_avatar_check(
    self, host: str, rendition: bytes | None, *, replace: bool,
  ) -> str | None:
    digest = hashlib.sha256(rendition).hexdigest() if rendition else None
    with self._mutation_lock(self._directory_lock, "directory"):
      path = self.directory_path()
      entries = self._load_object(path)
      entry = entries.get(host)
      if not isinstance(entry, dict):
        return None
      entry["avatar_checked_at"] = time.time()
      previous = entry.get("avatar")
      if not replace:
        digest = previous if isinstance(previous, str) else None
      elif digest is None:
        entry.pop("avatar", None)
      else:
        target = self.member_avatar_dir() / f"{digest}.webp"
        if not target.is_file():
          atomic_write(target, rendition)
        entry["avatar"] = digest
      atomic_write(path, json.dumps(entries, indent=2))
      in_use = {
        value.get("avatar") for value in entries.values() if isinstance(value, dict)
      }
      if isinstance(previous, str) and AVATAR_DIGEST.fullmatch(previous) and previous not in in_use:
        (self.member_avatar_dir() / f"{previous}.webp").unlink(missing_ok=True)
    return digest

  def members_due_for_avatar_check(self, limit: int, now: float | None = None) -> list[str]:
    """Members whose avatar copy is older than a day (or was never made)."""
    now = time.time() if now is None else now
    try:
      entries = self._load_object(self.directory_path())
    except HTTPException:
      return []
    due = sorted(
      (float(entry.get("avatar_checked_at") or 0), host)
      for host, entry in entries.items()
      if isinstance(host, str) and isinstance(entry, dict)
      and now - float(entry.get("avatar_checked_at") or 0) >= MEMBER_AVATAR_MAX_AGE_S
    )
    return [host for _checked, host in due[:limit]]

  def with_member_profiles(self, people: list) -> list:
    """Show only people with a known handle, using current directory profiles.

    Posts and replies keep the handle their author had when they were sent,
    which is empty for someone who posted before choosing one. The directory
    follows each member's own actor card, so its handle wins when it has one;
    the avatar hash lets viewers reuse one shared image.
    """
    avatars, handles = self._member_index()
    named = []
    for person in people:
      if not isinstance(person, dict):
        continue
      host = person.get("host")
      if avatars.get(host):
        person["avatar"] = avatars[host]
      if handles.get(host):
        person["handle"] = handles[host]
      if person.get("handle"):
        named.append(person)
    return named

  def search_directory(self, query: str = "") -> dict:
    entries = self._load_object(self.directory_path())
    needle = query.strip().lower()
    results = []
    for host, entry in entries.items():
      if not isinstance(host, str) or not isinstance(entry, dict):
        continue
      handle = entry.get("handle") if isinstance(entry.get("handle"), str) else ""
      if not handle:
        continue
      bio = entry.get("bio") if isinstance(entry.get("bio"), str) else ""
      if needle and needle not in f"{handle} {host} {bio}".lower():
        continue
      result = {"host": host}
      if "handle" in entry:
        result["handle"] = handle
      if "bio" in entry:
        result["bio"] = bio
      results.append(result)
    results.sort(key=lambda entry: entry["handle"].lower())
    return {"users": self.with_member_profiles(results[:200])}

  def register(self, host: str, handle: str, bio: str) -> dict:
    with self._mutation_lock(self._directory_lock, "directory"):
      path = self.directory_path()
      entries = self._load_object(path)
      if host not in entries and len(entries) >= DIRECTORY_LIMIT:
        raise HTTPException(status_code=507, detail="Directory is full.")
      previous = entries.get(host) if isinstance(entries.get(host), dict) else {}
      entries[host] = {
        "handle": handle,
        "bio": bio,
        "registered_at": time.time(),
        # The avatar copy is refreshed after registration, not reset by it.
        **{key: previous[key] for key in ("avatar", "avatar_checked_at") if key in previous},
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
    except (ValueError, json.JSONDecodeError, sqlite3.Error):
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

    Every original is checked, and every rendition rendered, before the board
    lock. Pairs from validate_attachment reuse their GIF check and decode view;
    plain pairs from direct callers are checked here, once each.
    """
    if attachment is not None and attachments and attachment[0] != attachments[0][0]:
      raise HTTPException(status_code=400, detail="First post image does not match its gallery copy.")
    if sum(len(data) for _, data in (attachments or ([attachment] if attachment else []))) > MAX_BOARD_TOTAL_ATTACHMENT_BYTES:
      raise HTTPException(status_code=413, detail="Post images are too large together.")
    # Inspect all original headers before writing any media. Optional
    # thumbnail failures still preserve ordinary legacy image posts, but an
    # oversized raster must not leave an orphan image or become a fallback.
    originals = []
    for item in attachments or ([attachment] if attachment else []):
      original = CheckedAttachment.of(item)
      originals.append(original)
      if original.gif_view is not None:
        continue
      try:
        with _open_board_image(original[1]) as image:
          _validate_image_header(image)
      except BoardImageTooLarge as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
      except (OSError, ValueError, SyntaxError, Image.UnidentifiedImageError):
        pass
    if thumbnails and len(thumbnails) != len(originals):
      raise HTTPException(status_code=400, detail="Post thumbnails are invalid.")
    try:
      for wire, data in thumbnails or []:
        validate_thumbnail_bytes(wire, data)
    except (OSError, ValueError, Image.UnidentifiedImageError) as exc:
      raise HTTPException(status_code=400, detail="Post thumbnail is invalid.") from exc
    path = self.board_dir() / f"{post['id']}.json"

    def stored_retry() -> bool:
      """A stable retry confirms its own post; an id is never shared."""
      stored = self._load_object(path)
      if not stored:
        return False  # Absent, or deleted concurrently.
      if stored.get("host") != post.get("host"):
        raise HTTPException(status_code=409, detail="Post id already belongs to another author.")
      return True

    if stored_retry():
      return False  # A stored post never changes, so its retry renders nothing.
    # Keep every thumbnail as WebP, the one type peers ask for by link: a
    # supplied WebP is stored as sent; another supplied type is re-encoded,
    # or the original's poster made, as an optional rendition.
    renditions = [
      (supplied[1], True) if supplied and supplied[0]["mime"] == "image/webp"
      else (optional_rendition(supplied[1] if supplied else original), False)
      for original, supplied in zip(originals, thumbnails or [None] * len(originals))
    ]
    try:
      self._ensure_board_index()
    except sqlite3.Error:
      self._board_index_ready = False
    with self._mutation_lock(self._board_lock, "board"):
      if stored_retry():
        return False
      if self._board_count() >= BOARD_POST_LIMIT:
        raise HTTPException(status_code=507, detail="Board is full.")
      record = dict(post)
      metas = []
      for index, ((wire, data), (rendition, supplied)) in enumerate(zip(originals, renditions)):
        target = (self.board_media_index_path(post["id"], index, wire["mime"]) if attachments
                  else self.board_media_path(post["id"], wire["mime"]))
        atomic_write(target, data)
        if rendition is not None:
          try:
            atomic_write(self.board_thumbnail_dir() / f"{post['id']}-{index}.webp", rendition)
          except OSError:
            if supplied:  # Only a made rendition is optional.
              raise
        metas.append({"mime": wire["mime"], "w": wire["w"], "h": wire["h"]})
      if attachments:
        record["attachments"] = metas
      if metas:
        record["attachment"] = metas[0]
      self._write_board_record(record, path)
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

  @staticmethod
  def _public_reactions(reactions: dict[str, dict], viewer: str | None) -> list[dict]:
    """Present post and reply reactions in the same order, without host lists."""
    return [
      {"emoji": emoji, "count": len(reactions[emoji]),
       "reacted": bool(viewer and viewer in reactions[emoji])}
      for emoji in BOARD_REACTION_EMOJIS if reactions.get(emoji)
    ]

  @staticmethod
  def _board_target(post: dict, reply_id: str | None) -> dict:
    """The post itself, or the reply with ``reply_id`` inside it."""
    if reply_id is None:
      return post
    replies = post.get("replies")
    target = next(
      (reply for reply in replies if isinstance(reply, dict) and reply.get("id") == reply_id),
      None,
    ) if isinstance(replies, list) else None
    if target is None:
      raise HTTPException(status_code=404, detail="Unknown reply.")
    return target

  def toggle_reaction(
    self, post_id: str, host: str, emoji: str,
    *, reply_id: str | None = None, replay_token: str | None = None,
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
      target = self._board_target(post, reply_id)
      reactions = self._reaction_hosts(target)
      hosts = reactions.setdefault(emoji, {})
      target["reactions"] = reactions
      target.pop("likes", None)
      author_host = target.get("host")
      now = time.time()
      if replay_token is not None:
        journal = target.setdefault("_reaction_replays", {})
        if not isinstance(journal, dict):
          journal = {}
          target["_reaction_replays"] = journal
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
        target["_reaction_replays"] = live
      if host not in hosts and len(hosts) >= BOARD_LIKE_LIMIT:
        raise HTTPException(status_code=507, detail="Post reaction limit reached.")
      added = host not in hosts
      if host in hosts:
        del hosts[host]
      else:
        hosts[host] = now
      self._write_board_record(post, path)
      # Only a newly added reaction notifies the target's author, never a
      # removal or replay.
      return {
        "status": "ok",
        "reaction_counts": {key: len(value) for key, value in reactions.items()},
        "reacted": [key for key, value in reactions.items() if host in value],
        "author_host": author_host, "activity": added,
      }

  def add_reply(
    self, post_id: str, reply_id: str, host: str, handle: str,
    text: str, created_at: float,
    attachment: tuple[dict, bytes] | None = None,
    thumbnail: tuple[dict, bytes] | None = None,
  ) -> dict:
    if thumbnail is not None:
      if attachment is None:
        raise HTTPException(status_code=400, detail="Reply thumbnail needs a photo.")
      try:
        validate_thumbnail_bytes(*thumbnail)
      except (OSError, ValueError, Image.UnidentifiedImageError) as exc:
        raise HTTPException(status_code=400, detail="Reply thumbnail is invalid.") from exc
    path = self.board_dir() / f"{post_id}.json"
    digest = hashlib.sha256(attachment[1]).hexdigest() if attachment else None
    thumbnail_digest = hashlib.sha256(thumbnail[1]).hexdigest() if thumbnail else None
    attachment_meta = (
      {key: attachment[0][key] for key in ("mime", "w", "h")}
      if attachment else None
    )

    def settle(post: dict) -> dict | None:
      """Answer a known post's retry, conflict or limit; None admits a new reply."""
      replies = post.get("replies")
      if not isinstance(replies, list):
        replies = []
        post["replies"] = replies
      existing = next((reply for reply in replies if isinstance(reply, dict)
                       and reply.get("id") == reply_id), None)
      if existing is not None:
        # A stable retry may confirm the same reply, never replace another
        # author's text or media under its id. Once the author has edited it,
        # a retry of the original send differs only in that edited text.
        if (existing.get("host") != host
            or (existing.get("text") != text and "_edit_clock" not in existing)
            or existing.get("attachment_sha256") != digest
            or existing.get("attachment") != attachment_meta
            or existing.get("thumbnail_sha256") != thumbnail_digest):
          raise HTTPException(status_code=409, detail="Reply id already belongs to different content.")
        return {
          "status": "ok", "reply_count": len(replies),
          "author_host": post.get("host"), "activity": False,
          "id": reply_id, "attachment": existing.get("attachment"),
        }
      tombstones = post.get("_deleted_replies")
      if isinstance(tombstones, list) and reply_id in tombstones:
        raise HTTPException(status_code=410, detail="This reply was deleted.")
      if len(replies) >= BOARD_REPLY_LIMIT:
        raise HTTPException(status_code=507, detail="Post reply limit reached.")
      return None

    # Records are replaced atomically, so this unlocked read answers retries,
    # conflicts and limits before any media work. Only an admitted new reply
    # pays for the full photo check and poster, still outside the board lock;
    # the locked commit below settles the same questions again authoritatively.
    if not path.is_file():
      raise HTTPException(status_code=404, detail="Unknown post.")
    settled = settle(self._load_object(path))
    if settled is not None:
      return settled
    rendition = None
    if attachment is not None:
      attachment = check_reply_original(attachment)
      rendition = optional_rendition(thumbnail[1] if thumbnail else attachment)
    try:
      self._ensure_board_index()
    except sqlite3.Error:
      self._board_index_ready = False
    with self._mutation_lock(self._board_lock, "board"):
      if not path.is_file():
        raise HTTPException(status_code=404, detail="Unknown post.")
      post = self._load_object(path)
      settled = settle(post)
      if settled is not None:
        return settled
      author_host = post.get("host")
      replies = post["replies"]
      # No reply owns this identity yet. A crashed or failed earlier commit
      # may have left media behind; none may become this new reply's rendition.
      for directory in (self.reply_media_dir(), self.reply_thumbnail_dir()):
        for extension in ATTACHMENT_MIME_EXT.values():
          (directory / post_id / f"{reply_id}.{extension}").unlink(missing_ok=True)
      record = {
        "id": reply_id,
        "host": host,
        "handle": handle,
        "text": text,
        "created_at": created_at,
      }
      if attachment is not None:
        wire, data = attachment
        media_dir = self.reply_media_dir() / post_id
        media_dir.mkdir(parents=True, exist_ok=True)
        atomic_write(media_dir / f"{reply_id}.{ATTACHMENT_MIME_EXT[wire['mime']]}", data)
        record["attachment"] = attachment_meta
        record["attachment_sha256"] = digest
        if thumbnail_digest is not None:
          record["thumbnail_sha256"] = thumbnail_digest
        if rendition is not None:
          try:
            thumb_dir = self.reply_thumbnail_dir() / post_id
            thumb_dir.mkdir(parents=True, exist_ok=True)
            atomic_write(thumb_dir / f"{reply_id}.webp", rendition)
          except OSError:
            pass
      replies.append(record)
      self._write_board_record(post, path)
      return {
        "status": "ok", "reply_count": len(replies),
        "author_host": author_host, "activity": True,
        "id": reply_id, "attachment": record.get("attachment"),
      }

  def _write_board_record(self, post: dict, path: Path) -> None:
    """Commit one post record and mirror it into the board index (lock held)."""
    owns_dirty_marker = self._mark_board_index_dirty()
    atomic_write(path, json.dumps(post))
    if self._refresh_board_index(post, path) and owns_dirty_marker:
      self._clear_board_index_dirty()

  def delete_reply(self, post_id: str, reply_id: str, host: str) -> dict:
    """Remove one reply its own author asked to delete, with its media.

    Like `delete_post`, this is a deliberate author action and idempotent. The
    id is remembered so a delayed retry of the original reply cannot bring the
    deleted reply back. That list keeps only the newest BOARD_REPLY_LIMIT ids
    per post, so a very old deleted id can be forgotten. An older host release
    reading these records neither hides the list nor checks it: after a rollback,
    a draft id the author's Social still holds could recreate the reply, because
    the relay signs every retry afresh rather than replaying the old envelope.
    """
    try:
      self._ensure_board_index()
    except sqlite3.Error:
      self._board_index_ready = False
    with self._mutation_lock(self._board_lock, "board"):
      path = self.board_dir() / f"{post_id}.json"
      if not path.is_file():
        return {"status": "deleted", "reply_count": 0}
      post = self._load_object(path)
      replies = post.get("replies")
      if not isinstance(replies, list):
        replies = []
      target = next((reply for reply in replies if isinstance(reply, dict)
                     and reply.get("id") == reply_id), None)
      if target is None:
        return {"status": "deleted", "reply_count": len(replies)}
      if target.get("host") != host:
        raise HTTPException(
          status_code=403, detail="Only the author host may delete this reply.",
        )
      post["replies"] = [reply for reply in replies if reply is not target]
      tombstones = post.get("_deleted_replies")
      if not isinstance(tombstones, list):
        tombstones = []
      post["_deleted_replies"] = (tombstones + [reply_id])[-BOARD_REPLY_LIMIT:]
      self._write_board_record(post, path)
      for directory in (self.reply_media_dir(), self.reply_thumbnail_dir()):
        for extension in ATTACHMENT_MIME_EXT.values():
          (directory / post_id / f"{reply_id}.{extension}").unlink(missing_ok=True)
      return {"status": "deleted", "reply_count": len(post["replies"])}

  def edit_text(
    self, post_id: str, reply_id: str | None, host: str, text: str, edited_at: float,
  ) -> dict:
    """Replace the text of one post or reply on behalf of its author.

    Edits are ordered by their signed time: an older or replayed edit never
    overwrites a newer one. Media is unchanged, so text may be empty only when
    the post or reply carries an image.
    """
    try:
      self._ensure_board_index()
    except sqlite3.Error:
      self._board_index_ready = False
    with self._mutation_lock(self._board_lock, "board"):
      path = self.board_dir() / f"{post_id}.json"
      if not path.is_file():
        raise HTTPException(status_code=404, detail="Unknown post.")
      post = self._load_object(path)
      target = self._board_target(post, reply_id)
      if target.get("host") != host:
        raise HTTPException(status_code=403, detail="Only the author may edit this.")
      has_media = bool(target.get("attachment") or target.get("attachments"))
      if not text.strip() and not has_media:
        raise HTTPException(status_code=400, detail="Text cannot be empty.")
      # Order by signed time on every accepted edit, including one that leaves
      # the text unchanged, so a delayed older edit can never win afterwards.
      clock = target.get("_edit_clock", target.get("edited_at"))
      if isinstance(clock, (int, float)) and edited_at <= clock:
        return {"status": "ok", "applied": False, "text": target.get("text", ""),
                "edited_at": target.get("edited_at")}
      target["_edit_clock"] = edited_at
      if target.get("text") != text:
        target["text"] = text
        target["edited_at"] = edited_at
      self._write_board_record(post, path)
      return {"status": "ok", "applied": True, "text": target.get("text", ""),
              "edited_at": target.get("edited_at")}

  def get_replies(self, post_id: str, viewer: str | None = None) -> dict:
    path = self.board_dir() / f"{post_id}.json"
    if not path.is_file():
      raise HTTPException(status_code=404, detail="Unknown post.")
    post = self._load_object(path)
    replies = post.get("replies")
    if not isinstance(replies, list):
      replies = []
    presented = []
    for reply in replies:
      if not isinstance(reply, dict):
        continue
      item = dict(reply)
      reactions = self._reaction_hosts(item)
      item.pop("likes", None)
      item.pop("_reaction_replays", None)
      item.pop("_edit_clock", None)
      item.pop("attachment_sha256", None)
      item.pop("thumbnail_sha256", None)
      item["reactions"] = self._public_reactions(reactions, viewer)
      presented.append(item)
    return {
      "replies": self.with_member_profiles(sorted(
        presented,
        key=lambda reply: reply.get("created_at", 0),
      ))
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
      for directory in (self.reply_media_dir(), self.reply_thumbnail_dir()):
        owned = directory / post_id
        if owned.is_dir():
          for asset in owned.iterdir():
            if asset.is_file():
              asset.unlink()
          owned.rmdir()
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


def split_image_name(name: str) -> tuple[str, str | None]:
  """Split the optional file type off the last segment of a board image link.

  The CDN in front of the community host keeps copies only of links that end
  in a file type, so current instances ask for ``<post>/<index>.webp``; older
  instances' type-less links keep working, uncached.
  """
  stem, dot, extension = name.rpartition(".")
  return (stem, extension) if dot else (name, None)


def _not_modified(request: Request, etag: str, modified: float) -> bool:
  candidates = request.headers.get("if-none-match")
  if candidates is not None:
    tags = {tag.strip().removeprefix("W/") for tag in candidates.split(",")}
    return "*" in tags or etag in tags
  since = request.headers.get("if-modified-since")
  if since:
    try:
      return int(modified) <= email.utils.parsedate_to_datetime(since).timestamp()
    except (TypeError, ValueError, IndexError, OverflowError):
      return False
  return False


def immutable_file_response(
  path: Path, media_type: str, request: Request | None = None, *,
  cache_control: str = IMMUTABLE_PUBLIC, etag: str | None = None,
) -> Response:
  """Serve an image whose URL never changes content; revalidation gets a 304."""
  stat = path.stat()
  etag = etag or f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"'
  headers = {
    "Cache-Control": cache_control,
    "ETag": etag,
    "X-Content-Type-Options": "nosniff",
  }
  if request is not None and _not_modified(request, etag, stat.st_mtime):
    return Response(status_code=304, headers=headers)
  return FileResponse(str(path), media_type=media_type, headers=headers)


async def refresh_member_profile(
  store: CommonPublicStore, verifier: ActorVerifier, host: str,
) -> None:
  """Refresh a registered member's handle and shared avatar copy.

  An instance registers once when its owner joins, which can be before they
  choose a handle, and older versions never register again. Re-reading the
  member's own actor card keeps the directory's handle, and so every board
  row by them, current without waiting for their instance to re-register.

  Members list themselves in the shared directory by choice and already serve
  this avatar publicly from their own instance. Holding one re-encoded copy
  here under its content hash lets every viewer's instance fetch it from this
  host once, instead of from each member's own, possibly slow, server.
  """
  try:
    actor = await verifier.fetch_actor(host, force=True)
  except HTTPException as exc:
    logging.getLogger("social").warning("Member handle not refreshed: %s", exc.detail)
  else:
    if actor.get("handle"):
      store.set_member_handle(host, actor["handle"])
  try:
    response = await federation_request(
      "GET", peer_service_url(host, "avatar"),
      max_response_bytes=MAX_AVATAR_BYTES, response_format="binary",
      timeout_seconds=min(OUTBOUND_TIMEOUT_S, 10.0),
    )
  except Exception as exc:
    logging.getLogger("social").warning("Member avatar not refreshed: %s", exc)
    store.keep_member_avatar(host)
    return
  if response.status_code == 404:
    store.set_member_avatar(host, None)
    return
  if response.status_code != 200 or not response.content:
    store.keep_member_avatar(host)
    return
  try:
    _mime, rendition = await asyncio.to_thread(
      image_thumbnail_bytes, response.content,
      MEMBER_AVATAR_MAX_SIDE, MEMBER_AVATAR_MAX_PIXELS,
    )
  except Exception as exc:
    logging.getLogger("social").warning("Member avatar was not a usable image: %s", exc)
    store.keep_member_avatar(host)
    return
  store.set_member_avatar(host, rendition)


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
  posts = []
  while len(posts) <= page_size:
    batch = store.read_board(page_size + 1, cursor, viewer)
    if not batch:
      break
    posts.extend(store.with_member_profiles(batch))
    cursor = _board_record_position(batch[-1])
    if len(batch) <= page_size:
      break
  has_more = len(posts) > page_size
  posts = posts[:page_size]
  for post in posts:
    post["reply_authors"] = store.with_member_profiles(post.get("reply_authors") or [])
  next_cursor = None
  if has_more and posts:
    last = posts[-1]
    position = _board_record_position(last)
    if position is not None:
      next_cursor = _encode_board_cursor(*position)
  return {
    "capabilities": {"emoji_reactions": True, "reply_reactions": True, "author_edits": True, "image_thumbnails": True, "reply_attachments": True, "gif_attachments": True},
    "media_limits": {
      "gif_bytes": MAX_ATTACHMENT_BYTES,
      "static_bytes": MAX_STATIC_ATTACHMENT_BYTES,
      "combined_bytes": MAX_BOARD_TOTAL_ATTACHMENT_BYTES,
      "thumbnail_bytes": MAX_THUMBNAIL_BYTES,
      "max_images": MAX_BOARD_ATTACHMENTS,
      "envelope_bytes": MAX_ATTACHMENT_ENVELOPE_BYTES,
    },
    "posts": posts,
    "next_cursor": next_cursor,
  }


async def send_board_activity(
  private_key_b64: str, board_host: str, *,
  kind: str, author_host: str, actor_host: str, actor_handle: str, post_id: str,
  reply_id: str | None = None, emoji: str | None = None,
  activity_id: str | None = None,
) -> None:
  """Tell a post's author host about a new like or reply, signed by the board host.

  The board host is the authority for activity on the posts it stores. Delivery
  is best-effort: a failed notice never affects the stored like or reply.
  """
  envelope = {
    "v": 0,
    "type": "board_activity",
    "post_id": post_id,
    "kind": kind,
    "actor": actor_host,
    "actor_handle": actor_handle,
    "from": board_host,
    "to": author_host,
    "sent_at": time.time(),
  }
  if reply_id is not None:
    envelope["reply_id"] = reply_id
  if emoji is not None:
    envelope["emoji"] = emoji
  if activity_id is not None:
    envelope["activity_id"] = activity_id
  envelope["sig"] = sign(envelope, private_key_b64)
  try:
    response = await federation_request(
      "POST", peer_service_url(author_host, "activity"), json=envelope,
      max_response_bytes=MAX_ENVELOPE_BYTES,
      timeout_seconds=min(OUTBOUND_TIMEOUT_S, 5.0),
    )
    response.raise_for_status()
  except Exception as exc:
    logging.getLogger("social").warning("Board activity not delivered: %s", exc)


async def verify_named_member(
  store: CommonPublicStore, verifier: ActorVerifier, envelope: dict, *,
  require_registration: bool = True, expected_handle: str | None = None,
) -> dict:
  """Verify a public write whose author must be named by a handle.

  Everything on the board and in the directory is shown by handle, so a member
  without one cannot join or take part. A cached card can predate a handle the
  member has just chosen, so an unnamed or outdated card is re-read once.
  The verified handle is the member's current name, so the directory takes it
  here; every row by them follows without waiting for a sweep.
  """
  actor = await verifier.verify_envelope(envelope)
  if not actor.get("handle") or (
    expected_handle is not None and actor.get("handle") != expected_handle
  ):
    try:
      await verifier.fetch_actor(envelope["from"], force=True)
      actor = await verifier.verify_envelope(envelope)
    except HTTPException:
      if not actor.get("handle"):
        raise HTTPException(status_code=409, detail=NEEDS_USERNAME) from None
      raise
    if not actor.get("handle"):
      raise HTTPException(status_code=409, detail=NEEDS_USERNAME)
  if require_registration and not store.is_member(envelope["from"]):
    raise HTTPException(status_code=403, detail="Join Social first.")
  store.set_member_handle(envelope["from"], actor["handle"])
  return actor


class _PublicEnvelopeAdmission:
  """Reserve bounded wire capacity without queuing bodies awaiting identity.

  Each public router owns two 60 MiB content reservations and eight independent
  32 KiB control reservations. Hold the reservation through ASGI response send,
  not merely decoding: peer verification can await while retaining the envelope.
  A lock makes the nonwaiting accounting safe across threads and event loops.
  """

  def __init__(self):
    self._lock = threading.Lock()
    self._limits = {
      MAX_ATTACHMENT_ENVELOPE_BYTES: MAX_PUBLIC_CONTENT_REQUESTS,
      MAX_ENVELOPE_BYTES: MAX_PUBLIC_CONTROL_REQUESTS,
    }
    self._used = dict.fromkeys(self._limits, 0)

  @asynccontextmanager
  async def reserve(self, body_limit: int):
    with self._lock:
      if self._used[body_limit] >= self._limits[body_limit]:
        raise HTTPException(
          status_code=503, detail="Community request capacity is busy.",
          headers={"Retry-After": "1"},
        )
      self._used[body_limit] += 1
    lifetime = asyncio.timeout(MAX_PUBLIC_REQUEST_SECONDS)
    try:
      try:
        async with lifetime:
          yield
      except TimeoutError:
        if not lifetime.expired():
          raise
        # The absolute reservation budget is exhausted. Cancellation has already
        # unwound the endpoint/response and freed its envelope. Return without
        # another app error send or a media-retaining exception traceback.
        # This bounds app data, not the server connection: Uvicorn may attempt
        # its small fallback500 if response.start never completed. That server
        # task holds neither our envelope nor a reservation; no app retry occurs.
    finally:
      with self._lock:
        self._used[body_limit] -= 1


def create_public_router(
  store: CommonPublicStore, verifier: ActorVerifier, *, prefix: str = "",
  on_activity=None, on_register=None,
) -> tuple[APIRouter, None]:
  """Build the community host's directory and public board surface.

  ``on_activity(kind, author_host, actor_host, actor_handle, post_id)`` is an
  optional awaitable the host calls after a genuine new like or reply by
  someone other than the author, so it can tell the author's instance. It never
  changes the peer-facing response. ``on_register(host)`` is likewise awaited
  after each directory registration (the host refreshes the member's avatar).
  """
  admission = _PublicEnvelopeAdmission()
  content_paths = {f"{prefix}/board", f"{prefix}/board/reply"}

  class AdmittedEnvelopeRoute(APIRoute):
    async def handle(self, scope, receive, send):
      if scope["method"] != "POST" or "POST" not in (self.methods or ()):
        return await super().handle(scope, receive, send)
      body_limit = (MAX_ATTACHMENT_ENVELOPE_BYTES if self.path in content_paths
                    else MAX_ENVELOPE_BYTES)
      async with admission.reserve(body_limit):
        state = scope.setdefault("state", {})
        state["common_envelope_max_bytes"] = body_limit
        try:
          # Unhandled exceptions otherwise retain the decoded envelope in an
          # outer 500-response traceback after releasing this reservation.
          # Keep Community's default 500 send inside the reservation;
          # Starlette re-raises after sending, so failures are not suppressed
          # and the outer middleware will not send an already-started response.
          # This host has no custom 500 hooks. Adding one requires moving the
          # admission outside the app's outer error layer to avoid a second call.
          # Native debug rendering is preserved, but outer HTML re-rendering
          # after release is outside this frozen debug=False resource contract.
          await ServerErrorMiddleware(
            super().handle, debug=scope["app"].debug,
          )(scope, receive, send)
        finally:
          state.pop("common_envelope_max_bytes", None)

  router = APIRouter(prefix=prefix, tags=["common-public"],
                     route_class=AdmittedEnvelopeRoute)

  @router.get("/directory")
  def reject_public_directory():
    raise HTTPException(
      status_code=403, detail="Join Social to see People.",
      headers={"Cache-Control": "no-store"},
    )

  @router.post("/directory/search")
  async def search_directory_for_member(request: Request):
    envelope = await read_envelope(request)
    if envelope.get("v") != 0 or envelope.get("type") != "directory_read":
      raise HTTPException(status_code=400, detail="Unsupported envelope type.")
    q = envelope.get("q")
    if not isinstance(q, str) or len(q) > MAX_NAME_CHARS:
      raise HTTPException(status_code=400, detail="Directory search is invalid.")
    await verifier.verify_envelope(envelope)
    if not store.is_member(envelope["from"]):
      raise HTTPException(status_code=403, detail="Join Social to see People.")
    return store.search_directory(q)

  @router.post("/directory")
  async def register_in_directory(request: Request):
    envelope = await read_envelope(request)
    if envelope.get("v") != 0 or envelope.get("type") != "register":
      raise HTTPException(status_code=400, detail="Unsupported envelope type.")
    claimed_handle = envelope.get("handle")
    if not isinstance(claimed_handle, str) or len(claimed_handle) > MAX_NAME_CHARS:
      raise HTTPException(status_code=400, detail="Directory profile is invalid.")
    actor = await verify_named_member(
      store, verifier, envelope, require_registration=False,
      expected_handle=claimed_handle,
    )
    handle = actor["handle"]
    bio = envelope.get("bio") or ""
    if (
      not isinstance(handle, str) or len(handle) > MAX_NAME_CHARS
      or not isinstance(bio, str) or len(bio) > MAX_BIO_CHARS
    ):
      raise HTTPException(status_code=400, detail="Directory profile is invalid.")
    registered = store.register(envelope["from"], handle, bio)
    if on_register is not None:
      await on_register(envelope["from"])
    return {**registered, "handle": handle}

  @router.get("/directory/avatars/{name}")
  def get_member_avatar(name: str, request: Request):
    path = store.member_avatar_file(name)
    if path is None:
      raise HTTPException(
        status_code=404, detail="Avatar not found.", headers=NOT_FOUND_UNCACHED,
      )
    return immutable_file_response(
      path, "image/webp", request, etag=f'"{path.stem}"',
    )

  @router.get("/board")
  def get_board(
    limit: int = 30, before: str | None = None, viewer: str | None = None,
  ):
    if viewer is not None and not valid_host(viewer):
      viewer = None
    return read_board_page(store, limit, before, viewer)

  # Each image route also answers with the file type appended to its last
  # segment (see split_image_name).
  def checked_post_id(post_id: str) -> str:
    if not valid_id(post_id):
      raise HTTPException(status_code=400, detail="Post id is invalid.")
    return post_id

  def checked_index(text: str) -> int:
    # One spelling per index ("5", never "05"), so shared caches keep one copy.
    if (
      not (text.isascii() and text.isdigit())
      or str(int(text)) != text or int(text) >= MAX_BOARD_ATTACHMENTS
    ):
      raise HTTPException(status_code=400, detail="Image index is invalid.")
    return int(text)

  def serve_board_image(found, extension: str | None, request: Request):
    # A link naming another type would store a second, mislabelled copy in
    # shared caches.
    if found is not None and extension is not None and found[0].suffix != f".{extension}":
      found = None
    return store.serve_image(found, request)

  @router.get("/board/media/{name}")
  def get_board_media(name: str, request: Request):
    post_id, extension = split_image_name(name)
    found = store.board_image(checked_post_id(post_id))
    return serve_board_image(found, extension, request)

  @router.get("/board/media/{post_id}/{name}")
  def get_board_media_at(post_id: str, name: str, request: Request):
    index, extension = split_image_name(name)
    found = store.board_image(checked_post_id(post_id), checked_index(index))
    return serve_board_image(found, extension, request)

  @router.get("/board/thumbnail/{name}")
  def get_board_thumbnail(name: str, request: Request):
    post_id, extension = split_image_name(name)
    found = store.board_thumbnail(checked_post_id(post_id))
    return serve_board_image(found, extension, request)

  @router.get("/board/thumbnail/{post_id}/{name}")
  def get_board_thumbnail_at(post_id: str, name: str, request: Request):
    index, extension = split_image_name(name)
    found = store.board_thumbnail(checked_post_id(post_id), checked_index(index))
    return serve_board_image(found, extension, request)

  @router.get("/board/{post_id}/replies")
  def get_board_replies(post_id: str):
    if not valid_id(post_id):
      raise HTTPException(status_code=400, detail="Post id is invalid.")
    return store.get_replies(post_id)

  @router.get("/board/{post_id}/replies/{name}/media")
  @router.get("/board/{post_id}/replies/{name}/thumbnail")
  def get_reply_image(post_id: str, name: str, request: Request):
    # Prefer the typed /media.ext and /thumbnail.ext routes below; this bare
    # route remains useful to callers without metadata.
    return serve_board_image(store.reply_image(checked_post_id(post_id), checked_post_id(name),
      thumbnail=request.url.path.endswith("/thumbnail")), None, request)

  @router.get("/board/{post_id}/replies/{reply_id}/media.{extension}")
  @router.get("/board/{post_id}/replies/{reply_id}/thumbnail.{extension}")
  def get_typed_reply_image(post_id: str, reply_id: str, extension: str, request: Request):
    return serve_board_image(store.reply_image(checked_post_id(post_id), checked_post_id(reply_id),
      thumbnail="/thumbnail." in request.url.path), extension, request)

  @router.post("/board/{post_id}/replies")
  async def get_member_board_replies(post_id: str, request: Request):
    envelope = await read_envelope(request)
    if envelope.get("v") != 0 or envelope.get("type") != "board_replies":
      raise HTTPException(status_code=400, detail="Unsupported envelope type.")
    if not valid_id(post_id) or envelope.get("post_id") != post_id:
      raise HTTPException(status_code=400, detail="Post id is invalid.")
    await verifier.verify_envelope(envelope)
    if not store.is_member(envelope["from"]):
      raise HTTPException(status_code=403, detail="Join Social to see your reactions.")
    return store.get_replies(post_id, envelope["from"])

  @router.post("/board/react")
  async def react_to_board(request: Request):
    envelope = await read_envelope(request)
    if envelope.get("v") != 0 or envelope.get("type") != "board_react":
      raise HTTPException(status_code=400, detail="Unsupported envelope type.")
    post_id = envelope.get("post_id")
    if not valid_id(post_id):
      raise HTTPException(status_code=400, detail="Post id is invalid.")
    reply_id = envelope.get("reply_id")
    if reply_id is not None and not valid_id(reply_id):
      raise HTTPException(status_code=400, detail="Reply id is invalid.")
    actor = await verify_named_member(store, verifier, envelope)
    replay_token = hashlib.sha256(canonical(envelope)).hexdigest()
    emoji = envelope.get("emoji")
    result = (
      store.toggle_like(post_id, envelope["from"], replay_token=replay_token)
      if emoji is None and reply_id is None
      else store.toggle_reaction(
        post_id, envelope["from"], emoji if emoji is not None else "❤️", reply_id=reply_id,
        replay_token=replay_token,
      )
    )
    author_host = result.pop("author_host", None)
    activity = result.pop("activity", False)
    if on_activity and activity and author_host not in (None, envelope["from"]):
      await on_activity(
        "like", author_host, envelope["from"],
        actor.get("handle") or "", post_id, reply_id=reply_id, emoji=emoji,
        activity_id=replay_token,
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
    validate_attachment_envelope_size(envelope)
    actor = await verify_named_member(store, verifier, envelope)
    text = envelope.get("text")
    attachment = validate_attachment(envelope.get("attachment"))
    thumbnail = validate_attachment(envelope.get("thumbnail"), thumbnail=True)
    validate_text_or_attachment(text, attachment, "Reply text is invalid.", MAX_REPLY_TEXT_CHARS)
    result = store.add_reply(
      post_id, reply_id, envelope["from"], actor["handle"],
      text, envelope["sent_at"], attachment, thumbnail,
    )
    author_host = result.pop("author_host", None)
    activity = result.pop("activity", False)
    if on_activity and activity and author_host not in (None, envelope["from"]):
      await on_activity(
        "reply", author_host, envelope["from"], actor.get("handle") or "", post_id,
        reply_id=reply_id, activity_id=reply_id,
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
    if not store.is_member(envelope["from"]):
      raise HTTPException(status_code=403, detail="Join Social first.")
    return store.delete_post(post_id, envelope["from"])

  # Reply deletion and edits use their own envelope types so an older host
  # rejects them (400/404) instead of reading them as a whole-post delete.
  @router.post("/board/reply/delete")
  async def delete_reply_from_board(request: Request):
    envelope = await read_envelope(request)
    if envelope.get("v") != 0 or envelope.get("type") != "board_reply_delete":
      raise HTTPException(status_code=400, detail="Unsupported envelope type.")
    post_id = envelope.get("post_id")
    reply_id = envelope.get("reply_id")
    if not valid_id(post_id) or not valid_id(reply_id):
      raise HTTPException(status_code=400, detail="Post or reply id is invalid.")
    await verifier.verify_envelope(envelope)
    if not store.is_member(envelope["from"]):
      raise HTTPException(status_code=403, detail="Join Social first.")
    return store.delete_reply(post_id, reply_id, envelope["from"])

  @router.post("/board/edit")
  async def edit_on_board(request: Request):
    envelope = await read_envelope(request)
    if envelope.get("v") != 0 or envelope.get("type") != "board_edit":
      raise HTTPException(status_code=400, detail="Unsupported envelope type.")
    post_id = envelope.get("post_id")
    reply_id = envelope.get("reply_id")
    if not valid_id(post_id) or (reply_id is not None and not valid_id(reply_id)):
      raise HTTPException(status_code=400, detail="Post or reply id is invalid.")
    text = envelope.get("text")
    max_chars = MAX_POST_TEXT_CHARS if reply_id is None else MAX_REPLY_TEXT_CHARS
    if not isinstance(text, str) or len(text) > max_chars:
      raise HTTPException(status_code=400, detail="Text is invalid.")
    await verifier.verify_envelope(envelope)
    if not store.is_member(envelope["from"]):
      raise HTTPException(status_code=403, detail="Join Social first.")
    return store.edit_text(post_id, reply_id, envelope["from"], text, envelope["sent_at"])

  @router.post("/board")
  async def post_to_board(request: Request):
    envelope = await read_envelope(request)
    if envelope.get("v") != 0 or envelope.get("type") != "board_post":
      raise HTTPException(status_code=400, detail="Unsupported envelope type.")
    post_id = envelope.get("id")
    if not valid_id(post_id):
      raise HTTPException(status_code=400, detail="Post id is invalid.")
    actor = await verify_named_member(store, verifier, envelope)
    first_wire, gallery = envelope.get("attachment"), envelope.get("attachments")
    if first_wire is not None and isinstance(gallery, list) and gallery and first_wire == gallery[0]:
      # The legacy first-image copy repeats the gallery's first wire; decode
      # and check those bytes once rather than twice.
      attachments = validate_attachments(gallery)
      attachment = attachments[0]
    else:
      attachment = validate_attachment(first_wire)
      attachments = validate_attachments(gallery)
    if attachment is not None and attachments and attachment[0] != attachments[0][0]:
      raise HTTPException(status_code=400, detail="First post image does not match its gallery copy.")
    thumbnails = validate_attachments(envelope.get("thumbnails"), thumbnail=True)
    image_count = len(attachments) if attachments else (1 if attachment else 0)
    if thumbnails and len(thumbnails) != image_count:
      raise HTTPException(status_code=400, detail="Post thumbnails are invalid.")
    text = envelope.get("text")
    first = attachment or (attachments[0] if attachments else None)
    validate_text_or_attachment(
      text, first, "Post text is invalid.", MAX_POST_TEXT_CHARS,
    )
    store.store_post({
      "id": post_id,
      "host": envelope["from"],
      "handle": actor["handle"],
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
