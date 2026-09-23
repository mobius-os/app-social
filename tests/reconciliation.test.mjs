import assert from 'node:assert/strict'
import test from 'node:test'

import {
  boardRefreshDelay,
  optimisticReactionChange,
  reactionActionLabel,
  reactionState,
  reconcileFeedPage,
  reconcileReplies,
  replyActionLabel,
  threadRefreshDelay,
} from '../reconciliation.js'

test('authoritative replies replace settled local rows without hiding an in-flight reply', () => {
  const current = [
    { id: 'settled-local', text: 'landed', created_at: 2 },
    { id: 'pending-local', text: 'still sending', created_at: 4, pending: true },
  ]
  const authoritative = [
    { id: 'server-1', text: 'earlier', created_at: 1 },
    { id: 'server-2', text: 'landed', created_at: 3 },
  ]

  assert.deepEqual(
    reconcileReplies(authoritative, current).map(reply => reply.id),
    ['server-1', 'server-2', 'pending-local'],
  )
})

test('a canonical id never appears twice during reconciliation', () => {
  const reply = { id: 'same-id', text: 'hello', created_at: 1, pending: true }
  assert.deepEqual(reconcileReplies([{ ...reply, pending: false }], [reply]), [
    { ...reply, pending: false },
  ])
})

test('every post exposes a keyboard-named reply action, including empty threads', () => {
  assert.equal(replyActionLabel(0), 'Reply')
  assert.equal(replyActionLabel(1), '1 reply')
  assert.equal(replyActionLabel(12), '12 replies')
})

const post = (id, createdAt, extra = {}) => ({ id, created_at: createdAt, ...extra })

test('a first-page refresh removes remotely deleted rows from its owned range', () => {
  const current = [
    post('newest', 5), post('deleted', 4), post('third', 3),
    post('boundary', 2), post('older', 1),
  ]
  const authoritative = [
    post('newest', 5, { text: 'updated' }), post('third', 3), post('boundary', 2),
  ]

  const result = reconcileFeedPage(authoritative, current, 3)

  assert.deepEqual(result.map(item => item.id), ['newest', 'third', 'boundary', 'older'])
  assert.equal(result[0].text, 'updated')
})

test('a full first-page refresh retains every already-loaded older page', () => {
  const current = [5, 4, 3, 2, 1].map(value => post(`post-${value}`, value))
  const authoritative = [7, 6, 5].map(value => post(`post-${value}`, value))

  assert.deepEqual(
    reconcileFeedPage(authoritative, current, 3).map(item => item.id),
    ['post-7', 'post-6', 'post-5', 'post-4', 'post-3', 'post-2', 'post-1'],
  )
})

test('a short first page is a complete snapshot and removes stale older rows', () => {
  const current = [5, 4, 3, 2, 1].map(value => post(`post-${value}`, value))
  const authoritative = [post('post-5', 5), post('post-3', 3)]

  assert.deepEqual(
    reconcileFeedPage(authoritative, current, 3).map(item => item.id),
    ['post-5', 'post-3'],
  )
})

test('the timestamp boundary stays conservative and page ids remain unique', () => {
  const current = [
    post('stale-above', 10),
    post('canonical', 9, { text: 'old' }),
    post('same-time-spill', 9),
    post('older', 8),
    post('older', 8),
  ]
  const authoritative = [
    post('new', 11), post('canonical', 9, { text: 'fresh' }),
  ]

  const result = reconcileFeedPage(authoritative, current, 2)

  assert.deepEqual(
    result.map(item => item.id),
    ['new', 'canonical', 'same-time-spill', 'older'],
  )
  assert.equal(result[1].text, 'fresh')
})

test('emoji reactions isolate the selected reaction and preserve rollback state', () => {
  const post = { reactions: [
    { emoji: '❤️', count: 2, reacted: false },
    { emoji: '🎉', count: 1, reacted: true },
  ] }
  const { current, next } = optimisticReactionChange(post, null, '🎉')
  assert.deepEqual(current['❤️'], { count: 2, reacted: false })
  assert.deepEqual(next['❤️'], current['❤️'])
  assert.deepEqual(next['🎉'], { count: 0, reacted: false })
  assert.deepEqual(reactionState(post, next), next)

  const followUp = optimisticReactionChange(post, next, '🎉')
  assert.strictEqual(followUp.current, next)
  assert.deepEqual(followUp.next['🎉'], { count: 1, reacted: true })
})

test('reaction controls announce every supported count magnitude exactly', () => {
  for (const count of [9, 10, 999, 2000]) {
    assert.equal(
      reactionActionLabel({ count, reacted: false }, '🎉'),
      `Add 🎉 reaction. ${count} reactions`,
    )
  }
  assert.equal(
    reactionActionLabel({ count: 1, reacted: true }, '❤️'),
    'Remove ❤️ reaction. 1 reaction',
  )
})

test('visible Social surfaces refresh quickly after activity and relax when idle', () => {
  assert.equal(boardRefreshDelay(10_000, 20_000), 2500)
  assert.equal(boardRefreshDelay(1_000, 20_000), 15000)
  assert.equal(threadRefreshDelay(10_000, 20_000), 1500)
  assert.equal(threadRefreshDelay(1_000, 20_000), 5000)
})
