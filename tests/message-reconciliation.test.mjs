import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addUnseenMessages, isDefinitePrecommitRejection, mergeMessages, reconcileLatestPage,
  reconcileOlderPage, settleMessage,
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

test('a send settles in place under its one client identity, direct or group', () => {
  const result = settleMessage([
    message('before', 1),
    { ...message('one', 2, 'sending'), _client_retry: true, _retry_attachment: { mime: 'image/png' } },
  ], 'one', { id: 'one', status: 'delivered', failed_members: [] })
  assert.deepEqual(result.map(({ id, status }) => [id, status]), [
    ['before', 'delivered'], ['one', 'delivered'],
  ])
  assert.equal(result[1]._retry_attachment, undefined)
  // The server row has the same id, so a refresh replaces rather than duplicates it.
  assert.equal(mergeMessages(result, [message('one', 2)]).length, 2)
})

test('an interrupted send already polled from the server never shows twice', () => {
  const pending = [{ ...message('one', 2, 'sending'), _client_retry: true, _client_unconfirmed_history: true }]
  const polled = addUnseenMessages(pending, { messages: [message('one', 2, 'delivered')] })
  assert.equal(polled.length, 1)
  const refreshed = reconcileLatestPage(polled, { messages: [message('one', 2, 'delivered')], next_cursor: null })
  assert.deepEqual(refreshed.messages, [message('one', 2, 'delivered')])
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

test('a published first-paint page only adds unseen messages and never rewinds one on screen', () => {
  const shown = [
    { id: 'a', sent_at: 1, status: 'delivered' },
    { id: 'b', sent_at: 2, status: 'delivered' },
  ]
  const olderPage = { messages: [{ id: 'b', sent_at: 2, status: 'sending' }], next_cursor: null }
  assert.equal(addUnseenMessages(shown, olderPage), shown)

  const arrived = { messages: [
    { id: 'b', sent_at: 2, status: 'sending' },
    { id: 'c', sent_at: 3, dir: 'in' },
  ], next_cursor: null }
  assert.deepEqual(addUnseenMessages(shown, arrived), [
    { id: 'a', sent_at: 1, status: 'delivered' },
    { id: 'b', sent_at: 2, status: 'delivered' },
    { id: 'c', sent_at: 3, dir: 'in' },
  ])
})
