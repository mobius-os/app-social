import base64
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
from fastapi import HTTPException

from common_protocol import (
  MAX_ATTACHMENT_ENVELOPE_BYTES, PUBLIC_SERVICE_PATH, canonical,
  peer_service_url, validate_attachment_envelope_size, wire_json_size,
)


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
  def seed_member(self, root):
    identity = root / "apps" / "7" / "server" / "common" / "identity.json"
    identity.parent.mkdir(parents=True, exist_ok=True)
    identity.write_text(json.dumps({
      "joined_at": 1, "directory_synced": {"handle": "owner", "avatar": ""},
      "handle": "owner", "private_key_b64": base64.b64encode(b"p" * 32).decode(),
    }))

  def test_unjoined_owner_cannot_open_people_or_private_chat_routes(self):
    with tempfile.TemporaryDirectory() as directory:
      root = Path(directory)
      actor = {"scope": "owner", "delegated": False}
      for path in (
        "people", "peer/member.example", "conversations/member.example/messages",
        "groups/deadbeef/messages",
      ):
        with self.subTest(path=path):
          response = self.call(root, path, actor=actor)
          self.assertEqual(response["status"], 403)
          self.assertIn("Join Social", response["body"]["detail"])

  def test_failed_join_keeps_public_actor_key_only_and_avatar_hidden(self):
    with tempfile.TemporaryDirectory() as directory:
      root = Path(directory)
      common = root / "apps/7/server/common"
      common.mkdir(parents=True)
      (common / "identity.json").write_text(json.dumps({
        "private_key_b64": base64.b64encode(b"p" * 32).decode(),
        "enc_private_key_b64": base64.b64encode(b"e" * 32).decode(),
        "handle": "owner", "bio": "Not published", "joined_at": 1,
      }))
      (common / "avatar.png").write_bytes(b"an existing photo")
      actor = self.call(root, "actor")
      self.assertEqual(actor["status"], 200)
      self.assertIn("public_key", actor["body"])
      self.assertNotIn("handle", actor["body"])
      self.assertNotIn("bio", actor["body"])
      self.assertEqual(self.call(root, "avatar")["status"], 404)

  def test_temporary_registration_actor_is_not_cacheable(self):
    with tempfile.TemporaryDirectory() as directory:
      root = Path(directory)
      common = root / "apps/7/server/common"
      common.mkdir(parents=True)
      (common / "identity.json").write_text(json.dumps({
        "private_key_b64": base64.b64encode(b"p" * 32).decode(),
        "enc_private_key_b64": base64.b64encode(b"e" * 32).decode(),
        "handle": "owner", "joined_at": 1,
        "registration_public_until": time.time() + 30,
      }))
      actor = self.call(root, "actor")
      self.assertEqual(actor["status"], 200)
      self.assertEqual(actor["body"]["handle"], "owner")
      self.assertEqual(actor["headers"]["cache-control"], "no-store")

  def test_legacy_key_migration_keeps_one_identity_across_workers(self):
    from concurrent.futures import ThreadPoolExecutor
    from unittest.mock import patch
    with patch.dict(os.environ, {
      "APP_STORAGE_DIR": "/tmp/social-key-migration-test", "APP_ID": "7",
      "APP_SLUG": "social", "INSTANCE_DOMAIN": "self.example",
      "INSTANCE_ORIGIN": "https://self.example",
    }):
      import social_routes

    with tempfile.TemporaryDirectory() as directory:
      path = Path(directory) / "identity.json"
      original = {
        "private_key_b64": base64.b64encode(b"p" * 32).decode(),
        "joined_at": 1, "directory_synced": {"handle": "owner"},
        "handle": "owner", "name": "Owner",
      }
      path.write_text(json.dumps(original))
      barrier = threading.Barrier(4)

      def load():
        barrier.wait(timeout=5)
        return social_routes._load_identity()

      with patch.object(social_routes, "_identity_path", return_value=path):
        with ThreadPoolExecutor(max_workers=4) as pool:
          loaded = list(pool.map(lambda _index: load(), range(4)))
      saved = json.loads(path.read_text())
      self.assertTrue(saved["enc_private_key_b64"])
      self.assertEqual({item["enc_private_key_b64"] for item in loaded}, {
        saved["enc_private_key_b64"],
      })
      self.assertEqual(saved["directory_synced"], original["directory_synced"])
      self.assertEqual(saved["private_key_b64"], original["private_key_b64"])

  def test_join_is_not_reported_complete_until_directory_accepts_it(self):
    import asyncio
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock, patch
    with patch.dict(os.environ, {
      "APP_STORAGE_DIR": "/tmp/social-join-test", "APP_ID": "7", "APP_SLUG": "social",
    }):
      from service_runtime import Principal
      import social_routes

    identity = {"name": "Owner", "handle": "owner", "private_key_b64": "unused"}
    principal = Principal("owner", None, None)

    @asynccontextmanager
    async def unlocked():
      yield
    with (
      patch.object(social_routes, "_require_owner_or_common_app"),
      patch.object(social_routes, "_refresh_profile_cache", new=AsyncMock(
        return_value={"identity": identity, "profile": {"name": "Owner"}},
      )),
      patch.object(social_routes, "_identity_lock", new=unlocked),
      patch.object(social_routes, "_load_identity", return_value=identity),
      patch.object(social_routes, "_save_identity"),
      patch.object(social_routes, "_register_with_community_host", new=AsyncMock(
        return_value="unreachable",
      )),
    ):
      pending = asyncio.run(social_routes.join_community(db=None, principal=principal))
    self.assertEqual(pending["status"], "pending")
    self.assertFalse(social_routes._membership_confirmed(identity))

    async def accepted(record):
      record["directory_synced"] = {"handle": "owner"}
      return "registered"

    with (
      patch.object(social_routes, "_require_owner_or_common_app"),
      patch.object(social_routes, "_refresh_profile_cache", new=AsyncMock(
        return_value={"identity": identity, "profile": {"name": "Owner"}},
      )),
      patch.object(social_routes, "_identity_lock", new=unlocked),
      patch.object(social_routes, "_load_identity", return_value=identity),
      patch.object(social_routes, "_save_identity"),
      patch.object(social_routes, "_register_with_community_host", new=accepted),
    ):
      joined = asyncio.run(social_routes.join_community(db=None, principal=principal))
    self.assertEqual(joined["status"], "joined")
    self.assertTrue(social_routes._membership_confirmed(identity))

  def test_registration_exposes_profile_only_during_the_host_handshake(self):
    import asyncio
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock, patch
    with patch.dict(os.environ, {
      "APP_STORAGE_DIR": "/tmp/social-registration-window-test",
      "APP_ID": "7", "APP_SLUG": "social", "INSTANCE_DOMAIN": "self.example",
    }):
      import social_routes

    identity = {"joined_at": 1, "handle": "owner", "private_key_b64": "unused"}
    seen = []

    @asynccontextmanager
    async def unlocked():
      yield

    async def unreachable(*_args, **_kwargs):
      seen.append(social_routes._profile_public(identity))
      raise httpx.ConnectError("offline")

    with (
      patch.object(social_routes, "_identity_lock", new=unlocked),
      patch.object(social_routes, "_save_identity"),
      patch.object(social_routes, "_load_identity", side_effect=lambda **_kw: dict(identity)),
      patch.object(social_routes, "_own_host", return_value="self.example"),
      patch.object(social_routes, "_sign", return_value="signature"),
      patch.object(social_routes, "_post_signed_envelope", new=unreachable),
    ):
      status = asyncio.run(social_routes._register_with_community_host(identity))
    self.assertEqual(status, "unreachable")
    self.assertEqual(seen, [True])
    self.assertFalse(social_routes._profile_public(identity))
    self.assertNotIn("registration_public_until", identity)

    with tempfile.TemporaryDirectory() as directory:
      avatar = Path(directory) / "avatar.png"
      avatar.write_bytes(b"photo")
      identity["registration_public_until"] = time.time() + 30
      with (
        patch.object(social_routes, "_identity_path", return_value=avatar),
        patch.object(social_routes, "_avatar_path", return_value=avatar),
        patch.object(social_routes, "_load_identity", return_value=identity),
      ):
        self.assertEqual(social_routes.get_avatar().headers["cache-control"], "no-store")
      identity["registration_public_until"] = time.time() - 1
      self.assertFalse(social_routes._profile_public(identity))
      identity["registration_public_until"] = time.time() + 30
      identity.pop("joined_at")
      self.assertFalse(social_routes._profile_public(identity))
      identity["joined_at"] = 1
      identity.pop("registration_public_until")

    with (
      patch.object(social_routes, "_identity_lock", new=unlocked),
      patch.object(social_routes, "_save_identity"),
      patch.object(social_routes, "_load_identity", side_effect=lambda **_kw: dict(identity)),
      patch.object(social_routes, "_own_host", return_value="self.example"),
      patch.object(social_routes, "_sign", return_value="signature"),
      patch.object(social_routes, "_post_signed_envelope", new=AsyncMock(
        return_value=httpx.Response(200, json={"status": "registered", "handle": "owner"}, request=httpx.Request("POST", "https://self.example")),
      )),
    ):
      status = asyncio.run(social_routes._register_with_community_host(identity))
    self.assertEqual(status, "registered")
    self.assertTrue(social_routes._profile_public(identity))
    self.assertNotIn("registration_public_until", identity)

  def test_failed_overlapping_registration_cannot_undo_a_successful_join(self):
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    from unittest.mock import patch
    with patch.dict(os.environ, {
      "APP_STORAGE_DIR": "/tmp/social-overlap-test", "APP_ID": "7", "APP_SLUG": "social",
      "INSTANCE_DOMAIN": "self.example", "INSTANCE_ORIGIN": "https://self.example",
    }):
      import social_routes

    with tempfile.TemporaryDirectory() as directory:
      path = Path(directory) / "identity.json"
      identity = {
        "joined_at": 1, "handle": "owner", "private_key_b64": "unused",
        "enc_private_key_b64": base64.b64encode(b"e" * 32).decode(),
      }
      path.write_text(json.dumps(identity))
      first_in_host = threading.Event()
      second_started = threading.Event()
      release_first = threading.Event()
      calls = []

      async def host(*_args, **_kwargs):
        calls.append(1)
        if len(calls) == 1:
          first_in_host.set()
          if not release_first.wait(5):
            raise AssertionError("The overlapping attempt did not start")
          status = 200
        else:
          status = 503
        return httpx.Response(
          status, json={"status": "registered", "handle": "owner"},
          request=httpx.Request("POST", "https://self.example"),
        )

      def register(snapshot, started=None):
        if started is not None:
          started.set()
        return asyncio.run(social_routes._register_with_community_host(snapshot))

      with (
        patch.object(social_routes, "_identity_path", return_value=path),
        patch.object(social_routes, "_own_host", return_value="self.example"),
        patch.object(social_routes, "_sign", return_value="signature"),
        patch.object(social_routes, "_post_signed_envelope", new=host),
        ThreadPoolExecutor(max_workers=2) as pool,
      ):
        first = pool.submit(register, dict(identity))
        self.assertTrue(first_in_host.wait(5))
        second = pool.submit(register, dict(identity), second_started)
        self.assertTrue(second_started.wait(5))
        release_first.set()
        self.assertEqual(first.result(5), "registered")
        self.assertEqual(second.result(5), "rejected")
      saved = json.loads(path.read_text())
      self.assertEqual(saved["directory_synced"]["handle"], "owner")
      self.assertNotIn("registration_public_until", saved)

  def test_registration_checks_the_hosts_actual_handle_before_confirming_join(self):
    import asyncio
    from unittest.mock import AsyncMock, patch
    with patch.dict(os.environ, {
      "APP_STORAGE_DIR": "/tmp/social-registration-ack-test", "APP_ID": "7",
      "APP_SLUG": "social", "INSTANCE_DOMAIN": "self.example",
      "INSTANCE_ORIGIN": "https://self.example",
    }):
      import social_routes

    with tempfile.TemporaryDirectory() as directory:
      path = Path(directory) / "identity.json"
      original = {
        "joined_at": 1, "handle": "new", "private_key_b64": "unused",
        "enc_private_key_b64": base64.b64encode(b"e" * 32).decode(),
      }
      post_url = "https://self.example/api/app-services/social/directory"
      get_url = "https://www.mobius.you/api/app-services/social/directory"

      def response(status, body, url=post_url):
        return httpx.Response(
          status, json=body,
          request=httpx.Request("POST" if url == post_url else "GET", url),
        )

      async def register(ack, legacy=None):
        path.write_text(json.dumps(original))
        with (
          patch.object(social_routes, "_identity_path", return_value=path),
          patch.object(social_routes, "_own_host", return_value="self.example"),
          patch.object(social_routes, "_sign", return_value="signature"),
          patch.object(social_routes, "_post_signed_envelope", new=AsyncMock(
            return_value=response(200, ack),
          )),
          patch.object(social_routes, "federation_request", new=AsyncMock(
            return_value=response(200, {"users": [
              {"host": "self.example", "handle": legacy},
            ]}, get_url),
          )) as read,
        ):
          status = await social_routes._register_with_community_host(dict(original))
        saved = json.loads(path.read_text())
        return status, saved, read.await_count

      status, saved, reads = asyncio.run(register(
        {"status": "registered", "handle": "old"},
      ))
      self.assertEqual(status, "verification_failed")
      self.assertNotIn("directory_synced", saved)
      self.assertEqual(reads, 0)

      status, saved, reads = asyncio.run(register(
        {"status": "registered"}, legacy="old",
      ))
      self.assertEqual(status, "verification_failed")
      self.assertNotIn("directory_synced", saved)
      self.assertEqual(reads, 1)

      status, saved, reads = asyncio.run(register(
        {"status": "registered"}, legacy="new",
      ))
      self.assertEqual(status, "registered")
      self.assertEqual(saved["directory_synced"]["handle"], "new")
      self.assertEqual(reads, 1)

      status, saved, reads = asyncio.run(register(
        {"status": "registered", "handle": "new"},
      ))
      self.assertEqual(status, "registered")
      self.assertEqual(saved["directory_synced"]["handle"], "new")
      self.assertEqual(reads, 0)

  def test_profile_refresh_waits_for_join_without_freezing_the_event_loop(self):
    # Run in a bounded child: a blocking flock would freeze the event loop so
    # even asyncio.wait_for could not stop this regression test.
    script = r'''
import asyncio, base64, json, tempfile
from pathlib import Path
from unittest.mock import patch
import httpx
import social_routes

async def main(path):
  identity = {
    "joined_at": 1, "handle": "owner", "private_key_b64": "unused",
    "enc_private_key_b64": base64.b64encode(b"e" * 32).decode(),
  }
  path.write_text(json.dumps(identity))
  entered = asyncio.Event()
  release = asyncio.Event()

  async def host(*_args, **_kwargs):
    entered.set()
    await release.wait()
    return httpx.Response(200, json={"status": "registered", "handle": "owner"}, request=httpx.Request("POST", "https://self.example"))

  async def profile():
    return {"handle": "owner", "display_name": "Updated", "avatar_url": None}

  with (patch.object(social_routes, "_identity_path", return_value=path),
        patch.object(social_routes, "_own_host", return_value="self.example"),
        patch.object(social_routes, "_sign", return_value="signature"),
        patch.object(social_routes, "_post_signed_envelope", new=host),
        patch.object(social_routes, "owner_profile", new=profile)):
    joining = asyncio.create_task(social_routes._register_with_community_host(dict(identity)))
    await entered.wait()
    refreshing = asyncio.create_task(social_routes._refresh_profile_cache(None, None))
    await asyncio.sleep(0.05)
    assert social_routes._profile_public(json.loads(path.read_text()))
    release.set()
    status, refreshed = await asyncio.wait_for(asyncio.gather(joining, refreshing), 3)
    assert status == "registered"
    assert refreshed["identity"]["name"] == "Updated"
    saved = json.loads(path.read_text())
    assert saved["directory_synced"]["handle"] == "owner"
    assert "registration_public_until" not in saved

with tempfile.TemporaryDirectory() as directory:
  asyncio.run(main(Path(directory) / "identity.json"))
'''
    env = {**os.environ, "INSTANCE_DOMAIN": "self.example", "APP_ID": "7",
           "APP_SLUG": "social", "APP_STORAGE_DIR": "/tmp/social-identity-race",
           "INSTANCE_ORIGIN": "https://self.example",
           "API_BASE_URL": "http://127.0.0.1:9"}
    result = subprocess.run(
      [sys.executable, "-c", script], cwd=ROOT, env=env,
      capture_output=True, text=True, timeout=6,
    )
    self.assertEqual(result.returncode, 0, result.stderr)

  def test_wire_json_size_matches_the_http_transport(self):
    envelope = {
      "type": "board_post", "text": "Four photos 📸",
      "attachment": {"mime": "image/jpeg", "data_b64": "AAAA", "w": 2, "h": 1},
    }
    request = httpx.Request("POST", "https://peer.example", json=envelope)
    self.assertEqual(wire_json_size(envelope), len(request.content))

  def test_outbound_attachment_envelope_enforces_the_receiver_boundary(self):
    exact = {"data": "A" * (MAX_ATTACHMENT_ENVELOPE_BYTES - 11)}
    oversized = {"data": "A" * (MAX_ATTACHMENT_ENVELOPE_BYTES - 10)}

    self.assertEqual(wire_json_size(exact), MAX_ATTACHMENT_ENVELOPE_BYTES)
    validate_attachment_envelope_size(exact)
    with self.assertRaises(HTTPException) as raised:
      validate_attachment_envelope_size(oversized)
    self.assertEqual(raised.exception.status_code, 413)

  def test_manifest_packaged_service_imports_every_runtime_dependency(self):
    manifest = json.loads((ROOT / "mobius.json").read_text())
    python_sources = [
      source for source in manifest["source_files"]
      if source.endswith(".py")
    ]
    self.assertIn("message_history.py", python_sources)
    with tempfile.TemporaryDirectory() as directory:
      packaged = Path(directory)
      for source in python_sources:
        target = packaged / source
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((ROOT / source).read_bytes())
      env = {
        **os.environ,
        "APP_STORAGE_DIR": str(packaged / "storage"),
        "APP_ID": "7",
        "APP_SLUG": "social",
        "APP_TOKEN": "test-app-token",
        "API_BASE_URL": "http://127.0.0.1:9",
        "INSTANCE_DOMAIN": "self.example",
        "INSTANCE_ORIGIN": "https://self.example",
      }
      probe = subprocess.run(
        [sys.executable, "-c", "import service"],
        cwd=packaged, env=env, text=True, capture_output=True,
      )
      self.assertEqual(probe.returncode, 0, probe.stderr)

  def test_preloaded_module_setup_needs_no_request_credential_and_starts_no_threads(self):
    # MOBIUS_PRELOAD lets Möbius run module setup once, without APP_TOKEN, and
    # fork each request from it; the per-request block must stay last.
    import ast
    tree = ast.parse((ROOT / "service.py").read_text())
    last = tree.body[-1]
    self.assertIsInstance(last, ast.If)
    self.assertEqual(ast.unparse(last.test), "__name__ == '__main__'")
    self.assertIn("MOBIUS_PRELOAD = True", [ast.unparse(node) for node in tree.body])
    with tempfile.TemporaryDirectory() as directory:
      env = {
        key: value for key, value in os.environ.items() if key != "APP_TOKEN"
      }
      env.update(APP_STORAGE_DIR=directory, APP_ID="7", APP_SLUG="social")
      probe = subprocess.run(
        [
          sys.executable, "-c",
          "import threading, service; assert service.MOBIUS_PRELOAD is True; "
          "assert threading.active_count() == 1, threading.enumerate()",
        ],
        cwd=ROOT, env=env, text=True, capture_output=True,
      )
    self.assertEqual(probe.returncode, 0, probe.stderr)

  def test_host_group_transaction_preserves_concurrent_member_updates(self):
    with tempfile.TemporaryDirectory() as directory:
      storage = Path(directory) / "apps" / "7"
      groups = storage / "server" / "common" / "groups"
      groups.mkdir(parents=True)
      gid = "deadbeef"
      group_path = groups / f"{gid}.json"
      group_path.write_text(json.dumps({
        "id": gid, "name": "Test", "host": "self.example", "members": {},
      }))
      env = {
        **os.environ,
        "APP_STORAGE_DIR": str(storage),
        "APP_ID": "7",
        "APP_SLUG": "social",
        "APP_TOKEN": "test-app-token",
        "API_BASE_URL": "http://127.0.0.1:9",
        "INSTANCE_DOMAIN": "self.example",
        "INSTANCE_ORIGIN": "https://self.example",
      }
      start = storage / "start"
      script = """
import json, pathlib, sys, time
import social_groups as groups
from service_io import atomic_write

member, ready, start = sys.argv[1:]
pathlib.Path(ready).touch()
while not pathlib.Path(start).exists():
  time.sleep(0.005)
with groups._host_group_transaction('deadbeef'):
  group = groups._load_host_group('deadbeef')
  time.sleep(0.15)
  group['members'][member] = {'handle': member, 'status': 'active'}
  atomic_write(groups._host_group_path('deadbeef'), json.dumps(group))
"""
      processes = []
      ready_paths = []
      for member in ("one.example", "two.example"):
        ready = storage / f"{member}.ready"
        ready_paths.append(ready)
        process = subprocess.Popen(
          [sys.executable, "-c", script, member, str(ready), str(start)],
          cwd=ROOT, env=env, text=True, stdout=subprocess.PIPE,
          stderr=subprocess.PIPE,
        )
        processes.append(process)
        self.addCleanup(lambda process=process: process.poll() is None and process.kill())
      deadline = time.time() + 5
      while not all(path.exists() for path in ready_paths) and time.time() < deadline:
        time.sleep(0.01)
      self.assertTrue(all(path.exists() for path in ready_paths))
      start.touch()
      for process in processes:
        stdout, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 0, stderr or stdout)
      self.assertEqual(
        set(json.loads(group_path.read_text())["members"]),
        {"one.example", "two.example"},
      )

  def test_host_accept_snapshot_cannot_overwrite_a_later_membership(self):
    with tempfile.TemporaryDirectory() as directory:
      storage = Path(directory) / "apps" / "7"
      groups = storage / "server" / "common" / "groups"
      groups.mkdir(parents=True)
      gid = "deadbeef"
      invitation = "11111111-1111-4111-8111-111111111111"
      group_path = groups / f"{gid}.json"
      group_path.write_text(json.dumps({
        "id": gid, "name": "Test", "host": "self.example",
        "members": {
          "self.example": {"handle": "self", "status": "active"},
          "one.example": {
            "handle": "one", "status": "invited",
            "invitation_id": invitation,
          },
        },
      }))
      env = {
        **os.environ,
        "APP_STORAGE_DIR": str(storage),
        "APP_ID": "7",
        "APP_SLUG": "social",
        "APP_TOKEN": "test-app-token",
        "API_BASE_URL": "http://127.0.0.1:9",
        "INSTANCE_DOMAIN": "self.example",
        "INSTANCE_ORIGIN": "https://self.example",
      }
      snapshot_ready = storage / "snapshot-ready"
      snapshot_proceed = storage / "snapshot-proceed"
      accepter = subprocess.Popen(
        [sys.executable, "-c", """
import asyncio, pathlib, sys
import social_groups as groups
from service_runtime import APP

async def main():
  original = groups._store_group_meta
  async def gated(app, gid, updates):
    if 'members' in updates:
      pathlib.Path(sys.argv[1]).touch()
      while not pathlib.Path(sys.argv[2]).exists():
        await asyncio.sleep(0.01)
    await original(app, gid, updates)
  groups._store_group_meta = gated
  result = await groups._accept_group_envelope(None, APP, {
    'gid': 'deadbeef', 'type': 'group_accept', 'from': 'one.example',
    'id': '22222222-2222-4222-8222-222222222222',
    'invitation_id': '11111111-1111-4111-8111-111111111111',
  }, {'handle': 'one'})
  print(result['status'], flush=True)

asyncio.run(main())
""", str(snapshot_ready), str(snapshot_proceed)],
        cwd=ROOT, env=env, text=True, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
      )
      self.addCleanup(lambda: accepter.poll() is None and accepter.kill())
      deadline = time.time() + 5
      while not snapshot_ready.exists() and time.time() < deadline:
        time.sleep(0.01)
      self.assertTrue(snapshot_ready.exists())

      updater_ready = storage / "updater-ready"
      updater_done = storage / "updater-done"
      updater = subprocess.Popen(
        [sys.executable, "-c", """
import asyncio, json, pathlib, sys
import social_groups as groups
from service_io import atomic_write
from service_runtime import APP

async def main():
  pathlib.Path(sys.argv[1]).touch()
  with groups._host_group_transaction('deadbeef'):
    group = groups._load_host_group('deadbeef')
    group['members']['later.example'] = {'handle': 'later', 'status': 'active'}
    atomic_write(groups._host_group_path('deadbeef'), json.dumps(group))
    await groups._store_group_meta(APP, 'deadbeef', {
      'members': groups._members_snapshot(group),
    })
  pathlib.Path(sys.argv[2]).touch()

asyncio.run(main())
""", str(updater_ready), str(updater_done)],
        cwd=ROOT, env=env, text=True, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
      )
      self.addCleanup(lambda: updater.poll() is None and updater.kill())
      deadline = time.time() + 5
      while not updater_ready.exists() and time.time() < deadline:
        time.sleep(0.01)
      self.assertTrue(updater_ready.exists())
      deadline = time.time() + 0.5
      while not updater_done.exists() and time.time() < deadline:
        time.sleep(0.01)
      self.assertFalse(updater_done.exists())

      snapshot_proceed.touch()
      self.assertEqual(accepter.stdout.readline().strip(), "accepted")
      self.assertEqual(accepter.wait(timeout=5), 0, accepter.stderr.read())
      self.assertEqual(updater.wait(timeout=5), 0, updater.stderr.read())
      meta = json.loads(
        (storage / "groups" / gid / "meta.json").read_text()
      )
      self.assertIn("later.example", {
        member["host"] for member in meta["members"]
      })
      accepter.stdout.close()
      accepter.stderr.close()
      updater.stdout.close()
      updater.stderr.close()

  def test_block_cannot_be_undone_by_an_overlapping_inbound_message(self):
    with tempfile.TemporaryDirectory() as directory:
      storage = Path(directory) / "apps" / "7"
      peer = "peer.example"
      meta = storage / "conversations" / peer / "meta.json"
      meta.parent.mkdir(parents=True)
      meta.write_text(json.dumps({
        "peer": peer, "request_status": "pending",
        "unread": 0, "request_count": 1,
      }))
      env = {
        **os.environ,
        "APP_STORAGE_DIR": str(storage),
        "APP_ID": "7",
        "APP_SLUG": "social",
        "APP_TOKEN": "test-app-token",
        "API_BASE_URL": "http://127.0.0.1:9",
        "INSTANCE_DOMAIN": "self.example",
        "INSTANCE_ORIGIN": "https://self.example",
      }
      ready = storage / "receiver-ready"
      proceed = storage / "receiver-proceed"
      receiver = subprocess.Popen(
        [sys.executable, "-c", """
import asyncio, pathlib, sys
import social_routes as routes
from service_runtime import APP

async def main():
  original = routes.atomic_write
  def gated(path, data):
    if path.parent.name == 'msgs':
      pathlib.Path(sys.argv[1]).touch()
      while not pathlib.Path(sys.argv[2]).exists():
        pass
    return original(path, data)
  routes.atomic_write = gated
  await routes._store_message(None, APP, 'peer.example', {
    'id': 'review-message', 'dir': 'in', 'text': 'synthetic test',
    'sent_at': 1.0,
  })

asyncio.run(main())
""", str(ready), str(proceed)],
        cwd=ROOT, env=env, text=True, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
      )
      self.addCleanup(lambda: receiver.poll() is None and receiver.kill())
      deadline = time.time() + 5
      while not ready.exists() and time.time() < deadline:
        time.sleep(0.01)
      self.assertTrue(ready.exists())

      blocker_ready = storage / "blocker-ready"
      blocker_done = storage / "blocker-done"
      blocker = subprocess.Popen(
        [sys.executable, "-c", """
import asyncio, pathlib, sys
import social_routes as routes
from service_runtime import APP

async def main():
  pathlib.Path(sys.argv[1]).touch()
  result = await routes._set_dm_request_state(APP, 'peer.example', 'blocked')
  pathlib.Path(sys.argv[2]).touch()
  print(result, flush=True)

asyncio.run(main())
""", str(blocker_ready), str(blocker_done)],
        cwd=ROOT, env=env, text=True, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
      )
      self.addCleanup(lambda: blocker.poll() is None and blocker.kill())
      deadline = time.time() + 5
      while not blocker_ready.exists() and time.time() < deadline:
        time.sleep(0.01)
      self.assertTrue(blocker_ready.exists())
      # Import/setup timing cannot prove lock contention.  The ready marker is
      # emitted immediately before the second process attempts the mutation;
      # while the receiver holds the transaction, completion must stay blocked.
      deadline = time.time() + 0.5
      while not blocker_done.exists() and time.time() < deadline:
        time.sleep(0.01)
      self.assertFalse(blocker_done.exists())
      self.assertIsNone(blocker.poll())

      proceed.touch()
      self.assertEqual(receiver.wait(timeout=5), 0, receiver.stderr.read())
      self.assertEqual(blocker.stdout.readline().strip(), "blocked")
      self.assertEqual(blocker.wait(timeout=5), 0, blocker.stderr.read())
      self.assertEqual(json.loads(meta.read_text())["request_status"], "blocked")
      self.assertTrue(
        (storage / "conversations" / peer / "msgs" / "review-message.json").is_file()
      )
      receiver.stdout.close()
      receiver.stderr.close()
      blocker.stdout.close()
      blocker.stderr.close()

  def test_read_markers_are_mutated_by_social_without_rewriting_metadata(self):
    with tempfile.TemporaryDirectory() as directory:
      root = Path(directory)
      self.seed_member(root)
      storage = root / "apps" / "7"
      dm_meta = storage / "conversations" / "peer.example" / "meta.json"
      group_meta = storage / "groups" / "deadbeef" / "meta.json"
      dm_meta.parent.mkdir(parents=True)
      group_meta.parent.mkdir(parents=True)
      dm_meta.write_text(json.dumps({
        "peer": "peer.example", "request_status": "accepted",
        "unread": 3, "last_text": "keep me",
      }))
      group_meta.write_text(json.dumps({
        "gid": "deadbeef", "request_status": "accepted",
        "unread": 2, "members": ["keep.example"],
      }))
      actor = {"scope": "owner", "delegated": False}

      dm = self.call(
        root, "conversations/peer.example/read", method="POST", actor=actor,
        body={},
      )
      group = self.call(
        root, "groups/deadbeef/read", method="POST", actor=actor, body={},
      )
      self.assertEqual(dm["body"], {"status": "read", "changed": True})
      self.assertEqual(group["body"], {"status": "read", "changed": True})
      self.assertEqual(json.loads(dm_meta.read_text()), {
        "peer": "peer.example", "request_status": "accepted",
        "unread": 0, "last_text": "keep me",
      })
      self.assertEqual(json.loads(group_meta.read_text()), {
        "gid": "deadbeef", "request_status": "accepted",
        "unread": 0, "members": ["keep.example"],
      })
      again = self.call(
        root, "conversations/peer.example/read", method="POST", actor=actor,
        body={},
      )
      self.assertEqual(again["body"], {"status": "read", "changed": False})

  def test_message_history_is_bounded_cursor_ordered_and_reconciles_file_writes(self):
    with tempfile.TemporaryDirectory() as directory:
      root = Path(directory)
      self.seed_member(root)
      storage = root / "apps" / "7"
      messages = storage / "conversations" / "peer.example" / "msgs"
      messages.mkdir(parents=True)
      for index in range(125):
        message_id = f"message-{index:03d}"
        (messages / f"{message_id}.json").write_text(json.dumps({
          "id": message_id, "dir": "in", "text": str(index),
          # Repeated timestamps prove the cursor's id tiebreaker does not
          # skip or duplicate rows at a page boundary.
          "sent_at": float(index // 10), "status": "delivered",
        }))
      actor = {"scope": "owner", "delegated": False}
      first = self.call(
        root, "conversations/peer.example/messages", actor=actor,
        query={"limit": ["50"]},
      )["body"]
      self.assertEqual(len(first["messages"]), 50)
      self.assertEqual(first["messages"][0]["text"], "75")
      self.assertEqual(first["messages"][-1]["text"], "124")
      self.assertIsInstance(first["next_cursor"], str)

      second = self.call(
        root, "conversations/peer.example/messages", actor=actor,
        query={"limit": ["50"], "before": [first["next_cursor"]]},
      )["body"]
      self.assertEqual(second["messages"][0]["text"], "25")
      self.assertEqual(second["messages"][-1]["text"], "74")
      self.assertTrue(
        {message["id"] for message in first["messages"]}.isdisjoint(
          message["id"] for message in second["messages"]
        )
      )

      latest = messages / "message-124.json"
      changed = json.loads(latest.read_text())
      changed["status"] = "failed"
      latest.write_text(json.dumps(changed))
      version = storage / "state" / "version.json"
      version.parent.mkdir(parents=True, exist_ok=True)
      version.write_text(json.dumps({"v": 1}))
      newest = {
        "id": "message-125", "dir": "out", "text": "125",
        "sent_at": 13.0, "status": "delivered",
      }
      newest_path = messages / "message-125.json"
      newest_path.write_text(json.dumps(newest))
      version.write_text(json.dumps({"v": 2}))
      env = {
        **os.environ,
        "APP_STORAGE_DIR": str(storage),
        "APP_ID": "7",
        "APP_SLUG": "social",
        "APP_TOKEN": "test-app-token",
        "API_BASE_URL": "http://127.0.0.1:9",
        "INSTANCE_DOMAIN": "self.example",
        "INSTANCE_ORIGIN": "https://self.example",
      }
      subprocess.run(
        [sys.executable, "-c", """
import json, pathlib
from message_history import mirror_message
path = pathlib.Path(__import__('sys').argv[1])
mirror_message('dm', 'peer.example', json.loads(path.read_text()), path)
""", str(newest_path)],
        cwd=ROOT, env=env, text=True, capture_output=True, timeout=5, check=True,
      )
      reconciled = self.call(
        root, "conversations/peer.example/messages", actor=actor,
        query={"limit": ["2"]},
      )["body"]
      self.assertEqual(reconciled["messages"][0]["id"], "message-124")
      self.assertEqual(reconciled["messages"][0]["status"], "failed")
      self.assertEqual(reconciled["messages"][1]["id"], "message-125")

  def test_message_history_falls_back_to_json_when_its_index_is_unavailable(self):
    with tempfile.TemporaryDirectory() as directory:
      root = Path(directory)
      self.seed_member(root)
      storage = root / "apps" / "7"
      messages = storage / "conversations" / "peer.example" / "msgs"
      messages.mkdir(parents=True)
      for index in range(3):
        message_id = f"fallback-{index}"
        (messages / f"{message_id}.json").write_text(json.dumps({
          "id": message_id, "dir": "in", "text": str(index),
          "sent_at": float(index), "status": "delivered",
        }))
      # sqlite3 cannot open a directory as a database. History must remain
      # readable from its durable files rather than surfacing a 500.
      (storage / "server" / "message-index.sqlite3").mkdir(parents=True)
      result = self.call(
        root, "conversations/peer.example/messages",
        actor={"scope": "owner", "delegated": False},
        query={"limit": ["2"]},
      )
      self.assertEqual(result["status"], 200)
      self.assertEqual(
        [message["id"] for message in result["body"]["messages"]],
        ["fallback-1", "fallback-2"],
      )
      self.assertIsInstance(result["body"]["next_cursor"], str)

  def test_metadata_only_versions_do_not_rescan_unchanged_message_files(self):
    with tempfile.TemporaryDirectory() as directory:
      root = Path(directory)
      self.seed_member(root)
      storage = root / "apps" / "7"
      conversation = storage / "conversations" / "peer.example"
      messages = conversation / "msgs"
      messages.mkdir(parents=True)
      (messages / "kept.json").write_text(json.dumps({
        "id": "kept", "dir": "in", "text": "Indexed",
        "sent_at": 1.0, "status": "delivered",
      }))
      conversation.joinpath("meta.json").write_text(json.dumps({
        "peer": "peer.example", "request_status": "accepted", "unread": 1,
      }))
      actor = {"scope": "owner", "delegated": False}
      first = self.call(
        root, "conversations/peer.example/messages", actor=actor,
      )["body"]
      self.assertEqual([message["id"] for message in first["messages"]], ["kept"])
      self.call(
        root, "conversations/peer.example/read", method="POST", actor=actor,
        body={},
      )

      hidden = conversation / "msgs-hidden"
      messages.rename(hidden)
      try:
        second = self.call(
          root, "conversations/peer.example/messages", actor=actor,
        )["body"]
      finally:
        hidden.rename(messages)
      self.assertEqual([message["id"] for message in second["messages"]], ["kept"])

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
      (legacy / "peers").mkdir()
      (legacy / "peers" / "peer.example.json").write_text("{}")
      self.call(root, "actor")
      self.assertFalse(legacy.exists())
      self.assertTrue((root / "apps/7/server/common/peers/peer.example.json").is_file())

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
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
        signing_private = Ed25519PrivateKey.from_private_bytes(b"p" * 32)
        signing_public = base64.b64encode(
          signing_private.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw,
          )
        ).decode()
        encryption_private = X25519PrivateKey.from_private_bytes(b"e" * 32)
        encryption_public = base64.b64encode(
          encryption_private.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw,
          )
        ).decode()
        (service_root / "identity.json").write_text(json.dumps({
          "private_key_b64": base64.b64encode(b"p" * 32).decode(),
          "public_key_b64": base64.b64encode(b"stale signing key" * 2).decode(),
          "enc_private_key_b64": base64.b64encode(b"e" * 32).decode(),
          "enc_public_key_b64": base64.b64encode(b"x" * 32).decode(),
          "handle": "owner", "bio": "Hello", "joined_at": 1,
          "directory_synced": {"handle": "owner"},
        }))
        actor = self.call(
          root, "actor", api_base_url=f"http://127.0.0.1:{server.server_port}",
        )["body"]
        self.assertEqual(actor["inbox"], "/api/app-services/social/inbox")
        self.assertEqual(actor["public_key"]["key_b64"], signing_public)
        self.assertEqual(actor["encryption_key"]["key_b64"], encryption_public)
        self.assertEqual(actor["member_since"], identity_payload["member_since"])
        self.assertEqual(actor["apps"], [{"name": "Shared", "description": "public app"}])
        self.assertEqual(set(seen_paths), {"/api/identity", "/api/apps/"})
        # Peer probes reuse the cached app-directory facts instead of
        # downloading the whole installed-app list again.
        apps_payload.append({"id": 3, "slug": "identity", "name": "You"})
        seen_paths.clear()
        actor = self.call(
          root, "actor", api_base_url=f"http://127.0.0.1:{server.server_port}",
        )["body"]
        self.assertEqual(actor["apps"], [{"name": "Shared", "description": "public app"}])
        # The two reads run concurrently, so only their set and count are stable.
        self.assertEqual(sorted(seen_paths), ["/api/apps/", "/api/identity"])
        seen_paths.clear()
        self.call(
          root, "actor", api_base_url=f"http://127.0.0.1:{server.server_port}",
        )
        self.assertEqual(seen_paths, ["/api/identity"])
    finally:
      server.shutdown()
      thread.join()
      server.server_close()

  def test_bootstrap_reads_the_shared_board_and_registration_in_one_request(self):
    import asyncio
    from unittest.mock import AsyncMock, patch
    environment = {
      "APP_ID": "7", "APP_SLUG": "social", "APP_STORAGE_DIR": "/tmp/social-bootstrap-test",
      "INSTANCE_DOMAIN": "self.example", "INSTANCE_ORIGIN": "https://self.example",
      "API_BASE_URL": "http://127.0.0.1:9",
    }
    with patch.dict(os.environ, environment):
      import social_routes

    def community(method, url, **kwargs):
      self.assertTrue(url.startswith("https://www.mobius.you/api/app-services/social/"))
      body = (
        {"users": [{"host": "someone-else.example"}]} if url.endswith("/directory/search")
        else {"capabilities": {}, "next_cursor": None, "posts": []}
      )
      return httpx.Response(200, json=body, request=httpx.Request(method, url))

    me = {"joined": True, "host": "self.example", "handle": "owner"}
    with (
      patch.dict(os.environ, environment),
      patch.object(social_routes, "_require_owner_or_common_app"),
      patch.object(social_routes, "_load_identity", return_value={
        "joined_at": 1, "directory_synced": {"handle": "owner"},
        "private_key_b64": "unused",
      }),
      patch.object(social_routes, "_sign", return_value="signature"),
      patch.object(social_routes, "_cached_me_payload", new=AsyncMock(return_value=me)),
      patch.object(social_routes, "federation_request", new=AsyncMock(side_effect=community)),
    ):
      result = asyncio.run(social_routes.bootstrap_social(db=None, principal=None))
    self.assertEqual(result["feed"]["host"], "www.mobius.you")
    self.assertEqual(result["feed"]["posts"], [])
    self.assertEqual(result["me"]["handle"], "owner")
    self.assertEqual(result["me"]["registration"], "missing")

  def test_joined_people_search_uses_old_host_only_when_signed_route_is_absent(self):
    import asyncio
    from unittest.mock import AsyncMock, patch
    environment = {
      "APP_ID": "7", "APP_SLUG": "social",
      "APP_STORAGE_DIR": "/tmp/social-directory-rollout-test",
      "INSTANCE_DOMAIN": "self.example", "INSTANCE_ORIGIN": "https://self.example",
      "API_BASE_URL": "http://127.0.0.1:9",
    }
    with patch.dict(os.environ, environment):
      import social_routes

    calls = []

    async def community(method, url, **kwargs):
      calls.append((method, url, kwargs))
      status = 404 if method == "POST" else 200
      body = {} if status == 404 else {"users": [{"host": "alex.example", "handle": "alex"}]}
      return httpx.Response(status, json=body, request=httpx.Request(method, url))

    with (
      patch.dict(os.environ, environment),
      patch.object(social_routes, "_require_member") as require_member,
      patch.object(social_routes, "_load_identity", return_value={
        "private_key_b64": "unused", "joined_at": 1,
        "directory_synced": {"handle": "owner"},
      }),
      patch.object(social_routes, "_sign", return_value="signature"),
      patch.object(social_routes, "federation_request", new=AsyncMock(side_effect=community)),
    ):
      result = asyncio.run(social_routes._people_payload("alex", db=None, principal=None))
    require_member.assert_called_once_with(None, None)
    self.assertEqual(result["users"][0]["host"], "alex.example")
    self.assertEqual([call[0] for call in calls], ["POST", "GET"])
    self.assertTrue(calls[0][1].endswith("/directory/search"))
    self.assertTrue(calls[1][1].endswith("/directory"))
    self.assertEqual(calls[1][2]["params"], {"q": "alex"})

    async def denied(method, url, **kwargs):
      calls.append((method, url, kwargs))
      return httpx.Response(403, json={}, request=httpx.Request(method, url))

    calls.clear()
    with (
      patch.dict(os.environ, environment),
      patch.object(social_routes, "_load_identity", return_value={"private_key_b64": "unused"}),
      patch.object(social_routes, "_sign", return_value="signature"),
      patch.object(social_routes, "federation_request", new=AsyncMock(side_effect=denied)),
    ):
      with self.assertRaises(HTTPException) as raised:
        asyncio.run(social_routes._search_community_members("alex"))
    self.assertEqual(raised.exception.status_code, 403)
    self.assertEqual([call[0] for call in calls], ["POST"])

  def test_federation_source_has_no_legacy_platform_route(self):
    for name in (
      "common_protocol.py", "social_routes.py", "social_groups.py",
      "social_objects.py",
    ):
      self.assertNotIn("/api/common", (ROOT / name).read_text(), name)


if __name__ == "__main__":
  unittest.main()
