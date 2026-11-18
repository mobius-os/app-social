"""Authors can delete their own replies and edit their own posts and replies."""

import os
import tempfile
import time
import unittest
import uuid
from contextlib import ExitStack, contextmanager
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx

from fastapi import HTTPException
from fastapi.testclient import TestClient

import common_public
import community_host

os.environ.setdefault("APP_STORAGE_DIR", "/tmp/social-message-tests")
os.environ.setdefault("APP_ID", "7")
os.environ.setdefault("APP_SLUG", "social")
import social_routes  # noqa: E402  (reads its app identity at import)
from test_community_host import _peer, _signed
from test_reply_photo import photo, wire


def _seed(store, post_id, reply_id, *, reply_host="replier.example"):
  store.store_post({"id": post_id, "host": "author.example", "handle": "author",
                    "text": "Post", "created_at": 1.0, "replies": []})
  store.add_reply(post_id, reply_id, reply_host, "replier", "x", 2.0)


class ReplyDeleteTests(unittest.TestCase):
  def test_author_deletes_only_their_reply_and_a_retry_cannot_restore_it(self):
    with tempfile.TemporaryDirectory() as root:
      store = common_public.CommonPublicStore(root)
      post_id, mine, other = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
      _seed(store, post_id, mine)
      store.add_reply(post_id, other, "someone.example", "someone", "keep", 3.0)

      self.assertEqual(store.delete_reply(post_id, mine, "replier.example"),
                       {"status": "deleted", "reply_count": 1})
      self.assertEqual([r["id"] for r in store.get_replies(post_id)["replies"]], [other])
      # Idempotent, and the original signed reply cannot be replayed back in.
      self.assertEqual(store.delete_reply(post_id, mine, "replier.example")["status"], "deleted")
      with self.assertRaises(HTTPException) as caught:
        store.add_reply(post_id, mine, "replier.example", "replier", "x", 2.0)
      self.assertEqual(caught.exception.status_code, 410)
      page = store.read_board(10, None)
      self.assertEqual(page[0]["reply_count"], 1)
      self.assertNotIn("_deleted_replies", page[0])

  def test_nobody_else_can_delete_a_reply_including_the_post_author(self):
    with tempfile.TemporaryDirectory() as root:
      store = common_public.CommonPublicStore(root)
      post_id, reply_id = str(uuid.uuid4()), str(uuid.uuid4())
      _seed(store, post_id, reply_id)
      for host in ("author.example", "stranger.example"):
        with self.assertRaises(HTTPException) as caught:
          store.delete_reply(post_id, reply_id, host)
        self.assertEqual(caught.exception.status_code, 403)
      self.assertEqual(len(store.get_replies(post_id)["replies"]), 1)

  def test_deleting_a_photo_reply_removes_its_media(self):
    with tempfile.TemporaryDirectory() as root:
      store = common_public.CommonPublicStore(root)
      post_id, reply_id = str(uuid.uuid4()), str(uuid.uuid4())
      store.store_post({"id": post_id, "host": "author.example", "text": "Post",
                        "created_at": 1.0, "replies": []})
      data = photo()
      store.add_reply(post_id, reply_id, "replier.example", "replier", "", 2.0,
                      (wire(data), data))
      self.assertIsNotNone(store.reply_image(post_id, reply_id))
      store.delete_reply(post_id, reply_id, "replier.example")
      self.assertFalse(any((store.reply_media_dir() / post_id).iterdir()))


class EditTests(unittest.TestCase):
  def test_author_edits_post_and_reply_text_and_older_edits_never_win(self):
    with tempfile.TemporaryDirectory() as root:
      store = common_public.CommonPublicStore(root)
      post_id, reply_id = str(uuid.uuid4()), str(uuid.uuid4())
      _seed(store, post_id, reply_id)

      store.edit_text(post_id, None, "author.example", "Post, fixed", 10.0)
      result = store.edit_text(post_id, reply_id, "replier.example", "y", 10.0)
      self.assertEqual(result, {"status": "ok", "applied": True, "text": "y", "edited_at": 10.0})
      stale = store.edit_text(post_id, reply_id, "replier.example", "x again", 9.0)
      self.assertEqual((stale["applied"], stale["text"]), (False, "y"))

      post = store.read_board(10, None)[0]
      self.assertEqual((post["text"], post["edited_at"]), ("Post, fixed", 10.0))
      reply = store.get_replies(post_id)["replies"][0]
      self.assertEqual((reply["text"], reply["edited_at"]), ("y", 10.0))

  def test_an_unchanged_newer_edit_still_blocks_an_older_delayed_one(self):
    with tempfile.TemporaryDirectory() as root:
      store = common_public.CommonPublicStore(root)
      post_id, reply_id = str(uuid.uuid4()), str(uuid.uuid4())
      _seed(store, post_id, reply_id)
      same = store.edit_text(post_id, reply_id, "replier.example", "x", 20.0)
      self.assertEqual((same["applied"], same["edited_at"]), (True, None))
      late = store.edit_text(post_id, reply_id, "replier.example", "older", 15.0)
      self.assertFalse(late["applied"])
      reply = store.get_replies(post_id)["replies"][0]
      self.assertEqual(reply["text"], "x")
      self.assertNotIn("edited_at", reply)
      self.assertNotIn("_edit_clock", reply)
      store.edit_text(post_id, None, "author.example", "Post", 30.0)
      self.assertNotIn("_edit_clock", store.read_board(10, None)[0])

  def test_only_the_author_may_edit_and_text_only_items_cannot_go_empty(self):
    with tempfile.TemporaryDirectory() as root:
      store = common_public.CommonPublicStore(root)
      post_id, reply_id = str(uuid.uuid4()), str(uuid.uuid4())
      _seed(store, post_id, reply_id)
      for args, code in (
        ((post_id, reply_id, "author.example", "hijack", 5.0), 403),
        ((post_id, None, "replier.example", "hijack", 5.0), 403),
        ((post_id, reply_id, "replier.example", "  ", 5.0), 400),
        ((post_id, str(uuid.uuid4()), "replier.example", "y", 5.0), 404),
      ):
        with self.assertRaises(HTTPException) as caught:
          store.edit_text(*args)
        self.assertEqual(caught.exception.status_code, code)

  def test_a_photo_reply_may_drop_its_caption(self):
    with tempfile.TemporaryDirectory() as root:
      store = common_public.CommonPublicStore(root)
      post_id, reply_id = str(uuid.uuid4()), str(uuid.uuid4())
      store.store_post({"id": post_id, "host": "author.example", "text": "Post",
                        "created_at": 1.0, "replies": []})
      data = photo()
      store.add_reply(post_id, reply_id, "replier.example", "replier", "cap", 2.0,
                      (wire(data), data))
      self.assertEqual(store.edit_text(post_id, reply_id, "replier.example", "", 5.0)["text"], "")


class RetryTests(unittest.TestCase):
  def test_retrying_an_edited_reply_with_its_original_text_confirms_it(self):
    with tempfile.TemporaryDirectory() as root:
      store = common_public.CommonPublicStore(root)
      post_id, reply_id = str(uuid.uuid4()), str(uuid.uuid4())
      _seed(store, post_id, reply_id)
      # Before any edit, other text under the same id is still a conflict.
      with self.assertRaises(HTTPException) as caught:
        store.add_reply(post_id, reply_id, "replier.example", "replier", "other", 2.0)
      self.assertEqual(caught.exception.status_code, 409)
      store.edit_text(post_id, reply_id, "replier.example", "x, edited", 10.0)
      retry = store.add_reply(post_id, reply_id, "replier.example", "replier", "x", 2.0)
      self.assertEqual((retry["status"], retry["activity"], retry["reply_count"]), ("ok", False, 1))
      self.assertEqual(store.get_replies(post_id)["replies"][0]["text"], "x, edited")
      # Another author, or different media, still never confirms under this id.
      with self.assertRaises(HTTPException) as caught:
        store.add_reply(post_id, reply_id, "someone.example", "someone", "x", 2.0)
      self.assertEqual(caught.exception.status_code, 409)
      data = photo()
      with self.assertRaises(HTTPException) as caught:
        store.add_reply(post_id, reply_id, "replier.example", "replier", "x", 2.0,
                        (wire(data), data))
      self.assertEqual(caught.exception.status_code, 409)


class PostIdTests(unittest.TestCase):
  def test_a_post_id_confirms_its_own_retry_but_is_never_shared(self):
    with tempfile.TemporaryDirectory() as root:
      store = common_public.CommonPublicStore(root)
      post_id = str(uuid.uuid4())
      record = {"id": post_id, "host": "author.example", "text": "Hi", "created_at": 1.0, "replies": []}
      self.assertTrue(store.store_post(dict(record)))
      self.assertFalse(store.store_post(dict(record)))
      with self.assertRaises(HTTPException) as caught:
        store.store_post({**record, "host": "other.example", "text": "Mine now"})
      self.assertEqual(caught.exception.status_code, 409)
      self.assertEqual(store.read_board(10, None)[0]["text"], "Hi")


class SignedRouteTests(unittest.TestCase):
  def test_host_advertises_author_edits(self):
    with tempfile.TemporaryDirectory() as data_dir:
      with TestClient(community_host.create_app(data_dir)) as client:
        capabilities = client.get("/api/common/board").json()["capabilities"]
      self.assertIs(capabilities["author_edits"], True)
      self.assertIs(capabilities["reply_reactions"], True)

  def test_an_exact_post_retry_with_the_same_id_lands_once(self):
    with tempfile.TemporaryDirectory() as data_dir:
      author = _peer(Path(data_dir), "author.example")
      store = common_public.CommonPublicStore(data_dir)
      store.register("author.example", "author", "")
      post_id = str(uuid.uuid4())
      with TestClient(community_host.create_app(data_dir)) as client:
        for sent_at in (time.time(), time.time() + 1):
          # The relay re-signs each retry, so only the id and content repeat.
          sent = client.post("/api/common/board", json=_signed(author, {
            "v": 0, "type": "board_post", "id": post_id, "from": "author.example",
            "text": "Hello once", "sent_at": sent_at,
          }))
          self.assertEqual(sent.status_code, 200, sent.text)
          self.assertEqual(sent.json(), {"status": "posted"})
      posts = store.read_board(10, None)
      self.assertEqual([(post["id"], post["text"]) for post in posts], [(post_id, "Hello once")])


  def test_signed_reply_delete_and_edit_routes(self):
    with tempfile.TemporaryDirectory() as data_dir:
      root = Path(data_dir)
      replier = _peer(root, "replier.example")
      store = common_public.CommonPublicStore(data_dir)
      store.register("replier.example", "replier", "")
      post_id, reply_id = str(uuid.uuid4()), str(uuid.uuid4())
      _seed(store, post_id, reply_id)
      with TestClient(community_host.create_app(data_dir)) as client:
        edited = client.post("/api/common/board/edit", json=_signed(replier, {
          "v": 0, "type": "board_edit", "post_id": post_id, "reply_id": reply_id,
          "text": "edited", "from": "replier.example", "sent_at": time.time(),
        }))
        self.assertEqual(edited.status_code, 200, edited.text)
        self.assertEqual(edited.json()["text"], "edited")
        # A reply-delete envelope is never accepted as a whole-post delete.
        wrong = client.post("/api/common/board/delete", json=_signed(replier, {
          "v": 0, "type": "board_reply_delete", "post_id": post_id, "reply_id": reply_id,
          "from": "replier.example", "sent_at": time.time(),
        }))
        self.assertEqual(wrong.status_code, 400)
        deleted = client.post("/api/common/board/reply/delete", json=_signed(replier, {
          "v": 0, "type": "board_reply_delete", "post_id": post_id, "reply_id": reply_id,
          "from": "replier.example", "sent_at": time.time(),
        }))
        self.assertEqual(deleted.json(), {"status": "deleted", "reply_count": 0})
        forged = client.post("/api/common/board/edit", json={
          "v": 0, "type": "board_edit", "post_id": post_id, "text": "forged",
          "from": "author.example", "sent_at": time.time(), "sig": "AAAA",
        })
        self.assertEqual(forged.status_code, 403)
      self.assertEqual(store.read_board(10, None)[0]["text"], "Post")


class CommunityRoleModerationTests(unittest.TestCase):
  """The deployment names an owner and admins; both moderate, members don't."""

  def test_store_lets_a_moderator_delete_others_posts_and_replies(self):
    with tempfile.TemporaryDirectory() as root:
      store = common_public.CommonPublicStore(root)
      post_id, reply_id = str(uuid.uuid4()), str(uuid.uuid4())
      _seed(store, post_id, reply_id)
      with self.assertRaises(HTTPException) as caught:
        store.delete_post(post_id, "admin.example")
      self.assertEqual(caught.exception.status_code, 403)
      self.assertEqual(store.delete_reply(post_id, reply_id, "admin.example", moderator=True),
                       {"status": "deleted", "reply_count": 0})
      self.assertEqual(store.delete_post(post_id, "admin.example", moderator=True),
                       {"status": "deleted"})
      self.assertEqual(store.read_board(10, None), [])

  def test_roles_come_from_settings_and_an_owner_listed_twice_stays_owner(self):
    with patch.dict(os.environ, {"COMMUNITY_OWNER_HOSTS": " Owner.example ",
                                 "COMMUNITY_ADMIN_HOSTS": "admin.example, owner.example,"}):
      self.assertEqual(community_host.community_roles(),
                       {"owner.example": "owner", "admin.example": "admin"})
    with patch.dict(os.environ, {"COMMUNITY_OWNER_HOSTS": "", "COMMUNITY_ADMIN_HOSTS": ""}):
      self.assertEqual(community_host.community_roles(), {})

  def test_an_owner_setting_with_several_hosts_seeds_no_owner(self):
    with patch.dict(os.environ, {"COMMUNITY_OWNER_HOSTS": "one.example, two.example",
                                 "COMMUNITY_ADMIN_HOSTS": "admin.example"}), \
        self.assertLogs("social", level="WARNING"):
      self.assertEqual(community_host.community_roles(), {"admin.example": "admin"})
    with patch.dict(os.environ, {"COMMUNITY_OWNER_HOSTS": "one.example,one.example"}):
      self.assertEqual(community_host.community_roles()["one.example"], "owner")

  def test_owner_and_admin_moderate_members_cannot_and_the_board_names_roles(self):
    with tempfile.TemporaryDirectory() as data_dir, \
        patch.dict(os.environ, {"COMMUNITY_OWNER_HOSTS": "owner.example",
                                "COMMUNITY_ADMIN_HOSTS": "admin.example"}):
      root = Path(data_dir)
      keys = {host: _peer(root, host) for host in ("owner.example", "admin.example", "member.example")}
      store = common_public.CommonPublicStore(data_dir)
      for host in keys:
        store.register(host, host.split(".")[0], "")
      posts = [(str(uuid.uuid4()), str(uuid.uuid4())) for _ in range(2)]
      for post_id, reply_id in posts:
        _seed(store, post_id, reply_id)

      def send(host, path, kind, post_id, reply_id=None):
        body = {"v": 0, "type": kind, "post_id": post_id, "from": host, "sent_at": time.time()}
        if reply_id:
          body["reply_id"] = reply_id
        return client.post(f"/api/common/{path}", json=_signed(keys[host], body))

      with TestClient(community_host.create_app(data_dir)) as client:
        self.assertEqual(client.get("/api/common/board").json()["capabilities"]["roles"],
                         {"admin.example": "admin", "owner.example": "owner"})
        post_id, reply_id = posts[0]
        self.assertEqual(send("member.example", "board/reply/delete", "board_reply_delete",
                              post_id, reply_id).status_code, 403)
        self.assertEqual(send("member.example", "board/delete", "board_delete", post_id).status_code, 403)
        for moderator, (post_id, reply_id) in zip(("owner.example", "admin.example"), posts):
          self.assertEqual(send(moderator, "board/reply/delete", "board_reply_delete",
                                post_id, reply_id).json(), {"status": "deleted", "reply_count": 0})
          self.assertEqual(send(moderator, "board/delete", "board_delete", post_id).json(),
                           {"status": "deleted"})
      self.assertEqual(store.read_board(10, None), [])


class CommunityRoleChangeTests(unittest.TestCase):
  """Only the owner changes roles; saved roles replace the deployment seed."""

  SEED = {"owner.example": "owner", "admin.example": "admin"}

  def _store(self, root):
    store = common_public.CommonPublicStore(root)
    for host in ("owner.example", "admin.example", "member.example"):
      store.register(host, host.split(".")[0], "")
    return store

  def test_owner_promotes_demotes_and_hands_over_once(self):
    with tempfile.TemporaryDirectory() as root:
      store = self._store(root)
      self.assertEqual(store.community_roles(self.SEED), self.SEED)
      self.assertEqual(store.set_community_role("owner.example", "member.example", "admin", 1.0, self.SEED)["roles"],
                       {"admin.example": "admin", "member.example": "admin", "owner.example": "owner"})
      store.set_community_role("owner.example", "admin.example", "none", 2.0, self.SEED)
      # Saved roles win from now on, whatever the settings say.
      self.assertEqual(store.community_roles({"someone.example": "owner"}),
                       {"owner.example": "owner", "member.example": "admin"})
      handed = store.set_community_role("owner.example", "member.example", "owner", 3.0)["roles"]
      self.assertEqual(handed, {"member.example": "owner", "owner.example": "admin"})
      self.assertEqual(list(handed.values()).count("owner"), 1)

  def test_only_the_owner_changes_roles_and_only_for_members(self):
    with tempfile.TemporaryDirectory() as root:
      store = self._store(root)
      for actor in ("admin.example", "member.example"):
        with self.assertRaises(HTTPException) as caught:
          store.set_community_role(actor, "member.example" if actor != "member.example" else "admin.example",
                                   "admin", 1.0, self.SEED)
        self.assertEqual(caught.exception.status_code, 403)
      for target, role in (("owner.example", "none"), ("stranger.example", "admin"),
                           ("member.example", "member")):
        with self.assertRaises(HTTPException) as caught:
          store.set_community_role("owner.example", target, role, 1.0, self.SEED)
        self.assertEqual(caught.exception.status_code, 400)
      self.assertFalse(store.roles_path().exists())

  def test_an_older_role_change_never_undoes_a_newer_one(self):
    with tempfile.TemporaryDirectory() as root:
      store = self._store(root)
      store.set_community_role("owner.example", "member.example", "admin", 10.0, self.SEED)
      store.set_community_role("owner.example", "member.example", "none", 20.0, self.SEED)
      # A retry of the promotion, and an older promotion delivered only now.
      for sent_at in (10.0, 15.0, 20.0):
        with self.assertRaises(HTTPException) as caught:
          store.set_community_role("owner.example", "member.example", "admin", sent_at, self.SEED)
        self.assertEqual(caught.exception.status_code, 409)
      self.assertNotIn("member.example", store.community_roles(self.SEED))
      store.set_community_role("owner.example", "member.example", "admin", 21.0, self.SEED)
      self.assertEqual(store.community_roles(self.SEED)["member.example"], "admin")

  def test_signed_role_route_updates_the_board_roles(self):
    with tempfile.TemporaryDirectory() as data_dir, \
        patch.dict(os.environ, {"COMMUNITY_OWNER_HOSTS": "owner.example",
                                "COMMUNITY_ADMIN_HOSTS": "admin.example"}):
      root = Path(data_dir)
      keys = {host: _peer(root, host) for host in ("owner.example", "admin.example", "member.example")}
      self._store(data_dir)

      def envelope(actor, target, role, sent_at=None):
        return _signed(keys[actor], {
          "v": 0, "type": "community_role", "target": target, "role": role,
          "from": actor, "sent_at": time.time() if sent_at is None else sent_at,
        })

      def change(actor, target, role):
        return client.post("/api/common/board/role", json=envelope(actor, target, role))

      with TestClient(community_host.create_app(data_dir)) as client:
        self.assertEqual(change("admin.example", "member.example", "admin").status_code, 403)
        # Promote, revoke, then replay the exact signed promotion: refused.
        promotion = envelope("owner.example", "member.example", "admin", time.time() - 5)
        self.assertEqual(client.post("/api/common/board/role", json=promotion).status_code, 200)
        self.assertEqual(change("owner.example", "member.example", "none").status_code, 200)
        replay = client.post("/api/common/board/role", json=promotion)
        self.assertEqual(replay.status_code, 409, replay.text)
        self.assertNotIn("member.example", client.get("/api/common/board").json()["capabilities"]["roles"])
        self.assertEqual(change("owner.example", "member.example", "admin").status_code, 200)
        self.assertEqual(change("owner.example", "admin.example", "owner").status_code, 200)
        self.assertEqual(client.get("/api/common/board").json()["capabilities"]["roles"],
                         {"admin.example": "owner", "member.example": "admin", "owner.example": "admin"})
        # The former owner is now an admin: still moderates, can't change roles.
        self.assertEqual(change("owner.example", "member.example", "none").status_code, 403)


class CommunityBanTests(unittest.TestCase):
  """Owners and admins ban ordinary members from posting; the host enforces it."""

  ROLES = {"owner.example": "owner", "admin.example": "admin"}

  def _store(self, root):
    store = common_public.CommonPublicStore(root)
    for host in ("owner.example", "admin.example", "member.example", "other.example"):
      store.register(host, host.split(".")[0], "")
    return store

  def test_moderators_ban_and_unban_members_but_never_each_other(self):
    with tempfile.TemporaryDirectory() as root:
      store = self._store(root)
      self.assertEqual(store.set_member_ban("admin.example", "member.example", True, 1.0, self.ROLES),
                       {"banned": ["member.example"]})
      self.assertEqual(store.set_member_ban("owner.example", "member.example", False, 2.0, self.ROLES),
                       {"banned": []})
      refusals = (
        ("member.example", "other.example", 403),   # ordinary members can't ban
        ("admin.example", "owner.example", 400),    # nor can anyone ban a moderator
        ("owner.example", "admin.example", 400),
        ("admin.example", "admin.example", 400),
        ("owner.example", "stranger.example", 400),  # only directory members
      )
      for actor, target, status in refusals:
        with self.subTest(actor=actor, target=target):
          with self.assertRaises(HTTPException) as caught:
            store.set_member_ban(actor, target, True, 3.0, self.ROLES)
          self.assertEqual(caught.exception.status_code, status)
      self.assertEqual(store.banned_members(), set())

  def test_an_older_ban_change_never_undoes_a_newer_one(self):
    with tempfile.TemporaryDirectory() as root:
      store = self._store(root)
      store.set_member_ban("admin.example", "member.example", True, 10.0, self.ROLES)
      store.set_member_ban("owner.example", "member.example", False, 20.0, self.ROLES)
      # The admin's ban replayed, or a different moderator's late older ban.
      for actor, sent_at in (("admin.example", 10.0), ("owner.example", 15.0)):
        with self.assertRaises(HTTPException) as caught:
          store.set_member_ban(actor, "member.example", True, sent_at, self.ROLES)
        self.assertEqual(caught.exception.status_code, 409)
      self.assertEqual(store.banned_members(), set())

  def test_a_banned_member_can_read_and_delete_but_not_post_reply_edit_or_react(self):
    with tempfile.TemporaryDirectory() as data_dir, \
        patch.dict(os.environ, {"COMMUNITY_OWNER_HOSTS": "owner.example",
                                "COMMUNITY_ADMIN_HOSTS": "admin.example"}):
      root = Path(data_dir)
      keys = {host: _peer(root, host) for host in ("owner.example", "admin.example", "member.example")}
      store = self._store(data_dir)
      post_id, mine = str(uuid.uuid4()), str(uuid.uuid4())
      _seed(store, post_id, mine, reply_host="member.example")

      def send(host, path, body):
        return client.post(f"/api/common/{path}", json=_signed(keys[host], {
          "v": 0, "from": host, "sent_at": time.time(), **body}))

      def ban(actor, banned):
        return send(actor, "board/ban", {"type": "community_ban", "target": "member.example",
                                         "banned": banned})

      writes = {
        "post": ("board", {"type": "board_post", "id": str(uuid.uuid4()), "text": "Hi"}),
        "reply": ("board/reply", {"type": "board_reply", "post_id": post_id,
                                  "id": str(uuid.uuid4()), "text": "Hi"}),
        "edit": ("board/edit", {"type": "board_edit", "post_id": post_id,
                                "reply_id": mine, "text": "changed"}),
        "react": ("board/react", {"type": "board_react", "post_id": post_id, "emoji": "❤️"}),
      }
      with TestClient(community_host.create_app(data_dir)) as client:
        self.assertEqual(client.get("/api/common/board").json()["capabilities"]["banned"], [])
        self.assertEqual(ban("member.example", True).status_code, 403)
        banned = ban("admin.example", True)
        self.assertEqual(banned.json(), {"banned": ["member.example"]}, banned.text)
        self.assertEqual(client.get("/api/common/board").json()["capabilities"]["banned"],
                         ["member.example"])
        for name, (path, body) in writes.items():
          with self.subTest(write=name):
            refused = send("member.example", path, body)
            self.assertEqual((refused.status_code, refused.json()["detail"]),
                             (403, common_public.BANNED_FROM_POSTING))
        # Removing their own content stays possible.
        removed = send("member.example", "board/reply/delete",
                       {"type": "board_reply_delete", "post_id": post_id, "reply_id": mine})
        self.assertEqual(removed.json(), {"status": "deleted", "reply_count": 0})
        self.assertEqual(ban("owner.example", False).json(), {"banned": []})
        path, body = writes["post"]
        self.assertEqual(send("member.example", path, body).status_code, 200)

  def test_a_banned_member_made_admin_is_no_longer_banned(self):
    with tempfile.TemporaryDirectory() as data_dir, \
        patch.dict(os.environ, {"COMMUNITY_OWNER_HOSTS": "owner.example",
                                "COMMUNITY_ADMIN_HOSTS": "admin.example"}):
      store = self._store(data_dir)
      store.set_member_ban("owner.example", "member.example", True, 1.0, self.ROLES)
      store.set_community_role("owner.example", "member.example", "admin", 2.0, self.ROLES)
      with TestClient(community_host.create_app(data_dir)) as client:
        self.assertEqual(client.get("/api/common/board").json()["capabilities"]["banned"], [])


class CommunityLockoutTests(unittest.TestCase):
  """A ban locks the member out of the board and People, not just posting."""

  def test_a_banned_member_sees_no_board_and_no_one_in_people(self):
    with tempfile.TemporaryDirectory() as data_dir, \
        patch.dict(os.environ, {"COMMUNITY_OWNER_HOSTS": "owner.example",
                                "COMMUNITY_ADMIN_HOSTS": "admin.example"}):
      root = Path(data_dir)
      keys = {host: _peer(root, host) for host in ("owner.example", "member.example", "other.example")}
      store = CommunityBanTests()._store(data_dir)
      _seed(store, str(uuid.uuid4()), str(uuid.uuid4()))
      store.set_member_ban("owner.example", "member.example", True, 1.0,
                           {"owner.example": "owner", "admin.example": "admin"})

      def search(host, q=""):
        return client.post("/api/common/directory/search", json=_signed(keys[host], {
          "v": 0, "type": "directory_read", "from": host, "q": q, "sent_at": time.time()})).json()

      with TestClient(community_host.create_app(data_dir)) as client:
        locked = client.get("/api/common/board", params={"viewer": "member.example"}).json()
        self.assertEqual((locked["posts"], locked["viewer_banned"]), ([], True))
        self.assertEqual(locked["capabilities"]["banned"], ["member.example"])
        self.assertTrue(client.get("/api/common/board", params={"viewer": "other.example"}).json()["posts"])
        # Only their own entry, so their Social still knows it is registered.
        self.assertEqual(search("member.example"),
                         {"users": [{"host": "member.example", "handle": "member", "bio": ""}],
                          "viewer_banned": True})
        self.assertNotIn("member.example", [user["host"] for user in search("other.example")["users"]])
        # Moderators still find them, to unban them.
        self.assertIn("member.example", [user["host"] for user in search("owner.example")["users"]])


class MessagingBanTests(unittest.IsolatedAsyncioTestCase):
  """Each instance refuses messages to or from a banned member."""

  async def test_messaging_is_refused_for_a_banned_peer_or_a_banned_owner(self):
    with patch.object(social_routes, "_own_host", return_value="me.example"):
      with patch.object(social_routes, "_community_bans", new=AsyncMock(return_value={"bad.example"})):
        await social_routes._refuse_banned_messaging("good.example")
        with self.assertRaises(HTTPException) as caught:
          await social_routes._refuse_banned_messaging("bad.example")
        self.assertEqual((caught.exception.status_code, caught.exception.detail),
                         (403, social_routes.BANNED_PERSON))
      with patch.object(social_routes, "_community_bans", new=AsyncMock(return_value={"me.example"})):
        with self.assertRaises(HTTPException) as caught:
          await social_routes._refuse_banned_messaging()
        self.assertEqual(caught.exception.detail, common_public.BANNED_FROM_COMMUNITY)

  async def test_the_ban_list_is_saved_from_the_board_and_kept_when_the_host_is_down(self):
    with tempfile.TemporaryDirectory() as data_dir, \
        patch.object(social_routes, "_common_dir", return_value=Path(data_dir)), \
        patch.object(social_routes, "_own_host", return_value="me.example"):
      board = AsyncMock(return_value=httpx.Response(200, json={"capabilities": {"banned": ["bad.example"]}, "posts": []},
        request=httpx.Request("GET", "https://community.example/board")))
      with patch.object(social_routes, "federation_request", new=board):
        self.assertEqual(await social_routes._community_bans(), {"bad.example"})
        # Fresh: no second board read.
        self.assertEqual(await social_routes._community_bans(), {"bad.example"})
      self.assertEqual(board.await_count, 1)
      saved = social_routes._saved_community_bans()
      social_routes.atomic_write(social_routes._community_bans_path(),
                                 '{"banned": ["bad.example"], "fetched_at": 0}')
      with patch.object(social_routes, "federation_request", new=AsyncMock(side_effect=httpx.ConnectError("down"))):
        self.assertEqual(await social_routes._community_bans(), {"bad.example"})
      self.assertGreater(social_routes._saved_community_bans()["fetched_at"], saved["fetched_at"] - 1)

  async def test_send_and_both_inboxes_check_the_ban(self):
    import social_groups
    source = Path(social_routes.__file__).read_text()
    self.assertIn("  await _refuse_banned_messaging(to_host)\n", source)
    self.assertEqual(source.count('await _refuse_banned_messaging(envelope["from"])'), 3)
    groups = Path(social_groups.__file__).read_text()
    self.assertIn('if envelope["type"] not in _GROUP_LEAVING_KINDS:', groups)
    self.assertGreaterEqual(groups.count("await _refuse_banned_messaging()"), 5)
    # Outgoing traffic checks its destinations too, not only the local owner.
    self.assertEqual(source.count("  await _refuse_banned_messaging(peer)\n"), 3)
    self.assertIn("  await _refuse_banned_messaging(*member_hosts)\n", groups)


@contextmanager
def _owner_relay(host):
  with ExitStack() as stack:
    for patcher in _owner_patches(host):
      stack.enter_context(patcher)
    yield


def _owner_patches(host):
  return (
    patch.object(social_routes, "require_nondelegated_owner_control"),
    patch.object(social_routes, "_require_member"),
    patch.object(social_routes, "_load_identity", return_value={"private_key_b64": "fixture"}),
    patch.object(social_routes, "_require_username"),
    patch.object(social_routes, "_sign", return_value="fixture-signature"),
    patch.object(social_routes, "_own_host", return_value="self.example"),
    # Author actions share the signed-write transport (and its timeout).
    patch.object(social_routes, "_post_signed_envelope", new=host),
  )


def _host_reply(status, detail):
  return AsyncMock(return_value=httpx.Response(status, json={"detail": detail},
    request=httpx.Request("POST", "https://community.example/board")))


class OwnerRelayTests(unittest.IsolatedAsyncioTestCase):
  async def _call(self, host, action):
    with _owner_relay(host):
      with self.assertRaises(HTTPException) as caught:
        await action()
    return caught.exception

  async def _relay(self, status, detail):
    host = _host_reply(status, detail)
    error = await self._call(host, lambda: social_routes.edit_own_board_text(
      social_routes.EditBoardText(post_id="abcdef12", reply_id="12abcdef", text=" new "),
      db=None, principal=None,
    ))
    envelope = host.await_args.args[1]
    self.assertEqual((envelope["type"], envelope["reply_id"], envelope["text"]),
                     ("board_edit", "12abcdef", "new"))
    return error

  async def test_acting_on_a_deleted_post_or_reply_reads_as_gone(self):
    actions = {
      "edit": lambda: social_routes.edit_own_board_text(
        social_routes.EditBoardText(post_id="abcdef12", reply_id="12abcdef", text="new"),
        db=None, principal=None),
      "reaction": lambda: social_routes.react_to_post(
        social_routes.ReactionPost(post_id="abcdef12", emoji="❤️", reply_id="12abcdef"),
        db=None, principal=None),
      "reply": lambda: social_routes.reply_to_post(
        social_routes.ReplyPost(post_id="abcdef12", id="12abcdef", text="x"),
        db=None, principal=None),
    }
    for name, action in actions.items():
      for detail in ("Unknown post.", "Unknown reply."):
        with self.subTest(action=name, detail=detail):
          gone = await self._call(_host_reply(404, detail), action)
          # Not 404: the app reads that as a server without the feature.
          self.assertEqual((gone.status_code, gone.detail), (410, "That message no longer exists."))
    older = await self._call(_host_reply(404, "Not Found"), actions["reaction"])
    self.assertEqual(older.status_code, 502)

  async def test_a_post_retry_keeps_its_id_and_a_bad_id_is_refused(self):
    host = AsyncMock(return_value=httpx.Response(200, json={"status": "posted"},
      request=httpx.Request("POST", "https://community.example/board")))
    with _owner_relay(host):
      for _ in range(2):
        result = await social_routes.publish_post(
          social_routes.PublishPost(text="Hello", id="abcdef12-3456"), db=None, principal=None)
        self.assertEqual(result, {"status": "posted", "id": "abcdef12-3456"})
        self.assertEqual(host.await_args.args[1]["id"], "abcdef12-3456")
      fresh = await social_routes.publish_post(
        social_routes.PublishPost(text="Hello"), db=None, principal=None)
      self.assertNotEqual(fresh["id"], "abcdef12-3456")
      with self.assertRaises(HTTPException) as caught:
        await social_routes.publish_post(
          social_routes.PublishPost(text="Hello", id="../not-an-id"), db=None, principal=None)
      self.assertEqual(caught.exception.status_code, 400)

  async def test_only_a_missing_route_reads_as_an_older_server(self):
    self.assertEqual((await self._relay(404, "Not Found")).status_code, 501)
    self.assertEqual((await self._relay(405, "Method Not Allowed")).status_code, 501)
    self.assertEqual((await self._relay(404, None)).status_code, 501)
    self.assertEqual((await self._relay(400, "Unsupported envelope type.")).status_code, 501)
    gone = await self._relay(404, "Unknown reply.")
    self.assertEqual((gone.status_code, gone.detail), (410, "That message no longer exists."))
    self.assertEqual((await self._relay(403, "Only the author may edit this.")).status_code, 403)

  async def test_host_validation_reasons_reach_the_author(self):
    empty = await self._relay(400, "Text cannot be empty.")
    self.assertEqual((empty.status_code, empty.detail), (400, "Text can’t be empty."))
    other = await self._relay(400, "Something unexpected.")
    self.assertEqual((other.status_code, other.detail), (502, "Your edit couldn’t be saved."))

  async def test_a_ban_reaches_the_host_and_its_refusal_reaches_the_member(self):
    host = AsyncMock(return_value=httpx.Response(200, json={"banned": ["member.example"]},
      request=httpx.Request("POST", "https://community.example/board/ban")))
    with _owner_relay(host):
      result = await social_routes.change_member_ban(
        social_routes.CommunityBan(host=" Member.Example ", banned=True), db=None, principal=None)
    self.assertEqual(result, {"banned": ["member.example"]})
    envelope = host.await_args.args[1]
    self.assertEqual((envelope["type"], envelope["target"], envelope["banned"]),
                     ("community_ban", "member.example", True))
    banned = common_public.BANNED_FROM_POSTING
    for name, action in {
      "post": lambda: social_routes.publish_post(
        social_routes.PublishPost(text="Hello"), db=None, principal=None),
      "reply": lambda: social_routes.reply_to_post(
        social_routes.ReplyPost(post_id="abcdef12", id="12abcdef", text="x"), db=None, principal=None),
      "reaction": lambda: social_routes.react_to_post(
        social_routes.ReactionPost(post_id="abcdef12", emoji="❤️"), db=None, principal=None),
    }.items():
      with self.subTest(action=name):
        self.assertEqual((await self._call(_host_reply(403, banned), action)).detail, banned)
    self.assertEqual((await self._relay(403, banned)).detail, banned)
    unverified = await self._call(_host_reply(403, "Signature is invalid."), lambda: social_routes.react_to_post(
      social_routes.ReactionPost(post_id="abcdef12", emoji="❤️"), db=None, principal=None))
    self.assertIn("could not verify", unverified.detail)

  async def test_retrying_a_deleted_reply_stops_instead_of_reposting(self):
    error = await self._call(_host_reply(410, "This reply was deleted."),
      lambda: social_routes.reply_to_post(
        social_routes.ReplyPost(post_id="abcdef12", id="12abcdef", text="x"),
        db=None, principal=None))
    self.assertEqual((error.status_code, error.detail), (410, "This reply was deleted."))


if __name__ == "__main__":
  unittest.main()
