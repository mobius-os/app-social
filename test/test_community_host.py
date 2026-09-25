import asyncio
import base64
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


class CommunityHostTests(unittest.TestCase):
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
    )

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

  def test_invalid_baked_revision_fails_closed(self):
    with patch.dict(os.environ, {"SOCIAL_SOURCE_SHA": "main"}, clear=False):
      with self.assertRaisesRegex(RuntimeError, "40-character lowercase Git SHA"):
        community_host.create_app("/tmp")

  def test_data_directory_must_be_absolute(self):
    with self.assertRaisesRegex(RuntimeError, "must be an absolute path"):
      community_host.create_app("relative")


if __name__ == "__main__":
  unittest.main()
