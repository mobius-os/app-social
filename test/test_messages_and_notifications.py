"""Message length, envelope bounds, and notification contracts."""

import json
import os
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import HTTPException

os.environ.setdefault("APP_STORAGE_DIR", "/tmp/social-message-tests")
os.environ.setdefault("APP_ID", "7")
os.environ.setdefault("APP_SLUG", "social")

import common_protocol
import service_runtime
import social_routes


class _Body:
  def __init__(self, envelope: dict):
    self._body = json.dumps(envelope).encode()

  async def stream(self):
    yield self._body


class MessageLengthTests(unittest.IsolatedAsyncioTestCase):
  def test_messages_allow_40000_characters_and_posts_4000(self):
    validate = common_protocol.validate_text_or_attachment
    validate("x" * 40_000, None, "bad")
    with self.assertRaises(HTTPException):
      validate("x" * 40_001, None, "bad")
    with self.assertRaises(HTTPException):
      validate("x" * 4001, None, "bad", common_protocol.MAX_POST_TEXT_CHARS)

  async def test_content_envelopes_may_be_large_but_control_envelopes_may_not(self):
    message = {"v": 0, "type": "message", "text": "é" * 40_000}
    self.assertEqual((await common_protocol.read_envelope(_Body(message)))["text"], message["text"])
    control = {"v": 0, "type": "board_activity", "pad": "x" * 40_000}
    with self.assertRaises(HTTPException) as caught:
      await common_protocol.read_envelope(_Body(control))
    self.assertEqual(caught.exception.status_code, 413)


class NotificationTests(unittest.IsolatedAsyncioTestCase):
  async def test_a_notification_opens_its_conversation(self):
    send = AsyncMock(return_value=httpx.Response(
      200, request=httpx.Request("POST", "http://platform/api/notifications/send"),
    ))
    with patch.object(service_runtime, "platform_request", new=send):
      await service_runtime.notify("Message from @a", "hi", "dm:peer.example:8443")
    self.assertEqual(
      send.await_args.kwargs["json_body"]["target"],
      f"/shell/?app={service_runtime.APP.id}&intent=dm:peer.example:8443",
    )

  async def test_a_refused_notification_is_logged(self):
    refused = AsyncMock(return_value=httpx.Response(
      429, request=httpx.Request("POST", "http://platform/api/notifications/send"),
    ))
    with (
      patch.object(service_runtime, "platform_request", new=refused),
      self.assertLogs("social", level="WARNING"),
    ):
      await service_runtime.notify("Message from @a", "hi", "dm:peer.example")

  async def test_only_the_community_host_reports_board_activity(self):
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
      envelope["from"] = social_routes.COMMUNITY_HOST
      await social_routes.receive_board_activity(None)
    notify.assert_awaited_once()
    self.assertEqual(notify.await_args.args[2], "board")


if __name__ == "__main__":
  unittest.main()
