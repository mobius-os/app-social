"""Security contracts for Social's app-owned federation transport."""

import gzip
import socket
import unittest
from unittest.mock import patch

import httpx
from fastapi import HTTPException

import common_transport


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
