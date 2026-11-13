"""Edits to your own private and group messages reach every copy, and only the author's count."""

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

os.environ.setdefault("APP_STORAGE_DIR", "/tmp/social-message-edit-tests")
os.environ.setdefault("APP_ID", "7")
os.environ.setdefault("APP_SLUG", "social")

import httpx
from fastapi import HTTPException

import service_runtime
import social_groups
import social_routes
from message_edits import (
  MESSAGE_EDITS_FEATURE, apply_edit, begin_own_edit, settle_own_edit, validate_edit,
)
from service_runtime import Principal

OWNER = Principal("owner", None, None)
MESSAGE_ID = "0b6f4d2e-5c1a-4e8b-9f3d-2a7c6e1b9d40"
GID = "deadbeef"
EDIT_ID = "7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"


def x25519_private_b64() -> str:
  from cryptography.hazmat.primitives import serialization
  from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
  raw = X25519PrivateKey.generate().private_bytes(
    serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption(),
  )
  return base64.b64encode(raw).decode()


class EditStateTests(unittest.TestCase):
  def test_the_newest_edit_wins_in_any_arrival_order(self):
    record = {"text": "Hi"}
    self.assertTrue(apply_edit(record, "Hello", 10.0))
    self.assertFalse(apply_edit(record, "Older", 9.0))
    self.assertFalse(apply_edit(record, "Hello", 10.0))
    self.assertEqual((record["text"], record["edited_at"]), ("Hello", 10.0))

  def test_own_edit_shows_at_once_and_only_a_refusal_restores_the_old_text(self):
    record = {"text": "Hi"}
    edit, new = begin_own_edit(record, "Hello", "e-1")
    self.assertTrue(new and edit["pending"])
    self.assertEqual(record["text"], "Hello")
    self.assertEqual(begin_own_edit(record, "Hello", "e-1"), (edit, False))
    self.assertTrue(settle_own_edit(record, "e-1", "uncertain", "lost"))
    self.assertEqual(record["text"], "Hello")
    self.assertTrue(settle_own_edit(record, "e-1", "refused"))
    self.assertEqual(record, {"text": "Hi"})

  def test_an_edit_id_is_never_reused_for_different_text(self):
    record = {"text": "Hi"}
    begin_own_edit(record, "Hello", "e-1")
    with self.assertRaises(HTTPException):
      begin_own_edit(record, "Other", "e-1")

  def test_empty_text_and_far_future_times_are_refused(self):
    for text, at in (("  ", time.time()), ("ok", time.time() + 3600), (None, time.time())):
      with self.assertRaises(HTTPException):
        validate_edit(text, at)


class DirectMessageEditTests(unittest.IsolatedAsyncioTestCase):
  def setUp(self):
    temporary = tempfile.TemporaryDirectory()
    self.addCleanup(temporary.cleanup)
    self.storage = Path(temporary.name)
    self.app = SimpleNamespace(id=7, slug="social")
    self.peer_private = x25519_private_b64()
    self.peer_actor = {
      "host": "peer.example", "features": [MESSAGE_EDITS_FEATURE],
      "encryption_key": {"alg": "x25519", "key_b64": social_routes._encryption_public_key(self.peer_private)},
    }
    self.sent = []
    self.reply = lambda: httpx.Response(200, json={"status": "ok"})
    for name, value in (
      ("_require_member", {"return_value": self.app}),
      ("_common_app", {"return_value": self.app}),
      ("_own_host", {"return_value": "self.example"}),
      ("_sign", {"return_value": "sig"}),
      ("_fetch_actor", {"new": AsyncMock(side_effect=lambda host: self.peer_actor)}),
      ("_post_signed_envelope", {"new": AsyncMock(side_effect=self.post)}),
      ("_load_identity", {"return_value": {"private_key_b64": "fixture", "enc_private_key_b64": self.peer_private}}),
      ("_verify_peer_envelope", {"new": AsyncMock(return_value={"handle": "me"})}),
    ):
      self.enterContext(patch.object(social_routes, name, **value))
    self.enterContext(patch.dict(os.environ, {"APP_STORAGE_DIR": str(self.storage)}))
    self.enterContext(patch.object(service_runtime, "STORAGE", self.storage))
    self.save("peer.example", "out")   # our copy: we wrote it
    self.save("self.example", "in")    # the peer's copy of the same message

  async def post(self, url, envelope, **kwargs):
    self.sent.append(envelope)
    response = self.reply()
    response.request = httpx.Request("POST", url)
    return response

  def save(self, peer, direction):
    convo = self.storage / "conversations" / peer
    (convo / "msgs").mkdir(parents=True)
    (convo / "meta.json").write_text(json.dumps({"peer": peer, "request_status": "accepted"}))
    (convo / "msgs" / f"{MESSAGE_ID}.json").write_text(json.dumps({
      "id": MESSAGE_ID, "dir": direction, "peer": peer, "text": "Hi", "sent_at": 1.0,
      "status": "delivered", "encrypted": True,
    }))

  def stored(self, peer):
    return json.loads((self.storage / "conversations" / peer / "msgs" / f"{MESSAGE_ID}.json").read_text())

  async def edit(self, text="Hello", peer="peer.example"):
    return await social_routes.edit_direct_message(
      peer, MESSAGE_ID, social_routes.MessageEdit(text=text, id=EDIT_ID), db=None, principal=OWNER,
    )

  async def test_a_sealed_edit_updates_both_copies(self):
    result = await self.edit()
    self.assertEqual((result["text"], result["pending"]), ("Hello", False))
    envelope, = self.sent
    self.assertEqual(envelope["type"], "message_edit")
    self.assertNotIn("text", envelope)  # the new text travels sealed
    with patch.object(social_routes, "_own_host", return_value="peer.example"):
      await social_routes._receive_message_edit(envelope, None)
    self.assertEqual(self.stored("self.example")["text"], "Hello")
    self.assertIn("edited_at", self.stored("self.example"))

  async def test_a_refusal_restores_our_text(self):
    self.reply = lambda: httpx.Response(400, json={"detail": "no"})
    with self.assertRaises(HTTPException) as caught:
      await self.edit()
    self.assertEqual(caught.exception.status_code, 409)
    self.assertEqual(self.stored("peer.example")["text"], "Hi")

  async def test_an_unreachable_peer_keeps_the_edit_pending(self):
    self.reply = lambda: (_ for _ in ()).throw(httpx.ConnectError("down"))
    result = await self.edit()
    self.assertTrue(result["pending"])
    self.assertEqual(self.stored("peer.example")["text"], "Hello")

  async def test_older_peers_are_not_sent_edits(self):
    self.peer_actor = {"host": "peer.example"}
    with self.assertRaises(HTTPException) as caught:
      await self.edit()
    self.assertEqual(caught.exception.status_code, 409)
    self.assertEqual(self.sent, [])

  async def test_only_my_own_messages_can_be_edited(self):
    with self.assertRaises(HTTPException) as caught:
      await self.edit(peer="self.example")  # that copy holds an incoming message
    self.assertEqual(caught.exception.status_code, 403)

  async def test_a_peer_cannot_edit_a_message_it_did_not_write(self):
    envelope = {"v": 0, "type": "message_edit", "id": EDIT_ID, "from": "peer.example",
                "to": "self.example", "message_id": MESSAGE_ID, "text": "Forged", "at": time.time()}
    # Our copy under peer.example is our own outgoing message.
    with self.assertRaises(HTTPException) as caught:
      await social_routes._receive_message_edit(envelope, None)
    self.assertIn(caught.exception.status_code, (400, 403))
    self.assertEqual(self.stored("peer.example")["text"], "Hi")

  def test_actor_card_advertises_message_edits(self):
    card = social_routes._key_actor_doc({
      "private_key_b64": base64.b64encode(b"\x01" * 32).decode(),
      "enc_private_key_b64": x25519_private_b64(),
    })
    self.assertIn(MESSAGE_EDITS_FEATURE, card["features"])


class GroupEditTests(unittest.IsolatedAsyncioTestCase):
  def setUp(self):
    temporary = tempfile.TemporaryDirectory()
    self.addCleanup(temporary.cleanup)
    self.storage = Path(temporary.name)
    self.app = SimpleNamespace(id=7, slug="social")
    self.host_group = None
    self.own = "self.example"
    self.delivered = []
    self.host_actor = {"host": "host.example", "features": [MESSAGE_EDITS_FEATURE]}
    self.host_posts = []
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
      ("_post_signed_envelope", {"new": AsyncMock(side_effect=self.post_to_host)}),
    ):
      self.enterContext(patch.object(social_groups, name, **value))
    self.enterContext(patch.dict(os.environ, {"APP_STORAGE_DIR": str(self.storage)}))
    self.enterContext(patch.object(service_runtime, "STORAGE", self.storage))

  async def deliver(self, host, envelope):
    self.delivered.append((host, envelope))
    return True

  async def post_to_host(self, url, envelope, **kwargs):
    self.host_posts.append(envelope)
    return httpx.Response(200, json={"status": "ok", "undelivered": 0}, request=httpx.Request("POST", url))

  def save(self, *, host, author):
    folder = self.storage / "groups" / GID
    (folder / "msgs").mkdir(parents=True, exist_ok=True)
    (folder / "meta.json").write_text(json.dumps({
      "gid": GID, "host": host, "name": "Friends", "request_status": "accepted",
    }))
    (folder / "msgs" / f"{MESSAGE_ID}.json").write_text(json.dumps({
      "id": MESSAGE_ID, "gid": GID, "author": author, "text": "Hi", "sent_at": 1.0,
      "dir": "out" if author == self.own else "in", "status": "delivered",
    }))

  def stored(self):
    return json.loads((self.storage / "groups" / GID / "msgs" / f"{MESSAGE_ID}.json").read_text())

  def hosting(self):
    self.own = "host.example"
    self.host_group = {"id": GID, "name": "Friends", "members": {
      "host.example": {"status": "active"},
      "pal.example": {"status": "active"},
      "third.example": {"status": "active"},
    }}

  async def test_member_edit_goes_to_the_host_and_changes_our_copy(self):
    self.save(host="host.example", author="self.example")
    result = await social_groups.edit_group_message(
      GID, MESSAGE_ID, social_groups.GroupEdit(text="Hello", id=EDIT_ID), db=None, principal=OWNER,
    )
    envelope, = self.host_posts
    self.assertEqual((envelope["type"], envelope["text"]), ("group_edit", "Hello"))
    self.assertEqual((result["text"], result["pending"]), ("Hello", False))

  async def test_host_relays_an_authors_edit_and_members_apply_it(self):
    self.hosting()
    self.save(host="host.example", author="pal.example")
    original = {"v": 0, "type": "group_edit", "id": EDIT_ID, "from": "pal.example",
                "to": "host.example", "gid": GID, "message_id": MESSAGE_ID,
                "text": "Hello", "at": time.time(), "sent_at": time.time()}
    await social_groups._accept_group_envelope(None, self.app, original, {"handle": "pal"})
    self.assertEqual(self.stored()["text"], "Hello")
    self.assertEqual([host for host, _ in self.delivered], ["third.example"])
    relay = self.delivered[0][1]
    self.own, self.host_group = "third.example", None
    self.save(host="host.example", author="pal.example")
    await social_groups._accept_group_envelope(None, self.app, relay, {})
    self.assertEqual(self.stored()["text"], "Hello")

  async def test_nobody_can_edit_someone_elses_group_message(self):
    self.hosting()
    self.save(host="host.example", author="third.example")
    forged = {"v": 0, "type": "group_edit", "id": EDIT_ID, "from": "pal.example",
              "to": "host.example", "gid": GID, "message_id": MESSAGE_ID,
              "text": "Forged", "at": time.time(), "sent_at": time.time()}
    with self.assertRaises(HTTPException) as caught:
      await social_groups._accept_group_envelope(None, self.app, forged, {"handle": "pal"})
    self.assertEqual(caught.exception.status_code, 403)
    self.assertEqual(self.stored()["text"], "Hi")
    self.assertEqual(self.delivered, [])


if __name__ == "__main__":
  unittest.main()
