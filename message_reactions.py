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
  return True


def reaction_line(who: str, emoji: str) -> str:
  """The notification text for a reaction to the owner's message."""
  if emoji == ":mobius:":
    return f"{who} reacted with the Möbius logo to your message"
  return f"{who} reacted {emoji} to your message"


def supports_message_reactions(actor: dict) -> bool:
  features = actor.get("features") if isinstance(actor, dict) else None
  return isinstance(features, list) and MESSAGE_REACTIONS_FEATURE in features
