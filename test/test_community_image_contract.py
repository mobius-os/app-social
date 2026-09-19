import importlib.util
import io
import json
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
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
  def test_packaged_runtime_can_resolve_and_reject_non_public_peer(self):
    repository = Path(__file__).parents[1]
    dockerfile = repository / "deploy" / "community" / "Dockerfile"
    copy_line = next(
      line for line in dockerfile.read_text().splitlines()
      if line.startswith("COPY ") and "community_host.py" in line
    )
    copy_command = shlex.split(copy_line)
    self.assertEqual(copy_command[-1], "./")

    with tempfile.TemporaryDirectory() as runtime_dir:
      for source in copy_command[1:-1]:
        shutil.copy2(repository / source, Path(runtime_dir) / Path(source).name)
      probe = subprocess.run(
        [
          sys.executable,
          "-c",
          """
import asyncio
from fastapi import HTTPException
import common_transport

try:
  asyncio.run(common_transport._resolve_url_safe("http://127.0.0.1/actor"))
except HTTPException as exc:
  assert exc.status_code == 400
else:
  raise AssertionError("packaged resolver accepted a non-public peer")
""",
        ],
        cwd=runtime_dir,
        capture_output=True,
        text=True,
      )
      self.assertEqual(probe.returncode, 0, probe.stderr)

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
