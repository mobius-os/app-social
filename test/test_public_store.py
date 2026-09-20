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
from unittest.mock import patch
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image

from common_protocol import validate_attachment
from common_public import CommonPublicStore, create_public_router, image_thumbnail_bytes


def forged_png_header(width=20000, height=20000):
  output = io.BytesIO()
  Image.new("RGB", (1, 1)).save(output, format="PNG")
  data = bytearray(output.getvalue())
  data[16:24] = struct.pack(">II", width, height)
  data[29:33] = struct.pack(">I", zlib.crc32(data[12:29]) & 0xffffffff)
  return bytes(data)


class PublicBoardIndexTests(unittest.TestCase):
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
      first = store.read_board(10, None, "viewer.example")
      loaded_during_migration = loads
      second = store.read_board(10, None, "viewer.example")

      self.assertEqual(loaded_during_migration, 120)
      self.assertEqual(loads, loaded_during_migration)
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


if __name__ == "__main__":
  unittest.main()
