"""Reactions on private and group messages stay consistent on every copy."""

import base64
import contextlib
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ.setdefault("APP_STORAGE_DIR", "/tmp/social-message-reaction-tests")
os.environ.setdefault("APP_ID", "7")
os.environ.setdefault("APP_SLUG", "social")

import httpx
from fastapi import HTTPException

import service_runtime
import social_groups
import social_routes
from message_reactions import (
  MESSAGE_REACTIONS_FEATURE, apply_reaction, begin_own_update, next_reaction_time,
  settle_own_update, validate_reaction,
)
from service_runtime import Principal

OWNER = Principal("owner", None, None)
MESSAGE_ID = "0b6f4d2e-5c1a-4e8b-9f3d-2a7c6e1b9d40"
GID = "deadbeef"
UPDATE_ID = "7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"


class ReactionStateTests(unittest.TestCase):
  def test_newest_update_wins_whatever_order_updates_arrive_in(self):
    record = {}
    self.assertTrue(apply_reaction(record, "a.example", "🎉", True, 10.0))
    self.assertTrue(apply_reaction(record, "b.example", "🎉", True, 11.0))
    # A delayed older "off" and a repeated update change nothing.
    self.assertFalse(apply_reaction(record, "a.example", "🎉", False, 9.0))
    self.assertFalse(apply_reaction(record, "a.example", "🎉", True, 10.0))
    self.assertEqual(set(record["reactions"]["🎉"]), {"a.example", "b.example"})
    self.assertTrue(apply_reaction(record, "a.example", "🎉", False, 12.0))
    self.assertTrue(apply_reaction(record, "b.example", "🎉", False, 13.0))
    self.assertEqual(record["reactions"], {})
    # Turning it off is remembered, so a stale "on" cannot resurrect it.
    self.assertFalse(apply_reaction(record, "a.example", "🎉", True, 11.5))

  def test_next_time_always_follows_this_hosts_last_update(self):
    future = time.time() + 100
    record = {"reaction_clock": {"me.example ❤️": future}}
    self.assertGreater(next_reaction_time(record, "me.example", "❤️"), future)
    self.assertLessEqual(next_reaction_time(record, "me.example", "🎉"), time.time())

  def test_own_update_is_shown_at_once_and_undone_only_by_a_refusal(self):
    record = {"reactions": {"🎉": {"me.example": 5.0}}, "reaction_clock": {"me.example 🎉": 5.0}}
    update, new = begin_own_update(record, "me.example", "🎉", False, "u-1")
    self.assertTrue(new and update["pending"])
    self.assertEqual(record["reactions"], {})
    rev = record["reaction_rev"]
    self.assertEqual(begin_own_update(record, "me.example", "🎉", False, "u-1"), (update, False))
    self.assertTrue(settle_own_update(record, "me.example", "🎉", "u-1", "uncertain", "lost"))
    self.assertGreater(record["reaction_rev"], rev)
    self.assertTrue(settle_own_update(record, "me.example", "🎉", "u-1", "refused"))
    self.assertEqual(record["reactions"], {"🎉": {"me.example": 5.0}})
    self.assertEqual(record["reaction_clock"], {"me.example 🎉": 5.0})
    # A refusal never undoes a newer update that has been applied since.
    begin_own_update(record, "me.example", "🎉", False, "u-2")
    apply_reaction(record, "me.example", "🎉", True, time.time() + 60)
    settle_own_update(record, "me.example", "🎉", "u-2", "refused")
    self.assertIn("me.example", record["reactions"]["🎉"])
    self.assertFalse(settle_own_update(record, "me.example", "🎉", "u-1", "delivered"))

  def test_only_supported_reactions_and_sane_times_are_accepted(self):
    self.assertEqual(validate_reaction(":mobius:", True, 5), (":mobius:", True, 5.0))
    for emoji, on, at in (
      ("🏴", True, 5), ("🎉", 1, 5), ("🎉", True, "5"), ("🎉", True, float("nan")),
      ("🎉", True, time.time() + 3600), ("🎉", True, True),
    ):
      with self.assertRaises(HTTPException):
        validate_reaction(emoji, on, at)


def x25519_private_b64() -> str:
  from cryptography.hazmat.primitives import serialization
  from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
  raw = X25519PrivateKey.generate().private_bytes(
    serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
    serialization.NoEncryption(),
  )
  return base64.b64encode(raw).decode()


class DirectMessageReactionTests(unittest.IsolatedAsyncioTestCase):
  """One storage holds both sides: each side keys the chat by the other host."""

  def setUp(self):
    temporary = tempfile.TemporaryDirectory()
    self.addCleanup(temporary.cleanup)
    self.storage = Path(temporary.name)
    self.app = SimpleNamespace(id=7, slug="social")
    self.peer_private = x25519_private_b64()
    self.peer_actor = {
      "host": "peer.example", "handle": "pal",
      "features": [MESSAGE_REACTIONS_FEATURE],
      "encryption_key": {
        "alg": "x25519",
        "key_b64": social_routes._encryption_public_key(self.peer_private),
      },
    }
    self.sent = []
    self.notify = AsyncMock(return_value=True)
    for name, value in (
      ("_require_member", {"return_value": self.app}),
      ("_common_app", {"return_value": self.app}),
      ("_own_host", {"return_value": "self.example"}),
      ("_sign", {"return_value": "sig"}),
      ("_fetch_actor", {"new": AsyncMock(side_effect=lambda host: self.peer_actor)}),
      ("_post_signed_envelope", {"new": AsyncMock(side_effect=self.post)}),
      ("_load_identity", {"return_value": {
        "private_key_b64": "fixture", "enc_private_key_b64": self.peer_private,
      }}),
      ("_verify_peer_envelope", {"new": AsyncMock(return_value={"handle": "me"})}),
      ("notify", {"new": self.notify}),
    ):
      self.enterContext(patch.object(social_routes, name, **value))
    self.enterContext(patch.dict(os.environ, {"APP_STORAGE_DIR": str(self.storage)}))
    self.enterContext(patch.object(service_runtime, "STORAGE", self.storage))
    self.save("peer.example", "out")    # our copy: we sent the message
    self.save("self.example", "in")     # the peer's copy of the same message

  async def post(self, url, envelope, **kwargs):
    self.sent.append(envelope)
    return httpx.Response(200, json={"status": "ok"}, request=httpx.Request("POST", url))

  def save(self, peer, direction):
    convo = self.storage / "conversations" / peer
    (convo / "msgs").mkdir(parents=True)
    (convo / "meta.json").write_text(json.dumps({"peer": peer, "request_status": "accepted"}))
    (convo / "msgs" / f"{MESSAGE_ID}.json").write_text(json.dumps({
      "id": MESSAGE_ID, "dir": direction, "peer": peer, "text": "Hi", "sent_at": 1.0,
      "status": "delivered",
    }))

  def stored(self, peer):
    return json.loads((self.storage / "conversations" / peer / "msgs" / f"{MESSAGE_ID}.json").read_text())

  async def react(self, emoji="🎉", on=True, update_id=None):
    return await social_routes.react_to_direct_message(
      "peer.example", MESSAGE_ID, social_routes.MessageReaction(emoji=emoji, on=on, id=update_id),
      db=None, principal=OWNER,
    )

  def opened(self, envelope):
    """What the peer reads from one sent reaction envelope."""
    return social_routes._open_payload(
      envelope["id"], envelope["enc"], self.peer_private, {"message_id", "emoji", "on", "at"},
    )

  async def peer_receives(self, envelope):
    with patch.object(social_routes, "_own_host", return_value="peer.example"):
      return await social_routes._receive_message_reaction(envelope, None)

  async def test_encrypted_reaction_reaches_the_peer_and_both_copies_agree(self):
    result = await self.react(":mobius:")
    self.assertEqual(set(result["reactions"][":mobius:"]), {"self.example"})
    envelope = self.sent[0]
    self.assertEqual(envelope["type"], "message_reaction")
    self.assertIn("enc", envelope)
    self.assertNotIn("emoji", envelope)  # the reaction travels sealed

    # The peer opens it with its key and stores it on its copy.
    with patch.object(social_routes, "_own_host", return_value="peer.example"):
      await social_routes._receive_message_reaction(envelope, None)
    peer_copy = self.stored("self.example")
    self.assertEqual(set(peer_copy["reactions"][":mobius:"]), {"self.example"})
    # The peer's message was not theirs, so they get no notification for it.
    self.notify.assert_not_awaited()

  async def test_a_reaction_to_my_message_notifies_me_once(self):
    envelope = {"v": 0, "type": "message_reaction", "id": "1f2e3d4c-aaaa-bbbb-cccc-111122223333",
                "from": "peer.example", "to": "self.example", "sent_at": time.time(),
                "message_id": MESSAGE_ID, "emoji": "👍", "on": True, "at": time.time()}
    with patch.object(social_routes, "_verify_peer_envelope", new=AsyncMock(return_value={"handle": "pal"})):
      await social_routes._receive_message_reaction(envelope, None)
      await social_routes._receive_message_reaction(envelope, None)
    self.assertEqual(set(self.stored("peer.example")["reactions"]["👍"]), {"peer.example"})
    self.notify.assert_awaited_once()
    self.assertEqual(self.notify.await_args.args[1], "@pal reacted 👍 to your message")

  async def test_unreachable_peer_keeps_the_reaction_pending_until_a_retry(self):
    async def refuse(url, envelope, **kwargs):
      self.sent.append(envelope)
      raise httpx.ConnectError("down")
    with patch.object(social_routes, "_post_signed_envelope", new=AsyncMock(side_effect=refuse)):
      result = await self.react(update_id=UPDATE_ID)
    self.assertEqual(result["status"], "pending")
    self.assertTrue(result["detail"])
    saved = self.stored("peer.example")
    self.assertEqual(set(saved["reactions"]["🎉"]), {"self.example"})
    self.assertTrue(saved["reaction_updates"]["🎉"]["pending"])

    # The retry re-sends the same update, under the same id and time.
    retried = await self.react(update_id=UPDATE_ID)
    self.assertEqual(retried["status"], "delivered")
    first, second = self.sent
    self.assertEqual((first["id"], self.opened(first)), (second["id"], self.opened(second)))
    self.assertFalse(self.stored("peer.example")["reaction_updates"]["🎉"]["pending"])
    # Once confirmed, the same id again sends nothing more.
    self.assertEqual((await self.react(update_id=UPDATE_ID))["status"], "delivered")
    self.assertEqual(len(self.sent), 2)

  async def test_a_lost_reply_after_the_peer_applied_settles_on_an_exact_retry(self):
    async def apply_then_time_out(url, envelope, **kwargs):
      self.sent.append(envelope)
      await self.peer_receives(envelope)
      raise httpx.ReadTimeout("no reply")
    with patch.object(social_routes, "_post_signed_envelope",
                      new=AsyncMock(side_effect=apply_then_time_out)):
      result = await self.react(":mobius:", update_id=UPDATE_ID)
    # Not an error: the peer may well have it, so both copies show it.
    self.assertEqual(result["status"], "pending")
    self.assertIn("may have arrived", result["detail"])
    self.assertEqual(set(result["reactions"][":mobius:"]), {"self.example"})
    self.assertEqual(set(self.stored("peer.example")["reactions"][":mobius:"]), {"self.example"})
    peer_copy = self.stored("self.example")
    self.assertEqual(set(peer_copy["reactions"][":mobius:"]), {"self.example"})

    async def apply(url, envelope, **kwargs):
      self.sent.append(envelope)
      await self.peer_receives(envelope)
      return httpx.Response(200, json={"status": "ok"}, request=httpx.Request("POST", url))
    with patch.object(social_routes, "_post_signed_envelope", new=AsyncMock(side_effect=apply)):
      retried = await self.react(":mobius:", update_id=UPDATE_ID)
    self.assertEqual(retried["status"], "delivered")
    self.assertEqual(self.opened(self.sent[0]), self.opened(self.sent[1]))
    # The peer applied the identical update once; its copy did not change again.
    self.assertEqual(self.stored("self.example"), peer_copy)
    self.assertFalse(self.stored("peer.example")["reaction_updates"][":mobius:"]["pending"])

  async def test_a_definite_refusal_restores_our_copy(self):
    await self.react("❤️", True)
    async def refuse(url, envelope, **kwargs):
      return httpx.Response(404, json={"detail": "Message not found."},
                            request=httpx.Request("POST", url))
    with patch.object(social_routes, "_post_signed_envelope", new=AsyncMock(side_effect=refuse)):
      with self.assertRaises(HTTPException) as caught:
        await self.react("❤️", False)
    self.assertEqual(caught.exception.status_code, 409)
    saved = self.stored("peer.example")
    self.assertEqual(set(saved["reactions"]["❤️"]), {"self.example"})
    self.assertNotIn("❤️", saved["reaction_updates"])  # nothing left to retry

  async def test_an_id_is_never_reused_for_a_different_update(self):
    await self.react("🎉", True, update_id=UPDATE_ID)
    with self.assertRaises(HTTPException) as caught:
      await self.react("🎉", False, update_id=UPDATE_ID)
    self.assertEqual(caught.exception.status_code, 409)

  async def test_a_reaction_to_an_encrypted_message_is_never_sent_unsealed(self):
    path = self.storage / "conversations" / "peer.example" / "msgs" / f"{MESSAGE_ID}.json"
    path.write_text(json.dumps({**self.stored("peer.example"), "encrypted": True}))
    # The peer still takes reactions, but no longer publishes an encryption key.
    self.peer_actor = {"host": "peer.example", "features": [MESSAGE_REACTIONS_FEATURE]}
    with self.assertRaises(HTTPException) as caught:
      await self.react()
    self.assertEqual(caught.exception.status_code, 409)
    self.assertIn("encryption key", caught.exception.detail)
    self.assertEqual(self.sent, [])
    self.assertNotIn("reactions", self.stored("peer.example"))

  async def test_an_unsealed_reaction_to_an_encrypted_message_is_refused(self):
    path = self.storage / "conversations" / "peer.example" / "msgs" / f"{MESSAGE_ID}.json"
    path.write_text(json.dumps({**self.stored("peer.example"), "encrypted": True}))
    envelope = {"v": 0, "type": "message_reaction", "id": UPDATE_ID,
                "from": "peer.example", "to": "self.example", "sent_at": time.time(),
                "message_id": MESSAGE_ID, "emoji": "👍", "on": True, "at": time.time()}
    with self.assertRaises(HTTPException) as caught:
      await social_routes._receive_message_reaction(envelope, None)
    self.assertEqual(caught.exception.status_code, 400)
    self.assertNotIn("reactions", self.stored("peer.example"))

  async def test_older_peers_are_not_sent_reactions_they_would_refuse(self):
    self.peer_actor = {"host": "peer.example"}
    with self.assertRaises(HTTPException) as caught:
      await self.react()
    self.assertEqual(caught.exception.status_code, 409)
    self.assertEqual(self.sent, [])

  async def test_reacting_then_removing_round_trips(self):
    await self.react("❤️", True)
    result = await self.react("❤️", False)
    self.assertEqual(result["reactions"], {})
    self.assertEqual([e["type"] for e in self.sent], ["message_reaction"] * 2)

  def test_actor_card_advertises_message_reactions(self):
    card = social_routes._key_actor_doc({
      "private_key_b64": base64.b64encode(b"\x01" * 32).decode(),
      "enc_private_key_b64": x25519_private_b64(),
    })
    self.assertIn(MESSAGE_REACTIONS_FEATURE, card["features"])


class GroupReactionTests(unittest.IsolatedAsyncioTestCase):
  def setUp(self):
    temporary = tempfile.TemporaryDirectory()
    self.addCleanup(temporary.cleanup)
    self.storage = Path(temporary.name)
    self.app = SimpleNamespace(id=7, slug="social")
    self.host_group = None
    self.own = "self.example"
    self.delivered = []
    self.notify = AsyncMock(return_value=True)
    self.host_actor = {"host": "host.example", "features": [MESSAGE_REACTIONS_FEATURE]}
    for name, value in (
      ("_require_member", {"return_value": self.app}),
      ("_own_host", {"side_effect": lambda: self.own}),
      ("_load_identity", {"return_value": {"handle": "me", "private_key_b64": "fixture"}}),
      ("_signed", {"side_effect": lambda envelope, identity: envelope}),
      ("_host_group_transaction", {"side_effect": lambda gid: contextlib.nullcontext()}),
      ("_load_host_group", {"side_effect": lambda gid: self.host_group}),
      ("_deliver", {"new": AsyncMock(side_effect=self.deliver)}),
      ("_fetch_actor", {"new": AsyncMock(side_effect=lambda host: self.host_actor)}),
      ("_verify_peer_envelope", {"new": AsyncMock(return_value={"handle": "pal"})}),
      ("notify", {"new": self.notify}),
    ):
      self.enterContext(patch.object(social_groups, name, **value))
    self.enterContext(patch.object(
      social_groups, "_host_groups_dir", side_effect=lambda: self.storage / "host-groups",
    ))
    self.host_posts = []
    self.host_reply = lambda envelope: httpx.Response(200, json={"status": "ok"})
    self.enterContext(patch.object(
      social_groups, "_post_signed_envelope", new=AsyncMock(side_effect=self.post_to_host),
    ))
    self.unreachable = set()
    self.enterContext(patch.dict(os.environ, {"APP_STORAGE_DIR": str(self.storage)}))
    self.enterContext(patch.object(service_runtime, "STORAGE", self.storage))

  async def deliver(self, host, envelope):
    self.delivered.append((host, envelope))
    return host not in self.unreachable

  async def post_to_host(self, url, envelope, **kwargs):
    self.host_posts.append(envelope)
    response = self.host_reply(envelope)
    response.request = httpx.Request("POST", url)
    return response

  def save(self, *, host, author, direction="in"):
    folder = self.storage / "groups" / GID
    (folder / "msgs").mkdir(parents=True, exist_ok=True)
    (folder / "meta.json").write_text(json.dumps({
      "gid": GID, "host": host, "name": "Friends", "request_status": "accepted",
    }))
    (folder / "msgs" / f"{MESSAGE_ID}.json").write_text(json.dumps({
      "id": MESSAGE_ID, "gid": GID, "author": author, "text": "Hi",
      "sent_at": 1.0, "dir": direction, "status": "delivered",
    }))

  def stored(self):
    return json.loads((self.storage / "groups" / GID / "msgs" / f"{MESSAGE_ID}.json").read_text())

  async def react(self, emoji="🎉", on=True, update_id=None):
    return await social_groups.react_to_group_message(
      GID, MESSAGE_ID, social_groups.GroupReaction(emoji=emoji, on=on, id=update_id),
      db=None, principal=OWNER,
    )

  def hosting(self):
    self.own = "host.example"
    self.host_group = {"id": GID, "name": "Friends", "members": {
      "host.example": {"status": "active"},
      "pal.example": {"status": "active", "handle": "pal"},
      "third.example": {"status": "active"},
      "left.example": {"status": "declined"},
    }}

  def member_react(self, **fields):
    return {"v": 0, "type": "group_react", "id": UPDATE_ID,
            "from": "pal.example", "to": "host.example", "gid": GID,
            "message_id": MESSAGE_ID, "emoji": "🎉", "on": True, "at": time.time(),
            "sent_at": time.time(), **fields}

  async def test_member_reaction_goes_to_the_host_then_our_copy(self):
    self.save(host="host.example", author="host.example")
    result = await self.react(":mobius:")
    envelope, = self.host_posts
    self.assertEqual((envelope["type"], envelope["emoji"], envelope["message_id"]),
                     ("group_react", ":mobius:", MESSAGE_ID))
    self.assertEqual(result["status"], "delivered")
    self.assertEqual(set(result["reactions"][":mobius:"]), {"self.example"})

  async def test_member_reaction_whose_reply_was_lost_stays_pending_until_an_exact_retry(self):
    self.save(host="host.example", author="host.example")
    def applied_then_lost(envelope):
      raise httpx.ReadTimeout("no reply")
    self.host_reply = applied_then_lost
    result = await self.react(":mobius:", update_id=UPDATE_ID)
    self.assertEqual(result["status"], "pending")
    self.assertEqual(set(self.stored()["reactions"][":mobius:"]), {"self.example"})
    self.assertTrue(self.stored()["reaction_updates"][":mobius:"]["pending"])

    self.host_reply = lambda envelope: httpx.Response(200, json={"status": "ok", "undelivered": 0})
    retried = await self.react(":mobius:", update_id=UPDATE_ID)
    self.assertEqual(retried["status"], "delivered")
    first, second = self.host_posts
    fields = ("id", "message_id", "emoji", "on", "at")
    self.assertEqual([first[f] for f in fields], [second[f] for f in fields])
    self.assertFalse(self.stored()["reaction_updates"][":mobius:"]["pending"])

  async def test_member_reaction_stays_pending_while_the_host_still_owes_relays(self):
    self.save(host="host.example", author="host.example")
    self.host_reply = lambda envelope: httpx.Response(200, json={"status": "ok", "undelivered": 1})
    result = await self.react(update_id=UPDATE_ID)
    self.assertEqual(result["status"], "pending")
    self.host_reply = lambda envelope: httpx.Response(200, json={"status": "ok", "undelivered": 0})
    self.assertEqual((await self.react(update_id=UPDATE_ID))["status"], "delivered")

  async def test_a_failed_relay_is_retried_by_an_exact_replay_without_a_second_notice(self):
    self.hosting()
    self.save(host="host.example", author="host.example", direction="out")
    original = self.member_react()
    self.unreachable = {"third.example"}
    first = await social_groups._accept_group_envelope(None, self.app, original, {"handle": "pal"})
    self.assertEqual(first, {"status": "ok", "undelivered": 1})
    self.assertEqual([host for host, _ in self.delivered], ["third.example"])

    # The member retries the same update, freshly signed; the host relays it again.
    self.unreachable = set()
    replay = {**original, "sent_at": time.time() + 1}
    second = await social_groups._accept_group_envelope(None, self.app, replay, {"handle": "pal"})
    self.assertEqual(second, {"status": "ok", "undelivered": 0})
    self.assertEqual([host for host, _ in self.delivered], ["third.example", "third.example"])
    self.assertEqual(self.delivered[1][1]["original"], replay)
    self.assertEqual(self.delivered[0][1]["id"], self.delivered[1][1]["id"])
    self.notify.assert_awaited_once()
    self.assertEqual(set(self.stored()["reactions"]["🎉"]), {"pal.example"})
    # Nothing is owed any more, so a third replay sends nothing.
    await social_groups._accept_group_envelope(None, self.app, replay, {"handle": "pal"})
    self.assertEqual(len(self.delivered), 2)
    self.assertFalse((self.storage / "host-groups" / "reaction-relays" / f"{GID}.json").exists())

  async def test_a_newer_update_replaces_relays_still_owed_for_an_older_one(self):
    self.hosting()
    self.save(host="host.example", author="host.example", direction="out")
    self.unreachable = {"third.example"}
    older = self.member_react()
    await social_groups._accept_group_envelope(None, self.app, older, {"handle": "pal"})
    newer = self.member_react(id="7c1e2d3f-4a5b-4c6d-8e7f-000000000001", on=False, at=older["at"] + 1)
    await social_groups._accept_group_envelope(None, self.app, newer, {"handle": "pal"})
    self.unreachable = set()
    self.delivered.clear()
    # The older update is no longer owed to anyone: its replay relays nothing.
    await social_groups._accept_group_envelope(None, self.app, {**older, "sent_at": time.time()}, {})
    self.assertEqual(self.delivered, [])
    await social_groups._accept_group_envelope(None, self.app, {**newer, "sent_at": time.time()}, {})
    self.assertEqual([relay["original"]["on"] for _, relay in self.delivered], [False])

  async def test_hosted_reaction_reports_failed_members_and_retries_only_them(self):
    self.hosting()
    self.save(host="host.example", author="pal.example")
    self.unreachable = {"third.example"}
    result = await self.react(update_id=UPDATE_ID)
    self.assertEqual(result["status"], "pending")
    self.assertEqual(result["failed_members"], ["third.example"])
    self.assertEqual(sorted(host for host, _ in self.delivered), ["pal.example", "third.example"])
    self.assertTrue(self.stored()["reaction_updates"]["🎉"]["pending"])

    self.unreachable = set()
    retried = await self.react(update_id=UPDATE_ID)
    self.assertEqual(retried["status"], "delivered")
    self.assertEqual([host for host, _ in self.delivered[2:]], ["third.example"])
    self.assertEqual(self.delivered[1][1]["original"]["at"], self.delivered[2][1]["original"]["at"])
    self.assertFalse(self.stored()["reaction_updates"]["🎉"]["pending"])
    self.notify.assert_not_awaited()

  async def test_member_reaction_is_refused_by_an_older_host_without_sending(self):
    self.save(host="host.example", author="host.example")
    self.host_actor = {"host": "host.example"}
    with self.assertRaises(HTTPException) as caught:
      await self.react()
    self.assertEqual(caught.exception.status_code, 409)
    self.assertEqual(self.host_posts, [])
    self.assertNotIn("reactions", self.stored())

  async def test_host_applies_a_members_reaction_and_relays_it_to_the_others(self):
    self.hosting()
    self.save(host="host.example", author="host.example", direction="out")
    original = {"v": 0, "type": "group_react", "id": "5d4c3b2a-0000-1111-2222-333344445555",
                "from": "pal.example", "to": "host.example", "gid": GID,
                "message_id": MESSAGE_ID, "emoji": "🎉", "on": True, "at": time.time(),
                "sent_at": time.time()}
    await social_groups._accept_group_envelope(None, self.app, original, {"handle": "pal"})
    self.assertEqual(set(self.stored()["reactions"]["🎉"]), {"pal.example"})
    self.assertEqual([host for host, _ in self.delivered], ["third.example"])
    relay = self.delivered[0][1]
    self.assertEqual((relay["type"], relay["original"]), ("group_reaction", original))
    # The host wrote the message, so the host's owner hears about it once.
    self.notify.assert_awaited_once()
    self.assertIn("@pal reacted 🎉 to your message", self.notify.await_args.args[1])

    # A member applies the relay after checking it came from the host.
    self.delivered.clear()
    self.own = "third.example"
    self.host_group = None
    self.save(host="host.example", author="host.example")
    await social_groups._accept_group_envelope(None, self.app, relay, {})
    self.assertEqual(set(self.stored()["reactions"]["🎉"]), {"pal.example"})

  async def test_members_refuse_reactions_not_relayed_by_the_host(self):
    self.save(host="host.example", author="host.example")
    forged = {"v": 0, "type": "group_reaction", "id": "5d4c3b2a-0000-1111-2222-333344445556",
              "from": "pal.example", "to": "self.example", "gid": GID,
              "original": {"type": "group_react", "gid": GID, "to": "host.example"}}
    with self.assertRaises(HTTPException) as caught:
      await social_groups._accept_group_envelope(None, self.app, forged, {})
    self.assertEqual(caught.exception.status_code, 403)
    self.assertNotIn("reactions", self.stored())
