"""Social federation — the Möbius-to-Möbius social layer (protocol v0).

Every Möbius instance is one user's server. This router gives an instance
three federated capabilities, all instance-to-instance over HTTPS with
Ed25519-signed envelopes and no third-party storage:

1. **Identity** — an actor card (`GET /actor`) publishing federation keys.
   Private participants expose only those keys; joining the community also
   publishes the owner's profile card. Peers verify every envelope against
   the claimed sender's fetched (and cached) actor card.
2. **Direct messages** — a signed envelope POSTed straight to the recipient
   instance's `/inbox`. A first inbound conversation is stored as a quiet
   message request until its owner accepts; an explicit first outbound message
   establishes consent. Each side stores only its own copy (in the Common
   mini-app's per-app storage), so a conversation lives exclusively on the two
   participants' servers.
3. **Community host role** — the shared host serves a members-only directory
   and a public message board. Peers register and
   post with the same signed-envelope scheme. Which host to use is the
   owner's choice (default: their own instance).

Public peer surface (no owner auth; envelope signatures are the authority):
  GET  /api/app-services/social/actor        federation keys; joined profile card
  GET  /api/app-services/social/avatar       instance profile avatar
  POST /api/app-services/social/inbox        deliver a signed DM
  GET|POST /api/app-services/social/directory  join and directory access control
  GET|POST /api/app-services/social/board      public board
  GET /api/app-services/social/board/{media|thumbnail}/{post_id}[/{index}][.{type}]
      hosted board image; links ending in the type are CDN-cacheable
  POST /api/app-services/social/board/reply    signed board reply
  GET /api/app-services/social/board/{post_id}/replies  hosted post replies

Owner surface (owner JWT or the Social app's scoped token):
  GET  /api/services/social/me           own profile (creates the keypair lazily)
  PUT  /api/services/social/me           update profile; re-registers with community host
  POST /api/services/social/send         sign + deliver a DM; store own copy
  POST /api/services/social/requests/dm/{host}/{decision}  accept/decline/block request
  POST /api/services/social/publish      sign + submit a board post to the community host
  GET  /api/services/social/board-media/{post_id}[/{index}]?thumbnail=&mime=
      local/cached community board image (mime: the type the post records)
  POST /api/services/social/reply        sign + submit a board reply to the community host
  GET  /api/services/social/feed         community host's board (local read when self)
  GET  /api/services/social/people       member-only directory search
  GET  /api/services/social/peer/{host}  a peer's actor card (profile view)
  POST /api/services/social/peer-avatars  a bounded visible-avatar batch

Server-owned state lives under `<data_dir>/common/` (identity + community-host
records). Conversation data lives in the Social app's per-app storage so
the app UI reads it through `window.mobius.storage`.
"""

from __future__ import annotations

import base64
import asyncio
import fcntl
import hashlib
import json
import logging
import os
import re
import time
import uuid
import weakref
from pathlib import Path
from contextlib import asynccontextmanager, contextmanager
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel

from common_protocol import (
  ATTACHMENT_MIME_EXT as _ATTACHMENT_MIME_EXT,
  MAX_ATTACHMENT_BYTES, MAX_STATIC_ATTACHMENT_BYTES, MAX_THUMBNAIL_BYTES,
  MAX_AVATAR_BYTES, MAX_BIO_CHARS,
  COMMUNITY_HOST, MAX_BOARD_ATTACHMENTS as _MAX_BOARD_ATTACHMENTS,
  MAX_ENVELOPE_BYTES, MAX_NAME_CHARS, MAX_POST_TEXT_CHARS, MAX_REPLY_TEXT_CHARS,
  CLOCK_SKEW_S,
  NEEDS_USERNAME, OUTBOUND_TIMEOUT_S, PROTOCOL, PUBLIC_SERVICE_PATH, ActorVerifier,
  canonical as _canonical, peer_service_url as _peer_service_url,
  post_signed_envelope as _post_signed_envelope,
  new_signing_key, read_envelope as _read_envelope, sign as _sign,
  signing_public_key,
  valid_host as _valid_host, valid_id as _valid_id,
  validate_attachment as _validate_attachment,
  validate_attachment_envelope_size as _validate_attachment_envelope_size,
  validate_attachments as _validate_attachments,
  validate_reply_to as _validate_reply_to,
  validate_text_or_attachment as _validate_text_or_attachment,
  wire_json_size as _wire_json_size,
)
from common_public import (
  AVATAR_DIGEST, BOARD_REACTION_EMOJIS, CommonPublicStore, image_thumbnail_bytes,
)
from common_transport import DEFAULT_MAX_RESPONSE_BYTES, FederationTransportError, federation_request
from service_io import atomic_write
from message_history import (
  begin_message_mutation, load_page, mark_version_covered, mirror_message,
)
from service_runtime import (
  APP, Principal, fs_locks, get_db, get_principal, get_settings,
  identity_app_id, notify, owner_profile, public_actor_metadata, record_badge,
  require_nondelegated_owner_control,
)

router = APIRouter(tags=["common"])
_log = logging.getLogger(__name__)

APP_SLUG = "social"
PEER_AVATAR_CACHE_TTL_S = 24 * 3600
# A confirmed absence can cool down longer than a transient failure. Both need
# on-disk markers because each service request runs in a fresh process.
PEER_AVATAR_MISS_TTL_S = 15 * 60
PEER_AVATAR_FAILURE_TTL_S = 45
# Raster decode is deliberately serialized across service processes. Eight
# worst-case accepted images leave headroom inside the process budget.
PEER_AVATAR_BATCH_LIMIT = 8
# Keep each peer inside the app-service's 15-second process ceiling while
# leaving time to encode and return successful peers from the same batch.
PEER_AVATAR_BATCH_TIMEOUT_S = 12
# Capability discovery and a signed Community write share one budget, leaving room for
# service startup and a useful error before the 15-second process ceiling.
COMMUNITY_WRITE_TIMEOUT_S = 13
# Peer avatars are re-encoded to a small validated raster before caching, so a
# malicious raster never reaches the browser and cached blobs stay tiny.
AVATAR_MAX_SIDE = 128
AVATAR_MAX_PIXELS = 8_000_000
# Owner-facing board images: one post image per URL, dropped after a day in
# case the post is deleted.
OWNER_BOARD_IMAGE_CACHE = "private, max-age=86400"
BOARD_MEDIA_CACHE_TTL_S = 24 * 3600
# Peer board media is a regenerable cache. The TTL only decides when a cached
# file is refreshed while its peer is reachable; an expired copy is still served
# when the peer is offline, so age alone never evicts. The byte cap bounds
# growth with the number of peers by evicting least-recently used full-size
# originals first, then thumbnails (the board's fast path).
BOARD_MEDIA_CACHE_MAX_BYTES = 16 * 1024 * 1024
REQUEST_STATES = {"pending", "accepted", "declined", "blocked"}


# ── paths ────────────────────────────────────────────────────────────────────

def _data_dir() -> str:
  return get_settings().data_dir


def _common_dir() -> Path:
  path = Path(_data_dir()) / "common"
  path.mkdir(parents=True, exist_ok=True)
  return path


_actor_verifier = ActorVerifier(_data_dir)
_find_image = CommonPublicStore.find_image
_fetch_actor = _actor_verifier.fetch_actor
_verify_peer_envelope = _actor_verifier.verify_envelope


def _serve_image(found):
  # Social's own sandboxed frame gets a fresh browser cache per launch, so it
  # also keeps thumbnails in app storage (boardMediaCache.js).
  return CommonPublicStore.serve_image(found, cache_control=OWNER_BOARD_IMAGE_CACHE)


class _PinnedBoardMediaResponse(FileResponse):
  """Keep native file/range responses bound to the opened cache inode."""

  def __init__(self, found: tuple[Path, str]):
    path, mime = found
    opened = path.open("rb")
    try:
      stat = os.fstat(opened.fileno())
      self.fetched_at = stat.st_mtime
      super().__init__(
        f"/proc/self/fd/{opened.fileno()}", media_type=mime,
        stat_result=stat,
        headers={
          "cache-control": OWNER_BOARD_IMAGE_CACHE,
          "etag": f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"',
          "x-content-type-options": "nosniff",
        },
      )
    except BaseException:
      opened.close()
      raise
    self._opened = opened
    # An uninvoked response has no ASGI lifecycle to release its descriptor.
    self._finalizer = weakref.finalize(self, opened.close)

  def close(self) -> None:
    self._finalizer()

  async def __call__(self, scope, receive, send):
    try:
      # pathsend can defer opening until after this response releases its fd.
      if "http.response.pathsend" in scope.get("extensions", {}):
        scope = {**scope, "extensions": {
          key: value for key, value in scope["extensions"].items()
          if key != "http.response.pathsend"
        }}
      await super().__call__(scope, receive, send)
    finally:
      self.close()


def _identity_path() -> Path:
  # Unlike the other Common paths, callers use this to distinguish an
  # untouched installation. Merely probing /actor must not materialize state.
  return Path(get_settings().data_dir) / "common" / "identity.json"


def _identity_lock_path() -> Path:
  return _identity_path().with_name(".identity.lock")


def _avatar_path() -> Path:
  return _common_dir() / "avatar.png"


def _peers_dir() -> Path:
  return _actor_verifier.peers_dir()


def _peer_avatar_path(host: str) -> Path:
  safe = re.sub(r"[^a-z0-9.-]", "_", host)
  path = _peers_dir() / "avatars"
  path.mkdir(parents=True, exist_ok=True)
  # Re-encoded WebP; a legacy `.png` cache is simply re-fetched once.
  return path / f"{safe}.webp"


def _peer_avatar_digest_path(host: str) -> Path:
  """Content hash of a cached avatar copied from the community directory."""
  safe = re.sub(r"[^a-z0-9.-]", "_", host)
  return _peers_dir() / "avatars" / f"{safe}.digest"


def _peer_avatar_miss_path(host: str) -> Path:
  safe = re.sub(r"[^a-z0-9.-]", "_", host)
  return _peers_dir() / "avatars" / f"{safe}.miss"


def _peer_avatar_failure_path(host: str) -> Path:
  safe = re.sub(r"[^a-z0-9.-]", "_", host)
  return _peers_dir() / "avatars" / f"{safe}.fail"


def _mark_avatar_miss(host: str) -> None:
  try:
    atomic_write(_peer_avatar_miss_path(host), b"")
  except OSError:
    pass


def _mark_avatar_failure(host: str) -> None:
  try:
    atomic_write(_peer_avatar_failure_path(host), b"")
  except OSError:
    pass


def _clear_avatar_markers(host: str) -> None:
  for path in (_peer_avatar_miss_path(host), _peer_avatar_failure_path(host)):
    try:
      path.unlink()
    except OSError:
      pass


def _recent_marker(path: Path, ttl: float, now: float) -> bool:
  try:
    return path.is_file() and now - path.stat().st_mtime < ttl
  except OSError:
    return False


@contextmanager
def _peer_avatar_decode_lock():
  """Bound raster decode memory across the service's per-request processes."""
  path = _peers_dir() / "avatars" / ".decode.lock"
  path.parent.mkdir(parents=True, exist_ok=True)
  # Keep this inode permanent: unlinking a lock can create two lock owners.
  with path.open("a+b") as handle:
    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
    try:
      yield
    finally:
      fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


_avatar_decode_gate = None
_avatar_decode_gate_loop = None


def _current_avatar_decode_gate() -> asyncio.Lock:
  """Return one in-process gate so timed-out requests do not queue workers."""
  global _avatar_decode_gate, _avatar_decode_gate_loop
  loop = asyncio.get_running_loop()
  if _avatar_decode_gate is None or _avatar_decode_gate_loop is not loop:
    _avatar_decode_gate = asyncio.Lock()
    _avatar_decode_gate_loop = loop
  return _avatar_decode_gate


def _decode_avatar_sync(raw: bytes) -> tuple[str, bytes]:
  """Own the file lock for the entire raster decode, even after cancellation."""
  with _peer_avatar_decode_lock():
    return image_thumbnail_bytes(raw, AVATAR_MAX_SIDE, AVATAR_MAX_PIXELS)


def _consume_cancelled_decode(task: asyncio.Task) -> None:
  try:
    task.result()
  except (asyncio.CancelledError, Exception):
    pass


async def _decode_avatar(raw: bytes) -> tuple[str, bytes]:
  """Decode off-loop with one active worker and cancellation-safe lock ownership."""
  started = False

  async def run() -> tuple[str, bytes]:
    nonlocal started
    async with _current_avatar_decode_gate():
      started = True
      return await asyncio.to_thread(_decode_avatar_sync, raw)

  task = asyncio.create_task(run())
  try:
    return await asyncio.shield(task)
  except asyncio.CancelledError:
    if not started:
      task.cancel()
    else:
      # The worker owns the lock until PIL returns; consume its eventual result
      # without keeping the timed-out request alive or leaking task exceptions.
      task.add_done_callback(_consume_cancelled_decode)
    raise


def _peer_board_media_dir() -> Path:
  path = _peers_dir() / "board-media"
  path.mkdir(parents=True, exist_ok=True)
  return path


@asynccontextmanager
async def _peer_board_media_lock(cache_dir: Path):
  """Serialize cache writes, eviction, and pinning across service processes."""
  # Never unlink this inode: two processes could otherwise lock different files.
  with (cache_dir / ".media.lock").open("a+b") as handle:
    while True:
      try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
      except BlockingIOError:
        await asyncio.sleep(0.02)
    try:
      yield
    finally:
      fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _peer_board_media_name(host: str, post_id: str) -> str:
  safe_host = re.sub(r"[^a-z0-9.-]", "_", host)
  return f"{safe_host}-{post_id}"


def _mark_board_media_used(path: Path) -> None:
  """Record a cache hit for LRU eviction without touching freshness.

  Recency lives in atime, set explicitly so relatime/noatime mounts don't hide
  it; mtime stays the fetch time that the freshness TTL reads.
  """
  try:
    stat = path.stat()
    os.utime(path, (time.time(), stat.st_mtime))
  except OSError:
    pass


def _evict_peer_board_media(cache_dir: Path, keep: Path) -> None:
  """Bring the cache under its byte cap, never on age alone.

  Full-size originals go before thumbnails, least recently used first, so an
  offline peer's older photos keep serving from cache until space is needed.
  Runtime callers hold _peer_board_media_lock through eviction and response pin.
  """
  entries = []
  for path in cache_dir.iterdir():
    if path.name.startswith(".") or not path.is_file() or path == keep:
      continue
    try:
      stat = path.stat()
    except OSError:
      continue
    last_used = max(stat.st_atime, stat.st_mtime)
    is_thumbnail = path.stem.endswith("-thumb")
    entries.append((is_thumbnail, last_used, stat.st_size, path))
  try:
    total = keep.stat().st_size + sum(entry[2] for entry in entries)
  except OSError:
    return
  for _is_thumbnail, _last_used, size, path in sorted(entries):
    if total <= BOARD_MEDIA_CACHE_MAX_BYTES:
      break
    path.unlink(missing_ok=True)
    total -= size


def _own_host() -> str:
  return get_settings().domain


async def _download_avatar(url: str) -> bytes:
  """Fetch one image while bounding the response body before buffering it."""
  response = await federation_request(
    "GET", url, max_response_bytes=MAX_AVATAR_BYTES,
    response_format="binary", timeout_seconds=OUTBOUND_TIMEOUT_S,
  )
  response.raise_for_status()
  content_type = response.headers.get("content-type", "").split(";", 1)[0]
  if not content_type.strip().lower().startswith("image/"):
    raise ValueError("Avatar response is not an image.")
  if not response.content:
    raise ValueError("Avatar response is empty.")
  return response.content


async def _download_board_media(url: str, *, thumbnail: bool = False) -> tuple[str, bytes]:
  """Fetch one hosted board image without buffering more than the wire cap."""
  response = await federation_request(
    # Existing hosts stored posters up to 1 MiB. Read that bounded legacy
    # allowance, then re-encode to the current thumbnail output budget.
    "GET", url, max_response_bytes=(1024 * 1024 if thumbnail else MAX_ATTACHMENT_BYTES),
    response_format="binary", timeout_seconds=OUTBOUND_TIMEOUT_S,
  )
  response.raise_for_status()
  mime = (
    response.headers.get("content-type", "")
    .split(";", 1)[0].strip().lower()
  )
  if mime not in _ATTACHMENT_MIME_EXT:
    raise ValueError("Board media response is not a supported image.")
  if not response.content:
    raise ValueError("Board media response is empty.")
  return mime, response.content


def _dm_key(shared: bytes) -> bytes:
  from cryptography.hazmat.primitives import hashes
  from cryptography.hazmat.primitives.kdf.hkdf import HKDF
  return HKDF(
    algorithm=hashes.SHA256(),
    length=32,
    salt=b"",
    info=b"common/0 dm v1",
  ).derive(shared)


def _seal_dm(
  message_id: str, recipient_key_b64: str, *, text: str,
  attachment: dict | None, reply_to: dict | None,
) -> dict:
  """Seal one canonical DM payload to a peer's static X25519 key."""
  from cryptography.hazmat.primitives import serialization
  from cryptography.hazmat.primitives.asymmetric.x25519 import (
    X25519PrivateKey, X25519PublicKey,
  )
  from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
  recipient = X25519PublicKey.from_public_bytes(
    base64.b64decode(recipient_key_b64, validate=True)
  )
  ephemeral = X25519PrivateKey.generate()
  key = _dm_key(ephemeral.exchange(recipient))
  nonce = os.urandom(12)
  plaintext = _canonical({
    "text": text, "attachment": attachment, "reply_to": reply_to,
  })
  ciphertext = ChaCha20Poly1305(key).encrypt(
    nonce, plaintext, message_id.encode("utf-8")
  )
  ephemeral_public = ephemeral.public_key().public_bytes(
    encoding=serialization.Encoding.Raw,
    format=serialization.PublicFormat.Raw,
  )
  return {
    "v": 1,
    "epk_b64": base64.b64encode(ephemeral_public).decode(),
    "nonce_b64": base64.b64encode(nonce).decode(),
    "ct_b64": base64.b64encode(ciphertext).decode(),
  }


def _open_dm(message_id: str, enc: Any, private_key_b64: str) -> dict:
  """Open one sealed DM payload or return the protocol's generic failure."""
  from cryptography.hazmat.primitives.asymmetric.x25519 import (
    X25519PrivateKey, X25519PublicKey,
  )
  from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
  try:
    if not isinstance(enc, dict) or set(enc) != {
      "v", "epk_b64", "nonce_b64", "ct_b64",
    } or enc.get("v") != 1:
      raise ValueError("invalid sealed payload")
    if not all(
      isinstance(enc.get(field), str)
      for field in ("epk_b64", "nonce_b64", "ct_b64")
    ):
      raise ValueError("invalid sealed payload")
    ephemeral_bytes = base64.b64decode(enc["epk_b64"], validate=True)
    nonce = base64.b64decode(enc["nonce_b64"], validate=True)
    ciphertext = base64.b64decode(enc["ct_b64"], validate=True)
    if len(ephemeral_bytes) != 32 or len(nonce) != 12:
      raise ValueError("invalid sealed payload")
    ephemeral = X25519PublicKey.from_public_bytes(ephemeral_bytes)
    private = X25519PrivateKey.from_private_bytes(
      base64.b64decode(private_key_b64, validate=True)
    )
    plaintext = ChaCha20Poly1305(
      _dm_key(private.exchange(ephemeral))
    ).decrypt(nonce, ciphertext, message_id.encode("utf-8"))
    payload = json.loads(plaintext)
    if not isinstance(payload, dict) or set(payload) != {
      "text", "attachment", "reply_to",
    }:
      raise ValueError("invalid sealed payload")
    return payload
  except Exception as exc:
    raise HTTPException(
      status_code=400, detail="Message could not be decrypted."
    ) from exc


def _message_preview(text: str) -> str:
  return text[:120] if text.strip() else "📷 Photo"


def _write_app_attachment(
  container: Path, message_id: str, attachment: tuple[dict, bytes]
) -> dict:
  wire, data = attachment
  ext = _ATTACHMENT_MIME_EXT[wire["mime"]]
  relative = Path("media") / f"{message_id}.{ext}"
  path = container / relative
  path.parent.mkdir(parents=True, exist_ok=True)
  atomic_write(path, data)
  return {
    "mime": wire["mime"], "w": wire["w"], "h": wire["h"],
    "file": relative.as_posix(), "sha256": hashlib.sha256(data).hexdigest(),
  }


# ── identity ────────────────────────────────────────────────────────────────

def _new_encryption_keypair() -> tuple[str, str]:
  """Return a raw X25519 private/public keypair encoded as base64."""
  from cryptography.hazmat.primitives import serialization
  from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
  key = X25519PrivateKey.generate()
  private_b64 = base64.b64encode(
    key.private_bytes(
      encoding=serialization.Encoding.Raw,
      format=serialization.PrivateFormat.Raw,
      encryption_algorithm=serialization.NoEncryption(),
    )
  ).decode()
  public_b64 = base64.b64encode(
    key.public_key().public_bytes(
      encoding=serialization.Encoding.Raw,
      format=serialization.PublicFormat.Raw,
    )
  ).decode()
  return private_b64, public_b64


def _encryption_public_key(private_key_b64: str) -> str:
  """Derive the advertised X25519 key from the key that decrypts messages."""
  from cryptography.hazmat.primitives import serialization
  from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
  key = X25519PrivateKey.from_private_bytes(
    base64.b64decode(private_key_b64, validate=True)
  )
  return base64.b64encode(
    key.public_key().public_bytes(
      encoding=serialization.Encoding.Raw,
      format=serialization.PublicFormat.Raw,
    )
  ).decode()


def _load_identity(*, locked: bool = False) -> dict:
  """Load (or lazily create) this instance's federation identity."""
  path = _identity_path()
  if path.is_file():
    identity = json.loads(path.read_text())
    if identity.get("enc_private_key_b64"):
      return identity
  if not locked:
    # Only first-use creation/migration writes here. Its lock-holder does not
    # await before saving the keys, so a synchronous caller cannot deadlock an
    # async registration waiting on the same event loop.
    lock_path = _identity_lock_path()
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as handle:
      fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
      try:
        return _load_identity(locked=True)
      finally:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
  if path.is_file():
    identity = json.loads(path.read_text())
    if not identity.get("enc_private_key_b64"):
      private_b64, public_b64 = _new_encryption_keypair()
      identity["enc_private_key_b64"] = private_b64
      identity["enc_public_key_b64"] = public_b64
      _save_identity(identity)
    return identity
  private_b64 = new_signing_key()
  public_b64 = signing_public_key(private_b64)
  enc_private_b64, enc_public_b64 = _new_encryption_keypair()
  identity = {
    "private_key_b64": private_b64,
    "public_key_b64": public_b64,
    "enc_private_key_b64": enc_private_b64,
    "enc_public_key_b64": enc_public_b64,
    "name": "",
    "bio": "",
    "created_at": int(time.time()),
  }
  atomic_write(path, json.dumps(identity, indent=2))
  path.chmod(0o600)
  return identity


def _save_identity(identity: dict) -> None:
  path = _identity_path()
  atomic_write(path, json.dumps(identity, indent=2))
  path.chmod(0o600)


def _key_actor_doc(identity: dict) -> dict:
  """The key-only actor card used by private federation peers."""
  return {
    "protocol": PROTOCOL,
    "host": _own_host(),
    "public_key": {
      "alg": "ed25519",
      "key_b64": signing_public_key(identity["private_key_b64"]),
    },
    "encryption_key": {
      "alg": "x25519",
      "key_b64": _encryption_public_key(identity["enc_private_key_b64"]),
    },
    "inbox": f"{PUBLIC_SERVICE_PATH}/inbox",
  }


def _actor_doc(identity: dict, metadata: dict) -> dict:
  """The joined public profile card; the display name remains local."""
  host = _own_host()
  return {
    **_key_actor_doc(identity),
    "address": f"{identity.get('handle') or 'someone'}@{host}",
    "handle": identity.get("handle") or "",
    "bio": identity.get("bio") or "",
    "avatar": _avatar_path().is_file(),
    "joined_at": identity.get("joined_at") or None,
    "member_since": metadata["member_since"],
    "apps": metadata["apps"],
  }


# ── peer actor cache ────────────────────────────────────────────────────────

# ── conversation storage (in the Social app's per-app storage) ──────────────

def _common_app(db=None):
  return APP


def _app_data_dir(app) -> Path:
  return Path(os.environ["APP_STORAGE_DIR"])


def _conversation_dir(app, peer_host: str) -> Path:
  safe = re.sub(r"[^a-z0-9.-]", "_", peer_host)
  return _app_data_dir(app) / "conversations" / safe


def _message_path(app, peer_host: str, message_id: str) -> Path:
  return _conversation_dir(app, peer_host) / "msgs" / f"{message_id}.json"


def _bump_version(app, *, history_covered: bool = True) -> int:
  """Advance the app's change counter (call while holding its storage lock).

  The open app UI watches this one small file to learn that new federated
  data (a DM, a group message) landed in its storage.
  """
  version_path = _app_data_dir(app) / "state" / "version.json"
  version_path.parent.mkdir(parents=True, exist_ok=True)
  version = 0
  if version_path.is_file():
    version = int(json.loads(version_path.read_text()).get("v") or 0)
  version += 1
  atomic_write(version_path, json.dumps({"v": version, "updated_at": time.time()}))
  if history_covered:
    mark_version_covered(version)
  record_badge(_app_data_dir(app), version)
  return version


async def _store_message(
  db, app, peer_host: str, record: dict,
  attachment: tuple[dict, bytes] | None = None,
) -> tuple[bool, str, bool]:
  """Store one message atomically; return ``(created, request_state, new_request)``.

  ``new_request`` is True only for the first inbound message of a brand-new
  pending conversation, so callers can notify on first contact without alerting
  again for every later message from an un-accepted sender.

  A metadata record written by an older Social version is an established
  conversation.  Only a genuinely new inbound conversation becomes a quiet
  request.  Keeping the duplicate check under the app-storage lock also makes
  concurrent federation retries unable to double-count unread/request state.
  """
  async with fs_locks.app_storage_lock(app.id):
    convo = _conversation_dir(app, peer_host)
    meta_path = convo / "meta.json"
    had_meta = meta_path.is_file()
    meta = json.loads(meta_path.read_text()) if had_meta else {}
    state = meta.get("request_status")
    if state not in REQUEST_STATES:
      state = "accepted" if had_meta or record["dir"] == "out" else "pending"
    # Blocking is a receive-time discard policy, not merely a notification
    # preference.  Decide it under the same lock as owner request decisions
    # and before materializing either the message or its attachment.
    if state == "blocked" and record["dir"] == "in":
      return False, state, False
    msgs = convo / "msgs"
    message_path = msgs / f"{record['id']}.json"
    if message_path.is_file():
      return False, state, False
    owns_dirty_marker = begin_message_mutation("dm", peer_host)
    if attachment is not None:
      record["attachment"] = _write_app_attachment(
        convo, record["id"], attachment
      )
    msgs.mkdir(parents=True, exist_ok=True)
    atomic_write(message_path, json.dumps(record))
    meta.update(
      peer=peer_host,
      last_text=_message_preview(record["text"]),
      last_at=record["sent_at"],
      last_dir=record["dir"],
      request_status=state,
    )
    if record.get("peer_handle"):
      meta["peer_handle"] = record["peer_handle"]
    if record["dir"] == "in" and state == "accepted":
      meta["unread"] = int(meta.get("unread") or 0) + 1
    elif record["dir"] == "in" and state == "pending":
      meta["request_count"] = int(meta.get("request_count") or 0) + 1
      meta["unread"] = 0
    elif state != "accepted":
      meta["unread"] = 0
    atomic_write(meta_path, json.dumps(meta))
    version = _bump_version(app, history_covered=False)
    mirror_message(
      "dm", peer_host, record, message_path, version=version,
      owns_dirty_marker=owns_dirty_marker,
    )
    new_request = not had_meta and record["dir"] == "in" and state == "pending"
    return True, state, new_request


async def _load_message(app, peer_host: str, message_id: str) -> dict:
  async with fs_locks.app_storage_lock(app.id):
    path = _message_path(app, peer_host, message_id)
    if not path.is_file():
      raise HTTPException(status_code=404, detail="Message not found.")
    try:
      value = json.loads(path.read_text())
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
      raise HTTPException(status_code=500, detail="Message record is invalid.") from exc
    if not isinstance(value, dict):
      raise HTTPException(status_code=500, detail="Message record is invalid.")
    return value


def _same_outgoing_intent(existing: dict, proposed: dict) -> bool:
  """Reject accidental id reuse while permitting an exact delivery retry."""
  if any(existing.get(field) != proposed.get(field) for field in (
    "id", "dir", "peer", "text", "reply_to",
  )):
    return False
  old_attachment = existing.get("attachment")
  new_attachment = proposed.get("attachment")
  if bool(old_attachment) != bool(new_attachment):
    return False
  if isinstance(old_attachment, dict) and isinstance(new_attachment, dict):
    metadata_matches = all(
      old_attachment.get(field) == new_attachment.get(field)
      for field in ("mime", "w", "h")
    )
    old_hash = old_attachment.get("sha256")
    return metadata_matches and (
      not isinstance(old_hash, str) or old_hash == new_attachment.get("sha256")
    )
  return True


async def _persist_outgoing_message(
  db, app, peer_host: str, record: dict,
  attachment: tuple[dict, bytes] | None,
) -> dict:
  """Commit author intent before delivery, reusing an exact stable id."""
  created, _state, _new_request = await _store_message(
    db, app, peer_host, record, attachment,
  )
  if created:
    return record
  existing = await _load_message(app, peer_host, record["id"])
  comparable = dict(record)
  if attachment is not None:
    wire, _data = attachment
    comparable["attachment"] = {
      "mime": wire["mime"], "w": wire["w"], "h": wire["h"],
      "sha256": hashlib.sha256(_data).hexdigest(),
    }
  if not _same_outgoing_intent(existing, comparable):
    raise HTTPException(
      status_code=409, detail="This message id already belongs to another message."
    )
  return existing


def _stored_attachment(app, peer_host: str, record: dict) -> tuple[dict, bytes] | None:
  metadata = record.get("attachment")
  if not isinstance(metadata, dict):
    return None
  relative = metadata.get("file")
  if not isinstance(relative, str):
    raise ValueError("Stored attachment path is missing.")
  conversation = _conversation_dir(app, peer_host).resolve()
  path = (conversation / relative).resolve()
  if not path.is_relative_to(conversation) or not path.is_file():
    raise ValueError("Stored attachment is unavailable.")
  if path.stat().st_size > MAX_ATTACHMENT_BYTES:
    raise ValueError("Stored attachment is too large.")
  data = path.read_bytes()
  wire = {
    "mime": metadata.get("mime"),
    "w": metadata.get("w"),
    "h": metadata.get("h"),
    "data_b64": base64.b64encode(data).decode(),
  }
  return _validate_attachment(wire)


DELIVERY_LEASE_S = 30.0


async def _begin_delivery_attempt(
  app, peer_host: str, message_id: str,
) -> tuple[str | None, dict]:
  """Claim one bounded attempt without holding storage across the network."""
  async with fs_locks.app_storage_lock(app.id):
    path = _message_path(app, peer_host, message_id)
    if not path.is_file():
      raise HTTPException(status_code=404, detail="Message not found.")
    record = json.loads(path.read_text())
    if record.get("dir") != "out" or record.get("peer") != peer_host:
      raise HTTPException(status_code=409, detail="Message cannot be retried.")
    if record.get("status") == "delivered":
      return None, record
    now = time.time()
    started = record.get("attempt_started_at")
    if (
      isinstance(record.get("attempt_id"), str)
      and isinstance(started, (int, float))
      and now - float(started) < DELIVERY_LEASE_S
    ):
      raise HTTPException(status_code=409, detail="Delivery is already in progress.")
    attempt_id = str(uuid.uuid4())
    record.update(
      status="sending",
      attempt_id=attempt_id,
      attempt_started_at=now,
      attempts=int(record.get("attempts") or 0) + 1,
    )
    record.pop("failure", None)
    owns_dirty_marker = begin_message_mutation("dm", peer_host)
    atomic_write(path, json.dumps(record))
    version = _bump_version(app, history_covered=False)
    mirror_message(
      "dm", peer_host, record, path, version=version,
      owns_dirty_marker=owns_dirty_marker,
    )
    return attempt_id, record


async def _finish_delivery_attempt(
  app, peer_host: str, message_id: str, attempt_id: str, *,
  status: str, detail: str | None, encrypted: bool,
) -> dict:
  """Settle only the attempt that still owns this message's delivery lease."""
  async with fs_locks.app_storage_lock(app.id):
    path = _message_path(app, peer_host, message_id)
    if not path.is_file():
      raise HTTPException(status_code=404, detail="Message not found.")
    record = json.loads(path.read_text())
    if record.get("attempt_id") != attempt_id:
      return record
    record["status"] = status
    record["last_attempt_at"] = time.time()
    if encrypted:
      record["encrypted"] = True
    if status == "delivered":
      record["delivered_at"] = time.time()
      record.pop("failure", None)
    elif detail:
      record["failure"] = detail
    record.pop("attempt_id", None)
    record.pop("attempt_started_at", None)
    owns_dirty_marker = begin_message_mutation("dm", peer_host)
    atomic_write(path, json.dumps(record))
    version = _bump_version(app, history_covered=False)
    mirror_message(
      "dm", peer_host, record, path, version=version,
      owns_dirty_marker=owns_dirty_marker,
    )
    return record


async def _require_encrypted_delivery(
  app, peer_host: str, message_id: str, attempt_id: str,
) -> dict:
  """Persist the no-downgrade decision before encrypted bytes leave this host."""
  async with fs_locks.app_storage_lock(app.id):
    path = _message_path(app, peer_host, message_id)
    if not path.is_file():
      raise HTTPException(status_code=404, detail="Message not found.")
    record = json.loads(path.read_text())
    if record.get("attempt_id") != attempt_id:
      raise HTTPException(status_code=409, detail="Delivery attempt was superseded.")
    if record.get("encrypted") is True:
      return record
    record["encrypted"] = True
    owns_dirty_marker = begin_message_mutation("dm", peer_host)
    atomic_write(path, json.dumps(record))
    version = _bump_version(app, history_covered=False)
    mirror_message(
      "dm", peer_host, record, path, version=version,
      owns_dirty_marker=owns_dirty_marker,
    )
    return record


async def _attempt_direct_delivery(app, peer_host: str, message_id: str) -> dict:
  attempt_id, record = await _begin_delivery_attempt(app, peer_host, message_id)
  if attempt_id is None:
    return record

  encrypted = bool(record.get("encrypted"))
  status = "failed"
  detail = "The peer could not be reached."
  try:
    attachment = _stored_attachment(app, peer_host, record)
    actor = await _fetch_actor(peer_host)
    identity = _load_identity()
    envelope = {
      "v": 0,
      "type": "message",
      "id": message_id,
      "from": _own_host(),
      "to": peer_host,
      "text": record.get("text") or "",
      # Transport signatures expire; renew this timestamp on every attempt
      # while preserving the authored message id and local creation time.
      "sent_at": time.time(),
    }
    encryption_key = actor.get("encryption_key")
    peer_encrypts = (
      isinstance(encryption_key, dict)
      and encryption_key.get("alg") == "x25519"
    )
    if encrypted and not peer_encrypts:
      raise ValueError("The peer no longer publishes its encryption key.")
    if peer_encrypts:
      recipient_key_b64 = encryption_key.get("key_b64")
      if not isinstance(recipient_key_b64, str) or not recipient_key_b64:
        raise ValueError("The peer published no valid encryption key.")
      # Once an attempt selects encryption, persist that policy before the
      # network side effect. A process exit after the peer accepts the message
      # must never let an expired-lease retry downgrade it to plaintext.
      record = await _require_encrypted_delivery(
        app, peer_host, message_id, attempt_id,
      )
      encrypted = True
      envelope["enc"] = _seal_dm(
        message_id, recipient_key_b64, text=envelope["text"],
        attachment=attachment[0] if attachment is not None else None,
        reply_to=record.get("reply_to"),
      )
      envelope["text"] = ""
      encrypted = True
    else:
      if attachment is not None:
        envelope["attachment"] = attachment[0]
      if record.get("reply_to") is not None:
        envelope["reply_to"] = record["reply_to"]
    envelope["sig"] = _sign(envelope, identity["private_key_b64"])
    response = await _post_signed_envelope(
      _peer_service_url(peer_host, "inbox"), envelope,
      max_response_bytes=MAX_ENVELOPE_BYTES,
    )
    response.raise_for_status()
    status = "delivered"
    detail = None
  except httpx.HTTPStatusError as exc:
    detail = f"The peer rejected the message ({exc.response.status_code})."
  except httpx.TimeoutException:
    detail = "The peer took too long to respond."
  except Exception:
    detail = "The peer could not be reached."
  return await _finish_delivery_attempt(
    app, peer_host, message_id, attempt_id,
    status=status, detail=detail, encrypted=encrypted,
  )


async def _prepare_outgoing_conversation(
  app, peer_host: str,
) -> None:
  """Persist consent for a new owner-initiated DM, or reject a request reply."""
  async with fs_locks.app_storage_lock(app.id):
    convo = _conversation_dir(app, peer_host)
    meta_path = convo / "meta.json"
    if meta_path.is_file():
      meta = json.loads(meta_path.read_text())
      state = meta.get("request_status")
      if state in {"pending", "declined", "blocked"}:
        raise HTTPException(
          status_code=409,
          detail="Accept this message request before replying.",
        )
      # Missing state is the backwards-compatible accepted interpretation.
      return
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(meta_path, json.dumps({
      "peer": peer_host,
      "request_status": "accepted",
      "unread": 0,
    }))
    _bump_version(app)


async def _set_dm_request_state(
  app, peer_host: str, state: str,
) -> str:
  """Apply one owner decision without deleting the retained conversation."""
  async with fs_locks.app_storage_lock(app.id):
    meta_path = _conversation_dir(app, peer_host) / "meta.json"
    if not meta_path.is_file():
      raise HTTPException(status_code=404, detail="Message request not found.")
    meta = json.loads(meta_path.read_text())
    current = meta.get("request_status")
    if current not in REQUEST_STATES:
      current = "accepted"
    if state == "accepted" and current == "accepted":
      return "accepted"
    if current != "pending":
      raise HTTPException(status_code=409, detail="Message request is no longer pending.")
    meta.update(request_status=state, request_count=0, unread=0)
    atomic_write(meta_path, json.dumps(meta))
    _bump_version(app)
    return state


async def _mark_dm_read(app, peer_host: str) -> bool:
  """Clear unread state inside the transaction that owns message metadata."""
  async with fs_locks.app_storage_lock(app.id):
    meta_path = _conversation_dir(app, peer_host) / "meta.json"
    if not meta_path.is_file():
      raise HTTPException(status_code=404, detail="Conversation not found.")
    meta = json.loads(meta_path.read_text())
    if not meta.get("unread"):
      return False
    meta["unread"] = 0
    atomic_write(meta_path, json.dumps(meta))
    _bump_version(app)
    return True


# ── public peer surface ─────────────────────────────────────────────────────

@router.get("/actor")
async def get_actor(db=Depends(get_db)):
  """Publish keys for federation, and profile data only for confirmed members."""
  # An unauthenticated probe must not lazily create an identity on an
  # untouched installation. Authenticated owner use and established
  # federation operations create this file before peers need its keys.
  if not _identity_path().is_file():
    raise HTTPException(status_code=404, detail="Social profile not found.")
  identity = _load_identity()
  if not _profile_public(identity):
    return _key_actor_doc(identity)
  metadata = await public_actor_metadata()
  identity = _load_identity()
  if not _profile_public(identity):
    return _key_actor_doc(identity)
  actor = _actor_doc(identity, metadata)
  if not _membership_confirmed(identity):
    # The host needs this card only for the registration handshake; a failed
    # join must not leave a shared cached copy of the temporary profile.
    return JSONResponse(actor, headers={"Cache-Control": "no-store"})
  return actor


def _temporarily_unavailable_avatar(
  host: str, cache: Path, cause: Exception,
) -> tuple[Path, str]:
  _mark_avatar_failure(host)
  if cache.is_file():
    return cache, "image/webp"
  raise HTTPException(
    status_code=502, detail="Peer avatar is temporarily unavailable.",
  ) from cause


@router.get("/avatar")
def get_avatar():
  """This instance's avatar, public only during registration or membership."""
  if not _identity_path().is_file():
    raise HTTPException(status_code=404, detail="Social profile not found.")
  identity = _load_identity()
  if not _profile_public(identity):
    raise HTTPException(status_code=404, detail="Social profile not found.")
  path = _avatar_path()
  if not path.is_file():
    raise HTTPException(status_code=404, detail="Avatar not found.")
  return FileResponse(
    str(path),
    media_type="image/png",
    headers={
      "Cache-Control": (
        "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400"
        if _membership_confirmed(identity) else "no-store"
      ),
      "X-Content-Type-Options": "nosniff",
    },
  )


@router.post("/inbox")
async def receive_message(request: Request, db=Depends(get_db)):
  """Accept one signed direct message from a peer instance."""
  if not _joined_for_federation():
    raise HTTPException(status_code=403, detail="Join Social before receiving messages.")
  envelope = await _read_envelope(request)
  if envelope.get("v") != 0 or envelope.get("type") != "message":
    raise HTTPException(status_code=400, detail="Unsupported envelope type.")
  if envelope.get("to") != _own_host():
    raise HTTPException(status_code=400, detail="Envelope is addressed elsewhere.")
  message_id = envelope.get("id")
  if not isinstance(message_id, str) or not _valid_id(message_id):
    raise HTTPException(status_code=400, detail="Message id is invalid.")
  actor = await _verify_peer_envelope(envelope)
  encrypted = "enc" in envelope
  if encrypted:
    payload = _open_dm(
      message_id, envelope.get("enc"), _load_identity()["enc_private_key_b64"]
    )
    text = payload.get("text")
    attachment = _validate_attachment(payload.get("attachment"))
    reply_to = _validate_reply_to(payload.get("reply_to"))
  else:
    text = envelope.get("text")
    attachment = _validate_attachment(envelope.get("attachment"))
    reply_to = _validate_reply_to(envelope.get("reply_to"))
  _validate_text_or_attachment(text, attachment, "Message text is invalid.")
  sender = envelope["from"]
  app = _common_app(db)
  sender_label = f"@{actor['handle']}" if actor.get("handle") else sender
  record = {
    "id": message_id,
    "dir": "in",
    "peer": sender,
    "peer_handle": actor.get("handle") or "",
    "text": text,
    "sent_at": envelope["sent_at"],
    "status": "delivered",
  }
  if encrypted:
    record["encrypted"] = True
  if reply_to is not None:
    record["reply_to"] = reply_to
  created, request_state, new_request = await _store_message(
    db, app, sender, record, attachment
  )
  if not created:
    # A blocked sender gets the same successful receipt as ordinary delivery;
    # the discard policy is local owner state, not federation metadata.
    if request_state == "blocked":
      return {"status": "delivered"}
    return {"status": "duplicate"}
  if request_state == "accepted":
    await notify(
      f"Message from {sender_label}", _message_preview(text), f"dm:{sender}",
    )
  elif new_request:
    # Only the first message of a new request notifies, so an un-accepted
    # sender cannot spam the owner with a push per message.
    await notify(
      f"Message request from {sender_label}", _message_preview(text),
      f"dm:{sender}",
    )
  return {
    "status": "delivered" if request_state == "accepted" else "pending",
  }


def _activity_line(kind: str, actor_host: str, actor_handle: str,
                   emoji: str | None = None, reply_id: str | None = None) -> str:
  who = f"@{actor_handle}" if actor_handle else actor_host
  if kind == "reply":
    return f"{who} replied to your post"
  item = "reply" if reply_id is not None else "post"
  if emoji is not None:
    return f"{who} reacted {emoji} to your {item}"
  return f"{who} liked your {item}"


@contextmanager
def _activity_replay_journal():
  """Serialize only short local journal transactions, never the push await."""
  directory = Path(_data_dir()) / "common"
  directory.mkdir(parents=True, exist_ok=True)
  with (directory / ".activity-replays.lock").open("a+b") as handle:
    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
    try:
      path = directory / "activity-replays.json"
      try:
        journal = json.loads(path.read_text())
      except (OSError, ValueError):
        journal = {}
      yield path, journal if isinstance(journal, dict) else {}
    finally:
      fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _claim_activity(token: str, claim: str) -> bool:
  now = time.time()
  with _activity_replay_journal() as (path, journal):
    live = {key: value for key, value in journal.items()
            if isinstance(value, dict) and isinstance(value.get("until"), (int, float))
            and value["until"] > now}
    if token in live:
      return False
    if len(live) >= 2048:
      raise HTTPException(status_code=429, detail="Activity replay journal is full.")
    live[token] = {"claim": claim, "until": now + 30}
    atomic_write(path, json.dumps(live))
    return True


def _finish_activity(token: str, claim: str, delivered: bool) -> None:
  with _activity_replay_journal() as (path, journal):
    if journal.get(token, {}).get("claim") != claim:
      return
    if delivered:
      journal[token] = {"until": time.time() + 2 * CLOCK_SKEW_S}
    else:
      journal.pop(token, None)
    atomic_write(path, json.dumps(journal))


@router.post("/activity")
async def receive_board_activity(request: Request):
  """Accept a signed notice that one of the owner's posts got a like or reply."""
  envelope = await _read_envelope(request, max_bytes=MAX_ENVELOPE_BYTES)
  if envelope.get("v") != 0 or envelope.get("type") != "board_activity":
    raise HTTPException(status_code=400, detail="Unsupported envelope type.")
  if envelope.get("to") != _own_host():
    raise HTTPException(status_code=400, detail="Envelope is addressed elsewhere.")
  if not _valid_id(envelope.get("post_id")):
    raise HTTPException(status_code=400, detail="Post id is invalid.")
  kind = envelope.get("kind")
  if kind not in ("like", "reply"):
    raise HTTPException(status_code=400, detail="Unsupported activity kind.")
  reply_id = envelope.get("reply_id")
  if reply_id is not None and not _valid_id(reply_id):
    raise HTTPException(status_code=400, detail="Reply id is invalid.")
  emoji = envelope.get("emoji")
  if emoji is not None and emoji not in BOARD_REACTION_EMOJIS:
    raise HTTPException(status_code=400, detail="Reaction is not supported.")
  activity_id = envelope.get("activity_id")
  if activity_id is not None and (not isinstance(activity_id, str) or not 1 <= len(activity_id) <= 128):
    raise HTTPException(status_code=400, detail="Activity id is invalid.")
  # Only the community host stores boards, so only it may report activity;
  # otherwise any signed peer could push arbitrary notifications.
  if envelope.get("from") != COMMUNITY_HOST:
    raise HTTPException(status_code=403, detail="Only the community host reports activity.")
  await _verify_peer_envelope(envelope)
  actor_host = envelope.get("actor") or envelope["from"]
  if actor_host == _own_host():
    return {"status": "ok"}
  actor_handle = envelope.get("actor_handle")
  actor_handle = actor_handle[:MAX_NAME_CHARS] if isinstance(actor_handle, str) else ""
  token = hashlib.sha256(activity_id.encode() if activity_id else _canonical(envelope)).hexdigest()
  claim = str(uuid.uuid4())
  if not _claim_activity(token, claim):
    return {"status": "ok"}
  intent = f"board:{envelope['post_id']}" + (f":{reply_id}" if reply_id else "")
  try:
    delivered = await notify(
      "Activity on your reply" if reply_id and kind != "reply" else "Activity on your post",
      _activity_line(kind, actor_host, actor_handle, emoji, reply_id), intent,
    )
  except BaseException:
    _finish_activity(token, claim, False)
    raise
  _finish_activity(token, claim, delivered is True)
  return {"status": "ok"}


# ── owner surface ───────────────────────────────────────────────────────────

def _require_owner_or_common_app(db, principal: Principal):
  """The owner, or the Social app's own scoped token, may act."""
  app = _common_app(db)
  if principal.scope == "public":
    raise HTTPException(status_code=401, detail="Authentication required.")
  if principal.app_id is not None and principal.app_slug != APP_SLUG:
    raise HTTPException(status_code=403, detail="Not available to other apps.")
  return app


def _membership_confirmed(identity: dict) -> bool:
  return bool(identity.get("joined_at") and identity.get("directory_synced"))


def _profile_public(identity: dict) -> bool:
  # The host must read the named actor while verifying registration. A bounded
  # window permits that handshake without publishing a failed join indefinitely.
  window = identity.get("registration_public_until")
  return bool(identity.get("joined_at")) and (
    _membership_confirmed(identity) or
    isinstance(window, (int, float)) and window > time.time()
  )


def _joined_for_federation() -> bool:
  # An anonymous inbound probe must not create a new identity on an untouched app.
  return _identity_path().is_file() and _membership_confirmed(_load_identity())


def _require_member(db, principal: Principal):
  """Owner/app access is not Social membership; both are needed for private areas."""
  app = _require_owner_or_common_app(db, principal)
  identity = _load_identity()
  if not _membership_confirmed(identity):
    raise HTTPException(status_code=403, detail="Join Social to access this area.")
  return app


class ProfileUpdate(BaseModel):
  bio: str | None = None


class SendMessage(BaseModel):
  id: str | None = None
  to: str
  text: str
  peer_handle: str | None = None
  attachment: Any = None
  reply_to: Any = None


def _request_peer(peer_host: str) -> str:
  host = peer_host.strip().lower()
  if not _valid_host(host):
    raise HTTPException(status_code=400, detail="Invalid peer host.")
  return host


class PublishPost(BaseModel):
  text: str
  attachment: Any = None
  attachments: Any = None
  thumbnails: Any = None


class AvatarBatch(BaseModel):
  hosts: list[str]
  # Directory members' avatar content hashes, as board and directory rows
  # report them; a matching cached copy never needs another fetch.
  avatars: dict[str, str] = {}


async def _refresh_profile_cache(db, principal: Principal) -> dict:
  """Pull the mobius.you profile into the federation identity cache.

  Returns profile state and whether the authoritative avatar changed. The cache keeps the
  actor card and directory registration working when the account service is
  briefly unreachable; the live profile remains the source of truth.
  """
  async with _identity_lock():
    cached_avatar_url = _load_identity(locked=True).get("avatar_source_url")
  profile = None
  account_error = None
  avatar_updated = False
  try:
    profile = await owner_profile()
  except HTTPException as exc:
    account_error = str(exc.detail)
  avatar = None
  avatar_url = profile.get("avatar_url") if profile else None
  if isinstance(avatar_url, str) and avatar_url and avatar_url != cached_avatar_url:
    try:
      avatar = await _download_avatar(avatar_url)
    except Exception:
      pass
  async with _identity_lock():
    # Profile calls may return while registration is in flight. Apply only
    # these profile fields to the latest saved identity, never a stale snapshot.
    identity = _load_identity(locked=True)
    changed = False
    if profile:
      name = str(profile.get("display_name") or profile.get("handle") or "")[:MAX_NAME_CHARS]
      handle = str(profile.get("handle") or "")[:MAX_NAME_CHARS]
      if name != identity.get("name") or handle != identity.get("handle"):
        identity["name"] = name
        identity["handle"] = handle
        changed = True
      try:
        if avatar is not None and avatar_url != identity.get("avatar_source_url"):
          atomic_write(_avatar_path(), avatar)
          identity["avatar_source_url"] = avatar_url
          avatar_updated = changed = True
        elif "avatar_url" in profile and not avatar_url:
          avatar_path = _avatar_path()
          if avatar_path.is_file() or identity.get("avatar_source_url"):
            avatar_path.unlink(missing_ok=True)
            identity.pop("avatar_source_url", None)
            avatar_updated = changed = True
      except OSError:
        # A failed local photo cache must not prevent joining or profile edits.
        pass
      if changed:
        _save_identity(identity)
  if identity.get("joined_at") and identity.get("directory_synced") != _directory_listing(identity):
    # The directory lists this handle and copies this avatar; re-registering
    # tells the community host to refresh both, and repeats until it succeeds.
    await _register_with_community_host(identity)
  return {
    "identity": identity,
    "profile": profile,
    "account_error": account_error,
    "avatar_updated": avatar_updated,
  }


def _avatar_wire(path: Path, media_type: str) -> dict | None:
  try:
    data = path.read_bytes()
  except OSError:
    return None
  return {"mime": media_type, "data_b64": base64.b64encode(data).decode()}


async def _me_response(
  identity: dict, *, connected: bool, account_error: str | None,
  include_avatar: bool = True,
) -> dict:
  response = {
    "host": _own_host(),
    "name": identity.get("name") or "",
    "handle": identity.get("handle") or "",
    "bio": identity.get("bio") or "",
    "connected": connected,
    "joined": _membership_confirmed(identity),
    "account_error": account_error,
    "identity_app_id": await identity_app_id(),
  }
  if include_avatar:
    response["avatar"] = _avatar_wire(_avatar_path(), "image/png")
  return response


async def _me_payload(
  db: object, principal: Principal, *, include_avatar: bool = True,
) -> dict:
  _require_owner_or_common_app(db, principal)
  state = await _refresh_profile_cache(db, principal)
  identity = state["identity"]
  return await _me_response(
    identity,
    connected=bool(state["profile"]) or bool(identity.get("name")),
    account_error=state["account_error"],
    include_avatar=include_avatar or state["avatar_updated"],
  )


async def _cached_me_payload(db: object, principal: Principal) -> dict:
  """Return saved identity context without waiting on the account service."""
  _require_owner_or_common_app(db, principal)
  identity = _load_identity()
  return await _me_response(
    identity, connected=bool(identity.get("name")), account_error=None,
  )


@router.get("/me")
async def get_me(
  include_avatar: bool = True,
  db: object = Depends(get_db), principal: Principal = Depends(get_principal),
):
  return await _me_payload(db, principal, include_avatar=include_avatar)


@router.post("/join")
async def join_community(
  db: object = Depends(get_db), principal: Principal = Depends(get_principal)
):
  """Join Common as the owner's mobius.you identity."""
  require_nondelegated_owner_control(principal)
  _require_owner_or_common_app(db, principal)
  state = await _refresh_profile_cache(db, principal)
  async with _identity_lock():
    identity = _load_identity(locked=True)
    if not state["profile"] and not identity.get("name"):
      raise HTTPException(
        status_code=409,
        detail=(
          "No Möbius profile is connected yet. Connect your account in "
          "Möbius · You first."
        ),
      )
    _require_username(identity)
    identity["joined_at"] = identity.get("joined_at") or time.time()
    _save_identity(identity)
  status = await _register_with_community_host(identity)
  return {
    "status": "joined" if status == "registered" else "pending",
    "directory": status,
    "name": identity.get("name") or "",
    "handle": identity.get("handle") or "",
  }


def _directory_listing(identity: dict) -> dict:
  """What the community directory shows for this instance."""
  return {
    "handle": identity.get("handle") or "",
    "avatar": identity.get("avatar_source_url") or "",
  }


async def _legacy_registration_matches(handle: str) -> bool:
  """Check the old host's public directory before trusting its bare 200 reply.

  Remove this only after older community hosts no longer need to interoperate.
  New hosts return the verified handle directly and never use this read.
  """
  response = await federation_request(
    "GET", _peer_service_url(COMMUNITY_HOST, "directory"),
    params={"q": _own_host()}, timeout_seconds=3.0,
  )
  response.raise_for_status()
  users = response.json().get("users")
  return isinstance(users, list) and any(
    isinstance(person, dict) and person.get("host") == _own_host()
    and person.get("handle") == handle for person in users
  )


@asynccontextmanager
async def _identity_lock():
  # Each service request may run in another process. Nonblocking flock also
  # lets a second request on this event loop wait without freezing the first.
  # Keep this inode: unlinking it could split the lock across processes.
  path = _identity_lock_path()
  path.parent.mkdir(parents=True, exist_ok=True)
  with path.open("a+b") as handle:
    while True:
      try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
      except BlockingIOError:
        await asyncio.sleep(0.02)
    try:
      yield
    finally:
      fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


async def _register_with_community_host(identity: dict) -> str:
  """Announce this instance to its community host. Returns a status string."""
  async with _identity_lock():
    # A waiting request may hold a snapshot from before another Join finished.
    saved = dict(_load_identity(locked=True))
    identity.clear()
    identity.update(saved)
    listing = _directory_listing(identity)
    envelope = {
      "v": 0,
      "type": "register",
      "from": _own_host(),
      "handle": identity.get("handle") or "",
      "bio": identity.get("bio") or "",
      "sent_at": time.time(),
    }
    envelope["sig"] = _sign(envelope, identity["private_key_b64"])
    identity["registration_public_until"] = time.time() + 60
    _save_identity(identity)
    status = "unreachable"
    try:
      response = await _post_signed_envelope(
        _peer_service_url(COMMUNITY_HOST, "directory"), envelope,
        max_response_bytes=MAX_ENVELOPE_BYTES,
      )
      response.raise_for_status()
      acknowledgement = response.json()
      if not isinstance(acknowledgement, dict) or acknowledgement.get("status") != "registered":
        status = "verification_failed"
      elif acknowledgement.get("handle") == listing["handle"]:
        status = "registered"
      elif "handle" not in acknowledgement:
        # The still-running old host returns only {status: registered}.
        # Check its actual directory row before considering this Join complete.
        status = (
          "registered" if await _legacy_registration_matches(listing["handle"])
          else "verification_failed"
        )
      else:
        status = "verification_failed"
    except httpx.HTTPStatusError as exc:
      status = "verification_failed" if exc.response.status_code == 403 else "rejected"
    except Exception:
      pass
    finally:
      latest = dict(_load_identity(locked=True))
      if status == "registered":
        latest["directory_synced"] = listing
      latest.pop("registration_public_until", None)
      _save_identity(latest)
      identity.clear()
      identity.update(latest)
    return status


def _require_username(identity: dict) -> None:
  """Everything public in Social is shown by handle, so taking part needs one."""
  if not identity.get("handle"):
    raise HTTPException(status_code=409, detail=NEEDS_USERNAME)


def _community_write_error(exc: Exception, action: str) -> str:
  """Describe a reached host separately from a transport failure."""
  if isinstance(exc, httpx.HTTPStatusError):
    if exc.response.status_code == 403:
      return "The community host could not verify this Social identity. Try again."
    return f"The community host rejected the {action}. Try again."
  if isinstance(exc, httpx.TimeoutException):
    return "The community host took too long to respond. Try again."
  if isinstance(exc, FederationTransportError):
    return "The community host returned an invalid response. Try again."
  if isinstance(exc, httpx.TransportError):
    return "The community host could not be reached. Try again."
  _log.exception("Unexpected community %s failure", action, exc_info=exc)
  return f"Social could not complete the {action}. Try again."


@router.put("/me")
async def update_me(
  update: ProfileUpdate,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  require_nondelegated_owner_control(principal)
  _require_owner_or_common_app(db, principal)
  async with _identity_lock():
    identity = _load_identity(locked=True)
    if update.bio is not None:
      identity["bio"] = update.bio.strip()[:MAX_BIO_CHARS]
      _save_identity(identity)
  status = (
    await _register_with_community_host(identity)
    if identity.get("joined_at") else "not_joined"
  )
  return {"status": "saved", "directory": status}


@router.post("/requests/dm/{peer_host}/accept")
async def accept_message_request(
  peer_host: str,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  require_nondelegated_owner_control(principal)
  app = _require_member(db, principal)
  # Acceptance may be the first authenticated federation action on a legacy
  # plaintext request. Create keys now so the accepted peer can verify and
  # encrypt the owner's reply after the required Social join.
  _load_identity()
  state = await _set_dm_request_state(app, _request_peer(peer_host), "accepted")
  return {"status": state}


@router.post("/requests/dm/{peer_host}/decline")
async def decline_message_request(
  peer_host: str,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  require_nondelegated_owner_control(principal)
  app = _require_member(db, principal)
  state = await _set_dm_request_state(app, _request_peer(peer_host), "declined")
  return {"status": state}


@router.post("/requests/dm/{peer_host}/block")
async def block_message_request(
  peer_host: str,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  require_nondelegated_owner_control(principal)
  app = _require_member(db, principal)
  state = await _set_dm_request_state(app, _request_peer(peer_host), "blocked")
  return {"status": state}


@router.post("/conversations/{peer_host}/read")
async def mark_direct_conversation_read(
  peer_host: str,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  require_nondelegated_owner_control(principal)
  app = _require_member(db, principal)
  changed = await _mark_dm_read(app, _request_peer(peer_host))
  return {"status": "read", "changed": changed}


@router.get("/conversations/{peer_host}/messages")
async def direct_message_history(
  peer_host: str,
  before: str | None = None,
  limit: int = Query(default=50, ge=1, le=100),
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Read one bounded newest-first slice, returned in display order."""
  require_nondelegated_owner_control(principal)
  app = _require_member(db, principal)
  peer = _request_peer(peer_host)
  messages_dir = _conversation_dir(app, peer) / "msgs"
  try:
    return await load_page(
      app.id, "dm", peer, messages_dir, cursor=before, limit=limit,
    )
  except ValueError as exc:
    raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/send")
async def send_message(
  message: SendMessage,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Persist one stable DM identity, then make a bounded delivery attempt."""
  require_nondelegated_owner_control(principal)
  app = _require_member(db, principal)
  to_host = message.to.strip().lower()
  text = message.text.strip()
  if not _valid_host(to_host):
    raise HTTPException(status_code=400, detail="Invalid recipient.")
  attachment = _validate_attachment(message.attachment)
  reply_to = _validate_reply_to(message.reply_to)
  _validate_text_or_attachment(text, attachment, "Message text is invalid.")
  message_id = message.id or str(uuid.uuid4())
  if not _valid_id(message_id):
    raise HTTPException(status_code=400, detail="Message id is invalid.")
  # The first deliberate outgoing message establishes consent. A reply to an
  # inbound request must instead go through the explicit acceptance action.
  await _prepare_outgoing_conversation(app, to_host)
  record = {
    "id": message_id,
    "dir": "out",
    "peer": to_host,
    "text": text,
    "sent_at": time.time(),
    "status": "sending",
  }
  if message.peer_handle:
    record["peer_handle"] = message.peer_handle.strip()[:MAX_NAME_CHARS]
  if reply_to is not None:
    record["reply_to"] = reply_to
  record = await _persist_outgoing_message(
    db, app, to_host, record, attachment,
  )
  if record.get("status") != "delivered":
    record = await _attempt_direct_delivery(app, to_host, message_id)
  return {
    "status": record.get("status") or "failed",
    "id": message_id,
    "detail": record.get("failure"),
  }


@router.post("/conversations/{peer_host}/messages/{message_id}/retry")
async def retry_direct_message(
  peer_host: str,
  message_id: str,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Retry a persisted outgoing message without creating a new identity."""
  require_nondelegated_owner_control(principal)
  app = _require_member(db, principal)
  peer = _request_peer(peer_host)
  if not _valid_id(message_id):
    raise HTTPException(status_code=400, detail="Message id is invalid.")
  record = await _attempt_direct_delivery(app, peer, message_id)
  return {
    "status": record.get("status") or "failed",
    "id": message_id,
    "detail": record.get("failure"),
  }


async def _require_community_media_support(
  host: str, *, reply: bool = False, gif: bool = False,
  originals: list[tuple[dict, bytes]] | None = None,
  thumbnails: list[tuple[dict, bytes]] | None = None,
  envelope_bytes: int = 0,
):
  """Older hosts must explicitly support media before accepting its write."""
  label = "reply photo" if reply else "GIF"
  try:
    response = await federation_request(
      "GET", _peer_service_url(host, "board"), params={"limit": 1},
      timeout_seconds=OUTBOUND_TIMEOUT_S,
    )
    response.raise_for_status()
    feed = response.json()
    capabilities = feed.get("capabilities", {})
    limits = feed.get("media_limits")
  except Exception as exc:
    raise HTTPException(status_code=502,
      detail=f"Community {label} support could not be checked.") from exc
  if reply and capabilities.get("reply_attachments") is not True:
    raise HTTPException(status_code=409, detail="Community host does not support reply photos yet.")
  if gif and capabilities.get("gif_attachments") is not True:
    raise HTTPException(status_code=409, detail="Community host does not support animated GIFs yet. Your draft is unchanged.")
  # Older hosts advertise only booleans. Their real caps are 1 MiB per
  # original and 2 MiB per signed envelope, even if gif_attachments is true.
  if not isinstance(limits, dict):
    limits = {"gif_bytes": 1024 * 1024, "static_bytes": 1024 * 1024,
              "combined_bytes": 2 * 1024 * 1024, "thumbnail_bytes": 1024 * 1024,
              "envelope_bytes": 2 * 1024 * 1024, "max_images": 4}
  try:
    if any(not isinstance(limits[key], int) or isinstance(limits[key], bool) or limits[key] <= 0
           for key in ("gif_bytes", "static_bytes", "combined_bytes",
                       "thumbnail_bytes", "envelope_bytes", "max_images")):
      raise ValueError()
    if len(originals or []) > limits["max_images"]:
      raise ValueError()
    for wire, data in originals or []:
      key = "gif_bytes" if wire["mime"] == "image/gif" else "static_bytes"
      if len(data) > limits[key]:
        raise ValueError()
    if sum(len(data) for _, data in originals or []) > limits["combined_bytes"]:
      raise ValueError()
    if any(len(data) > limits["thumbnail_bytes"] for _, data in thumbnails or []):
      raise ValueError()
    if envelope_bytes > limits["envelope_bytes"]:
      raise ValueError()
  except (KeyError, TypeError, ValueError):
    raise HTTPException(status_code=409, detail="Community host media limit is smaller than this draft. Your draft is unchanged.")
  return limits


@router.post("/publish")
async def publish_post(
  post: PublishPost,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Sign a board post and submit it to the community host."""
  require_nondelegated_owner_control(principal)
  _require_member(db, principal)
  text = post.text.strip()
  attachment = _validate_attachment(post.attachment)
  attachments = _validate_attachments(post.attachments)
  if attachment is not None and attachments and attachment[0] != attachments[0][0]:
    raise HTTPException(status_code=400, detail="First post image does not match its gallery copy.")
  thumbnails = _validate_attachments(post.thumbnails, thumbnail=True)
  image_count = len(attachments) if attachments else (1 if attachment else 0)
  if thumbnails and len(thumbnails) != image_count:
    raise HTTPException(status_code=400, detail="Post thumbnails are invalid.")
  first = attachment or (attachments[0] if attachments else None)
  _validate_text_or_attachment(
    text, first, "Post text is invalid.", MAX_POST_TEXT_CHARS,
  )
  identity = _load_identity()
  _require_username(identity)
  envelope = {
    "v": 0,
    "type": "board_post",
    "id": str(uuid.uuid4()),
    "from": _own_host(),
    "text": text,
    "sent_at": time.time(),
  }
  if attachments:
    # Send the whole gallery, and also the first image as a lone `attachment`
    # so a host that predates galleries still stores and shows one image.
    envelope["attachments"] = [wire for wire, _ in attachments]
    envelope["attachment"] = attachments[0][0]
  elif attachment is not None:
    envelope["attachment"] = attachment[0]
  if thumbnails:
    envelope["thumbnails"] = [wire for wire, _ in thumbnails]
  envelope["sig"] = _sign(envelope, identity["private_key_b64"])
  _validate_attachment_envelope_size(envelope)
  host = COMMUNITY_HOST
  has_gif = any(wire["mime"] == "image/gif" for wire, _ in (attachments or ([attachment] if attachment else [])))
  write_started = False
  try:
    async with asyncio.timeout(COMMUNITY_WRITE_TIMEOUT_S):
      if first is not None:
        await _require_community_media_support(
          host, gif=has_gif,
          originals=attachments or [attachment], envelope_bytes=_wire_json_size(envelope),
          thumbnails=thumbnails,
        )
      write_started = True
      response = await _post_signed_envelope(
        _peer_service_url(host, "board"), envelope,
        max_response_bytes=MAX_ENVELOPE_BYTES,
      )
      response.raise_for_status()
      return {"status": "posted", "id": envelope["id"]}
  except (TimeoutError, httpx.TimeoutException) as exc:
    detail = ("The post may have been sent, but confirmation timed out. Check the feed before sending again."
      if write_started else "Community GIF support could not be checked.")
    raise HTTPException(status_code=502, detail=detail) from exc
  except HTTPException:
    raise
  except Exception as exc:
    raise HTTPException(
      status_code=502, detail=_community_write_error(exc, "post")
    ) from exc


@router.get("/replies/{post_id}")
async def get_replies_for_owner(
  post_id: str,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Read the selected public board's replies through the safe peer transport."""
  _require_owner_or_common_app(db, principal)
  if not _valid_id(post_id):
    raise HTTPException(status_code=400, detail="Post id is invalid.")
  host = COMMUNITY_HOST
  try:
    url = _peer_service_url(host, f"board/{post_id}/replies")
    response = None
    if _joined_for_federation():
      identity = _load_identity()
      envelope = {
        "v": 0, "type": "board_replies", "from": _own_host(),
        "post_id": post_id, "sent_at": time.time(),
      }
      envelope["sig"] = _sign(envelope, identity["private_key_b64"])
      response = await _post_signed_envelope(
        url, envelope, max_response_bytes=DEFAULT_MAX_RESPONSE_BYTES,
      )
      # The shared host rolls out separately. Older hosts offer public replies
      # only; never turn a rejected signature into an anonymous retry.
      if response.status_code in (404, 405):
        response = None
    if response is None:
      response = await federation_request("GET", url, timeout_seconds=OUTBOUND_TIMEOUT_S)
    response.raise_for_status()
    result = response.json()
    if not isinstance(result.get("replies"), list):
      raise ValueError("Invalid reply response")
    return result
  except HTTPException:
    raise
  except Exception as exc:
    raise HTTPException(
      status_code=502, detail="Community replies could not be reached."
    ) from exc


def _board_media_path(
  kind: str, post_id: str, index: int | None, extension: str | None,
) -> str:
  # A link that ends in the image's type can be served from the community
  # site's CDN; without a known type the host still answers the bare link.
  name = post_id if index is None else f"{post_id}/{index}"
  return f"board/{kind}/{name}" + (f".{extension}" if extension else "")


async def _serve_owner_board_media(
  host: str, post_id: str, index: int | None, thumbnail: bool = False,
  recorded_mime: str | None = None,
):
  """Serve one community-board image (a gallery index or the first/legacy one),
  caching remote hosts for 24 hours. ``recorded_mime`` is the type the post
  records for a full image; the host keeps every thumbnail as WebP."""

  cache_dir = _peer_board_media_dir()
  base_stem = _peer_board_media_name(host, post_id)
  stem = base_stem if index is None else f"{base_stem}-{index}"
  if thumbnail:
    stem = f"{stem}-thumb"
  cached = None
  cached_response = None
  async with _peer_board_media_lock(cache_dir):
    cached = _find_image(cache_dir, stem)
    if cached is not None:
      try:
        cached_response = _PinnedBoardMediaResponse(cached)
      except OSError:
        cached = None
      else:
        if time.time() - cached_response.fetched_at < BOARD_MEDIA_CACHE_TTL_S:
          _mark_board_media_used(cached[0])
          return cached_response
  suffix = (
    _board_media_path("thumbnail", post_id, index, "webp") if thumbnail
    else _board_media_path(
      "media", post_id, index, _ATTACHMENT_MIME_EXT.get(recorded_mime),
    )
  )
  try:
    try:
      mime, data = await _download_board_media(_peer_service_url(host, suffix), thumbnail=thumbnail)
    except Exception:
      # A full image's typed link names what the host stored, so a miss means
      # it is gone; only a thumbnail has something else to fall back to.
      if not thumbnail:
        raise
      mime, data = await _download_board_media(
        _peer_service_url(host, _board_media_path("media", post_id, index, None))
      )
    if thumbnail:
      # Peer bytes are untrusted even when served from a thumbnail route.
      # Re-encode after the header-size guard before caching or serving them.
      mime, data = image_thumbnail_bytes(data)
    target = cache_dir / f"{stem}.{_ATTACHMENT_MIME_EXT[mime]}"
    async with _peer_board_media_lock(cache_dir):
      atomic_write(target, data)
      for _old_mime, ext in _ATTACHMENT_MIME_EXT.items():
        old = cache_dir / f"{stem}.{ext}"
        if old != target and old.is_file():
          old.unlink()
      try:
        _evict_peer_board_media(cache_dir, target)
      except OSError:
        pass
      response = _PinnedBoardMediaResponse((target, mime))
  except asyncio.CancelledError:
    if cached_response is not None:
      cached_response.close()
    raise
  except Exception:
    if cached_response is None:
      raise HTTPException(status_code=404, detail="Board image not found.")
    # The peer is unreachable: the expired copy is still the best answer.
    _mark_board_media_used(cached[0])
    return cached_response
  if cached_response is not None:
    cached_response.close()
  return response


@router.get("/board-media/{post_id}")
async def get_board_media_for_owner(
  post_id: str,
  thumbnail: bool = False,
  mime: str | None = None,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Serve a community-board image (the first, for legacy single-image posts)."""
  _require_owner_or_common_app(db, principal)
  if not _valid_id(post_id):
    raise HTTPException(status_code=400, detail="Post id is invalid.")
  return await _serve_owner_board_media(
    COMMUNITY_HOST, post_id, None, thumbnail, mime,
  )


@router.get("/board-media/{post_id}/{index}")
async def get_board_media_index_for_owner(
  post_id: str,
  index: int,
  thumbnail: bool = False,
  mime: str | None = None,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Serve one image from a multi-image community-board post."""
  _require_owner_or_common_app(db, principal)
  if not _valid_id(post_id):
    raise HTTPException(status_code=400, detail="Post id is invalid.")
  if not 0 <= index < _MAX_BOARD_ATTACHMENTS:
    raise HTTPException(status_code=400, detail="Image index is invalid.")
  return await _serve_owner_board_media(
    COMMUNITY_HOST, post_id, index, thumbnail, mime,
  )


@router.get("/reply-media/{post_id}/{reply_id}")
async def get_reply_media_for_owner(
  post_id: str,
  reply_id: str,
  thumbnail: bool = False,
  mime: str | None = None,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Proxy one hosted reply image under its post and reply identity."""
  _require_owner_or_common_app(db, principal)
  if not _valid_id(post_id) or not _valid_id(reply_id):
    raise HTTPException(status_code=400, detail="Reply media id is invalid.")
  extension = "webp" if thumbnail else _ATTACHMENT_MIME_EXT.get(mime)
  kind = "thumbnail" if thumbnail else "media"
  path = f"board/{post_id}/replies/{reply_id}/{kind}"
  if extension:
    path += f".{extension}"
  try:
    found_mime, data = await _download_board_media(
      _peer_service_url(COMMUNITY_HOST, path), thumbnail=thumbnail,
    )
    if thumbnail:
      found_mime, data = image_thumbnail_bytes(data)
  except Exception as exc:
    raise HTTPException(status_code=404, detail="Reply image not found.") from exc
  # The bounded client thumbnail cache already handles reopening. Do not
  # leave a second, unbounded disk copy that is never read by this proxy.
  return Response(content=data, media_type=found_mime,
    headers={"Cache-Control": OWNER_BOARD_IMAGE_CACHE, "X-Content-Type-Options": "nosniff"})


async def _feed_payload(
  limit: int = 30,
  before: str | None = None,
  db: object = None,
  principal: Principal = None,
) -> dict:
  _require_owner_or_common_app(db, principal)
  host = COMMUNITY_HOST
  try:
    response = await federation_request(
      "GET", _peer_service_url(host, "board"),
      params={
        "limit": limit, "viewer": _own_host(),
        **({"before": before} if before else {}),
      },
      timeout_seconds=OUTBOUND_TIMEOUT_S,
    )
    response.raise_for_status()
    return {"host": host, **response.json()}
  except HTTPException:
    raise
  except Exception as exc:
    raise HTTPException(
      status_code=502, detail="Community host could not be reached."
    ) from exc


@router.get("/feed")
async def get_feed(
  limit: int = 30,
  before: str | None = None,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """The community host's board, proxied for the app UI."""
  return await _feed_payload(limit, before, db, principal)


class LikePost(BaseModel):
  post_id: str


class ReactionPost(BaseModel):
  post_id: str
  emoji: str
  reply_id: str | None = None


class ReplyPost(BaseModel):
  post_id: str
  text: str = ""
  id: str | None = None
  attachment: Any = None
  thumbnail: Any = None


@router.post("/like")
async def like_post(
  body: LikePost,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Toggle a like on a community-board post, signed as this instance."""
  return await _react_to_post(body.post_id, "❤️", db, principal)


@router.post("/reaction")
async def react_to_post(
  body: ReactionPost,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Toggle one standard emoji reaction on a community-board post."""
  return await _react_to_post(body.post_id, body.emoji, db, principal, body.reply_id)


async def _react_to_post(post_id_value, emoji, db, principal, reply_id=None):
  require_nondelegated_owner_control(principal)
  _require_member(db, principal)
  post_id = str(post_id_value).strip()
  if not re.fullmatch(r"[a-f0-9-]{8,64}", post_id):
    raise HTTPException(status_code=400, detail="Post id is invalid.")
  if reply_id is not None and not _valid_id(reply_id):
    raise HTTPException(status_code=400, detail="Reply id is invalid.")
  if emoji not in BOARD_REACTION_EMOJIS:
    raise HTTPException(status_code=400, detail="Reaction is not supported.")
  identity = _load_identity()
  _require_username(identity)
  host = COMMUNITY_HOST
  envelope = {
    "v": 0,
    "type": "board_react",
    "post_id": post_id,
    "emoji": emoji,
    "from": _own_host(),
    "sent_at": time.time(),
  }
  if emoji is not None:
    envelope["emoji"] = emoji
  if reply_id is not None:
    envelope["reply_id"] = reply_id
  envelope["sig"] = _sign(envelope, identity["private_key_b64"])
  try:
    response = await _post_signed_envelope(
      _peer_service_url(host, "board/react"), envelope,
      max_response_bytes=MAX_ENVELOPE_BYTES,
    )
    response.raise_for_status()
    return response.json()
  except Exception as exc:
    raise HTTPException(
      status_code=502, detail=_community_write_error(exc, "reaction")
    ) from exc


@router.post("/reply")
async def reply_to_post(
  body: ReplyPost,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Reply to a community-board post, signed as this instance."""
  require_nondelegated_owner_control(principal)
  _require_member(db, principal)
  post_id = body.post_id.strip()
  if not re.fullmatch(r"[a-f0-9-]{8,64}", post_id):
    raise HTTPException(status_code=400, detail="Post id is invalid.")
  text = body.text.strip()
  attachment = _validate_attachment(body.attachment)
  thumbnail = _validate_attachment(body.thumbnail, thumbnail=True)
  _validate_text_or_attachment(text, attachment, "Reply text is invalid.", MAX_REPLY_TEXT_CHARS)
  if thumbnail is not None and attachment is None:
    raise HTTPException(status_code=400, detail="Reply thumbnail needs a photo.")
  identity = _load_identity()
  _require_username(identity)
  host = COMMUNITY_HOST
  reply_id = body.id or str(uuid.uuid4())
  if not _valid_id(reply_id):
    raise HTTPException(status_code=400, detail="Reply id is invalid.")
  write_started = False
  try:
    async with asyncio.timeout(COMMUNITY_WRITE_TIMEOUT_S):
      limits = None
      if attachment is not None:
        # Check compatibility before building a signed reply. This also
        # preserves the old-host rejection path when no local host is set.
        limits = await _require_community_media_support(
          host, reply=True, gif=attachment[0]["mime"] == "image/gif",
          originals=[attachment], thumbnails=[thumbnail] if thumbnail else None,
        )
      sent_at = time.time()
      envelope = {
        "v": 0,
        "type": "board_reply",
        "post_id": post_id,
        "id": reply_id,
        "text": text,
        "from": _own_host(),
        "sent_at": sent_at,
      }
      if attachment is not None:
        envelope["attachment"] = attachment[0]
      if thumbnail is not None:
        envelope["thumbnail"] = thumbnail[0]
      envelope["sig"] = _sign(envelope, identity["private_key_b64"])
      _validate_attachment_envelope_size(envelope)
      if limits is not None and _wire_json_size(envelope) > limits["envelope_bytes"]:
        raise HTTPException(status_code=409, detail="Community host media limit is smaller than this draft. Your draft is unchanged.")
      write_started = True
      response = await _post_signed_envelope(
        _peer_service_url(host, "board/reply"), envelope,
        max_response_bytes=MAX_ENVELOPE_BYTES,
      )
      response.raise_for_status()
      return {**response.json(), "id": reply_id}
  except (TimeoutError, httpx.TimeoutException) as exc:
    detail = (
      "The reply may have been sent, but confirmation timed out. Retry the same reply to confirm."
      if write_started else "Community reply photo support could not be checked."
    )
    raise HTTPException(status_code=502, detail=detail) from exc
  except HTTPException:
    raise
  except Exception as exc:
    raise HTTPException(
      status_code=502, detail=_community_write_error(exc, "reply")
    ) from exc


class DeletePost(BaseModel):
  post_id: str


@router.post("/delete")
async def delete_own_post(
  body: DeletePost,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Delete one of the owner's own board posts from the community host."""
  require_nondelegated_owner_control(principal)
  _require_member(db, principal)
  post_id = body.post_id.strip()
  if not re.fullmatch(r"[a-f0-9-]{8,64}", post_id):
    raise HTTPException(status_code=400, detail="Post id is invalid.")
  identity = _load_identity()
  host = COMMUNITY_HOST
  envelope = {
    "v": 0,
    "type": "board_delete",
    "post_id": post_id,
    "from": _own_host(),
    "sent_at": time.time(),
  }
  envelope["sig"] = _sign(envelope, identity["private_key_b64"])
  try:
    response = await federation_request(
      "POST", _peer_service_url(host, "board/delete"), json=envelope,
      max_response_bytes=MAX_ENVELOPE_BYTES,
      timeout_seconds=OUTBOUND_TIMEOUT_S,
    )
    response.raise_for_status()
    return response.json()
  except httpx.HTTPStatusError as exc:
    # The host was reachable but refused. An older release has no delete route
    # (404) or rejects the unknown envelope (400); either way it cannot delete
    # yet, so say that plainly instead of a misleading "unreachable". Our client
    # only ever sends a valid id and envelope, so those codes are not our fault.
    if exc.response.status_code in (400, 404):
      raise HTTPException(
        status_code=501,
        detail="This community server doesn’t support deleting posts yet.",
      ) from exc
    if exc.response.status_code == 403:
      raise HTTPException(
        status_code=403, detail="You can only delete your own posts.",
      ) from exc
    raise HTTPException(
      status_code=502, detail="The post could not be deleted.",
    ) from exc
  except Exception as exc:
    raise HTTPException(
      status_code=502, detail="Community host could not be reached."
    ) from exc


async def _people_payload(
  q: str = "",
  db: object = None,
  principal: Principal = None,
) -> dict:
  _require_member(db, principal)
  return await _search_community_members(q)


async def _search_community_members(q: str) -> dict:
  """One signed directory read for Social and shared-object invite lookup."""
  host = COMMUNITY_HOST
  identity = _load_identity()
  envelope = {
    "v": 0, "type": "directory_read", "from": _own_host(),
    "q": q, "sent_at": time.time(),
  }
  envelope["sig"] = _sign(envelope, identity["private_key_b64"])
  try:
    response = await federation_request(
      "POST", _peer_service_url(host, "directory/search"), json=envelope,
      timeout_seconds=OUTBOUND_TIMEOUT_S,
    )
    response.raise_for_status()
    return {"host": host, **response.json()}
  except httpx.HTTPStatusError as exc:
    if exc.response.status_code == 404:
      # The shared host is rolled out separately from personal installations.
      # This old public read is reachable only after the local membership gate;
      # once the host supports signed reads, it is never used.
      try:
        legacy = await federation_request(
          "GET", _peer_service_url(host, "directory"), params={"q": q},
          timeout_seconds=OUTBOUND_TIMEOUT_S,
        )
        legacy.raise_for_status()
        return {"host": host, **legacy.json()}
      except Exception as legacy_exc:
        raise HTTPException(
          status_code=502, detail="Community host could not be reached."
        ) from legacy_exc
    if exc.response.status_code == 403:
      raise HTTPException(
        status_code=403, detail="Join Social again to access People.",
      ) from exc
    raise HTTPException(
      status_code=502, detail="Community host could not be reached."
    ) from exc
  except HTTPException:
    raise
  except Exception as exc:
    raise HTTPException(
      status_code=502, detail="Community host could not be reached."
    ) from exc


@router.get("/people")
async def search_people(
  q: str = "",
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Search the community host's user directory, proxied for the app UI."""
  return await _people_payload(q, db, principal)


@router.get("/bootstrap")
async def bootstrap_social(
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Return first-paint board and identity state in one service invocation."""
  me, feed = await asyncio.gather(
    _cached_me_payload(db, principal),
    _feed_payload(30, None, db, principal),
  )
  if not me.get("joined"):
    registration = "not_joined"
  else:
    try:
      people = await _people_payload(me.get("host") or "", db, principal)
      registration = (
        "registered"
        if any(
          str(user.get("host") or "").strip().lower()
          == str(me.get("host") or "").strip().lower()
          for user in people.get("users", [])
        )
        else "missing"
      )
    except HTTPException as exc:
      registration = "missing" if exc.status_code == 403 else "unavailable"
  return {"me": {**me, "registration": registration}, "feed": feed}


@router.get("/peer/{host}")
async def get_peer(
  host: str,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """A peer's public actor card, for profile views in the app UI."""
  _require_member(db, principal)
  actor = await _fetch_actor(host.strip().lower())
  return actor


async def _member_avatar_from_directory(host: str, digest: str) -> tuple[Path, str] | None:
  """Serve a directory member's avatar by content hash, via the community host.

  The hash names one exact image, so a matching cached copy is current without
  asking anyone, and a new one comes from the community host's shared copy
  rather than from the member's own server. Bytes are verified against the hash
  and still re-encoded like any peer image. None falls back to the peer path.
  """
  cache = _peer_avatar_path(host)
  marker = _peer_avatar_digest_path(host)
  try:
    if cache.is_file() and marker.read_text().strip() == digest:
      return cache, "image/webp"
  except OSError:
    pass
  try:
    raw = await _download_avatar(
      _peer_service_url(COMMUNITY_HOST, f"directory/avatars/{digest}.webp"),
    )
    if hashlib.sha256(raw).hexdigest() != digest:
      raise ValueError("Directory avatar does not match its content hash.")
    _mime, encoded = await _decode_avatar(raw)
    atomic_write(cache, encoded)
    atomic_write(marker, digest.encode())
    _clear_avatar_markers(host)
  except Exception:
    return None
  return cache, "image/webp"


async def _resolve_peer_avatar(
  host: str, directory_digest: str | None = None,
) -> tuple[Path, str]:
  host = host.strip().lower()
  if not _valid_host(host):
    raise HTTPException(status_code=400, detail="Invalid peer host.")
  if host == _own_host():
    if not _avatar_path().is_file():
      raise HTTPException(status_code=404, detail="Avatar not found.")
    return _avatar_path(), "image/png"
  if directory_digest is not None:
    found = await _member_avatar_from_directory(host, directory_digest)
    if found is not None:
      return found
  cache = _peer_avatar_path(host)
  now = time.time()
  # Serve a fresh cached avatar without any federation hop (the common path).
  if cache.is_file() and now - cache.stat().st_mtime < PEER_AVATAR_CACHE_TTL_S:
    return cache, "image/webp"
  # A recently confirmed absence short-circuits without another federation hop.
  miss = _peer_avatar_miss_path(host)
  if _recent_marker(miss, PEER_AVATAR_MISS_TTL_S, now):
    raise HTTPException(status_code=404, detail="Peer avatar not found.")
  failure = _peer_avatar_failure_path(host)
  if _recent_marker(failure, PEER_AVATAR_FAILURE_TTL_S, now):
    if cache.is_file():
      return cache, "image/webp"
    raise HTTPException(
      status_code=502, detail="Peer avatar is temporarily unavailable.",
    )
  try:
    actor = await _fetch_actor(host)
  except Exception as exc:
    return _temporarily_unavailable_avatar(host, cache, exc)
  if actor.get("avatar") is not True:
    # Once the positive cache expires, a confirmed removal supersedes stale data.
    if cache.is_file():
      cache.unlink(missing_ok=True)
    _clear_avatar_markers(host)
    _mark_avatar_miss(host)
    raise HTTPException(status_code=404, detail="Peer avatar not found.")
  try:
    raw = await _download_avatar(_peer_service_url(host, "avatar"))
    # Keep network fetches concurrent but serialize memory-heavy raster decode
    # across short-lived workers. This preserves the established #21 input
    # contract without expanding multiple untrusted rasters at once.
    _mime, encoded = await _decode_avatar(raw)
    atomic_write(cache, encoded)
    _peer_avatar_digest_path(host).unlink(missing_ok=True)
    _clear_avatar_markers(host)
  except httpx.HTTPStatusError as exc:
    if exc.response.status_code == 404:
      if cache.is_file():
        cache.unlink(missing_ok=True)
      _clear_avatar_markers(host)
      _mark_avatar_miss(host)
      raise HTTPException(status_code=404, detail="Peer avatar not found.") from exc
    return _temporarily_unavailable_avatar(host, cache, exc)
  except Exception as exc:
    return _temporarily_unavailable_avatar(host, cache, exc)
  return cache, "image/webp"


@router.post("/peer-avatars")
async def get_peer_avatars(
  batch: AvatarBatch,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Resolve one bounded visible-avatar batch in a single service process."""
  _require_owner_or_common_app(db, principal)
  if len(batch.hosts) > PEER_AVATAR_BATCH_LIMIT:
    raise HTTPException(status_code=400, detail="Too many avatar hosts.")
  hosts = list(dict.fromkeys(host.strip().lower() for host in batch.hosts))
  if any(not _valid_host(host) for host in hosts):
    raise HTTPException(status_code=400, detail="Invalid peer host.")
  digests = {
    host.strip().lower(): digest for host, digest in batch.avatars.items()
    if isinstance(digest, str) and AVATAR_DIGEST.fullmatch(digest)
  }

  async def resolve(host: str):
    try:
      path, media_type = await asyncio.wait_for(
        _resolve_peer_avatar(host, digests.get(host)),
        timeout=PEER_AVATAR_BATCH_TIMEOUT_S,
      )
      return host, _avatar_wire(path, media_type), None
    except HTTPException as exc:
      status = "missing" if exc.status_code == 404 else "unavailable"
      return host, None, status
    except TimeoutError:
      _mark_avatar_failure(host)
      cache = _peer_avatar_path(host)
      if cache.is_file():
        return host, _avatar_wire(cache, "image/webp"), None
      return host, None, "unavailable"
    except Exception:
      _log.exception("Unexpected peer avatar batch failure for %s", host)
      _mark_avatar_failure(host)
      return host, None, "unavailable"

  avatars = {}
  missing = []
  unavailable = []
  served_digests = {}
  for host, avatar, status in await asyncio.gather(*(resolve(host) for host in hosts)):
    if avatar is not None:
      avatars[host] = avatar
      try:
        served = _peer_avatar_digest_path(host).read_text().strip()
      except OSError:
        served = ""
      if served and served == digests.get(host):
        served_digests[host] = served
    elif status == "missing":
      missing.append(host)
    else:
      unavailable.append(host)
  return {
    "avatars": avatars, "missing": missing, "unavailable": unavailable,
    "digests": served_digests,
  }
