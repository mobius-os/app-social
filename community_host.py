"""Standalone ASGI entrypoint for Social's shared public community service.

The personal Social service and this deployment both import the same protocol
and public-store modules.  This file only supplies process lifecycle, health,
and immutable build provenance for the central host.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException

from common_protocol import (
  COMMUNITY_HOST, PROTOCOL, ActorVerifier, new_signing_key, signing_public_key,
)
from common_public import (
  CommonPublicStore, create_public_router, refresh_member_profile, send_board_activity,
)
from service_io import atomic_write


SERVICE_NAME = "mobius-social"
# Member handles and avatar copies: a few refreshes at a time, a bounded sweep
# for members checked more than a day ago (including members who registered
# before copies existed, or before they chose a handle).
AVATAR_REFRESH_CONCURRENCY = 4
AVATAR_SWEEP_FIRST_DELAY_S = 60
AVATAR_SWEEP_INTERVAL_S = 15 * 60
AVATAR_SWEEP_BATCH = 25
DEVELOPMENT_REVISION = "development"
_SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def _hosts(name: str) -> list[str]:
  raw = os.environ.get(name, "")
  return [part.strip().lower() for part in raw.split(",") if part.strip()]


def community_roles() -> dict[str, str]:
  """Owner and admin hosts from the deployment settings; others are members.

  COMMUNITY_OWNER_HOSTS names the one owner host and COMMUNITY_ADMIN_HOSTS
  lists admin hosts, comma-separated. A host listed in both is the owner. A
  community has exactly one owner, so an owner setting naming several hosts
  is refused: nobody is seeded as owner and a warning is logged.
  """
  roles = {host: "admin" for host in _hosts("COMMUNITY_ADMIN_HOSTS")}
  owners = _hosts("COMMUNITY_OWNER_HOSTS")
  if len(set(owners)) > 1:
    logging.getLogger("social").warning(
      "COMMUNITY_OWNER_HOSTS names %d hosts; a community has one owner, so none was set.",
      len(set(owners)),
    )
  elif owners:
    roles[owners[0]] = "owner"
  return roles


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

  async def on_activity(kind, author_host, actor_host, actor_handle, post_id,
                        *, reply_id=None, emoji=None, activity_id=None):
    # This host stores the board, so it is the authority that tells a post's
    # author about new activity. The notice never delays the like or reply.
    relay = asyncio.create_task(send_board_activity(
      application.state.signing_key, COMMUNITY_HOST, kind=kind,
      author_host=author_host, actor_host=actor_host,
      actor_handle=actor_handle, post_id=post_id,
      reply_id=reply_id, emoji=emoji, activity_id=activity_id,
    ))
    relays.add(relay)
    relay.add_done_callback(relays.discard)

  refreshing: set[str] = set()
  refresh_slots = asyncio.Semaphore(AVATAR_REFRESH_CONCURRENCY)

  async def refresh_avatar(member_host):
    try:
      async with refresh_slots:
        await refresh_member_profile(store, verifier, member_host)
    finally:
      refreshing.discard(member_host)

  def schedule_avatar_refresh(member_host):
    # One refresh per member at a time; a burst of registrations coalesces.
    if member_host in refreshing:
      return
    refreshing.add(member_host)
    refresh = asyncio.create_task(refresh_avatar(member_host))
    relays.add(refresh)
    refresh.add_done_callback(relays.discard)

  async def sweep_stale_avatars():
    await asyncio.sleep(AVATAR_SWEEP_FIRST_DELAY_S)
    while True:
      for member_host in await asyncio.to_thread(
        store.members_due_for_avatar_check, AVATAR_SWEEP_BATCH,
      ):
        schedule_avatar_refresh(member_host)
      await asyncio.sleep(AVATAR_SWEEP_INTERVAL_S)

  async def on_register(member_host):
    # Registration answers at once; the handle check and avatar copy follow in
    # the background.
    schedule_avatar_refresh(member_host)

  public_router, _ = create_public_router(
    store, verifier, prefix="/api/common", on_activity=on_activity,
    on_register=on_register,
    # The shared KLIPY key is a private deployment setting, read per request
    # so replacing it needs no rebuild of this image's source.
    gif_key=lambda: os.environ.get("KLIPY_APP_KEY", "").strip() or None,
    # Community owner and admins are deployment settings (member hosts) who
    # may moderate the board. Read per request, like the GIF key.
    community_roles=community_roles,
  )

  @asynccontextmanager
  async def lifespan(application: FastAPI):
    store.initialize()
    application.state.signing_key = load_signing_key(configured)
    application.state.initialized = True
    sweep = asyncio.create_task(sweep_stale_avatars())
    try:
      yield
    finally:
      application.state.initialized = False
      sweep.cancel()
      with contextlib.suppress(asyncio.CancelledError):
        await sweep

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
