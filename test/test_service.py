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
      version.parent.mkdir(parents=True)
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
      legacy_reaction = signed(key, {
        "v": 0, "type": "board_react", "post_id": post_id,
        "from": "peer.example", "sent_at": time.time(),
      })
      legacy_result = self.call(
        root, "board/react", method="POST", body=legacy_reaction,
      )["body"]
      self.assertEqual(set(legacy_result), {"status", "likes", "liked"})
      self.assertEqual(legacy_result["likes"], 1)
      emoji_reaction = signed(key, {
        "v": 0, "type": "board_react", "post_id": post_id, "emoji": "🎉",
        "from": "peer.example", "sent_at": time.time(),
      })
      emoji_result = self.call(
        root, "board/react", method="POST", body=emoji_reaction,
      )["body"]
      self.assertEqual(emoji_result["reaction_counts"], {"❤️": 1, "🎉": 1})
      self.assertEqual(emoji_result["reacted"], ["❤️", "🎉"])
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
    finally:
      server.shutdown()
      thread.join()
      server.server_close()

  def test_bootstrap_returns_board_identity_and_registration_in_one_request(self):
    class Handler(BaseHTTPRequestHandler):
      def do_GET(self):
        if self.headers.get("Authorization") != "Bearer test-app-token":
          self.send_error(401)
          return
        if self.path == "/api/identity":
          payload = {"profile": {"handle": "owner", "display_name": "Owner"}}
        elif self.path == "/api/apps/":
          payload = []
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
        common = root / "apps/7/server/common"
        common.mkdir(parents=True)
        (common / "identity.json").write_text(json.dumps({
          "name": "Owner", "handle": "owner", "joined_at": 1,
          "community_host": "self.example",
        }))
        (common / "avatar.png").write_bytes(b"avatar-bytes")
        result = self.call(
          root, "bootstrap", actor={"scope": "owner", "delegated": False},
          query={"community_host": ["self.example"]},
          api_base_url=f"http://127.0.0.1:{server.server_port}",
        )
        self.assertEqual(result["status"], 200)
        self.assertEqual(result["body"]["feed"], {
          "host": "self.example",
          "capabilities": {"emoji_reactions": True, "image_thumbnails": True},
          "next_cursor": None,
          "posts": [],
        })
        self.assertEqual(result["body"]["me"]["handle"], "owner")
        self.assertEqual(result["body"]["me"]["registration"], "missing")
        self.assertEqual(result["body"]["me"]["avatar"], {
          "mime": "image/png",
          "data_b64": base64.b64encode(b"avatar-bytes").decode(),
        })
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
