"""A client-minted group message id makes an interrupted send safely retryable."""

import base64
import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ.setdefault("APP_STORAGE_DIR", "/tmp/social-group-send-retry-tests")
os.environ.setdefault("APP_ID", "7")
os.environ.setdefault("APP_SLUG", "social")

from fastapi import HTTPException
from PIL import Image

import service_runtime
import social_groups
from service_runtime import Principal

GID = "deadbeef"
MESSAGE_ID = "0b6f4d2e-5c1a-4e8b-9f3d-2a7c6e1b9d40"
OWNER = Principal("owner", None, None)


def photo():
  output = io.BytesIO()
  Image.new("RGB", (4, 3), (200, 40, 90)).save(output, format="PNG")
  return {"mime": "image/png", "w": 4, "h": 3,
          "data_b64": base64.b64encode(output.getvalue()).decode()}


class GroupSendRetryTests(unittest.IsolatedAsyncioTestCase):
  def setUp(self):
    temporary = tempfile.TemporaryDirectory()
    self.addCleanup(temporary.cleanup)
    self.storage = Path(temporary.name) / "app"
    self.storage.mkdir(parents=True)
    self.app = SimpleNamespace(id=7, slug="social")
    self.host_group = None
    self.delivered = True
    for patcher in (
      patch.dict(os.environ, {"APP_STORAGE_DIR": str(self.storage)}),
      patch.object(service_runtime, "STORAGE", self.storage),
      patch.object(social_groups, "_require_member", return_value=self.app),
      patch.object(social_groups, "_own_host", return_value="self.example"),
      patch.object(social_groups, "_load_identity", return_value={"handle": "me"}),
      patch.object(social_groups, "_host_group_transaction",
                   side_effect=lambda gid: contextlib.nullcontext()),
      patch.object(social_groups, "_load_host_group", side_effect=lambda gid: self.host_group),
      patch.object(social_groups, "_post_envelope",
                   side_effect=lambda *args, **fields: {"type": "group_post", **fields}),
      patch.object(social_groups, "_relay_envelope",
                   side_effect=lambda *args, **fields: {"type": "group_message"}),
    ):
      patcher.start()
      self.addCleanup(patcher.stop)
    self.deliver = AsyncMock(side_effect=lambda host, envelope: self.delivered)
    deliver = patch.object(social_groups, "_deliver", new=self.deliver)
    deliver.start()
    self.addCleanup(deliver.stop)

  def member_of(self, host="host.example"):
    meta = self.storage / "groups" / GID / "meta.json"
    meta.parent.mkdir(parents=True)
    meta.write_text(json.dumps({
      "gid": GID, "host": host, "name": "Friends", "request_status": "accepted",
    }))

  def saved(self):
    folder = self.storage / "groups" / GID / "msgs"
    return [json.loads(path.read_text()) for path in sorted(folder.glob("*.json"))]

  async def send(self, text="Hello", message_id=MESSAGE_ID, **fields):
    return await social_groups.send_group_message(GID, social_groups.GroupSend(
      id=message_id, text=text, **fields), db=None, principal=OWNER)

  async def test_member_retry_after_failure_redelivers_the_one_saved_post(self):
    self.member_of()
    self.delivered = False
    first = await self.send()
    self.assertEqual((first["status"], first["id"]), ("failed", MESSAGE_ID))
    sent_at = self.saved()[0]["sent_at"]

    self.delivered = True
    retried = await self.send()

    self.assertEqual((retried["status"], retried["id"]), ("delivered", MESSAGE_ID))
    self.assertEqual([(m["id"], m["status"]) for m in self.saved()], [(MESSAGE_ID, "delivered")])
    self.assertEqual(self.saved()[0]["sent_at"], sent_at)
    # The host sees the same identity and original time, so it deduplicates.
    sent = [call.args[1] for call in self.deliver.await_args_list]
    self.assertEqual({(e["message_id"], e["sent_at"]) for e in sent}, {(MESSAGE_ID, sent_at)})

  async def test_member_retry_of_a_delivered_post_is_idempotent_without_networking(self):
    self.member_of()
    await self.send()
    self.deliver.reset_mock()

    again = await self.send()

    self.assertEqual((again["status"], again["id"]), ("delivered", MESSAGE_ID))
    self.deliver.assert_not_awaited()
    self.assertEqual(len(self.saved()), 1)

  async def test_host_retry_returns_the_committed_post_without_a_second_fan_out(self):
    self.host_group = {"id": GID, "name": "Friends", "host": "self.example", "members": {
      "self.example": {"handle": "me"}, "friend.example": {"handle": "friend"},
    }}
    with patch.object(social_groups, "_fan_out",
                      new=AsyncMock(return_value={"friend.example": True})) as fan_out:
      first = await self.send()
      again = await self.send()

    self.assertEqual((first["id"], again["id"]), (MESSAGE_ID, MESSAGE_ID))
    self.assertEqual(again["status"], "delivered")
    self.assertEqual(fan_out.await_count, 1)
    self.assertEqual(len(self.saved()), 1)

  async def test_reusing_an_id_for_different_content_or_author_is_rejected(self):
    self.member_of()
    await self.send()
    for change in ({"text": "Something else"}, {"reply_to": {
      "id": "abcdef12", "author_handle": "friend", "excerpt": "Hi",
    }}):
      with self.subTest(change=change), self.assertRaises(HTTPException) as caught:
        await self.send(**{"text": "Hello", **change})
      self.assertEqual(caught.exception.status_code, 409)

    other = self.storage / "groups" / GID / "msgs" / "abcdef12-0000.json"
    other.write_text(json.dumps({
      "id": "abcdef12-0000", "gid": GID, "author": "friend.example", "text": "Hello",
      "dir": "in", "status": "delivered", "sent_at": 1,
    }))
    with self.assertRaises(HTTPException) as caught:
      await self.send(message_id="abcdef12-0000")
    self.assertEqual(caught.exception.status_code, 409)
    self.assertEqual(len(self.saved()), 2)

  async def test_client_ids_are_validated_and_omitted_ids_are_minted(self):
    self.member_of()
    for invalid in ("short", "../../escape", "ABCDEF12", "x" * 80):
      with self.subTest(invalid=invalid), self.assertRaises(HTTPException) as caught:
        await self.send(message_id=invalid)
      self.assertEqual(caught.exception.status_code, 400)
    self.assertFalse((self.storage / "groups" / GID / "msgs").exists())

    minted = await self.send(message_id=None)
    self.assertRegex(minted["id"], social_groups._GID_RE)
    self.assertEqual([m["id"] for m in self.saved()], [minted["id"]])


  def test_retry_route_mirrors_the_direct_message_retry_route(self):
    routes = {(route.path, tuple(route.methods)) for route in social_groups.router.routes}
    self.assertIn(("/groups/{gid}/messages/{message_id}/retry", ("POST",)), routes)

  async def retry(self, message_id=MESSAGE_ID):
    return await social_groups.retry_group_message(
      GID, message_id, db=None, principal=OWNER)

  async def test_failed_photo_retries_from_the_saved_copy_to_one_delivered_post(self):
    self.member_of()
    self.delivered = False
    image = photo()
    reply = {"id": "abcdef12", "author_handle": "friend", "excerpt": "Hi"}
    first = await self.send(text="Look", attachment=image, reply_to=reply)
    self.assertEqual(first["status"], "failed")
    saved = self.saved()[0]
    self.assertEqual((saved["status"], saved["attachment"]["mime"]), ("failed", "image/png"))

    self.delivered = True
    retried = await self.retry()

    self.assertEqual((retried["status"], retried["id"]), ("delivered", MESSAGE_ID))
    self.assertEqual([(m["id"], m["status"]) for m in self.saved()], [(MESSAGE_ID, "delivered")])
    # The host receives the identical post: same id, time, text, reply and photo bytes.
    envelope = self.deliver.await_args_list[-1].args[1]
    self.assertEqual(envelope["message_id"], MESSAGE_ID)
    self.assertEqual(envelope["sent_at"], saved["sent_at"])
    self.assertEqual((envelope["text"], envelope["reply_to"]), ("Look", reply))
    wire, data = envelope["attachment"]
    self.assertEqual(data, base64.b64decode(image["data_b64"]))
    self.assertEqual((wire["mime"], wire["w"], wire["h"]), ("image/png", 4, 3))

  async def test_retry_that_still_fails_keeps_one_failed_copy(self):
    self.member_of()
    self.delivered = False
    await self.send()
    result = await self.retry()
    self.assertEqual(result["status"], "failed")
    self.assertIn("host.example", result["detail"])
    self.assertEqual([(m["id"], m["status"]) for m in self.saved()], [(MESSAGE_ID, "failed")])

  async def test_retrying_a_delivered_post_is_a_no_op(self):
    self.member_of()
    await self.send()
    self.deliver.reset_mock()
    result = await self.retry()
    self.assertEqual((result["status"], result["id"]), ("delivered", MESSAGE_ID))
    self.deliver.assert_not_awaited()
    self.assertEqual(len(self.saved()), 1)

  async def test_only_the_owners_own_outgoing_post_can_be_retried(self):
    self.member_of()
    folder = self.storage / "groups" / GID / "msgs"
    folder.mkdir(parents=True)
    for message_id, author, direction in (
      ("abcdef12-0001", "friend.example", "in"),
      ("abcdef12-0002", "self.example", "in"),
    ):
      (folder / f"{message_id}.json").write_text(json.dumps({
        "id": message_id, "gid": GID, "author": author, "text": "Hi",
        "dir": direction, "status": "failed", "sent_at": 1,
      }))
      with self.subTest(message_id=message_id), self.assertRaises(HTTPException) as caught:
        await self.retry(message_id)
      self.assertEqual(caught.exception.status_code, 403)
    with self.assertRaises(HTTPException) as caught:
      await self.retry("abcdef12-0404")
    self.assertEqual(caught.exception.status_code, 404)
    with self.assertRaises(HTTPException) as caught:
      await self.retry("../escape")
    self.assertEqual(caught.exception.status_code, 400)
    self.deliver.assert_not_awaited()
    self.assertEqual({m["status"] for m in self.saved()}, {"failed"})

  async def test_delivered_upgrade_rechecks_ownership_under_the_lock(self):
    self.member_of()
    folder = self.storage / "groups" / GID / "msgs"
    folder.mkdir(parents=True)
    (folder / "abcdef12-0001.json").write_text(json.dumps({
      "id": "abcdef12-0001", "gid": GID, "author": "friend.example", "text": "Hi",
      "dir": "in", "status": "failed", "sent_at": 1,
    }))
    with self.assertRaises(HTTPException):
      await social_groups._mark_group_message_delivered(self.app, GID, "abcdef12-0001")
    self.assertEqual(self.saved()[0]["status"], "failed")


if __name__ == "__main__":
  unittest.main()
