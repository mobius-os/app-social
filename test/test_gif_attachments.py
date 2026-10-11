"""Animation originals use one bounded validator across all Common content."""

import asyncio
import base64
import gc
import io
import json
import random
import os
import tempfile
import time
import tracemalloc
import unittest
import uuid
import weakref
from contextlib import ExitStack, contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import httpx
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient
from PIL import Image

import common_protocol
import common_public
import community_host
from common_public import CommonPublicStore, check_reply_original, image_thumbnail_bytes, validate_thumbnail_bytes
from test_community_host import _peer, _signed


def animation():
  palette = [0, 0, 0, 255, 0, 0, 0, 0, 255] + [0] * (768 - 9)
  frames = []
  for color in (1, 2):
    image = Image.new("P", (24, 16), color)
    image.putpalette(palette)
    image.putpixel((0, 0), 0)
    frames.append(image)
  output = io.BytesIO()
  frames[0].save(output, format="GIF", save_all=True, append_images=frames[1:],
                 optimize=False, duration=[80, 170], loop=3, disposal=[2, 3],
                 transparency=0, comment=b"original metadata ; GIF89a")
  return output.getvalue()


def wire(data, size=(24, 16)):
  return {"mime": "image/gif", "data_b64": base64.b64encode(data).decode(),
          "w": size[0], "h": size[1]}


def tiny_container(size=(1, 1), frames=1, *, broken_last=False):
  """Small descriptors on a chosen canvas keep resource fixtures cheap."""
  output = io.BytesIO()
  Image.new("P", (1, 1)).save(output, format="GIF")
  data = output.getvalue()
  start = 13 + 3 * 2 ** ((data[10] & 7) + 1)
  header = bytearray(data[:start])
  header[6:10] = size[0].to_bytes(2, "little") + size[1].to_bytes(2, "little")
  frame = data[start:-1]
  last = bytearray(frame)
  if broken_last:
    # A complete sub-block containing a bad LZW stream, not a framing error.
    last[12:15] = b"\xff\xff\xff"
  return bytes(header) + frame * (frames - 1) + bytes(last) + b";"


def padded_gif(total_bytes, padding=b"x", chunk=255):
  """A fully framed, decodable GIF with legal comment sub-block padding."""
  original = tiny_container()
  overhead = 3  # extension introducer, comment label, terminator
  room = total_bytes - len(original) - overhead
  blocks = bytearray()
  while room:
    take = min(chunk, room - 1)
    if room - take - 1 == 1:
      take -= 1
    if take <= 0:
      raise ValueError("Cannot represent padding length")
    blocks.append(take)
    blocks.extend(padding * take)
    room -= take + 1
  return original[:-1] + b"\x21\xfe" + bytes(blocks) + b"\x00;"


def control(packed=0, delay=0, index=0):
  """One graphic control extension: packed fields, delay, transparency index."""
  return b"\x21\xf9\x04" + bytes([packed]) + delay.to_bytes(2, "little") + bytes([index, 0])


# A plain-text header, an application extension and an unknown label, each
# carrying data sub-blocks that a decode view never needs.
PLAIN_TEXT = b"\x21\x01\x0c" + bytes(12) + b"\x05hello\x00"
APPLICATION = b"\x21\xff\x0bXMP DataXMP\x03<x>\x00"
UNKNOWN = b"\x21\x99\x02ab\x00"


def with_metadata(gif, metadata):
  """Insert extension blocks before the first image of a tiny container."""
  start = 13 + 3 * 2 ** ((gif[10] & 7) + 1)
  return gif[:start] + metadata + gif[start:]


def invalid_gifs():
  small = tiny_container()
  # The first image descriptor follows this tiny global color table.
  start = 13 + 3 * 2 ** ((small[10] & 7) + 1)
  zero_frame = bytearray(small)
  zero_frame[start + 5:start + 7] = b"\0\0"
  outside_canvas = bytearray(small)
  outside_canvas[start + 1:start + 3] = b"\1\0"
  return [
    (wire(b"not a GIF", (1, 1)), 400),
    (wire(small[:-1], (1, 1)), 400),  # Pillow accepts this missing trailer.
    (wire(small[:-3] + b";", (1, 1)), 400),
    (wire(small + b"junk", (1, 1)), 400),
    (wire(small, (2, 1)), 400),
    (wire(tiny_container((0, 1)), (1, 1)), 400),
    (wire(bytes(zero_frame), (1, 1)), 400),
    (wire(bytes(outside_canvas), (1, 1)), 400),
    (wire(tiny_container((1601, 1)), (1601, 1)), 413),
    (wire(tiny_container(frames=301), (1, 1)), 413),
    (wire(tiny_container((1600, 1600), frames=13), (1600, 1600)), 413),
  ] + [
    ({**value, "mime": mime}, 400)
    for value in (
      wire(small, (1, 1)), wire(small[:-1], (1, 1)),
      wire(tiny_container(frames=301), (1, 1)),
      wire(tiny_container((1601, 1)), (1601, 1)),
      wire(tiny_container((1600, 1600), frames=13), (1600, 1600)),
    )
    for mime in ("image/png", "image/jpeg", "image/webp")
  ] + [(wire(tiny_container(frames=2, broken_last=True), (1, 1)), 400)]


def envelope_request(raw, chunk_size=64 * 1024):
  position = 0

  async def receive():
    nonlocal position
    chunk = raw[position:position + chunk_size]
    position += len(chunk)
    return {"type": "http.request", "body": chunk,
            "more_body": position < len(raw)}

  return Request({"type": "http", "method": "POST", "path": "/"}, receive)


class EnvelopeAdmissionTests(unittest.IsolatedAsyncioTestCase):
  async def assert_predecode_rejected(self, raw):
    with patch.object(common_protocol.json, "loads") as decoded:
      with self.assertRaises(HTTPException) as caught:
        await common_protocol.read_envelope(envelope_request(raw))
      self.assertEqual(caught.exception.status_code, 413)
      self.assertEqual(caught.exception.detail, "Envelope JSON is too complex.")
      decoded.assert_not_called()

  async def test_dense_arrays_reject_before_decode_with_bounded_actual_read_memory(self):
    # Allocate the original input before tracing, matching the reported attack.
    raw = b'{"type":"board_post","extra":[' + b'[],' * 699999 + b'[]]}'
    self.assertEqual(len(raw), 2_100_031)
    tracemalloc.start()
    try:
      await self.assert_predecode_rejected(raw)
      _, peak = tracemalloc.get_traced_memory()
    finally:
      tracemalloc.stop()
    # Includes capped-body assembly and source decoding, not just the scanner.
    # The old actual read materialized 700k lists and peaked at 49.3 MB.
    self.assertLess(peak, 4 * len(raw) + 2 * 1024 * 1024)

  async def test_entries_containers_and_duplicate_keys_all_spend_structure_budget(self):
    for element in (b'[]', b'{}', b'0', b'1.25', b'true', b'null', b'"x"'):
      raw = b'{"type":"board_post","extra":[' + (element + b',') * 33000 + element + b']}'
      with self.subTest(element=element):
        await self.assert_predecode_rejected(raw)
    for entries in (
      b'"duplicate":0,' * 17000,
      b','.join(('"key%d":0' % n).encode() for n in range(17000)) + b',',
    ):
      await self.assert_predecode_rejected(b'{"type":"board_post","extra":{' + entries + b'"last":0}}')

  async def test_exact_structure_and_depth_boundaries_are_inclusive(self):
    # This wrapper uses seven punctuation characters; N scalars use N-1 commas.
    count = common_protocol.MAX_ENVELOPE_STRUCTURE_TOKENS - 6
    raw = b'{"type":"board_post","extra":[' + b'0,' * (count - 1) + b'0]}'
    result = await common_protocol.read_envelope(envelope_request(raw))
    self.assertEqual(len(result["extra"]), count)
    await self.assert_predecode_rejected(raw[:-2] + b',0]}')
    # The root object is container depth one.
    for depth in (common_protocol.MAX_ENVELOPE_DEPTH, common_protocol.MAX_ENVELOPE_DEPTH + 1):
      raw = b'{"type":"board_post","extra":' + b'[' * (depth - 1) + b'0' + b']' * (depth - 1) + b'}'
      if depth == common_protocol.MAX_ENVELOPE_DEPTH:
        await common_protocol.read_envelope(envelope_request(raw))
      else:
        await self.assert_predecode_rejected(raw)

  async def test_admitted_dense_containers_have_a_small_allocation_ceiling(self):
    count = (common_protocol.MAX_ENVELOPE_STRUCTURE_TOKENS - 6) // 3
    raw = b'{"type":"board_post","extra":[' + b'[],' * (count - 1) + b'[]]}'
    tracemalloc.start()
    try:
      result = await common_protocol.read_envelope(envelope_request(raw))
      _, peak = tracemalloc.get_traced_memory()
    finally:
      tracemalloc.stop()
    self.assertEqual(len(result["extra"]), count)
    self.assertLess(peak, 3 * 1024 * 1024)

  async def test_strings_escaping_unicode_and_stdlib_encodings_cannot_hide_structure(self):
    value = {"type": "board_post", "extra": {
      "escaped key \\\" {}[]:, 🪐": "{}[]:," * 6000 + '\\"\\\\🪐é\n\t',
      "nested": [[], {}, [1, "\\\\\"", None]],
    }}
    for ensure_ascii in (True, False):
      source = json.dumps(value, ensure_ascii=ensure_ascii)
      for encoding in ("utf-8", "utf-8-sig", "utf-16", "utf-16-le", "utf-16-be",
                       "utf-32", "utf-32-le", "utf-32-be"):
        with self.subTest(ensure_ascii=ensure_ascii, encoding=encoding):
          raw = source.encode(encoding)
          self.assertEqual(await common_protocol.read_envelope(envelope_request(raw, 7)), value)
    # Surrogate escapes and literal surrogate code units keep stdlib semantics.
    for raw in (b'{"extra":"\\ud800"}', '{"extra":"\ud800"}'.encode("utf-16-le", "surrogatepass")):
      self.assertEqual(await common_protocol.read_envelope(envelope_request(raw)), json.loads(raw))
    attack = '{"type":"board_post","quoted":"\\\\\\\"[]{}:,","extra":[' + '[],' * 12000 + '[]]}'
    for encoding in ("utf-8", "utf-8-sig", "utf-16", "utf-16-le", "utf-16-be",
                     "utf-32", "utf-32-le", "utf-32-be"):
      with self.subTest(attack_encoding=encoding):
        await self.assert_predecode_rejected(attack.encode(encoding))

  async def test_stdlib_remains_authoritative_for_malformed_and_compatible_json(self):
    for raw in (b'', b'{', b'{"x":}', b'{"x":[}}', b'{"x":1,}', b'{} {}',
                b'{"x":"unterminated}', b'{"x":"\\q"}', b'{"x":"\\u00xz"}',
                b'{"x":"\x01"}', b'{"x":"\xff"}', b'{"x":01}', b'{"x":true false}',
                b'[]', b'null', b'"scalar"'):
      with self.subTest(raw=raw), self.assertRaises(HTTPException) as caught:
        await common_protocol.read_envelope(envelope_request(raw))
      self.assertEqual(caught.exception.status_code, 400)
    for raw in (b'{"x":NaN,"y":Infinity,"z":-Infinity}',
                b'{"type":"register","type":"board_post","extra":{}}',
                b'{"\\u0074ype":"board_post","extra":[true,null,1.2e3]}'):
      with patch.object(common_protocol.json, "loads", wraps=json.loads) as decoded:
        result = await common_protocol.read_envelope(envelope_request(raw))
        decoded.assert_called_once_with(raw.decode())
      self.assertIsInstance(result, dict)
    # A resource failure wins over later grammar errors; no unsafe fallback parse.
    await self.assert_predecode_rejected(b'{"extra":[' + b'[],' * 12000 + b'bad JSON')

  async def test_escape_dense_scalars_use_stdlib_string_work_not_python_per_escape(self):
    # Inputs are prepared outside timing; each used to block the event loop for
    # approximately 3.3-3.7s before any identity/content validation.
    size = 16 * 1024 * 1024
    for pair, value in ((b'\\n', '\n'), (b'\\"', '"'), (b'\\\\', '\\'), (b'\\/', '/')):
      source = b'{"type":"board_post","extra":"' + pair * (size // 2) + b'"}'
      with self.subTest(pair=pair), \
           patch.object(json.decoder, "scanstring", wraps=json.decoder.scanstring) as strings, \
           patch.object(json, "loads", wraps=json.loads) as decoded:
        started = time.perf_counter()
        result = await common_protocol.read_envelope(envelope_request(source))
        elapsed = time.perf_counter() - started
        self.assertLess(elapsed, 1.0)
        self.assertEqual(strings.call_count, 4)  # Two keys and two values.
        decoded.assert_called_once_with(source.decode())
        self.assertEqual(len(result["extra"]), size // 2)
        self.assertEqual(result["extra"][:3], value * 3)

  async def test_maximum_text_and_slash_escaped_20_mib_gif_keep_signed_original(self):
    # A legal comment filled with FF produces tens of millions of base64 '/'
    # characters. JSON senders may legally escape each '/' without changing it.
    data = padded_gif(common_protocol.MAX_ATTACHMENT_BYTES, padding=b'\xff')
    key = common_protocol.new_signing_key()
    value = {"v": 0, "type": "message", "from": "member.example", "id": "abcdef12",
             "text": '🪐' * common_protocol.MAX_MESSAGE_TEXT_CHARS,
             "sent_at": time.time(), "attachment": wire(data, (1, 1))}
    signed = {**value, "sig": common_protocol.sign(value, key)}
    source = json.dumps(signed, separators=(",", ":")).replace('/', '\\/')
    self.assertGreater(source.count('\\/'), 20 * 1024 * 1024)
    self.assertLessEqual(len(source.encode()), common_protocol.MAX_ATTACHMENT_ENVELOPE_BYTES)
    with patch.object(json, "loads", wraps=json.loads) as decoded:
      result = await common_protocol.read_envelope(envelope_request(source.encode()))
      decoded.assert_called_once_with(source)
    self.assertEqual(result, signed)
    self.assertTrue(common_protocol.verify(
      {k: v for k, v in result.items() if k != "sig"}, result["sig"],
      common_protocol.signing_public_key(key)))
    self.assertEqual(common_protocol.validate_attachment(result["attachment"])[1], data)

  async def test_malformed_adjacent_strings_cannot_buy_unbounded_scanner_calls(self):
    # Missing commas are malformed, but the preflight must not synchronously
    # advance a million scalars before stdlib can report the first syntax error.
    source = b'{"type":"board_post","extra":' + b'""' * (1024 * 1024) + b'}'
    started = time.perf_counter()
    await self.assert_predecode_rejected(source)
    self.assertLess(time.perf_counter() - started, 1.0)
    with self.assertRaises(HTTPException) as malformed:
      await common_protocol.read_envelope(envelope_request(b'{"type":"board_post","extra":""""}'))
    self.assertEqual(malformed.exception.status_code, 400)
    for count in (common_protocol.MAX_ENVELOPE_STRUCTURE_TOKENS,
                  common_protocol.MAX_ENVELOPE_STRUCTURE_TOKENS + 1):
      with self.subTest(count=count), patch.object(json, "loads", wraps=json.loads) as decoded:
        with self.assertRaises(HTTPException) as result:
          await common_protocol.read_envelope(envelope_request(b'""' * count))
        self.assertEqual(result.exception.status_code,
                         400 if count == common_protocol.MAX_ENVELOPE_STRUCTURE_TOKENS else 413)
        self.assertEqual(decoded.call_count, int(count == common_protocol.MAX_ENVELOPE_STRUCTURE_TOKENS))

  async def test_control_byte_cap_remains_32_kib_even_for_large_scalars(self):
    for size in (common_protocol.MAX_ENVELOPE_BYTES, common_protocol.MAX_ENVELOPE_BYTES + 1):
      prefix, suffix = b'{"type":"register","extra":"', b'"}'
      raw = prefix + b'x' * (size - len(prefix) - len(suffix)) + suffix
      if size == common_protocol.MAX_ENVELOPE_BYTES:
        await common_protocol.read_envelope(envelope_request(raw))
      else:
        with self.assertRaises(HTTPException) as caught:
          await common_protocol.read_envelope(envelope_request(raw))
        self.assertEqual(caught.exception.status_code, 413)

  async def test_large_legal_scalar_and_signed_maximum_media_are_not_rewritten(self):
    key = common_protocol.new_signing_key()

    async def roundtrip(value):
      value = {"v": 0, "id": "abcdef12", "from": "member.example",
               "text": "x" * common_protocol.MAX_POST_TEXT_CHARS,
               "sent_at": time.time(), **value}
      signed = {**value, "sig": common_protocol.sign(value, key)}
      source = json.dumps(signed, ensure_ascii=False, separators=(",", ":"))
      self.assertLessEqual(len(source.encode()), common_protocol.MAX_ATTACHMENT_ENVELOPE_BYTES)
      with patch.object(common_protocol.json, "loads", wraps=json.loads) as decoded:
        result = await common_protocol.read_envelope(envelope_request(source.encode()))
        decoded.assert_called_once_with(source)
      self.assertEqual(result, signed)
      self.assertTrue(common_protocol.verify(
        {k: v for k, v in result.items() if k != "sig"}, result["sig"],
        common_protocol.signing_public_key(key)))
      return result

    await roundtrip({"type": "message", "enc": {"ciphertext": "a" * (8 * 1024 * 1024)},
                     "extra": "[]{}:,\\\"🪐" * 10000})
    photo = io.BytesIO()
    Image.new("RGB", (1, 1)).save(photo, format="JPEG")
    thumbnail = {"mime": "image/jpeg", "w": 1, "h": 1,
                 "data_b64": base64.b64encode(photo.getvalue().ljust(common_protocol.MAX_THUMBNAIL_BYTES, b'\0')).decode()}
    original = padded_gif(common_protocol.MAX_ATTACHMENT_BYTES)
    attachment = wire(original, (1, 1))
    result = await roundtrip({"type": "board_post", "attachments": [attachment],
                              "attachment": attachment, "thumbnails": [thumbnail]})
    self.assertEqual(common_protocol.validate_attachment(result["attachment"])[1], original)
    del result, original, attachment
    data = photo.getvalue().ljust(common_protocol.MAX_STATIC_ATTACHMENT_BYTES, b'\0')
    attachment = {"mime": "image/jpeg", "data_b64": base64.b64encode(data).decode(), "w": 1, "h": 1}
    result = await roundtrip({"type": "board_post", "attachments": [attachment] * 4,
                              "attachment": attachment, "thumbnails": [thumbnail] * 4})
    self.assertEqual([decoded for _, decoded in common_protocol.validate_attachments(result["attachments"])], [data] * 4)


class PublicEnvelopeAdmissionTests(unittest.TestCase):
  def test_actual_public_handlers_reject_dense_json_before_auth_media_or_commit(self):
    raw = b'{"type":"board_post","extra":[' + b'[],' * 699999 + b'[]]}'
    with tempfile.TemporaryDirectory() as root, TestClient(community_host.create_app(root)) as client:
      before = sorted(p.relative_to(root) for p in Path(root).rglob('*') if p.is_file())
      for path in ("/api/common/board", "/api/common/board/reply", "/api/common/directory"):
        with self.subTest(path=path), \
             patch.object(common_protocol.json, "loads") as decoded, \
             patch.object(common_protocol.ActorVerifier, "verify_envelope", new_callable=AsyncMock) as verified, \
             patch("common_protocol.validate_gif_bytes") as gif:
          tracemalloc.start()
          try:
            response = client.post(path, content=raw, headers={"Content-Type": "application/json"})
            _, peak = tracemalloc.get_traced_memory()
          finally:
            tracemalloc.stop()
          self.assertEqual(response.status_code, 413)
          decoded.assert_not_called()
          verified.assert_not_awaited()
          gif.assert_not_called()
          self.assertLess(peak, 6 * len(raw) + 2 * 1024 * 1024)
        self.assertEqual(response.json()["detail"],
                         "Request body is too large." if path == "/api/common/directory"
                         else "Envelope JSON is too complex.")
      self.assertEqual(sorted(p.relative_to(root) for p in Path(root).rglob('*') if p.is_file()), before)

  def test_public_handler_keeps_malformed_400_and_signed_unknown_fields(self):
    with tempfile.TemporaryDirectory() as root, TestClient(community_host.create_app(root)) as client:
      store = CommonPublicStore(root)
      store.register("member.example", "member", "")
      key = _peer(Path(root), "member.example")
      response = client.post("/api/common/board", content=b'{"type":"board_post","extra": [}')
      self.assertEqual(response.status_code, 400)
      body = {"v": 0, "type": "board_post", "from": "member.example", "id": str(uuid.uuid4()),
              "text": "Caption", "sent_at": time.time(), "attachment": wire(animation()),
              "extra": {"future": [{"key": "{}[]:,\\\"🪐"}] * 1000}}
      response = client.post("/api/common/board", json=_signed(key, body))
      self.assertEqual(response.status_code, 200, response.text)
      self.assertEqual(store.board_image(body["id"])[0].read_bytes(), animation())


class PublicRequestLifetimeTests(unittest.IsolatedAsyncioTestCase):
  async def asyncSetUp(self):
    fixture = tempfile.TemporaryDirectory()
    self.addCleanup(fixture.cleanup)
    self.root = Path(fixture.name)
    self.store = CommonPublicStore(self.root)
    self.keys = {}
    self.actors = {}
    for host in ("large-a.example", "large-b.example", "member.example"):
      self.store.register(host, host.split('.')[0], "")
      self.keys[host] = _peer(self.root, host)
      self.actors[host] = common_protocol.ActorVerifier(self.root)._read_cached(host)
    self.app = community_host.create_app(self.root)
    self.post_id = str(uuid.uuid4())
    self.store.store_post({"id": self.post_id, "host": "large-b.example",
                           "text": "Parent", "created_at": time.time(), "replies": []})

  def signed_raw(self, host="member.example", kind="board_post", **fields):
    body = {"v": 0, "type": kind, "from": host, "id": str(uuid.uuid4()),
            "text": "Caption", "sent_at": time.time(), **fields}
    return json.dumps(_signed(self.keys[host], body), separators=(",", ":")).encode()

  def observed_body(self, raw, chunk_size=None):
    reads = []

    async def stream():
      size = chunk_size or len(raw)
      for start in range(0, len(raw), size):
        chunk = raw[start:start + size]
        reads.append(len(chunk))
        yield chunk

    return stream(), reads

  async def test_one_byte_stalls_expire_before_decode_for_content_and_control_slots(self):
    import common_public
    for path, capacity in (("/api/common/board", 2), ("/api/common/directory/search", 8)):
      entered = 0
      ready, stall = asyncio.Event(), asyncio.Event()

      async def stream():
        nonlocal entered
        yield b'{'
        entered += 1
        if entered == capacity:
          ready.set()
        await stall.wait()

      with patch.object(common_protocol, "MAX_ENVELOPE_RECEIVE_SECONDS", .15), \
           patch.object(common_public, "MAX_PUBLIC_REQUEST_SECONDS", 2.0):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test") as client:
          with patch.object(json, "loads") as decoded, \
               patch.object(common_protocol.ActorVerifier, "verify_envelope", new_callable=AsyncMock) as verified:
            tasks = [asyncio.create_task(client.post(path, content=stream())) for _ in range(capacity)]
            try:
              await asyncio.wait_for(ready.wait(), 1)
              body, reads = self.observed_body(b'{}')
              self.assertEqual((await client.post(path, content=body)).status_code, 503)
              self.assertEqual(reads, [])
              responses = await asyncio.wait_for(asyncio.gather(*tasks), 1)
              self.assertTrue(all(response.status_code == 408 for response in responses))
              self.assertTrue(all("Envelope receive deadline exceeded." in response.text for response in responses))
              decoded.assert_not_called()
              verified.assert_not_awaited()
            finally:
              for task in tasks:
                task.cancel()
              await asyncio.gather(*tasks, return_exceptions=True)
          # No restart or modified identity/id/signature is needed after expiry.
          raw = self.signed_raw() if path.endswith("board") else self.signed_raw(kind="directory_read", q="")
          self.assertEqual((await client.post(path, content=raw)).status_code, 200)

  async def test_receive_budget_is_absolute_even_when_each_chunk_keeps_arriving(self):
    chunks = 0

    async def drip():
      nonlocal chunks
      while True:
        chunks += 1
        yield b' '
        await asyncio.sleep(.015)

    with patch.object(common_protocol, "MAX_ENVELOPE_RECEIVE_SECONDS", .12):
      async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test") as client:
        with patch.object(json, "loads") as decoded:
          response = await asyncio.wait_for(client.post("/api/common/board", content=drip()), 1)
          self.assertEqual(response.status_code, 408)
          self.assertGreater(chunks, 2)
          self.assertLess(chunks, 20)
          decoded.assert_not_called()

  async def test_immediately_ready_chunks_cannot_run_past_receive_budget(self):
    # No await inside this generator: deadline enforcement must not depend on
    # another task/timer getting event-loop time between stream chunks.
    async def ready():
      yield b'{}'

    with patch.object(common_protocol, "MAX_ENVELOPE_RECEIVE_SECONDS", 0.0):
      async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test") as client:
        with patch.object(json, "loads") as decoded:
          self.assertEqual((await client.post("/api/common/board", content=ready())).status_code, 408)
          decoded.assert_not_called()

  async def test_reservation_expiry_unwinds_identity_before_capacity_is_reused(self):
    import common_public
    entered = 0
    cancelled = 0
    ready, stall = asyncio.Event(), asyncio.Event()

    async def fetch(host, **kwargs):
      nonlocal entered, cancelled
      entered += 1
      if entered == 2:
        ready.set()
      try:
        await stall.wait()
      finally:
        cancelled += 1

    raw = self.signed_raw(extra="a" * (1024 * 1024))
    with patch.object(common_public, "MAX_PUBLIC_REQUEST_SECONDS", .3):
      async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test") as client:
        with patch.object(common_protocol.ActorVerifier, "fetch_actor", side_effect=fetch):
          tasks = [asyncio.create_task(client.post("/api/common/board", content=raw)) for _ in range(2)]
          try:
            await asyncio.wait_for(ready.wait(), 1)
            stream, reads = self.observed_body(raw)
            self.assertEqual((await client.post("/api/common/board", content=stream)).status_code, 503)
            self.assertEqual(reads, [])
            results = await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), 1)
            self.assertTrue(all(isinstance(result, AssertionError) for result in results))
            self.assertEqual(cancelled, 2)
          finally:
            for task in tasks:
              task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        self.assertEqual((await client.post("/api/common/board", content=raw)).status_code, 200)

  async def test_reservation_expiry_unwinds_stalled_app_send_then_allows_unchanged_retry(self):
    import common_public
    entered = 0
    ready, stall = asyncio.Event(), asyncio.Event()
    cancelled = 0
    sent = []

    async def app(scope, receive, send):
      async def blocked_send(message):
        nonlocal entered, cancelled
        if message["type"] == "http.response.start" and (b'x-stall-send', b'yes') in scope["headers"]:
          sent.append(message["status"])
          entered += 1
          if entered == 2:
            ready.set()
          try:
            await stall.wait()
          except asyncio.CancelledError:
            cancelled += 1
            raise
        await send(message)
      await self.app(scope, receive, blocked_send)

    raw = self.signed_raw(extra="a" * (1024 * 1024))
    with patch.object(common_public, "MAX_PUBLIC_REQUEST_SECONDS", .3):
      async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        tasks = [asyncio.create_task(client.post("/api/common/board", content=raw,
                                                headers={"x-stall-send": "yes"})) for _ in range(2)]
        try:
          await asyncio.wait_for(ready.wait(), 1)
          stream, reads = self.observed_body(raw)
          self.assertEqual((await client.post("/api/common/board", content=stream)).status_code, 503)
          self.assertEqual(reads, [])
          # ASGITransport reports the incomplete app response as an assertion.
          # Unlike Uvicorn it has no server-owned fallback500 (tested below).
          results = await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), 1)
          self.assertTrue(all(isinstance(result, AssertionError) for result in results))
          self.assertEqual(cancelled, 2)
          self.assertEqual(sent, [200, 200])
          self.assertEqual((await client.post("/api/common/board", content=raw)).status_code, 200)
        finally:
          for task in tasks:
            task.cancel()
          await asyncio.gather(*tasks, return_exceptions=True)

  async def test_escape_dense_public_post_preserves_caption_without_event_loop_starvation(self):
    post_id = str(uuid.uuid4())
    raw = self.signed_raw(id=post_id, text='Caption 🪐 "kept"', extra='\n' * (8 * 1024 * 1024))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test") as client:
      started = time.perf_counter()
      response = await client.post("/api/common/board", content=raw)
      elapsed = time.perf_counter() - started
    self.assertEqual(response.status_code, 200, response.text)
    self.assertLess(elapsed, 1.0)
    record = json.loads((self.store.board_dir() / f"{post_id}.json").read_text())
    self.assertEqual(record["text"], 'Caption 🪐 "kept"')

  async def test_uvicorn_fallback_after_expiry_retains_no_envelope_traceback_or_slot(self):
    import common_public
    import h11
    import inspect
    from uvicorn.protocols.http.h11_impl import RequestResponseCycle

    class TrackedEnvelope(dict):
      pass

    class TrackedFailure(RuntimeError):
      pass

    original_read = common_public.read_envelope
    original_fetch = common_protocol.ActorVerifier.fetch_actor
    original_store = CommonPublicStore.store_post
    # FastAPI can retain an included router rather than flatten its routes.
    routes = [child for route in self.app.routes
              for child in (getattr(route.original_router, "routes", ())
                            if hasattr(route, "original_router") else (route,))]
    route = next(route for route in routes if getattr(route, "path", None) == "/api/common/board"
                 and "POST" in (getattr(route, "methods", None) or ()))
    admission = inspect.getclosurevars(type(route).handle).nonlocals["admission"]
    # Exercise expiry while verifying, sending200, and sending an unhandled500.
    # The latter's exception traceback used to retain the endpoint's media.
    for phase in ("identity", "success", "failure"):
      with self.subTest(phase=phase):
        envelope_refs, error_refs = [], []
        fallback_started, unblock = asyncio.Event(), asyncio.Event()
        drain_calls = 0

        async def tracked_read(request):
          envelope = TrackedEnvelope(await original_read(request))
          envelope_refs.append(weakref.ref(envelope))
          return envelope

        async def identity(host, **kwargs):
          await asyncio.Event().wait()

        def failure(*args, **kwargs):
          error = TrackedFailure("fixture failure")
          error_refs.append(weakref.ref(error))
          raise error

        class BlockedFlow:
          write_paused = True

          def resume_reading(self):
            pass

          async def drain(self):
            nonlocal drain_calls
            drain_calls += 1
            if phase == "identity" or drain_calls == 2:
              fallback_started.set()
            await unblock.wait()

        raw = self.signed_raw(extra="a" * (1024 * 1024))
        scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
                 "method": "POST", "scheme": "http", "path": "/api/common/board",
                 "raw_path": b"/api/common/board", "root_path": "", "query_string": b"",
                 "headers": [], "client": ("127.0.0.1", 1), "server": ("test", 80)}
        conn = h11.Connection(h11.SERVER)
        conn.receive_data(b'POST /api/common/board HTTP/1.1\r\nHost: test\r\nContent-Length: '
                          + str(len(raw)).encode() + b'\r\n\r\n')
        conn.next_event()
        message_event = asyncio.Event()
        message_event.set()
        transport = Mock()
        cycle = RequestResponseCycle(
          scope=scope, conn=conn, transport=transport, flow=BlockedFlow(),
          logger=Mock(), access_logger=Mock(), access_log=False,
          default_headers=[], message_event=message_event, on_response=lambda: None,
        )
        cycle.body = bytearray(raw)
        cycle.more_body = False
        with patch.object(common_public, "MAX_PUBLIC_REQUEST_SECONDS", .2), \
             patch.object(common_public, "read_envelope", side_effect=tracked_read):
          phase_patch = (patch.object(common_protocol.ActorVerifier, "fetch_actor", side_effect=identity)
                         if phase == "identity" else
                         patch.object(CommonPublicStore, "store_post", side_effect=failure)
                         if phase == "failure" else patch.object(self.app, "debug", False))
          with phase_patch:
            task = asyncio.create_task(cycle.run_asgi(self.app))
            try:
              await asyncio.wait_for(fallback_started.wait(), 1)
              gc.collect()
              self.assertFalse(task.done())  # Native server fallback still waits.
              self.assertEqual(drain_calls, 1 if phase == "identity" else 2)
              self.assertEqual(len(envelope_refs), 1)
              self.assertIsNone(envelope_refs[0]())
              self.assertTrue(all(ref() is None for ref in error_refs))
              if phase == "failure":
                self.assertEqual(len(error_refs), 1)
              self.assertEqual(len(cycle.body), 0)
              self.assertNotIn("common_envelope_max_bytes", scope.get("state", {}))
              # Inspect the actual suspended coroutine chain, not just HTTPX's
              # incomplete-response assertion: only Uvicorn's small500 remains.
              current, frames = task.get_coro(), []
              while current is not None:
                frame = getattr(current, "cr_frame", None)
                if frame is not None:
                  frames.append((frame.f_code.co_name, frame.f_locals))
                current = getattr(current, "cr_await", None)
              self.assertTrue(any(name == "send_500_response" for name, _ in frames))
              self.assertFalse(any(name in ("read_envelope", "post_to_board", "handle", "reserve")
                                   for name, _ in frames))
              self.assertFalse(any(isinstance(value, (TrackedEnvelope, TrackedFailure))
                                   for _, local in frames for value in local.values()))
              self.assertEqual(list(admission._used.values()), [0, 0])
              # Retry while the native fallback is STILL flow-control blocked,
              # not only after the socket task has completed. Restore only our
              # induced fixture stall/failure for these real signed requests.
              with patch.object(common_protocol.ActorVerifier, "fetch_actor", original_fetch), \
                   patch.object(CommonPublicStore, "store_post", original_store):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test") as client:
                  self.assertEqual((await client.post("/api/common/board", content=raw)).status_code, 200)
                  self.assertEqual((await client.post("/api/common/directory/search", content=self.signed_raw(
                    kind="directory_read", q=""))).status_code, 200)
              self.assertFalse(task.done())
              self.assertEqual(list(admission._used.values()), [0, 0])
            finally:
              unblock.set()
              await asyncio.wait_for(task, 1)
          self.assertTrue(cycle.response_complete)
          self.assertTrue(cycle.response_started)
          self.assertIn(b'Internal Server Error', b''.join(
            call.args[0] for call in transport.write.call_args_list))

  async def test_two_identity_waits_do_not_queue_third_body_or_block_small_controls(self):
    entered = set()
    ready = asyncio.Event()
    release = asyncio.Event()

    async def fetch(host, **kwargs):
      if host.startswith("large-"):
        entered.add(host)
        if len(entered) == 2:
          ready.set()
        await release.wait()
      return self.actors[host]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test") as client:
      with patch.object(common_protocol.ActorVerifier, "fetch_actor", side_effect=fetch):
        first = self.signed_raw("large-a.example", extra="a" * (1024 * 1024))
        second = self.signed_raw("large-b.example", "board_reply", post_id=self.post_id,
                                 extra="b" * (1024 * 1024))
        tasks = [asyncio.create_task(client.post("/api/common/board", content=first)),
                 asyncio.create_task(client.post("/api/common/board/reply", content=second))]
        try:
          await asyncio.wait_for(ready.wait(), 5)
          raw = self.signed_raw(extra="c" * (1024 * 1024))
          stream, reads = self.observed_body(raw)
          response = await client.post("/api/common/board", content=stream)
          self.assertEqual(response.status_code, 503)
          self.assertEqual(response.headers["Retry-After"], "1")
          self.assertEqual(reads, [])
          # Method mismatches must not become an admission503 or inner-error500.
          for path in ("/api/common/board/media/abcdef12.gif", "/api/common/directory/avatars/a"):
            stream, reads = self.observed_body(raw)
            mismatch = await client.post(path, content=stream)
            self.assertEqual(mismatch.status_code, 405)
            self.assertIn("GET", mismatch.headers["Allow"])
            self.assertEqual(reads, [])
          control = await client.post("/api/common/directory/search", content=self.signed_raw(
            kind="directory_read", q=""))
          self.assertEqual(control.status_code, 200)
          self.assertEqual((await client.get("/api/common/board")).status_code, 200)
          self.assertEqual((await client.get("/api/common/board/media/abcdef12.gif")).status_code, 404)
          # Claimed content type and Content-Length cannot widen a control route.
          oversize = b'{"type":"board_post","extra":"' + b'a' * (1024 * 1024) + b'"}'
          for chunk_size in (4096, len(oversize)):
            stream, reads = self.observed_body(oversize, chunk_size)
            with patch.object(common_protocol.json, "loads") as decoded:
              tracemalloc.start()
              try:
                rejected = await client.post("/api/common/directory/search", content=stream,
                                             headers={"Content-Length": "2"})
                _, peak = tracemalloc.get_traced_memory()
              finally:
                tracemalloc.stop()
              self.assertEqual(rejected.status_code, 413)
              decoded.assert_not_called()
            self.assertLess(peak, 512 * 1024)  # Never copy the oversized chunk.
            self.assertLessEqual(len(reads), 9)
          tasks[0].cancel()
          await asyncio.gather(tasks[0], return_exceptions=True)
          stream, reads = self.observed_body(raw)
          retried = await client.post("/api/common/board", content=stream)
          self.assertEqual(retried.status_code, 200, retried.text)
          self.assertEqual(sum(reads), len(raw))
          release.set()
          self.assertEqual((await tasks[1]).status_code, 200)
        finally:
          release.set()
          for task in tasks:
            task.cancel()
          await asyncio.gather(*tasks, return_exceptions=True)

  async def test_control_budget_is_finite_and_independent_of_content_reservations(self):
    import common_public
    entered = 0
    ready, release = asyncio.Event(), asyncio.Event()

    async def fetch(host, **kwargs):
      nonlocal entered
      if host == "large-a.example":
        entered += 1
        if entered == common_public.MAX_PUBLIC_CONTROL_REQUESTS:
          ready.set()
        await release.wait()
      return self.actors[host]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test") as client:
      with patch.object(common_protocol.ActorVerifier, "fetch_actor", side_effect=fetch):
        raw = self.signed_raw("large-a.example", "directory_read", q="")
        tasks = [asyncio.create_task(client.post("/api/common/directory/search", content=raw))
                 for _ in range(common_public.MAX_PUBLIC_CONTROL_REQUESTS)]
        try:
          await asyncio.wait_for(ready.wait(), 5)
          stream, reads = self.observed_body(raw)
          rejected = await client.post("/api/common/directory/search", content=stream)
          self.assertEqual(rejected.status_code, 503)
          self.assertEqual(reads, [])
          response = await client.post("/api/common/board", content=self.signed_raw())
          self.assertEqual(response.status_code, 200)
          tasks[0].cancel()
          await asyncio.gather(tasks[0], return_exceptions=True)
          release.set()
          retried = await client.post("/api/common/directory/search", content=raw)
          self.assertEqual(retried.status_code, 200)
          self.assertTrue(all(response.status_code == 200 for response in await asyncio.gather(*tasks[1:])))
        finally:
          release.set()
          for task in tasks:
            task.cancel()
          await asyncio.gather(*tasks, return_exceptions=True)

  async def test_success_error_and_cancelled_response_sends_hold_then_release_capacity(self):
    entered = 0
    statuses = []
    ready, release = asyncio.Event(), asyncio.Event()

    async def app(scope, receive, send):
      async def observed_send(message):
        nonlocal entered
        if message["type"] == "http.response.start" and (b'x-hold-send', b'yes') in scope["headers"]:
          statuses.append(message["status"])
          entered += 1
          if entered == 2:
            ready.set()
          await release.wait()
        await send(message)
      await self.app(scope, receive, observed_send)

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
      tasks = [asyncio.create_task(client.post("/api/common/board", content=self.signed_raw(),
                                               headers={"x-hold-send": "yes"})),
               asyncio.create_task(client.post("/api/common/board", content=b'{',
                                               headers={"x-hold-send": "yes"}))]
      try:
        await asyncio.wait_for(ready.wait(), 5)
        self.assertEqual(sorted(statuses), [200, 400])
        raw = self.signed_raw()
        stream, reads = self.observed_body(raw)
        self.assertEqual((await client.post("/api/common/board", content=stream)).status_code, 503)
        self.assertEqual(reads, [])
        tasks[0].cancel()
        await asyncio.gather(tasks[0], return_exceptions=True)
        self.assertEqual((await client.post("/api/common/board", content=raw)).status_code, 200)
        release.set()
        self.assertEqual((await tasks[1]).status_code, 400)
        # An unexpected handler exception must release too, without suppressing it.
        with patch.object(CommonPublicStore, "store_post", side_effect=RuntimeError("fixture failure")):
          with self.assertRaisesRegex(RuntimeError, "fixture failure"):
            await client.post("/api/common/board", content=self.signed_raw())
        self.assertEqual((await client.post("/api/common/board", content=self.signed_raw())).status_code, 200)
      finally:
        release.set()
        for task in tasks:
          task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

  async def test_unhandled_failure_tracebacks_remain_admitted_until_500_is_sent(self):
    await self.check_unhandled_failure_response_lifetime(debug=False)

  async def test_debug_failure_tracebacks_remain_admitted_until_500_is_sent(self):
    await self.check_unhandled_failure_response_lifetime(debug=True)

  async def check_unhandled_failure_response_lifetime(self, *, debug):
    self.app.debug = debug
    entered = 0
    ready, release = asyncio.Event(), asyncio.Event()

    async def app(scope, receive, send):
      async def blocked_send(message):
        nonlocal entered
        if message["type"] == "http.response.start" and (b'x-hold-send', b'yes') in scope["headers"]:
          self.assertEqual(message["status"], 500)
          entered += 1
          if entered == 2:
            ready.set()
          await release.wait()
        await send(message)
      await self.app(scope, receive, blocked_send)

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
      raw = self.signed_raw(extra="a" * (1024 * 1024))
      with patch.object(CommonPublicStore, "store_post", side_effect=RuntimeError("fixture failure")):
        tasks = [asyncio.create_task(client.post("/api/common/board", content=raw,
                                                headers={"x-hold-send": "yes"})) for _ in range(2)]
        try:
          await asyncio.wait_for(ready.wait(), 5)
          stream, reads = self.observed_body(raw)
          rejected = await client.post("/api/common/board", content=stream)
          self.assertEqual(rejected.status_code, 503)
          self.assertEqual(reads, [])
          tasks[0].cancel()
          await asyncio.gather(tasks[0], return_exceptions=True)
          # A cancelled 500 send also releases its held reservation.
          retry = await client.post("/api/common/board", content=raw)
          self.assertEqual(retry.status_code, 500)
          if debug:
            self.assertIn("fixture failure", retry.text)
          else:
            self.assertEqual(retry.text, "Internal Server Error")
          release.set()
          response = await tasks[1]
          self.assertEqual(response.status_code, 500)
          if debug:
            self.assertIn("fixture failure", response.text)
          else:
            self.assertEqual(response.text, "Internal Server Error")
        finally:
          release.set()
          for task in tasks:
            task.cancel()
          await asyncio.gather(*tasks, return_exceptions=True)
      self.assertEqual((await client.post("/api/common/board", content=raw)).status_code, 200)


class CanonicalGifTests(unittest.TestCase):
  def test_animated_original_cannot_be_installed_as_an_autoplay_thumbnail(self):
    with self.assertRaisesRegex(ValueError, "static thumbnail"):
      validate_thumbnail_bytes(wire(animation()), animation())

  def test_exact_original_and_static_behavior_are_preserved(self):
    data = animation()
    value = wire(data)
    validated, original = common_protocol.validate_attachment(value)
    self.assertIs(validated, value)
    self.assertEqual(original, data)
    self.assertEqual(check_reply_original((value, data)), (value, data))
    self.assertEqual(common_protocol.ATTACHMENT_MIME_EXT["image/gif"], "gif")
    for mime in ("image/jpeg", "image/png", "image/webp"):
      legacy = {**value, "mime": mime, "data_b64": base64.b64encode(b"legacy original").decode()}
      self.assertEqual(common_protocol.validate_attachment(legacy)[1], b"legacy original")

  def test_complete_framing_and_every_raster_are_required(self):
    for value, status in invalid_gifs():
      with self.subTest(status=status, value=value):
        with self.assertRaises(HTTPException) as caught:
          common_protocol.validate_attachment(value)
        self.assertEqual(caught.exception.status_code, status)
    data = tiny_container()
    for end in range(len(data)):
      with self.subTest(prefix=end), self.assertRaises(HTTPException):
        common_protocol.validate_attachment(wire(data[:end], (1, 1)))

  def test_budget_and_container_preflight_precedes_pillow(self):
    for value, status in invalid_gifs()[:-1]:
      with self.subTest(status=status), patch("PIL.Image.open") as opened:
        with self.assertRaises(HTTPException):
          common_protocol.validate_attachment(value)
        opened.assert_not_called()
    # Inclusive frame/side boundaries remain usable without large fixtures.
    common_protocol.validate_attachment(wire(tiny_container(frames=300), (1, 1)))
    common_protocol.validate_attachment(wire(tiny_container((1600, 1)), (1600, 1)))

  def test_wire_shape_mime_and_byte_limits_are_unchanged(self):
    data = animation()
    value = wire(data)
    cases = [({**value, "frames": 2}, 400), ({**value, "w": True}, 400),
             ({**value, "h": 0}, 400), ({**value, "data_b64": "!"}, 400),
             (wire(b"x" * (20 * 1024 * 1024 + 1)), 413)]
    output = io.BytesIO()
    Image.new("RGB", (24, 16)).save(output, format="PNG")
    cases.append((wire(output.getvalue()), 400))
    for malformed, status in cases:
      with self.subTest(status=status), self.assertRaises(HTTPException) as caught:
        common_protocol.validate_attachment(malformed)
      self.assertEqual(caught.exception.status_code, status)
    with self.assertRaises(HTTPException) as caught:
      common_protocol.validate_attachment_envelope_size({"text": "x" * (60 * 1024 * 1024)})
    self.assertEqual(caught.exception.status_code, 413)

  def test_large_gif_and_static_boundaries_and_gallery_total(self):
    mb = 1024 * 1024
    for size in (mb + 1, 20 * mb):
      data = padded_gif(size)
      self.assertEqual(len(data), size)
      self.assertEqual(common_protocol.validate_attachment(wire(data, (1, 1)))[1], data)
    mime, poster = image_thumbnail_bytes(data)
    self.assertEqual(mime, "image/webp")
    self.assertLessEqual(len(poster), common_protocol.MAX_THUMBNAIL_BYTES)
    with self.assertRaises(HTTPException) as caught:
      common_protocol.validate_attachment(wire(padded_gif(20 * mb + 1), (1, 1)))
    self.assertEqual(caught.exception.status_code, 413)
    static = lambda size: {"mime": "image/jpeg", "data_b64": base64.b64encode(b"a" * size).decode(), "w": 1, "h": 1}
    common_protocol.validate_attachment(static(5 * mb))
    with self.assertRaises(HTTPException) as caught:
      common_protocol.validate_attachment(static(5 * mb + 1))
    self.assertEqual(caught.exception.status_code, 413)
    common_protocol.validate_attachments([static(5 * mb)] * 4)
    with self.assertRaises(HTTPException) as caught:
      common_protocol.validate_attachments([static(5 * mb)] * 4 + [static(1)])
    self.assertEqual(caught.exception.status_code, 400)  # four-image cap
    with self.assertRaises(HTTPException) as caught:
      common_protocol.validate_attachments([wire(data, (1, 1)), static(1)])
    self.assertEqual(caught.exception.status_code, 413)
    with self.assertRaises(HTTPException) as caught:
      common_protocol.validate_attachment(static(120 * 1024 + 1), thumbnail=True)
    self.assertEqual(caught.exception.status_code, 413)

  def test_large_original_fits_signed_plaintext_and_encrypted_transport(self):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
    root = self.enterContext(tempfile.TemporaryDirectory())
    self.enterContext(patch.dict(os.environ, {
      "APP_STORAGE_DIR": root, "APP_ID": "7", "APP_SLUG": "social",
    }))
    import social_routes
    original = wire(padded_gif(1024 * 1024 + 1), (1, 1))
    key = common_protocol.new_signing_key()
    plain = {"v": 0, "type": "message", "id": "abcdef12", "from": "a.example",
             "to": "b.example", "text": "", "sent_at": time.time(),
             "attachment": original}
    plain["sig"] = common_protocol.sign(plain, key)
    common_protocol.validate_attachment_envelope_size(plain)
    self.assertTrue(common_protocol.verify(
      {k: v for k, v in plain.items() if k != "sig"}, plain["sig"],
      common_protocol.signing_public_key(key)))
    recipient = X25519PrivateKey.generate()
    private = base64.b64encode(recipient.private_bytes(
      serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
      serialization.NoEncryption())).decode()
    public = base64.b64encode(recipient.public_key().public_bytes(
      serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()
    sealed = social_routes._seal_dm("abcdef12", public, text="", attachment=original, reply_to=None)
    encrypted = {k: v for k, v in plain.items() if k not in ("attachment", "sig")}
    encrypted["enc"] = sealed
    encrypted["sig"] = common_protocol.sign(encrypted, key)
    common_protocol.validate_attachment_envelope_size(encrypted)
    opened = social_routes._open_dm("abcdef12", sealed, private)
    self.assertEqual(common_protocol.validate_attachment(opened["attachment"])[1],
                     base64.b64decode(original["data_b64"]))

  def test_first_frame_thumbnail_is_a_static_transparent_poster(self):
    data = animation()
    mime, poster = image_thumbnail_bytes(data)
    self.assertEqual(mime, "image/webp")
    with Image.open(io.BytesIO(poster)) as image:
      self.assertEqual(image.size, (24, 16))
      self.assertEqual(image.n_frames, 1)
      rgba = image.convert("RGBA")
      self.assertEqual(rgba.getpixel((0, 0))[3], 0)
      self.assertGreater(rgba.getpixel((12, 8))[0], 240)
      self.assertLess(rgba.getpixel((12, 8))[2], 10)


def decoded_frames(data):
  """Each frame's composited pixels plus the fields graphic controls set."""
  with Image.open(io.BytesIO(data)) as image:
    frames = []
    for index in range(image.n_frames):
      image.seek(index)
      image.load()
      frames.append((image.convert("RGBA").tobytes(), image.info.get("duration"),
                     image.disposal_method, image.info.get("transparency")))
    return frames


class GifMetadataBudgetTests(unittest.TestCase):
  """Metadata cannot multiply decode-view objects or synchronous framing work."""

  def test_repeated_graphic_controls_fold_to_the_same_animation_and_poster(self):
    data = animation()
    controls = [i for i in range(len(data)) if data.startswith(b"\x21\xf9\x04", i)]
    self.assertEqual(len(controls), 2)
    self.assertTrue(all(data[i + 8] == 0x2c for i in controls))
    repeated, every_control, previous = bytearray(), bytearray(), 0
    for i in controls:
      packed, delay, index = data[i + 3], int.from_bytes(data[i + 4:i + 6], "little"), data[i + 6]
      self.assertTrue(packed & 0x01 and packed & 0x1c)
      # Transparency, disposal and delay each come from a different control.
      run = [control(0x01, delay + 50, index), control(packed & 0x1c, delay + 20, 99),
             control(0, delay, 77)]
      repeated += data[previous:i] + run[0] + PLAIN_TEXT + run[1] + APPLICATION + UNKNOWN + run[2]
      every_control += data[previous:i] + b"".join(run)
      previous = i + 8
    # Controls after the last image are validated but precede no raster.
    repeated += data[previous:-1] + control(0x0d, 5, 3) * 3 + b";"
    every_control += data[previous:]
    original = bytes(repeated)
    value = wire(original)
    self.assertEqual(common_protocol.validate_attachment(value)[1], original)
    view = common_protocol.validate_gif_bytes(value, original)
    self.assertLessEqual(view.count(b"\x21\xf9\x04"), 3 * len(controls))
    # Equivalent to the earlier view that retained every control, and to the
    # conforming one-control-per-frame animation those controls fold into.
    self.assertEqual(decoded_frames(view), decoded_frames(bytes(every_control)))
    self.assertEqual(decoded_frames(view), decoded_frames(data))
    self.assertEqual(image_thumbnail_bytes(original), image_thumbnail_bytes(data))

  def test_identical_control_runs_leave_the_conforming_decode_view(self):
    one = with_metadata(tiny_container(), control(0x05, 7, 0))
    expected = common_protocol.validate_gif_bytes(wire(one, (1, 1)), one)
    self.assertEqual(expected.count(b"\x21\xf9"), 1)
    for metadata in (control(0x05, 7, 0) * 20_000,
                     (control(0x05, 7, 0) + PLAIN_TEXT + APPLICATION + UNKNOWN) * 5_000):
      data = with_metadata(tiny_container(), metadata)
      with self.subTest(size=len(data)):
        self.assertEqual(common_protocol.validate_gif_bytes(wire(data, (1, 1)), data), expected)

  def test_repeated_controls_validate_without_per_control_objects(self):
    data = with_metadata(tiny_container(), control(0x04, 3) * 50_000)
    shape = {"mime": "image/gif", "w": 1, "h": 1}
    gc.collect()
    tracemalloc.start()
    try:
      view = common_protocol.validate_gif_bytes(shape, data)
      peak = tracemalloc.get_traced_memory()[1]
    finally:
      tracemalloc.stop()
    self.assertEqual(view.count(b"\x21\xf9"), 1)
    # Retaining a slice per control held several MiB for this 400 KB input.
    self.assertLess(peak, 256 * 1024)

  def test_block_budget_counts_extensions_images_and_sub_blocks_exactly(self):
    tiny = tiny_container()  # One image descriptor and one data sub-block.
    start = 13 + 3 * 2 ** ((tiny[10] & 7) + 1)
    payload = tiny[start + 12:-2]
    dense_image = tiny[:start + 11] + b"".join(b"\x01" + bytes([c]) for c in payload) + b"\x00;"
    cases = {
      "control": (with_metadata(tiny, control() * 8), 2 + 8),
      "plain text": (with_metadata(tiny, PLAIN_TEXT * 8), 2 + 16),
      "application": (with_metadata(tiny, APPLICATION * 8), 2 + 16),
      "unknown": (with_metadata(tiny, UNKNOWN * 8), 2 + 16),
      "empty comments": (with_metadata(tiny, b"\x21\xfe\x00" * 8), 2 + 8),
      "comment sub-blocks": (with_metadata(tiny, b"\x21\xfe" + b"\x01x" * 8 + b"\x00"), 2 + 9),
      "image sub-blocks": (dense_image, 1 + len(payload)),
    }
    for name, (data, blocks) in cases.items():
      with self.subTest(name):
        with patch.object(common_protocol, "MAX_GIF_BLOCKS", blocks):
          self.assertEqual(common_protocol.validate_attachment(wire(data, (1, 1)))[1], data)
        with patch.object(common_protocol, "MAX_GIF_BLOCKS", blocks - 1), \
             patch("PIL.Image.open") as opened, self.assertRaises(HTTPException) as caught:
          common_protocol.validate_attachment(wire(data, (1, 1)))
        self.assertEqual((caught.exception.status_code, caught.exception.detail),
                         (413, "GIF structure is too complex."))
        opened.assert_not_called()

  def test_block_budget_stops_the_walk_before_later_framing(self):
    cap = common_protocol.MAX_GIF_BLOCKS
    tiny = tiny_container()
    comment = lambda count: b"\x21\xfe" + b"\x01x" * count + b"\x00"
    at_cap = with_metadata(tiny, comment(cap - 3))
    self.assertEqual(common_protocol.validate_attachment(wire(at_cap, (1, 1)))[1], at_cap)
    start = 13 + 3 * 2 ** ((tiny[10] & 7) + 1)
    unterminated = with_metadata(tiny, comment(cap))[:start + 2 + 2 * cap]
    # Unterminated after the cap: 413, not the truncation 400 a full walk finds.
    for over in (with_metadata(tiny, comment(cap - 2)), unterminated):
      with self.subTest(size=len(over)), self.assertRaises(HTTPException) as caught:
        common_protocol.validate_attachment(wire(over, (1, 1)))
      self.assertEqual(caught.exception.status_code, 413)

  def test_maximum_size_dense_metadata_is_rejected_before_pillow(self):
    size = common_protocol.MAX_ATTACHMENT_BYTES
    tiny = tiny_container()
    room = size - len(tiny) - 3
    dense = {
      "repeated controls": with_metadata(tiny, control() * ((room + 3) // 8)),
      "empty unknown extensions": with_metadata(tiny, b"\x21\x99\x00" * ((room + 3) // 3)),
      "one-byte comment sub-blocks": with_metadata(tiny, b"\x21\xfe" + b"\x01x" * (room // 2) + b"\x00"),
    }
    for name, data in dense.items():
      self.assertLessEqual(len(data), size)
      with self.subTest(name), patch("PIL.Image.open") as opened, \
           self.assertRaises(HTTPException) as caught:
        common_protocol.validate_attachment(wire(data, (1, 1)))
      self.assertEqual(caught.exception.status_code, 413)
      opened.assert_not_called()
    # Legal maximum-size originals with short sub-blocks keep exact identity.
    data = padded_gif(size, chunk=64)
    self.assertEqual(len(data), size)
    self.assertEqual(common_protocol.validate_attachment(wire(data, (1, 1)))[1], data)
    self.assertEqual(image_thumbnail_bytes(data)[0], "image/webp")

  def test_every_folded_control_and_extension_header_keeps_framing_checks(self):
    good = control(0x04, 3)
    malformed = [
      b"\x21\xf9\x05" + bytes(6),  # wrong control size
      control(0x20),  # reserved bits
      control(0x10),  # disposal 4
      good[:-1] + b"\x01",  # control carries a data sub-block
      b"\x21\x01\x0b" + bytes(11) + b"\x00",  # plain-text header size
      b"\x21\xff\x0a" + bytes(10) + b"\x00",  # application header size
    ]
    for bad in malformed:
      data = with_metadata(tiny_container(), good * 3 + bad + good * 3)
      with self.subTest(bad=bad), patch("PIL.Image.open") as opened, \
           self.assertRaises(HTTPException) as caught:
        common_protocol.validate_attachment(wire(data, (1, 1)))
      self.assertEqual(caught.exception.status_code, 400)
      opened.assert_not_called()
    data = with_metadata(tiny_container(), good * 3)
    start = 13 + 3 * 2 ** ((data[10] & 7) + 1)
    for end in range(start, start + 3 * len(good)):
      with self.subTest(prefix=end), self.assertRaises(HTTPException) as caught:
        common_protocol.validate_attachment(wire(data[:end], (1, 1)))
      self.assertEqual(caught.exception.status_code, 400)


class MediaWorkLedger(ExitStack):
  """Record every GIF walk and poster render, and whether the board lock was held."""

  def __enter__(self):
    super().__enter__()
    self.held, self.walks, self.renders = 0, [], []
    lock, walk = CommonPublicStore._mutation_lock, common_protocol.validate_gif_bytes
    render = common_public.image_thumbnail_bytes

    @contextmanager
    def held_lock(store, local_lock, name):
      with lock(store, local_lock, name):
        self.held += 1
        try:
          yield
        finally:
          self.held -= 1

    def counted_walk(wire, data):
      self.walks.append((bytes(data[:64]), len(data), bool(self.held)))
      return walk(wire, data)

    def counted_render(source, *args, **kwargs):
      self.renders.append(bool(self.held))
      return render(source, *args, **kwargs)

    self.enter_context(patch.object(CommonPublicStore, "_mutation_lock", held_lock))
    self.enter_context(patch("common_protocol.validate_gif_bytes", counted_walk))
    self.enter_context(patch("common_public.validate_gif_bytes", counted_walk))
    self.enter_context(patch("common_public.image_thumbnail_bytes", counted_render))
    return self

  def assert_outside_lock(self, case):
    case.assertFalse(any(locked for *_, locked in self.walks), "a GIF walk ran under the board lock")
    case.assertFalse(any(self.renders), "a poster rendered under the board lock")


def distinct_gifs():
  """Four different valid originals, each with its declared canvas."""
  return [(animation(), (24, 16)), (tiny_container(frames=2), (1, 1)),
          (tiny_container((3, 2), frames=3), (3, 2)),
          (with_metadata(tiny_container(), control(0x04, 3) * 3 + PLAIN_TEXT), (1, 1))]


class GifValidationOwnershipTests(unittest.TestCase):
  """Each distinct original is walked once, before the board lock, per request."""

  def member_client(self, root):
    store = CommonPublicStore(root)
    store.register("member.example", "member", "")
    key = _peer(Path(root), "member.example")
    client = self.enterContext(TestClient(community_host.create_app(root)))
    body = {"v": 0, "from": "member.example", "sent_at": time.time()}
    return store, key, client, body

  def test_public_gallery_walks_each_distinct_original_once_outside_the_lock(self):
    root = self.enterContext(tempfile.TemporaryDirectory())
    store, key, client, body = self.member_client(root)
    gifs = distinct_gifs()
    gallery = [wire(data, size) for data, size in gifs]
    post_id = str(uuid.uuid4())
    post = {**body, "id": post_id, "type": "board_post", "text": "Gallery",
            "attachments": gallery, "attachment": gallery[0]}
    with MediaWorkLedger() as ledger:
      response = client.post("/api/common/board", json=_signed(key, post))
    self.assertEqual(response.status_code, 200, response.text)
    # Previously 13: the compatibility copy, the gallery, the store and posters.
    self.assertEqual(sorted(walk[:2] for walk in ledger.walks),
                     sorted((data[:64], len(data)) for data, _ in gifs))
    self.assertEqual(len(ledger.renders), 4)
    ledger.assert_outside_lock(self)
    for index, (data, _) in enumerate(gifs):
      self.assertEqual(store.board_image(post_id, index)[0].read_bytes(), data)
      poster = store.board_thumbnail_dir() / f"{post_id}-{index}.webp"
      self.assertEqual(poster.read_bytes(), image_thumbnail_bytes(data)[1])
    with MediaWorkLedger() as ledger:
      retried = client.post("/api/common/board", json=_signed(key, post))
    self.assertEqual(retried.status_code, 200, retried.text)
    self.assertEqual((len(ledger.walks), ledger.renders), (4, []))  # Checked, never re-rendered.
    ledger.assert_outside_lock(self)

  def test_public_reply_walks_once_and_retries_settle_before_media_work(self):
    root = self.enterContext(tempfile.TemporaryDirectory())
    store, key, client, body = self.member_client(root)
    post_id, reply_id = str(uuid.uuid4()), str(uuid.uuid4())
    store.store_post({"id": post_id, "host": "member.example", "text": "Post",
                      "created_at": 1, "replies": []})
    data = animation()
    reply = {**body, "id": reply_id, "post_id": post_id, "type": "board_reply",
             "text": "Reply", "attachment": wire(data)}
    with MediaWorkLedger() as ledger:
      response = client.post("/api/common/board/reply", json=_signed(key, reply))
    self.assertEqual(response.status_code, 200, response.text)
    self.assertEqual((len(ledger.walks), len(ledger.renders)), (1, 1))  # Previously 3 walks.
    ledger.assert_outside_lock(self)
    poster = store.reply_image(post_id, reply_id, thumbnail=True)[0]
    self.assertEqual(poster.read_bytes(), image_thumbnail_bytes(data)[1])
    self.assertEqual(store.reply_image(post_id, reply_id)[0].read_bytes(), data)
    with MediaWorkLedger() as ledger:
      retried = client.post("/api/common/board/reply", json=_signed(key, reply))
      changed = client.post("/api/common/board/reply", json=_signed(key, {**reply, "text": "Other"}))
    self.assertEqual((retried.status_code, retried.json()["reply_count"], changed.status_code), (200, 1, 409))
    # Only the wire check of each request; neither retry nor conflict renders.
    self.assertEqual((len(ledger.walks), ledger.renders), (2, []))

  def test_direct_store_callers_get_one_full_check_per_original(self):
    root = self.enterContext(tempfile.TemporaryDirectory())
    store = CommonPublicStore(root)
    gifs = distinct_gifs()
    plain = [(wire(data, size), data) for data, size in gifs]
    with MediaWorkLedger() as ledger:
      self.assertTrue(store.store_post({"id": "abcdef12", "host": "member.example", "text": "",
                                        "created_at": 1, "replies": []}, attachments=plain))
      store.add_reply("abcdef12", "abcdef34", "member.example", "member", "Reply", 2, plain[0])
    self.assertEqual(len(ledger.walks), 5)  # Previously 8 + 2: check, then poster.
    ledger.assert_outside_lock(self)
    self.assertEqual([store.board_image("abcdef12", i)[0].read_bytes() for i in range(4)],
                     [data for data, _ in gifs])
    self.assertEqual(store.reply_image("abcdef12", "abcdef34")[0].read_bytes(), gifs[0][0])

  def test_a_check_is_reused_only_for_the_unchanged_wire_it_proved(self):
    root = self.enterContext(tempfile.TemporaryDirectory())
    store = CommonPublicStore(root)
    data = animation()
    checked = common_protocol.validate_attachment(wire(data))
    self.assertIsInstance(checked, tuple)
    self.assertEqual(checked, (checked[0], data))
    with self.assertRaises(HTTPException):  # Constructing one is the check.
      common_protocol.CheckedAttachment(wire(data[:-1]), data[:-1])
    store.store_post({"id": "abcdef20", "host": "member.example", "text": "Post",
                      "created_at": 1, "replies": []})
    checked[0]["w"] = 23  # Edited after its check: checked again, and rejected.
    for store_media in (
      lambda: store.store_post({"id": "abcdef12", "host": "member.example", "text": "",
                                "created_at": 1, "replies": []}, checked),
      lambda: store.add_reply("abcdef20", "abcdef34", "member.example", "member", "R", 2, checked),
    ):
      with self.assertRaises(HTTPException) as caught:
        store_media()
      self.assertEqual(caught.exception.status_code, 400)
    self.assertEqual(list(store.board_media_dir().iterdir()), [])
    self.assertFalse((store.board_dir() / "abcdef12.json").exists())
    self.assertEqual(store.get_replies("abcdef20")["replies"], [])
    self.assertFalse((store.reply_media_dir() / "abcdef20").exists())
    # False static MIME still meets the GIF check, reused or not.
    with self.assertRaises(HTTPException):
      store.store_post({"id": "abcdef13", "host": "member.example", "text": "",
                        "created_at": 1, "replies": []}, ({**wire(data), "mime": "image/png"}, data))

  def test_standalone_backfill_still_fully_checks_stored_bytes(self):
    root = self.enterContext(tempfile.TemporaryDirectory())
    store = CommonPublicStore(root)
    data = animation()
    store.store_post({"id": "abcdef12", "host": "member.example", "text": "",
                      "created_at": 1, "replies": []}, common_protocol.validate_attachment(wire(data)))
    poster = store.board_thumbnail_dir() / "abcdef12-0.webp"
    expected = poster.read_bytes()
    poster.unlink()
    with MediaWorkLedger() as ledger:
      self.assertEqual(store.board_thumbnail("abcdef12")[0].read_bytes(), expected)
    self.assertEqual(len(ledger.walks), 1)

  def test_mismatched_compatibility_copy_is_rejected_without_media_or_records(self):
    root = self.enterContext(tempfile.TemporaryDirectory())
    store, key, client, body = self.member_client(root)
    gifs = distinct_gifs()
    gallery = [wire(data, size) for data, size in gifs[:2]]
    post = {**body, "id": str(uuid.uuid4()), "type": "board_post", "text": "",
            "attachments": gallery, "attachment": gallery[1]}
    response = client.post("/api/common/board", json=_signed(key, post))
    self.assertEqual((response.status_code, response.json()["detail"]),
                     (400, "First post image does not match its gallery copy."))
    self.assertEqual(list(store.board_media_dir().iterdir()), [])
    self.assertEqual(list(store.board_dir().glob("*.json")), [])


class CommunityGifTests(unittest.TestCase):
  def test_public_media_decoding_requires_signed_named_membership(self):
    with tempfile.TemporaryDirectory() as root:
      store = CommonPublicStore(root)
      store.register("member.example", "member", "")
      member_key = _peer(Path(root), "member.example")
      outsider_key = _peer(Path(root), "outsider.example")
      post_id = str(uuid.uuid4())
      store.store_post({"id": post_id, "host": "member.example", "text": "Post",
                        "created_at": time.time(), "replies": []})
      with TestClient(community_host.create_app(root)) as client:
        for kind, path in (("board_post", "/api/common/board"),
                           ("board_reply", "/api/common/board/reply")):
          body = {"v": 0, "type": kind, "from": "member.example", "id": str(uuid.uuid4()),
                  "post_id": post_id, "text": "Caption", "sent_at": time.time(),
                  "attachment": wire(animation())}
          if kind == "board_post":
            body["attachments"] = [body["attachment"]]
          invalid_signature = _signed(member_key, body)
          invalid_signature["text"] = "Tampered caption"
          outsider = _signed(outsider_key, {**body, "from": "outsider.example"})
          for rejected in (body, invalid_signature, outsider):
            with self.subTest(kind=kind, sender=rejected["from"], signed="sig" in rejected), \
                 patch("common_protocol.validate_gif_bytes",
                       wraps=common_protocol.validate_gif_bytes) as decoded:
              response = client.post(path, json=rejected)
              self.assertIn(response.status_code, (400, 401, 403), response.text)
              self.assertEqual(decoded.call_count, 0)
        self.assertEqual(store.get_replies(post_id)["replies"], [])
        self.assertEqual(list(store.board_media_dir().iterdir()), [])

  def test_failed_reply_commit_cannot_reuse_a_different_gif_original_or_poster(self):
    from common_public import atomic_write

    for poster_fails in (False, True):
      with self.subTest(poster_fails=poster_fails), tempfile.TemporaryDirectory() as root:
        store = CommonPublicStore(root)
        store.store_post({"id": "abcdef12", "host": "member.example", "text": "Post",
                          "created_at": 1, "replies": []})
        old = animation()
        new = tiny_container((24, 16))
        post_path = store.board_dir() / "abcdef12.json"

        def fail_commit(path, content):
          if path == post_path:
            raise OSError("reply JSON commit failed")
          return atomic_write(path, content)

        args = ("abcdef12", "abcdef34", "member.example", "member", "Caption", 2)
        with patch("common_public.atomic_write", side_effect=fail_commit):
          with self.assertRaises(OSError):
            store.add_reply(*args, (wire(old), old))
        old_poster = store.reply_thumbnail_dir() / "abcdef12" / "abcdef34.webp"
        self.assertTrue(old_poster.exists())
        self.assertEqual(store.get_replies("abcdef12")["replies"], [])
        if poster_fails:
          with patch("common_public.image_thumbnail_bytes", side_effect=OSError("poster failed")):
            store.add_reply(*args, (wire(new), new))
          self.assertFalse(old_poster.exists())
        else:
          store.add_reply(*args, (wire(new), new))
        self.assertEqual(store.reply_image("abcdef12", "abcdef34")[0].read_bytes(), new)
        poster = store.reply_image("abcdef12", "abcdef34", thumbnail=True)
        self.assertEqual(poster[0].read_bytes(), image_thumbnail_bytes(new)[1])
        self.assertNotEqual(poster[0].read_bytes(), image_thumbnail_bytes(old)[1])
        result = store.add_reply(*args, (wire(new), new))
        self.assertFalse(result["activity"])
        self.assertEqual(result["reply_count"], 1)

  def test_signed_post_reply_caption_retry_original_poster_recovery_and_deletion(self):
    with tempfile.TemporaryDirectory() as root:
      store = CommonPublicStore(root)
      store.register("member.example", "member", "")
      key = _peer(Path(root), "member.example")
      post_id, reply_id = str(uuid.uuid4()), str(uuid.uuid4())
      data = animation()
      body = {"v": 0, "from": "member.example", "sent_at": time.time(),
              "id": post_id, "type": "board_post", "text": "Post caption",
              "attachment": wire(data)}
      reply = {**body, "id": reply_id, "post_id": post_id,
               "type": "board_reply", "text": "Reply caption"}
      with TestClient(community_host.create_app(root)) as client:
        self.assertTrue(client.get("/api/common/board").json()["capabilities"]["gif_attachments"])
        for _ in range(2):
          response = client.post("/api/common/board", json=_signed(key, body))
          self.assertEqual(response.status_code, 200, response.text)
        # A transient poster failure never damages the committed original.
        with patch("common_public.image_thumbnail_bytes", side_effect=OSError("encoder failed")):
          response = client.post("/api/common/board/reply", json=_signed(key, reply))
        self.assertEqual(response.status_code, 200, response.text)
        response = client.post("/api/common/board/reply", json=_signed(key, reply))
        self.assertEqual(response.json()["reply_count"], 1)
        saved_post = client.get("/api/common/board").json()["posts"][0]
        self.assertEqual(saved_post["text"], "Post caption")
        saved_reply = store.get_replies(post_id)["replies"][0]
        self.assertEqual(saved_reply["text"], "Reply caption")
        changed = client.post("/api/common/board/reply", json=_signed(key, {**reply, "text": "Changed"}))
        self.assertEqual(changed.status_code, 409)
        base = f"/api/common/board/{post_id}/replies/{reply_id}/"
        for path in (f"/api/common/board/media/{post_id}.gif", base + "media.gif", base + "media"):
          response = client.get(path)
          self.assertEqual(response.status_code, 200, response.text)
          self.assertEqual(response.headers["content-type"], "image/gif")
          self.assertEqual(response.content, data)
          with Image.open(io.BytesIO(response.content)) as image:
            self.assertEqual(image.n_frames, 2)
            self.assertEqual(image.info["loop"], 3)
            self.assertEqual(image.info["transparency"], 0)
            for index, duration, disposal in ((0, 80, 2), (1, 170, 3)):
              image.seek(index)
              self.assertEqual(image.info["duration"], duration)
              self.assertEqual(image.disposal_method, disposal)
        thumb = store.reply_thumbnail_dir() / post_id / f"{reply_id}.webp"
        self.assertFalse(thumb.exists())
        for path in (f"/api/common/board/thumbnail/{post_id}.webp", base + "thumbnail.webp"):
          response = client.get(path)
          self.assertEqual(response.status_code, 200, response.text)
          self.assertEqual(response.content, image_thumbnail_bytes(data)[1])
        self.assertTrue(thumb.exists())
        thumb.unlink()
        store.delete_post(post_id, "member.example")
        # Even an orphan original cannot resurrect a deleted reply's poster.
        orphan = store.reply_media_dir() / post_id / f"{reply_id}.gif"
        orphan.parent.mkdir(parents=True, exist_ok=True)
        orphan.write_bytes(data)
        self.assertEqual(client.get(base + "media.gif").status_code, 404)
        self.assertEqual(client.get(base + "thumbnail.webp").status_code, 404)
        self.assertEqual(client.get(f"/api/common/board/media/{post_id}.gif").status_code, 404)
        self.assertFalse(thumb.exists())

  def test_invalid_signed_post_reply_and_gallery_leave_no_media_or_records(self):
    with tempfile.TemporaryDirectory() as root:
      store = CommonPublicStore(root)
      store.register("member.example", "member", "")
      key = _peer(Path(root), "member.example")
      post_id = str(uuid.uuid4())
      store.store_post({"id": post_id, "host": "member.example", "text": "Post",
                        "created_at": time.time(), "replies": []})
      with TestClient(community_host.create_app(root)) as client:
        for value, status in invalid_gifs():
          for kind, path in (("board_post", "/api/common/board"),
                             ("board_reply", "/api/common/board/reply")):
            identity = str(uuid.uuid4())
            body = {"v": 0, "type": kind, "from": "member.example", "id": identity,
                    "post_id": post_id, "text": "Caption", "sent_at": time.time(),
                    "attachment": value}
            with self.subTest(kind=kind, status=status):
              response = client.post(path, json=_signed(key, body))
              self.assertEqual(response.status_code, status, response.text)
              self.assertIn("detail", response.json())
              self.assertFalse((store.board_dir() / f"{identity}.json").exists())
          body.pop("attachment")
          body.update(type="board_post", id=str(uuid.uuid4()),
                      attachments=[wire(animation()), value])
          self.assertEqual(client.post("/api/common/board", json=_signed(key, body)).status_code, status)
        self.assertEqual(store.get_replies(post_id)["replies"], [])
        for directory in (store.board_media_dir(), store.board_thumbnail_dir(),
                          store.reply_media_dir(), store.reply_thumbnail_dir()):
          self.assertEqual(list(directory.rglob("*")), [])

  def test_direct_store_gif_guards_precede_files_and_records(self):
    with tempfile.TemporaryDirectory() as root:
      store = CommonPublicStore(root)
      post = {"id": "abcdef12", "host": "member.example", "text": "Post", "created_at": 1}
      data = tiny_container()[:-1]
      with self.assertRaises(HTTPException):
        store.store_post(post, (wire(data, (1, 1)), data))
      self.assertFalse((store.board_dir() / "abcdef12.json").exists())
      store.store_post(post)
      with self.assertRaises(HTTPException):
        store.add_reply("abcdef12", "abcdef34", "member.example", "member", "Reply", 2,
                        (wire(data, (1, 1)), data))
      self.assertEqual(store.get_replies("abcdef12")["replies"], [])
      self.assertEqual(list(store.board_media_dir().rglob("*")), [])
      self.assertEqual(list(store.reply_media_dir().rglob("*")), [])

  def test_direct_store_rejects_gif_bytes_mislabeled_as_a_static_image(self):
    for mime in ("image/png", "image/jpeg", "image/webp"):
      with self.subTest(mime=mime), tempfile.TemporaryDirectory() as root:
        store = CommonPublicStore(root)
        data = tiny_container(frames=301)
        metadata = {**wire(data, (1, 1)), "mime": mime}
        with self.assertRaises(HTTPException) as caught:
          store.store_post({"id": "abcdef12", "host": "member.example",
                            "text": "Caption", "created_at": 1}, (metadata, data))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertFalse((store.board_dir() / "abcdef12.json").exists())
        self.assertEqual(list(store.board_media_dir().rglob("*")), [])


class DecryptedMessageAdmissionTests(unittest.IsolatedAsyncioTestCase):
  """Authenticated DM plaintext passes the shared JSON structure admission."""

  def setUp(self):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
    root = self.enterContext(tempfile.TemporaryDirectory())
    self.enterContext(patch.dict(os.environ, {
      "APP_STORAGE_DIR": root, "APP_ID": "7", "APP_SLUG": "social",
    }))
    import social_routes
    self.routes = social_routes
    recipient = X25519PrivateKey.generate()
    self.private = base64.b64encode(recipient.private_bytes(
      serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
      serialization.NoEncryption())).decode()
    self.public = base64.b64encode(recipient.public_key().public_bytes(
      serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()

  def seal(self, plaintext, message_id="abcdef12"):
    """Use the real sealing path, substituting only the plaintext bytes."""
    with patch.object(self.routes, "_canonical", return_value=plaintext):
      return self.routes._seal_dm(message_id, self.public, text="", attachment=None, reply_to=None)

  def assert_generic_failure(self, message_id, sealed, private=None):
    with self.assertRaises(HTTPException) as caught:
      self.routes._open_dm(message_id, sealed, private or self.private)
    self.assertEqual(caught.exception.status_code, 400)
    self.assertEqual(caught.exception.detail, "Message could not be decrypted.")
    return caught.exception

  def assert_predecode_rejected(self, plaintext):
    sealed = self.seal(plaintext)
    with patch.object(json, "loads") as decoded:
      failure = self.assert_generic_failure("abcdef12", sealed)
      decoded.assert_not_called()
    # The generic wire failure is caused by the shared structure budget.
    self.assertIsInstance(failure.__cause__, HTTPException)
    self.assertEqual(failure.__cause__.status_code, 413)

  def test_dense_decrypted_containers_reject_before_decode_with_bounded_memory(self):
    plaintext = b'{"attachment":null,"reply_to":null,"text":[' + b'[],' * 699999 + b'[]]}'
    sealed = self.seal(plaintext)
    tracemalloc.start()
    try:
      with patch.object(json, "loads") as decoded:
        failure = self.assert_generic_failure("abcdef12", sealed)
        decoded.assert_not_called()
      _, peak = tracemalloc.get_traced_memory()
    finally:
      tracemalloc.stop()
    self.assertEqual(failure.__cause__.status_code, 413)
    # Ciphertext decode, decryption and source decoding only (about 6.3 MB);
    # the unguarded json.loads(plaintext) returned 700k lists, peaking at 51.4 MB,
    # before late text rejection.
    self.assertLess(peak, 4 * len(plaintext) + 2 * 1024 * 1024)

  def test_entries_duplicates_depth_and_escaping_follow_the_shared_contract(self):
    base = b'{"attachment":null,"reply_to":null,'
    for element in (b'[]', b'{}', b'0', b'true', b'null', b'"x"'):
      with self.subTest(element=element):
        self.assert_predecode_rejected(base + b'"text":[' + (element + b',') * 33000 + element + b']}')
    # Duplicates collapse to the exact three keys yet still spend the budget.
    self.assert_predecode_rejected(base + b'"text":"",' * 17000 + b'"text":"x"}')
    # Root object is depth one: depth 64 is admitted, 65 rejects before decode.
    limit = common_protocol.MAX_ENVELOPE_DEPTH
    nested = lambda depth: base + b'"text":' + b'[' * (depth - 1) + b'0' + b']' * (depth - 1) + b'}'
    opened = self.routes._open_dm("abcdef12", self.seal(nested(limit)), self.private)
    self.assertEqual(set(opened), {"text", "attachment", "reply_to"})
    self.assert_predecode_rejected(nested(limit + 1))
    # Inclusive token boundary: nine wrapper punctuation characters plus N-1 commas.
    count = common_protocol.MAX_ENVELOPE_STRUCTURE_TOKENS - 8
    exact = base + b'"text":[' + b'0,' * (count - 1) + b'0]}'
    self.assertEqual(len(self.routes._open_dm("abcdef12", self.seal(exact), self.private)["text"]), count)
    self.assert_predecode_rejected(exact[:-2] + b',0]}')
    # Structural characters and escapes inside strings are not structure.
    text = '[]{}:,\\"' * 4000 + '🪐é\n'
    value = {"text": text, "attachment": None, "reply_to": None}
    for ensure_ascii in (True, False):
      source = json.dumps(value, ensure_ascii=ensure_ascii).replace('/', '\\/')
      for encoding in ("utf-8", "utf-8-sig", "utf-16", "utf-16-le", "utf-16-be",
                       "utf-32", "utf-32-le", "utf-32-be"):
        with self.subTest(ensure_ascii=ensure_ascii, encoding=encoding):
          self.assertEqual(self.routes._open_dm(
            "abcdef12", self.seal(source.encode(encoding)), self.private), value)

  def test_malformed_plaintext_keys_and_ciphertext_still_fail_generically(self):
    valid = common_protocol.canonical({"text": "hi", "attachment": None, "reply_to": None})
    # Stdlib json.loads(bytes) stays authoritative for grammar and encodings.
    for plaintext in (b'', b'{', b'{"text":}', b'{"text":"\xff","attachment":null,"reply_to":null}',
                      b'{"text":"\\q","attachment":null,"reply_to":null}', b'[]', b'null',
                      b'{"text":"x","attachment":null}', valid[:-1] + b',"extra":1}', valid + b' {}',
                      b'{"attachment":null,"reply_to":null,"text":[' + b'[],' * 12000 + b'bad JSON'):
      with self.subTest(plaintext=plaintext[:40]):
        self.assert_generic_failure("abcdef12", self.seal(plaintext))
    sealed = self.seal(valid)
    self.assertEqual(self.routes._open_dm("abcdef12", sealed, self.private)["text"], "hi")
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
    other = base64.b64encode(X25519PrivateKey.generate().private_bytes(
      serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
      serialization.NoEncryption())).decode()
    ciphertext = bytearray(base64.b64decode(sealed["ct_b64"]))
    ciphertext[0] ^= 1
    with patch.object(json, "loads") as decoded:
      self.assert_generic_failure("abcdef12", sealed, other)
      self.assert_generic_failure("abcdef34", sealed)  # message id is the AAD
      self.assert_generic_failure("abcdef12", {**sealed, "ct_b64": base64.b64encode(bytes(ciphertext)).decode()})
      self.assert_generic_failure("abcdef12", {**sealed, "ct_b64": "!"})
      self.assert_generic_failure("abcdef12", {**sealed, "v": 2})
      self.assert_generic_failure("abcdef12", {**sealed, "extra": 1})
      decoded.assert_not_called()

  def test_maximum_gif_text_and_quoted_reply_roundtrip_exactly(self):
    data = padded_gif(common_protocol.MAX_ATTACHMENT_BYTES, padding=b'\xff')
    attachment = wire(data, (1, 1))
    reply_to = {"id": "abcdef56", "author_handle": "a" * common_protocol.MAX_REPLY_AUTHOR_CHARS,
                "excerpt": "[]{}:,\\\"🪐" * 14}
    text = '🪐' * common_protocol.MAX_MESSAGE_TEXT_CHARS
    sealed = self.routes._seal_dm("abcdef12", self.public, text=text,
                                  attachment=attachment, reply_to=reply_to)
    # Sealed wire bytes still carry the frozen canonical plaintext.
    key = common_protocol.new_signing_key()
    envelope = {"v": 0, "type": "message", "id": "abcdef12", "from": "a.example",
                "to": "b.example", "text": "", "sent_at": time.time(), "enc": sealed}
    envelope["sig"] = common_protocol.sign(envelope, key)
    common_protocol.validate_attachment_envelope_size(envelope)
    self.assertTrue(common_protocol.verify(
      {k: v for k, v in envelope.items() if k != "sig"}, envelope["sig"],
      common_protocol.signing_public_key(key)))
    with patch.object(json, "loads", wraps=json.loads) as decoded:
      opened = self.routes._open_dm("abcdef12", sealed, self.private)
      self.assertEqual(decoded.call_count, 1)
    self.assertEqual(opened, {"text": text, "attachment": attachment, "reply_to": reply_to})
    self.assertEqual(common_protocol.validate_attachment(opened["attachment"])[1], data)
    self.assertEqual(common_protocol.validate_reply_to(opened["reply_to"]), reply_to)
    common_protocol.validate_text_or_attachment(opened["text"], None, "invalid")
    # A sender may legally escape every base64 slash; the original is unchanged.
    escaped = common_protocol.canonical(opened).replace(b'/', b'\\/')
    self.assertGreater(escaped.count(b'\\/'), 20 * 1024 * 1024)
    del opened
    reopened = self.routes._open_dm("abcdef12", self.seal(escaped), self.private)
    self.assertEqual(common_protocol.validate_attachment(reopened["attachment"])[1], data)

  async def test_receive_route_verifies_signature_before_bounded_decryption(self):
    plaintext = b'{"attachment":null,"reply_to":null,"text":[' + b'[],' * 699999 + b'[]]}'
    envelope = {"v": 0, "type": "message", "from": "peer.example", "to": "self.example",
                "id": "abcdef12", "sent_at": 1, "enc": self.seal(plaintext)}
    routes = self.routes
    with (patch.object(routes, "_joined_for_federation", return_value=True),
          patch.object(routes, "_own_host", return_value="self.example"),
          patch.object(routes, "_read_envelope", new=AsyncMock(return_value=envelope)),
          patch.object(routes, "_load_identity", return_value={"enc_private_key_b64": self.private}),
          patch.object(routes, "_common_app") as stored):
      unsigned = HTTPException(status_code=401, detail="Signature is invalid.")
      with patch.object(routes, "_verify_peer_envelope", new=AsyncMock(side_effect=unsigned)), \
           patch.object(routes, "_open_dm", wraps=routes._open_dm) as opened:
        with self.assertRaises(HTTPException) as caught:
          await routes.receive_message(None, db=None)
        self.assertEqual(caught.exception.status_code, 401)
        opened.assert_not_called()
      with patch.object(routes, "_verify_peer_envelope", new=AsyncMock(return_value={"handle": "peer"})), \
           patch.object(json, "loads") as decoded:
        with self.assertRaises(HTTPException) as caught:
          await routes.receive_message(None, db=None)
        self.assertEqual((caught.exception.status_code, caught.exception.detail),
                         (400, "Message could not be decrypted."))
        decoded.assert_not_called()
      stored.assert_not_called()


class LoadsBoundedJsonTests(unittest.TestCase):
  def test_matches_stdlib_bytes_decoding_and_rejects_structure_first(self):
    corpus = [b'{"x":NaN}', b'{"a":1,"a":2}', b'\xef\xbb\xbf{"x":[]}', b'"\\ud800"',
              '{"x":"\ud800"}'.encode("utf-16-le", "surrogatepass"), '{"🪐":[1]}'.encode("utf-32"),
              b'', b'{', b'{"x":"\xff"}', b'{"x":01}', b'{} {}', b'\xff\xfe\x00']
    for raw in corpus:
      with self.subTest(raw=raw):
        try:
          expected = ("ok", json.loads(raw))
        except Exception as exc:
          expected = ("error", type(exc))
        try:
          actual = ("ok", common_protocol.loads_bounded_json(raw))
        except Exception as exc:
          actual = ("error", type(exc))
        self.assertEqual(repr(actual), repr(expected))
    with patch.object(json, "loads") as decoded, self.assertRaises(HTTPException) as caught:
      common_protocol.loads_bounded_json(b'[' + b'0,' * 40000 + b'0]')
    self.assertEqual(caught.exception.status_code, 413)
    decoded.assert_not_called()


class MessageGifSeamTests(unittest.IsolatedAsyncioTestCase):
  async def test_dm_and_group_canonical_seam_rejects_before_outbound_persistence(self):
    with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {
      "APP_STORAGE_DIR": root, "APP_ID": "7", "APP_SLUG": "social",
    }):
      import social_routes
      import social_groups
      from service_runtime import Principal
      app = SimpleNamespace(id=7, slug="social")
      self.assertIs(social_routes._validate_attachment, common_protocol.validate_attachment)
      self.assertIs(social_groups._validate_attachment, common_protocol.validate_attachment)
      data = animation()
      for validator in (social_routes._validate_attachment, social_groups._validate_attachment):
        self.assertEqual(validator(wire(data))[1], data)
      malformed = wire(data[:-1])
      with (patch.object(social_routes, "_require_member", return_value=app),
            patch.object(social_groups, "_require_member", return_value=app),
            patch.object(social_routes, "_persist_outgoing_message", new=AsyncMock()) as dm_store,
            patch.object(social_routes, "_prepare_outgoing_conversation", new=AsyncMock()) as consent,
            patch.object(social_groups, "_store_group_message", new=AsyncMock()) as group_store,
            patch.object(social_groups, "_host_commit_post", new=AsyncMock()) as group_commit):
        owner = Principal("owner", None, None)
        with self.assertRaises(HTTPException) as caught:
          await social_routes.send_message(social_routes.SendMessage(
            to="peer.example", text="Caption", attachment=malformed), db=None, principal=owner)
        self.assertEqual(caught.exception.status_code, 400)
        with self.assertRaises(HTTPException) as caught:
          await social_groups.send_group_message("abcdef12", social_groups.GroupSend(
            text="Caption", attachment=malformed), db=None, principal=owner)
        self.assertEqual(caught.exception.status_code, 400)
        dm_store.assert_not_called()
        consent.assert_not_called()
        group_store.assert_not_called()
        group_commit.assert_not_called()

  async def test_dm_plain_encrypted_and_group_post_relay_validate_before_inbound_storage(self):
    with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {
      "APP_STORAGE_DIR": root, "APP_ID": "7", "APP_SLUG": "social",
    }):
      import social_routes
      import social_groups
      app = SimpleNamespace(id=7, slug="social")
      malformed = wire(animation()[:-1])
      body = {"v": 0, "type": "message", "from": "peer.example", "to": "self.example",
              "id": "abcdef34", "text": "Caption", "sent_at": 1, "attachment": malformed}
      with (patch.object(social_routes, "_joined_for_federation", return_value=True),
            patch.object(social_routes, "_own_host", return_value="self.example"),
            patch.object(social_routes, "_verify_peer_envelope", new=AsyncMock(return_value={"handle": "peer"})),
            patch.object(social_routes, "_common_app") as dm_app,
            patch.object(social_routes, "_load_identity", return_value={"enc_private_key_b64": "unused"}),
            patch.object(social_routes, "_open_dm", return_value=body),
            patch.object(social_groups, "_host_commit_post", new=AsyncMock()) as commit,
            patch.object(social_groups, "_store_group_message", new=AsyncMock()) as store,
            patch.object(social_groups, "_load_group_meta", return_value={"host": "peer.example"}),
            patch.object(social_groups, "_verify_peer_envelope", new=AsyncMock(return_value={"handle": "peer"}))):
        for encrypted in (False, True):
          envelope = {**body, "enc": {}} if encrypted else body
          with patch.object(social_routes, "_read_envelope", new=AsyncMock(return_value=envelope)):
            with self.assertRaises(HTTPException) as caught:
              await social_routes.receive_message(None, db=None)
          self.assertEqual(caught.exception.status_code, 400)
        original = {**body, "type": "group_post", "gid": "abcdef12", "to": "peer.example"}
        relay = {**original, "type": "group_message", "original": original}
        for envelope in (original, relay):
          with self.assertRaises(HTTPException) as caught:
            await social_groups._accept_group_envelope(None, app, envelope, {"handle": "peer"})
          self.assertEqual(caught.exception.status_code, 400)
        dm_app.assert_not_called()
        commit.assert_not_called()
        store.assert_not_called()


class GeneratedPosterBudgetTests(unittest.TestCase):
  def test_high_detail_generated_poster_fits_media_download_budget(self):
    original = io.BytesIO()
    Image.frombytes('RGB', (640, 640), random.Random(1).randbytes(640 * 640 * 3)).save(original, format='PNG')
    mime, poster = image_thumbnail_bytes(original.getvalue())
    self.assertEqual(mime, 'image/webp')
    self.assertLessEqual(len(poster), common_protocol.MAX_THUMBNAIL_BYTES)
    with Image.open(io.BytesIO(poster)) as image:
      self.assertLessEqual(max(image.size), 640)
      image.load()


if __name__ == "__main__":
  unittest.main()
