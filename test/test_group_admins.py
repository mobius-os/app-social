"""Group roles: the creator and admins manage a group through its host."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import HTTPException

os.environ.setdefault("APP_STORAGE_DIR", "/tmp/social-group-admin-tests")
os.environ.setdefault("APP_ID", "7")
os.environ.setdefault("APP_SLUG", "social")

import service_runtime
import social_groups

GID = "deadbeef-0000-4000-8000-000000000001"
HOST = "self.example"


def manage_envelope(sender, action, request_id="11111111-1111-4111-8111-111111111111", **fields):
  return {"v": 0, "type": "group_manage", "id": request_id, "from": sender,
          "to": HOST, "gid": GID, "action": action, "sent_at": 1, **fields}


class GroupRoleTests(unittest.IsolatedAsyncioTestCase):
  def setUp(self):
    self.temporary = tempfile.TemporaryDirectory()
    self.addCleanup(self.temporary.cleanup)
    root = Path(self.temporary.name)
    self.storage = root / "app"
    self.storage.mkdir(parents=True)
    self.common = root / "common"
    self.common.mkdir()
    for patcher in (
      patch.dict(os.environ, {"APP_STORAGE_DIR": str(self.storage), "INSTANCE_DOMAIN": HOST, "INSTANCE_ORIGIN": f"https://{HOST}"}),
      patch.object(service_runtime, "STORAGE", self.storage),
      patch.object(social_groups, "_common_dir", lambda: self.common),
      patch.object(social_groups, "_load_identity", lambda **_: {"private_key_b64": "", "joined_at": 1}),
      patch.object(social_groups, "_sign", lambda envelope, key: "signature"),
      patch.object(social_groups, "_fetch_actor", AsyncMock(side_effect=HTTPException(502))),
    ):
      patcher.start()
      self.addCleanup(patcher.stop)
    self.fan_out = AsyncMock(side_effect=lambda group, envelopes: {h: True for h in envelopes})
    patcher = patch.object(social_groups, "_fan_out", self.fan_out)
    patcher.start()
    self.addCleanup(patcher.stop)
    self.app = SimpleNamespace(id=7, slug="social")
    self.write_group({
      HOST: {"handle": "creator", "status": "active"},
      "admin.example": {"handle": "ada", "status": "active", "role": "admin"},
      "member.example": {"handle": "mo", "status": "active", "invitation_version": 1},
      "other.example": {"handle": "ola", "status": "active"},
    })

  def write_group(self, members, **extra):
    path = social_groups._host_group_path(GID)
    path.write_text(json.dumps({
      "id": GID, "name": "Friends", "host": HOST, "created_at": 1,
      "members": members, **extra,
    }))

  def group(self):
    return social_groups._load_host_group(GID)

  def delivered_types(self):
    envelopes = self.fan_out.await_args.args[1]
    return {host: envelope["type"] for host, envelope in envelopes.items()}

  async def test_creator_appoints_an_admin_and_everyone_learns_the_role(self):
    receipt = await social_groups._manage(
      self.app, GID, "set_admin", target="member.example", admin=True,
    )

    self.assertEqual(receipt["status"], "admin_added")
    roles = {m["host"]: m.get("role", "member") for m in receipt["members"]}
    self.assertEqual(roles, {
      HOST: "creator", "admin.example": "admin",
      "member.example": "admin", "other.example": "member",
    })
    self.assertEqual(receipt["roster_revision"], 1)
    sent = self.fan_out.await_args.args[1]
    self.assertEqual(set(sent), {"admin.example", "member.example", "other.example"})
    self.assertEqual(sent["other.example"]["roster_revision"], 1)
    self.assertEqual(
      json.loads((self.storage / "groups" / GID / "meta.json").read_text())["roster_revision"], 1,
    )

  async def test_an_admin_adds_someone_and_receives_the_roster_in_the_reply(self):
    reply = await social_groups._host_accept_manage(
      self.app, GID, manage_envelope("admin.example", "add", member="new.example"),
    )

    self.assertEqual(reply["status"], "added")
    self.assertIn("new.example", {m["host"] for m in reply["members"]})
    self.assertEqual(self.group()["members"]["new.example"]["status"], "invited")
    # The requesting admin is waiting on this reply, so it gets no refresh.
    self.assertNotIn("admin.example", self.delivered_types())
    self.assertEqual(self.delivered_types()["new.example"], "group_added")

  async def test_an_admin_can_rename_and_remove_an_ordinary_member(self):
    renamed = await social_groups._host_accept_manage(
      self.app, GID, manage_envelope("admin.example", "rename", name="  Best friends "),
    )
    removed = await social_groups._host_accept_manage(
      self.app, GID, manage_envelope(
        "admin.example", "remove", "22222222-2222-4222-8222-222222222222",
        member="member.example",
      ),
    )

    self.assertEqual(renamed["name"], "Best friends")
    self.assertEqual(removed["status"], "removed")
    self.assertNotIn("member.example", {m["host"] for m in removed["members"]})
    self.assertEqual(self.delivered_types()["member.example"], "group_removed")
    record = self.group()["members"]["member.example"]
    self.assertEqual((record["status"], record["removed_by"]), ("removed", "admin.example"))
    self.assertEqual(self.group()["roster_revision"], 2)

  async def test_only_the_creator_chooses_admins_or_removes_them(self):
    self.write_group({
      HOST: {"handle": "creator", "status": "active"},
      "admin.example": {"handle": "ada", "status": "active", "role": "admin"},
      "second.example": {"handle": "sam", "status": "active", "role": "admin"},
      "member.example": {"handle": "mo", "status": "active"},
    })
    refused = [
      ("set_admin", {"member": "member.example", "admin": True}),
      ("remove", {"member": "second.example"}),
      ("remove", {"member": HOST}),
    ]
    for index, (action, fields) in enumerate(refused):
      with self.subTest(action=action, fields=fields):
        with self.assertRaises(HTTPException) as raised:
          await social_groups._host_accept_manage(self.app, GID, manage_envelope(
            "admin.example", action, f"3333333{index}-3333-4333-8333-333333333333", **fields,
          ))
        self.assertEqual(raised.exception.status_code, 403)
    self.assertEqual(self.group()["members"]["second.example"]["role"], "admin")
    self.assertNotIn("role", self.group()["members"]["member.example"])

  async def test_ordinary_and_removed_members_cannot_manage(self):
    self.write_group({
      HOST: {"handle": "creator", "status": "active"},
      "member.example": {"handle": "mo", "status": "active"},
      "gone.example": {"handle": "gus", "status": "removed", "role": "admin"},
    })
    for sender in ("member.example", "gone.example", "stranger.example"):
      with self.subTest(sender=sender):
        with self.assertRaises(HTTPException) as raised:
          await social_groups._host_accept_manage(
            self.app, GID, manage_envelope(sender, "rename", name="Taken"),
          )
        self.assertEqual(raised.exception.status_code, 403)
    self.assertEqual(self.group()["name"], "Friends")

  async def test_the_creator_cannot_be_removed_or_demoted(self):
    for action, fields in (("remove", {}), ("set_admin", {"admin": False})):
      with self.subTest(action=action):
        with self.assertRaises(HTTPException) as raised:
          await social_groups._manage(self.app, GID, action, target=HOST, **fields)
        self.assertEqual(raised.exception.status_code, 409)

  async def test_a_replayed_admin_request_changes_nothing_twice(self):
    envelope = manage_envelope("admin.example", "remove", member="member.example")
    await social_groups._host_accept_manage(self.app, GID, envelope)
    await social_groups._manage(self.app, GID, "add", target="member.example")
    self.assertEqual(self.group()["members"]["member.example"]["status"], "invited")

    replay = await social_groups._host_accept_manage(self.app, GID, envelope)

    self.assertEqual(replay["status"], "duplicate")
    self.assertEqual(self.group()["members"]["member.example"]["status"], "invited")

  async def test_a_removed_member_can_no_longer_post(self):
    await social_groups._manage(self.app, GID, "remove", target="member.example")

    with self.assertRaises(HTTPException) as raised:
      await social_groups._accept_group_envelope(None, self.app, {
        "v": 0, "type": "group_post", "id": "44444444-4444-4444-8444-444444444444",
        "from": "member.example", "to": HOST, "gid": GID, "text": "still here?",
        "sent_at": 1,
      }, {"handle": "mo"})
    self.assertEqual(raised.exception.status_code, 403)

  async def test_re_adding_a_removed_member_sends_a_newer_invitation(self):
    await social_groups._manage(self.app, GID, "remove", target="member.example")
    receipt = await social_groups._manage(self.app, GID, "add", target="member.example")

    self.assertEqual(receipt["status"], "reinvited")
    record = self.group()["members"]["member.example"]
    self.assertEqual((record["status"], record["invitation_version"]), ("invited", 2))
    self.assertNotIn("removed_at", record)


  async def test_a_replay_from_a_removed_admin_reveals_nothing(self):
    rename = manage_envelope("admin.example", "rename", name="Ours")
    await social_groups._host_accept_manage(self.app, GID, rename)
    await social_groups._manage(self.app, GID, "remove", target="admin.example")
    await social_groups._manage(self.app, GID, "add", target="later.example")
    self.fan_out.reset_mock()

    with self.assertRaises(HTTPException) as raised:
      await social_groups._host_accept_manage(self.app, GID, rename)

    self.assertEqual(raised.exception.status_code, 403)
    self.fan_out.assert_not_awaited()

  async def test_remembered_request_ids_belong_to_their_sender(self):
    self.write_group({
      HOST: {"handle": "creator", "status": "active"},
      "admin.example": {"handle": "ada", "status": "active", "role": "admin"},
      "second.example": {"handle": "sam", "status": "active", "role": "admin"},
    })
    await social_groups._host_accept_manage(
      self.app, GID, manage_envelope("admin.example", "rename", name="First"),
    )

    # The same id from another admin is that admin's own, new request.
    reply = await social_groups._host_accept_manage(
      self.app, GID, manage_envelope("second.example", "rename", name="Second"),
    )

    self.assertEqual((reply["status"], self.group()["name"]), ("renamed", "Second"))

  async def test_repeating_a_removal_resends_its_notice_without_reinviting(self):
    await social_groups._manage(self.app, GID, "remove", target="member.example")
    first = self.fan_out.await_args.args[1]["member.example"]

    receipt = await social_groups._manage(self.app, GID, "remove", target="member.example")

    self.assertEqual(receipt["status"], "already_removed")
    again = self.fan_out.await_args.args[1]["member.example"]
    self.assertEqual(again["type"], "group_removed")
    self.assertEqual(again["invitation_version"], first["invitation_version"])
    record = self.group()["members"]["member.example"]
    self.assertEqual((record["status"], record["invitation_version"]), ("removed", 1))
    self.assertNotIn("member.example", {m["host"] for m in receipt["members"]})
    self.assertEqual(self.group()["roster_revision"], 1)

  async def test_repeating_an_applied_change_retries_the_roster_refresh(self):
    await social_groups._manage(self.app, GID, "rename", target=None, name="Ours")
    self.fan_out.reset_mock()

    receipt = await social_groups._manage(self.app, GID, "rename", target=None, name="Ours")

    self.assertEqual(receipt["status"], "unchanged")
    self.assertEqual(self.delivered_types(), {
      "admin.example": "group_added", "member.example": "group_added",
      "other.example": "group_added",
    })

  async def test_a_duplicate_admin_request_retries_delivery(self):
    envelope = manage_envelope("admin.example", "rename", name="Ours")
    await social_groups._host_accept_manage(self.app, GID, envelope)
    self.fan_out.reset_mock()

    replay = await social_groups._host_accept_manage(self.app, GID, envelope)

    self.assertEqual((replay["status"], replay["name"]), ("duplicate", "Ours"))
    self.assertEqual(set(self.delivered_types()), {"member.example", "other.example"})

class MemberCopyTests(unittest.IsolatedAsyncioTestCase):
  def setUp(self):
    self.temporary = tempfile.TemporaryDirectory()
    self.addCleanup(self.temporary.cleanup)
    self.storage = Path(self.temporary.name) / "app"
    self.storage.mkdir(parents=True)
    for patcher in (
      patch.dict(os.environ, {"APP_STORAGE_DIR": str(self.storage), "INSTANCE_DOMAIN": HOST, "INSTANCE_ORIGIN": f"https://{HOST}"}),
      patch.object(service_runtime, "STORAGE", self.storage),
      patch.object(social_groups, "_load_identity", lambda **_: {"private_key_b64": "", "joined_at": 1}),
      patch.object(social_groups, "_sign", lambda envelope, key: "signature"),
    ):
      patcher.start()
      self.addCleanup(patcher.stop)
    self.app = SimpleNamespace(id=7, slug="social")
    self.path = self.storage / "groups" / GID / "meta.json"
    self.path.parent.mkdir(parents=True)

  def write_meta(self, **meta):
    self.path.write_text(json.dumps({
      "gid": GID, "host": "creator.example", "name": "Friends",
      "invitation_id": "same-invite", "invitation_version": 1,
      "request_status": "accepted", "unread": 0, **meta,
    }))

  def meta(self):
    return json.loads(self.path.read_text())

  async def roster(self, version=1, invitation="same-invite", **updates):
    return await social_groups._apply_member_group_lifecycle(
      self.app, GID, "creator.example", "group_added",
      {"invitation_id": invitation, "invitation_version": version, **updates},
      invitation_id=invitation, invitation_version=version,
    )

  async def test_an_older_roster_cannot_undo_a_newer_one(self):
    self.write_meta(name="New name", roster_revision=3,
                    members=[{"host": HOST, "role": "admin"}])

    status = await self.roster(name="Old name", roster_revision=2, members=[{"host": HOST}])

    self.assertEqual(status, "updated")
    self.assertEqual(self.meta()["name"], "New name")
    self.assertEqual(self.meta()["members"], [{"host": HOST, "role": "admin"}])

  async def test_removal_keeps_history_and_survives_a_delayed_refresh(self):
    self.write_meta(unread=2)

    removed = await social_groups._apply_member_group_lifecycle(
      self.app, GID, "creator.example", "group_removed", {}, invitation_version=1,
    )
    delayed = await self.roster(roster_revision=9, members=[{"host": HOST}])

    self.assertEqual((removed, delayed), ("removed", "stale"))
    self.assertTrue(self.meta()["removed_at"])
    self.assertEqual(self.meta()["unread"], 0)
    with self.assertRaises(HTTPException) as raised:
      social_groups._require_open(self.meta())
    self.assertEqual(raised.exception.status_code, 410)

  async def test_a_newer_invitation_reopens_a_removed_group_as_a_request(self):
    self.write_meta(removed_at=5)

    status = await self.roster(version=2, invitation="newer-invite")

    self.assertEqual(status, "pending")
    self.assertNotIn("removed_at", self.meta())
    self.assertEqual(self.meta()["request_status"], "pending")

  async def test_a_delayed_removal_cannot_undo_a_later_invitation(self):
    self.write_meta(invitation_id="newer-invite", invitation_version=2)

    status = await social_groups._apply_member_group_lifecycle(
      self.app, GID, "creator.example", "group_removed", {}, invitation_version=1,
    )

    self.assertEqual(status, "stale")
    self.assertNotIn("removed_at", self.meta())

  async def test_only_an_admin_copy_forwards_management_to_the_host(self):
    self.write_meta(members=[{"host": HOST}])
    with self.assertRaises(HTTPException) as raised:
      await social_groups._request_manage(self.app, GID, "rename", name="Ours")
    self.assertEqual(raised.exception.status_code, 403)

  async def test_an_older_host_is_reported_as_needing_an_update(self):
    self.write_meta(members=[{"host": HOST, "role": "admin"}])
    request = httpx.Request("POST", "https://creator.example/inbox")
    refused = httpx.Response(400, json={"detail": "Unsupported envelope type."}, request=request)

    async def post(url, envelope, **_):
      self.assertEqual((envelope["type"], envelope["action"]), ("group_manage", "rename"))
      return refused

    with patch.object(social_groups, "_post_signed_envelope", post):
      with self.assertRaises(HTTPException) as raised:
        await social_groups._request_manage(self.app, GID, "rename", name="Ours")
    self.assertEqual(raised.exception.status_code, 409)
    self.assertIn("needs an update", raised.exception.detail)
    self.assertEqual(self.meta()["name"], "Friends")

  async def test_an_admin_saves_the_hosts_roster_from_the_reply(self):
    self.write_meta(members=[{"host": HOST, "role": "admin"}], roster_revision=1)
    reply = {
      "status": "renamed", "name": "Ours", "roster_revision": 2,
      "members": [{"host": "creator.example", "role": "creator"}, {"host": HOST, "role": "admin"}],
      "delivered": {"creator.example": True},
    }

    async def post(url, envelope, **_):
      return httpx.Response(200, json=reply, request=httpx.Request("POST", url))

    with patch.object(social_groups, "_post_signed_envelope", post):
      receipt = await social_groups._request_manage(self.app, GID, "rename", name="Ours")

    self.assertEqual((receipt["status"], receipt["name"]), ("renamed", "Ours"))
    self.assertEqual(self.meta()["roster_revision"], 2)
    self.assertEqual(self.meta()["name"], "Ours")


if __name__ == "__main__":
  unittest.main()
