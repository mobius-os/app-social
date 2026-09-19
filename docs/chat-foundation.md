# Social chat foundation

This document defines the reliability and scale boundary for Social's public
board, direct messages, group messages, and future agent participation. It is a
delivery plan, not a claim that every stage below already ships.

## Product contract

- A direct message has one stable identity from the first local submit through every
  retry and recipient deduplication.
- Saving a direct-message intent happens before network delivery. A process exit,
  timeout, or lost response must not lose the message or create a second one.
- Direct-message delivery state is explicit: `sending`, `delivered`, or `failed`. Retrying a
  failed or ambiguous delivery reuses the same message id.
- A direct-message recipient persists each message id at most once and treats a duplicate as
  a successful receipt.
- Histories are cursor-paginated. Opening a long conversation or busy board
  never reloads its entire lifetime.
- Public community data and private conversation data remain separate. The
  central community service owns the board and directory; each participant's
  Möbius owns its DMs and local group copy.
- Agent participation never bypasses owner authority. The current
  non-delegated-owner guard remains until a separate, explicit grant model is
  implemented.

## Storage and delivery ownership

### Public board

The rollback-safe JSON post records remain the durable compatibility format for
the first scale release. A SQLite/WAL read model mirrors those records and owns
feed ordering and pagination. Feed reads query only the requested page instead
of scanning and sorting every post. The index is disposable: startup reconciles
it from the JSON records, and any index failure falls back to the files.

This staged cutover protects existing data and immediate container rollback.
After the release has operated cleanly, SQLite can become the sole board record
owner in a deliberate migration rather than keeping two permanent write paths.

### Direct and group messages

DM and group JSON records also remain the rollback-safe durable format in the
first scale release. A shared SQLite/WAL history index mirrors their complete
records and serves pages ordered by `(sent_at, id)`. Each conversation records
the app-storage version it has reconciled. If a file-only rollback writes or
changes messages, the next read detects the version gap and repairs that one
conversation before serving it; a newer mirrored write cannot conceal an
older missed write.

The UI opens only the latest 50 messages and requests older 50-message pages
with an opaque cursor. Loading an older page preserves the reader's scroll
position, while ordinary refreshes merge the newest page into history already
on screen. When the local service is offline, the existing runtime cache
remains a read-only fallback for already-saved history.

The first direct-message delivery transaction is:

1. Accept or create a client-generated message id.
2. Atomically persist the local message, attachment reference, and outbox row.
3. Return the persisted `sending` message to the UI.
4. A supervised delivery owner fetches current peer keys, creates a fresh
   transport timestamp/signature, and attempts the bounded network operation.
5. Mark the outbox row and local message `delivered` or `failed` atomically.
6. Retry with the same message id. The transport signature may be renewed;
   message identity and original authored content may not.

SQLite/WAL is the first single-host transaction owner for message metadata and
outbox state. Attachments remain bounded files referenced by the transaction.
No distributed queue is justified for the expected first hundreds of users.

The current JSON-v1 app service exits after each request, so an in-process task
is not a delivery owner. Background delivery must be held by a supervised app
job or a long-lived Social service before `/send` can honestly return
immediately. Until that owner exists, persist-before-send plus explicit retry is
the safe intermediate state; a detached coroutine is not.

## Group consistency

The group creator remains the membership authority. Membership, closure, and
accepted-message transitions require a cross-process transaction lock because
private and public requests can run in different short-lived processes. Never
hold that lock across network I/O: snapshot the authoritative transition,
commit it, release the lock, then deliver from the outbox.

Group fan-out creates one delivery row per active member. A message is locally
accepted once; individual member failures are visible and independently
retryable rather than making the authored group message ambiguous.

That group outbox is the next delivery stage, not a claim about the current
request-bound group sender. The current foundation serializes authoritative
group state and makes ambiguous UI outcomes explicit, but group sends still
need stable client ids, persist-before-network acceptance, resumable fan-out,
and per-recipient retry before they share the direct-message guarantee.

## History and realtime delivery

DM and group history use `(sent_at, id)` cursors and return a bounded page plus
`next_cursor`, which the current polling UI consumes. The board read model is
also bounded and indexed, but its existing public compatibility endpoint still
uses a timestamp boundary; an opaque `(created_at, id)` board cursor remains a
follow-up before the board UI exposes deep paging. In a local 5,000-message
probe, the initial JSON-to-index
reconciliation took 524 ms; subsequent 50-message reads were 0.70 ms median
and 0.94 ms p95. A later event stream may reduce polling, but it is a
notification channel, not the source of truth: reconnect always resumes from a
cursor and storage remains authoritative.

## Agent participation

An agent is a visible conversation participant, never an invisible use of the
owner's identity. The minimum grant records:

- the authorizing owner;
- the agent identity shown beside each message;
- allowed conversation ids;
- allowed actions (read, draft, send, react, moderate);
- expiry and revocation state;
- an audit link from every agent-authored action to its grant.

Sending requires an explicit scoped grant and preserves both the agent author
and authorizing owner in the signed message. Revocation blocks new work without
rewriting history. Broad delegated credentials and silently impersonating the
owner are out of scope.

## Release gates

Current foundation gates:

- signed create/delete/list succeeds without touching owner data;
- a lost response followed by retry produces one recipient message;
- concurrent group membership and closure cannot lose an accepted transition;
- 50 concurrent reads over 1,000 board posts remain under 250 ms p95 on the
  reference host;
- 5,000-post warm board reads remain under 20 ms p95;
- long histories load one bounded page and retain scroll position while new
  messages arrive;
- failures expose retry and preserve the draft, attachment, and message id.

The next delivery-owner release adds automatic resume after process restart,
the group outbox described above, and scoped agent grants. Until then, direct
messages recover through explicit same-id retry and group delivery uncertainty
is shown rather than silently submitted twice.
