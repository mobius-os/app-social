"""Process context and platform adapters for Social's reviewed service."""

from __future__ import annotations

import asyncio
import fcntl
import json
import logging
import os
import shutil
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


async def public_actor_metadata() -> dict:
  """Read public profile facts from the platform records that own them."""
  identity_response, apps_response = await asyncio.gather(
    platform_request("GET", "/api/identity"),
    platform_request("GET", "/api/apps/"),
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

  public_apps = []
  if isinstance(apps_response, httpx.Response) and apps_response.status_code < 400:
    try:
      apps = apps_response.json()
    except ValueError:
      apps = None
    if isinstance(apps, list):
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
  return {"member_since": member_since, "apps": public_apps}


async def identity_app_id() -> int | None:
  response = await platform_request("GET", "/api/apps/")
  if response.status_code >= 400:
    return None
  payload = response.json()
  if not isinstance(payload, list):
    return None
  match = next((app for app in payload if app.get("slug") == "identity"), None)
  return match.get("id") if isinstance(match, dict) else None


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


async def notify(title: str, body: str, intent: str) -> None:
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
  except Exception as exc:
    logging.getLogger("social").warning("Notification not sent: %s", exc)
