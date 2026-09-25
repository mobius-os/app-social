"""Standalone ASGI entrypoint for Social's shared public community service.

The personal Social service and this deployment both import the same protocol
and public-store modules.  This file only supplies process lifecycle, health,
and immutable build provenance for the central host.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException

from common_protocol import (
  COMMUNITY_HOST, PROTOCOL, ActorVerifier, new_signing_key, signing_public_key,
)
from common_public import CommonPublicStore, create_public_router, send_board_activity
from service_io import atomic_write


SERVICE_NAME = "mobius-social"
DEVELOPMENT_REVISION = "development"
_SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def source_revision() -> str:
  """Return the baked Git revision, allowing one explicit local-dev value."""
  revision = os.environ.get("SOCIAL_SOURCE_SHA", DEVELOPMENT_REVISION).strip()
  if revision != DEVELOPMENT_REVISION and not _SHA_RE.fullmatch(revision):
    raise RuntimeError("SOCIAL_SOURCE_SHA must be a 40-character lowercase Git SHA")
  return revision


def load_signing_key(data_dir: Path) -> str:
  """Load the host's Ed25519 key, creating it once on the data volume."""
  path = data_dir / "common" / "host_key.json"
  if not path.is_file():
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(path, json.dumps({"private_key_b64": new_signing_key()}))
    path.chmod(0o600)
  return json.loads(path.read_text())["private_key_b64"]


def create_app(data_dir: str | Path | None = None) -> FastAPI:
  configured = Path(
    data_dir if data_dir is not None else os.environ.get("SOCIAL_DATA_DIR", "/data")
  )
  if not configured.is_absolute():
    raise RuntimeError("SOCIAL_DATA_DIR must be an absolute path")

  revision = source_revision()
  store = CommonPublicStore(configured)
  verifier = ActorVerifier(configured)
  relays: set[asyncio.Task] = set()

  async def on_activity(kind, author_host, actor_host, actor_handle, post_id):
    # This host stores the board, so it is the authority that tells a post's
    # author about new activity. The notice never delays the like or reply.
    relay = asyncio.create_task(send_board_activity(
      application.state.signing_key, COMMUNITY_HOST, kind=kind,
      author_host=author_host, actor_host=actor_host,
      actor_handle=actor_handle, post_id=post_id,
    ))
    relays.add(relay)
    relay.add_done_callback(relays.discard)

  public_router, _ = create_public_router(
    store, verifier, prefix="/api/common", on_activity=on_activity,
  )

  @asynccontextmanager
  async def lifespan(application: FastAPI):
    store.initialize()
    application.state.signing_key = load_signing_key(configured)
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

  @application.get("/api/common/actor")
  def actor():
    """The key recipients use to verify this host's signed activity notices."""
    return {
      "protocol": PROTOCOL,
      "host": COMMUNITY_HOST,
      "public_key": {
        "alg": "ed25519",
        "key_b64": signing_public_key(application.state.signing_key),
      },
    }

  @application.get("/version")
  def version():
    return {"service": SERVICE_NAME, "source_sha": revision}

  application.include_router(public_router)
  return application


app = create_app()
