"""Message length, envelope bounds, and notification contracts."""

import asyncio
import json
import os
import tempfile
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


class ReplyReadTests(unittest.IsolatedAsyncioTestCase):
  async def test_public_reply_read_does_not_create_an_identity_or_claim_a_viewer(self):
    peer = AsyncMock(return_value=httpx.Response(200, json={"replies": []},
      request=httpx.Request("GET", "https://community.example/replies")))
    with (
      patch.object(social_routes, "_require_owner_or_common_app"),
      patch.object(social_routes, "_joined_for_federation", return_value=False),
      patch.object(social_routes, "_load_identity") as identity,
      patch.object(social_routes, "federation_request", new=peer),
    ):
      await social_routes.get_replies_for_owner("abcdef12", db=None, principal=None)
    identity.assert_not_called()
    self.assertEqual(peer.await_args.args[0], "GET")
    self.assertNotIn("params", peer.await_args.kwargs)

  async def test_members_sign_reply_reads_and_only_legacy_hosts_fall_back_to_public_counts(self):
    for status in (200, 404, 405, 403, 500):
      with self.subTest(status=status):
        replies = [{"id": f"reply-{index}", "text": "🦋" * 1000} for index in range(200)]
        response = httpx.Response(status, json={"replies": replies},
          request=httpx.Request("POST", "https://community.example/replies"))
        signed = AsyncMock(return_value=response)
        public = AsyncMock(return_value=httpx.Response(200, json={"replies": []},
          request=httpx.Request("GET", "https://community.example/replies")))
        with (
          patch.object(social_routes, "_require_owner_or_common_app"),
          patch.object(social_routes, "_joined_for_federation", return_value=True),
          patch.object(social_routes, "_load_identity", return_value={"private_key_b64": "fixture"}),
          patch.object(social_routes, "_sign", return_value="fixture-signature"),
          patch.object(social_routes, "_own_host", return_value="self.example"),
          patch.object(social_routes, "_post_signed_envelope", new=signed),
          patch.object(social_routes, "federation_request", new=public),
        ):
          if status in (403, 500):
            with self.assertRaises(HTTPException) as caught:
              await social_routes.get_replies_for_owner("abcdef12", db=None, principal=None)
            self.assertEqual(caught.exception.status_code, 502)
          else:
            await social_routes.get_replies_for_owner("abcdef12", db=None, principal=None)
        envelope = signed.await_args.args[1]
        self.assertEqual((envelope["type"], envelope["from"], envelope["post_id"]),
                         ("board_replies", "self.example", "abcdef12"))
        self.assertNotIn("viewer", envelope)
        self.assertGreater(len(response.content), social_routes.MAX_ENVELOPE_BYTES)
        self.assertGreater(signed.await_args.kwargs["max_response_bytes"], len(response.content))
        self.assertEqual(public.await_count, int(status in (404, 405)))
        if public.await_count:
          self.assertNotIn("params", public.await_args.kwargs)


class NotificationTests(unittest.IsolatedAsyncioTestCase):
  async def test_a_notification_opens_and_groups_by_its_conversation(self):
    send = AsyncMock(return_value=httpx.Response(
      200, request=httpx.Request("POST", "http://platform/api/notifications/send"),
    ))
    with patch.object(service_runtime, "platform_request", new=send):
      await service_runtime.notify("Message from @a", "hi", "dm:peer.example:8443")
    sent = send.await_args.kwargs["json_body"]
    self.assertEqual(
      sent["target"], f"/shell/?app={service_runtime.APP.id}&intent=dm:peer.example:8443",
    )
    self.assertEqual(sent["tag"], "dm:peer.example:8443")

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
    notify = AsyncMock(return_value=True)
    with tempfile.TemporaryDirectory() as directory:
      with (
        patch.dict(social_routes.os.environ, {
          "INSTANCE_DOMAIN": "self.example",
          "INSTANCE_ORIGIN": "https://self.example",
          "API_BASE_URL": "http://127.0.0.1:9",
        }),
        patch.object(social_routes, "_read_envelope", new=AsyncMock(return_value=envelope)),
        patch.object(social_routes, "_verify_peer_envelope", new=AsyncMock(return_value={})),
        patch.object(social_routes, "notify", new=notify),
        patch.object(social_routes, "_data_dir", return_value=directory),
      ):
        with self.assertRaises(HTTPException) as caught:
          await social_routes.receive_board_activity(None)
        self.assertEqual(caught.exception.status_code, 403)
        envelope["from"] = social_routes.COMMUNITY_HOST
        await social_routes.receive_board_activity(None)
    notify.assert_awaited_once()
    self.assertEqual(notify.await_args.args[2], "board:abcdef12")

  async def test_reaction_activity_replay_and_exact_reply_intent(self):
    envelope = {
      "v": 0, "type": "board_activity", "post_id": "abcdef12",
      "reply_id": "abcdef34", "kind": "like", "emoji": "🎉",
      "activity_id": "first", "actor": "liker.example",
      "actor_handle": "liker", "from": social_routes.COMMUNITY_HOST,
      "to": "self.example", "sent_at": 1.0,
    }
    sent = AsyncMock(return_value=True)
    with tempfile.TemporaryDirectory() as directory:
      with (
        patch.object(social_routes, "_data_dir", return_value=directory),
        patch.object(social_routes, "_own_host", return_value="self.example"),
        patch.object(social_routes, "_read_envelope", new=AsyncMock(return_value=envelope)),
        patch.object(social_routes, "_verify_peer_envelope", new=AsyncMock(return_value={})),
        patch.object(social_routes, "notify", new=sent),
      ):
        await social_routes.receive_board_activity(None)
        await social_routes.receive_board_activity(None)
        self.assertEqual(sent.await_count, 1)
        self.assertEqual(sent.await_args.args[1], "@liker reacted 🎉 to your reply")
        self.assertEqual(sent.await_args.args[2], "board:abcdef12:abcdef34")
        envelope["activity_id"] = "second"
        await social_routes.receive_board_activity(None)
        self.assertEqual(sent.await_count, 2)
        envelope["activity_id"] = "failed"
        sent.return_value = False
        await social_routes.receive_board_activity(None)
        sent.return_value = True
        await social_routes.receive_board_activity(None)
        self.assertEqual(sent.await_count, 4)

  def test_every_emoji_is_preserved_in_legacy_compatible_activity_wording(self):
    for emoji in social_routes.BOARD_REACTION_EMOJIS:
      if emoji in social_routes.BOARD_REACTION_NAMES:
        continue
      self.assertEqual(social_routes._activity_line("like", "peer.example", "peer", emoji),
                       f"@peer reacted {emoji} to your post")
      self.assertEqual(social_routes._activity_line("like", "peer.example", "peer", emoji, "abcdef34"),
                       f"@peer reacted {emoji} to your reply")
    self.assertEqual(social_routes._activity_line("like", "peer.example", "peer"), "@peer liked your post")
    self.assertEqual(social_routes._activity_line("like", "peer.example", "peer", ":mobius:"),
                     "@peer reacted with the Möbius logo to your post")
    # A newer host's reaction this version cannot name is still announced.
    self.assertEqual(social_routes._activity_line("like", "peer.example", "peer", ":future:"),
                     "@peer reacted to your post")
    self.assertEqual(social_routes._activity_line("reply", "peer.example", "peer", reply_id="abcdef34"),
                     "@peer replied to your post")

  async def test_activity_announces_reactions_newer_than_this_version(self):
    envelope = {
      "v": 0, "type": "board_activity", "post_id": "abcdef12", "kind": "like",
      "activity_id": "newer", "actor": "liker.example", "actor_handle": "liker",
      "from": social_routes.COMMUNITY_HOST, "to": "self.example", "sent_at": 1.0,
    }
    sent = AsyncMock(return_value=True)
    with tempfile.TemporaryDirectory() as directory:
      with (
        patch.object(social_routes, "_data_dir", return_value=directory),
        patch.object(social_routes, "_own_host", return_value="self.example"),
        patch.object(social_routes, "_read_envelope", new=AsyncMock(return_value=envelope)),
        patch.object(social_routes, "_verify_peer_envelope", new=AsyncMock(return_value={})),
        patch.object(social_routes, "notify", new=sent),
      ):
        for activity_id, emoji, line in (
          ("logo", ":mobius:", "@liker reacted with the Möbius logo to your post"),
          ("newer", ":not-yet-known:", "@liker reacted to your post"),
        ):
          envelope.update(activity_id=activity_id, emoji=emoji)
          await social_routes.receive_board_activity(None)
          self.assertEqual(sent.await_args.args[1], line)
        for invalid in ("", "has space", "x" * 33, "bad\x00", 7):
          envelope.update(activity_id=f"invalid-{invalid!r}", emoji=invalid)
          with self.assertRaises(HTTPException) as caught:
            await social_routes.receive_board_activity(None)
          self.assertEqual(caught.exception.status_code, 400)
    self.assertEqual(sent.await_count, 2)

  async def test_activity_accepts_only_the_host_emitted_protocol_kinds(self):
    envelope = {
      "v": 0, "type": "board_activity", "post_id": "abcdef12", "kind": "reaction",
      "emoji": "🎉", "from": social_routes.COMMUNITY_HOST, "to": "self.example",
    }
    with (
      patch.object(social_routes, "_read_envelope", new=AsyncMock(return_value=envelope)),
      patch.object(social_routes, "_own_host", return_value="self.example"),
      patch.object(social_routes, "notify", new=AsyncMock()) as sent,
    ):
      with self.assertRaises(HTTPException) as caught:
        await social_routes.receive_board_activity(None)
    self.assertEqual(caught.exception.status_code, 400)
    sent.assert_not_awaited()

  async def test_reply_receipt_exposes_the_canonical_signed_id(self):
    peer = AsyncMock(return_value=httpx.Response(200, json={"status": "ok", "reply_count": 1},
                     request=httpx.Request("POST", "https://community.example/board/reply")))
    with (
      patch.object(social_routes, "_require_member"),
      patch.object(social_routes, "_load_identity", return_value={"handle": "owner", "private_key_b64": "fixture"}),
      patch.object(social_routes, "_require_username"),
      patch.object(social_routes, "_sign", return_value="fixture-signature"),
      patch.object(social_routes, "_own_host", return_value="self.example"),
      patch.object(social_routes, "_post_signed_envelope", new=peer),
    ):
      result = await social_routes.reply_to_post(social_routes.ReplyPost(post_id="abcdef12", text="hello"),
                  db=None, principal=service_runtime.Principal("owner", None, None))
    self.assertEqual(result["id"], peer.await_args.args[1]["id"])
    self.assertEqual(result["reply_count"], 1)

  async def test_photo_reply_refuses_host_without_advertised_capability(self):
    attachment = {"mime": "image/png", "data_b64": "eA==", "w": 1, "h": 1}
    response = httpx.Response(200, json={"posts": [], "capabilities": {}},
                              request=httpx.Request("GET", "https://community.example/board"))
    send = AsyncMock()
    with (
      patch.object(social_routes, "_require_member"),
      patch.object(social_routes, "_load_identity", return_value={"handle": "owner", "private_key_b64": "fixture"}),
      patch.object(social_routes, "_require_username"),
      patch.object(social_routes, "federation_request", new=AsyncMock(return_value=response)),
      patch.object(social_routes, "_post_signed_envelope", new=send),
    ):
      with self.assertRaises(HTTPException) as caught:
        await social_routes.reply_to_post(
          social_routes.ReplyPost(post_id="abcdef12", text="", attachment=attachment),
          db=None, principal=service_runtime.Principal("owner", None, None),
        )
    self.assertEqual(caught.exception.status_code, 409)
    send.assert_not_awaited()


class ReplyDeadlineTests(unittest.IsolatedAsyncioTestCase):
  def setUp(self):
    self.body = social_routes.ReplyPost(post_id="abcdef12", id="abcdef34", text="caption",
      attachment={"mime": "image/png", "data_b64": "eA==", "w": 1, "h": 1})
    self.principal = service_runtime.Principal("owner", None, None)
    for name, kwargs in (
      ("_require_member", {}),
      ("_load_identity", {"return_value": {"handle": "owner", "private_key_b64": "fixture"}}),
      ("_require_username", {}),
      ("_sign", {"return_value": "fixture-signature"}),
      ("_own_host", {"return_value": "self.example"}),
    ):
      self.enterContext(patch.object(social_routes, name, **kwargs))
    self.capability = httpx.Response(200, json={"capabilities": {"reply_attachments": True}},
      request=httpx.Request("GET", "https://community.example/board"))
    self.receipt = httpx.Response(200, json={"status": "ok"},
      request=httpx.Request("POST", "https://community.example/board/reply"))

  async def test_capability_and_signed_write_share_one_deadline_and_retry_id(self):
    # Scale time, not the operation: each stage fits, their sum does not.
    self.assertLess(social_routes.COMMUNITY_WRITE_TIMEOUT_S, 15)
    async def capability(*args, **kwargs):
      await asyncio.sleep(0.04)
      return self.capability
    cancelled = asyncio.Event()
    async def write(*args, **kwargs):
      try:
        await asyncio.sleep(0.06)
        return self.receipt
      except asyncio.CancelledError:
        cancelled.set()
        raise
    with (
      patch.object(social_routes, "COMMUNITY_WRITE_TIMEOUT_S", 0.08),
      patch.object(social_routes, "federation_request", new=AsyncMock(side_effect=capability)),
      patch.object(social_routes, "_post_signed_envelope", new=AsyncMock(side_effect=write)) as send,
    ):
      started = asyncio.get_running_loop().time()
      with self.assertRaises(HTTPException) as caught:
        await social_routes.reply_to_post(self.body, db=None, principal=self.principal)
      self.assertLess(asyncio.get_running_loop().time() - started, 0.2)
      self.assertEqual(caught.exception.status_code, 502)
      self.assertIn("may have been sent", caught.exception.detail)
      self.assertTrue(cancelled.is_set())
      self.assertEqual(send.await_args.args[1]["id"], self.body.id)
      send.side_effect = None
      send.return_value = self.receipt
      result = await social_routes.reply_to_post(self.body, db=None, principal=self.principal)
      self.assertEqual(result["id"], self.body.id)
      self.assertEqual(send.await_args.args[1]["id"], self.body.id)

  async def test_capability_deadline_fails_closed_without_sending(self):
    async def capability(*args, **kwargs):
      await asyncio.sleep(0.06)
      return self.capability
    with (
      patch.object(social_routes, "COMMUNITY_WRITE_TIMEOUT_S", 0.03),
      patch.object(social_routes, "federation_request", new=AsyncMock(side_effect=capability)),
      patch.object(social_routes, "_post_signed_envelope", new=AsyncMock()) as send,
    ):
      with self.assertRaises(HTTPException) as caught:
        await social_routes.reply_to_post(self.body, db=None, principal=self.principal)
    self.assertEqual(caught.exception.status_code, 502)
    self.assertIn("support could not be checked", caught.exception.detail)
    send.assert_not_awaited()

  async def test_transport_write_timeout_reports_unconfirmed_send(self):
    with (
      patch.object(social_routes, "federation_request", new=AsyncMock(return_value=self.capability)),
      patch.object(social_routes, "_post_signed_envelope", new=AsyncMock(side_effect=httpx.ReadTimeout("slow"))),
    ):
      with self.assertRaises(HTTPException) as caught:
        await social_routes.reply_to_post(self.body, db=None, principal=self.principal)
    self.assertIn("may have been sent", caught.exception.detail)

  async def test_external_cancellation_is_not_relabelled_as_reply_timeout(self):
    with (
      patch.object(social_routes, "federation_request", new=AsyncMock(side_effect=asyncio.CancelledError)),
      patch.object(social_routes, "_post_signed_envelope", new=AsyncMock()) as send,
    ):
      with self.assertRaises(asyncio.CancelledError):
        await social_routes.reply_to_post(self.body, db=None, principal=self.principal)
    send.assert_not_awaited()


if __name__ == "__main__":
  unittest.main()
