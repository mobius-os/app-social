"""Edits to the owner's own private and group messages.

Every participant keeps its own copy of a conversation, so an edit is a small
update each copy applies for itself: the author replaced a message's text at
time ``at``. Copies keep the newest edit, so a repeated, delayed, or reordered
edit never brings back older text, and applying one twice is harmless. Only the
message's author may edit it; every receiving copy checks that itself.

A stored message keeps:

- ``text``: the current text, replaced by the newest edit;
- ``edited_at``: when that newest edit was made (absent if never edited);
- ``edit`` (author's copy only): the owner's newest edit,
  ``{"id", "at", "text", "pending", "before", "detail"}``. ``pending`` stays
  true until the other side confirms it; ``before`` is what a definite refusal
  restores.
"""

from __future__ import annotations

import math
import time

from fastapi import HTTPException

from common_protocol import MAX_MESSAGE_TEXT_CHARS

# Advertised in the actor card. A peer without it rejects edit envelopes, so
# the app offers editing only to peers (and group hosts) that list it.
MESSAGE_EDITS_FEATURE = "message_edits"

# A clock can run a little fast; refuse edits far in the future so one bad
# clock cannot freeze a message's text for everyone else.
MAX_FUTURE_SKEW_S = 600


def supports_message_edits(actor: dict) -> bool:
  features = actor.get("features") if isinstance(actor, dict) else None
  return isinstance(features, list) and MESSAGE_EDITS_FEATURE in features


def validate_edit(text, at) -> tuple[str, float]:
  """The checked (text, at) of one edit, or a 400."""
  if not isinstance(text, str) or not text.strip() or len(text) > MAX_MESSAGE_TEXT_CHARS:
    raise HTTPException(status_code=400, detail="Edited text is invalid.")
  if (
    not isinstance(at, (int, float)) or isinstance(at, bool) or not math.isfinite(at)
    or at <= 0 or at > time.time() + MAX_FUTURE_SKEW_S
  ):
    raise HTTPException(status_code=400, detail="Edit time is invalid.")
  return text, float(at)


def _edited_at(record: dict) -> float:
  value = record.get("edited_at")
  return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0.0


def apply_edit(record: dict, text: str, at: float) -> bool:
  """Apply one edit to this copy; False when it is not newer than the current text."""
  if at <= _edited_at(record):
    return False
  record["text"] = text
  record["edited_at"] = at
  return True


def begin_own_edit(record: dict, text: str, edit_id: str) -> tuple[dict, bool]:
  """Apply and remember the owner's edit; ``(edit, new)``.

  The same id again is an exact retry of the saved edit and changes nothing.
  """
  current = record.get("edit")
  if isinstance(current, dict) and current.get("id") == edit_id:
    if current.get("text") != text:
      raise HTTPException(status_code=409, detail="This edit id belongs to another edit.")
    return current, False
  text, at = validate_edit(text, max(time.time(), _edited_at(record) + 0.001))
  before = {"text": record.get("text"), "edited_at": record.get("edited_at")}
  apply_edit(record, text, at)
  edit = {"id": edit_id, "at": at, "text": text, "pending": True, "before": before}
  record["edit"] = edit
  return edit, True


def settle_own_edit(record: dict, edit_id: str, outcome: str, detail: str | None = None) -> bool:
  """Record what became of the owner's edit; False if a newer edit replaced it.

  ``delivered`` confirms it. ``uncertain`` keeps it pending with ``detail``:
  the other side may have applied it. ``refused`` restores the earlier text,
  unless something newer has replaced it meanwhile.
  """
  edit = record.get("edit")
  if not isinstance(edit, dict) or edit.get("id") != edit_id:
    return False
  if outcome == "delivered":
    record["edit"] = {**edit, "pending": False, "detail": None}
  elif outcome == "uncertain":
    record["edit"] = {**edit, "pending": True, "detail": detail}
  else:
    before = edit.get("before") if isinstance(edit.get("before"), dict) else {}
    if _edited_at(record) == edit.get("at"):
      record["text"] = before.get("text")
      if before.get("edited_at") is None:
        record.pop("edited_at", None)
      else:
        record["edited_at"] = before["edited_at"]
    record.pop("edit", None)
  return True


def edit_result(record: dict) -> dict:
  """What the app needs after an edit attempt."""
  edit = record.get("edit") if isinstance(record.get("edit"), dict) else {}
  return {
    "id": record.get("id"),
    "text": record.get("text"),
    "edited_at": record.get("edited_at"),
    "pending": bool(edit.get("pending")),
    "detail": edit.get("detail"),
  }
