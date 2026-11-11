import asyncio
import base64
import hashlib
import io
import json
import os
import stat
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient
from PIL import Image

import common_public
import community_host
from common_protocol import COMMUNITY_HOST, canonical, verify


def _peer(root: Path, host: str) -> Ed25519PrivateKey:
  """Seed a cached actor card so the host can verify this peer's envelopes."""
  key = Ed25519PrivateKey.generate()
  public = base64.b64encode(key.public_key().public_bytes(
    serialization.Encoding.Raw, serialization.PublicFormat.Raw,
  )).decode()
  peers = root / "common" / "peers"
  peers.mkdir(parents=True, exist_ok=True)
  (peers / f"{host}.json").write_text(json.dumps({"fetched_at": time.time(), "actor": {
    "protocol": "common/0", "host": host, "handle": host.split(".")[0],
    "public_key": {"alg": "ed25519", "key_b64": public},
  }}))
  return key


def _signed(key: Ed25519PrivateKey, body: dict) -> dict:
  return {**body, "sig": base64.b64encode(key.sign(canonical(body))).decode()}


def _search(client, key, host: str, q: str = ""):
  return client.post("/api/common/directory/search", json=_signed(key, {
    "v": 0, "type": "directory_read", "from": host,
    "q": q, "sent_at": time.time(),
  }))


class _ActorCards:
  """Serve each member's live actor card (None: the member is unreachable)."""

  def __init__(self, handles: dict | None = None):
    self.handles = handles or {}

  async def fetch_actor(self, host: str, *, force: bool = False) -> dict:
    if self.handles.get(host) is None:
      raise common_public.HTTPException(status_code=502, detail="Peer could not be reached.")
    return {"protocol": "common/0", "host": host, "handle": self.handles[host]}


class CommunityHostTests(unittest.TestCase):
  def test_reply_selections_require_the_viewers_signature_not_a_claimed_host(self):
    with tempfile.TemporaryDirectory() as data_dir:
      root = Path(data_dir)
      member = _peer(root, "member.example")
      other = _peer(root, "other.example")
      outsider = _peer(root, "outsider.example")
      store = common_public.CommonPublicStore(data_dir)
      store.register("member.example", "member", "")
      store.register("other.example", "other", "")
      post_id, reply_id = str(uuid.uuid4()), str(uuid.uuid4())
      store.store_post({
        "id": post_id, "host": "author.example", "handle": "author",
        "text": "hello", "created_at": time.time(), "replies": [],
      })
      store.add_reply(post_id, reply_id, "other.example", "other", "reply", time.time())
      store.toggle_reaction(post_id, "member.example", "🎉", reply_id=reply_id)
      path = f"/api/common/board/{post_id}/replies"
      body = {
        "v": 0, "type": "board_replies", "from": "member.example",
        "post_id": post_id, "sent_at": time.time(),
      }
      with TestClient(community_host.create_app(data_dir)) as client:
        public = client.get(path, params={"viewer": "member.example"}).json()["replies"][0]
        self.assertEqual(public["reactions"], [{"emoji": "🎉", "count": 1, "reacted": False}])
        own = client.post(path, json=_signed(member, body)).json()["replies"][0]
        self.assertTrue(own["reactions"][0]["reacted"])
        other_body = {**body, "from": "other.example", "viewer": "member.example"}
        theirs = client.post(path, json=_signed(other, other_body)).json()["replies"][0]
        self.assertFalse(theirs["reactions"][0]["reacted"])
        self.assertEqual(client.post(path, json=_signed(other, body)).status_code, 403)
        self.assertEqual(client.post(path, json=_signed(outsider, {**body, "from": "outsider.example"})).status_code, 403)
        self.assertEqual(client.post(path, json=_signed(member, {**body, "post_id": reply_id})).status_code, 400)

  def test_board_is_public_but_people_require_signed_membership(self):
    with tempfile.TemporaryDirectory() as data_dir:
      peer = _peer(Path(data_dir), "peer.example")
      outsider = _peer(Path(data_dir), "outsider.example")
      store = common_public.CommonPublicStore(data_dir)
      store.register("peer.example", "peer", "")
      with TestClient(community_host.create_app(data_dir)) as client:
        self.assertEqual(client.get("/api/common/board").status_code, 200)
        public_people = client.get("/api/common/directory")
        self.assertEqual(public_people.status_code, 403)
        self.assertEqual(public_people.headers["cache-control"], "no-store")
        self.assertEqual(_search(client, outsider, "outsider.example").status_code, 403)
        outsider_post = _signed(outsider, {
          "v": 0, "type": "board_post", "id": str(uuid.uuid4()),
          "from": "outsider.example", "text": "Not joined", "sent_at": time.time(),
        })
        self.assertEqual(client.post("/api/common/board", json=outsider_post).status_code, 403)
        forged = _signed(peer, {
          "v": 0, "type": "directory_read", "from": "peer.example",
          "q": "", "sent_at": time.time(),
        })
        forged["q"] = "tampered"
        self.assertEqual(client.post("/api/common/directory/search", json=forged).status_code, 403)
        self.assertEqual(
          _search(client, peer, "peer.example").json()["users"][0]["host"],
          "peer.example",
        )

  def test_the_shared_gif_key_goes_only_to_signed_members(self):
    def ask(client, key, host):
      return client.post("/api/common/gifs/key", json=_signed(key, {
        "v": 0, "type": "gif_key_read", "from": host, "sent_at": time.time(),
      }))

    with tempfile.TemporaryDirectory() as data_dir:
      member = _peer(Path(data_dir), "peer.example")
      outsider = _peer(Path(data_dir), "outsider.example")
      common_public.CommonPublicStore(data_dir).register("peer.example", "peer", "")
      with patch.dict(os.environ, {"KLIPY_APP_KEY": ""}):
        with TestClient(community_host.create_app(data_dir)) as client:
          # Not configured: members learn that plainly.
          self.assertEqual(ask(client, member, "peer.example").status_code, 404)
      with patch.dict(os.environ, {"KLIPY_APP_KEY": "shared_key_123456"}):
        with TestClient(community_host.create_app(data_dir)) as client:
          granted = ask(client, member, "peer.example")
          self.assertEqual(granted.status_code, 200)
          self.assertEqual(granted.json(), {"provider": "klipy", "app_key": "shared_key_123456"})
          self.assertEqual(granted.headers["cache-control"], "no-store")
          self.assertEqual(ask(client, outsider, "outsider.example").status_code, 403)
          forged = _signed(member, {
            "v": 0, "type": "gif_key_read", "from": "peer.example", "sent_at": time.time(),
          })
          forged["from"] = "outsider.example"
          self.assertEqual(client.post("/api/common/gifs/key", json=forged).status_code, 403)
          self.assertNotIn("gifs/key", client.get("/api/common/board").text)

  def test_health_version_and_public_prefix_share_one_app(self):
    revision = "a" * 40
    with tempfile.TemporaryDirectory() as data_dir, patch.dict(
      os.environ, {"SOCIAL_SOURCE_SHA": revision}, clear=False,
    ):
      with TestClient(community_host.create_app(data_dir)) as client:
        self.assertEqual(client.get("/healthz").json(), {"status": "ok"})
        self.assertEqual(
          client.get("/version").json(),
          {"service": "mobius-social", "source_sha": revision},
        )
        self.assertEqual(client.get("/api/common/board").status_code, 200)
        self.assertEqual(client.get("/board").status_code, 404)
        # A malformed write proves the route exists without changing data.
        response = client.post("/api/common/board/delete", json={})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "Unsupported envelope type.")

  def test_signed_board_flow_serves_reactions_and_media(self):
    with tempfile.TemporaryDirectory() as data_dir:
      peer = _peer(Path(data_dir), "peer.example")
      common_public.CommonPublicStore(data_dir).register("peer.example", "peer", "")
      post_id = str(uuid.uuid4())
      with TestClient(community_host.create_app(data_dir)) as client:
        created = client.post("/api/common/board", json=_signed(peer, {
          "v": 0, "type": "board_post", "id": post_id,
          "from": "peer.example", "text": "", "sent_at": time.time(),
          "attachment": {
            "mime": "image/png", "data_b64": base64.b64encode(b"image").decode(),
            "w": 1, "h": 1,
          },
        }))
        self.assertEqual(created.json(), {"status": "posted"})
        legacy = client.post("/api/common/board/react", json=_signed(peer, {
          "v": 0, "type": "board_react", "post_id": post_id,
          "from": "peer.example", "sent_at": time.time(),
        })).json()
        self.assertEqual(set(legacy), {"status", "likes", "liked"})
        self.assertEqual(legacy["likes"], 1)
        emoji = client.post("/api/common/board/react", json=_signed(peer, {
          "v": 0, "type": "board_react", "post_id": post_id, "emoji": "🎉",
          "from": "peer.example", "sent_at": time.time(),
        })).json()
        self.assertEqual(emoji["reaction_counts"], {"❤️": 1, "🎉": 1})
        self.assertEqual(emoji["reacted"], ["❤️", "🎉"])
        media = client.get(f"/api/common/board/media/{post_id}")
        self.assertEqual(media.headers["content-type"], "image/png")
        self.assertEqual(media.content, b"image")

  def test_the_host_publishes_one_persistent_signing_key(self):
    with tempfile.TemporaryDirectory() as data_dir:
      with TestClient(community_host.create_app(data_dir)) as client:
        first = client.get("/api/common/actor").json()
      with TestClient(community_host.create_app(data_dir)) as client:
        second = client.get("/api/common/actor").json()
      key_file = Path(data_dir) / "common" / "host_key.json"
      self.assertEqual(stat.S_IMODE(key_file.stat().st_mode), 0o600)
    self.assertEqual(first, second)
    self.assertEqual(first["host"], COMMUNITY_HOST)
    self.assertEqual(first["public_key"]["alg"], "ed25519")

  def test_a_new_like_tells_the_post_author_but_not_their_own(self):
    with tempfile.TemporaryDirectory() as data_dir:
      root = Path(data_dir)
      author = _peer(root, "author.example")
      liker = _peer(root, "liker.example")
      store = common_public.CommonPublicStore(data_dir)
      store.register("author.example", "author", "")
      store.register("liker.example", "liker", "")
      post_id = str(uuid.uuid4())
      relay = AsyncMock()
      with (
        patch.object(community_host, "send_board_activity", new=relay),
        TestClient(community_host.create_app(data_dir)) as client,
      ):
        client.post("/api/common/board", json=_signed(author, {
          "v": 0, "type": "board_post", "id": post_id, "from": "author.example",
          "text": "Hello", "sent_at": time.time(),
        })).raise_for_status()
        liked = client.post("/api/common/board/react", json=_signed(liker, {
          "v": 0, "type": "board_react", "post_id": post_id,
          "from": "liker.example", "sent_at": time.time(),
        }))
        client.post("/api/common/board/react", json=_signed(author, {
          "v": 0, "type": "board_react", "post_id": post_id,
          "from": "author.example", "sent_at": time.time(),
        })).raise_for_status()
        signing_key = client.app.state.signing_key
    self.assertNotIn("activity", liked.json())
    relay.assert_called_once_with(
      signing_key, COMMUNITY_HOST, kind="like", author_host="author.example",
      actor_host="liker.example", actor_handle="liker", post_id=post_id,
      reply_id=None, emoji=None, activity_id=unittest.mock.ANY,
    )

  def test_explicit_post_and_reply_reactions_keep_the_legacy_activity_kind(self):
    with tempfile.TemporaryDirectory() as data_dir:
      root = Path(data_dir)
      author = _peer(root, "author.example")
      actor = _peer(root, "actor.example")
      store = common_public.CommonPublicStore(data_dir)
      store.register("author.example", "author", "")
      store.register("actor.example", "actor", "")
      post_id, reply_id = str(uuid.uuid4()), str(uuid.uuid4())
      relay = AsyncMock()
      with (patch.object(community_host, "send_board_activity", new=relay),
            TestClient(community_host.create_app(data_dir)) as client):
        client.post("/api/common/board", json=_signed(author, {
          "v": 0, "type": "board_post", "id": post_id, "from": "author.example",
          "text": "Hello", "sent_at": time.time(),
        })).raise_for_status()
        store.add_reply(post_id, reply_id, "author.example", "author", "Reply", time.time())
        for target in [None, reply_id]:
          envelope = _signed(actor, {
            "v": 0, "type": "board_react", "post_id": post_id, "emoji": "🎉",
            "from": "actor.example", "sent_at": time.time(),
            **({"reply_id": target} if target else {}),
          })
          client.post("/api/common/board/react", json=envelope).raise_for_status()
          client.post("/api/common/board/react", json=envelope).raise_for_status()
        for invalid in ["", False, 0, "🏴"]:
          response = client.post("/api/common/board/react", json=_signed(actor, {
            "v": 0, "type": "board_react", "post_id": post_id, "reply_id": reply_id,
            "emoji": invalid, "from": "actor.example", "sent_at": time.time(),
          }))
          self.assertEqual(response.status_code, 400)
      self.assertEqual(relay.await_count, 2)
      for call in relay.await_args_list:
        self.assertEqual(call.kwargs["kind"], "like")
        self.assertEqual(call.kwargs["emoji"], "🎉")
        self.assertEqual(len(call.kwargs["activity_id"]), 64)
      self.assertEqual([call.kwargs["reply_id"] for call in relay.await_args_list], [None, reply_id])

  def test_activity_notices_verify_against_the_published_key(self):
    private = community_host.new_signing_key()
    sent = AsyncMock(return_value=httpx.Response(
      200, request=httpx.Request("POST", "https://author.example/activity"),
    ))
    with patch.object(common_public, "federation_request", new=sent):
      asyncio.run(common_public.send_board_activity(
        private, COMMUNITY_HOST, kind="reply", author_host="author.example",
        actor_host="liker.example", actor_handle="liker", post_id="abcdef12",
      ))
    envelope = sent.await_args.kwargs["json"]
    payload = {key: value for key, value in envelope.items() if key != "sig"}
    self.assertEqual(payload["from"], COMMUNITY_HOST)
    self.assertEqual(payload["to"], "author.example")
    self.assertTrue(verify(
      payload, envelope["sig"], community_host.signing_public_key(private),
    ))

  def test_board_images_are_cached_for_a_day_and_revalidate_with_not_modified(self):
    with tempfile.TemporaryDirectory() as data_dir:
      peer = _peer(Path(data_dir), "peer.example")
      common_public.CommonPublicStore(data_dir).register("peer.example", "peer", "")
      post_id = str(uuid.uuid4())
      with TestClient(community_host.create_app(data_dir)) as client:
        client.post("/api/common/board", json=_signed(peer, {
          "v": 0, "type": "board_post", "id": post_id,
          "from": "peer.example", "text": "", "sent_at": time.time(),
          "attachment": {
            "mime": "image/png", "data_b64": base64.b64encode(b"image").decode(),
            "w": 1, "h": 1,
          },
        })).raise_for_status()
        url = f"/api/common/board/media/{post_id}"
        first = client.get(url)
        # Deleted or moderated posts must drop out of shared caches.
        self.assertEqual(first.headers["cache-control"], common_public.BOARD_IMAGE_CACHE)
        revalidated = client.get(url, headers={"If-None-Match": first.headers["etag"]})
        self.assertEqual(revalidated.status_code, 304)
        self.assertEqual(revalidated.content, b"")
        self.assertEqual(client.get(url, headers={"If-None-Match": '"other"'}).status_code, 200)

  def test_registration_refreshes_the_member_profile_without_waiting_for_it(self):
    with tempfile.TemporaryDirectory() as data_dir:
      peer = _peer(Path(data_dir), "member.example")
      refreshed = AsyncMock()
      with (
        patch.object(community_host, "refresh_member_profile", new=refreshed),
        TestClient(community_host.create_app(data_dir)) as client,
      ):
        response = client.post("/api/common/directory", json=_signed(peer, {
          "v": 0, "type": "register", "from": "member.example",
          "handle": "member", "bio": "", "sent_at": time.time(),
        }))
        deadline = time.monotonic() + 5
        while not refreshed.await_count and time.monotonic() < deadline:
          time.sleep(0.02)
    self.assertEqual(response.json(), {"status": "registered", "handle": "member"})
    self.assertEqual(refreshed.await_args.args[2], "member.example")

  def test_member_avatars_are_content_addressed_and_follow_changes(self):
    def png(color):
      output = io.BytesIO()
      Image.new("RGB", (300, 200), color).save(output, "PNG")
      return output.getvalue()

    def reply(status, content=b""):
      return httpx.Response(
        status, content=content, headers={"content-type": "image/png"},
        request=httpx.Request("GET", "https://member.example/api/app-services/social/avatar"),
      )

    with tempfile.TemporaryDirectory() as data_dir:
      store = common_public.CommonPublicStore(data_dir)
      store.register("member.example", "member", "")
      with patch.object(common_public, "federation_request", new=AsyncMock(
        return_value=reply(200, png("#336699")),
      )):
        asyncio.run(common_public.refresh_member_profile(store, _ActorCards(), "member.example"))
      first = store.member_avatars()["member.example"]
      stored = store.member_avatar_file(f"{first}.webp")
      self.assertEqual(hashlib.sha256(stored.read_bytes()).hexdigest(), first)
      with Image.open(stored) as rendition:
        self.assertEqual((rendition.format, max(rendition.size)), ("WEBP", 128))
      self.assertEqual(store.search_directory("")["users"][0]["avatar"], first)

      # Re-registering (a bio or handle change) keeps the current copy.
      store.register("member.example", "member", "hello")
      self.assertEqual(store.member_avatars()["member.example"], first)

      with TestClient(community_host.create_app(data_dir)) as client:
        image = client.get(f"/api/common/directory/avatars/{first}.webp")
        self.assertEqual(image.headers["content-type"], "image/webp")
        self.assertEqual(image.headers["cache-control"], common_public.IMMUTABLE_PUBLIC)
        self.assertEqual(client.get(
          f"/api/common/directory/avatars/{first}.webp",
          headers={"If-None-Match": f'"{first}"'},
        ).status_code, 304)
        self.assertEqual(client.get("/api/common/directory/avatars/nothing.webp").status_code, 404)

      with patch.object(common_public, "federation_request", new=AsyncMock(
        return_value=reply(200, png("#993366")),
      )):
        asyncio.run(common_public.refresh_member_profile(store, _ActorCards(), "member.example"))
      second = store.member_avatars()["member.example"]
      self.assertNotEqual(second, first)
      self.assertIsNone(store.member_avatar_file(f"{first}.webp"))

      # An unreachable member keeps its copy, and is not retried for a day.
      with patch.object(common_public, "federation_request", new=AsyncMock(
        side_effect=httpx.ConnectError("down"),
      )):
        asyncio.run(common_public.refresh_member_profile(store, _ActorCards(), "member.example"))
      self.assertEqual(store.member_avatars()["member.example"], second)
      self.assertEqual(store.members_due_for_avatar_check(10), [])
      # A removed avatar clears the copy.
      with patch.object(common_public, "federation_request", new=AsyncMock(
        return_value=reply(404),
      )):
        asyncio.run(common_public.refresh_member_profile(store, _ActorCards(), "member.example"))
      self.assertNotIn("member.example", store.member_avatars())
      self.assertIsNone(store.member_avatar_file(f"{second}.webp"))

  def test_every_member_copy_is_refreshed_daily_oldest_first(self):
    # Instances that never re-register (older versions, failed registrations)
    # still get their picture re-copied within a day.
    with tempfile.TemporaryDirectory() as data_dir:
      store = common_public.CommonPublicStore(data_dir)
      for host in ("old.example", "new.example", "never.example"):
        store.register(host, host.split(".")[0], "")
      with patch.object(common_public.time, "time", return_value=1_000.0):
        store.set_member_avatar("old.example", b"old")
      with patch.object(common_public.time, "time", return_value=50_000.0):
        store.set_member_avatar("new.example", b"new")
      day = common_public.MEMBER_AVATAR_MAX_AGE_S
      self.assertEqual(
        store.members_due_for_avatar_check(10, now=1_000.0 + day),
        ["never.example", "old.example"],
      )
      self.assertEqual(store.members_due_for_avatar_check(1, now=1_000.0 + day), ["never.example"])
      # Re-registering keeps the check time, so it does not reset the schedule.
      store.register("old.example", "old", "bio")
      self.assertIn("old.example", store.members_due_for_avatar_check(10, now=1_000.0 + day))

  def test_unnamed_members_are_hidden_from_the_directory(self):
    with tempfile.TemporaryDirectory() as data_dir:
      store = common_public.CommonPublicStore(data_dir)
      store.register("unnamed.example", "", "")
      store.register("named.example", "named", "")
      self.assertEqual(
        [user["host"] for user in store.search_directory("")["users"]],
        ["named.example"],
      )

  def test_a_members_post_gives_the_directory_their_current_handle(self):
    # A member who joined before handles were required keeps an unnamed
    # directory entry until the host sees their named actor card; their
    # next verified post is that moment, so older rows follow at once.
    with tempfile.TemporaryDirectory() as data_dir:
      member = _peer(Path(data_dir), "member.example")
      store = common_public.CommonPublicStore(data_dir)
      store.register("member.example", "", "")
      store.store_post({
        "id": str(uuid.uuid4()), "host": "member.example", "handle": "",
        "text": "Before", "created_at": time.time() - 60, "replies": [],
      }, None, None, None)
      with (
        patch.object(community_host, "refresh_member_profile", new=AsyncMock()),
        TestClient(community_host.create_app(data_dir)) as client,
      ):
        self.assertEqual(client.get("/api/common/board").json()["posts"], [])
        client.post("/api/common/board", json=_signed(member, {
          "v": 0, "type": "board_post", "id": str(uuid.uuid4()),
          "from": "member.example", "text": "After", "sent_at": time.time(),
        })).raise_for_status()
        posts = client.get("/api/common/board").json()["posts"]
    self.assertEqual(
      [(post["text"], post["handle"]) for post in posts],
      [("After", "member"), ("Before", "member")],
    )

  def test_board_rows_name_author_and_reply_author_avatars(self):
    with tempfile.TemporaryDirectory() as data_dir:
      root = Path(data_dir)
      author = _peer(root, "author.example")
      replier = _peer(root, "replier.example")
      store = common_public.CommonPublicStore(data_dir)
      for host in ("author.example", "replier.example"):
        store.register(host, host.split(".")[0], "")
      store.set_member_avatar("author.example", b"author-rendition")
      store.set_member_avatar("replier.example", b"replier-rendition")
      post_id = str(uuid.uuid4())
      with TestClient(community_host.create_app(data_dir)) as client:
        client.post("/api/common/board", json=_signed(author, {
          "v": 0, "type": "board_post", "id": post_id, "from": "author.example",
          "text": "Hello", "sent_at": time.time(),
        })).raise_for_status()
        client.post("/api/common/board/reply", json=_signed(replier, {
          "v": 0, "type": "board_reply", "post_id": post_id, "id": str(uuid.uuid4()),
          "from": "replier.example", "text": "Hi", "sent_at": time.time(),
        })).raise_for_status()
        post = client.get("/api/common/board").json()["posts"][0]
        replies = client.get(f"/api/common/board/{post_id}/replies").json()["replies"]
    digest = lambda data: hashlib.sha256(data).hexdigest()
    self.assertEqual(post["avatar"], digest(b"author-rendition"))
    self.assertEqual(post["reply_authors"][0]["avatar"], digest(b"replier-rendition"))
    self.assertEqual(replies[0]["avatar"], digest(b"replier-rendition"))

  def test_board_names_authors_by_their_current_handle(self):
    # Posts made before usernames were required kept an empty handle. Once the
    # host re-reads the author's actor card, every row names them.
    with tempfile.TemporaryDirectory() as data_dir:
      store = common_public.CommonPublicStore(data_dir)
      store.register("author.example", "", "")
      store.register("replier.example", "", "")
      post_id = str(uuid.uuid4())
      store.store_post({
        "id": post_id, "host": "author.example", "handle": "", "text": "Hello",
        "created_at": time.time(), "replies": [],
      }, None, None, None)
      store.add_reply(post_id, str(uuid.uuid4()), "replier.example", "", "Hi", time.time())
      with TestClient(community_host.create_app(data_dir)) as client:
        self.assertEqual(client.get("/api/common/board").json()["posts"], [])
        self.assertEqual(store.search_directory("")["users"], [])
        self.assertEqual(client.get(f"/api/common/board/{post_id}/replies").json()["replies"], [])

        cards = _ActorCards({"author.example": "ada", "replier.example": "lin"})
        with patch.object(common_public, "federation_request", new=AsyncMock(
          side_effect=httpx.ConnectError("no avatar"),
        )):
          for host in ("author.example", "replier.example"):
            asyncio.run(common_public.refresh_member_profile(store, cards, host))
        # An unreachable member keeps the handle the directory already has.
        asyncio.run(common_public.refresh_member_profile(store, _ActorCards(), "author.example"))

        post = client.get("/api/common/board").json()["posts"][0]
        replies = client.get(f"/api/common/board/{post_id}/replies").json()["replies"]
        people = store.search_directory("ada")["users"]
    self.assertEqual(post["handle"], "ada")
    self.assertEqual(post["reply_authors"][0]["handle"], "lin")
    self.assertEqual(replies[0]["handle"], "lin")
    self.assertEqual([person["host"] for person in people], ["author.example"])

  def test_board_pagination_skips_legacy_unnamed_posts_without_losing_named_posts(self):
    with tempfile.TemporaryDirectory() as data_dir:
      store = common_public.CommonPublicStore(data_dir)
      for index, handle in enumerate(("older", "", "newer")):
        store.store_post({
          "id": str(uuid.uuid4()), "host": f"member{index}.example",
          "handle": handle, "text": "Hello", "created_at": 1_000 + index,
          "replies": [],
        })
      first = common_public.read_board_page(store, 1, None)
      second = common_public.read_board_page(store, 1, first["next_cursor"])
      self.assertEqual([post["handle"] for post in first["posts"]], ["newer"])
      self.assertEqual([post["handle"] for post in second["posts"]], ["older"])
      self.assertIsNone(second["next_cursor"])

  def test_registration_uses_verified_actor_handle_not_envelope_claim(self):
    with tempfile.TemporaryDirectory() as data_dir:
      peer = _peer(Path(data_dir), "member.example")
      cached = common_public.ActorVerifier.fetch_actor

      async def unchanged_actor(verifier, host, *, force=False):
        # Even after a forced refresh, an older live actor may still say
        # "member"; the host must not trust the signed "claimed" field.
        return await cached(verifier, host, force=False)

      with (
        patch.object(common_public.ActorVerifier, "fetch_actor", new=unchanged_actor),
        patch.object(community_host, "refresh_member_profile", new=AsyncMock()),
        TestClient(community_host.create_app(data_dir)) as client,
      ):
        response = client.post("/api/common/directory", json=_signed(peer, {
          "v": 0, "type": "register", "from": "member.example",
          "handle": "claimed", "bio": "", "sent_at": time.time(),
        }))
        people = _search(client, peer, "member.example").json()["users"]
    self.assertEqual(response.status_code, 200)
    self.assertEqual(response.json()["handle"], "member")
    self.assertEqual([person["handle"] for person in people], ["member"])

  def test_registration_refreshes_a_cached_old_nonempty_handle(self):
    class Verifier:
      handle = "old"
      refreshed = False

      async def verify_envelope(self, _envelope):
        return {"handle": self.handle}

      async def fetch_actor(self, _host, *, force=False):
        self.refreshed = force
        self.handle = "new"

    with tempfile.TemporaryDirectory() as data_dir:
      store = common_public.CommonPublicStore(data_dir)
      store.register("member.example", "old", "")
      verifier = Verifier()
      actor = asyncio.run(common_public.verify_named_member(
        store, verifier, {"from": "member.example"},
        expected_handle="new",
      ))
      self.assertTrue(verifier.refreshed)
      self.assertEqual(actor["handle"], "new")
      self.assertEqual(store.search_directory("member.example")["users"][0]["handle"], "new")

  def test_members_without_a_username_cannot_join_or_post(self):
    with tempfile.TemporaryDirectory() as data_dir:
      root = Path(data_dir)
      member = _peer(root, "member.example")
      cache = root / "common" / "peers" / "member.example.json"
      card = json.loads(cache.read_text())

      def cached_handle(handle):
        card["actor"]["handle"] = handle
        cache.write_text(json.dumps(card))

      post = lambda: _signed(member, {
        "v": 0, "type": "board_post", "id": str(uuid.uuid4()),
        "from": "member.example", "text": "Hello", "sent_at": time.time(),
      })
      cached_handle("")
      with (
        patch.object(community_host, "refresh_member_profile", new=AsyncMock()),
        TestClient(community_host.create_app(data_dir)) as client,
      ):
        refused = client.post("/api/common/board", json=post())
        unlisted = client.post("/api/common/directory", json=_signed(member, {
          "v": 0, "type": "register", "from": "member.example",
          "handle": "claimed", "bio": "", "sent_at": time.time(),
        }))
        # Re-registering with a new handle re-reads the card; once it has
        # the handle, the same member can post under it.
        cached_handle("member")
        client.post("/api/common/directory", json=_signed(member, {
          "v": 0, "type": "register", "from": "member.example",
          "handle": "member", "bio": "", "sent_at": time.time(),
        })).raise_for_status()
        posted = client.post("/api/common/board", json=post())
        board = client.get("/api/common/board").json()["posts"]
    self.assertEqual(refused.status_code, 409)
    self.assertEqual(refused.json()["detail"], common_public.NEEDS_USERNAME)
    self.assertEqual(unlisted.status_code, 409)
    self.assertEqual(posted.json()["status"], "posted")
    self.assertEqual([item["handle"] for item in board], ["member"])

  def test_invalid_baked_revision_fails_closed(self):
    with patch.dict(os.environ, {"SOCIAL_SOURCE_SHA": "main"}, clear=False):
      with self.assertRaisesRegex(RuntimeError, "40-character lowercase Git SHA"):
        community_host.create_app("/tmp")

  def test_data_directory_must_be_absolute(self):
    with self.assertRaisesRegex(RuntimeError, "must be an absolute path"):
      community_host.create_app("relative")


if __name__ == "__main__":
  unittest.main()
