"""Community bans hold for group relays and for every outgoing destination."""

import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ.setdefault("APP_STORAGE_DIR", "/tmp/social-ban-enforcement-tests")
os.environ.setdefault("APP_ID", "7")
os.environ.setdefault("APP_SLUG", "social")

from fastapi import HTTPException

import social_groups
import social_routes

GID = "abcdef12"
MESSAGE_ID = "1a2b3c4d"
BANNED = "bad.example"
HOST = "host.example"
ME = "self.example"


class RelayedAuthorBanTests(unittest.IsolatedAsyncioTestCase):
  """A group host only forwards: the original author's ban still applies."""

  def relays(self):
    post = {"v": 0, "type": "group_post", "id": MESSAGE_ID, "from": BANNED, "to": HOST,
            "gid": GID, "text": "hi", "sent_at": 1.0}
    react = {"v": 0, "type": "group_react", "id": "5d4c3b2a-0000-1111-2222-333344445555",
             "from": BANNED, "to": HOST, "gid": GID, "message_id": MESSAGE_ID,
             "emoji": "🎉", "on": True, "at": 1.0, "sent_at": 1.0}
    edit = {"v": 0, "type": "group_edit", "id": "5d4c3b2a-0000-1111-2222-333344445556",
            "from": BANNED, "to": HOST, "gid": GID, "message_id": MESSAGE_ID,
            "text": "edited", "at": 2.0, "sent_at": 2.0}
    relay = {"v": 0, "from": HOST, "to": ME, "gid": GID, "sent_at": 3.0}
    return {
      "group_message": {**relay, "type": "group_message", "id": MESSAGE_ID, "text": "hi",
                        "original": post},
      "group_reaction": {**relay, "type": "group_reaction", "id": "9a8b7c6d", "original": react},
      "group_edited": {**relay, "type": "group_edited", "id": "9a8b7c6e", "original": edit},
    }

  async def test_a_banned_authors_relayed_message_reaction_and_edit_are_refused(self):
    app = SimpleNamespace(id=7, slug="social")
    with (patch.object(social_routes, "_own_host", return_value=ME),
          patch.object(social_routes, "_community_bans", new=AsyncMock(return_value={BANNED})),
          patch.object(social_groups, "_load_group_meta", return_value={"host": HOST}),
          patch.object(social_groups, "_verify_peer_envelope", new=AsyncMock(return_value={"handle": "bad"})),
          patch.object(social_groups, "_store_group_message", new=AsyncMock()) as message,
          patch.object(social_groups, "_store_group_reaction", new=AsyncMock()) as reaction,
          patch.object(social_groups, "_store_group_edit", new=AsyncMock()) as edit):
      for kind, envelope in self.relays().items():
        with self.subTest(kind=kind), self.assertRaises(HTTPException) as caught:
          await social_groups._accept_group_envelope(None, app, envelope, {"handle": "host"})
        self.assertEqual((caught.exception.status_code, caught.exception.detail),
                         (403, social_routes.BANNED_PERSON))
      message.assert_not_called()
      reaction.assert_not_called()
      edit.assert_not_called()


class OutgoingDestinationBanTests(unittest.IsolatedAsyncioTestCase):
  """The sender refuses banned recipients itself, so older receivers can't let them through."""

  def setUp(self):
    from service_runtime import Principal
    self.owner = Principal("owner", None, None)
    self.app = SimpleNamespace(id=7, slug="social")
    for patcher in (
      patch.object(social_routes, "_own_host", return_value=ME),
      patch.object(social_groups, "_own_host", return_value=ME),
      patch.object(social_routes, "_community_bans", new=AsyncMock(return_value={BANNED})),
      patch.object(social_groups, "_community_bans", new=AsyncMock(return_value={BANNED})),
      patch.object(social_routes, "_require_member", return_value=self.app),
      patch.object(social_groups, "_require_member", return_value=self.app),
    ):
      patcher.start()
      self.addCleanup(patcher.stop)

  async def test_direct_retry_reaction_and_edit_to_a_banned_peer_are_refused(self):
    attempts = {
      "retry": lambda peer: social_routes.retry_direct_message(
        peer, MESSAGE_ID, db=None, principal=self.owner),
      "reaction": lambda peer: social_routes.react_to_direct_message(
        peer, MESSAGE_ID, social_routes.MessageReaction(emoji="🎉", on=True), db=None,
        principal=self.owner),
      "edit": lambda peer: social_routes.edit_direct_message(
        peer, MESSAGE_ID, social_routes.MessageEdit(text="edited"), db=None, principal=self.owner),
    }
    with patch.object(social_routes, "_post_signed_envelope", new=AsyncMock()) as sent:
      for name, attempt in attempts.items():
        # The peer is normalised before the check, as it is for sending.
        with self.subTest(name), self.assertRaises(HTTPException) as caught:
          await attempt(" Bad.Example ")
        self.assertEqual((caught.exception.status_code, caught.exception.detail),
                         (403, social_routes.BANNED_PERSON))
      sent.assert_not_called()

  async def test_a_new_group_never_invites_a_banned_member(self):
    with (patch.object(social_groups, "_load_identity", return_value={"joined_at": 1.0}),
          patch.object(social_groups, "_fan_out", new=AsyncMock()) as fan_out,
          patch.object(social_groups, "_store_group_meta", new=AsyncMock()) as stored):
      with self.assertRaises(HTTPException) as caught:
        await social_groups.create_group(
          social_groups.CreateGroup(name="Friends", members=["good.example", "BAD.example"]),
          db=None, principal=self.owner,
        )
    self.assertEqual((caught.exception.status_code, caught.exception.detail),
                     (403, social_routes.BANNED_PERSON))
    fan_out.assert_not_called()
    stored.assert_not_called()

  async def test_group_fan_out_skips_banned_members_except_to_let_them_go(self):
    delivered = []

    async def deliver(host, envelope):
      delivered.append((host, envelope["type"]))
      return True

    with patch.object(social_groups, "_deliver", new=deliver):
      for kind in ("group_message", "group_reaction", "group_edited", "group_added"):
        delivered.clear()
        with self.subTest(kind):
          result = await social_groups._fan_out({}, {
            "good.example": {"type": kind}, BANNED: {"type": kind},
          })
          self.assertEqual(result, {"good.example": True, BANNED: False})
          self.assertEqual(delivered, [("good.example", kind)])
      for kind in ("group_removed", "group_deleted"):
        delivered.clear()
        with self.subTest(kind):
          self.assertEqual(await social_groups._fan_out({}, {BANNED: {"type": kind}}), {BANNED: True})
          self.assertEqual(delivered, [(BANNED, kind)])


if __name__ == "__main__":
  unittest.main()
