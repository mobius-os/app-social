"""Peer board media is a bounded, regenerable cache."""

import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

with patch.dict(os.environ, {
  "APP_STORAGE_DIR": os.path.join(tempfile.gettempdir(), "social-board-media-cache-tests"),
  "APP_ID": "7", "APP_SLUG": "social",
}):
  import social_routes


def write(path: Path, size: int, age_s: float) -> Path:
  path.write_bytes(b"x" * size)
  stamp = time.time() - age_s
  os.utime(path, (stamp, stamp))
  return path


class BoardMediaEvictionTest(unittest.TestCase):
  def test_expired_originals_stay_cached_under_the_cap_for_offline_peers(self):
    # The TTL only schedules a refresh; an expired original is still what the
    # owner sees while its peer is offline, so age alone must never evict it.
    ttl = social_routes.BOARD_MEDIA_CACHE_TTL_S
    with tempfile.TemporaryDirectory() as directory:
      root = Path(directory)
      expired = write(root / "peer-post-0.png", 10, ttl * 5)
      thumb = write(root / "peer-post-0-thumb.webp", 10, ttl * 5)
      kept = write(root / "peer-post-2.png", 10, 0)
      social_routes._evict_peer_board_media(root, kept)
      self.assertTrue(expired.exists())
      self.assertTrue(thumb.exists())
      self.assertTrue(kept.exists())

  def test_byte_cap_evicts_originals_before_thumbnails_and_never_the_new_file(self):
    with tempfile.TemporaryDirectory() as directory, patch.object(
      social_routes, "BOARD_MEDIA_CACHE_MAX_BYTES", 25,
    ):
      root = Path(directory)
      old_thumb = write(root / "a-thumb.webp", 10, 300)
      recent_original = write(root / "b.png", 10, 100)
      kept = write(root / "c.png", 10, 0)
      social_routes._evict_peer_board_media(root, kept)
      self.assertTrue(old_thumb.exists())
      self.assertFalse(recent_original.exists())
      self.assertTrue(kept.exists())

  def test_byte_cap_evicts_least_recently_used_within_a_kind(self):
    with tempfile.TemporaryDirectory() as directory, patch.object(
      social_routes, "BOARD_MEDIA_CACHE_MAX_BYTES", 25,
    ):
      root = Path(directory)
      fetched_first = write(root / "a.png", 10, 300)
      fetched_later = write(root / "b.png", 10, 100)
      # A cache hit on the older fetch makes it the more recently used one.
      social_routes._mark_board_media_used(fetched_first)
      kept = write(root / "c.png", 10, 0)
      social_routes._evict_peer_board_media(root, kept)
      self.assertTrue(fetched_first.exists())
      self.assertFalse(fetched_later.exists())

  def test_marking_a_hit_keeps_the_fetch_time_that_drives_refresh(self):
    with tempfile.TemporaryDirectory() as directory:
      path = write(Path(directory) / "a.png", 10, 300)
      fetched = path.stat().st_mtime
      social_routes._mark_board_media_used(path)
      self.assertEqual(path.stat().st_mtime, fetched)
      self.assertGreater(path.stat().st_atime, fetched)


if __name__ == "__main__":
  unittest.main()
