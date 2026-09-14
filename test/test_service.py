import base64
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from common_protocol import PUBLIC_SERVICE_PATH, canonical, peer_service_url


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
  def call(
    self, root, path, *, method="GET", body=None, actor=None, query=None,
    api_base_url="http://127.0.0.1:9",
  ):
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
      "APP_SLUG": "social",
      "APP_TOKEN": "test-app-token",
      "API_BASE_URL": api_base_url,
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

  def test_peer_urls_use_the_public_app_service(self):
    self.assertEqual(PUBLIC_SERVICE_PATH, "/api/app-services/social")
    self.assertEqual(
      peer_service_url("peer.example", "/groups/inbox"),
      "https://peer.example/api/app-services/social/groups/inbox",
    )

  def test_public_actor_uses_platform_owned_member_and_app_metadata(self):
    identity_payload = {
      "member_since": "2025-04-03",
      "profile": {"handle": "owner"},
    }
    apps_payload = [
      {
        "id": 8, "name": "Private", "description": "not published",
        "distribution_manifest": None,
      },
      {
        "id": 2, "name": "Shared", "description": "public app",
        "distribution_manifest": {"kind": "published"},
      },
    ]
    seen_paths = []

    class Handler(BaseHTTPRequestHandler):
      def do_GET(self):
        seen_paths.append(self.path)
        if self.headers.get("Authorization") != "Bearer test-app-token":
          self.send_error(401)
          return
        if self.path == "/api/identity":
          payload = identity_payload
        elif self.path == "/api/apps/":
          payload = apps_payload
        else:
          self.send_error(404)
          return
        encoded = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

      def log_message(self, _format, *_args):
        pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
      with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        service_root = root / "apps/7/server/common"
        service_root.mkdir(parents=True)
        _key, public = keypair()
        (service_root / "identity.json").write_text(json.dumps({
          "private_key_b64": base64.b64encode(b"p" * 32).decode(),
          "public_key_b64": public,
          "enc_private_key_b64": base64.b64encode(b"e" * 32).decode(),
          "enc_public_key_b64": base64.b64encode(b"x" * 32).decode(),
          "handle": "owner", "bio": "Hello", "joined_at": 1,
        }))
        actor = self.call(
          root, "actor", api_base_url=f"http://127.0.0.1:{server.server_port}",
        )["body"]
        self.assertEqual(actor["inbox"], "/api/app-services/social/inbox")
        self.assertEqual(actor["member_since"], identity_payload["member_since"])
        self.assertEqual(actor["apps"], [{"name": "Shared", "description": "public app"}])
        self.assertEqual(set(seen_paths), {"/api/identity", "/api/apps/"})
    finally:
      server.shutdown()
      thread.join()
      server.server_close()

  def test_federation_source_has_no_legacy_platform_route(self):
    for name in (
      "common_protocol.py", "social_routes.py", "social_groups.py",
      "social_objects.py",
    ):
      self.assertNotIn("/api/common", (ROOT / name).read_text(), name)


if __name__ == "__main__":
  unittest.main()
