#!/usr/bin/env python3
"""JSON-v1 adapter for Social's app-owned ASGI service."""

from __future__ import annotations

import asyncio
import base64
import json
import sys
from urllib.parse import quote, urlencode

import httpx
from fastapi import FastAPI

from service_runtime import migrate_legacy_state, reconcile_badge, reset_actor, set_actor
from social_groups import router as groups_router
from social_objects import router as objects_router
from social_routes import router as social_router


app = FastAPI()
app.include_router(social_router)
app.include_router(groups_router)
app.include_router(objects_router)

# Möbius may run everything above once and fork each request from it, which
# removes ~0.9 s of imports per request. Module setup therefore reads only
# per-installation values (APP_ID, APP_SLUG, APP_STORAGE_DIR) and starts no
# threads; APP_TOKEN and the request are read inside dispatch().
MOBIUS_PRELOAD = True


async def dispatch(request: dict) -> dict:
  migrate_legacy_state()
  query = request.get("query") if isinstance(request.get("query"), dict) else {}
  # The platform already decoded the path when selecting its reviewed cap.
  # Preserve that literal identity through httpx's URL/ASGI boundary rather
  # than interpreting another escape, query or fragment as a different route.
  suffix = quote("/" + str(request.get("path") or "").lstrip("/"), safe="/")
  if query:
    suffix += "?" + urlencode(query, doseq=True)
  headers = request.get("headers") if isinstance(request.get("headers"), dict) else {}
  token = set_actor(request.get("actor") or {})
  try:
    async with httpx.AsyncClient(
      transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
      base_url="http://social.service",
    ) as client:
      response = await client.request(
        str(request.get("method") or "GET"), suffix,
        headers=headers,
        json=request.get("body") if request.get("body") is not None else None,
      )
  finally:
    reset_actor(token)
  await reconcile_badge()
  media_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
  forwarded = {
    name: value for name, value in response.headers.items()
    if name.lower() in {"cache-control", "etag", "last-modified"}
  }
  if media_type == "application/json" or media_type.endswith("+json"):
    try:
      body = response.json()
    except ValueError:
      body = {"detail": "Social returned invalid JSON."}
    return {"status": response.status_code, "body": body, "headers": forwarded}
  return {
    "status": response.status_code,
    "body_base64": base64.b64encode(response.content).decode(),
    "media_type": media_type or "application/octet-stream",
    "headers": forwarded,
  }


if __name__ == "__main__":
  try:
    print(json.dumps(asyncio.run(dispatch(json.load(sys.stdin))), separators=(",", ":")))
  except Exception as exc:
    print(f"Social service failed: {exc}", file=sys.stderr)
    raise SystemExit(1)
