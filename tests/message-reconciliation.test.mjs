import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isDefinitePrecommitRejection, mergeMessages, reconcileLatestPage,
  reconcileOlderPage, settleMessage, settleOptimistic,
} from '../message_ui_state.js'

const message = (id, sentAt, status = 'delivered') => ({
  id, sent_at: sentAt, status,
})

test('first successful recovery establishes its older-history cursor', () => {
  const result = reconcileLatestPage(null, {
    messages: [message('new', 2)], next_cursor: 'older-page',
  })
  assert.equal(result.resetCursor, true)
  assert.equal(result.nextCursor, 'older-page')
  assert.deepEqual(result.messages.map(({ id }) => id), ['new'])
})

test('an initially empty thread establishes its older-history cursor', () => {
  const result = reconcileLatestPage([], {
    messages: [message('new', 2)], next_cursor: 'older-page',
  })
  assert.equal(result.resetCursor, true)
  assert.equal(result.nextCursor, 'older-page')
  assert.deepEqual(result.messages.map(({ id }) => id), ['new'])
})

test('overlapping latest refresh preserves already-loaded continuous history', () => {
  const result = reconcileLatestPage([
    message('old', 1), message('boundary', 2),
  ], {
    messages: [message('boundary', 2), message('new', 3)],
    next_cursor: 'newest-page-cursor',
  })
  assert.equal(result.resetCursor, false)
  assert.deepEqual(result.messages.map(({ id }) => id), ['old', 'boundary', 'new'])
})

test('non-overlapping full refresh restarts pagination instead of hiding a gap', () => {
  const result = reconcileLatestPage([
    message('old-a', 1), message('old-b', 2),
  ], {
    messages: [message('new-a', 100), message('new-b', 101)],
    next_cursor: 'restart-here',
  })
  assert.equal(result.resetCursor, true)
  assert.equal(result.nextCursor, 'restart-here')
  assert.deepEqual(result.messages.map(({ id }) => id), ['new-a', 'new-b'])
})

test('gap recovery preserves an ambiguous local submission identity', () => {
  const pending = { ...message('local-pending', 3, 'sending'), _client_retry: true }
  const result = reconcileLatestPage([
    message('old-a', 1), message('old-b', 2), pending,
  ], {
    messages: [message('new-a', 100), message('new-b', 101)],
    next_cursor: 'restart-here',
  })
  assert.equal(result.resetCursor, true)
  assert.deepEqual(result.messages.map(({ id }) => id), [
    'local-pending', 'new-a', 'new-b',
  ])
})

test('gap recovery prefers an authoritative row over its pending copy', () => {
  const pending = { ...message('same', 3, 'sending'), _client_retry: true }
  const result = reconcileLatestPage([message('old', 1), pending], {
    messages: [message('same', 3, 'delivered')], next_cursor: 'restart-here',
  })
  assert.equal(result.resetCursor, true)
  assert.deepEqual(result.messages, [message('same', 3, 'delivered')])
})

test('a pending identity overlap cannot hide an intervening history gap', () => {
  const pending = { ...message('same', 1000, 'sending'), _client_retry: true }
  const result = reconcileLatestPage([
    message('old', 1), pending,
  ], {
    messages: [message('new', 999), message('same', 1000)],
    next_cursor: 'restart-at-999',
  })
  assert.equal(result.resetCursor, true)
  assert.equal(result.nextCursor, 'restart-at-999')
  assert.deepEqual(result.messages.map(({ id }) => id), ['new', 'same'])
})

test('settling a group send replaces its one optimistic identity', () => {
  const result = settleOptimistic([
    message('before', 1), message('local-one', 2, 'sending'),
  ], 'local-one', { id: 'server-one', status: 'delivered' })
  assert.deepEqual(result.map(({ id, status }) => [id, status]), [
    ['before', 'delivered'], ['server-one', 'delivered'],
  ])
  assert.equal(mergeMessages(result, [message('server-one', 2)]).length, 2)
})

test('settling a group send deduplicates an early polled server row', () => {
  const result = settleOptimistic([
    message('local-one', 2, 'sending'), message('server-one', 2, 'delivered'),
  ], 'local-one', { id: 'server-one', status: 'delivered' })
  assert.deepEqual(result.map(({ id, status }) => [id, status]), [
    ['server-one', 'delivered'],
  ])
})

test('only a definite local rejection restores a draft for a new send', () => {
  assert.equal(isDefinitePrecommitRejection({ status: 409 }), true)
  assert.equal(isDefinitePrecommitRejection({ status: 500 }), false)
  assert.equal(isDefinitePrecommitRejection(new TypeError('lost response')), false)
})

test('retry settles an older loaded row without depending on the newest page', () => {
  const result = settleMessage([
    message('old-failed', 1, 'failed'), message('latest', 100),
  ], 'old-failed', { status: 'delivered' })
  assert.deepEqual(result.map(({ id, status }) => [id, status]), [
    ['old-failed', 'delivered'], ['latest', 'delivered'],
  ])
})

test('a successful direct-send response settles before any refresh result', () => {
  const result = settleMessage([
    { ...message('sent', 1, 'sending'), _client_retry: true },
  ], 'sent', { id: 'sent', status: 'delivered' })
  assert.deepEqual(result.map(({ id, status, _client_retry }) => ({
    id, status, _client_retry,
  })), [{ id: 'sent', status: 'delivered', _client_retry: undefined }])
})

test('a failed direct-send response settles to retryable failure immediately', () => {
  const result = settleMessage([
    { ...message('sent', 1, 'sending'), _client_retry: true },
  ], 'sent', { id: 'sent', status: 'failed', detail: 'Peer unavailable' })
  assert.equal(result[0].status, 'failed')
  assert.equal(result[0].failure, 'Peer unavailable')
  assert.equal(result[0]._client_retry, undefined)
})

test('settled local send cannot falsely prove newest-page continuity', () => {
  const settled = settleMessage([
    message('old', 1), {
      ...message('same', 1000, 'sending'),
      _client_retry: true,
      _client_unconfirmed_history: true,
    },
  ], 'same', { id: 'same', status: 'delivered' })
  const result = reconcileLatestPage(settled, {
    messages: [message('remote', 999), message('same', 1000, 'delivered')],
    next_cursor: 'restart-at-999',
  })
  assert.equal(result.resetCursor, true)
  assert.equal(result.nextCursor, 'restart-at-999')
  assert.deepEqual(result.messages, [
    message('remote', 999), message('same', 1000, 'delivered'),
  ])
})

test('settled group send cannot falsely prove newest-page continuity', () => {
  const settled = settleOptimistic([
    message('old', 1), {
      ...message('local', 1000, 'sending'),
      _client_pending: true,
      _client_unconfirmed_history: true,
    },
  ], 'local', { id: 'same', status: 'delivered' })
  const result = reconcileLatestPage(settled, {
    messages: [message('remote', 999), message('same', 1000, 'delivered')],
    next_cursor: 'restart-at-999',
  })
  assert.equal(result.resetCursor, true)
  assert.deepEqual(result.messages, [
    message('remote', 999), message('same', 1000, 'delivered'),
  ])
})

test('deferred older page cannot overwrite a reset pagination chain', () => {
  let generation = 0
  const olderRequestGeneration = generation
  const reset = reconcileLatestPage([
    message('old', 100),
  ], {
    messages: [message('latest', 200)], next_cursor: 'before-200',
  })
  assert.equal(reset.resetCursor, true)
  generation += 1

  const deferred = reconcileOlderPage(reset.messages, {
    messages: [message('earlier', 50)], next_cursor: 'before-50',
  }, olderRequestGeneration, generation)
  assert.equal(deferred, null)
  assert.deepEqual(reset.messages, [message('latest', 200)])
  assert.equal(reset.nextCursor, 'before-200')
})
