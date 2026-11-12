"""Reactions on private and group messages.

Every participant keeps its own copy of a conversation, so a reaction is a
small update each copy applies for itself. One update says that ``host`` turned
``emoji`` on or off at time ``at``. Each copy remembers the newest ``at`` it
applied for every (host, emoji) pair, so a repeated, delayed, or reordered
update can never undo a newer one, and applying the same update twice is
harmless.

A stored message keeps two fields:

- ``reactions``: ``{emoji: {host: at}}``, the reactions currently on.
- ``reaction_clock``: ``{"<host> <emoji>": at}``, the newest update applied for
  each pair, including turning one off.
"""

from __future__ import annotations

import math
import time

from fastapi import HTTPException

from common_public import BOARD_REACTION_EMOJIS

# Advertised in the actor card. A peer without it rejects reaction envelopes,
# so the app offers reactions only to peers (and group hosts) that list it.
MESSAGE_REACTIONS_FEATURE = "message_reactions"

# A clock can run a little fast; refuse updates far in the future so one bad
# clock cannot freeze a reaction for everyone else.
MAX_FUTURE_SKEW_S = 600


def validate_reaction(emoji, on, at) -> tuple[str, bool, float]:
  """The checked (emoji, on, at) of one reaction update, or a 400."""
  if emoji not in BOARD_REACTION_EMOJIS:
    raise HTTPException(status_code=400, detail="Reaction is not supported.")
  if not isinstance(on, bool):
    raise HTTPException(status_code=400, detail="Reaction state is invalid.")
  if (
    not isinstance(at, (int, float)) or isinstance(at, bool)
    or not math.isfinite(at) or at <= 0
    or at > time.time() + MAX_FUTURE_SKEW_S
  ):
    raise HTTPException(status_code=400, detail="Reaction time is invalid.")
  return emoji, on, float(at)


def next_reaction_time(record: dict, host: str, emoji: str) -> float:
  """A time for this host's next update that is newer than any it applied."""
  clock = record.get("reaction_clock")
  last = clock.get(f"{host} {emoji}") if isinstance(clock, dict) else None
  now = time.time()
  if isinstance(last, (int, float)) and last >= now:
    return float(last) + 0.001
  return now


def apply_reaction(record: dict, host: str, emoji: str, on: bool, at: float) -> bool:
  """Apply one update to a stored message; False when a newer one already won."""
  clock = record.get("reaction_clock")
  clock = dict(clock) if isinstance(clock, dict) else {}
  key = f"{host} {emoji}"
  last = clock.get(key)
  if isinstance(last, (int, float)) and last >= at:
    return False
  clock[key] = at
  reactions = record.get("reactions")
  reactions = {
    name: dict(hosts) for name, hosts in reactions.items() if isinstance(hosts, dict)
  } if isinstance(reactions, dict) else {}
  hosts = reactions.setdefault(emoji, {})
  if on:
    hosts[host] = at
  else:
    hosts.pop(host, None)
  if not hosts:
    reactions.pop(emoji, None)
  record["reactions"] = reactions
  record["reaction_clock"] = clock
  bump_reaction_rev(record)
  return True


def reaction_line(who: str, emoji: str) -> str:
  """The notification text for a reaction to the owner's message."""
  if emoji == ":mobius:":
    return f"{who} reacted with the Möbius logo to your message"
  return f"{who} reacted {emoji} to your message"


def supports_message_reactions(actor: dict) -> bool:
  features = actor.get("features") if isinstance(actor, dict) else None
  return isinstance(features, list) and MESSAGE_REACTIONS_FEATURE in features


# ── the owner's own updates ─────────────────────────────────────────────────
#
# The owner's update is applied to this copy before it is sent, so the message
# shows what the owner chose even when a reply is lost. ``reaction_updates``
# keeps the newest own update per emoji: ``{emoji: {"id", "on", "at",
# "pending", "before", "detail"}}``. ``id`` is the update's stable identity: a
# retry under it re-sends exactly the same update, which every copy applies at
# most once. ``pending`` stays true until the other side confirms it, and
# ``before`` is what a definite refusal restores. ``reaction_rev`` counts every
# change to a message's reaction fields, so a view holding two copies of one
# message keeps the newer one.

OWN_UPDATES = "reaction_updates"


def bump_reaction_rev(record: dict) -> None:
  rev = record.get("reaction_rev")
  record["reaction_rev"] = (rev if isinstance(rev, int) and not isinstance(rev, bool) else 0) + 1


def begin_own_update(
  record: dict, host: str, emoji: str, on: bool, update_id: str,
) -> tuple[dict, bool]:
  """Apply and remember one own update; ``(update, new)``.

  The same id again is an exact retry of the saved update, which is returned
  unchanged. Reusing an id for a different update is refused.
  """
  updates = record.get(OWN_UPDATES)
  updates = {key: dict(value) for key, value in updates.items() if isinstance(value, dict)} \
    if isinstance(updates, dict) else {}
  for key, update in updates.items():
    if update.get("id") == update_id:
      if key != emoji or update.get("on") is not on:
        raise HTTPException(status_code=409, detail="This reaction id belongs to another update.")
      return update, False
  emoji, on, at = validate_reaction(emoji, on, next_reaction_time(record, host, emoji))
  clock = record.get("reaction_clock")
  reactions = record.get("reactions")
  hosts = reactions.get(emoji) if isinstance(reactions, dict) else None
  before = {
    "at": clock.get(f"{host} {emoji}") if isinstance(clock, dict) else None,
    "since": hosts.get(host) if isinstance(hosts, dict) else None,
  }
  apply_reaction(record, host, emoji, on, at)
  update = {"id": update_id, "on": on, "at": at, "pending": True, "before": before}
  updates[emoji] = update
  record[OWN_UPDATES] = updates
  return update, True


def settle_own_update(
  record: dict, host: str, emoji: str, update_id: str, outcome: str,
  detail: str | None = None,
) -> bool:
  """Record what became of an own update; False if a newer one replaced it.

  ``delivered`` confirms it. ``uncertain`` keeps it pending with ``detail``:
  the other side may have applied it, so it stays shown and retryable.
  ``refused`` is a definite refusal, so this copy returns to its prior state.
  """
  updates = record.get(OWN_UPDATES)
  update = updates.get(emoji) if isinstance(updates, dict) else None
  if not isinstance(update, dict) or update.get("id") != update_id:
    return False
  updates = dict(updates)
  if outcome == "delivered":
    updates[emoji] = {key: value for key, value in update.items() if key not in ("before", "detail")}
    updates[emoji]["pending"] = False
  elif outcome == "uncertain":
    updates[emoji] = {**update, "detail": detail} if detail else dict(update)
  elif outcome == "refused":
    updates.pop(emoji)
    _restore(record, host, emoji, update)
  else:
    raise ValueError(f"Unknown outcome {outcome!r}.")
  record[OWN_UPDATES] = updates
  bump_reaction_rev(record)
  return True


def _restore(record: dict, host: str, emoji: str, update: dict) -> None:
  key = f"{host} {emoji}"
  clock = dict(record.get("reaction_clock") or {})
  if clock.get(key) != update.get("at"):
    return  # a newer update for this pair has been applied since
  before = update.get("before") if isinstance(update.get("before"), dict) else {}
  if isinstance(before.get("at"), (int, float)):
    clock[key] = before["at"]
  else:
    clock.pop(key, None)
  reactions = {
    name: dict(hosts) for name, hosts in (record.get("reactions") or {}).items()
    if isinstance(hosts, dict)
  }
  hosts = reactions.setdefault(emoji, {})
  if isinstance(before.get("since"), (int, float)):
    hosts[host] = before["since"]
  else:
    hosts.pop(host, None)
  if not hosts:
    reactions.pop(emoji, None)
  record["reactions"] = reactions
  record["reaction_clock"] = clock


def own_update_result(record: dict, update: dict) -> dict:
  """The owner surface's answer for one own update."""
  pending = bool(update.get("pending"))
  return {
    "status": "pending" if pending else "delivered",
    "id": update.get("id"),
    "detail": update.get("detail") if pending else None,
    "reactions": record.get("reactions") or {},
  }
