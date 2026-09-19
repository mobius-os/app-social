import os
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

import community_host


class CommunityHostTests(unittest.TestCase):
  def test_health_version_and_public_prefix_share_one_app(self):
    revision = "a" * 40
    with tempfile.TemporaryDirectory() as data_dir, patch.dict(
      os.environ, {"SOCIAL_SOURCE_SHA": revision}, clear=False,
    ):
      with TestClient(community_host.create_app(data_dir)) as client:
        self.assertEqual(client.get("/healthz").json(), {"status": "ok"})
        self.assertEqual(
          client.get("/version").json(),
          {"service": "mobius-social", "source_sha": revision},
        )
        self.assertEqual(client.get("/api/common/board").status_code, 200)
        self.assertEqual(client.get("/board").status_code, 404)
        # A malformed write proves the route exists without changing data.
        response = client.post("/api/common/board/delete", json={})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "Unsupported envelope type.")

  def test_invalid_baked_revision_fails_closed(self):
    with patch.dict(os.environ, {"SOCIAL_SOURCE_SHA": "main"}, clear=False):
      with self.assertRaisesRegex(RuntimeError, "40-character lowercase Git SHA"):
        community_host.create_app("/tmp")

  def test_data_directory_must_be_absolute(self):
    with self.assertRaisesRegex(RuntimeError, "must be an absolute path"):
      community_host.create_app("relative")


if __name__ == "__main__":
  unittest.main()
