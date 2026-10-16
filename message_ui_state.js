export function mergeMessages(...pages) {
  const byId = new Map()
  for (const page of pages) {
    for (const message of page || []) byId.set(message.id, message)
  }
  return [...byId.values()].sort((a, b) =>
    (a.sent_at || 0) - (b.sent_at || 0) || String(a.id).localeCompare(String(b.id)))
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
