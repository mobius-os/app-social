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

  async def test_retrying_a_deleted_reply_stops_instead_of_reposting(self):
    error = await self._call(_host_reply(410, "This reply was deleted."),
      lambda: social_routes.reply_to_post(
        social_routes.ReplyPost(post_id="abcdef12", id="12abcdef", text="x"),
        db=None, principal=None))
    self.assertEqual((error.status_code, error.detail), (410, "This reply was deleted."))


if __name__ == "__main__":
  unittest.main()
