"""Canonical ``common/0`` wire validation and peer-key verification.

This module is deliberately independent of the owner database and identity
keys.  Every personal Social service and the central community host use these
exact canonical bytes and validation rules, so there is one federation
implementation.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import math
import re
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import HTTPException, Request

from common_transport import federation_request
from service_io import atomic_write

PROTOCOL = "common/0"
PUBLIC_SERVICE_PATH = "/api/app-services/social"
# The one shared board and directory host every Möbius browses.
COMMUNITY_HOST = "www.mobius.you"
# Everything public is shown by handle, so the host refuses unnamed writers
# with this exact detail and instances recognise it.
NEEDS_USERNAME = "Choose a username in Möbius · You before joining in."
# Messages match Slack's 40,000-character cap. Board posts stay short because a
# feed page carries many of them through the bounded community-host transport.
MAX_MESSAGE_TEXT_CHARS = 40_000
MAX_POST_TEXT_CHARS = 4000
MAX_REPLY_TEXT_CHARS = 1000
MAX_NAME_CHARS = 80
MAX_BIO_CHARS = 400
MAX_ENVELOPE_BYTES = 32_768
MAX_ATTACHMENT_ENVELOPE_BYTES = 60 * 1024 * 1024
# Match the existing signed-write allowance, as a total receive budget rather
# than an idle timeout that an unauthenticated drip stream can keep refreshing.
MAX_ENVELOPE_RECEIVE_SECONDS = 12.0
# Media grows scalar strings, not JSON structure. Bound container/entry
# amplification independently of the wire-byte allowance, including extras.
MAX_ENVELOPE_STRUCTURE_TOKENS = 32_768
MAX_ENVELOPE_DEPTH = 64
MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
MAX_STATIC_ATTACHMENT_BYTES = 5 * 1024 * 1024
MAX_BOARD_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024
MAX_THUMBNAIL_BYTES = 120 * 1024
MAX_ATTACHMENT_DIMENSION = 8192
MAX_GIF_DIMENSION = 1600
MAX_GIF_FRAMES = 300
MAX_GIF_CANVAS_PIXELS = 32_000_000
# Every extension, image descriptor and data sub-block is one interpreted GIF
# block, walked synchronously in Python. Encoders write full 255-byte data
# sub-blocks, so a maximum-size original or comment-padded file needs about
# 82,000 blocks. The cap leaves room for short text/XMP sub-blocks while bounding
# the walk of a container built from millions of tiny blocks or repeated
# controls, which the byte limit alone would still admit.
MAX_GIF_BLOCKS = 524_288
# One board post may carry four images within a separate raw-byte budget.
MAX_BOARD_ATTACHMENTS = 4
MAX_REPLY_AUTHOR_CHARS = 80
MAX_REPLY_EXCERPT_CHARS = 140
MAX_AVATAR_BYTES = 512 * 1024
ACTOR_CACHE_TTL_S = 3600
ACTOR_CACHE_LIMIT = 4096
# A signed delivery can make the receiver fetch the sender's actor card before
# it answers. Keep that nested budget shorter than the delivery budget, while
# keeping the whole write below the platform service's 15-second hard ceiling.
# Otherwise the platform kills the service before Social can classify the peer
# timeout and return its own useful error.
ACTOR_FETCH_TIMEOUT_S = 10.0
OUTBOUND_TIMEOUT_S = 10.0
SIGNED_WRITE_TIMEOUT_S = 12.0

CLOCK_SKEW_S = 600
_HOST_RE = re.compile(r"^[a-z0-9]([a-z0-9.-]{0,250})(:\d{1,5})?$")
_ID_RE = re.compile(r"^[a-f0-9-]{8,64}$")
ATTACHMENT_MIME_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
}
_CONTENT_ENVELOPE_TYPES = {
  "message", "group_post", "group_message", "board_post", "board_reply",
}
_JSON_STRUCTURE_RE = re.compile(r'["{}\[\]:,]')


def valid_host(host: Any) -> bool:
  return isinstance(host, str) and bool(_HOST_RE.fullmatch(host))


def valid_id(value: Any) -> bool:
  return isinstance(value, str) and bool(_ID_RE.fullmatch(value))


def peer_base_url(host: str) -> str:
  """Return the public HTTPS origin for an already-validated peer host."""
  return f"https://{host}"


def peer_service_url(host: str, path: str = "") -> str:
  """Return one peer-facing URL on Social's public app service."""
  suffix = path.lstrip("/")
  return f"{peer_base_url(host)}{PUBLIC_SERVICE_PATH}" + (
    f"/{suffix}" if suffix else ""
  )


async def post_signed_envelope(
  url: str, envelope: dict, *, max_response_bytes: int = MAX_ENVELOPE_BYTES,
):
  """Send a signed write with room for the receiver's actor-card callback."""
  return await federation_request(
    "POST", url, json=envelope, max_response_bytes=max_response_bytes,
    timeout_seconds=SIGNED_WRITE_TIMEOUT_S,
  )


def canonical(payload: dict) -> bytes:
  """The frozen ``common/0`` signed representation (do not change)."""
  return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()


def wire_json_size(payload: dict) -> int:
  """Return the exact UTF-8 size produced by the shared HTTP JSON transport."""
  return len(json.dumps(
    payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False,
  ).encode("utf-8"))


def validate_attachment_envelope_size(payload: dict) -> None:
  if wire_json_size(payload) > MAX_ATTACHMENT_ENVELOPE_BYTES:
    raise HTTPException(
      status_code=413,
      detail="Attachments are too large to send together.",
    )


def new_signing_key() -> str:
  """Return a fresh raw Ed25519 private key, base64-encoded."""
  from cryptography.hazmat.primitives import serialization
  from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
  return base64.b64encode(Ed25519PrivateKey.generate().private_bytes(
    encoding=serialization.Encoding.Raw,
    format=serialization.PrivateFormat.Raw,
    encryption_algorithm=serialization.NoEncryption(),
  )).decode()


def signing_public_key(private_key_b64: str) -> str:
  """Derive the advertised Ed25519 key from the key that signs envelopes."""
  from cryptography.hazmat.primitives import serialization
  from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
  key = Ed25519PrivateKey.from_private_bytes(
    base64.b64decode(private_key_b64, validate=True)
  )
  return base64.b64encode(key.public_key().public_bytes(
    encoding=serialization.Encoding.Raw,
    format=serialization.PublicFormat.Raw,
  )).decode()


def sign(payload: dict, private_key_b64: str) -> str:
  from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
  key = Ed25519PrivateKey.from_private_bytes(
    base64.b64decode(private_key_b64, validate=True)
  )
  return base64.b64encode(key.sign(canonical(payload))).decode()


def verify(payload: dict, sig_b64: str, public_key_b64: str) -> bool:
  from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
  try:
    signature = base64.b64decode(sig_b64, validate=True)
    public_key = base64.b64decode(public_key_b64, validate=True)
    if len(signature) != 64 or len(public_key) != 32:
      return False
    Ed25519PublicKey.from_public_bytes(public_key).verify(
      signature, canonical(payload)
    )
    return True
  except Exception:
    return False


_GIF_TOO_COMPLEX = "GIF structure is too complex."


def _skip_gif_subblocks(data: bytes, position: int, blocks: int) -> tuple[int, int]:
  """Step over one data sub-block chain, counting each against MAX_GIF_BLOCKS.

  Dense chains are the hot path: lengths are read without slicing payloads, and
  the walk stops at the cap rather than after the whole container.
  """
  end = len(data)
  while position < end:
    size = data[position]
    position += size + 1
    if not size:
      return position, blocks
    blocks += 1
    if blocks > MAX_GIF_BLOCKS:
      raise HTTPException(status_code=413, detail=_GIF_TOO_COMPLEX)
  raise ValueError("Truncated GIF block.")


def validate_gif_bytes(wire: dict, data: bytes) -> bytes:
  """Preflight complete GIF framing/budgets, then decode every raster.

  Pillow tolerates a missing trailer and can enlarge its canvas for an image
  descriptor. Walk GIF87a/89a blocks first, without decoding or allocating any
  raster. LZW decoding remains Pillow's responsibility; originals are never
  re-encoded. See https://www.w3.org/Graphics/GIF/spec-gif89a.txt.
  """
  from PIL import Image

  if len(data) > MAX_ATTACHMENT_BYTES:
    raise HTTPException(status_code=413, detail="Attachment is too large.")
  position = 0
  blocks = 0  # Every interpreted block, bounded by MAX_GIF_BLOCKS.

  def take(size: int) -> bytes:
    nonlocal position
    end = position + size
    if end > len(data):
      raise ValueError("Truncated GIF block.")
    block = data[position:end]
    position = end
    return block

  try:
    if take(6) not in (b"GIF87a", b"GIF89a") or wire["mime"] != "image/gif":
      raise ValueError("GIF header does not match its media type.")
    screen = take(7)
    width = int.from_bytes(screen[:2], "little")
    height = int.from_bytes(screen[2:4], "little")
    if not width or not height or (width, height) != (wire["w"], wire["h"]):
      raise ValueError("GIF dimensions do not match its metadata.")
    if max(width, height) > MAX_GIF_DIMENSION:
      raise HTTPException(status_code=413, detail="GIF dimensions are too large.")
    global_palette = bool(screen[4] & 0x80)
    if global_palette:
      take(3 * (2 ** ((screen[4] & 7) + 1)))
    # Non-GCE extension metadata may be large but cannot alter LZW rasters.
    # Validate its framing while excluding it from Pillow's slower metadata
    # aggregation; the original bytes remain untouched for storage.
    decoded_parts = [data[:position]]
    # GIF89a allows one graphic control per rendering block, but decoders
    # tolerate a run of them. Pillow folds a run before one image: the last
    # delay, the last transparency index and the last non-zero disposal win.
    # Keeping just the controls that supply those values (in original order)
    # decodes exactly like keeping all of them, with at most three per frame.
    controls: dict[str, tuple[int, int]] = {}
    frames = 0
    while True:
      block_start = position
      marker = take(1)[0]
      if marker == 0x3b:  # Trailer: it must terminate the entire container.
        if not frames or position != len(data):
          raise ValueError("GIF trailer is invalid.")
        # Controls after the last image precede no raster.
        decoded_parts.append(b";")
        break
      blocks += 1
      if blocks > MAX_GIF_BLOCKS:
        raise HTTPException(status_code=413, detail=_GIF_TOO_COMPLEX)
      if marker == 0x21:  # Extension; unknown labels are safely skippable.
        label = take(1)[0]
        if label == 0xf9:
          # Size, packed fields, delay, transparency index, terminator.
          control = take(6)
          packed = control[1]
          if control[0] != 4 or control[5] or packed & 0xe0 or ((packed >> 2) & 7) > 3:
            raise ValueError("GIF graphic control is invalid.")
          span = (block_start, position)
          controls["delay"] = span
          if packed & 0x01:
            controls["transparency"] = span
          if packed & 0x1c:
            controls["disposal"] = span
          continue
        if label in (0xff, 0x01):  # Application and plain-text headers.
          size = take(1)[0]
          if size != (11 if label == 0xff else 12):
            raise ValueError("GIF extension size is invalid.")
          take(size)
        position, blocks = _skip_gif_subblocks(data, position, blocks)
        continue
      if marker != 0x2c:
        raise ValueError("GIF block is invalid.")
      decoded_parts.extend(data[start:end] for start, end in sorted(set(controls.values())))
      controls.clear()
      descriptor = take(9)
      left, top, frame_width, frame_height = (
        int.from_bytes(descriptor[i:i + 2], "little") for i in (0, 2, 4, 6)
      )
      if (not frame_width or not frame_height
          or left + frame_width > width or top + frame_height > height
          or descriptor[8] & 0x18):
        raise ValueError("GIF frame dimensions or flags are invalid.")
      frames += 1
      if frames > MAX_GIF_FRAMES or width * height * frames > MAX_GIF_CANVAS_PIXELS:
        raise HTTPException(status_code=413, detail="GIF animation is too large.")
      if descriptor[8] & 0x80:
        take(3 * (2 ** ((descriptor[8] & 7) + 1)))
      elif not global_palette:
        raise ValueError("GIF frame has no color table.")
      if not 2 <= take(1)[0] <= 8:
        raise ValueError("GIF LZW code size is invalid.")
      position, blocks = _skip_gif_subblocks(data, position, blocks)
      decoded_parts.append(data[block_start:position])
    # No Pillow seek/load happens until the complete container fits every cap.
    decode_view = b"".join(decoded_parts)
    with Image.open(io.BytesIO(decode_view)) as image:
      if image.format != "GIF" or image.size != (width, height):
        raise ValueError("GIF header is invalid.")
      for index in range(frames):
        image.seek(index)
        image.load()
      try:
        image.seek(frames)
      except EOFError:
        pass
      else:
        raise ValueError("GIF frame count is invalid.")
    return decode_view
  except (OSError, ValueError, SyntaxError, EOFError, Image.DecompressionBombError) as exc:
    raise HTTPException(status_code=400, detail="GIF attachment is invalid.") from exc


def validate_attachment(
  value: Any, *, thumbnail: bool = False,
) -> tuple[dict, bytes] | None:
  """Validate and decode the protocol's one supported attachment shape."""
  if value is None:
    return None
  if not isinstance(value, dict) or set(value) != {"mime", "data_b64", "w", "h"}:
    raise HTTPException(status_code=400, detail="Attachment is invalid.")
  mime = value.get("mime")
  data_b64 = value.get("data_b64")
  width = value.get("w")
  height = value.get("h")
  if (
    not isinstance(mime, str)
    or mime not in ATTACHMENT_MIME_EXT
    or not isinstance(data_b64, str)
    or not isinstance(width, int) or isinstance(width, bool)
    or not isinstance(height, int) or isinstance(height, bool)
    or not 1 <= width <= MAX_ATTACHMENT_DIMENSION
    or not 1 <= height <= MAX_ATTACHMENT_DIMENSION
  ):
    raise HTTPException(status_code=400, detail="Attachment is invalid.")
  limit = (MAX_THUMBNAIL_BYTES if thumbnail else
           MAX_ATTACHMENT_BYTES if mime == "image/gif" else
           MAX_STATIC_ATTACHMENT_BYTES)
  max_b64_chars = 4 * ((limit + 2) // 3)
  if len(data_b64) > max_b64_chars:
    raise HTTPException(status_code=413, detail="Attachment is too large.")
  try:
    data = base64.b64decode(data_b64, validate=True)
  except Exception as exc:
    raise HTTPException(status_code=400, detail="Attachment data is invalid.") from exc
  if len(data) > limit:
    raise HTTPException(status_code=413, detail="Attachment is too large.")
  if not data:
    raise HTTPException(status_code=400, detail="Attachment data is empty.")
  # A false static MIME must not bypass animation budgets or capability gates.
  if mime == "image/gif" or data[:6] in (b"GIF87a", b"GIF89a"):
    if thumbnail:
      raise HTTPException(status_code=400, detail="Thumbnail must be static.")
    validate_gif_bytes(value, data)
  return value, data


def validate_attachments(
  value: Any, *, max_count: int = MAX_BOARD_ATTACHMENTS,
  thumbnail: bool = False,
) -> list[tuple[dict, bytes]] | None:
  """Validate the multi-image shape: a bounded list of single attachments.

  The gallery's original bytes have a separate combined limit. Thumbnails
  are bounded individually and do not count as originals.
  """
  if value is None:
    return None
  if not isinstance(value, list) or not value:
    raise HTTPException(status_code=400, detail="Attachments are invalid.")
  if len(value) > max_count:
    raise HTTPException(
      status_code=400, detail=f"At most {max_count} images are allowed.",
    )
  decoded: list[tuple[dict, bytes]] = []
  for item in value:
    one = validate_attachment(item, thumbnail=thumbnail)
    if one is None:
      raise HTTPException(status_code=400, detail="Attachments are invalid.")
    decoded.append(one)
    if not thumbnail and sum(len(data) for _, data in decoded) > MAX_BOARD_TOTAL_ATTACHMENT_BYTES:
      raise HTTPException(status_code=413, detail="Post images are too large together.")
  return decoded


def validate_reply_to(value: Any) -> dict | None:
  """Validate a self-contained quoted reply without resolving its target."""
  if value is None:
    return None
  if not isinstance(value, dict) or set(value) != {
    "id", "author_handle", "excerpt",
  }:
    raise HTTPException(status_code=400, detail="Quoted reply is invalid.")
  if (
    not valid_id(value.get("id"))
    or not isinstance(value.get("author_handle"), str)
    or len(value["author_handle"]) > MAX_REPLY_AUTHOR_CHARS
    or not isinstance(value.get("excerpt"), str)
    or len(value["excerpt"]) > MAX_REPLY_EXCERPT_CHARS
  ):
    raise HTTPException(status_code=400, detail="Quoted reply is invalid.")
  return value


def validate_text_or_attachment(
  text: Any, attachment: tuple[dict, bytes] | None, detail: str,
  max_chars: int = MAX_MESSAGE_TEXT_CHARS,
) -> None:
  if (
    not isinstance(text, str)
    or len(text) > max_chars
    or (not text.strip() and attachment is None)
  ):
    raise HTTPException(status_code=400, detail=detail)


def _preflight_envelope_structure(document: str) -> None:
  """Bound JSON allocation shape, without decoding containers or rewriting source.

  Count the six structural punctuation characters outside quoted strings.
  Commas/colons also bound scalar entries and object keys (including duplicates),
  not just containers. Stdlib's string scanner advances over quoted strings in
  C, including arbitrary escaping; its temporary scalar is discarded immediately.
  This avoids Python work per escape without narrowing legitimate media/text
  encodings or materializing any containers. No source slices or token list are
  made. Grammar, escapes, Unicode and value semantics remain stdlib JSON's job.
  Resource overruns take precedence over any later malformed-JSON error.
  """
  position = tokens = depth = strings = 0
  while match := _JSON_STRUCTURE_RE.search(document, position):
    token = match[0]
    position = match.end()
    if token == '"':
      strings += 1
      if strings > MAX_ENVELOPE_STRUCTURE_TOKENS:
        # Valid entries already spend punctuation. Malformed adjacent strings
        # must not buy unbounded Python/C calls by omitting those separators.
        raise HTTPException(status_code=413, detail="Envelope JSON is too complex.")
      try:
        position = json.decoder.scanstring(document, position)[1]
      except ValueError:
        # Parsing must fail at this string before any later containers. The
        # bounded prefix is safe; let json.loads report the ordinary JSON400.
        return
      continue
    tokens += 1
    if token in "{[":
      depth += 1
    elif token in "}]":
      depth -= 1
    if tokens > MAX_ENVELOPE_STRUCTURE_TOKENS or depth > MAX_ENVELOPE_DEPTH:
      raise HTTPException(status_code=413, detail="Envelope JSON is too complex.")


def loads_bounded_json(data: bytes) -> Any:
  """Decode JSON bytes like ``json.loads(bytes)``, admitting structure first.

  Wire envelopes and authenticated plaintext revealed only after decryption
  share this one primitive; neither has a trusted shape. Encoding detection
  matches stdlib's UTF-8/16/32 handling and retains one decoded source. A
  resource overrun raises HTTPException(413) before any container exists; any
  other exception means the bytes are not JSON. Callers own their wire errors.
  """
  document = data.decode(json.detect_encoding(data), "surrogatepass")
  _preflight_envelope_structure(document)
  return json.loads(document)


async def read_envelope(
  request: Request, *, max_bytes: int = MAX_ATTACHMENT_ENVELOPE_BYTES,
) -> dict:
  """Read within the route's wire cap, narrowed by any public reservation."""
  # The public router reserves this allowance for the complete request lifetime.
  # Its route-owned state also caps control streams before JSON materialization;
  # neither an untrusted Content-Length nor the document's type grants room.
  state = getattr(request, "state", None)
  limit = min(max_bytes, getattr(state, "common_envelope_max_bytes", max_bytes))
  body = bytearray()
  receive_budget = asyncio.timeout(MAX_ENVELOPE_RECEIVE_SECONDS)
  try:
    async with receive_budget:
      async for chunk in request.stream():
        # Also enforce the absolute budget for immediately-ready chunks, which
        # need not suspend to deliver asyncio's deadline cancellation.
        if asyncio.get_running_loop().time() >= receive_budget.when():
          raise HTTPException(status_code=408, detail="Envelope receive deadline exceeded.")
        # Reject even one oversized chunk before copying it into our body buffer.
        if len(chunk) > limit - len(body):
          raise HTTPException(status_code=413, detail="Request body is too large.")
        body.extend(chunk)
  except TimeoutError:
    if not receive_budget.expired():
      raise
    raise HTTPException(status_code=408, detail="Envelope receive deadline exceeded.") from None
  body = bytes(body)
  try:
    envelope = loads_bounded_json(body)
  except HTTPException:
    raise
  except Exception as exc:
    raise HTTPException(status_code=400, detail="Envelope is not JSON.") from exc
  if not isinstance(envelope, dict):
    raise HTTPException(status_code=400, detail="Envelope is not an object.")
  # Content envelopes may carry long text, images, or ciphertext; their fields
  # are validated individually. Control envelopes stay small.
  if (
    len(body) > MAX_ENVELOPE_BYTES
    and envelope.get("type") not in _CONTENT_ENVELOPE_TYPES
  ):
    raise HTTPException(status_code=413, detail="Envelope too large.")
  return envelope


def _validate_actor_card(actor: Any, host: str) -> dict:
  """Validate the bounded subset used as signature authority.

  Extra actor fields remain allowed for protocol compatibility, but all
  strings consumed by this service and the Ed25519 key are strictly bounded.
  The transport separately caps the complete actor document at 32 KiB.
  """
  if (
    not isinstance(actor, dict)
    or actor.get("protocol") != PROTOCOL
    or actor.get("host") != host
  ):
    raise HTTPException(status_code=502, detail="Peer returned an invalid actor card.")
  handle = actor.get("handle", "")
  bio = actor.get("bio", "")
  if (
    not isinstance(handle, str) or len(handle) > MAX_NAME_CHARS
    or not isinstance(bio, str) or len(bio) > MAX_BIO_CHARS
  ):
    raise HTTPException(status_code=502, detail="Peer returned an invalid actor card.")
  public_key = actor.get("public_key")
  key = public_key.get("key_b64") if isinstance(public_key, dict) else None
  try:
    raw_key = base64.b64decode(key, validate=True) if isinstance(key, str) else b""
  except Exception:
    raw_key = b""
  if (
    not isinstance(public_key, dict)
    or public_key.get("alg") != "ed25519"
    or len(key or "") > 128
    or len(raw_key) != 32
  ):
    raise HTTPException(status_code=502, detail="Peer returned an invalid actor card.")
  return actor


class ActorVerifier:
  """Fetch/cache remote actor keys and verify signed Common envelopes."""

  def __init__(self, data_dir: str | Path | Callable[[], str | Path]):
    self._data_dir = data_dir
    self._cache_lock = threading.Lock()

  def _root(self) -> Path:
    value = self._data_dir() if callable(self._data_dir) else self._data_dir
    return Path(value) / "common"

  def peers_dir(self) -> Path:
    path = self._root() / "peers"
    path.mkdir(parents=True, exist_ok=True)
    return path

  def cache_path(self, host: str) -> Path:
    safe = re.sub(r"[^a-z0-9.-]", "_", host)
    return self.peers_dir() / f"{safe}.json"

  def _read_cached(self, host: str) -> dict | None:
    cache = self.cache_path(host)
    if not cache.is_file() or cache.stat().st_size > MAX_ENVELOPE_BYTES:
      return None
    try:
      cached = json.loads(cache.read_text(encoding="utf-8"))
      fetched_at = cached.get("fetched_at", 0)
      if (
        not isinstance(fetched_at, (int, float)) or isinstance(fetched_at, bool)
        or not math.isfinite(fetched_at)
        or time.time() - fetched_at >= ACTOR_CACHE_TTL_S
      ):
        return None
      return _validate_actor_card(cached.get("actor"), host)
    except Exception:
      return None

  async def fetch_actor(self, host: str, *, force: bool = False) -> dict:
    if not valid_host(host):
      raise HTTPException(status_code=400, detail="Invalid peer host.")
    if not force:
      with self._cache_lock:
        cached = self._read_cached(host)
      if cached is not None:
        return cached
    try:
      response = await federation_request(
        "GET", peer_service_url(host, "actor"),
        max_response_bytes=MAX_ENVELOPE_BYTES,
        timeout_seconds=ACTOR_FETCH_TIMEOUT_S,
      )
      response.raise_for_status()
      actor = response.json()
    except Exception as exc:
      raise HTTPException(status_code=502, detail="Peer could not be reached.") from exc
    actor = _validate_actor_card(actor, host)
    with self._cache_lock:
      cache = self.cache_path(host)
      if (
        cache.is_file()
        or sum(1 for _ in self.peers_dir().glob("*.json")) < ACTOR_CACHE_LIMIT
      ):
        atomic_write(
          cache, json.dumps({"fetched_at": time.time(), "actor": actor}),
        )
    return actor

  async def verify_envelope(self, envelope: dict) -> dict:
    sender = envelope.get("from")
    signature = envelope.get("sig")
    if (
      not valid_host(sender)
      or not isinstance(signature, str)
      or len(signature) > 128
    ):
      raise HTTPException(status_code=400, detail="Malformed envelope.")
    sent_at = envelope.get("sent_at")
    if (
      not isinstance(sent_at, (int, float))
      or isinstance(sent_at, bool)
      or not math.isfinite(sent_at)
      or abs(time.time() - sent_at) > CLOCK_SKEW_S
    ):
      raise HTTPException(status_code=400, detail="Envelope timestamp out of range.")
    payload = {key: value for key, value in envelope.items() if key != "sig"}
    try:
      actor = await self.fetch_actor(sender)
    except HTTPException as exc:
      raise HTTPException(status_code=403, detail="Envelope signature is invalid.") from exc
    if not verify(payload, signature, actor["public_key"]["key_b64"]):
      try:
        actor = await self.fetch_actor(sender, force=True)
      except HTTPException:
        raise HTTPException(status_code=403, detail="Envelope signature is invalid.")
      if not verify(payload, signature, actor["public_key"]["key_b64"]):
        raise HTTPException(status_code=403, detail="Envelope signature is invalid.")
    return actor


__all__ = [
  "ACTOR_CACHE_LIMIT", "ACTOR_CACHE_TTL_S", "ACTOR_FETCH_TIMEOUT_S",
  "ATTACHMENT_MIME_EXT", "ActorVerifier",
  "CLOCK_SKEW_S", "MAX_ATTACHMENT_BYTES", "MAX_STATIC_ATTACHMENT_BYTES",
  "MAX_BOARD_TOTAL_ATTACHMENT_BYTES", "MAX_THUMBNAIL_BYTES", "MAX_ATTACHMENT_DIMENSION",
  "MAX_ATTACHMENT_ENVELOPE_BYTES", "MAX_AVATAR_BYTES", "MAX_BIO_CHARS",
  "MAX_BOARD_ATTACHMENTS", "validate_attachments",
  "MAX_ENVELOPE_BYTES", "MAX_NAME_CHARS", "MAX_REPLY_TEXT_CHARS",
  "MAX_ENVELOPE_STRUCTURE_TOKENS", "MAX_ENVELOPE_DEPTH",
  "MAX_ENVELOPE_RECEIVE_SECONDS",
  "MAX_MESSAGE_TEXT_CHARS", "MAX_POST_TEXT_CHARS",
  "MAX_GIF_DIMENSION", "MAX_GIF_FRAMES", "MAX_GIF_CANVAS_PIXELS",
  "MAX_GIF_BLOCKS",
  "OUTBOUND_TIMEOUT_S", "SIGNED_WRITE_TIMEOUT_S",
  "COMMUNITY_HOST", "NEEDS_USERNAME", "PROTOCOL", "PUBLIC_SERVICE_PATH",
  "new_signing_key", "signing_public_key",
  "canonical", "peer_base_url", "peer_service_url", "post_signed_envelope",
  "read_envelope", "sign",
  "valid_host", "valid_id",
  "validate_attachment", "validate_attachment_envelope_size",
  "validate_gif_bytes",
  "validate_reply_to", "validate_text_or_attachment",
  "wire_json_size",
  "verify",
]
