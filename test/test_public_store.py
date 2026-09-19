"""Scale and rollback contracts for Social's public board store."""

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from common_public import CommonPublicStore


class PublicBoardIndexTests(unittest.TestCase):
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
      self.assertIn("viewer.example", rollback_record["likes"])
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
