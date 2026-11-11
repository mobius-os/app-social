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
  MESSAGE_REACTIONS_FEATURE, apply_reaction, next_reaction_time, validate_reaction,
)
from service_runtime import Principal

OWNER = Principal("owner", None, None)
MESSAGE_ID = "0b6f4d2e-5c1a-4e8b-9f3d-2a7c6e1b9d40"
GID = "deadbeef"


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

  async def react(self, emoji="🎉", on=True):
    return await social_routes.react_to_direct_message(
      "peer.example", MESSAGE_ID, social_routes.MessageReaction(emoji=emoji, on=on),
      db=None, principal=OWNER,
    )

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

  async def test_unreachable_peer_leaves_our_copy_unchanged(self):
    async def refuse(url, envelope, **kwargs):
      raise httpx.ConnectError("down")
    with patch.object(social_routes, "_post_signed_envelope", new=AsyncMock(side_effect=refuse)):
      with self.assertRaises(HTTPException) as caught:
        await self.react()
    self.assertEqual(caught.exception.status_code, 502)
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
    self.enterContext(patch.dict(os.environ, {"APP_STORAGE_DIR": str(self.storage)}))
    self.enterContext(patch.object(service_runtime, "STORAGE", self.storage))

  async def deliver(self, host, envelope):
    self.delivered.append((host, envelope))
    return True

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

  async def react(self, emoji="🎉", on=True):
    return await social_groups.react_to_group_message(
      GID, MESSAGE_ID, social_groups.GroupReaction(emoji=emoji, on=on), db=None, principal=OWNER,
    )

  async def test_member_reaction_goes_to_the_host_then_our_copy(self):
    self.save(host="host.example", author="host.example")
    result = await self.react(":mobius:")
    (host, envelope), = self.delivered
    self.assertEqual(host, "host.example")
    self.assertEqual((envelope["type"], envelope["emoji"], envelope["message_id"]),
                     ("group_react", ":mobius:", MESSAGE_ID))
    self.assertEqual(set(result["reactions"][":mobius:"]), {"self.example"})

  async def test_member_reaction_is_refused_by_an_older_host_without_sending(self):
    self.save(host="host.example", author="host.example")
    self.host_actor = {"host": "host.example"}
    with self.assertRaises(HTTPException) as caught:
      await self.react()
    self.assertEqual(caught.exception.status_code, 409)
    self.assertEqual(self.delivered, [])

  async def test_host_applies_a_members_reaction_and_relays_it_to_the_others(self):
    self.own = "host.example"
    self.save(host="host.example", author="host.example", direction="out")
    self.host_group = {"id": GID, "name": "Friends", "members": {
      "host.example": {"status": "active"},
      "pal.example": {"status": "active", "handle": "pal"},
      "third.example": {"status": "active"},
      "left.example": {"status": "declined"},
    }}
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
