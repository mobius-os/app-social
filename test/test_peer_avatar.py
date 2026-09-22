"""Behavioral coverage for the peer-avatar trust and cache boundary."""

import io
import multiprocessing
import os
import tempfile
import time
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import HTTPException
from PIL import Image

with patch.dict(os.environ, {
  "APP_STORAGE_DIR": tempfile.gettempdir(), "APP_ID": "7", "APP_SLUG": "social",
}):
  import social_routes


def png(width=32, height=24) -> bytes:
  output = io.BytesIO()
  Image.new("RGB", (width, height), "#5678ab").save(output, "PNG")
  return output.getvalue()


def take_decode_lock(acquired):
  with social_routes._peer_avatar_decode_lock():
    acquired.set()


class PeerAvatarHardeningTests(unittest.IsolatedAsyncioTestCase):
  def setUp(self):
    self.temporary = tempfile.TemporaryDirectory()
    self.root = Path(self.temporary.name)

  def tearDown(self):
    self.temporary.cleanup()

  @contextmanager
  def route_context(self):
    with patch.object(
      social_routes, "_require_owner_or_common_app", return_value=None,
    ), patch.object(
      social_routes, "_peers_dir", return_value=self.root,
    ), patch.object(social_routes, "_own_host", return_value="self.example"):
      yield

  async def test_untrusted_avatar_is_reencoded_at_the_avatar_size(self):
    with self.route_context(), patch.object(
      social_routes, "_fetch_actor", AsyncMock(return_value={"avatar": True}),
    ), patch.object(
      social_routes, "_download_avatar", AsyncMock(return_value=png(256, 128)),
    ):
      response = await social_routes.get_peer_avatar("peer.example", None, None)

    cache = self.root / "avatars" / "peer.example.webp"
    self.assertEqual(response.path, str(cache))
    self.assertEqual(response.media_type, "image/webp")
    self.assertEqual(response.headers["x-content-type-options"], "nosniff")
    with Image.open(cache) as avatar:
      self.assertEqual(avatar.format, "WEBP")
      self.assertEqual(avatar.size, (128, 64))

  async def test_avatar_specific_pixel_cap_rejects_before_cache(self):
    with self.route_context(), patch.object(
      social_routes, "_fetch_actor", AsyncMock(return_value={"avatar": True}),
    ), patch.object(
      social_routes, "_download_avatar", AsyncMock(return_value=png(3000, 3000)),
    ):
      with self.assertRaises(HTTPException) as raised:
        await social_routes.get_peer_avatar("peer.example", None, None)

    self.assertEqual(raised.exception.status_code, 502)
    self.assertFalse((self.root / "avatars" / "peer.example.webp").exists())

  def test_avatar_decode_lock_serializes_short_lived_service_processes(self):
    context = multiprocessing.get_context("fork")
    acquired = context.Event()
    process = context.Process(target=take_decode_lock, args=(acquired,))
    with self.route_context(), social_routes._peer_avatar_decode_lock():
      process.start()
      self.assertFalse(acquired.wait(0.15))
    try:
      self.assertTrue(acquired.wait(2))
      process.join(2)
      self.assertEqual(process.exitcode, 0)
    finally:
      if process.is_alive():
        process.kill()
        process.join()

  async def test_fresh_cache_returns_without_actor_or_avatar_network_calls(self):
    with self.route_context():
      cache = social_routes._peer_avatar_path("peer.example")
      cache.write_bytes(b"cached-webp")
      fetch_actor = AsyncMock(side_effect=AssertionError("unexpected actor fetch"))
      download = AsyncMock(side_effect=AssertionError("unexpected avatar fetch"))
      with patch.object(social_routes, "_fetch_actor", fetch_actor), patch.object(
        social_routes, "_download_avatar", download,
      ):
        response = await social_routes.get_peer_avatar("peer.example", None, None)

    self.assertEqual(response.path, str(cache))
    fetch_actor.assert_not_awaited()
    download.assert_not_awaited()

  async def test_transient_actor_failure_stays_retryable_and_is_cooled_down(self):
    fetch_actor = AsyncMock(side_effect=HTTPException(502, "offline"))
    with self.route_context(), patch.object(
      social_routes, "_fetch_actor", fetch_actor,
    ):
      with self.assertRaises(HTTPException) as first:
        await social_routes.get_peer_avatar("peer.example", None, None)
      self.assertEqual(first.exception.status_code, 502)
      self.assertTrue(social_routes._peer_avatar_failure_path("peer.example").is_file())

      fetch_actor.reset_mock()
      with self.assertRaises(HTTPException) as cooled:
        await social_routes.get_peer_avatar("peer.example", None, None)
      self.assertEqual(cooled.exception.status_code, 502)
      fetch_actor.assert_not_awaited()

  async def test_transient_refresh_failure_serves_stale_cache_without_refetching(self):
    with self.route_context():
      cache = social_routes._peer_avatar_path("peer.example")
      cache.write_bytes(b"stale-webp")
      old = time.time() - social_routes.PEER_AVATAR_CACHE_TTL_S - 1
      os.utime(cache, (old, old))
      fetch_actor = AsyncMock(side_effect=HTTPException(502, "offline"))
      with patch.object(social_routes, "_fetch_actor", fetch_actor):
        first = await social_routes.get_peer_avatar("peer.example", None, None)
        fetch_actor.reset_mock()
        second = await social_routes.get_peer_avatar("peer.example", None, None)

    self.assertEqual(first.path, str(cache))
    self.assertEqual(second.path, str(cache))
    fetch_actor.assert_not_awaited()

  async def test_confirmed_absence_removes_stale_avatar_and_negative_caches_404(self):
    with self.route_context():
      cache = social_routes._peer_avatar_path("peer.example")
      cache.write_bytes(b"stale-webp")
      old = time.time() - social_routes.PEER_AVATAR_CACHE_TTL_S - 1
      os.utime(cache, (old, old))
      fetch_actor = AsyncMock(return_value={"avatar": False})
      with patch.object(social_routes, "_fetch_actor", fetch_actor):
        with self.assertRaises(HTTPException) as first:
          await social_routes.get_peer_avatar("peer.example", None, None)
        self.assertEqual(first.exception.status_code, 404)
        self.assertFalse(cache.exists())

        fetch_actor.reset_mock()
        with self.assertRaises(HTTPException) as cached:
          await social_routes.get_peer_avatar("peer.example", None, None)
        self.assertEqual(cached.exception.status_code, 404)
        fetch_actor.assert_not_awaited()

  async def test_avatar_endpoint_404_is_absence_but_other_failures_are_transient(self):
    request = httpx.Request("GET", "https://peer.example/avatar")
    not_found = httpx.HTTPStatusError(
      "missing", request=request, response=httpx.Response(404, request=request),
    )
    with self.route_context(), patch.object(
      social_routes, "_fetch_actor", AsyncMock(return_value={"avatar": True}),
    ), patch.object(
      social_routes, "_download_avatar", AsyncMock(side_effect=not_found),
    ):
      with self.assertRaises(HTTPException) as raised:
        await social_routes.get_peer_avatar("peer.example", None, None)

    self.assertEqual(raised.exception.status_code, 404)
    self.assertTrue((self.root / "avatars" / "peer.example.miss").is_file())
    self.assertFalse((self.root / "avatars" / "peer.example.fail").exists())


if __name__ == "__main__":
  unittest.main()
