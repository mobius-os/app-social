"""A client-minted group message id makes an interrupted send safely retryable."""

import contextlib
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

import service_runtime
import social_groups
from service_runtime import Principal

GID = "deadbeef"
MESSAGE_ID = "0b6f4d2e-5c1a-4e8b-9f3d-2a7c6e1b9d40"
OWNER = Principal("owner", None, None)


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


if __name__ == "__main__":
  unittest.main()
