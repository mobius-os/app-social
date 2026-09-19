"""Standalone ASGI entrypoint for Social's shared public community service.

The personal Social service and this deployment both import the same protocol
and public-store modules.  This file only supplies process lifecycle, health,
and immutable build provenance for the central host.
"""

from __future__ import annotations

import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException

from common_protocol import ActorVerifier
from common_public import CommonPublicStore, create_public_router


SERVICE_NAME = "mobius-social"
DEVELOPMENT_REVISION = "development"
_SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def source_revision() -> str:
  """Return the baked Git revision, allowing one explicit local-dev value."""
  revision = os.environ.get("SOCIAL_SOURCE_SHA", DEVELOPMENT_REVISION).strip()
  if revision != DEVELOPMENT_REVISION and not _SHA_RE.fullmatch(revision):
    raise RuntimeError("SOCIAL_SOURCE_SHA must be a 40-character lowercase Git SHA")
  return revision


def create_app(data_dir: str | Path | None = None) -> FastAPI:
  configured = Path(
    data_dir if data_dir is not None else os.environ.get("SOCIAL_DATA_DIR", "/data")
  )
  if not configured.is_absolute():
    raise RuntimeError("SOCIAL_DATA_DIR must be an absolute path")

  revision = source_revision()
  store = CommonPublicStore(configured)
  verifier = ActorVerifier(configured)
  public_router, _ = create_public_router(store, verifier, prefix="/api/common")

  @asynccontextmanager
  async def lifespan(application: FastAPI):
    store.initialize()
    application.state.initialized = True
    try:
      yield
    finally:
      application.state.initialized = False

  application = FastAPI(
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
  )
  application.state.initialized = False

  @application.get("/healthz")
  def healthz():
    if not application.state.initialized:
      raise HTTPException(status_code=503, detail="Service is initializing.")
    return {"status": "ok"}

  @application.get("/version")
  def version():
    return {"service": SERVICE_NAME, "source_sha": revision}

  application.include_router(public_router)
  return application


app = create_app()
