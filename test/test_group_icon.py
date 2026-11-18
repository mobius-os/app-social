"""Group pictures: the creator or an admin sets one; every member's copy follows."""

import base64
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from PIL import Image

os.environ.setdefault("APP_STORAGE_DIR", "/tmp/social-group-icon-tests")
os.environ.setdefault("APP_ID", "7")
os.environ.setdefault("APP_SLUG", "social")

import service_runtime
import social_groups

GID = "deadbeef-0000-4000-8000-0000000000aa"
HOST = "self.example"


def image_wire(size=(600, 400), mime="image/png", noisy=False):
  image = Image.new("RGB", size, (200, 80, 40))
  if noisy:
    image = Image.frombytes("RGB", size, os.urandom(size[0] * size[1] * 3))
  out = io.BytesIO()
  image.save(out, format={"image/png": "PNG", "image/gif": "GIF"}[mime])
  return {"mime": mime, "data_b64": base64.b64encode(out.getvalue()).decode(),
          "w": size[0], "h": size[1]}


class GroupIconTests(unittest.IsolatedAsyncioTestCase):
  def setUp(self):
    self.temporary = tempfile.TemporaryDirectory()
    self.addCleanup(self.temporary.cleanup)
    root = Path(self.temporary.name)
    self.storage = root / "app"
    self.storage.mkdir()
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
    social_groups._host_group_path(GID).write_text(json.dumps({
      "id": GID, "name": "Friends", "host": HOST, "created_at": 1, "members": {
        HOST: {"handle": "creator", "status": "active"},
        "admin.example": {"handle": "ada", "status": "active", "role": "admin"},
        "member.example": {"handle": "mo", "status": "active"},
      },
    }))

  def group_dir(self):
    return self.storage / "groups" / GID

  async def test_the_creator_sets_a_small_picture_and_every_member_receives_it(self):
    receipt = await social_groups._manage(
      self.app, GID, "set_icon", icon=social_groups._render_group_icon(image_wire()),
    )

    self.assertEqual(receipt["status"], "icon_set")
    icon = social_groups._load_host_group(GID)["icon"]
    self.assertEqual(icon["mime"], "image/webp")
    self.assertLessEqual(max(icon["w"], icon["h"]), 128)
    self.assertLessEqual(len(base64.b64decode(icon["data_b64"])), social_groups.MAX_GROUP_ICON_BYTES)
    sent = self.fan_out.await_args.args[1]
    self.assertEqual(set(sent), {"admin.example", "member.example"})
    for envelope in sent.values():
      self.assertEqual(envelope["type"], "group_added")
      self.assertEqual(envelope["group_icon"]["data_b64"], icon["data_b64"])
      # Still a control envelope that older members accept.
      self.assertLess(len(json.dumps(envelope)), social_groups.MAX_ENVELOPE_BYTES)
    meta = json.loads((self.group_dir() / "meta.json").read_text())
    saved = json.loads((self.group_dir() / "icon.json").read_text())
    self.assertEqual(meta["icon_hash"], saved["hash"])
    self.assertEqual(receipt["icon_hash"], saved["hash"])

  async def test_an_admin_can_set_the_picture_but_an_ordinary_member_cannot(self):
    wire = social_groups._render_group_icon(image_wire())
    reply = await social_groups._host_accept_manage(self.app, GID, {
      "v": 0, "type": "group_manage", "id": "11111111-1111-4111-8111-1111111111aa",
      "from": "admin.example", "to": HOST, "gid": GID, "action": "set_icon",
      "icon": wire, "sent_at": 1,
    })
    self.assertEqual(reply["status"], "icon_set")
    self.assertIsNotNone(reply["icon"])

    with self.assertRaises(HTTPException) as raised:
      await social_groups._host_accept_manage(self.app, GID, {
        "v": 0, "type": "group_manage", "id": "11111111-1111-4111-8111-1111111111ab",
        "from": "member.example", "to": HOST, "gid": GID, "action": "set_icon",
        "icon": None, "sent_at": 1,
      })
    self.assertEqual(raised.exception.status_code, 403)
    self.assertIn("icon", social_groups._load_host_group(GID))

  async def test_clearing_the_picture_reaches_members_as_an_explicit_null(self):
    await social_groups._manage(self.app, GID, "set_icon", icon=social_groups._render_group_icon(image_wire()))
    receipt = await social_groups._manage(self.app, GID, "set_icon", icon=None)

    self.assertEqual(receipt["status"], "icon_removed")
    self.assertNotIn("icon", social_groups._load_host_group(GID))
    sent = self.fan_out.await_args.args[1]
    self.assertTrue(all(e["group_icon"] is None for e in sent.values()))
    self.assertFalse((self.group_dir() / "icon.json").exists())
    self.assertNotIn("icon_hash", json.loads((self.group_dir() / "meta.json").read_text()))

  def test_animated_or_detailed_images_are_handled(self):
    with self.assertRaises(HTTPException):
      social_groups._render_group_icon(image_wire((40, 40), mime="image/gif"))
    detailed = social_groups._render_group_icon(image_wire((900, 900), noisy=True))
    self.assertLessEqual(len(base64.b64decode(detailed["data_b64"])), social_groups.MAX_GROUP_ICON_BYTES)

  async def test_a_member_saves_the_hosts_picture_and_keeps_it_when_an_old_host_omits_it(self):
    wire = social_groups._render_group_icon(image_wire())
    base = {"gid": GID, "name": "Friends", "host": "host.example", "members": [],
            "invitation_id": "22222222-2222-4222-8222-2222222222aa", "invitation_version": 1}
    await social_groups._apply_member_group_lifecycle(
      self.app, GID, "host.example", "group_added", {**base, "roster_revision": 1, "icon": wire},
      invitation_id=base["invitation_id"], invitation_version=1,
    )
    digest = json.loads((self.group_dir() / "meta.json").read_text())["icon_hash"]
    # An older host's refresh has no picture field at all: keep what we have.
    await social_groups._apply_member_group_lifecycle(
      self.app, GID, "host.example", "group_added", {**base, "roster_revision": 2},
      invitation_id=base["invitation_id"], invitation_version=1,
    )
    self.assertEqual(json.loads((self.group_dir() / "meta.json").read_text())["icon_hash"], digest)
    # A delayed, older refresh can't bring back a removed picture.
    await social_groups._apply_member_group_lifecycle(
      self.app, GID, "host.example", "group_added", {**base, "roster_revision": 3, "icon": None},
      invitation_id=base["invitation_id"], invitation_version=1,
    )
    await social_groups._apply_member_group_lifecycle(
      self.app, GID, "host.example", "group_added", {**base, "roster_revision": 2, "icon": wire},
      invitation_id=base["invitation_id"], invitation_version=1,
    )
    self.assertFalse((self.group_dir() / "icon.json").exists())

  def test_a_member_ignores_an_unusable_picture(self):
    self.assertIsNone(social_groups._received_icon({"mime": "image/gif", "data_b64": "R0lGODlh", "w": 1, "h": 1}))
    self.assertIsNone(social_groups._received_icon("nope"))
    big = image_wire((300, 300), noisy=True)
    self.assertIsNone(social_groups._received_icon(big))


if __name__ == "__main__":
  unittest.main()
