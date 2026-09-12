import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path

from fastapi.testclient import TestClient

from common_protocol import canonical
from public_host_factory import create_app


ROOT = Path(__file__).parents[1]


def keypair():
  from cryptography.hazmat.primitives import serialization
  from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
  key = Ed25519PrivateKey.generate()
  private = key.private_bytes(
    serialization.Encoding.Raw,
    serialization.PrivateFormat.Raw,
    serialization.NoEncryption(),
  )
  public = key.public_key().public_bytes(
    serialization.Encoding.Raw,
    serialization.PublicFormat.Raw,
  )
  return key, base64.b64encode(public).decode()


def signed(key, body):
  value = dict(body)
  value["sig"] = base64.b64encode(key.sign(canonical(value))).decode()
  return value


class SocialServiceTests(unittest.TestCase):
  def call(self, root, path, *, method="GET", body=None, actor=None, query=None):
    storage = root / "apps" / "7"
    storage.mkdir(parents=True, exist_ok=True)
    request = {
      "schema": 1,
      "method": method,
      "path": path,
      "query": query or {},
      "headers": {"content-type": "application/json"} if body is not None else {},
      "body": body,
      "public": (actor or {}).get("scope", "public") == "public",
      "actor": actor or {"scope": "public"},
    }
    env = {
      **os.environ,
      "APP_STORAGE_DIR": str(storage),
      "APP_ID": "7",
      "APP_SLUG": "common",
      "API_BASE_URL": "http://127.0.0.1:9",
      "INSTANCE_DOMAIN": "self.example",
      "INSTANCE_ORIGIN": "https://self.example",
    }
    result = subprocess.run(
      [sys.executable, str(ROOT / "service.py")],
      input=json.dumps(request), text=True, capture_output=True, env=env,
      timeout=20, check=True,
    )
    return json.loads(result.stdout)

  def test_legacy_social_state_moves_into_the_app_before_first_request(self):
    with tempfile.TemporaryDirectory() as directory:
      root = Path(directory)
      legacy = root / "common"
      legacy.mkdir()
      (legacy / "directory.json").write_text(json.dumps({
        "peer.example": {"handle": "peer", "bio": "kept"},
      }))
      result = self.call(root, "directory")
      self.assertEqual(result["body"]["users"][0]["host"], "peer.example")
      self.assertFalse(legacy.exists())
      self.assertTrue((root / "apps/7/server/common/directory.json").is_file())

  def test_public_signed_board_flow_and_binary_media_stay_app_owned(self):
    with tempfile.TemporaryDirectory() as directory:
      root = Path(directory)
      self.call(root, "directory")
      key, public = keypair()
      peers = root / "apps/7/server/common/peers"
      peers.mkdir(parents=True, exist_ok=True)
      (peers / "peer.example.json").write_text(json.dumps({
        "fetched_at": time.time(),
        "actor": {
          "protocol": "common/0", "host": "peer.example", "handle": "peer",
          "bio": "", "public_key": {"alg": "ed25519", "key_b64": public},
        },
      }))
      post_id = str(uuid.uuid4())
      post = signed(key, {
        "v": 0, "type": "board_post", "id": post_id,
        "from": "peer.example", "text": "", "sent_at": time.time(),
        "attachment": {
          "mime": "image/png", "data_b64": base64.b64encode(b"image").decode(),
          "w": 1, "h": 1,
        },
      })
      created = self.call(root, "board", method="POST", body=post)
      self.assertEqual(created["body"], {"status": "posted"})
      media = self.call(root, f"board/media/{post_id}")
      self.assertEqual(media["media_type"], "image/png")
      self.assertEqual(base64.b64decode(media["body_base64"]), b"image")

  def test_public_cannot_use_owner_object_routes_but_kanban_can(self):
    with tempfile.TemporaryDirectory() as directory:
      root = Path(directory)
      denied = self.call(root, "objects", query={"app": ["kanban"]})
      self.assertEqual(denied["status"], 401)
      actor = {
        "scope": "app", "app_id": 12, "app_slug": "kanban", "delegated": False,
      }
      created = self.call(root, "objects", method="POST", actor=actor, body={
        "app": "kanban", "kind": "board", "label": "Plan", "doc": {"v": 1},
      })
      self.assertEqual(created["status"], 200)
      listed = self.call(root, "objects", actor=actor, query={"app": ["kanban"]})
      self.assertEqual(len(listed["body"]["hosted"]), 1)
      self.assertEqual(listed["body"]["joined"], [])

  def test_public_host_serves_current_and_dated_legacy_paths(self):
    with tempfile.TemporaryDirectory() as directory:
      application = create_app(directory, source_sha="f" * 40)
      with TestClient(application) as client:
        self.assertEqual(client.get("/healthz").json(), {"status": "ok"})
        self.assertEqual(
          client.get("/api/app-services/common/directory").json(), {"users": []},
        )
        self.assertEqual(client.get("/api/common/directory").status_code, 404)
        self.assertEqual(client.get("/docs").status_code, 404)


if __name__ == "__main__":
  unittest.main()
