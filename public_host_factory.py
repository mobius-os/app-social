"""Owner-independent public directory and board host from the Social app."""

from __future__ import annotations

import re
import time
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from common_protocol import ActorVerifier
from common_public import CommonPublicStore, create_public_router

SERVICE_NAME = "mobius-social"
_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
WRITE_LIMIT = 120
WRITE_WINDOW_SECONDS = 60
WRITE_PEER_LIMIT = 4096


class WriteRateLimiter:
  """Bound write admission per proxy-resolved peer without unbounded keys."""

  def __init__(
    self, *, limit: int = WRITE_LIMIT,
    window_seconds: int = WRITE_WINDOW_SECONDS,
    peer_limit: int = WRITE_PEER_LIMIT,
  ):
    self.limit = limit
    self.window_seconds = window_seconds
    self.peer_limit = peer_limit
    self.windows: dict[str, deque[float]] = {}

  def allow(self, peer: str, now: float) -> bool:
    cutoff = now - self.window_seconds
    window = self.windows.get(peer)
    if window is None:
      if len(self.windows) >= self.peer_limit:
        stale = [
          key for key, values in self.windows.items()
          if not values or values[-1] < cutoff
        ]
        for key in stale:
          self.windows.pop(key, None)
      if len(self.windows) >= self.peer_limit:
        return False
      window = self.windows[peer] = deque()
    while window and window[0] < cutoff:
      window.popleft()
    if len(window) >= self.limit:
      return False
    window.append(now)
    return True


def _baked_source_sha() -> str:
  path = Path(__file__).with_name("SOCIAL_SOURCE_SHA")
  value = path.read_text(encoding="ascii").strip()
  if not _SHA_RE.fullmatch(value):
    raise RuntimeError("SOCIAL_SOURCE_SHA is not a baked 40-character Git SHA")
  return value


def create_app(data_dir: str | Path, *, source_sha: str) -> FastAPI:
  configured = Path(data_dir)
  if not configured.is_absolute() or not _SHA_RE.fullmatch(source_sha):
    raise RuntimeError("Public Social host needs an absolute data path and source SHA")
  store = CommonPublicStore(configured)
  verifier = ActorVerifier(configured)
  write_limiter = WriteRateLimiter()

  @asynccontextmanager
  async def lifespan(application: FastAPI):
    store.initialize()
    application.state.initialized = True
    try:
      yield
    finally:
      application.state.initialized = False

  application = FastAPI(
    title="Möbius Social public host",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
  )
  application.state.initialized = False
  application.state.social_store = store
  application.state.actor_verifier = verifier

  @application.middleware("http")
  async def bounded_writes(request: Request, call_next):
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
      peer = request.client.host if request.client else "unknown"
      now = time.monotonic()
      if not write_limiter.allow(peer, now):
        return JSONResponse({"detail": "Rate limit exceeded"}, status_code=429)
    return await call_next(request)

  @application.get("/healthz")
  def healthz():
    if not application.state.initialized:
      raise HTTPException(status_code=503, detail="Service is initializing.")
    return {"status": "ok"}

  @application.get("/version")
  def version():
    return {"service": SERVICE_NAME, "source_sha": source_sha}

  current, _ = create_public_router(
    store, verifier, prefix="/api/common",
  )
  application.include_router(current)
  return application
