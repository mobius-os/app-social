"""Scale and rollback contracts for Social's public board store."""

import asyncio
import base64
import io
import json
import os
import sqlite3
import struct
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import call, patch
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image

from common_protocol import validate_attachment
from common_public import (
  BOARD_INDEX_NORMALIZATION_VERSION,
  CommonPublicStore,
  create_public_router,
  image_thumbnail_bytes,
)


def forged_png_header(width=20000, height=20000):
  output = io.BytesIO()
  Image.new("RGB", (1, 1)).save(output, format="PNG")
  data = bytearray(output.getvalue())
  data[16:24] = struct.pack(">II", width, height)
  data[29:33] = struct.pack(">I", zlib.crc32(data[12:29]) & 0xffffffff)
  return bytes(data)


class PublicBoardIndexTests(unittest.TestCase):
  def _write_cursor_edge_records(self, store):
    records = [
      ("normal-top", {"id": "normal-top", "created_at": 5.0}),
      ("edge-string", {"id": "edge-string", "created_at": "4.0"}),
      ("edge-nan", {"id": "edge-nan", "created_at": float("nan")}),
      ("edge-missing", {"id": "edge-missing"}),
      ("edge-infinity", {"id": "edge-infinity", "created_at": float("inf")}),
      ("edge-huge", {"id": "edge-huge", "created_at": 10 ** 1000}),
      ("edge-bool", {"id": "edge-bool", "created_at": True}),
      ("normal-old", {"id": "normal-old", "created_at": -1.0}),
      ("missing-id", {"created_at": 4.0}),
      ("empty-id", {"id": "", "created_at": 4.0}),
      ("non-string-id", {"id": 123, "created_at": 4.0}),
      ("mismatched-id", {"id": "other-id", "created_at": 4.0}),
    ]
    for filename, fields in records:
      (store.board_dir() / f"{filename}.json").write_text(json.dumps({
        "host": "author.example", "text": filename, "replies": [], **fields,
      }))

  def _collect_cursor_pages(self, store, *, force_file_fallback=False):
    app = FastAPI()
    router, _ = create_public_router(store, None)
    app.include_router(router)

    def collect():
      posts = []
      seen_cursors = set()
      cursor = None
      with TestClient(app, raise_server_exceptions=False) as client:
        while True:
          params = {"limit": 2}
          if cursor is not None:
            params["before"] = cursor
          response = client.get("/board", params=params)
          self.assertEqual(response.status_code, 200, response.text)
          page = response.json()
          posts.extend(page["posts"])
          cursor = page["next_cursor"]
          if cursor is None:
            return posts
          self.assertNotIn(cursor, seen_cursors)
          seen_cursors.add(cursor)

    if not force_file_fallback:
      return collect()
    store._ensure_board_index()
    with patch.object(
      store, "_board_index", side_effect=sqlite3.DatabaseError("forced fallback"),
    ):
      return collect()

  def test_oversized_original_header_rejects_entire_gallery_before_media_write(self):
    for size in ((6000, 5000), (20000, 20000)):
      with self.subTest(size=size), tempfile.TemporaryDirectory() as directory:
        store = CommonPublicStore(directory)
        oversized = validate_attachment({
          "mime": "image/png", "w": 1, "h": 1,
          "data_b64": base64.b64encode(forged_png_header(*size)).decode(),
        })
        ordinary = ({"mime": "image/png", "w": 1, "h": 1}, b"legacy-image")
        with self.assertRaises(HTTPException) as raised:
          store.store_post({
            "id": "oversized-gallery", "host": "author.example", "text": "Photo",
            "created_at": 1.0, "replies": [],
          }, attachments=[ordinary, oversized])
        self.assertEqual(raised.exception.status_code, 400)
        self.assertFalse((store.board_dir() / "oversized-gallery.json").exists())
        self.assertEqual(list(store.board_media_dir().iterdir()), [])
        self.assertEqual(list(store.board_thumbnail_dir().iterdir()), [])

  def test_pillow_bomb_header_in_client_thumbnail_is_a_clean_rejection(self):
    with tempfile.TemporaryDirectory() as directory:
      store = CommonPublicStore(directory)
      with self.assertRaises(HTTPException) as raised:
        store.store_post({
          "id": "oversized-thumb", "host": "author.example", "text": "Photo",
          "created_at": 1.0, "replies": [],
        }, ({"mime": "image/png", "w": 1, "h": 1}, b"legacy-image"),
          thumbnails=[({"mime": "image/png", "w": 1, "h": 1}, forged_png_header())])
      self.assertEqual(raised.exception.status_code, 400)
      self.assertEqual(list(store.board_media_dir().iterdir()), [])
      self.assertEqual(list(store.board_thumbnail_dir().iterdir()), [])
      self.assertFalse((store.board_dir() / "oversized-thumb.json").exists())

  def test_oversized_backfill_is_rejected_without_cache_or_original_fallback(self):
    with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
      "APP_STORAGE_DIR": directory, "APP_ID": "7", "APP_SLUG": "social",
    }):
      import social_routes
      store = CommonPublicStore(directory)
      original = store.board_media_path("deadbeef", "image/png")
      original.write_bytes(forged_png_header())
      with self.assertRaises(HTTPException) as raised:
        store.board_thumbnail("deadbeef")
      self.assertEqual(raised.exception.status_code, 400)
      self.assertEqual(list(store.board_thumbnail_dir().iterdir()), [])
      self.assertTrue(original.exists(), "legacy source is retained, not deleted")

      app = FastAPI()
      router, _ = create_public_router(store, None)
      app.include_router(router)
      with TestClient(app) as client:
        response = client.get("/board/thumbnail/deadbeef")
      self.assertEqual(response.status_code, 400)
      with patch.object(social_routes, "_public_store", store), patch.object(
        social_routes, "_own_host", return_value="self.example",
      ), patch.object(social_routes, "_serve_image") as serve:
        with self.assertRaises(HTTPException) as raised:
          asyncio.run(social_routes._serve_owner_board_media(
            "self.example", "deadbeef", None, thumbnail=True,
          ))
        self.assertEqual(raised.exception.status_code, 400)
        serve.assert_not_called()

  def test_board_images_get_small_reusable_timeline_thumbnails(self):
    with tempfile.TemporaryDirectory() as directory:
      store = CommonPublicStore(directory)
      output = io.BytesIO()
      Image.new("RGB", (1600, 1200), (48, 96, 160)).save(
        output, format="JPEG", quality=88,
      )
      source = output.getvalue()
      store.store_post({
        "id": "post-image", "host": "author.example", "text": "Photo",
        "created_at": 1.0, "replies": [],
      }, ({"mime": "image/jpeg", "w": 1600, "h": 1200}, source))

      found = store.board_thumbnail("post-image")
      self.assertIsNotNone(found)
      self.assertEqual(found[1], "image/webp")
      self.assertLess(found[0].stat().st_size, len(source))
      with Image.open(found[0]) as thumbnail:
        self.assertLessEqual(max(thumbnail.size), 640)

  def test_client_thumbnail_is_stored_without_reprocessing(self):
    with tempfile.TemporaryDirectory() as directory:
      store = CommonPublicStore(directory)
      original = b"full-image-bytes"
      output = io.BytesIO()
      Image.new("RGB", (64, 48), (10, 20, 30)).save(output, format="WEBP")
      thumbnail = output.getvalue()
      store.store_post({
        "id": "post-client-thumb", "host": "author.example", "text": "Photo",
        "created_at": 1.0, "replies": [],
      }, ({"mime": "image/png", "w": 800, "h": 600}, original), None, [
        ({"mime": "image/webp", "w": 64, "h": 48}, thumbnail),
      ])

      found = store.board_thumbnail("post-client-thumb")
      self.assertIsNotNone(found)
      self.assertEqual(found[1], "image/webp")
      self.assertEqual(found[0].read_bytes(), thumbnail)

  def test_invalid_client_thumbnail_leaves_no_partial_media(self):
    with tempfile.TemporaryDirectory() as directory:
      store = CommonPublicStore(directory)
      with self.assertRaisesRegex(HTTPException, "Post thumbnail is invalid") as raised:
        store.store_post({
          "id": "post-bad-thumb", "host": "author.example", "text": "Photo",
          "created_at": 1.0, "replies": [],
        }, ({"mime": "image/png", "w": 1, "h": 1}, b"source"), None, [
          ({"mime": "image/webp", "w": 1, "h": 1}, b"not-an-image"),
        ])

      self.assertEqual(raised.exception.status_code, 400)
      self.assertFalse((store.board_dir() / "post-bad-thumb.json").exists())
      self.assertEqual(list(store.board_media_dir().iterdir()), [])

  def test_oversized_image_is_rejected_before_raster_processing(self):
    class HeaderOnlyImage:
      format = "PNG"
      width = 6000
      height = 5000

      def __enter__(self):
        return self

      def __exit__(self, *_args):
        pass

    with patch("common_public.Image.open", return_value=HeaderOnlyImage()), patch(
      "common_public.ImageOps.exif_transpose",
    ) as transpose:
      with self.assertRaisesRegex(ValueError, "dimensions are too large"):
        image_thumbnail_bytes(b"header")
      transpose.assert_not_called()

  def test_standard_reactions_preserve_legacy_likes_and_viewer_state(self):
    with tempfile.TemporaryDirectory() as directory:
      store = CommonPublicStore(directory)
      store.store_post({
        "id": "post-react", "host": "author.example", "text": "React",
        "created_at": 1.0, "replies": [],
        "likes": {"legacy.example": 1.0},
      })
      result = store.toggle_reaction("post-react", "viewer.example", "🎉")
      presented = store.read_board(10, None, "viewer.example")[0]

      self.assertEqual(result["reaction_counts"], {"❤️": 1, "🎉": 1})
      self.assertEqual(result["reacted"], ["🎉"])
      self.assertEqual(presented["like_count"], 1)
      self.assertEqual([item["emoji"] for item in presented["reactions"]], ["❤️", "🎉"])
      self.assertTrue(presented["reactions"][1]["reacted"])

  def test_legacy_like_response_shape_survives_storage_migration(self):
    with tempfile.TemporaryDirectory() as directory:
      store = CommonPublicStore(directory)
      store.store_post({
        "id": "post-like", "host": "author.example", "text": "Like",
        "created_at": 1.0, "replies": [],
        "likes": {"existing.example": 1.0},
      })

      result = store.toggle_like("post-like", "viewer.example")

      self.assertEqual(set(result), {
        "status", "likes", "liked", "author_host", "activity",
      })
      self.assertEqual(result["likes"], 2)
      self.assertTrue(result["liked"])

  def test_feed_includes_recent_unique_reply_authors_for_avatar_stack(self):
    with tempfile.TemporaryDirectory() as directory:
      store = CommonPublicStore(directory)
      store.store_post({
        "id": "post-replies", "host": "author.example", "text": "Talk",
        "created_at": 1.0, "replies": [],
      })
      store.add_reply("post-replies", "one", "alice.example", "alice", "Hi", 2.0)
      store.add_reply("post-replies", "two", "bob.example", "bob", "Hey", 3.0)
      store.add_reply("post-replies", "three", "alice.example", "alice", "Again", 4.0)

      post = store.read_board(10, None)[0]
      self.assertEqual(post["reply_authors"], [
        {"host": "alice.example", "handle": "alice"},
        {"host": "bob.example", "handle": "bob"},
      ])

  def test_warm_feed_reads_use_the_index_instead_of_rescanning_every_post(self):
    with tempfile.TemporaryDirectory() as directory:
      store = CommonPublicStore(directory)
      board = store.board_dir()
      for index in range(120):
        (board / f"post-{index:03d}.json").write_text(json.dumps({
          "id": f"post-{index:03d}",
          "host": "author.example",
          "text": f"Post {index}",
          "created_at": float(index),
          "likes": {"viewer.example": index},
          "replies": [{"id": f"reply-{index}"}],
          "_reaction_replays": {"private": 9999999999},
        }))

      loads = 0
      load_object = store._load_object

      def counted(path):
        nonlocal loads
        loads += 1
        return load_object(path)

      store._load_object = counted
      with patch.object(store, "_board_index", wraps=store._board_index) as index:
        first = store.read_board(10, None, "viewer.example")
        loaded_during_migration = loads
        second = store.read_board(10, None, "viewer.example")

      self.assertEqual(loaded_during_migration, 120)
      self.assertEqual(loads, loaded_during_migration)
      self.assertEqual(index.call_args_list, [
        call(initialize=True), call(), call(),
      ])
      self.assertEqual([post["id"] for post in first], [
        f"post-{index:03d}" for index in range(119, 109, -1)
      ])
      self.assertEqual(first, second)
      self.assertTrue(first[0]["liked"])
      self.assertEqual(first[0]["like_count"], 1)
      self.assertEqual(first[0]["reply_count"], 1)
      self.assertNotIn("likes", first[0])
      self.assertNotIn("replies", first[0])
      self.assertNotIn("_reaction_replays", first[0])
      with sqlite3.connect(store.board_index_path()) as connection:
        self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone()[0], "wal")

  def test_cursor_pagination_does_not_skip_posts_with_equal_timestamps(self):
    with tempfile.TemporaryDirectory() as directory:
      store = CommonPublicStore(directory)
      for post_id in ("same-a", "same-b", "same-c"):
        store.store_post({
          "id": post_id, "host": "author.example", "text": post_id,
          "created_at": 10.0, "replies": [],
        })
      app = FastAPI()
      router, _ = create_public_router(store, None)
      app.include_router(router)

      with TestClient(app) as client:
        first = client.get("/board", params={"limit": 2}).json()
        second = client.get("/board", params={
          "limit": 2, "before": first["next_cursor"],
        }).json()
        legacy = client.get("/board", params={"before": "10"}).json()
        invalid = client.get("/board", params={"before": "not-a-cursor"})

      self.assertEqual([post["id"] for post in first["posts"]], [
        "same-c", "same-b",
      ])
      self.assertIsNotNone(first["next_cursor"])
      self.assertEqual([post["id"] for post in second["posts"]], ["same-a"])
      self.assertIsNone(second["next_cursor"])
      self.assertEqual(legacy["posts"], [])
      self.assertEqual(invalid.status_code, 400)
      self.assertEqual(invalid.json()["detail"], "Board cursor is invalid.")

  def test_indexed_cursor_pages_normalize_legacy_positions_without_gaps(self):
    with tempfile.TemporaryDirectory() as directory:
      store = CommonPublicStore(directory)
      self._write_cursor_edge_records(store)

      posts = self._collect_cursor_pages(store)

      self.assertEqual([post["id"] for post in posts], [
        "normal-top", "edge-string", "edge-nan", "edge-missing",
        "edge-infinity", "edge-huge", "edge-bool", "normal-old",
      ])
      self.assertEqual([post["created_at"] for post in posts], [
        5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -1.0,
      ])

  def test_page_ending_at_normalized_zero_retains_older_records(self):
    with tempfile.TemporaryDirectory() as directory:
      store = CommonPublicStore(directory)
      for post_id, created_at in (
        ("new", 1.0), ("normalized", float("inf")), ("old", -1.0),
      ):
        store.store_post({
          "id": post_id, "host": "author.example", "text": post_id,
          "created_at": created_at, "replies": [],
        })
      app = FastAPI()
      router, _ = create_public_router(store, None)
      app.include_router(router)

      with TestClient(app) as client:
        first = client.get("/board", params={"limit": 2}).json()
        second = client.get("/board", params={
          "limit": 2, "before": first["next_cursor"],
        }).json()

      self.assertEqual([post["id"] for post in first["posts"]], [
        "new", "normalized",
      ])
      self.assertEqual(first["posts"][-1]["created_at"], 0.0)
      self.assertIsNotNone(first["next_cursor"])
      self.assertEqual([post["id"] for post in second["posts"]], ["old"])

  def test_old_index_normalization_version_rebuilds_unchanged_infinity_row(self):
    with tempfile.TemporaryDirectory() as directory:
      store = CommonPublicStore(directory)
      path = store.board_dir() / "legacy-infinity.json"
      record = {
        "id": "legacy-infinity", "host": "author.example", "text": "Old",
        "created_at": float("inf"), "replies": [],
      }
      path.write_text(json.dumps(record))
      stat = path.stat()
      with sqlite3.connect(store.board_index_path()) as connection:
        connection.execute(
          """
          CREATE TABLE board_posts (
            id TEXT PRIMARY KEY,
            created_at REAL NOT NULL,
            record_json TEXT NOT NULL,
            source_mtime_ns INTEGER NOT NULL,
            source_size INTEGER NOT NULL
          ) WITHOUT ROWID
          """
        )
        connection.execute(
          """
          INSERT INTO board_posts(
            id, created_at, record_json, source_mtime_ns, source_size
          ) VALUES (?, ?, ?, ?, ?)
          """,
          (
            record["id"], float("inf"), json.dumps(record),
            stat.st_mtime_ns, stat.st_size,
          ),
        )

      posts = store.read_board(10, None)

      self.assertEqual(posts[0]["created_at"], 0.0)
      with sqlite3.connect(store.board_index_path()) as connection:
        self.assertEqual(
          connection.execute("PRAGMA user_version").fetchone()[0],
          BOARD_INDEX_NORMALIZATION_VERSION,
        )
        self.assertEqual(
          connection.execute(
            "SELECT created_at FROM board_posts WHERE id = ?",
            (record["id"],),
          ).fetchone()[0],
          0.0,
        )

  def test_file_fallback_cursor_pages_match_indexed_normalization(self):
    with tempfile.TemporaryDirectory() as directory:
      store = CommonPublicStore(directory)
      self._write_cursor_edge_records(store)

      indexed = self._collect_cursor_pages(store)
      fallback = self._collect_cursor_pages(store, force_file_fallback=True)

      self.assertEqual(fallback, indexed)

  def test_mutations_update_the_index_and_json_remains_rollback_readable(self):
    with tempfile.TemporaryDirectory() as directory:
      store = CommonPublicStore(directory)
      post = {
        "id": "post-one", "host": "author.example", "handle": "author",
        "text": "Hello", "created_at": 10.0, "replies": [],
      }
      self.assertTrue(store.store_post(post))
      self.assertEqual(store.read_board(10, None)[0]["like_count"], 0)

      liked = store.toggle_like("post-one", "viewer.example")
      replied = store.add_reply(
        "post-one", "reply-one", "viewer.example", "viewer", "Hi", 11.0,
      )
      indexed = store.read_board(10, None, "viewer.example")[0]
      rollback_record = json.loads(
        (store.board_dir() / "post-one.json").read_text()
      )

      self.assertTrue(liked["liked"])
      self.assertEqual(replied["reply_count"], 1)
      self.assertTrue(indexed["liked"])
      self.assertEqual(indexed["reply_count"], 1)
      self.assertIn("viewer.example", rollback_record["reactions"]["❤️"])
      self.assertEqual(rollback_record["replies"][0]["id"], "reply-one")

      self.assertEqual(store.delete_post("post-one", "author.example"), {
        "status": "deleted",
      })
      self.assertEqual(store.read_board(10, None), [])

  def test_restart_imports_records_written_during_a_file_only_rollback(self):
    with tempfile.TemporaryDirectory() as directory:
      first = CommonPublicStore(directory)
      first.store_post({
        "id": "before", "host": "author.example", "text": "Before",
        "created_at": 1.0, "replies": [],
      })
      self.assertEqual([p["id"] for p in first.read_board(10, None)], ["before"])

      rollback_post = {
        "id": "during-rollback", "host": "author.example", "text": "Later",
        "created_at": 2.0, "replies": [],
      }
      (first.board_dir() / "during-rollback.json").write_text(
        json.dumps(rollback_post)
      )

      restarted = CommonPublicStore(directory)
      self.assertEqual(
        [p["id"] for p in restarted.read_board(10, None)],
        ["during-rollback", "before"],
      )

  def test_failed_delete_mirror_invalidates_other_process_readers(self):
    with tempfile.TemporaryDirectory() as directory:
      writer = CommonPublicStore(directory)
      reader = CommonPublicStore(directory)
      writer.store_post({
        "id": "private-after-delete", "host": "author.example",
        "text": "Remove me", "created_at": 1.0, "replies": [],
      })
      self.assertEqual(len(reader.read_board(10, None)), 1)

      with patch.object(writer, "_board_index", side_effect=sqlite3.OperationalError("synthetic mirror failure")):
        self.assertEqual(
          writer.delete_post("private-after-delete", "author.example"),
          {"status": "deleted"},
        )

      self.assertEqual(reader.read_board(10, None), [])

  def test_later_board_write_cannot_clear_an_inherited_delete_marker(self):
    with tempfile.TemporaryDirectory() as directory:
      deleter = CommonPublicStore(directory)
      later_writer = CommonPublicStore(directory)
      reader = CommonPublicStore(directory)
      deleter.store_post({
        "id": "one", "host": "author.example", "text": "Delete",
        "created_at": 1.0, "replies": [],
      })
      self.assertEqual([post["id"] for post in later_writer.read_board(10, None)], ["one"])
      self.assertEqual([post["id"] for post in reader.read_board(10, None)], ["one"])

      with patch.object(deleter, "_board_index", side_effect=sqlite3.OperationalError("synthetic mirror failure")):
        deleter.delete_post("one", "author.example")
      # Models a concurrent writer that passed its readiness check before the
      # failed delete, then acquired the board lock after that delete finished.
      with patch.object(later_writer, "_ensure_board_index", return_value=None):
        later_writer.store_post({
          "id": "two", "host": "author.example", "text": "Keep",
          "created_at": 2.0, "replies": [],
        })

      self.assertTrue(reader.board_index_dirty_path().is_file())
      self.assertEqual(
        [post["id"] for post in reader.read_board(10, None)], ["two"],
      )

  def test_corrupt_disposable_index_is_rebuilt_once_from_json_records(self):
    with tempfile.TemporaryDirectory() as directory:
      store = CommonPublicStore(directory)
      store.store_post({
        "id": "kept", "host": "author.example", "text": "Keep me",
        "created_at": 1.0, "replies": [],
      })
      self.assertEqual([post["id"] for post in store.read_board(10, None)], ["kept"])
      store.board_index_path().write_bytes(b"not a sqlite database")

      restarted = CommonPublicStore(directory)
      first = restarted.read_board(10, None)
      second = restarted.read_board(10, None)

      self.assertEqual([post["id"] for post in first], ["kept"])
      self.assertEqual(second, first)
      with sqlite3.connect(restarted.board_index_path()) as connection:
        self.assertEqual(
          connection.execute("SELECT COUNT(*) FROM board_posts").fetchone()[0], 1,
        )

  def test_inherited_dirty_marker_uses_source_count_for_admission(self):
    with tempfile.TemporaryDirectory() as directory, patch(
      "common_public.BOARD_POST_LIMIT", 2,
    ):
      failing_writer = CommonPublicStore(directory)
      later_writer = CommonPublicStore(directory)
      failing_writer.store_post({
        "id": "one", "host": "author.example", "text": "One",
        "created_at": 1.0, "replies": [],
      })
      self.assertEqual(len(later_writer.read_board(10, None)), 1)

      with patch.object(
        failing_writer, "_board_index",
        side_effect=sqlite3.OperationalError("synthetic mirror failure"),
      ):
        failing_writer.store_post({
          "id": "two", "host": "author.example", "text": "Two",
          "created_at": 2.0, "replies": [],
        })

      with patch.object(later_writer, "_ensure_board_index", return_value=None):
        with self.assertRaises(HTTPException) as raised:
          later_writer.store_post({
            "id": "three", "host": "author.example", "text": "Three",
            "created_at": 3.0, "replies": [],
          })

      self.assertEqual(raised.exception.status_code, 507)
      self.assertEqual(len(list(later_writer.board_dir().glob("*.json"))), 2)


if __name__ == "__main__":
  unittest.main()
