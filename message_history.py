"""Bounded, rollback-safe history reads for Social conversations.

JSON message files remain the durable compatibility format.  A disposable
SQLite/WAL read model makes opening and paging an established conversation
independent of its total length.  The app-wide version counter lets a newer
release notice writes made by a file-only rollback and reconcile only the
conversation being opened.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from service_io import atomic_write
from service_runtime import fs_locks


DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 100
_SCOPES = {"dm", "group"}


def _storage() -> Path:
  return Path(os.environ["APP_STORAGE_DIR"])


def _index_path() -> Path:
  path = _storage() / "server" / "message-index.sqlite3"
  path.parent.mkdir(parents=True, exist_ok=True)
  return path


def _dirty_path(scope: str, conversation: str) -> Path:
  """Return a durable invalidation marker for one indexed conversation."""
  digest = hashlib.sha256(f"{scope}\0{conversation}".encode()).hexdigest()
  return _storage() / "server" / "message-history-dirty" / f"{scope}-{digest}.json"


def begin_message_mutation(scope: str, conversation: str) -> bool:
  """Invalidate one read-model slice before its source JSON can change.

  Callers already hold the app-storage lock.  A process exit after this write
  can leave the marker behind, but can never make a committed JSON mutation
  invisible to a later indexed read.
  """
  if scope not in _SCOPES:
    raise ValueError("Unknown message scope.")
  path = _dirty_path(scope, conversation)
  if path.is_file():
    # This mutation inherited an unresolved crash window.  Mirroring only its
    # own row must not clear the marker before a full conversation scan.
    return False
  path.parent.mkdir(parents=True, exist_ok=True)
  atomic_write(path, json.dumps({"scope": scope, "conversation": conversation}))
  return True


def _finish_message_mutation(scope: str, conversation: str) -> None:
  try:
    _dirty_path(scope, conversation).unlink(missing_ok=True)
  except OSError:
    # A retained marker only causes one more conservative reconciliation.
    pass


@contextmanager
def _index():
  connection = sqlite3.connect(_index_path(), timeout=5.0)
  try:
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=NORMAL")
    connection.execute("PRAGMA busy_timeout=5000")
    connection.execute(
      """
      CREATE TABLE IF NOT EXISTS messages (
        scope TEXT NOT NULL,
        conversation TEXT NOT NULL,
        id TEXT NOT NULL,
        sent_at REAL NOT NULL,
        record_json TEXT NOT NULL,
        source_mtime_ns INTEGER NOT NULL,
        source_size INTEGER NOT NULL,
        PRIMARY KEY(scope, conversation, id)
      ) WITHOUT ROWID
      """
    )
    connection.execute(
      """
      CREATE INDEX IF NOT EXISTS messages_history
      ON messages(scope, conversation, sent_at DESC, id DESC)
      """
    )
    connection.execute(
      """
      CREATE TABLE IF NOT EXISTS conversation_state (
        scope TEXT NOT NULL,
        conversation TEXT NOT NULL,
        indexed_version INTEGER NOT NULL,
        PRIMARY KEY(scope, conversation)
      ) WITHOUT ROWID
      """
    )
    connection.execute(
      """
      CREATE TABLE IF NOT EXISTS history_coverage (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        covered_from INTEGER NOT NULL,
        covered_through INTEGER NOT NULL
      )
      """
    )
    yield connection
    connection.commit()
  except Exception:
    connection.rollback()
    raise
  finally:
    connection.close()


def _version() -> int:
  path = _storage() / "state" / "version.json"
  if not path.is_file():
    return 0
  try:
    return int(json.loads(path.read_text()).get("v") or 0)
  except (OSError, ValueError, TypeError, json.JSONDecodeError):
    return 0


def _values(scope: str, conversation: str, record: dict, path: Path) -> tuple:
  sent_at = record.get("sent_at", 0)
  if not isinstance(sent_at, (int, float)) or isinstance(sent_at, bool):
    sent_at = 0
  stat = path.stat()
  return (
    scope, conversation, str(record.get("id") or ""), float(sent_at),
    json.dumps(record, separators=(",", ":")),
    int(stat.st_mtime_ns), int(stat.st_size),
  )


def _upsert(connection: sqlite3.Connection, values: tuple) -> None:
  connection.execute(
    """
    INSERT INTO messages(
      scope, conversation, id, sent_at, record_json,
      source_mtime_ns, source_size
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope, conversation, id) DO UPDATE SET
      sent_at=excluded.sent_at,
      record_json=excluded.record_json,
      source_mtime_ns=excluded.source_mtime_ns,
      source_size=excluded.source_size
    """,
    values,
  )


def _mark_version_covered(connection: sqlite3.Connection, version: int) -> None:
  """Record one app version whose message effects are fully mirrored.

  A gap starts a new covered suffix. Conversations indexed before that suffix
  still reconcile once; conversations already at its boundary can safely skip
  scans for unrelated current-version mutations.
  """
  row = connection.execute(
    "SELECT covered_from, covered_through FROM history_coverage WHERE singleton = 1"
  ).fetchone()
  if row is None:
    connection.execute(
      "INSERT INTO history_coverage(singleton, covered_from, covered_through) VALUES (1, ?, ?)",
      (version, version),
    )
  elif version <= int(row["covered_through"]):
    return
  elif version == int(row["covered_through"]) + 1:
    connection.execute(
      "UPDATE history_coverage SET covered_through = ? WHERE singleton = 1",
      (version,),
    )
  else:
    connection.execute(
      "UPDATE history_coverage SET covered_from = ?, covered_through = ? WHERE singleton = 1",
      (version, version),
    )


def mark_version_covered(version: int) -> None:
  """Mark a metadata-only app version as irrelevant to message history."""
  try:
    with _index() as connection:
      _mark_version_covered(connection, version)
  except (OSError, sqlite3.Error):
    # Missing coverage only causes a conservative JSON reconciliation later.
    pass


def mirror_message(
  scope: str, conversation: str, record: dict, path: Path,
  *, version: int | None = None, owns_dirty_marker: bool = False,
) -> None:
  """Mirror a committed JSON message without making cache health authoritative."""
  if scope not in _SCOPES:
    raise ValueError("Unknown message scope.")
  mirrored = False
  try:
    with _index() as connection:
      _upsert(connection, _values(scope, conversation, record, path))
      current_version = _version() if version is None else version
      # Advance a known-complete slice only across this exact one mutation.
      # If a file-only rollback or an unrelated storage change skipped one or
      # more versions, retain the mismatch so the next read reconciles JSON.
      connection.execute(
        """
        UPDATE conversation_state SET indexed_version = ?
        WHERE scope = ? AND conversation = ? AND indexed_version = ?
        """,
        (current_version, scope, conversation, current_version - 1),
      )
      _mark_version_covered(connection, current_version)
    mirrored = True
  except (OSError, sqlite3.Error):
    # JSON is the source of truth.  A later history read rebuilds this slice.
    pass
  if mirrored and owns_dirty_marker:
    _finish_message_mutation(scope, conversation)


def _decode_cursor(cursor: str | None) -> tuple[float, str] | None:
  if not cursor:
    return None
  try:
    padded = cursor + "=" * (-len(cursor) % 4)
    raw = json.loads(base64.urlsafe_b64decode(padded).decode())
    sent_at, message_id = raw
    if (
      not isinstance(sent_at, (int, float))
      or isinstance(sent_at, bool)
      or not isinstance(message_id, str)
      or not message_id
    ):
      raise ValueError
    return float(sent_at), message_id
  except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError) as exc:
    raise ValueError("History cursor is invalid.") from exc


def _encode_cursor(sent_at: float, message_id: str) -> str:
  payload = json.dumps([sent_at, message_id], separators=(",", ":")).encode()
  return base64.urlsafe_b64encode(payload).decode().rstrip("=")


async def ensure_conversation(
  app_id: int, scope: str, conversation: str, messages_dir: Path,
) -> None:
  """Reconcile one conversation when its durable JSON version has advanced."""
  if scope not in _SCOPES:
    raise ValueError("Unknown message scope.")
  async with fs_locks.app_storage_lock(app_id):
    current_version = _version()
    dirty = _dirty_path(scope, conversation).is_file()
    with _index() as connection:
      state = connection.execute(
        """
        SELECT indexed_version FROM conversation_state
        WHERE scope = ? AND conversation = ?
        """,
        (scope, conversation),
      ).fetchone()
      if not dirty and state is not None and int(state["indexed_version"]) == current_version:
        return
      coverage = connection.execute(
        "SELECT covered_from, covered_through FROM history_coverage WHERE singleton = 1"
      ).fetchone()
      if (
        not dirty and state is not None and coverage is not None
        and current_version >= int(state["indexed_version"])
        and int(state["indexed_version"]) >= int(coverage["covered_from"]) - 1
        and int(coverage["covered_through"]) == current_version
      ):
        connection.execute(
          """
          UPDATE conversation_state SET indexed_version = ?
          WHERE scope = ? AND conversation = ?
          """,
          (current_version, scope, conversation),
        )
        return
      existing = {
        row["id"]: (row["source_mtime_ns"], row["source_size"])
        for row in connection.execute(
          """
          SELECT id, source_mtime_ns, source_size FROM messages
          WHERE scope = ? AND conversation = ?
          """,
          (scope, conversation),
        )
      }
      seen = set()
      invalid = set()
      for path in messages_dir.glob("*.json") if messages_dir.is_dir() else ():
        message_id = path.stem
        seen.add(message_id)
        try:
          stat = path.stat()
        except OSError:
          continue
        if existing.get(message_id) == (stat.st_mtime_ns, stat.st_size):
          continue
        try:
          record = json.loads(path.read_text())
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
          invalid.add(message_id)
          continue
        if not isinstance(record, dict) or record.get("id") != message_id:
          invalid.add(message_id)
          continue
        try:
          _upsert(connection, _values(scope, conversation, record, path))
        except OSError:
          invalid.add(message_id)
      stale = (set(existing) - seen) | invalid
      connection.executemany(
        """
        DELETE FROM messages
        WHERE scope = ? AND conversation = ? AND id = ?
        """,
        ((scope, conversation, message_id) for message_id in stale),
      )
      connection.execute(
        """
        INSERT INTO conversation_state(scope, conversation, indexed_version)
        VALUES (?, ?, ?)
        ON CONFLICT(scope, conversation) DO UPDATE SET
          indexed_version=excluded.indexed_version
        """,
        (scope, conversation, current_version),
      )
    _finish_message_mutation(scope, conversation)


def read_page(
  scope: str, conversation: str, *, cursor: str | None = None,
  limit: int = DEFAULT_PAGE_SIZE,
) -> dict:
  """Return one ascending display page and an opaque cursor for older rows."""
  if scope not in _SCOPES:
    raise ValueError("Unknown message scope.")
  limit = max(1, min(int(limit), MAX_PAGE_SIZE))
  before = _decode_cursor(cursor)
  where = "scope = ? AND conversation = ?"
  params: list[object] = [scope, conversation]
  if before is not None:
    # Tuple comparison preserves the exact (sent_at, id) cursor semantics and
    # lets SQLite seek directly into messages_history instead of scanning the
    # whole conversation for every older page.
    where += " AND (sent_at, id) < (?, ?)"
    params.extend([before[0], before[1]])
  params.append(limit + 1)
  with _index() as connection:
    rows = connection.execute(
      f"""
      SELECT id, sent_at, record_json FROM messages
      WHERE {where}
      ORDER BY sent_at DESC, id DESC
      LIMIT ?
      """,
      params,
    ).fetchall()
  has_older = len(rows) > limit
  selected = rows[:limit]
  messages = [json.loads(row["record_json"]) for row in reversed(selected)]
  next_cursor = None
  if has_older and selected:
    oldest = selected[-1]
    next_cursor = _encode_cursor(float(oldest["sent_at"]), oldest["id"])
  return {"messages": messages, "next_cursor": next_cursor}


def _read_file_page(
  messages_dir: Path, *, cursor: str | None, limit: int,
) -> dict:
  """Availability fallback when the disposable SQLite read model is broken."""
  limit = max(1, min(int(limit), MAX_PAGE_SIZE))
  before = _decode_cursor(cursor)
  records = []
  for path in messages_dir.glob("*.json") if messages_dir.is_dir() else ():
    try:
      record = json.loads(path.read_text())
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
      continue
    if not isinstance(record, dict) or record.get("id") != path.stem:
      continue
    sent_at = record.get("sent_at", 0)
    if not isinstance(sent_at, (int, float)) or isinstance(sent_at, bool):
      sent_at = 0
    key = (float(sent_at), record["id"])
    if before is not None and key >= before:
      continue
    records.append((key, record))
  records.sort(key=lambda item: item[0], reverse=True)
  selected = records[:limit]
  next_cursor = None
  if len(records) > limit and selected:
    next_cursor = _encode_cursor(*selected[-1][0])
  return {
    "messages": [record for _key, record in reversed(selected)],
    "next_cursor": next_cursor,
  }


async def load_page(
  app_id: int, scope: str, conversation: str, messages_dir: Path, *,
  cursor: str | None = None, limit: int = DEFAULT_PAGE_SIZE,
) -> dict:
  """Serve an indexed page, falling back to durable JSON on index failure."""
  try:
    await ensure_conversation(app_id, scope, conversation, messages_dir)
    return read_page(scope, conversation, cursor=cursor, limit=limit)
  except sqlite3.Error:
    return _read_file_page(messages_dir, cursor=cursor, limit=limit)
