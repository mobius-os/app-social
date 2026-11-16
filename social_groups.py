"""Social federation — group chats (protocol common/0, group extension).

A group lives on its creator's instance, the **group host**. The host owns the
authoritative membership record; members keep their own copy of every message,
exactly like 1:1 conversations. Twelve signed envelope types extend the
protocol, all delivered to `/api/app-services/social/groups/inbox`:

- `group_added`  host → invitee   invitation; carries group metadata
- `group_accept` invitee → host   owner explicitly joins the group
- `group_decline` invitee → host  owner dismisses the invitation
- `group_post`   member → host    a member's message for the group
- `group_message` host → member   the host's fan-out relay of a post
- `group_deleted` host → member   the group is closed; retain local history
- `group_react`   member → host    a member turns a reaction on or off
- `group_reaction` host → member   the host's relay of a reaction
- `group_manage`  admin → host     an admin asks the host to change the group
- `group_removed` host → member    the member was removed; retain local history
- `group_edit`    member → host    the author replaces their message's text
- `group_edited`  host → member    the host's relay of an edit, with the signed `group_edit`

A group may have a small picture (`group_icon`, a 128px static image of at most
`MAX_GROUP_ICON_BYTES`). The host keeps it in its record and sends it inside
every `group_added` roster refresh, so it fits the control-envelope budget and
older members simply ignore the field. A refresh from an updated host always
carries the key (null when there is no picture); its absence means an older
host, and the member's saved picture is left alone.

Roles live only in the host's record. The creator (the host) can do every
management action; an admin may add, reinvite and remove ordinary members and
rename the group. Only the creator appoints admins or deletes the group. An
admin's request is a signed `group_manage` the host authorizes against its own
roster, so no member can grant itself authority. Roster refreshes carry each
member's role and a `roster_revision`, so a delayed refresh never undoes a
newer one.

Like `group_message`, a `group_reaction` carries the member-signed
`group_react` as `original`, so the host cannot forge someone's reaction.

A relayed `group_message` is signed by the *host* and carries the complete
author-signed `group_post` as `original`. Members verify both signatures, so
the host controls membership and fan-out without being able to forge another
member's authorship. Nothing about a group ever touches a third instance.

Owner surface (owner JWT or the Social app's scoped token):
  POST /api/services/social/groups                     create a group + invite members
  POST /api/services/social/groups/{gid}/send          send a message to the group
  POST /api/services/social/groups/{gid}/messages/{id}/retry  re-send a saved failed post
  POST /api/services/social/groups/{gid}/read          mark saved messages read
  POST /api/services/social/groups/{gid}/accept        accept + join a remote group
  POST /api/services/social/groups/{gid}/decline       decline a remote invitation
  POST /api/services/social/groups/{gid}/members       add a member (creator or admin)
  DELETE /api/services/social/groups/{gid}/members/{host}  remove a member (creator or admin)
  PATCH /api/services/social/groups/{gid}              rename the group (creator or admin)
  PUT /api/services/social/groups/{gid}/icon           set or clear the picture (creator or admin)
  POST /api/services/social/groups/{gid}/admins        appoint or demote an admin (creator)
  DELETE /api/services/social/groups/{gid}             close a group (creator only)

Host-side authoritative records live in `<data_dir>/common/groups/`; each
instance's own copy of group conversations lives in the Social app's per-app
storage under `groups/<gid>/`, where the app UI reads it.
"""

from __future__ import annotations

import asyncio
import base64
import fcntl
import hashlib
import json
import re
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from weakref import WeakValueDictionary

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from common_protocol import (
  MAX_ENVELOPE_BYTES,
  MAX_NAME_CHARS,
  post_signed_envelope as _post_signed_envelope,
  peer_service_url as _peer_service_url,
  read_envelope as _read_envelope,
  sign as _sign,
  valid_host as _valid_host,
  validate_attachment as _validate_attachment,
  validate_reply_to as _validate_reply_to,
  validate_text_or_attachment as _validate_text_or_attachment,
)
from service_runtime import (
  Principal, fs_locks, get_db, get_principal, notify,
  require_nondelegated_owner_control,
)
from social_routes import (
  _app_data_dir,
  _bump_version,
  _common_app,
  _common_dir,
  _fetch_actor,
  _load_identity,
  _message_preview,
  _own_host,
  _joined_for_federation,
  _require_member,
  _same_outgoing_intent,
  _verify_peer_envelope,
  _write_app_attachment,
)
from service_io import atomic_write
from common_public import image_thumbnail_bytes as _image_thumbnail_bytes
from message_history import begin_message_mutation, load_page, mirror_message
from message_edits import (
  apply_edit, begin_own_edit, edit_result, settle_own_edit, supports_message_edits, validate_edit,
)
from message_reactions import (
  apply_reaction, begin_own_update, own_update_result, reaction_line, settle_own_update,
  supports_message_reactions, validate_reaction,
)

router = APIRouter(prefix="/groups", tags=["common"])

MAX_GROUP_MEMBERS = 64
_GID_RE = re.compile(r"^[a-f0-9-]{8,64}$")
_REQUEST_STATES = {"pending", "accepted", "declined"}
_group_locks: WeakValueDictionary[str, asyncio.Lock] = WeakValueDictionary()


def _group_lock(gid: str) -> asyncio.Lock:
  # Group lifecycle is outermost; app-storage locks are acquired only inside it.
  lock = _group_locks.get(gid)
  if lock is None:
    lock = asyncio.Lock()
    _group_locks[gid] = lock
  return lock


@contextmanager
def _host_group_transaction(gid: str):
  """Serialize authoritative group RMW across Social service processes.

  This lock owns local file transitions only. Callers must release it before
  actor discovery, federation delivery, or notifications.
  """
  directory = _host_groups_dir() / ".locks"
  directory.mkdir(parents=True, exist_ok=True)
  with (directory / f"{gid}.lock").open("a+b") as handle:
    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
    try:
      yield
    finally:
      fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _validate_gid(gid: str) -> None:
  if not isinstance(gid, str) or not _GID_RE.fullmatch(gid):
    raise HTTPException(status_code=400, detail="Group id is invalid.")


def _require_open(group: dict) -> None:
  if group.get("deleted_at"):
    raise HTTPException(status_code=410, detail="This group has been deleted.")
  if group.get("removed_at"):
    raise HTTPException(status_code=410, detail="You're no longer a member of this group.")



# ── host-side authoritative records ─────────────────────────────────────────

def _host_groups_dir() -> Path:
  d = _common_dir() / "groups"
  d.mkdir(parents=True, exist_ok=True)
  return d


def _host_group_path(gid: str) -> Path:
  return _host_groups_dir() / f"{gid}.json"


def _load_host_group(gid: str) -> dict | None:
  path = _host_group_path(gid)
  return json.loads(path.read_text()) if path.is_file() else None


# ── member-side app-storage copies (what the UI reads) ──────────────────────

def _group_dir(app, gid: str) -> Path:
  return _app_data_dir(app) / "groups" / gid


def _load_group_meta(app, gid: str) -> dict | None:
  path = _group_dir(app, gid) / "meta.json"
  return json.loads(path.read_text()) if path.is_file() else None


async def _store_group_meta(app, gid: str, updates: dict) -> None:
  async with fs_locks.app_storage_lock(app.id):
    path = _group_dir(app, gid) / "meta.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    meta = json.loads(path.read_text()) if path.is_file() else {}
    updates = dict(updates)
    has_icon = "icon" in updates
    icon = updates.pop("icon", None)
    meta.update(updates)
    if has_icon:
      _write_member_icon(app, gid, meta, icon)
    atomic_write(path, json.dumps(meta))
    _bump_version(app)


async def _apply_member_group_lifecycle(
  app, gid: str, sender: str, kind: str, updates: dict, *,
  invitation_id: str | None = None, invitation_version: int | None = None,
) -> str:
  """Commit a host lifecycle callback from one current member-side snapshot.

  Envelope parsing and roster validation happen before this boundary, but all
  decisions that depend on existing state happen under the cross-process app
  lock.  A delayed roster refresh therefore cannot undo an owner's acceptance
  or a newer invitation.
  """
  async with fs_locks.app_storage_lock(app.id):
    path = _group_dir(app, gid) / "meta.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    meta = json.loads(path.read_text()) if path.is_file() else {}
    known_host = meta.get("host")
    if known_host and sender != known_host:
      raise HTTPException(status_code=403, detail="Only the group host may update this group.")

    if kind == "group_deleted":
      prior_state = _group_request_state(meta) if meta else "declined"
      merged = dict(meta)
      merged.update(updates)
      merged.update(
        gid=gid,
        host=sender,
        name=meta.get("name") or updates.get("name") or "Group",
        deleted_at=meta.get("deleted_at") or time.time(),
        unread=0,
        request_status="accepted" if prior_state == "accepted" else "declined",
      )
      status = "deleted"
    elif kind == "group_removed":
      if not meta:
        return "unknown_group"
      if meta.get("deleted_at"):
        return "deleted"
      if invitation_version < int(meta.get("invitation_version") or 0):
        return "stale"  # a delayed removal must not undo a later re-invitation
      if meta.get("removed_at"):
        return "removed"
      merged = dict(meta)
      merged.update(
        removed_at=time.time(), unread=0, request_count=0,
        request_status=(
          "declined" if _group_request_state(meta) == "pending" else "accepted"
        ),
      )
      status = "removed"
    else:
      if meta.get("deleted_at"):
        _require_open(meta)
      current_version = meta.get("invitation_version", 0)
      if invitation_version < current_version:
        return "stale"
      if (
        meta and invitation_version == current_version
        and meta.get("invitation_id") not in (None, invitation_id)
      ):
        return "stale"
      rejoining = bool(meta.get("removed_at"))
      if rejoining and invitation_version == current_version:
        return "stale"  # the roster of the membership that was removed
      request_state = _group_request_state(meta) if meta else "pending"
      if rejoining or (
        request_state == "declined" and meta.get("invitation_id") != invitation_id
      ):
        request_state = "pending"
      incoming_revision = updates.get("roster_revision")
      if (
        isinstance(incoming_revision, int)
        and incoming_revision < _roster_revision(meta)
      ):
        # A delayed refresh keeps its invitation facts but not its older roster.
        updates = {
          key: value for key, value in updates.items()
          if key not in ("members", "name", "roster_revision", "icon")
        }
      merged = dict(meta)
      merged.pop("removed_at", None)
      updates = dict(updates)
      has_icon = "icon" in updates
      icon = updates.pop("icon", None)
      merged.update(updates)
      if has_icon:
        _write_member_icon(app, gid, merged, icon)
      merged.update(
        request_status=request_state,
        request_count=(
          max(1, int(meta.get("request_count") or 0))
          if request_state == "pending" else 0
        ),
        unread=0 if request_state == "pending" else int(meta.get("unread") or 0),
      )
      status = "pending" if request_state == "pending" else "updated"

    atomic_write(path, json.dumps(merged))
    _bump_version(app)
    return status


async def _transition_member_group_request(
  app, gid: str, host: str, invitation_id: str, decision: str,
) -> str:
  """Apply one owner decision only to the invitation that was presented."""
  async with fs_locks.app_storage_lock(app.id):
    path = _group_dir(app, gid) / "meta.json"
    if not path.is_file():
      raise HTTPException(status_code=404, detail="Group invitation not found.")
    meta = json.loads(path.read_text())
    if meta.get("host") != host or meta.get("invitation_id") != invitation_id:
      raise HTTPException(
        status_code=409, detail="Group invitation changed while deciding.",
      )
    _require_open(meta)
    state = _group_request_state(meta)
    if state == decision:
      return decision
    if state != "pending":
      raise HTTPException(status_code=409, detail="This invitation is no longer pending.")
    meta.update(request_status=decision, request_count=0, unread=0)
    atomic_write(path, json.dumps(meta))
    _bump_version(app)
    return decision


async def _store_group_message(
  app, gid: str, record: dict,
  attachment: tuple[dict, bytes] | None = None,
) -> bool:
  async with fs_locks.app_storage_lock(app.id):
    group = _group_dir(app, gid)
    msgs = group / "msgs"
    message_path = msgs / f"{record['id']}.json"
    if message_path.is_file():
      return False
    owns_dirty_marker = begin_message_mutation("group", gid)
    if attachment is not None:
      record["attachment"] = _write_app_attachment(
        group, record["id"], attachment
      )
    msgs.mkdir(parents=True, exist_ok=True)
    atomic_write(message_path, json.dumps(record))
    meta_path = group / "meta.json"
    had_meta = meta_path.is_file()
    meta = json.loads(meta_path.read_text()) if had_meta else {}
    request_state = meta.get("request_status")
    if request_state not in _REQUEST_STATES:
      # Every pre-request-migration group is an established conversation.
      request_state = "accepted" if had_meta else "pending"
    meta.update(
      gid=gid,
      last_text=_message_preview(record["text"]),
      last_at=record["sent_at"],
      last_from_handle=record.get("author_handle") or record.get("author") or "",
      last_dir=record["dir"],
      request_status=request_state,
    )
    if record["dir"] == "in" and request_state == "accepted":
      meta["unread"] = int(meta.get("unread") or 0) + 1
    elif record["dir"] == "in" and request_state == "pending":
      meta["request_count"] = int(meta.get("request_count") or 0) + 1
      meta["unread"] = 0
    elif request_state != "accepted":
      meta["unread"] = 0
    atomic_write(meta_path, json.dumps(meta))
    version = _bump_version(app, history_covered=False)
    mirror_message(
      "group", gid, record, message_path, version=version,
      owns_dirty_marker=owns_dirty_marker,
    )
    return True


def _group_request_state(meta: dict) -> str:
  state = meta.get("request_status")
  return state if state in _REQUEST_STATES else "accepted"


def _host_member_active(member: dict) -> bool:
  # Host records created before message requests have no status; they remain
  # active rather than being silently demoted during upgrade.
  return member.get("status") in (None, "active")


def _require_accepted_group(meta: dict) -> None:
  if _group_request_state(meta) != "accepted":
    raise HTTPException(
      status_code=409,
      detail="Accept this group invitation before sending messages.",
    )


async def _mark_group_read(app, gid: str) -> bool:
  """Clear unread state without racing delivery or lifecycle metadata."""
  async with fs_locks.app_storage_lock(app.id):
    path = _group_dir(app, gid) / "meta.json"
    if not path.is_file():
      raise HTTPException(status_code=404, detail="Group not found.")
    meta = json.loads(path.read_text())
    if not meta.get("unread"):
      return False
    meta["unread"] = 0
    atomic_write(path, json.dumps(meta))
    _bump_version(app)
    return True


_GONE_STATES = ("declined", "removed")


def _member_role(group: dict, host: str) -> str:
  """The host's own record is the only authority for a member's role."""
  if host == group.get("host"):
    return "creator"
  member = group["members"].get(host) or {}
  if member.get("status") in _GONE_STATES:
    return "none"
  return "admin" if member.get("role") == "admin" else "member"


def _members_snapshot(group: dict) -> list[dict]:
  # Privacy contract: only host, handle and role circulate; display names never do.
  snapshot = []
  for h, m in group["members"].items():
    if m.get("status") in _GONE_STATES:
      continue
    entry = {"host": h, "handle": str(m.get("handle") or "")[:MAX_NAME_CHARS]}
    role = _member_role(group, h)
    if role != "member":
      entry["role"] = role
    snapshot.append(entry)
  return snapshot


def _roster_revision(group_or_meta: dict) -> int:
  revision = group_or_meta.get("roster_revision")
  if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
    return 0
  return revision


def _roster_view(group: dict) -> dict:
  """What members' copies show: the name, picture, roster and its revision."""
  return {
    "name": group["name"], "members": _members_snapshot(group),
    "roster_revision": _roster_revision(group), "icon": _icon_wire(group.get("icon")),
  }


# ── group picture ───────────────────────────────────────────────────────────

MAX_GROUP_ICON_BYTES = 10_240
GROUP_ICON_SIDES = (128, 96, 64)
_ICON_MIMES = ("image/webp", "image/png", "image/jpeg")


def _icon_wire(icon: Any) -> dict | None:
  """The exact protocol shape of a saved picture, or None."""
  if not isinstance(icon, dict):
    return None
  return {key: icon[key] for key in ("mime", "data_b64", "w", "h") if key in icon} or None


def _icon_hash(data_b64: str) -> str:
  return hashlib.sha256(data_b64.encode()).hexdigest()[:20]


def _render_group_icon(value: Any) -> dict | None:
  """Re-encode an untrusted image into the small square-bounded group picture."""
  if value is None:
    return None
  checked = _validate_attachment(value)
  if checked is None or value.get("mime") == "image/gif":
    raise HTTPException(status_code=400, detail="Choose a still image for the group picture.")
  for side in GROUP_ICON_SIDES:
    try:
      mime, data = _image_thumbnail_bytes(checked, max_side=side)
    except Exception as exc:
      raise HTTPException(status_code=400, detail="This image couldn't be used.") from exc
    if len(data) <= MAX_GROUP_ICON_BYTES:
      from PIL import Image
      import io
      with Image.open(io.BytesIO(data)) as image:
        width, height = image.size
      return {
        "mime": mime, "data_b64": base64.b64encode(data).decode(), "w": width, "h": height,
      }
  raise HTTPException(status_code=400, detail="This image is too detailed for a group picture.")


def _received_icon(value: Any) -> dict | None:
  """A member's check of the host's picture; anything unusable shows no picture."""
  try:
    checked = _validate_attachment(value, thumbnail=True)
  except HTTPException:
    return None
  if checked is None or value["mime"] not in _ICON_MIMES or len(checked[1]) > MAX_GROUP_ICON_BYTES:
    return None
  return _icon_wire(value)


def _write_member_icon(app, gid: str, meta: dict, icon: dict | None) -> None:
  """Save the picture beside meta.json; meta keeps only its hash. Caller holds the lock."""
  path = _group_dir(app, gid) / "icon.json"
  if icon is None:
    path.unlink(missing_ok=True)
    meta.pop("icon_hash", None)
    return
  digest = _icon_hash(icon["data_b64"])
  if meta.get("icon_hash") != digest or not path.is_file():
    atomic_write(path, json.dumps({**icon, "hash": digest}))
  meta["icon_hash"] = digest


# ── outbound delivery ───────────────────────────────────────────────────────

async def _deliver(host: str, envelope: dict) -> bool:
  try:
    response = await _post_signed_envelope(
      _peer_service_url(host, "groups/inbox"), envelope,
      max_response_bytes=MAX_ENVELOPE_BYTES,
    )
    response.raise_for_status()
    return True
  except Exception:
    return False


def _signed(envelope: dict, identity: dict) -> dict:
  envelope["sig"] = _sign(envelope, identity["private_key_b64"])
  return envelope


async def _fan_out(group: dict, envelopes_by_host: dict[str, dict]) -> dict:
  """Deliver per-member envelopes concurrently; returns host → delivered."""
  hosts = list(envelopes_by_host)
  results = await asyncio.gather(
    *(_deliver(h, envelopes_by_host[h]) for h in hosts)
  )
  return dict(zip(hosts, results))


def _added_envelope(identity: dict, group: dict, member: str) -> dict:
  member_record = group["members"][member]
  invitation_id = member_record.get("invitation_id")
  if not isinstance(invitation_id, str) or not _GID_RE.fullmatch(invitation_id):
    # Stable compatibility identity for a legacy active member receiving a
    # roster refresh. New pending invitations always persist a random id.
    invitation_id = str(uuid.uuid5(
      uuid.NAMESPACE_URL, f"common-group:{group['id']}:{member}"
    ))
  invitation_version = member_record.get("invitation_version")
  if not isinstance(invitation_version, int) or isinstance(invitation_version, bool):
    invitation_version = 1
  return _signed({
    "v": 0,
    "type": "group_added",
    "id": invitation_id,
    "from": _own_host(),
    "to": member,
    "gid": group["id"],
    "invitation_version": invitation_version,
    "group_name": group["name"],
    "members": _members_snapshot(group),
    "roster_revision": _roster_revision(group),
    "group_icon": _icon_wire(group.get("icon")),
    "sent_at": time.time(),
  }, identity)


def _post_envelope(
  identity: dict, gid: str, host: str, *, message_id: str, text: str,
  sent_at: float, attachment: tuple[dict, bytes] | None = None,
  reply_to: dict | None = None,
) -> dict:
  envelope = {
    "v": 0,
    "type": "group_post",
    "id": message_id,
    "from": _own_host(),
    "to": host,
    "gid": gid,
    "text": text,
    "sent_at": sent_at,
  }
  if attachment is not None:
    envelope["attachment"] = attachment[0]
  if reply_to is not None:
    envelope["reply_to"] = reply_to
  return _signed(envelope, identity)


def _relay_envelope(
  identity: dict, group: dict, member: str, *, original: dict,
  message_id: str, author: str, author_handle: str, text: str, sent_at: float,
  attachment: tuple[dict, bytes] | None = None,
  reply_to: dict | None = None,
) -> dict:
  envelope = {
    "v": 0,
    "type": "group_message",
    "id": message_id,
    "from": _own_host(),
    "to": member,
    "gid": group["id"],
    "group_name": group["name"],
    "author": author,
    "author_handle": author_handle,
    "text": text,
    "original": original,
    "sent_at": sent_at,
  }
  if attachment is not None:
    envelope["attachment"] = attachment[0]
  if reply_to is not None:
    envelope["reply_to"] = reply_to
  return _signed(envelope, identity)


async def _host_commit_post(
  app, group: dict, *, original: dict,
  message_id: str, author: str, author_handle: str, text: str, sent_at: float,
  attachment: tuple[dict, bytes] | None = None,
  reply_to: dict | None = None,
) -> dict:
  """Persist an accepted post and build its relay batch without networking."""
  record = {
    "id": message_id, "gid": group["id"], "author": author,
    "author_handle": author_handle, "text": text, "sent_at": sent_at,
    "dir": "out" if author == _own_host() else "in",
    "status": "delivered",
  }
  if reply_to is not None:
    record["reply_to"] = reply_to
  await _store_group_message(app, group["id"], record, attachment)
  identity = _load_identity()
  relays = {
    member: _relay_envelope(
      identity, group, member, original=original, message_id=message_id,
      author=author, author_handle=author_handle, text=text, sent_at=sent_at,
      attachment=attachment, reply_to=reply_to,
    )
    for member in group["members"]
    if (
      member not in (_own_host(), author)
      and _host_member_active(group["members"][member])
    )
  }
  return relays


async def _deliver_committed_host_post(
  db: object, app, group: dict, *, author: str, author_handle: str,
  text: str, relays: dict[str, dict],
) -> dict:
  """Perform post-commit fan-out and notification outside the transaction."""
  delivered = await _fan_out(group, relays)
  if author != _own_host():
    await _notify_group_message(group["id"], group["name"], author_handle, text)
  return delivered


async def _notify_group_message(
  gid: str, group_name: str, author_handle: str, text: str
) -> None:
  await notify(
    f"{group_name} — {author_handle}", _message_preview(text), f"group:{gid}",
  )


# ── peer surface ────────────────────────────────────────────────────────────

@router.post("/inbox")
async def group_inbox(request: Request, db: object = Depends(get_db)):
  """Verify peer authority before serializing against the group lifecycle."""
  if not _joined_for_federation():
    raise HTTPException(status_code=403, detail="Join Social before receiving groups.")
  envelope = await _read_envelope(request)
  if envelope.get("v") != 0:
    raise HTTPException(status_code=400, detail="Unsupported envelope version.")
  if envelope.get("to") != _own_host():
    raise HTTPException(status_code=400, detail="Envelope is addressed elsewhere.")
  gid = envelope.get("gid")
  _validate_gid(gid)
  if envelope.get("type") not in (
    "group_added", "group_deleted", "group_post", "group_message",
    "group_accept", "group_decline", "group_react", "group_reaction",
    "group_manage", "group_removed", "group_edit", "group_edited",
  ):
    raise HTTPException(status_code=400, detail="Unsupported envelope type.")
  app = _common_app(db)
  actor = await _verify_peer_envelope(envelope)
  async with _group_lock(gid):
    return await _accept_group_envelope(db, app, envelope, actor)


async def _accept_group_envelope(
  db, app, envelope: dict, actor: dict,
) -> dict:
  """Handle a verified envelope while holding the group's lifecycle lock."""
  gid = envelope["gid"]
  kind = envelope["type"]
  sender = envelope["from"]
  if kind in ("group_accept", "group_decline"):
    action_id = envelope.get("id")
    if not isinstance(action_id, str) or not _GID_RE.fullmatch(action_id):
      raise HTTPException(status_code=400, detail="Request id is invalid.")
    with _host_group_transaction(gid):
      group = _load_host_group(gid)
      if group is None:
        raise HTTPException(status_code=404, detail="Unknown group.")
      _require_open(group)
      member = group["members"].get(sender)
      if member is None:
        raise HTTPException(status_code=403, detail="No invitation exists for this group.")
      status = member.get("status")
      if status is None:
        # A legacy member was already active before invitation requests existed.
        return {"status": "accepted"}
      if envelope.get("invitation_id") != member.get("invitation_id"):
        raise HTTPException(status_code=409, detail="This invitation has been replaced.")
      if kind == "group_accept":
        if status == "active":
          return {"status": "accepted"}
        if status != "invited":
          raise HTTPException(status_code=409, detail="This invitation is no longer pending.")
        member.update(
          status="active",
          handle=str(actor.get("handle") or member.get("handle") or "")[:MAX_NAME_CHARS],
          joined_at=time.time(),
        )
        atomic_write(_host_group_path(gid), json.dumps(group, indent=2))
        members = _members_snapshot(group)
      else:
        if status == "declined":
          return {"status": "declined"}
        if status == "active":
          raise HTTPException(status_code=409, detail="An active member cannot decline an invitation.")
        member["status"] = "declined"
        atomic_write(_host_group_path(gid), json.dumps(group, indent=2))
        members = _members_snapshot(group)
      # Keep the local UI snapshot in the same authoritative transaction. A
      # later membership transition must not be overwritten by this older
      # roster after it has already committed.
      await _store_group_meta(app, gid, {"members": members})
    if kind == "group_accept":
      return {"status": "accepted"}
    return {"status": "declined"}

  if kind == "group_manage":
    return await _host_accept_manage(app, gid, envelope)

  if kind in ("group_added", "group_deleted", "group_removed"):
    meta = _load_group_meta(app, gid)
    hosted = _load_host_group(gid)
    known_host = hosted.get("host") if hosted else meta.get("host") if meta else None
    if known_host and sender != known_host:
      raise HTTPException(status_code=403, detail="Only the group host may update this group.")
    if hosted:
      raise HTTPException(status_code=403, detail="Hosted groups are managed locally.")
    name = str(envelope.get("group_name") or "Group")[:MAX_NAME_CHARS]
    if kind == "group_deleted":
      # A tombstone also precedes a delayed first invite; reordering must not
      # resurrect a closed group. Member-owned history is never erased.
      status = await _apply_member_group_lifecycle(
        app, gid, sender, kind, {"name": name},
      )
      return {"status": status}
    if kind == "group_removed":
      removed_version = envelope.get("invitation_version", 1)
      if (
        not isinstance(removed_version, int) or isinstance(removed_version, bool)
        or removed_version < 1
      ):
        raise HTTPException(status_code=400, detail="Invitation version is invalid.")
      status = await _apply_member_group_lifecycle(
        app, gid, sender, kind, {}, invitation_version=removed_version,
      )
      if status == "removed":
        await notify(
          f"You were removed from {name}", "Your earlier messages are still in Social.",
          f"group:{gid}",
        )
      return {"status": status}
    invitation_id = envelope.get("id")
    if not isinstance(invitation_id, str) or not _GID_RE.fullmatch(invitation_id):
      raise HTTPException(status_code=400, detail="Invitation id is invalid.")
    roster = _parse_roster(envelope.get("members"))
    invitation_version = envelope.get("invitation_version", 1)
    if (
      not isinstance(invitation_version, int)
      or isinstance(invitation_version, bool)
      or invitation_version < 1
    ):
      raise HTTPException(status_code=400, detail="Invitation version is invalid.")
    prior = _load_group_meta(app, gid) or {}
    updates = {
      "gid": gid, "name": name, "host": sender,
      "members": roster,
      "invited_by_handle": str(actor.get("handle") or "")[:MAX_NAME_CHARS],
      "invitation_id": invitation_id,
      "invitation_version": invitation_version,
    }
    roster_revision = envelope.get("roster_revision")
    if isinstance(roster_revision, int) and not isinstance(roster_revision, bool):
      if roster_revision < 0:
        raise HTTPException(status_code=400, detail="Roster revision is invalid.")
      updates["roster_revision"] = roster_revision
    if "group_icon" in envelope:
      updates["icon"] = _received_icon(envelope["group_icon"])
    status = await _apply_member_group_lifecycle(
      app, gid, sender, kind, updates,
      invitation_id=invitation_id, invitation_version=invitation_version,
    )
    # Roster refreshes re-deliver the same pending invitation; notify once.
    if status == "pending" and (
      prior.get("invitation_id") != invitation_id
      or _group_request_state(prior) != "pending"
    ):
      inviter = f"@{actor['handle']}" if actor.get("handle") else sender
      await notify(f"{inviter} invited you to {name}", "Open Social to reply.", f"group:{gid}")
    return {"status": status}

  message_id = envelope.get("id")
  if not isinstance(message_id, str) or not _GID_RE.fullmatch(message_id):
    raise HTTPException(status_code=400, detail="Message id is invalid.")

  if kind == "group_react":
    return await _host_accept_reaction(app, gid, envelope)
  if kind == "group_reaction":
    return await _member_accept_reaction(app, gid, envelope)
  if kind == "group_edit":
    return await _host_accept_edit(app, gid, envelope)
  if kind == "group_edited":
    return await _member_accept_edit(app, gid, envelope)

  if kind == "group_post":
    text = envelope.get("text")
    attachment = _validate_attachment(envelope.get("attachment"))
    _validate_text_or_attachment(text, attachment, "Message text is invalid.")
    reply_to = _validate_reply_to(envelope.get("reply_to"))
    with _host_group_transaction(gid):
      group = _load_host_group(gid)
      if group is None:
        raise HTTPException(status_code=404, detail="Unknown group.")
      _require_open(group)
      member = group["members"].get(sender)
      if member is None or not _host_member_active(member):
        raise HTTPException(status_code=403, detail="Not a member of this group.")
      existing = _group_dir(app, gid) / "msgs" / f"{message_id}.json"
      if existing.is_file():
        return {"status": "duplicate"}
      author_handle = member.get("handle") or sender
      relays = await _host_commit_post(
        app, group, original=envelope,
        message_id=message_id, author=sender,
        author_handle=author_handle, text=text, sent_at=envelope["sent_at"],
        attachment=attachment, reply_to=reply_to,
      )
    delivered = await _deliver_committed_host_post(
      db, app, group, author=sender, author_handle=author_handle,
      text=text, relays=relays,
    )
    return {"status": "delivered", "relayed": delivered}

  # A member verifies both the known host relay and its author-signed original.
  meta = _load_group_meta(app, gid)
  if meta is None:
    return {"status": "unknown_group"}
  if sender != meta.get("host"):
    raise HTTPException(status_code=403, detail="Relay is not from the group host.")
  _require_open(meta)
  original = envelope.get("original")
  if (
    not isinstance(original, dict)
    or original.get("type") != "group_post"
    or original.get("gid") != gid
    or original.get("id") != message_id
    or original.get("to") != meta["host"]
  ):
    raise HTTPException(status_code=403, detail="Original message is invalid.")
  try:
    original_actor = await _verify_peer_envelope(original)
  except HTTPException as exc:
    raise HTTPException(
      status_code=403, detail="Original message signature is invalid."
    ) from exc
  text = original.get("text")
  attachment = _validate_attachment(original.get("attachment"))
  _validate_text_or_attachment(text, attachment, "Message text is invalid.")
  reply_to = _validate_reply_to(original.get("reply_to"))
  author = original["from"]
  author_handle = str(original_actor.get("handle") or author)[:MAX_NAME_CHARS]
  record = {
    "id": message_id, "gid": gid, "author": author,
    "author_handle": author_handle, "text": text,
    "sent_at": original["sent_at"], "dir": "in", "status": "delivered",
  }
  if reply_to is not None:
    record["reply_to"] = reply_to
  created = await _store_group_message(app, gid, record, attachment)
  if not created:
    return {"status": "duplicate"}
  if _group_request_state(meta) == "accepted":
    await _notify_group_message(
      gid, meta.get("name") or "Group", author_handle, text,
    )
    return {"status": "delivered"}
  return {"status": "pending"}


# ── reactions ───────────────────────────────────────────────────────────────

def _reaction_fields(envelope: dict) -> tuple[str, str, bool, float]:
  message_id = envelope.get("message_id")
  if not isinstance(message_id, str) or not _GID_RE.fullmatch(message_id):
    raise HTTPException(status_code=400, detail="Message id is invalid.")
  emoji, on, at = validate_reaction(envelope.get("emoji"), envelope.get("on"), envelope.get("at"))
  return message_id, emoji, on, at


def _react_envelope(
  identity: dict, gid: str, host: str, message_id: str, emoji: str, on: bool, at: float,
  *, update_id: str,
) -> dict:
  # The id is the update's stable identity: every attempt of one update
  # carries it, with a fresh transport timestamp and signature.
  return _signed({
    "v": 0, "type": "group_react", "id": update_id,
    "from": _own_host(), "to": host, "gid": gid,
    "message_id": message_id, "emoji": emoji, "on": on, "at": at,
    "sent_at": time.time(),
  }, identity)


async def _change_group_message(app, gid: str, message_id: str, change) -> tuple[dict | None, Any]:
  """Run ``change(record)`` on a saved group message under the storage lock.

  ``change`` returns ``(changed, value)``; a changed record is saved and
  republished. Returns ``(record, value)``, or ``(None, None)`` when this copy
  never received the message.
  """
  async with fs_locks.app_storage_lock(app.id):
    path = _group_dir(app, gid) / "msgs" / f"{message_id}.json"
    if not path.is_file():
      return None, None
    record = json.loads(path.read_text())
    changed, value = change(record)
    if changed:
      owns_dirty_marker = begin_message_mutation("group", gid)
      atomic_write(path, json.dumps(record))
      version = _bump_version(app, history_covered=False)
      mirror_message(
        "group", gid, record, path, version=version,
        owns_dirty_marker=owns_dirty_marker,
      )
    return record, value


async def _store_group_reaction(
  app, gid: str, message_id: str, host: str, emoji: str, on: bool, at: float,
) -> tuple[bool, dict | None]:
  """Apply one update to this copy; ``(applied, record)``, record None if unknown."""
  def change(saved: dict) -> tuple[bool, bool]:
    applied = apply_reaction(saved, host, emoji, on, at)
    return applied, applied

  record, applied = await _change_group_message(app, gid, message_id, change)
  return bool(applied), record


# Relays the host still owes members, kept apart from the message so that
# delivering them never reapplies a reaction or repeats a notification:
# ``{"<message id> <reacting host> <emoji>": {"original": signed group_react,
# "members": [hosts not yet confirmed]}}``. A newer update for the same pair
# replaces the entry, because members need only the newest one.

def _relay_outbox_path(gid: str) -> Path:
  return _host_groups_dir() / "reaction-relays" / f"{gid}.json"


def _load_relay_outbox(gid: str) -> dict:
  path = _relay_outbox_path(gid)
  if not path.is_file():
    return {}
  value = json.loads(path.read_text())
  return value if isinstance(value, dict) else {}


def _save_relay_outbox(gid: str, outbox: dict) -> None:
  path = _relay_outbox_path(gid)
  if outbox:
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(path, json.dumps(outbox))
  else:
    path.unlink(missing_ok=True)


def _relay_key(original: dict) -> str:
  return f"{original['message_id']} {original['from']} {original['emoji']}"


def _same_update(a: dict, b: dict) -> bool:
  return all(a.get(field) == b.get(field) for field in (
    "id", "from", "gid", "message_id", "emoji", "on", "at",
  ))


def _queue_reaction_relays(group: dict, original: dict, *, applied: bool) -> dict[str, dict]:
  """Record and return the relays one host-accepted update still needs.

  A newly applied update owes every other active member a relay. An exact
  retry of an applied one owes only the members its earlier attempts missed.
  Callers hold the host group transaction.
  """
  outbox = _load_relay_outbox(group["id"])
  key = _relay_key(original)
  if applied:
    entry = {"original": original, "members": [
      member for member in group["members"]
      if member not in (_own_host(), original["from"])
      and _host_member_active(group["members"][member])
    ]}
  else:
    entry = outbox.get(key)
    if not isinstance(entry, dict) or not _same_update(entry.get("original") or {}, original):
      return {}  # an older update, or one every member already has
    # Relay the freshly signed attempt: members check the original's timestamp.
    entry = {"original": original, "members": [
      member for member in entry.get("members") or []
      if member in group["members"] and _host_member_active(group["members"][member])
    ]}
  if entry["members"]:
    outbox[key] = entry
  else:
    outbox.pop(key, None)
  _save_relay_outbox(group["id"], outbox)
  identity = _load_identity()
  return {
    member: _signed({
      "v": 0, "type": "group_reaction",
      "id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"group-reaction:{original['id']}:{member}")),
      "from": _own_host(), "to": member, "gid": group["id"],
      "original": original, "sent_at": time.time(),
    }, identity)
    for member in entry["members"]
  }


async def _relay_reaction(group: dict, original: dict, relays: dict[str, dict]) -> list[str]:
  """Fan out, then settle confirmed members; return those still owed."""
  delivered = await _fan_out(group, relays) if relays else {}
  key = _relay_key(original)
  with _host_group_transaction(group["id"]):
    outbox = _load_relay_outbox(group["id"])
    entry = outbox.get(key)
    if not isinstance(entry, dict) or not _same_update(entry.get("original") or {}, original):
      return []  # a newer update replaced this one; it carries its own relays
    remaining = [member for member in entry.get("members") or [] if not delivered.get(member)]
    if remaining:
      outbox[key] = {**entry, "members": remaining}
    else:
      outbox.pop(key)
    _save_relay_outbox(group["id"], outbox)
  return remaining


async def _host_commit_reaction(app, group: dict, original: dict) -> tuple[bool, dict, dict]:
  """Apply a verified ``group_react`` on the host; return the relays it owes."""
  message_id, emoji, on, at = _reaction_fields(original)
  applied, record = await _store_group_reaction(
    app, group["id"], message_id, original["from"], emoji, on, at,
  )
  if record is None:
    raise HTTPException(status_code=404, detail="Message not found.")
  return applied, record, _queue_reaction_relays(group, original, applied=applied)


async def _notify_group_reaction(meta: dict, record: dict, who: str, emoji: str, on: bool) -> None:
  if on and record.get("dir") == "out" and _group_request_state(meta) == "accepted":
    await notify(
      f"{meta.get('name') or 'Group'}", reaction_line(who, emoji), f"group:{meta.get('gid') or record.get('gid')}",
    )


async def _host_accept_reaction(app, gid: str, envelope: dict) -> dict:
  sender = envelope["from"]
  with _host_group_transaction(gid):
    group = _load_host_group(gid)
    if group is None:
      raise HTTPException(status_code=404, detail="Unknown group.")
    _require_open(group)
    member = group["members"].get(sender)
    if member is None or not _host_member_active(member):
      raise HTTPException(status_code=403, detail="Not a member of this group.")
    applied, record, relays = await _host_commit_reaction(app, group, envelope)
  undelivered = await _relay_reaction(group, envelope, relays)
  if applied:
    # Only the first application notifies; a retry only finishes relaying.
    _message_id, emoji, on, _at = _reaction_fields(envelope)
    who = f"@{member['handle']}" if member.get("handle") else sender
    await _notify_group_reaction(
      _load_group_meta(app, gid) or {"gid": gid, "name": group.get("name")}, record, who, emoji, on,
    )
  # The reacting member keeps its update retryable while relays are owed.
  return {"status": "ok", "undelivered": len(undelivered)}


async def _member_accept_reaction(app, gid: str, envelope: dict) -> dict:
  meta = _load_group_meta(app, gid)
  if meta is None:
    return {"status": "unknown_group"}
  if envelope["from"] != meta.get("host"):
    raise HTTPException(status_code=403, detail="Relay is not from the group host.")
  _require_open(meta)
  original = envelope.get("original")
  if (
    not isinstance(original, dict)
    or original.get("type") != "group_react"
    or original.get("gid") != gid
    or original.get("to") != meta["host"]
  ):
    raise HTTPException(status_code=403, detail="Original reaction is invalid.")
  try:
    original_actor = await _verify_peer_envelope(original)
  except HTTPException as exc:
    raise HTTPException(status_code=403, detail="Original reaction signature is invalid.") from exc
  message_id, emoji, on, at = _reaction_fields(original)
  applied, record = await _store_group_reaction(app, gid, message_id, original["from"], emoji, on, at)
  if record is None:
    # A member who joined later never received this message.
    return {"status": "unknown_message"}
  if applied:
    who = f"@{original_actor['handle']}" if original_actor.get("handle") else original["from"]
    await _notify_group_reaction(meta, record, who, emoji, on)
  return {"status": "ok"}


# ── edits ───────────────────────────────────────────────────────────────────
# Only a message's author edits it. The author signs a ``group_edit``; the host
# checks it against its own copy and relays it once to every other active
# member inside a host-signed ``group_edited``. Members verify the author's
# signature and their own copy's author, so the host cannot forge an edit.

def _edit_fields(envelope: dict) -> tuple[str, str, float]:
  message_id = envelope.get("message_id")
  if not isinstance(message_id, str) or not _GID_RE.fullmatch(message_id):
    raise HTTPException(status_code=400, detail="Message id is invalid.")
  text, at = validate_edit(envelope.get("text"), envelope.get("at"))
  return message_id, text, at


def _edit_envelope(
  identity: dict, gid: str, host: str, message_id: str, text: str, at: float, *, edit_id: str,
) -> dict:
  return _signed({
    "v": 0, "type": "group_edit", "id": edit_id,
    "from": _own_host(), "to": host, "gid": gid,
    "message_id": message_id, "text": text, "at": at,
    "sent_at": time.time(),
  }, identity)


async def _store_group_edit(app, gid: str, message_id: str, author: str, text: str, at: float):
  """Apply one author edit to this copy; ``(applied, record)``, record None if unknown."""
  def change(saved: dict):
    if saved.get("author") != author:
      raise HTTPException(status_code=403, detail="Only the author can edit this message.")
    applied = apply_edit(saved, text, at)
    return applied, applied

  record, applied = await _change_group_message(app, gid, message_id, change)
  return bool(applied), record


def _edit_relays(group: dict, original: dict) -> dict[str, dict]:
  identity = _load_identity()
  return {
    member: _signed({
      "v": 0, "type": "group_edited",
      "id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"group-edited:{original['id']}:{member}")),
      "from": _own_host(), "to": member, "gid": group["id"],
      "original": original, "sent_at": time.time(),
    }, identity)
    for member in group["members"]
    if member not in (_own_host(), original["from"]) and _host_member_active(group["members"][member])
  }


async def _host_accept_edit(app, gid: str, envelope: dict) -> dict:
  sender = envelope["from"]
  message_id, text, at = _edit_fields(envelope)
  with _host_group_transaction(gid):
    group = _load_host_group(gid)
    if group is None:
      raise HTTPException(status_code=404, detail="Unknown group.")
    _require_open(group)
    member = group["members"].get(sender)
    if member is None or not _host_member_active(member):
      raise HTTPException(status_code=403, detail="Not a member of this group.")
    _applied, record = await _store_group_edit(app, gid, message_id, sender, text, at)
    if record is None:
      raise HTTPException(status_code=404, detail="Message not found.")
    relays = _edit_relays(group, envelope)
  delivered = await _fan_out(group, relays) if relays else {}
  undelivered = [host for host in relays if not delivered.get(host)]
  return {"status": "ok", "undelivered": len(undelivered)}


async def _member_accept_edit(app, gid: str, envelope: dict) -> dict:
  meta = _load_group_meta(app, gid)
  if meta is None:
    return {"status": "unknown_group"}
  if envelope["from"] != meta.get("host"):
    raise HTTPException(status_code=403, detail="Relay is not from the group host.")
  _require_open(meta)
  original = envelope.get("original")
  if (
    not isinstance(original, dict)
    or original.get("type") != "group_edit"
    or original.get("gid") != gid
    or original.get("to") != meta["host"]
  ):
    raise HTTPException(status_code=403, detail="Original edit is invalid.")
  try:
    await _verify_peer_envelope(original)
  except HTTPException as exc:
    raise HTTPException(status_code=403, detail="Original edit signature is invalid.") from exc
  message_id, text, at = _edit_fields(original)
  _applied, record = await _store_group_edit(app, gid, message_id, original["from"], text, at)
  if record is None:
    return {"status": "unknown_message"}
  return {"status": "ok"}


# ── owner surface ───────────────────────────────────────────────────────────

class CreateGroup(BaseModel):
  name: str
  members: list[str] = []


class GroupSend(BaseModel):
  # A client-minted id lets an interrupted send be retried without a duplicate.
  id: str | None = None
  text: str
  attachment: Any = None
  reply_to: Any = None


class AddMember(BaseModel):
  host: str
  handle: str | None = None


def _membership_action_envelope(
  identity: dict, gid: str, host: str, action: str, invitation_id: str,
) -> dict:
  return _signed({
    "v": 0,
    "type": action,
    "id": str(uuid.uuid4()),
    "from": _own_host(),
    "to": host,
    "gid": gid,
    "invitation_id": invitation_id,
    "sent_at": time.time(),
  }, identity)


@router.post("")
async def create_group(
  body: CreateGroup,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Create a group hosted on this instance and invite its first members."""
  require_nondelegated_owner_control(principal)
  app = _require_member(db, principal)
  name = body.name.strip()[:MAX_NAME_CHARS]
  if not name:
    raise HTTPException(status_code=400, detail="Give the group a name.")
  identity = _load_identity()
  if not identity.get("joined_at"):
    raise HTTPException(status_code=409, detail="Join Common before creating groups.")
  member_hosts = []
  for host in body.members:
    host = host.strip().lower()
    if host and host != _own_host():
      if not _valid_host(host):
        raise HTTPException(status_code=400, detail=f"Invalid member: {host}")
      member_hosts.append(host)
  if len(member_hosts) + 1 > MAX_GROUP_MEMBERS:
    raise HTTPException(status_code=400, detail="Too many members.")

  gid = str(uuid.uuid4())
  members = {
    _own_host(): {
      "handle": identity.get("handle") or "", "joined_at": time.time(),
      "status": "active",
    },
  }
  for host in member_hosts:
    entry = {
      "handle": "", "invited_at": time.time(), "status": "invited",
      "invitation_id": str(uuid.uuid4()),
      "invitation_version": 1,
    }
    try:
      actor = await _fetch_actor(host)
      entry["handle"] = actor.get("handle") or ""
    except HTTPException:
      pass  # unreachable now; metadata heals on their first post
    members[host] = entry
  group = {
    "id": gid, "name": name, "host": _own_host(),
    "created_at": time.time(), "members": members,
  }
  async with _group_lock(gid):
    with _host_group_transaction(gid):
      atomic_write(_host_group_path(gid), json.dumps(group, indent=2))
      await _store_group_meta(app, gid, {
        "gid": gid, "name": name, "host": _own_host(),
        "members": _members_snapshot(group),
        "last_at": time.time(), "last_text": "", "unread": 0,
        "request_status": "accepted",
      })
    invitations = {
      host: _added_envelope(identity, group, host) for host in member_hosts
    }
  invited = await _fan_out(group, invitations)
  return {"status": "created", "gid": gid, "invited": invited}


@router.post("/{gid}/read")
async def mark_group_read(
  gid: str,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  require_nondelegated_owner_control(principal)
  app = _require_member(db, principal)
  _validate_gid(gid)
  changed = await _mark_group_read(app, gid)
  return {"status": "read", "changed": changed}


@router.get("/{gid}/messages")
async def group_message_history(
  gid: str,
  before: str | None = None,
  limit: int = Query(default=50, ge=1, le=100),
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Read one bounded group-history slice in chronological display order."""
  require_nondelegated_owner_control(principal)
  app = _require_member(db, principal)
  _validate_gid(gid)
  messages_dir = _group_dir(app, gid) / "msgs"
  try:
    return await load_page(
      app.id, "group", gid, messages_dir, cursor=before, limit=limit,
    )
  except ValueError as exc:
    raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/{gid}/accept")
async def accept_group_invitation(
  gid: str,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Join only after the owner explicitly accepts the host's invitation."""
  require_nondelegated_owner_control(principal)
  app = _require_member(db, principal)
  _validate_gid(gid)
  identity = _load_identity()
  if not identity.get("joined_at"):
    raise HTTPException(status_code=409, detail="Join Social before accepting groups.")
  async with _group_lock(gid):
    meta = _load_group_meta(app, gid)
    if meta is None:
      raise HTTPException(status_code=404, detail="Group invitation not found.")
    _require_open(meta)
    state = _group_request_state(meta)
    if state == "accepted":
      return {"status": "accepted"}
    if state != "pending":
      raise HTTPException(status_code=409, detail="This invitation is no longer pending.")
    host = meta.get("host")
    if not _valid_host(host or "") or host == _own_host():
      raise HTTPException(status_code=409, detail="Group host is invalid.")
    invitation_id = meta.get("invitation_id")
    if not isinstance(invitation_id, str) or not _GID_RE.fullmatch(invitation_id):
      raise HTTPException(status_code=409, detail="Invitation identity is missing.")
    envelope = _membership_action_envelope(
      identity, gid, host, "group_accept", invitation_id
    )

  # Do not hold the lifecycle lock across a call to the same host that may be
  # delivering a tombstone concurrently.
  if not await _deliver(host, envelope):
    raise HTTPException(status_code=502, detail="The group host could not be reached.")

  async with _group_lock(gid):
    await _transition_member_group_request(
      app, gid, host, invitation_id, "accepted",
    )
  return {"status": "accepted"}


@router.post("/{gid}/decline")
async def decline_group_invitation(
  gid: str,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Dismiss an invitation locally without erasing its retained history."""
  require_nondelegated_owner_control(principal)
  app = _require_member(db, principal)
  _validate_gid(gid)
  identity = _load_identity()
  async with _group_lock(gid):
    meta = _load_group_meta(app, gid)
    if meta is None:
      raise HTTPException(status_code=404, detail="Group invitation not found.")
    _require_open(meta)
    state = _group_request_state(meta)
    if state == "declined":
      return {"status": "declined", "host_notified": True}
    if state != "pending":
      raise HTTPException(status_code=409, detail="This invitation is no longer pending.")
    host = meta.get("host")
    if not _valid_host(host or "") or host == _own_host():
      raise HTTPException(status_code=409, detail="Group host is invalid.")
    invitation_id = meta.get("invitation_id")
    if not isinstance(invitation_id, str) or not _GID_RE.fullmatch(invitation_id):
      raise HTTPException(status_code=409, detail="Invitation identity is missing.")
    envelope = _membership_action_envelope(
      identity, gid, host, "group_decline", invitation_id
    )
    await _transition_member_group_request(
      app, gid, host, invitation_id, "declined",
    )

  # Declining is locally final even when the host is offline. It never grants
  # membership, and the host can retry an invitation later.
  notified = await _deliver(host, envelope)
  return {"status": "declined", "host_notified": notified}


def _own_group_message(
  app, gid: str, message_id: str, *, text: str, reply_to: dict | None,
  attachment: tuple[dict, bytes] | None,
) -> dict | None:
  """Return this owner's saved post for an exact retry; reject id reuse."""
  path = _group_dir(app, gid) / "msgs" / f"{message_id}.json"
  if not path.is_file():
    return None
  existing = json.loads(path.read_text())
  proposed = {"id": message_id, "dir": "out", "text": text}
  if reply_to is not None:
    proposed["reply_to"] = reply_to
  if attachment is not None:
    wire, data = attachment
    proposed["attachment"] = {
      "mime": wire["mime"], "w": wire["w"], "h": wire["h"],
      "sha256": hashlib.sha256(data).hexdigest(),
    }
  if existing.get("author") != _own_host() or not _same_outgoing_intent(existing, proposed):
    raise HTTPException(
      status_code=409, detail="This message id already belongs to another message."
    )
  return existing


def _saved_outgoing_group_message(app, gid: str, message_id: str) -> dict:
  """Load the owner's own saved outgoing post; nothing else is retryable."""
  path = _group_dir(app, gid) / "msgs" / f"{message_id}.json"
  if not path.is_file():
    raise HTTPException(status_code=404, detail="Message not found.")
  record = json.loads(path.read_text())
  if record.get("author") != _own_host() or record.get("dir") != "out":
    raise HTTPException(status_code=403, detail="Only your own messages can be retried.")
  return record


def _stored_group_attachment(app, gid: str, record: dict) -> tuple[dict, bytes] | None:
  """Rebuild the exact photo a saved post was sent with from its media file."""
  metadata = record.get("attachment")
  if not isinstance(metadata, dict):
    return None
  group = _group_dir(app, gid).resolve()
  relative = metadata.get("file")
  path = (group / relative).resolve() if isinstance(relative, str) else None
  if path is None or not path.is_relative_to(group) or not path.is_file():
    raise HTTPException(status_code=409, detail="This photo is no longer saved here.")
  data = path.read_bytes()
  if metadata.get("sha256") not in (None, hashlib.sha256(data).hexdigest()):
    raise HTTPException(status_code=409, detail="This photo is no longer saved here.")
  return _validate_attachment({
    "mime": metadata.get("mime"), "w": metadata.get("w"), "h": metadata.get("h"),
    "data_b64": base64.b64encode(data).decode(),
  })


async def _mark_group_message_delivered(app, gid: str, message_id: str) -> dict:
  """A successful retry upgrades the one saved failed copy in place."""
  async with fs_locks.app_storage_lock(app.id):
    # Re-check under the lock: only the owner's own outgoing post is upgraded.
    record = _saved_outgoing_group_message(app, gid, message_id)
    path = _group_dir(app, gid) / "msgs" / f"{message_id}.json"
    if record.get("status") == "delivered":
      return record
    record["status"] = "delivered"
    owns_dirty_marker = begin_message_mutation("group", gid)
    atomic_write(path, json.dumps(record))
    version = _bump_version(app, history_covered=False)
    mirror_message(
      "group", gid, record, path, version=version,
      owns_dirty_marker=owns_dirty_marker,
    )
    return record


async def _retry_saved_group_message(app, gid: str, message_id: str) -> dict:
  """Re-send a saved outgoing post exactly as stored, under its original id
  and time, so the host deduplicates it and the copy here upgrades in place."""
  async with _group_lock(gid):
    record = _saved_outgoing_group_message(app, gid, message_id)
    if record.get("status") == "delivered":
      return {"status": "delivered", "id": message_id, "detail": None}
    meta = _load_group_meta(app, gid)
    if meta is None:
      raise HTTPException(status_code=404, detail="Unknown group.")
    _require_open(meta)
    _require_accepted_group(meta)
    envelope = _post_envelope(
      _load_identity(), gid, meta["host"], message_id=message_id,
      text=record.get("text") or "", sent_at=record["sent_at"],
      attachment=_stored_group_attachment(app, gid, record),
      reply_to=record.get("reply_to"),
    )
  # As for a first send, never hold the member lock while contacting the host.
  if await _deliver(meta["host"], envelope):
    record = await _mark_group_message_delivered(app, gid, message_id)
  ok = record.get("status") == "delivered"
  current = _load_group_meta(app, gid) or meta
  return {
    "status": "delivered" if ok else "failed", "id": message_id,
    "detail": None if ok else f"The group host {meta['host']} could not be reached.",
    **({"group_deleted": True} if current.get("deleted_at") else {}),
  }


@router.post("/{gid}/messages/{message_id}/retry")
async def retry_group_message(
  gid: str,
  message_id: str,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Retry the owner's saved outgoing group post without a new identity."""
  require_nondelegated_owner_control(principal)
  app = _require_member(db, principal)
  _validate_gid(gid)
  if not _GID_RE.fullmatch(message_id):
    raise HTTPException(status_code=400, detail="Message id is invalid.")
  return await _retry_saved_group_message(app, gid, message_id)


class GroupReaction(BaseModel):
  emoji: str
  on: bool
  # The update's stable identity; a retry under it re-sends the same update.
  id: str | None = None


async def _deliver_to_host(host: str, envelope: dict) -> tuple[str, dict]:
  """``(outcome, reply)``: delivered, refused (the host said no), or uncertain."""
  try:
    response = await _post_signed_envelope(
      _peer_service_url(host, "groups/inbox"), envelope,
      max_response_bytes=MAX_ENVELOPE_BYTES,
    )
    response.raise_for_status()
  except httpx.HTTPStatusError as exc:
    code = exc.response.status_code
    return ("refused" if 400 <= code < 500 and code not in (408, 429) else "uncertain"), {}
  except Exception:
    # A lost reply is no proof the host did not apply it.
    return "uncertain", {}
  try:
    reply = response.json()
  except Exception:
    reply = {}
  return "delivered", reply if isinstance(reply, dict) else {}


@router.post("/{gid}/messages/{message_id}/reactions")
async def react_to_group_message(
  gid: str,
  message_id: str,
  body: GroupReaction,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Turn one of the owner's reactions on or off for everyone in a group.

  The update is saved on this copy, as pending, before anything is sent. It
  stays pending, shown and retryable under its id, until the host has it and
  every member it is relayed to has confirmed it. An exact retry re-sends only
  what is still owed; only a definite refusal undoes it here.
  """
  require_nondelegated_owner_control(principal)
  app = _require_member(db, principal)
  _validate_gid(gid)
  if not _GID_RE.fullmatch(message_id):
    raise HTTPException(status_code=400, detail="Message id is invalid.")
  update_id = body.id or str(uuid.uuid4())
  if not isinstance(update_id, str) or not _GID_RE.fullmatch(update_id):
    raise HTTPException(status_code=400, detail="Reaction id is invalid.")
  validate_reaction(body.emoji, body.on, time.time())
  identity = _load_identity()
  own = _own_host()
  if not (_group_dir(app, gid) / "msgs" / f"{message_id}.json").is_file():
    raise HTTPException(status_code=404, detail="Message not found.")

  def begin(saved: dict) -> tuple[bool, tuple[dict, bool]]:
    update, new = begin_own_update(saved, own, body.emoji, body.on, update_id)
    return new, (update, new)

  def settle(outcome: str, detail: str | None = None):
    return lambda saved: (
      settle_own_update(saved, own, body.emoji, update_id, outcome, detail), None,
    )

  async def result(outcome: str, detail: str | None = None, **extra) -> dict:
    record, _ = await _change_group_message(app, gid, message_id, settle(outcome, detail))
    current = ((record or {}).get("reaction_updates") or {}).get(body.emoji)
    if not isinstance(current, dict) or current.get("id") != update_id:
      # A newer update for this reaction replaced this one while it was sent.
      current = {"id": update_id, "pending": False}
    return {**own_update_result(record or {}, current), **extra}

  async with _group_lock(gid):
    with _host_group_transaction(gid):
      group = _load_host_group(gid)
      if group is not None:
        _require_open(group)
        record, begun = await _change_group_message(app, gid, message_id, begin)
        if record is None:
          raise HTTPException(status_code=404, detail="Message not found.")
        update, new = begun
        original = _react_envelope(
          identity, gid, own, message_id, body.emoji, update["on"], update["at"],
          update_id=update_id,
        )
        relays = _queue_reaction_relays(group, original, applied=new)
  if group is not None:
    # Committed before networking, like a hosted post.
    if not update.get("pending"):
      return own_update_result(record, update)
    failed = await _relay_reaction(group, original, relays)
    if failed:
      return await result(
        "uncertain", "Not everyone in the group has this reaction yet. Retry to send it again.",
        failed_members=failed,
      )
    return await result("delivered", failed_members=[])

  meta = _load_group_meta(app, gid)
  if meta is None:
    raise HTTPException(status_code=404, detail="Unknown group.")
  _require_open(meta)
  _require_accepted_group(meta)
  host = meta["host"]
  try:
    host_actor = await _fetch_actor(host)
  except HTTPException as exc:
    raise HTTPException(status_code=502, detail="The group host couldn’t be reached.") from exc
  if not supports_message_reactions(host_actor):
    raise HTTPException(
      status_code=409, detail="This group’s host doesn’t support reactions yet.",
    )
  record, begun = await _change_group_message(app, gid, message_id, begin)
  if record is None:
    raise HTTPException(status_code=404, detail="Message not found.")
  update, _new = begun
  if not update.get("pending"):
    return own_update_result(record, update)
  envelope = _react_envelope(
    identity, gid, host, message_id, body.emoji, update["on"], update["at"],
    update_id=update_id,
  )
  # Never hold the member lock while contacting the host.
  outcome, reply = await _deliver_to_host(host, envelope)
  if outcome == "refused":
    await result("refused")
    raise HTTPException(status_code=409, detail="The group host refused the reaction.")
  if outcome == "uncertain":
    return await result(
      "uncertain", "The group host didn’t confirm this reaction; it may have arrived. Retry to make sure.",
    )
  if reply.get("undelivered"):
    return await result(
      "uncertain", "Not everyone in the group has this reaction yet. Retry to send it again.",
    )
  return await result("delivered")


class GroupEdit(BaseModel):
  text: str
  id: str | None = None


@router.post("/{gid}/messages/{message_id}/edit")
async def edit_group_message(
  gid: str,
  message_id: str,
  body: GroupEdit,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Replace the text of one of the owner's group messages for everyone.

  Saved here first, as pending; it is confirmed once the host and every member
  it relays to have it. Only a definite refusal restores the earlier text.
  """
  require_nondelegated_owner_control(principal)
  app = _require_member(db, principal)
  _validate_gid(gid)
  if not _GID_RE.fullmatch(message_id):
    raise HTTPException(status_code=400, detail="Message id is invalid.")
  edit_id = body.id or str(uuid.uuid4())
  if not isinstance(edit_id, str) or not _GID_RE.fullmatch(edit_id):
    raise HTTPException(status_code=400, detail="Edit id is invalid.")
  validate_edit(body.text, time.time())
  identity = _load_identity()
  own = _own_host()
  path = _group_dir(app, gid) / "msgs" / f"{message_id}.json"
  if not path.is_file():
    raise HTTPException(status_code=404, detail="Message not found.")
  saved = json.loads(path.read_text())
  if saved.get("author") != own:
    raise HTTPException(status_code=403, detail="You can only edit your own messages.")
  if saved.get("status") != "delivered":
    raise HTTPException(status_code=409, detail="Only delivered messages can be edited.")

  def begin(record: dict):
    edit, new = begin_own_edit(record, body.text, edit_id)
    return new, edit

  async def settle(outcome: str, detail: str | None = None) -> dict:
    record, _ = await _change_group_message(
      app, gid, message_id, lambda record: (settle_own_edit(record, edit_id, outcome, detail), None),
    )
    return edit_result(record or {})

  async with _group_lock(gid):
    with _host_group_transaction(gid):
      group = _load_host_group(gid)
      if group is not None:
        _require_open(group)
        record, edit = await _change_group_message(app, gid, message_id, begin)
        if record is None:
          raise HTTPException(status_code=404, detail="Message not found.")
        original = _edit_envelope(
          identity, gid, own, message_id, edit["text"], edit["at"], edit_id=edit_id,
        )
        relays = _edit_relays(group, original)
  if group is not None:
    delivered = await _fan_out(group, relays) if relays else {}
    if any(not delivered.get(host) for host in relays):
      return await settle("uncertain", "Not everyone in the group has this edit yet. Save it again to resend.")
    return await settle("delivered")

  meta = _load_group_meta(app, gid)
  if meta is None:
    raise HTTPException(status_code=404, detail="Unknown group.")
  _require_open(meta)
  _require_accepted_group(meta)
  host = meta["host"]
  try:
    host_actor = await _fetch_actor(host)
  except HTTPException as exc:
    raise HTTPException(status_code=502, detail="The group host couldn’t be reached.") from exc
  if not supports_message_edits(host_actor):
    raise HTTPException(status_code=409, detail="This group’s host doesn’t support edits yet.")
  record, edit = await _change_group_message(app, gid, message_id, begin)
  if record is None:
    raise HTTPException(status_code=404, detail="Message not found.")
  envelope = _edit_envelope(identity, gid, host, message_id, edit["text"], edit["at"], edit_id=edit_id)
  outcome, reply = await _deliver_to_host(host, envelope)
  if outcome == "refused":
    await settle("refused")
    raise HTTPException(status_code=409, detail="The group host refused the edit.")
  if outcome == "uncertain":
    return await settle("uncertain", "The group host didn’t confirm this edit; it may have arrived. Save it again to make sure.")
  if reply.get("undelivered"):
    return await settle("uncertain", "Not everyone in the group has this edit yet. Save it again to resend.")
  return await settle("delivered")


@router.post("/{gid}/send")
async def send_group_message(
  gid: str,
  body: GroupSend,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Send while open; host acceptance serializes with membership and deletion."""
  require_nondelegated_owner_control(principal)
  app = _require_member(db, principal)
  _validate_gid(gid)
  text = body.text.strip()
  attachment = _validate_attachment(body.attachment)
  _validate_text_or_attachment(text, attachment, "Message text is invalid.")
  reply_to = _validate_reply_to(body.reply_to)
  message_id = body.id or str(uuid.uuid4())
  if not isinstance(message_id, str) or not _GID_RE.fullmatch(message_id):
    raise HTTPException(status_code=400, detail="Message id is invalid.")
  intent = {"text": text, "reply_to": reply_to, "attachment": attachment}
  identity = _load_identity()
  sent_at = time.time()
  existing = None

  async with _group_lock(gid):
    with _host_group_transaction(gid):
      group = _load_host_group(gid)
      if group is not None:
        # The host commits before fan-out, so a retry finds the saved post.
        if _own_group_message(app, gid, message_id, **intent) is not None:
          return {"status": "delivered", "id": message_id, "failed_members": []}
        _require_open(group)
        original = _post_envelope(
          identity, gid, _own_host(), message_id=message_id, text=text,
          sent_at=sent_at, attachment=attachment, reply_to=reply_to,
        )
        author_handle = identity.get("handle") or _own_host()
        relays = await _host_commit_post(
          app, group, original=original,
          message_id=message_id, author=_own_host(),
          author_handle=author_handle,
          text=text, sent_at=sent_at, attachment=attachment, reply_to=reply_to,
        )
      else:
        relays = None
    if group is None:
      meta = _load_group_meta(app, gid)
      if meta is None:
        raise HTTPException(status_code=404, detail="Unknown group.")
      existing = _own_group_message(app, gid, message_id, **intent)
      if existing is None:
        _require_open(meta)
        _require_accepted_group(meta)
        envelope = _post_envelope(
          identity, gid, meta["host"], message_id=message_id, text=text,
          sent_at=sent_at, attachment=attachment, reply_to=reply_to,
        )

  if existing is not None:
    # An exact repeat of a saved send settles or retries that one copy.
    return await _retry_saved_group_message(app, gid, message_id)

  if group is not None:
    # The post is committed before networking. Membership or closure may
    # advance concurrently, but cannot erase this accepted local message.
    delivered = await _deliver_committed_host_post(
      db, app, group, author=_own_host(), author_handle=author_handle,
      text=text, relays=relays,
    )
    failed = [host for host, ok in delivered.items() if not ok]
    return {"status": "delivered", "id": message_id, "failed_members": failed}

  # Do not hold a member lock while contacting its host: a simultaneous host
  # deletion needs to deliver its tombstone back here without a lock cycle.
  ok = await _deliver(meta["host"], envelope)
  async with _group_lock(gid):
    current = _load_group_meta(app, gid)
    if current is None:
      raise HTTPException(status_code=404, detail="Unknown group.")
    # A host receipt can precede a closure notice arriving locally. Keep that
    # already-accepted message and the tombstone; only failed sends are refused.
    if not ok:
      _require_open(current)
    record = {
      "id": message_id, "gid": gid, "author": _own_host(),
      "author_handle": identity.get("handle") or _own_host(), "text": text,
      "sent_at": sent_at, "dir": "out",
      "status": "delivered" if ok else "failed",
    }
    if reply_to is not None:
      record["reply_to"] = reply_to
    if not await _store_group_message(app, gid, record, attachment):
      # A concurrent send saved this id first. It must be this same message
      # (409 otherwise); settle that one copy and report its real state.
      saved = _own_group_message(app, gid, message_id, **intent)
      if ok:
        record = await _mark_group_message_delivered(app, gid, message_id)
      elif saved is not None:
        record = saved
  ok = record.get("status") == "delivered"
  detail = None if ok else f"The group host {meta['host']} could not be reached."
  return {
    "status": "delivered" if ok else "failed", "id": message_id, "detail": detail,
    **({"group_deleted": True} if current.get("deleted_at") else {}),
  }


# ── management: creator and admins ──────────────────────────────────────────

_MANAGE_ACTIONS = ("add", "remove", "rename", "set_admin", "set_icon")
_UNSET = object()
_MANAGE_ID_MEMORY = 200
_HOST_UPDATE_NEEDED = (
  "The group creator's Social needs an update before admins can manage this group."
)


class RenameGroup(BaseModel):
  name: str


class SetAdmin(BaseModel):
  host: str
  admin: bool


class SetIcon(BaseModel):
  icon: dict | None = None


def _clean_group_name(value: Any) -> str:
  name = str(value or "").strip()[:MAX_NAME_CHARS]
  if not name:
    raise HTTPException(status_code=400, detail="Give the group a name.")
  return name


def _clean_member_host(value: Any) -> str:
  host = str(value or "").strip().lower()
  if not _valid_host(host):
    raise HTTPException(status_code=400, detail="Invalid member address.")
  return host


async def _discover_handle(host: str, fallback: str = "") -> str:
  try:
    actor = await _fetch_actor(host)
    return str(actor.get("handle") or fallback)[:MAX_NAME_CHARS]
  except HTTPException:
    return fallback[:MAX_NAME_CHARS]  # unreachable now; metadata heals later


def _require_manager(group: dict, actor: str) -> str:
  """The actor's current role, if it may manage (and so see) this group now."""
  role = _member_role(group, actor)
  if role == "creator":
    return role
  if role != "admin" or not _host_member_active(group["members"][actor]):
    raise HTTPException(
      status_code=403,
      detail="Only the group's creator or an admin can manage this group.",
    )
  return role


def _authorize_manage(group: dict, actor: str, action: str, target: str | None) -> None:
  """The creator manages everything; an admin manages ordinary members."""
  if _require_manager(group, actor) == "creator":
    if target == group["host"] and action in ("remove", "set_admin"):
      raise HTTPException(
        status_code=409, detail="The creator's place in the group can't be changed.",
      )
    return
  if action == "set_admin":
    raise HTTPException(status_code=403, detail="Only the group's creator can choose admins.")
  if action == "remove" and target is not None and _member_role(group, target) in (
    "creator", "admin",
  ):
    raise HTTPException(status_code=403, detail="Only the group's creator can remove an admin.")


def _apply_manage(group: dict, actor: str, action: str, *, target: str | None,
                  handle: str, name: str | None, admin: bool | None,
                  icon: Any = _UNSET) -> str:
  """Mutate the authoritative record in place and return the outcome."""
  members = group["members"]
  if action == "add":
    entry = members.get(target)
    if entry is None:
      if len(members) >= MAX_GROUP_MEMBERS:
        raise HTTPException(status_code=400, detail="The group is full.")
      members[target] = {
        "handle": handle, "invited_at": time.time(), "status": "invited",
        "invitation_id": str(uuid.uuid4()), "invitation_version": 1,
      }
      return "added"
    if entry.get("status") in _GONE_STATES:
      entry.pop("removed_at", None)
      entry.pop("removed_by", None)
      entry.update(
        status="invited", invited_at=time.time(),
        handle=handle or entry.get("handle") or "",
        invitation_id=str(uuid.uuid4()),
        invitation_version=int(entry.get("invitation_version") or 1) + 1,
      )
      return "reinvited"
    return "already_member"
  if action == "remove":
    entry = members.get(target)
    if entry is None or entry.get("status") in _GONE_STATES:
      return "not_member"
    entry.pop("role", None)
    entry.update(status="removed", removed_at=time.time(), removed_by=actor)
    return "removed"
  if action == "rename":
    if name == group["name"]:
      return "unchanged"
    group["name"] = name
    return "renamed"
  if action == "set_icon":
    current = _icon_wire(group.get("icon"))
    if icon == current:
      return "unchanged"
    if icon is None:
      group.pop("icon", None)
      return "icon_removed"
    group["icon"] = icon
    return "icon_set"
  # set_admin
  entry = members.get(target)
  if entry is None or not _host_member_active(entry):
    raise HTTPException(
      status_code=409, detail="Only someone who has joined the group can be an admin.",
    )
  if (entry.get("role") == "admin") == admin:
    return "unchanged"
  if admin:
    entry["role"] = "admin"
    return "admin_added"
  entry.pop("role", None)
  return "admin_removed"


async def _host_manage(
  app, gid: str, actor: str, action: str, *, target: str | None = None,
  handle: str = "", name: str | None = None, admin: bool | None = None,
  icon: Any = _UNSET, request_id: str | None = None, skip: str | None = None,
) -> tuple[dict, dict[str, dict]]:
  """Authorize and commit one change on the host; return (receipt, deliveries).

  Callers hold the group lifecycle lock and deliver outside the transaction.
  `skip` is the requesting admin, who receives the roster in the reply rather
  than a refresh it would have to accept while still waiting on this host.
  """
  with _host_group_transaction(gid):
    group = _load_host_group(gid)
    if group is None:
      raise HTTPException(status_code=404, detail="Unknown group.")
    _require_open(group)
    seen = group.get("manage_ids") or []
    # Remembered per sender: one sender can never replay another's request id.
    remembered = f"{actor} {request_id}" if request_id is not None else None
    if remembered is not None and remembered in seen:
      # Nothing changes twice, but the reply still shows the group, so the
      # sender must be allowed to manage it now, not merely when first asked.
      _require_manager(group, actor)
      return {"status": "duplicate", **_roster_view(group)}, {}
    _authorize_manage(group, actor, action, target)
    status = _apply_manage(
      group, actor, action, target=target, handle=handle, name=name, admin=admin,
      icon=icon,
    )
    changed = status not in ("already_member", "not_member", "unchanged")
    if changed:
      group["roster_revision"] = _roster_revision(group) + 1
    if remembered is not None:
      group["manage_ids"] = (seen + [remembered])[-_MANAGE_ID_MEMORY:]
    if changed or remembered is not None:
      atomic_write(_host_group_path(gid), json.dumps(group, indent=2))
    view = _roster_view(group)
    await _store_group_meta(app, gid, view)
    identity = _load_identity()
    deliveries: dict[str, dict] = {}
    # Adding someone who is already a member deliberately retries delivery.
    if changed or action == "add":
      for member, entry in group["members"].items():
        if member in (_own_host(), skip) or entry.get("status") in _GONE_STATES:
          continue
        deliveries[member] = _added_envelope(identity, group, member)
    if status == "removed":
      deliveries[target] = _signed({
        "v": 0, "type": "group_removed", "id": str(uuid.uuid4()),
        "from": _own_host(), "to": target, "gid": gid,
        "group_name": group["name"],
        "invitation_version": int(group["members"][target].get("invitation_version") or 1),
        "sent_at": time.time(),
      }, identity)
  icon_hash = _icon_hash(view["icon"]["data_b64"]) if view["icon"] else None
  return {"status": status, **view, "icon_hash": icon_hash}, deliveries


async def _host_accept_manage(app, gid: str, envelope: dict) -> dict:
  """An admin's signed request; the host's own roster decides if it is allowed."""
  request_id = envelope.get("id")
  if not isinstance(request_id, str) or not _GID_RE.fullmatch(request_id):
    raise HTTPException(status_code=400, detail="Request id is invalid.")
  action = envelope.get("action")
  if action not in _MANAGE_ACTIONS:
    raise HTTPException(status_code=400, detail="Unsupported group change.")
  fields: dict[str, Any] = {}
  if action in ("add", "remove", "set_admin"):
    fields["target"] = _clean_member_host(envelope.get("member"))
  if action == "rename":
    fields["name"] = _clean_group_name(envelope.get("name"))
  if action == "set_icon":
    # Re-encode on the host too: a member's bytes never reach others unchecked.
    fields["icon"] = _render_group_icon(envelope.get("icon"))
  if action == "set_admin":
    if not isinstance(envelope.get("admin"), bool):
      raise HTTPException(status_code=400, detail="Admin choice is invalid.")
    fields["admin"] = envelope["admin"]
  if action == "add":
    fields["handle"] = await _discover_handle(
      fields["target"], str(envelope.get("handle") or ""),
    )
  sender = envelope["from"]
  receipt, deliveries = await _host_manage(
    app, gid, sender, action, request_id=request_id, skip=sender, **fields,
  )
  delivered = await _fan_out({}, deliveries)
  return {**receipt, "delivered": delivered}


def _parse_roster(members: Any) -> list[dict]:
  if not isinstance(members, list) or len(members) > MAX_GROUP_MEMBERS:
    raise HTTPException(status_code=400, detail="Member list is invalid.")
  roster = {}
  for member in members:
    if not isinstance(member, dict) or not _valid_host(member.get("host") or ""):
      raise HTTPException(status_code=400, detail="Member list is invalid.")
    entry = {
      "host": member["host"],
      "handle": str(member.get("handle") or "")[:MAX_NAME_CHARS],
    }
    if member.get("role") in ("creator", "admin"):
      entry["role"] = member["role"]
    roster[member["host"]] = entry
  return list(roster.values())


async def _store_host_roster(app, gid: str, host: str, reply: dict) -> bool:
  """Save the host's reply to an admin unless a newer roster already arrived."""
  try:
    members = _parse_roster(reply.get("members"))
    name = _clean_group_name(reply.get("name"))
  except HTTPException:
    return False
  revision = _roster_revision(reply)
  async with fs_locks.app_storage_lock(app.id):
    path = _group_dir(app, gid) / "meta.json"
    if not path.is_file():
      return False
    meta = json.loads(path.read_text())
    if meta.get("host") != host or revision < _roster_revision(meta):
      return False
    meta.update(members=members, name=name, roster_revision=revision)
    if "icon" in reply:
      _write_member_icon(app, gid, meta, _received_icon(reply["icon"]))
    atomic_write(path, json.dumps(meta))
    _bump_version(app)
    return True


def _own_role(meta: dict) -> str:
  for member in meta.get("members") or []:
    if isinstance(member, dict) and member.get("host") == _own_host():
      return member.get("role") or "member"
  return "none"


async def _request_manage(app, gid: str, action: str, **fields) -> dict:
  """Ask the remote host to apply an admin's change, then save its roster."""
  meta = _load_group_meta(app, gid)
  if meta is None:
    raise HTTPException(status_code=404, detail="Group not found.")
  _require_open(meta)
  _require_accepted_group(meta)
  host = meta.get("host")
  if not _valid_host(host or "") or host == _own_host():
    raise HTTPException(status_code=409, detail="Group host is invalid.")
  if action == "set_admin":
    raise HTTPException(status_code=403, detail="Only the group's creator can choose admins.")
  if _own_role(meta) != "admin":
    raise HTTPException(
      status_code=403,
      detail="Only the group's creator or an admin can manage this group.",
    )
  body = {
    "v": 0, "type": "group_manage", "id": str(uuid.uuid4()),
    "from": _own_host(), "to": host, "gid": gid, "action": action,
    "sent_at": time.time(),
  }
  if fields.get("target") is not None:
    body["member"] = fields["target"]
  if fields.get("handle"):
    body["handle"] = fields["handle"]
  if fields.get("name") is not None:
    body["name"] = fields["name"]
  if "icon" in fields:
    body["icon"] = fields["icon"]
  envelope = _signed(body, _load_identity())
  try:
    response = await _post_signed_envelope(
      _peer_service_url(host, "groups/inbox"), envelope,
      max_response_bytes=MAX_ENVELOPE_BYTES,
    )
    response.raise_for_status()
  except httpx.HTTPStatusError as exc:
    code = exc.response.status_code
    try:
      detail = str(exc.response.json().get("detail") or "")
    except Exception:
      detail = ""
    if code == 400 and detail in ("Unsupported envelope type.", "Unsupported group change."):
      raise HTTPException(status_code=409, detail=_HOST_UPDATE_NEEDED) from exc
    if 400 <= code < 500 and code not in (408, 429):
      raise HTTPException(
        status_code=code, detail=detail or "The group's creator refused this change.",
      ) from exc
    raise HTTPException(
      status_code=502,
      detail="The group's creator couldn't confirm this change. Check the members and try again.",
    ) from exc
  except Exception as exc:
    raise HTTPException(
      status_code=502,
      detail="The group's creator couldn't be reached. Check the members and try again.",
    ) from exc
  try:
    reply = response.json()
  except Exception:
    reply = {}
  if not isinstance(reply, dict):
    reply = {}
  await _store_host_roster(app, gid, host, reply)
  saved = _load_group_meta(app, gid) or meta
  return {
    "status": reply.get("status") or "updated",
    "name": saved.get("name"), "members": saved.get("members") or [],
    "icon_hash": saved.get("icon_hash"),
    "roster_revision": _roster_revision(saved),
    "delivered": reply.get("delivered") if isinstance(reply.get("delivered"), dict) else {},
  }


async def _manage(app, gid: str, action: str, **fields) -> dict:
  """Apply locally when this instance hosts the group, otherwise ask its host."""
  _validate_gid(gid)
  if _load_host_group(gid) is not None:
    async with _group_lock(gid):
      receipt, deliveries = await _host_manage(app, gid, _own_host(), action, **fields)
    delivered = await _fan_out({}, deliveries)
    return {**receipt, "delivered": delivered}
  # Never hold the lifecycle lock across a call to the host, which may be
  # delivering a roster refresh to this instance at the same moment.
  return await _request_manage(app, gid, action, **fields)


@router.post("/{gid}/members")
async def add_group_member(
  gid: str,
  body: AddMember,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Add one deployment, or retry its current roster delivery, without history."""
  require_nondelegated_owner_control(principal)
  app = _require_member(db, principal)
  host = _clean_member_host(body.host)
  handle = await _discover_handle(host, body.handle or "")
  return await _manage(app, gid, "add", target=host, handle=handle)


@router.delete("/{gid}/members/{member}")
async def remove_group_member(
  gid: str,
  member: str,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Remove someone from future messages; their copy of the history stays theirs."""
  require_nondelegated_owner_control(principal)
  app = _require_member(db, principal)
  return await _manage(app, gid, "remove", target=_clean_member_host(member))


@router.patch("/{gid}")
async def rename_group(
  gid: str,
  body: RenameGroup,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  require_nondelegated_owner_control(principal)
  app = _require_member(db, principal)
  return await _manage(app, gid, "rename", name=_clean_group_name(body.name))


@router.put("/{gid}/icon")
async def set_group_icon(
  gid: str,
  body: SetIcon,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Set or clear the group's picture; members get it with the next roster refresh."""
  require_nondelegated_owner_control(principal)
  app = _require_member(db, principal)
  return await _manage(app, gid, "set_icon", icon=_render_group_icon(body.icon))


@router.post("/{gid}/admins")
async def set_group_admin(
  gid: str,
  body: SetAdmin,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """The creator appoints or demotes an admin."""
  require_nondelegated_owner_control(principal)
  app = _require_member(db, principal)
  return await _manage(
    app, gid, "set_admin", target=_clean_member_host(body.host), admin=body.admin,
  )


@router.delete("/{gid}")
async def delete_group(
  gid: str,
  db: object = Depends(get_db),
  principal: Principal = Depends(get_principal),
):
  """Close the host-owned group durably; never erase a member's local history."""
  require_nondelegated_owner_control(principal)
  app = _require_member(db, principal)
  _validate_gid(gid)
  async with _group_lock(gid):
    with _host_group_transaction(gid):
      group = _load_host_group(gid)
      if group is None:
        raise HTTPException(status_code=404, detail="Only the group's host can delete it.")
      if not group.get("deleted_at"):
        group["deleted_at"] = time.time()
        atomic_write(_host_group_path(gid), json.dumps(group, indent=2))
      await _store_group_meta(app, gid, {
        "deleted_at": group["deleted_at"], "unread": 0,
      })
      identity = _load_identity()
      tombstones = {
        member: _signed({
          "v": 0, "type": "group_deleted", "id": str(uuid.uuid4()),
          "from": _own_host(), "to": member, "gid": gid,
          "group_name": group["name"], "sent_at": time.time(),
        }, identity)
        for member in group["members"] if member != _own_host()
      }
  delivered = await _fan_out(group, tombstones)
  return {"status": "deleted", "delivered": delivered}
