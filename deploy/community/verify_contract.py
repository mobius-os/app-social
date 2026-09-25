"""Black-box contract checks streamed into a candidate Social container."""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request


def verify(base: str, expected_sha: str, opener=urllib.request.urlopen) -> None:
  def read(path: str):
    with opener(base + path, timeout=3) as response:
      return response.status, json.load(response)

  assert read("/healthz") == (200, {"status": "ok"})
  assert read("/version") == (
    200, {"service": "mobius-social", "source_sha": expected_sha},
  )
  status, board = read("/api/common/board?limit=1")
  assert status == 200 and isinstance(board, dict)
  assert isinstance(board.get("posts"), list)
  status, actor = read("/api/common/actor")
  assert status == 200 and actor["public_key"]["alg"] == "ed25519"

  request = urllib.request.Request(
    base + "/api/common/board/delete",
    data=b"{}",
    headers={"Content-Type": "application/json"},
    method="POST",
  )
  try:
    opener(request, timeout=3)
  except urllib.error.HTTPError as error:
    assert error.code == 400
    assert json.load(error)["detail"] == "Unsupported envelope type."
  else:
    raise AssertionError("malformed delete unexpectedly succeeded")


if __name__ == "__main__":
  verify("http://127.0.0.1:8080", sys.argv[1])
