"""The peer-avatar route must re-encode untrusted bytes and serve cache-first.

Structural guards so a future edit cannot silently drop the #21-grade
re-encode, the cache-before-federation ordering, or the nosniff header. The
image validation itself is exercised by test_public_store's thumbnail tests,
which this route reuses at an avatar-sized cap.
"""

import inspect
import os
import tempfile
import unittest
from unittest.mock import patch


class PeerAvatarHardeningTests(unittest.TestCase):
  def _social_routes(self):
    with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
      "APP_STORAGE_DIR": directory, "APP_ID": "7", "APP_SLUG": "social",
    }):
      import social_routes
    return social_routes

  def test_route_reencodes_untrusted_bytes(self):
    src = inspect.getsource(self._social_routes().get_peer_avatar)
    # Untrusted peer bytes go through the shared #21 guard (rejects SVG,
    # oversized dimensions and decompression bombs) before caching or serving.
    self.assertIn("image_thumbnail_bytes(raw, AVATAR_MAX_SIDE)", src)

  def test_route_serves_cache_before_any_federation(self):
    src = inspect.getsource(self._social_routes().get_peer_avatar)
    self.assertLess(src.index("cache.is_file()"), src.index("_fetch_actor"))

  def test_route_has_offline_negative_cache(self):
    src = inspect.getsource(self._social_routes().get_peer_avatar)
    self.assertIn("_peer_avatar_miss_path", src)
    self.assertIn("_mark_avatar_miss", src)

  def test_served_avatar_sets_nosniff(self):
    served = inspect.getsource(self._social_routes()._serve_avatar)
    self.assertIn("nosniff", served)


if __name__ == "__main__":
  unittest.main()
