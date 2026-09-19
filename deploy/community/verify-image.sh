#!/usr/bin/env bash
# Prove one immutable Social image boots and reports the expected Git source.
set -euo pipefail

IMAGE="${1:-}"
EXPECTED_SHA="${2:-}"
case "$EXPECTED_SHA" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) echo "usage: $0 <image> <40-character-source-sha>" >&2; exit 2 ;;
esac
[ -n "$IMAGE" ] || { echo "image is required" >&2; exit 2; }

revision="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE")"
source="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.source"}}' "$IMAGE")"
[ "$revision" = "$EXPECTED_SHA" ] || {
  echo "image revision $revision does not match expected $EXPECTED_SHA" >&2
  exit 1
}
[ "$source" = "https://github.com/mobius-os/app-social" ] || {
  echo "image source is not mobius-os/app-social: $source" >&2
  exit 1
}

name="mobius-social-verify-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d \
  --name "$name" \
  --read-only \
  --network none \
  --tmpfs /tmp:rw,nosuid,nodev,noexec \
  --tmpfs /data:rw,nosuid,nodev,noexec,uid=1000,gid=1000,mode=0700 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  "$IMAGE" >/dev/null

for _ in $(seq 1 30); do
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$name")"
  case "$health" in
    healthy) break ;;
    unhealthy)
      docker logs "$name" >&2
      echo "image health check failed" >&2
      exit 1
      ;;
  esac
  sleep 1
done
[ "${health:-}" = healthy ] || {
  docker logs "$name" >&2
  echo "image did not become healthy" >&2
  exit 1
}

docker exec "$name" python - "$EXPECTED_SHA" <<'PY'
import json
import sys
import urllib.error
import urllib.request

base = "http://127.0.0.1:8080"
expected = sys.argv[1]

def read(path):
  with urllib.request.urlopen(base + path, timeout=3) as response:
    return response.status, json.load(response)

assert read("/healthz") == (200, {"status": "ok"})
assert read("/version") == (
  200, {"service": "mobius-social", "source_sha": expected},
)
status, board = read("/api/common/board?limit=1")
assert status == 200 and isinstance(board, dict) and isinstance(board.get("posts"), list)

request = urllib.request.Request(
  base + "/api/common/board/delete",
  data=b"{}",
  headers={"Content-Type": "application/json"},
  method="POST",
)
try:
  urllib.request.urlopen(request, timeout=3)
except urllib.error.HTTPError as error:
  assert error.code == 400
  assert json.load(error)["detail"] == "Unsupported envelope type."
else:
  raise AssertionError("malformed delete unexpectedly succeeded")
PY

printf 'verified image=%s source_sha=%s\n' "$IMAGE" "$EXPECTED_SHA"
