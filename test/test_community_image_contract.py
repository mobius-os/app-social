import importlib.util
import io
import json
from pathlib import Path
import unittest
import urllib.error


MODULE_PATH = (
  Path(__file__).parents[1] / "deploy" / "community" / "verify_contract.py"
)
SPEC = importlib.util.spec_from_file_location("verify_contract", MODULE_PATH)
verify_contract = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify_contract)


class Response(io.BytesIO):
  def __init__(self, status, body):
    super().__init__(json.dumps(body).encode())
    self.status = status

  def __enter__(self):
    return self

  def __exit__(self, *_args):
    self.close()


def opener_with_version(version):
  def open_request(request, timeout):
    del timeout
    url = request if isinstance(request, str) else request.full_url
    if url.endswith("/healthz"):
      return Response(200, {"status": "ok"})
    if url.endswith("/version"):
      return Response(200, version)
    if url.endswith("/api/common/board?limit=1"):
      return Response(200, {"posts": []})
    if url.endswith("/api/common/board/delete"):
      raise urllib.error.HTTPError(
        url, 400, "bad request", {},
        Response(400, {"detail": "Unsupported envelope type."}),
      )
    raise AssertionError(f"unexpected URL: {url}")
  return open_request


class CommunityImageContractTests(unittest.TestCase):
  def test_expected_contract_passes(self):
    revision = "a" * 40
    verify_contract.verify(
      "http://candidate", revision,
      opener_with_version({"service": "mobius-social", "source_sha": revision}),
    )

  def test_wrong_reported_revision_fails(self):
    with self.assertRaises(AssertionError):
      verify_contract.verify(
        "http://candidate", "a" * 40,
        opener_with_version({"service": "mobius-social", "source_sha": "b" * 40}),
      )


if __name__ == "__main__":
  unittest.main()
