"""Small filesystem and request primitives owned by Social's service."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from fastapi import HTTPException, Request


def atomic_write(path: Path, content: str | bytes) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  raw = content.encode() if isinstance(content, str) else content
  fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
  try:
    with os.fdopen(fd, "wb") as handle:
      handle.write(raw)
      handle.flush()
      os.fsync(handle.fileno())
    os.replace(temporary, path)
  finally:
    try:
      os.unlink(temporary)
    except FileNotFoundError:
      pass


async def read_capped_body(
  request: Request, limit: int, too_large: str = "Request body is too large.",
) -> bytes:
  body = bytearray()
  async for chunk in request.stream():
    body.extend(chunk)
    if len(body) > limit:
      raise HTTPException(413, too_large)
  return bytes(body)
