"""Security contracts for Social's app-owned federation transport."""

import asyncio
import base64
import gzip
import importlib
import os
import socket
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import HTTPException

import common_protocol
import common_transport
from common_protocol import ACTOR_FETCH_TIMEOUT_S, SIGNED_WRITE_TIMEOUT_S


REAL_ASYNC_CLIENT = httpx.AsyncClient
PUBLIC_IP = "93.184.216.34"


def resolve_to(address):
  calls = []

  def getaddrinfo(host, port, *_args, **_kwargs):
    calls.append((host, port))
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    sockaddr = (address, 0, 0, 0) if family == socket.AF_INET6 else (address, 0)
    return [(family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", sockaddr)]

  return calls, getaddrinfo


def client_factory(handler, options):
  def factory(**kwargs):
    options.append(kwargs.copy())
    return REAL_ASYNC_CLIENT(transport=httpx.MockTransport(handler), **kwargs)

  return factory


class FederationTransportTests(unittest.IsolatedAsyncioTestCase):
  async def test_deadline_includes_dns_validation(self):
    def slow_validation(_url):
      time.sleep(0.2)
      return ([f"https://{PUBLIC_IP}/actor"], "peer.example", "peer.example")

    started = time.monotonic()
    with patch.object(common_transport, "validate_url_safe", slow_validation):
      with self.assertRaises(httpx.TimeoutException) as raised:
        await common_transport.federation_request(
          "GET", "https://peer.example/actor", timeout_seconds=0.02,
        )

    self.assertLess(time.monotonic() - started, 0.15)
    self.assertEqual(str(raised.exception.request.url), "https://peer.example/actor")

  async def test_deadline_includes_complete_response_stream(self):
    class SlowStream(httpx.AsyncByteStream):
      async def __aiter__(self):
        yield b'{"status":'
        await asyncio.sleep(0.2)
        yield b'"ok"}'

      async def aclose(self):
        pass

    _calls, resolver = resolve_to(PUBLIC_IP)
    options = []

    def handler(_request):
      return httpx.Response(
        200,
        stream=SlowStream(),
        headers={"content-type": "application/json"},
      )

    with (
      patch("socket.getaddrinfo", resolver),
      patch.object(
        common_transport.httpx,
        "AsyncClient",
        client_factory(handler, options),
      ),
    ):
      with self.assertRaises(httpx.TimeoutException):
        await common_transport.federation_request(
          "GET", "https://peer.example/actor", timeout_seconds=0.02,
        )

  async def test_actor_fetch_uses_the_shorter_verification_budget(self):
    actor = {
      "protocol": "common/0",
      "host": "peer.example",
      "handle": "peer",
      "bio": "",
      "public_key": {
        "alg": "ed25519",
        "key_b64": base64.b64encode(b"k" * 32).decode("ascii"),
      },
    }
    request_url = "https://peer.example/api/app-services/social/actor"
    response = httpx.Response(
      200, json=actor, request=httpx.Request("GET", request_url),
    )
    with tempfile.TemporaryDirectory() as data_dir:
      verifier = common_protocol.ActorVerifier(data_dir)
      with patch.object(
        common_protocol, "federation_request",
        new=AsyncMock(return_value=response),
      ) as request:
        result = await verifier.fetch_actor("peer.example")
    self.assertEqual(result, actor)
    request.assert_awaited_once_with(
      "GET", request_url,
      max_response_bytes=common_protocol.MAX_ENVELOPE_BYTES,
      timeout_seconds=ACTOR_FETCH_TIMEOUT_S,
    )

  async def test_signed_write_budget_outlives_nested_actor_verification(self):
    self.assertGreater(SIGNED_WRITE_TIMEOUT_S, ACTOR_FETCH_TIMEOUT_S)
    self.assertLess(SIGNED_WRITE_TIMEOUT_S, 15.0)
    response = httpx.Response(200, json={"status": "ok"})
    with patch.object(
      common_protocol, "federation_request",
      new=AsyncMock(return_value=response),
    ) as request:
      result = await common_protocol.post_signed_envelope(
        "https://peer.example/api/app-services/social/board",
        {"sig": "signed"}, max_response_bytes=321,
      )
    self.assertIs(result, response)
    request.assert_awaited_once_with(
      "POST", "https://peer.example/api/app-services/social/board",
      json={"sig": "signed"}, max_response_bytes=321,
      timeout_seconds=SIGNED_WRITE_TIMEOUT_S,
    )

  def test_community_write_errors_distinguish_peer_failures(self):
    with tempfile.TemporaryDirectory() as storage:
      with patch.dict(os.environ, {
        "APP_STORAGE_DIR": storage,
        "APP_ID": "7",
        "APP_SLUG": "social",
        "APP_TOKEN": "test-app-token",
        "API_BASE_URL": "http://127.0.0.1:9",
        "INSTANCE_DOMAIN": "self.example",
        "INSTANCE_ORIGIN": "https://self.example",
      }):
        social_routes = importlib.import_module("social_routes")

    request = httpx.Request("POST", "https://peer.example/write")
    rejected = httpx.HTTPStatusError(
      "rejected", request=request, response=httpx.Response(409, request=request),
    )
    denied = httpx.HTTPStatusError(
      "denied", request=request, response=httpx.Response(403, request=request),
    )
    self.assertIn("rejected", social_routes._community_write_error(rejected, "reply"))
    self.assertIn("verify", social_routes._community_write_error(denied, "reply"))
    self.assertIn(
      "too long",
      social_routes._community_write_error(httpx.ReadTimeout("slow", request=request), "reply"),
    )
    self.assertIn(
      "invalid response",
      social_routes._community_write_error(
        common_transport.FederationTransportError("bad json"), "reply",
      ),
    )
    self.assertIn(
      "could not be reached",
      social_routes._community_write_error(
        httpx.ConnectError("offline", request=request), "reply",
      ),
    )
    self.assertIn(
      "Social could not complete",
      social_routes._community_write_error(RuntimeError("unexpected"), "reply"),
    )

  async def test_non_public_destinations_are_rejected_before_connect(self):
    for host, address in (
      ("127.0.0.1", "127.0.0.1"),
      ("private.example", "10.23.4.5"),
      ("metadata.example", "169.254.169.254"),
    ):
      with self.subTest(host=host):
        _calls, resolver = resolve_to(address)

        class MustNotConnect:
          def __init__(self, **_kwargs):
            raise AssertionError("unsafe destination reached the HTTP client")

        with (
          patch("socket.getaddrinfo", resolver),
          patch.object(common_transport.httpx, "AsyncClient", MustNotConnect),
        ):
          with self.assertRaises(HTTPException):
            await common_transport.federation_request(
              "GET", f"https://{host}/common/0/actor",
            )

  async def test_dns_rebinding_cannot_change_pinned_host_or_tls_name(self):
    dns_calls, resolver = resolve_to(PUBLIC_IP)
    requests = []
    options = []

    def handler(request):
      requests.append(request)
      return httpx.Response(200, json={"status": "ok"})

    with (
      patch("socket.getaddrinfo", resolver),
      patch.object(
        common_transport.httpx,
        "AsyncClient",
        client_factory(handler, options),
      ),
    ):
      response = await common_transport.federation_request(
        "GET", "https://peer.example/common/0/actor", params={"view": "full"},
      )

    self.assertEqual(response.json(), {"status": "ok"})
    self.assertEqual(dns_calls, [("peer.example", None)])
    self.assertEqual(len(requests), 1)
    self.assertEqual(requests[0].url.host, PUBLIC_IP)
    self.assertEqual(requests[0].url.params["view"], "full")
    self.assertEqual(requests[0].headers["host"], "peer.example")
    self.assertEqual(requests[0].extensions["sni_hostname"], "peer.example")
    self.assertFalse(options[0]["follow_redirects"])
    self.assertFalse(options[0]["trust_env"])
    self.assertEqual(options[0]["timeout"], 10.0)

  async def test_redirect_is_rejected_without_a_second_request(self):
    _calls, resolver = resolve_to(PUBLIC_IP)
    requests = []
    options = []

    def handler(request):
      requests.append(request)
      return httpx.Response(
        302, headers={"location": "http://169.254.169.254/latest/meta-data/"},
      )

    with (
      patch("socket.getaddrinfo", resolver),
      patch.object(
        common_transport.httpx,
        "AsyncClient",
        client_factory(handler, options),
      ),
    ):
      with self.assertRaises(common_transport.FederationTransportError):
        await common_transport.federation_request(
          "GET", "https://peer.example/common/0/actor",
        )
    self.assertEqual(len(requests), 1)

  async def test_invalid_json_responses_are_rejected(self):
    for content_type, body in (
      ("text/html", b"{}"),
      ("application/json", b"not-json"),
      ("application/json", b"[]"),
    ):
      with self.subTest(content_type=content_type, body=body):
        _calls, resolver = resolve_to(PUBLIC_IP)
        options = []

        def handler(_request):
          return httpx.Response(
            200, content=body, headers={"content-type": content_type},
          )

        with (
          patch("socket.getaddrinfo", resolver),
          patch.object(
            common_transport.httpx,
            "AsyncClient",
            client_factory(handler, options),
          ),
        ):
          with self.assertRaises(common_transport.FederationTransportError):
            await common_transport.federation_request(
              "GET", "https://peer.example/common/0/actor",
            )

  async def test_response_is_stopped_at_the_callers_byte_limit(self):
    _calls, resolver = resolve_to(PUBLIC_IP)
    options = []

    def handler(_request):
      return httpx.Response(
        200, content=b"x" * 9, headers={"content-type": "application/json"},
      )

    with (
      patch("socket.getaddrinfo", resolver),
      patch.object(
        common_transport.httpx,
        "AsyncClient",
        client_factory(handler, options),
      ),
    ):
      with self.assertRaises(common_transport.FederationTransportError):
        await common_transport.federation_request(
          "GET", "https://peer.example/common/0/actor", max_response_bytes=8,
        )

  async def test_binary_responses_skip_json_validation(self):
    _calls, resolver = resolve_to(PUBLIC_IP)
    options = []

    def handler(_request):
      return httpx.Response(
        200,
        content=b"archive",
        headers={"content-type": "application/octet-stream"},
      )

    with (
      patch("socket.getaddrinfo", resolver),
      patch.object(
        common_transport.httpx,
        "AsyncClient",
        client_factory(handler, options),
      ),
    ):
      response = await common_transport.federation_request(
        "GET", "https://peer.example/common/0/media", response_format="binary",
      )
    self.assertEqual(response.content, b"archive")

  async def test_compressed_response_is_decoded_once(self):
    _calls, resolver = resolve_to(PUBLIC_IP)
    options = []
    payload = b'{"status":"ok"}'
    compressed = gzip.compress(payload)

    def handler(_request):
      return httpx.Response(
        200,
        content=compressed,
        headers={
          "content-type": "application/json",
          "content-encoding": "gzip",
          "content-length": str(len(compressed)),
        },
      )

    with (
      patch("socket.getaddrinfo", resolver),
      patch.object(
        common_transport.httpx,
        "AsyncClient",
        client_factory(handler, options),
      ),
    ):
      response = await common_transport.federation_request(
        "GET", "https://peer.example/common/0/actor",
      )
    self.assertEqual(response.json(), {"status": "ok"})
    self.assertEqual(response.content, payload)
    self.assertNotIn("content-encoding", response.headers)
    self.assertEqual(int(response.headers["content-length"]), len(payload))


if __name__ == "__main__":
  unittest.main()
