// The service counts every change to a message's reactions in reaction_rev.
// Two copies of one message can reach a view in either order (the newest page,
// an older page, a refresh of the loaded range), so its reactions always come
// from the copy that has seen more changes, never just the one merged last.
const REACTION_FIELDS = ['reactions', 'reaction_clock', 'reaction_updates', 'reaction_rev']
const reactionRev = message => (Number.isInteger(message?.reaction_rev) ? message.reaction_rev : 0)

// Edits work the same way with edit_rev, which the service advances on every
// edit change, including a refused edit rolling back to the earlier text.
const EDIT_FIELDS = ['text', 'edited_at', 'edit', 'edit_rev']
export const editRev = message => (Number.isInteger(message?.edit_rev) ? message.edit_rev : 0)

function keepFields(merged, source, fields) {
  for (const field of fields) {
    if (field in source) merged[field] = source[field]
    else delete merged[field]
  }
}

function mergeRow(earlier, later) {
  if (!earlier) return later
  const keepReactions = reactionRev(earlier) > reactionRev(later)
  const keepEdit = editRev(earlier) > editRev(later)
  if (!keepReactions && !keepEdit) return later
  const merged = { ...later }
  if (keepReactions) keepFields(merged, earlier, REACTION_FIELDS)
  if (keepEdit) keepFields(merged, earlier, EDIT_FIELDS)
  return merged
}

function compareMessages(a, b) {
  return (a.sent_at || 0) - (b.sent_at || 0) || String(a.id).localeCompare(String(b.id))
}

export function mergeMessages(...pages) {
  const byId = new Map()
  for (const page of pages) {
    for (const message of page || []) byId.set(message.id, mergeRow(byId.get(message.id), message))
  }
  return [...byId.values()].sort(compareMessages)
}

// Whether the view holds saved messages older than a page's oldest row: the
// newest page alone does not cover them, so their changes need another read.
export function loadedBefore(messages, boundary) {
  if (!boundary) return false
  return (messages || []).some(message => !message._client_retry && compareMessages(message, boundary) < 0)
}

// A re-read of already-loaded history refreshes the rows the view holds. It
// never adds rows, so older-page pagination keeps its own cursor and order.
export function refreshLoadedRows(prior, rows) {
  if (!prior) return prior
  const fresh = new Map((rows || []).map(row => [row.id, row]))
  let changed = false
  const next = prior.map((message) => {
    const row = fresh.get(message.id)
    if (!row) return message
    const merged = mergeRow(message, row)
    if (JSON.stringify(merged) === JSON.stringify(message)) return message
    changed = true
    return merged
  })
  return changed ? next : prior
}

export function reconcileLatestPage(prior, page, { replace = false } = {}) {
  const incoming = page?.messages || []
  // A locally pending identity can reappear in the newest server page without
  // proving that the intervening remote history is continuous.
  const priorIds = new Set((prior || [])
    .filter((message) => (
      !message._client_retry
      && !message._client_unconfirmed_history
    ))
    .map((message) => message.id))
  const lostContinuity = !replace && prior?.length > 0 && page?.next_cursor &&
    !incoming.some((message) => priorIds.has(message.id))
  const resetCursor = replace || prior == null || prior.length === 0 || lostContinuity
  const pendingLocal = (prior || []).filter((message) =>
    message._client_retry || message._client_unconfirmed_history)
  return {
    // When a pending id has already reached the server, its authoritative row
    // must replace the optimistic copy rather than be overwritten by it.
    messages: resetCursor ? mergeMessages(pendingLocal, incoming) : mergeMessages(prior, incoming),
    nextCursor: page?.next_cursor || null,
    resetCursor,
  }
}

// The published first-paint page can arrive before or after an authoritative
// history response, so it may be older than what is on screen. It may only add
// messages the view has not seen yet; changes to a message already shown
// (delivery status, retries) belong to the authoritative history.
export function addUnseenMessages(prior, page) {
  const known = new Set((prior || []).map((message) => message.id))
  const unseen = (page?.messages || []).filter((message) => !known.has(message.id))
  return unseen.length ? mergeMessages(prior, unseen) : prior
}

export function reconcileOlderPage(
  prior, page, requestGeneration, currentGeneration,
) {
  // A latest-page continuity reset owns a new pagination chain.  An older
  // response from the abandoned chain cannot safely advance its cursor.
  if (requestGeneration !== currentGeneration) return null
  return {
    messages: mergeMessages(page?.messages, prior),
    nextCursor: page?.next_cursor || null,
  }
}

export function isDefinitePrecommitRejection(error) {
  return Number.isInteger(error?.status) && error.status >= 400 && error.status < 500
}

export function settleMessage(messages, messageId, result) {
  return (messages || []).map((message) => {
    if (message.id !== messageId) return message
    const { _client_retry, _retry_attachment, failure, ...saved } = message
    return {
      ...saved,
      status: result.status || 'failed',
      ...(result.detail ? { failure: result.detail } : {}),
    }
  })
}

// A lost response is not proof of rejection: keep the same retryable identity
// until a server record or a later retry establishes the delivery outcome.
export function markDeliveryUnknown(messages, messageId, reason) {
  return (messages || []).map((message) => message.id === messageId && message.status !== 'delivered'
    ? { ...message, status: 'sending', failure: reason, _client_unconfirmed_history: true }
    : message)
}

// Screen readers hear what the delivery tick means, not a raw status word.
export function deliveryLabel(status) {
  return status === 'sending' ? 'Sending' : status === 'failed' ? 'Delivery failed' : 'Delivered'
}

// The owner's own reaction updates that are not confirmed yet, oldest first:
// those this view could not confirm (`local`, keyed by emoji), then those the
// service saved as pending. A confirmed or refused id (`settled`) is done, even
// while an older copy of the message still lists it.
export function unconfirmedReactions(message, local, settled) {
  const found = new Map()
  for (const [emoji, update] of Object.entries(local || {})) {
    if (update && !settled?.has(update.id)) found.set(emoji, update)
  }
  const saved = message?.reaction_updates && typeof message.reaction_updates === 'object'
    ? message.reaction_updates : {}
  for (const [emoji, update] of Object.entries(saved)) {
    if (found.has(emoji) || !update?.pending || typeof update.id !== 'string' || settled?.has(update.id)) continue
    found.set(emoji, { emoji, on: Boolean(update.on), id: update.id, detail: update.detail || '' })
  }
  return [...found.values()]
}
