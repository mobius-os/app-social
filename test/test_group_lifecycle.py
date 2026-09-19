"""Transactional member-side group lifecycle contracts."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("APP_STORAGE_DIR", "/tmp/social-group-lifecycle-tests")
os.environ.setdefault("APP_ID", "7")
os.environ.setdefault("APP_SLUG", "social")

import service_runtime
import social_groups


class MemberGroupLifecycleTests(unittest.IsolatedAsyncioTestCase):
  def setUp(self):
    self.temporary = tempfile.TemporaryDirectory()
    self.addCleanup(self.temporary.cleanup)
    self.storage = Path(self.temporary.name) / "app"
    self.storage.mkdir(parents=True)
    self.environment = patch.dict(os.environ, {
      "APP_STORAGE_DIR": str(self.storage),
      "INSTANCE_DOMAIN": "self.example",
    })
    self.environment.start()
    self.addCleanup(self.environment.stop)
    self.storage_owner = patch.object(service_runtime, "STORAGE", self.storage)
    self.storage_owner.start()
    self.addCleanup(self.storage_owner.stop)
    self.app = SimpleNamespace(id=7, slug="social")

  async def test_delayed_roster_refresh_cannot_undo_owner_acceptance(self):
    gid = "deadbeef"
    path = self.storage / "groups" / gid / "meta.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({
      "gid": gid, "host": "host.example", "name": "Friends",
      "invitation_id": "11111111", "invitation_version": 1,
      "request_status": "accepted", "request_count": 0, "unread": 0,
    }))

    status = await social_groups._apply_member_group_lifecycle(
      self.app, gid, "host.example", "group_added", {
        "gid": gid, "host": "host.example", "name": "Friends",
        "members": [{"host": "self.example", "handle": "me"}],
        "invitation_id": "11111111", "invitation_version": 1,
      }, invitation_id="11111111", invitation_version=1,
    )

    saved = json.loads(path.read_text())
    self.assertEqual(status, "updated")
    self.assertEqual(saved["request_status"], "accepted")
    self.assertEqual(saved["request_count"], 0)

  async def test_older_roster_callback_cannot_replace_newer_invitation(self):
    gid = "deadbeef"
    path = self.storage / "groups" / gid / "meta.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({
      "gid": gid, "host": "host.example", "name": "Friends",
      "invitation_id": "22222222", "invitation_version": 2,
      "request_status": "pending", "members": [{"host": "new.example"}],
    }))

    status = await social_groups._apply_member_group_lifecycle(
      self.app, gid, "host.example", "group_added", {
        "members": [{"host": "old.example"}],
        "invitation_id": "11111111", "invitation_version": 1,
      }, invitation_id="11111111", invitation_version=1,
    )

    saved = json.loads(path.read_text())
    self.assertEqual(status, "stale")
    self.assertEqual(saved["invitation_version"], 2)
    self.assertEqual(saved["members"], [{"host": "new.example"}])

  async def test_owner_decision_cannot_apply_to_a_replaced_invitation(self):
    gid = "deadbeef"
    path = self.storage / "groups" / gid / "meta.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({
      "gid": gid, "host": "host.example", "name": "Friends",
      "invitation_id": "new-invite", "invitation_version": 2,
      "request_status": "pending",
    }))

    with self.assertRaises(Exception) as raised:
      await social_groups._transition_member_group_request(
        self.app, gid, "host.example", "old-invite", "accepted",
      )

    self.assertEqual(getattr(raised.exception, "status_code", None), 409)
    self.assertEqual(json.loads(path.read_text())["request_status"], "pending")

  async def test_owner_acceptance_and_roster_refresh_converge_to_accepted(self):
    gid = "deadbeef"
    path = self.storage / "groups" / gid / "meta.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({
      "gid": gid, "host": "host.example", "name": "Friends",
      "invitation_id": "same-invite", "invitation_version": 1,
      "request_status": "pending", "request_count": 1,
    }))

    await social_groups._transition_member_group_request(
      self.app, gid, "host.example", "same-invite", "accepted",
    )
    await social_groups._apply_member_group_lifecycle(
      self.app, gid, "host.example", "group_added", {
        "invitation_id": "same-invite", "invitation_version": 1,
        "members": [{"host": "self.example"}],
      }, invitation_id="same-invite", invitation_version=1,
    )

    saved = json.loads(path.read_text())
    self.assertEqual(saved["request_status"], "accepted")
    self.assertEqual(saved["members"], [{"host": "self.example"}])


if __name__ == "__main__":
  unittest.main()
