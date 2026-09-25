"""Canonical ``common/0`` wire validation and peer-key verification.

This module is deliberately independent of the owner database and identity
keys.  Every personal Social service and the central community host use these
exact canonical bytes and validation rules, so there is one federation
implementation.
"""

from __future__ import annotations

import base64
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
from service_io import atomic_write, read_capped_body

PROTOCOL = "common/0"
PUBLIC_SERVICE_PATH = "/api/app-services/social"
# The one shared board and directory host every Möbius browses.
COMMUNITY_HOST = "www.mobius.you"
# Messages match Slack's 40,000-character cap. Board posts stay short because a
# feed page carries many of them through the bounded community-host transport.
MAX_MESSAGE_TEXT_CHARS = 40_000
MAX_POST_TEXT_CHARS = 4000
MAX_REPLY_TEXT_CHARS = 1000
MAX_NAME_CHARS = 80
MAX_BIO_CHARS = 400
MAX_ENVELOPE_BYTES = 32_768
MAX_ATTACHMENT_ENVELOPE_BYTES = 2 * 1024 * 1024
MAX_ATTACHMENT_BYTES = 1024 * 1024
MAX_ATTACHMENT_DIMENSION = 8192
# One board post may carry a small gallery. The whole envelope still obeys
# MAX_ATTACHMENT_ENVELOPE_BYTES, so callers keep the images small enough to fit.
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
}
_CONTENT_ENVELOPE_TYPES = {
  "message", "group_post", "group_message", "board_post",
}


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


def validate_attachment(value: Any) -> tuple[dict, bytes] | None:
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
  max_b64_chars = 4 * ((MAX_ATTACHMENT_BYTES + 2) // 3)
  if len(data_b64) > max_b64_chars:
    raise HTTPException(status_code=413, detail="Attachment is too large.")
  try:
    data = base64.b64decode(data_b64, validate=True)
  except Exception as exc:
    raise HTTPException(status_code=400, detail="Attachment data is invalid.") from exc
  if len(data) > MAX_ATTACHMENT_BYTES:
    raise HTTPException(status_code=413, detail="Attachment is too large.")
  if not data:
    raise HTTPException(status_code=400, detail="Attachment data is empty.")
  return value, data


def validate_attachments(
  value: Any, *, max_count: int = MAX_BOARD_ATTACHMENTS,
) -> list[tuple[dict, bytes]] | None:
  """Validate the multi-image shape: a bounded list of single attachments.

  Each item is validated exactly like a lone attachment; the surrounding
  envelope cap (MAX_ATTACHMENT_ENVELOPE_BYTES) bounds the combined size.
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
    one = validate_attachment(item)
    if one is None:
      raise HTTPException(status_code=400, detail="Attachments are invalid.")
    decoded.append(one)
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


async def read_envelope(request: Request) -> dict:
  """Read one bounded envelope without letting Starlette buffer it first."""
  body = await read_capped_body(request, MAX_ATTACHMENT_ENVELOPE_BYTES)
  try:
    envelope = json.loads(body)
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
  "CLOCK_SKEW_S", "MAX_ATTACHMENT_BYTES", "MAX_ATTACHMENT_DIMENSION",
  "MAX_ATTACHMENT_ENVELOPE_BYTES", "MAX_AVATAR_BYTES", "MAX_BIO_CHARS",
  "MAX_BOARD_ATTACHMENTS", "validate_attachments",
  "MAX_ENVELOPE_BYTES", "MAX_NAME_CHARS", "MAX_REPLY_TEXT_CHARS",
  "MAX_MESSAGE_TEXT_CHARS", "MAX_POST_TEXT_CHARS",
  "OUTBOUND_TIMEOUT_S", "SIGNED_WRITE_TIMEOUT_S",
  "COMMUNITY_HOST", "PROTOCOL", "PUBLIC_SERVICE_PATH",
  "new_signing_key", "signing_public_key",
  "canonical", "peer_base_url", "peer_service_url", "post_signed_envelope",
  "read_envelope", "sign",
  "valid_host", "valid_id",
  "validate_attachment", "validate_attachment_envelope_size",
  "validate_reply_to", "validate_text_or_attachment",
  "wire_json_size",
  "verify",
]
