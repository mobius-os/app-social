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
      && !message._client_pending
      && !message._client_unconfirmed_history
    ))
    .map((message) => message.id))
  const lostContinuity = !replace && prior?.length > 0 && page?.next_cursor &&
    !incoming.some((message) => priorIds.has(message.id))
  const resetCursor = replace || prior === null || lostContinuity
  const pendingLocal = (prior || []).filter((message) =>
    message._client_retry || message._client_pending || message._client_unconfirmed_history)
  return {
    // When a pending id has already reached the server, its authoritative row
    // must replace the optimistic copy rather than be overwritten by it.
    messages: resetCursor ? mergeMessages(pendingLocal, incoming) : mergeMessages(prior, incoming),
    nextCursor: page?.next_cursor || null,
    resetCursor,
  }
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

export function settleOptimistic(messages, optimisticId, result) {
  const prior = messages || []
  const optimistic = prior.find((message) => message.id === optimisticId)
  if (!optimistic) return prior
  const remaining = prior.filter((message) => message.id !== optimisticId)
  const resultId = result.id || optimistic.id
  // Polling may have already inserted the server row before the POST reply.
  // In that case retain that authoritative copy and remove only the local one.
  if (remaining.some((message) => message.id === resultId)) {
    return mergeMessages(remaining)
  }
  const { _client_pending, ...saved } = optimistic
  return mergeMessages(remaining, [{
    ...saved,
    id: resultId,
    status: result.status || 'delivered',
  }])
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
