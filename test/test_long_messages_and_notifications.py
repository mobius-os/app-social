"""Long private messages across versions, and Social's notification contract."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import HTTPException

os.environ.setdefault("APP_STORAGE_DIR", "/tmp/social-long-message-tests")
os.environ.setdefault("APP_ID", "7")
os.environ.setdefault("APP_SLUG", "social")

import common_protocol
import service_runtime
import social_routes


class _StreamRequest:
  def __init__(self, body: bytes):
    self._body = body

  async def stream(self):
    yield self._body


def _envelope_request(envelope: dict) -> _StreamRequest:
  return _StreamRequest(json.dumps(envelope).encode())


class MessageLengthContractTests(unittest.IsolatedAsyncioTestCase):
  def test_private_messages_allow_slack_length_but_posts_stay_short(self):
    validate = common_protocol.validate_text_or_attachment
    validate("x" * 40_000, None, "bad", max_chars=common_protocol.MAX_MESSAGE_TEXT_CHARS)
    with self.assertRaises(HTTPException):
      validate("x" * 40_001, None, "bad", max_chars=common_protocol.MAX_MESSAGE_TEXT_CHARS)
    with self.assertRaises(HTTPException):
      validate("x" * 4001, None, "bad", max_chars=common_protocol.MAX_POST_TEXT_CHARS)

  def test_peer_cards_without_limits_are_treated_as_legacy(self):
    limit = common_protocol.message_text_limit
    self.assertEqual(limit({}), 4000)
    self.assertEqual(limit({"limits": {"message_text_chars": True}}), 4000)
    self.assertEqual(limit({"limits": {"message_text_chars": 40_000}}), 40_000)

  async def test_long_text_envelopes_pass_the_bounded_reader(self):
    long_message = {"v": 0, "type": "message", "text": "é" * 40_000}
    self.assertEqual(
      (await common_protocol.read_envelope(_envelope_request(long_message)))["type"],
      "message",
    )
    control = {"v": 0, "type": "board_activity", "pad": "x" * 40_000}
    with self.assertRaises(HTTPException) as caught:
      await common_protocol.read_envelope(_envelope_request(control))
    self.assertEqual(caught.exception.status_code, 413)

  async def test_overflow_is_confirmed_against_a_fresh_peer_card(self):
    verifier = common_protocol.ActorVerifier("/unused")
    cards = {False: {}, True: {"limits": {"message_text_chars": 40_000}}}
    fetch = AsyncMock(side_effect=lambda _host, force=False: cards[force])
    with patch.object(verifier, "fetch_actor", new=fetch):
      self.assertIsNone(await verifier.message_text_overflow("peer.example", 3000))
      fetch.assert_not_awaited()
      self.assertIsNone(await verifier.message_text_overflow("peer.example", 9000))
    self.assertEqual(fetch.await_count, 2)


class LegacyPeerDeliveryTests(unittest.IsolatedAsyncioTestCase):
  def setUp(self):
    self.temporary = tempfile.TemporaryDirectory()
    self.addCleanup(self.temporary.cleanup)
    storage = Path(self.temporary.name) / "app"
    storage.mkdir(parents=True)
    environment = patch.dict(social_routes.os.environ, {
      "APP_STORAGE_DIR": str(storage),
      "INSTANCE_DOMAIN": "self.example",
      "INSTANCE_ORIGIN": "https://self.example",
      "API_BASE_URL": "http://127.0.0.1:9",
    })
    environment.start()
    self.addCleanup(environment.stop)
    owner = patch.object(service_runtime, "STORAGE", storage)
    owner.start()
    self.addCleanup(owner.stop)
    self.app = SimpleNamespace(id=7, slug="social")

  async def _deliver(self, text: str, overflow):
    message_id = "44444444-4444-4444-8444-444444444444"
    await social_routes._persist_outgoing_message(None, self.app, "old.example", {
      "id": message_id, "dir": "out", "peer": "old.example",
      "peer_handle": "alex", "text": text, "sent_at": 1.0, "status": "sending",
    }, None)
    post = AsyncMock(return_value=httpx.Response(
      200, json={"status": "delivered"},
      request=httpx.Request("POST", "https://old.example/inbox"),
    ))
    with (
      patch.object(social_routes, "_fetch_actor", new=AsyncMock(return_value={})),
      patch.object(social_routes, "_message_text_overflow", new=overflow),
      patch.object(social_routes, "_load_identity", return_value={"private_key_b64": "unused"}),
      patch.object(social_routes, "_sign", return_value="signature"),
      patch.object(social_routes, "_post_signed_envelope", new=post),
    ):
      record = await social_routes._attempt_direct_delivery(
        self.app, "old.example", message_id,
      )
    return record, post

  async def test_a_legacy_peer_gets_a_clear_retryable_failure_not_a_400(self):
    record, post = await self._deliver("x" * 9000, AsyncMock(return_value=4000))
    post.assert_not_awaited()
    self.assertEqual(record["status"], "failed")
    self.assertIn("@alex can receive up to 4,000 characters", record["failure"])

  async def test_an_updated_peer_receives_the_long_message(self):
    record, post = await self._deliver("x" * 9000, AsyncMock(return_value=None))
    post.assert_awaited_once()
    self.assertEqual(record["status"], "delivered")


class NotificationTests(unittest.IsolatedAsyncioTestCase):
  def test_preview_is_one_calm_line_cut_on_a_word(self):
    preview = social_routes._message_preview
    self.assertEqual(preview("  Hey\n\nthere  "), "Hey there")
    self.assertEqual(preview(" \n "), "📷 Photo")
    long = preview("word " * 60)
    self.assertTrue(long.endswith("…"))
    self.assertLessEqual(len(long), 120)
    self.assertNotIn("  ", long)
    self.assertFalse(long[:-1].endswith(" "))

  async def test_notifications_deep_link_into_social(self):
    sent = AsyncMock(return_value=httpx.Response(200, json={"id": 1}))
    with patch.object(service_runtime, "platform_request", new=sent):
      await service_runtime.notify("t", "b", intent="dm:peer.example")
      await service_runtime.notify("t", "b", intent="dm:bad host")
    targets = [call.kwargs["json_body"]["target"] for call in sent.await_args_list]
    app_id = service_runtime.APP.id
    self.assertEqual(targets, [
      f"/shell/?app={app_id}&intent=dm:peer.example", f"/shell/?app={app_id}",
    ])

  async def test_a_refused_notification_is_logged_not_lost_silently(self):
    refused = AsyncMock(return_value=httpx.Response(429, json={}))
    with (
      patch.object(service_runtime, "platform_request", new=refused),
      self.assertLogs("social.notify", level="WARNING"),
    ):
      await service_runtime.notify("Message from @a", "hi")

  async def test_only_the_community_host_can_report_board_activity(self):
    envelope = {
      "v": 0, "type": "board_activity", "post_id": "abcdef12", "kind": "like",
      "actor": "liker.example", "actor_handle": "liker",
      "from": "impostor.example", "to": "self.example", "sent_at": 1.0,
    }
    notify = AsyncMock()
    with (
      patch.dict(social_routes.os.environ, {
        "INSTANCE_DOMAIN": "self.example",
        "INSTANCE_ORIGIN": "https://self.example",
        "API_BASE_URL": "http://127.0.0.1:9",
      }),
      patch.object(social_routes, "_read_envelope", new=AsyncMock(return_value=envelope)),
      patch.object(social_routes, "_verify_peer_envelope", new=AsyncMock(return_value={})),
      patch.object(social_routes, "notify", new=notify),
    ):
      with self.assertRaises(HTTPException) as caught:
        await social_routes.receive_board_activity(None)
      self.assertEqual(caught.exception.status_code, 403)
      notify.assert_not_awaited()

      envelope["from"] = social_routes.COMMUNITY_HOST
      await social_routes.receive_board_activity(None)
    notify.assert_awaited_once()
    self.assertEqual(notify.await_args.kwargs["intent"], "board")


if __name__ == "__main__":
  unittest.main()
