"""New animations fail closed against old hosts without weakening write deadlines."""
import asyncio
import base64
import gc
import io
import json
import os
import random
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from PIL import Image

os.environ.setdefault("APP_STORAGE_DIR", "/tmp/social-gif-owner-tests")
os.environ.setdefault("APP_ID", "7")
os.environ.setdefault("APP_SLUG", "social")
import social_routes as routes
import common_protocol
import service_runtime


class GifOwnerRoutes(unittest.IsolatedAsyncioTestCase):
  def setUp(self):
    out = io.BytesIO()
    Image.new("RGB", (2, 2), "red").save(out, format="GIF")
    self.attachment = {"mime": "image/gif", "data_b64": base64.b64encode(out.getvalue()).decode(), "w": 2, "h": 2}
    self.principal = service_runtime.Principal("owner", None, None)
    for name, kwargs in (
      ("_require_member", {}),
      ("_load_identity", {"return_value": {"handle": "owner", "private_key_b64": "fixture"}}),
      ("_require_username", {}), ("_sign", {"return_value": "sig"}),
      ("_own_host", {"return_value": "owner.example"}),
    ):
      self.enterContext(patch.object(routes, name, **kwargs))
    self.send = self.enterContext(patch.object(routes, "_post_signed_envelope", new=AsyncMock(return_value=self.response({"status": "ok"}))))
    self.discover = self.enterContext(patch.object(routes, "federation_request", new=AsyncMock()))

  def response(self, body):
    return httpx.Response(200, json=body, request=httpx.Request("GET", "https://community.example/board"))

  def full_size_gif(self):
    small = base64.b64decode(self.attachment["data_b64"])
    target_size = 20 * 1024 * 1024
    budget = target_size - len(small) - 3  # comment marker and terminator
    blocks = (budget + 255) // 256
    payload, extra = divmod(budget - blocks, blocks)
    comment = (bytes([payload + 1]) + b"g" * (payload + 1)) * extra
    comment += (bytes([payload]) + b"g" * payload) * (blocks - extra)
    gif = small[:-1] + b"\x21\xfe" + comment + b"\x00;"
    self.assertEqual(len(gif), target_size)
    return gif

  def ingress_request(self, chunks, *, headers=(), limit=None, path="/activity"):
    receive = AsyncMock(side_effect=[
      {"type": "http.request", "body": chunk, "more_body": index < len(chunks) - 1}
      for index, chunk in enumerate(chunks)
    ])
    state = {} if limit is None else {"common_envelope_max_bytes": limit}
    return Request({"type": "http", "method": "POST", "path": path,
                    "headers": list(headers), "state": state}, receive), receive

  async def assert_activity_predecode_rejected(self, chunks, **kwargs):
    request, receive = self.ingress_request(chunks, **kwargs)
    copied = Mock()
    class ObservedBody(bytearray):
      def extend(self, chunk):
        copied(len(chunk))
        super().extend(chunk)
    with (
      patch.object(common_protocol, "bytearray", ObservedBody, create=True),
      patch.object(common_protocol.json, "detect_encoding", wraps=json.detect_encoding) as encoding,
      patch.object(common_protocol, "_preflight_envelope_structure", wraps=common_protocol._preflight_envelope_structure) as structure,
      patch.object(common_protocol.json, "loads", wraps=json.loads) as decoded,
      patch.object(routes, "_verify_peer_envelope", new=AsyncMock()) as auth,
    ):
      with self.assertRaises(HTTPException) as caught:
        await routes.receive_board_activity(request)
      self.assertEqual((caught.exception.status_code, caught.exception.detail),
                       (413, "Request body is too large."))
      encoding.assert_not_called()
      structure.assert_not_called()
      decoded.assert_not_called()
      auth.assert_not_awaited()
    # The offending chunk must not enter the buffer, or trigger another read.
    admitted = sum(call.args[0] for call in copied.call_args_list)
    self.assertLessEqual(admitted, common_protocol.MAX_ENVELOPE_BYTES)
    self.assertEqual(receive.await_count, copied.call_count + 1)
    return admitted

  async def test_activity_rejects_reported_megabyte_before_copy_decode_or_auth(self):
    raw = json.dumps({"type": "board_activity", "extra": "x" * (1024 * 1024)}).encode()
    raw += b" " * (1_048_618 - len(raw))
    self.assertEqual(len(raw), 1_048_618)
    self.assertEqual(await self.assert_activity_predecode_rejected([raw]), 0)

  async def test_service_dispatch_preserves_literal_path_and_separate_query(self):
    import service
    probe = FastAPI()
    @probe.api_route("/{path:path}", methods=["POST"])
    async def echo(request: Request, path: str):
      return {"path": request.scope["path"],
              "query": {key: request.query_params.getlist(key) for key in request.query_params}}
    query = {"q": ["a?b#c", "%61ctivity"], "tag": ["one", "two"]}
    with patch.object(service, "app", probe), \
         patch.object(service, "migrate_legacy_state"), \
         patch.object(service, "reconcile_badge", new=AsyncMock()):
      for path in ("activity", "/activity", "%61ctivity", "%2Factivity",
                   "activity?x=1", "activity#x", "a b", "é🪐"):
        with self.subTest(path=path):
          response = await service.dispatch({"method": "POST", "path": path,
                                             "query": query, "body": {}})
          self.assertEqual(response["status"], 200)
          self.assertEqual(response["body"],
                           {"path": "/" + path.lstrip("/"), "query": query})

  async def test_service_dispatch_activity_receive_cap_applies_after_reencoding(self):
    import service
    cap = common_protocol.MAX_ENVELOPE_BYTES
    value = {"v": 0, "type": "board_activity", "to": "owner.example",
             "from": routes.COMMUNITY_HOST, "post_id": "abcdef12", "kind": "like",
             "actor": "owner.example", "extra": ""}
    compact = lambda item: json.dumps(item, separators=(",", ":"), ensure_ascii=False).encode()
    value["extra"] = "x" * (cap - len(compact(value)))
    self.assertEqual(len(compact(value)), cap)
    with patch.object(service, "migrate_legacy_state"), \
         patch.object(service, "reconcile_badge", new=AsyncMock()), \
         patch.object(common_protocol, "_preflight_envelope_structure",
                      wraps=common_protocol._preflight_envelope_structure) as preflight, \
         patch.object(routes, "_verify_peer_envelope", new=AsyncMock()) as auth:
      response = await service.dispatch({"method": "POST", "path": "activity", "body": value})
      self.assertEqual((response["status"], response["body"]), (200, {"status": "ok"}))
      auth.assert_awaited_once_with(value)
      preflight.assert_called_once()
      auth.reset_mock()
      preflight.reset_mock()
      value["extra"] += "x"
      self.assertEqual(len(compact(value)), cap + 1)
      response = await service.dispatch({"method": "POST", "path": "activity", "body": value})
      self.assertEqual(response["status"], 413)
      auth.assert_not_awaited()
      preflight.assert_not_called()

  async def test_service_dispatch_encoded_control_paths_do_not_alias_activity(self):
    import service
    with patch.object(service, "migrate_legacy_state"), \
         patch.object(service, "reconcile_badge", new=AsyncMock()), \
         patch.object(common_protocol, "_preflight_envelope_structure") as preflight, \
         patch.object(routes, "_verify_peer_envelope", new=AsyncMock()) as auth:
      for path in ("%61ctivity", "activity?x=1", "activity#x"):
        with self.subTest(path=path):
          response = await service.dispatch({"method": "POST", "path": path, "body": {}})
          self.assertEqual(response["status"], 404)
      auth.assert_not_awaited()
      preflight.assert_not_called()

  async def test_activity_route_cap_ignores_claimed_content_type_and_length(self):
    for claimed_type in ("board_activity", "message", "board_post", "board_reply"):
      raw = json.dumps({"type": claimed_type, "extra": "x" * 32768}).encode()
      for headers in ((), ((b"content-length", b"1"),),
                      ((b"content-length", str(len(raw)).encode()),),
                      ((b"transfer-encoding", b"chunked"),)):
        for limit in (None, common_protocol.MAX_ATTACHMENT_ENVELOPE_BYTES * 2):
          with self.subTest(type=claimed_type, headers=headers, limit=limit):
            self.assertEqual(await self.assert_activity_predecode_rejected(
              [raw], headers=headers, limit=limit), 0)

  async def test_activity_chunked_total_rejects_boundary_plus_one_without_copying_overrun(self):
    cap = common_protocol.MAX_ENVELOPE_BYTES
    for chunks in ([b" " * cap, b"x", b"unread"],
                   [b" " * (cap - 1), b"xy", b"unread"]):
      with self.subTest(first=len(chunks[0])):
        self.assertEqual(await self.assert_activity_predecode_rejected(
          chunks, headers=((b"content-length", b"0"),)), len(chunks[0]))

  async def test_activity_exact_boundary_authenticates_with_stdlib_unicode_encodings(self):
    value = {"v": 0, "type": "board_activity", "to": "owner.example",
             "from": routes.COMMUNITY_HOST, "post_id": "abcdef12", "kind": "like",
             "actor": "owner.example", "actor_handle": "é🪐", "extra": "{}[]:,\\\""}
    for encoding in ("utf-8", "utf-8-sig", "utf-16", "utf-16-le", "utf-16-be",
                     "utf-32", "utf-32-le", "utf-32-be"):
      raw = json.dumps(value, ensure_ascii=False).encode(encoding)
      space = " ".encode(encoding)
      space = space[{"utf-8-sig": 3, "utf-16": 2, "utf-32": 4}.get(encoding, 0):]
      raw += space * ((common_protocol.MAX_ENVELOPE_BYTES - len(raw)) // len(space))
      self.assertEqual(len(raw), common_protocol.MAX_ENVELOPE_BYTES)
      request, _ = self.ingress_request([raw[:23], raw[23:]])
      with self.subTest(encoding=encoding), \
           patch.object(common_protocol.json, "loads", wraps=json.loads) as decoded, \
           patch.object(routes, "_verify_peer_envelope", new=AsyncMock()) as auth:
        self.assertEqual(await routes.receive_board_activity(request), {"status": "ok"})
        decoded.assert_called_once()
        auth.assert_awaited_once_with(value)

  async def test_activity_small_malformed_json_and_wrong_type_keep_400_semantics(self):
    for raw, detail in ((b'{"type":', "Envelope is not JSON."),
                        (b'[]', "Envelope is not an object."),
                        (b'{"v":0,"type":"message"}', "Unsupported envelope type.")):
      request, _ = self.ingress_request([raw])
      with self.subTest(raw=raw), patch.object(routes, "_verify_peer_envelope", new=AsyncMock()) as auth:
        with self.assertRaises(HTTPException) as caught:
          await routes.receive_board_activity(request)
        self.assertEqual((caught.exception.status_code, caught.exception.detail), (400, detail))
        auth.assert_not_awaited()

  async def test_route_cap_and_public_control_state_can_only_narrow_receive_allowance(self):
    raw = b'{"type":"message","extra":"' + b'x' * 100 + b'"}'
    request, _ = self.ingress_request([raw], limit=32)
    with patch.object(common_protocol.json, "loads") as decoded:
      with self.assertRaises(HTTPException) as caught:
        await common_protocol.read_envelope(request, max_bytes=common_protocol.MAX_ENVELOPE_BYTES)
      self.assertEqual(caught.exception.status_code, 413)
      decoded.assert_not_called()
    request, _ = self.ingress_request([raw], limit=common_protocol.MAX_ENVELOPE_BYTES)
    with patch.object(common_protocol.json, "loads") as decoded:
      with self.assertRaises(HTTPException) as caught:
        await common_protocol.read_envelope(request, max_bytes=32)
      self.assertEqual(caught.exception.status_code, 413)
      decoded.assert_not_called()

  async def test_actual_inbox_keeps_60_mib_receive_boundary(self):
    prefix, suffix = b'{"v":0,"type":"message","to":"owner.example","id":"abcdef12","enc":{"ciphertext":"', b'"}}'
    raw = prefix + b'x' * (common_protocol.MAX_ATTACHMENT_ENVELOPE_BYTES - len(prefix) - len(suffix)) + suffix
    self.assertEqual(len(raw), 60 * 1024 * 1024)
    with patch.object(routes, "_joined_for_federation", return_value=True), \
         patch.object(routes, "_verify_peer_envelope", new=AsyncMock(side_effect=HTTPException(401, "fixture auth"))) as auth:
      request, _ = self.ingress_request([raw], path="/inbox")
      with self.assertRaises(HTTPException) as caught:
        await routes.receive_message(request, db=None)
      self.assertEqual((caught.exception.status_code, caught.exception.detail), (401, "fixture auth"))
      auth.assert_awaited_once()
      auth.reset_mock()
      request, _ = self.ingress_request([raw, b" "], path="/inbox")
      with patch.object(common_protocol.json, "loads") as decoded:
        with self.assertRaises(HTTPException) as caught:
          await routes.receive_message(request, db=None)
        self.assertEqual(caught.exception.status_code, 413)
        decoded.assert_not_called()
        auth.assert_not_awaited()

  async def test_actual_inbox_preserves_20_mib_gif_original(self):
    original = self.full_size_gif()
    attachment = {**self.attachment, "data_b64": base64.b64encode(original).decode()}
    value = {"v": 0, "type": "message", "to": "owner.example", "from": "peer.example",
             "id": "abcdef12", "sent_at": 1, "text": "caption", "attachment": attachment}
    raw = json.dumps(value).encode()
    request, _ = self.ingress_request([raw], path="/inbox")
    with patch.object(routes, "_joined_for_federation", return_value=True), \
         patch.object(routes, "_verify_peer_envelope", new=AsyncMock(return_value={"handle": "peer"})), \
         patch.object(routes, "_common_app", return_value=object()), \
         patch.object(routes, "_store_message", new=AsyncMock(return_value=(False, "accepted", False))) as store, \
         patch.object(routes, "notify", new=AsyncMock()) as notify:
      self.assertEqual(await routes.receive_message(request, db=None), {"status": "duplicate"})
      self.assertEqual(store.await_args.args[-1][1], original)
      notify.assert_not_awaited()

  async def send_asgi(self, response, send=None, *, headers=(), extensions=None):
    messages = []
    async def collect(message):
      messages.append(message)
      if send is not None:
        await send(message)
    async def receive():
      await asyncio.Event().wait()
    await response({
      "type": "http", "method": "GET", "headers": list(headers),
      "asgi": {"version": "3.0", "spec_version": "2.4"},
      "extensions": extensions or {},
    }, receive, collect)
    return messages

  async def test_evicted_gif_response_streams_exact_bytes_and_releases_its_file(self):
    gif = b"GIF89a" + b"g" * 14
    png = b"\x89PNG" + b"p" * 8
    with (
      tempfile.TemporaryDirectory() as directory,
      patch.object(routes, "_peer_board_media_dir", return_value=Path(directory)),
      patch.object(routes, "BOARD_MEDIA_CACHE_MAX_BYTES", 16),
      patch.object(routes, "_require_owner_or_common_app"),
      patch.object(routes, "_download_board_media", new=AsyncMock(side_effect=[
        ("image/gif", gif), ("image/png", png),
      ])),
    ):
      first = await routes.get_board_media_for_owner("abcdef12", mime="image/gif", db=None, principal=self.principal)
      self.assertFalse(first._opened.closed)
      ranged = await routes.get_board_media_for_owner("abcdef12", mime="image/gif", db=None, principal=self.principal)
      second = await routes.get_board_media_for_owner("abcdef34", mime="image/png", db=None, principal=self.principal)
      self.assertFalse((Path(directory) / f"{routes._peer_board_media_name(routes.COMMUNITY_HOST, 'abcdef12')}.gif").exists())
      messages = await self.send_asgi(first, extensions={"http.response.pathsend": {}})
      self.assertEqual(b"".join(m.get("body", b"") for m in messages[1:]), gif)
      self.assertEqual(messages[0]["status"], 200)
      headers = dict(messages[0]["headers"])
      self.assertEqual(headers[b"content-type"], b"image/gif")
      self.assertEqual(headers[b"content-length"], str(len(gif)).encode())
      self.assertEqual(headers[b"cache-control"], routes.OWNER_BOARD_IMAGE_CACHE.encode())
      self.assertIn(b"etag", headers)
      self.assertIn(b"last-modified", headers)
      self.assertEqual(headers[b"x-content-type-options"], b"nosniff")
      self.assertTrue(first._opened.closed)
      range_messages = await self.send_asgi(ranged, headers=[(b"range", b"bytes=2-5")])
      self.assertEqual(range_messages[0]["status"], 206)
      self.assertEqual(b"".join(m.get("body", b"") for m in range_messages[1:]), gif[2:6])
      self.assertEqual(dict(range_messages[0]["headers"])[b"content-range"], b"bytes 2-5/20")
      self.assertTrue(ranged._opened.closed)
      await self.send_asgi(second)
      self.assertTrue(second._opened.closed)

  async def test_full_size_gif_stays_byte_exact_after_cache_eviction(self):
    gif = self.full_size_gif()
    Image.open(io.BytesIO(gif)).verify()
    with (
      tempfile.TemporaryDirectory() as directory,
      patch.object(routes, "_peer_board_media_dir", return_value=Path(directory)),
      patch.object(routes, "_require_owner_or_common_app"),
      patch.object(routes, "_download_board_media", new=AsyncMock(side_effect=[
        ("image/gif", gif), ("image/png", b"\x89PNG"),
      ])),
    ):
      first = await routes.get_board_media_for_owner("abcdef12", db=None, principal=self.principal)
      second = await routes.get_board_media_for_owner("abcdef34", db=None, principal=self.principal)
      self.assertFalse(Path(first._opened.name).exists())
      messages = await self.send_asgi(first)
      self.assertEqual(b"".join(m.get("body", b"") for m in messages[1:]), gif)
      self.assertTrue(first._opened.closed)
      await self.send_asgi(second)

  async def test_other_process_cannot_evict_download_between_write_and_pin(self):
    gif = self.full_size_gif()
    child_code = r"""
import asyncio, sys, time
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import AsyncMock, patch
import social_routes as routes

root = Path(sys.argv[1])
written, ready, done = (root / name for name in (".written", ".ready", ".done"))
real_lock = routes._peer_board_media_lock
entries = [0]
@asynccontextmanager
async def observed_lock(cache_dir):
    entries[0] += 1
    if entries[0] == 2:
        ready.touch()
    async with real_lock(cache_dir):
        yield
async def download(*args, **kwargs):
    (root / ".download-ready").touch()
    deadline = time.monotonic() + 10
    while not written.exists():
        if time.monotonic() > deadline:
            raise TimeoutError("parent did not finish cache write")
        await asyncio.sleep(.005)
    return "image/png", b"\x89PNG"
async def run():
    with patch.object(routes, "_peer_board_media_dir", return_value=root), patch.object(
        routes, "_download_board_media", side_effect=download
    ), patch.object(routes, "_peer_board_media_lock", observed_lock):
        response = await routes._serve_owner_board_media(routes.COMMUNITY_HOST, "abcdef34", None)
        response.close()
asyncio.run(run())
done.touch()
"""
    with (
      tempfile.TemporaryDirectory() as directory,
      patch.object(routes, "_peer_board_media_dir", return_value=Path(directory)),
      patch.object(routes, "_download_board_media", new=AsyncMock(return_value=("image/gif", gif))),
    ):
      root = Path(directory)
      original_write = routes.atomic_write
      interleaved = []
      def pause_after_write(path, data):
        original_write(path, data)
        (root / ".written").touch()
        deadline = time.monotonic() + 10
        while not (root / ".ready").exists():
          if time.monotonic() > deadline:
            raise TimeoutError("child did not start cache write")
          time.sleep(.005)
        # The child has reached the normal writer and would evict this
        # oversized original without the cross-process critical section.
        time.sleep(.15)
        interleaved.append((root / ".done").exists())
      child = subprocess.Popen(
        [sys.executable, "-c", child_code, directory],
        cwd=str(Path(__file__).resolve().parent.parent),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
      )
      try:
        deadline = time.monotonic() + 10
        while not (root / ".download-ready").exists():
          if time.monotonic() > deadline:
            raise TimeoutError("child did not reach download barrier")
          time.sleep(.005)
        with patch.object(routes, "atomic_write", side_effect=pause_after_write):
          first = await routes._serve_owner_board_media(routes.COMMUNITY_HOST, "abcdef12", None)
        stdout, stderr = child.communicate(timeout=15)
        self.assertEqual(child.returncode, 0, stdout + stderr)
      finally:
        if child.poll() is None:
          child.kill()
        child.communicate()
      self.assertEqual(interleaved, [False])
      self.assertFalse(Path(first._opened.name).exists())
      messages = await self.send_asgi(first)
      self.assertEqual(b"".join(m.get("body", b"") for m in messages[1:]), gif)
      self.assertTrue(first._opened.closed)

  async def test_cached_ranges_match_native_file_response(self):
    data = b"GIF89a" + bytes(range(32))
    with (
      tempfile.TemporaryDirectory() as directory,
      patch.object(routes, "_peer_board_media_dir", return_value=Path(directory)),
      patch.object(routes, "_require_owner_or_common_app"),
      patch.object(routes, "_download_board_media", new=AsyncMock(return_value=("image/gif", data))),
    ):
      baseline_path = Path(directory) / ".baseline.gif"
      baseline_path.write_bytes(data)
      for range_value, if_range in (
        (None, None), ("bytes=2-5", None), ("bytes=6-", None),
        ("bytes=-4", None), ("bytes=0-1,5-7", None),
        ("bytes=2-5", "match"), ("bytes=2-5", "mismatch"),
        ("bytes=2-5", "date-match"), ("bytes=2-5", "date-mismatch"),
        ("garbage", None), ("bytes=99-100", None),
      ):
        with self.subTest(range=range_value, if_range=if_range):
          cached = await routes.get_board_media_for_owner("abcdef12", db=None, principal=self.principal)
          native = FileResponse(baseline_path, media_type="image/gif", headers={
            "cache-control": routes.OWNER_BOARD_IMAGE_CACHE,
            "x-content-type-options": "nosniff",
          })
          request_headers = [] if range_value is None else [(b"range", range_value.encode())]
          cached_headers = list(request_headers)
          native_headers = list(request_headers)
          if if_range is not None:
            # Native FileResponse computes its ETag at send time.
            native.set_stat_headers(baseline_path.stat())
            if if_range == "match":
              cached_if_range, native_if_range = cached.headers["etag"], native.headers["etag"]
            elif if_range == "date-match":
              cached_if_range, native_if_range = cached.headers["last-modified"], native.headers["last-modified"]
            elif if_range == "date-mismatch":
              cached_if_range = native_if_range = "Wed, 01 Jan 2020 00:00:00 GMT"
            else:
              cached_if_range = native_if_range = '"other"'
            cached_headers.append((b"if-range", cached_if_range.encode()))
            native_headers.append((b"if-range", native_if_range.encode()))
          with patch("starlette.responses.token_hex", return_value="fixed-boundary"):
            expected = await self.send_asgi(native, headers=native_headers)
            actual = await self.send_asgi(cached, headers=cached_headers)
          self.assertEqual(actual[0]["status"], expected[0]["status"])
          self.assertEqual(b"".join(m.get("body", b"") for m in actual[1:]),
                           b"".join(m.get("body", b"") for m in expected[1:]))
          actual_headers, expected_headers = dict(actual[0]["headers"]), dict(expected[0]["headers"])
          for header in (b"content-type", b"content-length", b"content-range", b"accept-ranges", b"cache-control"):
            self.assertEqual(actual_headers.get(header), expected_headers.get(header), header)
          self.assertTrue(cached._opened.closed)

  async def test_cached_response_releases_file_on_failed_or_cancelled_send_and_abandonment(self):
    with (
      tempfile.TemporaryDirectory() as directory,
      patch.object(routes, "_peer_board_media_dir", return_value=Path(directory)),
      patch.object(routes, "_require_owner_or_common_app"),
      patch.object(routes, "_download_board_media", new=AsyncMock(return_value=("image/gif", b"GIF89a"))),
    ):
      async def fail(message):
        if message["type"] == "http.response.body":
          raise RuntimeError("send failed")
      response = await routes.get_board_media_for_owner("abcdef12", db=None, principal=self.principal)
      with self.assertRaises(RuntimeError):
        await self.send_asgi(response, fail)
      self.assertTrue(response._opened.closed)

      blocked = asyncio.Event()
      async def stall(message):
        if message["type"] == "http.response.body":
          blocked.set()
          await asyncio.Event().wait()
      response = await routes.get_board_media_for_owner("abcdef12", db=None, principal=self.principal)
      task = asyncio.create_task(self.send_asgi(response, stall))
      await blocked.wait()
      task.cancel()
      with self.assertRaises(asyncio.CancelledError):
        await task
      self.assertTrue(response._opened.closed)

      response = await routes.get_board_media_for_owner("abcdef12", db=None, principal=self.principal)
      opened = response._opened
      del response
      gc.collect()
      self.assertTrue(opened.closed)

  async def test_expired_cached_media_survives_refresh_replacement_and_offline_failure(self):
    old, new = b"GIF89a-old", b"GIF89a-new"
    with (
      tempfile.TemporaryDirectory() as directory,
      patch.object(routes, "_peer_board_media_dir", return_value=Path(directory)),
      patch.object(routes, "_require_owner_or_common_app"),
    ):
      path = Path(directory) / f"{routes._peer_board_media_name(routes.COMMUNITY_HOST, 'abcdef12')}.gif"
      path.write_bytes(old)
      existing = await routes.get_board_media_for_owner("abcdef12", db=None, principal=self.principal)
      expired = time.time() - routes.BOARD_MEDIA_CACHE_TTL_S - 10
      os.utime(path, (expired, expired))
      started, release = asyncio.Event(), asyncio.Event()
      async def download(*args, **kwargs):
        started.set()
        await release.wait()
        return "image/gif", new
      with patch.object(routes, "_download_board_media", side_effect=download):
        task = asyncio.create_task(routes.get_board_media_for_owner("abcdef12", db=None, principal=self.principal))
        await started.wait()
        # A different cache writer replaces the path while this refresh waits.
        path.unlink()
        release.set()
        refreshed = await task
      self.assertEqual(b"".join(m.get("body", b"") for m in (await self.send_asgi(existing))[1:]), old)
      self.assertEqual(b"".join(m.get("body", b"") for m in (await self.send_asgi(refreshed))[1:]), new)
      self.assertTrue(existing._opened.closed)
      self.assertTrue(refreshed._opened.closed)

      os.utime(path, (expired, expired))
      with patch.object(routes, "_download_board_media", side_effect=RuntimeError("offline")):
        fallback = await routes.get_board_media_for_owner("abcdef12", db=None, principal=self.principal)
      self.assertEqual(b"".join(m.get("body", b"") for m in (await self.send_asgi(fallback))[1:]), new)
      self.assertTrue(fallback._opened.closed)

      # A refreshed format replaces the old name without invalidating a
      # response already opened on the previous format.
      os.utime(path, None)
      prior_format = await routes.get_board_media_for_owner("abcdef12", db=None, principal=self.principal)
      os.utime(path, (expired, expired))
      with patch.object(routes, "_download_board_media", new=AsyncMock(return_value=("image/png", b"png-new"))):
        changed = await routes.get_board_media_for_owner("abcdef12", db=None, principal=self.principal)
      self.assertFalse(path.exists())
      self.assertEqual(b"".join(m.get("body", b"") for m in (await self.send_asgi(prior_format))[1:]), new)
      self.assertEqual(b"".join(m.get("body", b"") for m in (await self.send_asgi(changed))[1:]), b"png-new")
      self.assertTrue(prior_format._opened.closed)
      self.assertTrue(changed._opened.closed)

  async def test_existing_reply_posters_above_new_output_budget_remain_readable(self):
    original = Image.frombytes("RGB", (640, 640), random.Random(1).randbytes(640 * 640 * 3))
    output = io.BytesIO()
    original.save(output, format="WEBP", quality=72, method=4)
    legacy_poster = output.getvalue()
    self.assertGreater(len(legacy_poster), routes.MAX_THUMBNAIL_BYTES)
    self.assertLess(len(legacy_poster), 1024 * 1024)

    async def download(method, url, **kwargs):
      if len(legacy_poster) > kwargs["max_response_bytes"]:
        raise ValueError("Response exceeds transfer budget")
      return httpx.Response(200, content=legacy_poster,
        headers={"content-type": "image/webp"}, request=httpx.Request(method, url))

    with patch.object(routes, "_require_owner_or_common_app"):
      self.discover.side_effect = download
      result = await routes.get_reply_media_for_owner(
        "abcdef12", "abcdef34", thumbnail=True, db=None, principal=self.principal)
    self.assertEqual(result.status_code, 200)
    self.assertLessEqual(len(result.body), routes.MAX_THUMBNAIL_BYTES)
    self.assertEqual(result.media_type, "image/webp")

  async def submit(self, kind, gallery=False):
    if kind == "reply":
      return await routes.reply_to_post(routes.ReplyPost(post_id="abcdef12", id="abcdef34", text="caption", attachment=self.attachment), db=None, principal=self.principal)
    body = routes.PublishPost(text="caption", **({"attachments": [{"mime": "image/png", "data_b64": "eA==", "w": 1, "h": 1}, self.attachment]} if gallery else {"attachment": self.attachment}))
    return await routes.publish_post(body, db=None, principal=self.principal)

  async def test_all_community_gif_sends_require_explicit_support_and_keep_captions(self):
    for kind, gallery in (("post", False), ("post", True), ("reply", False)):
      for supported in (False, "true", True):
        with self.subTest(kind=kind, gallery=gallery, supported=supported):
          self.send.reset_mock();self.discover.reset_mock()
          self.discover.return_value=self.response({"capabilities": {"reply_attachments": True, "gif_attachments": supported}})
          if supported is True:
            await self.submit(kind, gallery)
            envelope=self.send.await_args.args[1]
            self.assertEqual(envelope["text"], "caption")
            selected=envelope["attachments"][1] if gallery else envelope["attachment"]
            self.assertEqual(selected, self.attachment)
            self.assertEqual(self.discover.await_count, 1)
          else:
            with self.assertRaises(HTTPException) as caught:
              await self.submit(kind, gallery)
            self.assertEqual(caught.exception.status_code, 409)
            self.assertIn("animated GIFs", caught.exception.detail)
            self.send.assert_not_awaited()

  async def test_discovery_failure_never_starts_a_write(self):
    for kind in ("post", "reply"):
      self.send.reset_mock();self.discover.side_effect=httpx.ConnectError("offline")
      with self.assertRaises(HTTPException) as caught:
        await self.submit(kind)
      self.assertEqual(caught.exception.status_code, 502)
      self.send.assert_not_awaited()

  async def test_legacy_boolean_gif_capability_does_not_admit_large_media(self):
    self.discover.return_value = self.response({"capabilities": {
      "gif_attachments": True, "reply_attachments": True,
    }})
    large = {**self.attachment, "data_b64": base64.b64encode(b"x" * (1024 * 1024 + 1)).decode()}
    with self.assertRaises(HTTPException) as caught:
      await routes._require_community_media_support(
        "community.example", gif=True, originals=[(large, b"x" * (1024 * 1024 + 1))],
        envelope_bytes=1024 * 1024,
      )
    self.assertEqual(caught.exception.status_code, 409)
    self.send.assert_not_awaited()
    self.discover.return_value = self.response({"capabilities": {
      "gif_attachments": True,
    }, "media_limits": {"gif_bytes": 20 * 1024 * 1024,
                        "static_bytes": 5 * 1024 * 1024,
                        "combined_bytes": 20 * 1024 * 1024,
                        "thumbnail_bytes": 120 * 1024,
                        "max_images": 4,
                        "envelope_bytes": 60 * 1024 * 1024}})
    await routes._require_community_media_support(
      "community.example", gif=True, originals=[(large, b"x" * (1024 * 1024 + 1))],
      envelope_bytes=2 * 1024 * 1024 + 1,
    )

  async def test_gif_post_discovery_and_write_share_the_service_deadline(self):
    self.assertLess(routes.COMMUNITY_WRITE_TIMEOUT_S, 15)
    async def discover(*args, **kwargs):
      await asyncio.sleep(.02)
      return self.response({"capabilities": {"gif_attachments": True}})
    async def send(*args, **kwargs):
      await asyncio.sleep(.05)
    self.discover.side_effect=discover;self.send.side_effect=send
    with patch.object(routes, "COMMUNITY_WRITE_TIMEOUT_S", .04):
      with self.assertRaises(HTTPException) as caught:
        await self.submit("post")
    self.assertIn("may have been sent", caught.exception.detail)

  async def test_gif_post_capability_deadline_fails_closed(self):
    async def discover(*args, **kwargs):
      await asyncio.sleep(.05)
    self.discover.side_effect=discover
    with patch.object(routes, "COMMUNITY_WRITE_TIMEOUT_S", .02):
      with self.assertRaises(HTTPException) as caught:
        await self.submit("post")
    self.assertIn("support could not be checked", caught.exception.detail)
    self.send.assert_not_awaited()
