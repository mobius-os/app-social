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


if __name__ == "__main__":
  unittest.main()
