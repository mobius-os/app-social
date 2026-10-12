"""Process context and platform adapters for Social's reviewed service."""

from __future__ import annotations

import asyncio
import fcntl
import json
import logging
import os
import shutil
import time
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote

import httpx
from fastapi import HTTPException


STORAGE = Path(os.environ["APP_STORAGE_DIR"])
SERVER_ROOT = STORAGE / "server"
LEGACY_ROOT = STORAGE.parents[1] / "common"
APP = SimpleNamespace(id=int(os.environ["APP_ID"]), slug=os.environ["APP_SLUG"])
_actor: ContextVar[dict] = ContextVar("social_actor", default={"scope": "public"})
PLATFORM_TIMEOUT_SECONDS = 5


@dataclass(frozen=True)
class Principal:
  scope: str
  app_id: int | None
  app_slug: str | None
  delegated: bool = False


def set_actor(actor: dict):
  return _actor.set(actor if isinstance(actor, dict) else {"scope": "public"})


def reset_actor(token) -> None:
  _actor.reset(token)


def get_principal() -> Principal:
  actor = _actor.get()
  return Principal(
    scope=str(actor.get("scope") or "public"),
    app_id=actor.get("app_id") if isinstance(actor.get("app_id"), int) else None,
    app_slug=actor.get("app_slug") if isinstance(actor.get("app_slug"), str) else None,
    delegated=actor.get("delegated") is True,
  )


def get_db():
  return None


@asynccontextmanager
async def app_storage_lock(_app_id: int):
  """Serialize app-owned state changes across private and public processes.

  Möbius deliberately runs private requests and public federation callbacks in
  separate execution lanes so an outbound request cannot deadlock the callback
  that verifies it.  Those lanes may still update the same Social records, so
  the service owns this short, filesystem-backed transaction boundary.  Every
  current caller holds it only for local reads and atomic writes—never across a
  peer or platform request.
  """
  STORAGE.mkdir(parents=True, exist_ok=True)
  with (STORAGE / ".state.lock").open("a+b") as handle:
    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
    try:
      yield
    finally:
      fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


fs_locks = SimpleNamespace(app_storage_lock=app_storage_lock)


def require_nondelegated_owner_control(principal: Principal) -> None:
  if principal.delegated:
    raise HTTPException(403, "Delegated agents cannot perform this Social action.")


def get_settings():
  return SimpleNamespace(
    data_dir=str(SERVER_ROOT),
    domain=os.environ["INSTANCE_DOMAIN"],
    api_base_url=os.environ["API_BASE_URL"].rstrip("/"),
    frontend_origin=os.environ["INSTANCE_ORIGIN"].rstrip("/"),
  )


def migrate_legacy_state() -> None:
  """Move the old platform-owned Social tree into this app exactly once."""
  target = SERVER_ROOT / "common"
  STORAGE.mkdir(parents=True, exist_ok=True)
  with (STORAGE / ".service-migration.lock").open("a+b") as handle:
    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
    if target.exists() or not LEGACY_ROOT.exists():
      return
    SERVER_ROOT.mkdir(parents=True, exist_ok=True)
    try:
      os.replace(LEGACY_ROOT, target)
    except OSError:
      staged = SERVER_ROOT / ".common-migration"
      shutil.rmtree(staged, ignore_errors=True)
      shutil.copytree(LEGACY_ROOT, staged)
      os.replace(staged, target)


async def platform_request(
  method: str, path: str, *, json_body=None,
) -> httpx.Response:
  headers = {
    "Authorization": f"Bearer {os.environ['APP_TOKEN']}",
    "Accept": "application/json",
  }
  async with httpx.AsyncClient(
    timeout=PLATFORM_TIMEOUT_SECONDS, follow_redirects=False,
  ) as client:
    return await client.request(
      method, get_settings().api_base_url + path, headers=headers, json=json_body,
    )


async def owner_profile() -> dict | None:
  response = await platform_request("GET", "/api/identity")
  if response.status_code == 409:
    return None
  if response.status_code >= 400:
    raise HTTPException(502, "Möbius identity could not be reached.")
  payload = response.json()
  profile = payload.get("profile") if isinstance(payload, dict) else None
  return profile if isinstance(profile, dict) else None


# Requests are forked from a preloaded process, so an in-memory cache would die
# with each request. The installed-app list (~43 KB, p50 ~300 ms) changes only
# on install/uninstall, while /me and every public /actor probe need two small
# facts from it; keep just those facts on disk for a short freshness window.
APP_DIRECTORY_CACHE_PATH = SERVER_ROOT / "cache" / "app-directory.json"
APP_DIRECTORY_CACHE_TTL_SECONDS = 600


def _published_apps(apps: list) -> list[dict]:
  public_apps = []
  for app in sorted(
    (item for item in apps if isinstance(item, dict)),
    key=lambda item: item.get("id") if isinstance(item.get("id"), int) else 0,
  ):
    distribution = app.get("distribution_manifest")
    name = app.get("name")
    description = app.get("description")
    if (
      not isinstance(distribution, dict)
      or distribution.get("kind") != "published"
      or not isinstance(name, str)
      or not name.strip()
    ):
      continue
    public_apps.append({
      "name": name.strip()[:80],
      "description": description[:140] if isinstance(description, str) else "",
    })
    if len(public_apps) == 8:
      break
  return public_apps


def _read_app_directory_cache() -> dict | None:
  try:
    cached = json.loads(APP_DIRECTORY_CACHE_PATH.read_text())
  except (OSError, ValueError):
    return None
  if not isinstance(cached, dict):
    return None
  fetched_at = cached.get("fetched_at")
  if not isinstance(fetched_at, (int, float)):
    return None
  if not 0 <= time.time() - fetched_at < APP_DIRECTORY_CACHE_TTL_SECONDS:
    return None
  # A missing Identity app is not cached: the join flow must notice an install
  # immediately rather than after the freshness window.
  if not isinstance(cached.get("identity_app_id"), int):
    return None
  return cached


async def app_directory_facts() -> dict | None:
  """Return ``{identity_app_id, public_apps}`` from a fresh cache or the platform.

  ``None`` means the platform list was unreachable; callers keep their prior
  degraded behavior for that case. Failures are not cached.
  """
  cached = _read_app_directory_cache()
  if cached is not None:
    return cached
  from service_io import atomic_write
  try:
    response = await platform_request("GET", "/api/apps/")
  except httpx.HTTPError:
    return None
  if response.status_code >= 400:
    return None
  try:
    apps = response.json()
  except ValueError:
    return None
  if not isinstance(apps, list):
    return None
  identity = next(
    (app for app in apps if isinstance(app, dict) and app.get("slug") == "identity"),
    None,
  )
  identity_id = identity.get("id") if isinstance(identity, dict) else None
  facts = {
    "fetched_at": time.time(),
    "identity_app_id": identity_id if isinstance(identity_id, int) else None,
    "public_apps": _published_apps(apps),
  }
  try:
    atomic_write(APP_DIRECTORY_CACHE_PATH, json.dumps(facts))
  except OSError:
    pass
  return facts


async def public_actor_metadata() -> dict:
  """Read public profile facts from the platform records that own them."""
  identity_response, directory = await asyncio.gather(
    platform_request("GET", "/api/identity"),
    app_directory_facts(),
    return_exceptions=True,
  )
  member_since = None
  if isinstance(identity_response, httpx.Response) and identity_response.status_code < 400:
    try:
      identity = identity_response.json()
    except ValueError:
      identity = None
    value = identity.get("member_since") if isinstance(identity, dict) else None
    if isinstance(value, str) and len(value) <= 64:
      member_since = value
  public_apps = directory.get("public_apps") if isinstance(directory, dict) else None
  return {
    "member_since": member_since,
    "apps": public_apps if isinstance(public_apps, list) else [],
  }


async def identity_app_id() -> int | None:
  directory = await app_directory_facts()
  value = directory.get("identity_app_id") if directory else None
  return value if isinstance(value, int) else None


async def resolve_handle_hosts(handle: str) -> list[str] | None:
  response = await platform_request(
    "GET", "/api/identity/handles/" + quote(handle, safe=""),
  )
  if response.status_code == 404:
    raise HTTPException(404, "No one has claimed that mobius.you handle.")
  if response.status_code >= 400:
    return None
  payload = response.json()
  if not isinstance(payload, dict) or payload.get("linked") is not True:
    return None
  hosts = payload.get("hosts")
  return hosts if isinstance(hosts, list) else None


async def notify(title: str, body: str, intent: str) -> bool:
  """Best-effort push; tapping it opens ``intent`` (dm:<host>, group:<gid>, board).

  The intent is also the tag, so each conversation keeps one notification.
  """
  try:
    response = await platform_request("POST", "/api/notifications/send", json_body={
      "title": title,
      "body": body,
      "source_type": "app",
      "source_id": str(APP.id),
      "target": f"/shell/?app={APP.id}&intent={quote(intent, safe=':')}",
      "tag": intent,
    })
    response.raise_for_status()
    return True
  except Exception as exc:
    logging.getLogger("social").warning("Notification not sent: %s", exc)
    return False


# ── unread badge ─────────────────────────────────────────────────────────────
# Social reports its Messages unread total as its Möbius sidebar badge. The
# badge is a projection Social reconciles, persisted in two small files:
#
#   state/badge.json      {"revision", "count"}  what the badge should show
#   state/badge-ack.json  {"revision"}           the last report Möbius accepted
#                         {"unsupported_at"}     when an older Möbius lacked badges
#
# ``record_badge`` runs inside every storage transaction (``_bump_version``,
# under ``app_storage_lock``) and captures the count together with that
# transaction's version, so the revision is Social's own state order, never a
# clock. ``reconcile_badge`` runs after every service request, outside the
# lock: when the acknowledged revision is behind, it reports and acknowledges
# only on success. A failed report is therefore retried by the next request of
# any kind, and an installation that already holds unread messages reports
# them on its first request.

BADGE_PATH = ("state", "badge.json")
BADGE_ACK_PATH = ("state", "badge-ack.json")
# An older Möbius without badges is asked again at most this often, so the
# badge appears soon after the platform is upgraded without a PUT per request.
BADGE_UNSUPPORTED_RETRY_SECONDS = 3600
# The same statuses ``api.requestStatus`` hides; anything else is accepted.
_HIDDEN_REQUEST_STATUSES = frozenset({"pending", "declined", "blocked"})


def _counts_toward_badge(meta: dict) -> bool:
  return meta.get("request_status") not in _HIDDEN_REQUEST_STATUSES


def unread_total(storage: Path) -> int:
  """Unread messages across accepted conversations and groups.

  Matches the Messages tab badge. A group the owner deleted is hidden there,
  and deleting it already zeroes its unread count.

  This rescans every conversation and group on each storage write, under the
  storage lock: about 48 ms at 2,500 threads. If histories grow far beyond
  that, keep a running total where ``unread`` is changed instead.
  """
  total = 0
  for kind in ("conversations", "groups"):
    for meta_path in (storage / kind).glob("*/meta.json"):
      try:
        meta = json.loads(meta_path.read_text())
      except (OSError, ValueError):
        continue
      if isinstance(meta, dict) and _counts_toward_badge(meta):
        total += max(0, int(meta.get("unread") or 0))
  return total


def _read_json(path: Path) -> dict | None:
  try:
    value = json.loads(path.read_text())
  except (OSError, ValueError):
    return None
  return value if isinstance(value, dict) else None


def _storage_version(storage: Path) -> int:
  state = _read_json(storage / "state" / "version.json") or {}
  return int(state.get("v") or 0)


def record_badge(storage: Path, version: int) -> None:
  """Capture the badge for a committed storage version (caller holds the lock).

  Only a changed count advances the badge revision, so writes that do not
  touch unread state never cause a report.
  """
  from service_io import atomic_write

  count = unread_total(storage)
  current = _read_json(storage.joinpath(*BADGE_PATH))
  if current is not None and current.get("count") == count:
    return
  atomic_write(storage.joinpath(*BADGE_PATH),
               json.dumps({"revision": version, "count": count}))


async def _badge_snapshot(storage: Path) -> tuple[dict, dict]:
  """The badge to show and the acknowledgement record, bootstrapping once."""
  badge = _read_json(storage.joinpath(*BADGE_PATH))
  if badge is None:
    async with app_storage_lock(APP.id):
      badge = _read_json(storage.joinpath(*BADGE_PATH))
      if badge is None:
        record_badge(storage, _storage_version(storage))
        badge = _read_json(storage.joinpath(*BADGE_PATH)) or {}
  return badge, _read_json(storage.joinpath(*BADGE_ACK_PATH)) or {}


def _acked_revision(ack: dict) -> int:
  return int(ack.get("revision") if ack.get("revision") is not None else -1)


async def _acknowledge(storage: Path, revision: int) -> None:
  from service_io import atomic_write

  async with app_storage_lock(APP.id):
    ack = _read_json(storage.joinpath(*BADGE_ACK_PATH)) or {}
    if _acked_revision(ack) < revision or "unsupported_at" in ack:
      atomic_write(storage.joinpath(*BADGE_ACK_PATH),
                   json.dumps({"revision": max(revision, _acked_revision(ack))}))


async def _mark_unsupported(storage: Path) -> None:
  """Remember that this Möbius lacks badges, without acknowledging anything."""
  from service_io import atomic_write

  async with app_storage_lock(APP.id):
    ack = _read_json(storage.joinpath(*BADGE_ACK_PATH)) or {}
    atomic_write(storage.joinpath(*BADGE_ACK_PATH),
                 json.dumps({**ack, "unsupported_at": time.time()}))


async def reconcile_badge() -> None:
  """Bring Möbius's badge up to Social's recorded one; never fail the request."""
  storage = Path(os.environ["APP_STORAGE_DIR"])
  try:
    badge, ack = await _badge_snapshot(storage)
    revision, count = int(badge.get("revision") or 0), int(badge.get("count") or 0)
    if _acked_revision(ack) >= revision:
      return
    unsupported_at = ack.get("unsupported_at")
    if (
      unsupported_at is not None
      and time.time() - float(unsupported_at) < BADGE_UNSUPPORTED_RETRY_SECONDS
    ):
      return
    path = f"/api/apps/{APP.id}/badge"
    response = await platform_request(
      "PUT", path, json_body={"count": count, "revision": revision},
    )
    if response.status_code in (404, 405):
      # This Möbius predates app badges. Leave the badge unacknowledged so it
      # is reported once the platform is upgraded, but only ask again hourly.
      await _mark_unsupported(storage)
      return
    response.raise_for_status()
    stored = response.json()
    stored_revision = stored.get("revision")
    if (
      not stored.get("applied") and stored_revision is not None
      and stored_revision > _storage_version(storage)
    ):
      # Möbius holds a revision Social's storage has never reached: Social's
      # state went backwards (restored from a backup). Reset the ordering with
      # the current badge; an unrevisioned report always applies. This relies
      # on the storage version only moving forward in normal operation; a data
      # wipe resets it too, but the wipe also clears Möbius's badge row.
      current, _ = await _badge_snapshot(storage)
      response = await platform_request(
        "PUT", path, json_body={"count": int(current.get("count") or 0)},
      )
      response.raise_for_status()
    # Otherwise it applied, or Social's own newer report already landed.
    await _acknowledge(storage, revision)
  except Exception as exc:
    # Unacknowledged: the next request reports again.
    logging.getLogger("social").warning("Unread badge not updated: %s", exc)
