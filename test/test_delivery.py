"""Durable identity and retry contracts for direct-message delivery."""

import asyncio
import tempfile
import time
import unittest
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx

os.environ.setdefault("APP_STORAGE_DIR", "/tmp/social-delivery-tests")
os.environ.setdefault("APP_ID", "7")
os.environ.setdefault("APP_SLUG", "social")

import service_runtime
import message_history
import social_routes
from service_runtime import Principal


class DirectDeliveryTests(unittest.IsolatedAsyncioTestCase):
  def setUp(self):
    self.temporary = tempfile.TemporaryDirectory()
    self.addCleanup(self.temporary.cleanup)
    self.storage = Path(self.temporary.name) / "app"
    self.storage.mkdir(parents=True)
    self.environment = patch.dict(social_routes.os.environ, {
      "APP_STORAGE_DIR": str(self.storage),
      "INSTANCE_DOMAIN": "self.example",
      "INSTANCE_ORIGIN": "https://self.example",
      "API_BASE_URL": "http://127.0.0.1:9",
    })
    self.environment.start()
    self.addCleanup(self.environment.stop)
    self.storage_owner = patch.object(service_runtime, "STORAGE", self.storage)
    self.storage_owner.start()
    self.addCleanup(self.storage_owner.stop)
    self.app = SimpleNamespace(id=7, slug="social")

  async def test_send_persists_the_stable_id_before_peer_discovery(self):
    message_id = "11111111-1111-4111-8111-111111111111"
    path = social_routes._message_path(self.app, "peer.example", message_id)

    async def peer_discovery(_host):
      self.assertTrue(path.is_file())
      self.assertEqual(social_routes.json.loads(path.read_text())["status"], "sending")
      raise RuntimeError("peer unavailable")

    with (
      patch.object(social_routes, "APP", self.app),
      patch.object(social_routes, "_fetch_actor", new=peer_discovery),
    ):
      result = await social_routes.send_message(
        social_routes.SendMessage(
          id=message_id, to="peer.example", text="Keep this message",
        ),
        db=None,
        principal=Principal("owner", None, None),
      )

    saved = social_routes.json.loads(path.read_text())
    self.assertEqual(result["id"], message_id)
    self.assertEqual(result["status"], "failed")
    self.assertEqual(saved["id"], message_id)
    self.assertEqual(saved["text"], "Keep this message")
    self.assertEqual(saved["status"], "failed")
    self.assertEqual(saved["attempts"], 1)

  async def test_retry_renews_transport_time_but_reuses_message_identity(self):
    message_id = "22222222-2222-4222-8222-222222222222"
    record = {
      "id": message_id, "dir": "out", "peer": "peer.example",
      "text": "Exactly once", "sent_at": 1.0, "status": "sending",
    }
    await social_routes._persist_outgoing_message(
      None, self.app, "peer.example", record, None,
    )
    request = httpx.Request("POST", "https://peer.example/inbox")
    responses = [
      httpx.ReadTimeout("slow", request=request),
      httpx.Response(200, json={"status": "duplicate"}, request=request),
    ]
    envelopes = []

    async def deliver(_url, envelope, **_kwargs):
      envelopes.append(dict(envelope))
      result = responses.pop(0)
      if isinstance(result, Exception):
        raise result
      return result

    with (
      patch.object(social_routes, "_fetch_actor", new=AsyncMock(return_value={})),
      patch.object(social_routes, "_load_identity", return_value={"private_key_b64": "unused"}),
      patch.object(social_routes, "_sign", return_value="signature"),
      patch.object(social_routes, "_post_signed_envelope", new=deliver),
    ):
      first = await social_routes._attempt_direct_delivery(
        self.app, "peer.example", message_id,
      )
      time.sleep(0.002)
      second = await social_routes._attempt_direct_delivery(
        self.app, "peer.example", message_id,
      )

    self.assertEqual(first["status"], "failed")
    self.assertEqual(second["status"], "delivered")
    self.assertEqual(second["attempts"], 2)
    self.assertEqual([envelope["id"] for envelope in envelopes], [
      message_id, message_id,
    ])
    self.assertGreater(envelopes[1]["sent_at"], envelopes[0]["sent_at"])

  async def test_exact_repeat_of_a_delivered_send_does_not_deliver_twice(self):
    message_id = "33333333-3333-4333-8333-333333333333"
    response = httpx.Response(
      200,
      json={"status": "delivered"},
      request=httpx.Request("POST", "https://peer.example/inbox"),
    )
    delivery = AsyncMock(return_value=response)
    message = social_routes.SendMessage(
      id=message_id, to="peer.example", text="One message",
    )
    with (
      patch.object(social_routes, "APP", self.app),
      patch.object(social_routes, "_fetch_actor", new=AsyncMock(return_value={})),
      patch.object(social_routes, "_load_identity", return_value={"private_key_b64": "unused"}),
      patch.object(social_routes, "_sign", return_value="signature"),
      patch.object(social_routes, "_post_signed_envelope", new=delivery),
    ):
      first = await social_routes.send_message(
        message, db=None, principal=Principal("owner", None, None),
      )
      second = await social_routes.send_message(
        message, db=None, principal=Principal("owner", None, None),
      )

    self.assertEqual(first["status"], "delivered")
    self.assertEqual(second["status"], "delivered")
    self.assertEqual(delivery.await_count, 1)

  async def test_reused_message_id_rejects_different_attachment_bytes(self):
    message_id = "55555555-5555-4555-8555-555555555555"
    record = {
      "id": message_id, "dir": "out", "peer": "peer.example",
      "text": "", "sent_at": 1.0, "status": "sending",
    }
    wire = {"mime": "image/png", "w": 1, "h": 1}
    await social_routes._persist_outgoing_message(
      None, self.app, "peer.example", record, (wire, b"first-image"),
    )
    with self.assertRaises(Exception) as raised:
      await social_routes._persist_outgoing_message(
        None, self.app, "peer.example", dict(record), (wire, b"other-image"),
      )
    self.assertEqual(getattr(raised.exception, "status_code", None), 409)

  async def test_process_exit_after_encrypted_delivery_cannot_downgrade_retry(self):
    message_id = "44444444-4444-4444-8444-444444444444"
    path = social_routes._message_path(self.app, "peer.example", message_id)
    await social_routes._persist_outgoing_message(
      None, self.app, "peer.example", {
        "id": message_id, "dir": "out", "peer": "peer.example",
        "text": "Keep this encrypted", "sent_at": 1.0, "status": "sending",
      }, None,
    )

    async def accepted_then_process_exits(_url, _envelope, **_kwargs):
      self.assertTrue(social_routes.json.loads(path.read_text())["encrypted"])
      raise asyncio.CancelledError

    encrypted_actor = {
      "encryption_key": {"alg": "x25519", "key_b64": "recipient-key"},
    }
    with (
      patch.object(social_routes, "_fetch_actor", new=AsyncMock(return_value=encrypted_actor)),
      patch.object(social_routes, "_load_identity", return_value={"private_key_b64": "unused"}),
      patch.object(social_routes, "_seal_dm", return_value={"ciphertext": "sealed"}),
      patch.object(social_routes, "_sign", return_value="signature"),
      patch.object(social_routes, "_post_signed_envelope", new=accepted_then_process_exits),
    ):
      with self.assertRaises(asyncio.CancelledError):
        await social_routes._attempt_direct_delivery(
          self.app, "peer.example", message_id,
        )

    interrupted = social_routes.json.loads(path.read_text())
    self.assertTrue(interrupted["encrypted"])
    interrupted["attempt_started_at"] = time.time() - social_routes.DELIVERY_LEASE_S - 1
    path.write_text(social_routes.json.dumps(interrupted))
    plaintext_delivery = AsyncMock()
    with (
      patch.object(social_routes, "_fetch_actor", new=AsyncMock(return_value={})),
      patch.object(social_routes, "_post_signed_envelope", new=plaintext_delivery),
    ):
      retried = await social_routes._attempt_direct_delivery(
        self.app, "peer.example", message_id,
      )

    self.assertEqual(retried["status"], "failed")
    self.assertTrue(retried["encrypted"])
    plaintext_delivery.assert_not_awaited()

  async def test_process_exit_before_version_bump_forces_immediate_reconciliation(self):
    await social_routes._store_message(None, self.app, "peer.example", {
      "id": "known", "dir": "in", "peer": "peer.example",
      "text": "Known", "sent_at": 1.0, "status": "delivered",
    })
    messages_dir = social_routes._conversation_dir(self.app, "peer.example") / "msgs"
    await message_history.load_page(
      self.app.id, "dm", "peer.example", messages_dir,
    )
    with patch.object(social_routes, "_bump_version", side_effect=KeyboardInterrupt):
      with self.assertRaises(KeyboardInterrupt):
        await social_routes._store_message(None, self.app, "peer.example", {
          "id": "saved-before-exit", "dir": "in", "peer": "peer.example",
          "text": "Must remain visible", "sent_at": 2.0,
          "status": "delivered",
        })

    page = await message_history.load_page(
      self.app.id, "dm", "peer.example", messages_dir,
    )
    self.assertEqual(
      [message["id"] for message in page["messages"]],
      ["known", "saved-before-exit"],
    )

  async def test_later_message_cannot_clear_an_inherited_crash_marker(self):
    await social_routes._store_message(None, self.app, "peer.example", {
      "id": "known", "dir": "in", "peer": "peer.example",
      "text": "Known", "sent_at": 1.0, "status": "delivered",
    })
    messages_dir = social_routes._conversation_dir(self.app, "peer.example") / "msgs"
    primed = await message_history.load_page(
      self.app.id, "dm", "peer.example", messages_dir,
    )
    self.assertEqual([message["id"] for message in primed["messages"]], ["known"])
    with patch.object(social_routes, "_bump_version", side_effect=KeyboardInterrupt):
      with self.assertRaises(KeyboardInterrupt):
        await social_routes._store_message(None, self.app, "peer.example", {
          "id": "saved-before-exit", "dir": "in", "peer": "peer.example",
          "text": "Must remain visible", "sent_at": 2.0,
          "status": "delivered",
        })

    # A later successful message in this same conversation may mirror its own
    # row, but it does not own the older crash marker and cannot clear it.
    await social_routes._store_message(None, self.app, "peer.example", {
      "id": "later", "dir": "in", "peer": "peer.example",
      "text": "Later", "sent_at": 3.0, "status": "delivered",
    })
    page = await message_history.load_page(
      self.app.id, "dm", "peer.example", messages_dir,
    )
    self.assertEqual(
      [message["id"] for message in page["messages"]],
      ["known", "saved-before-exit", "later"],
    )


if __name__ == "__main__":
  unittest.main()
