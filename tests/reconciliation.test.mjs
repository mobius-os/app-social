import assert from 'node:assert/strict'
import test from 'node:test'

import {
  boardRefreshDelay,
  optimisticLikeChange,
  optimisticReactionChange,
  reactionState,
  reconcileReplies,
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

test('a failed follow-up like can restore the last confirmed local state', () => {
  const confirmed = { liked: true, count: 3 }
  const change = optimisticLikeChange({ liked: false, like_count: 2 }, confirmed)

  assert.deepEqual(change.next, { liked: false, count: 2 })
  assert.strictEqual(change.current, confirmed)
})

test('emoji reactions optimistically change only the selected reaction', () => {
  const post = { reactions: [
    { emoji: '❤️', count: 2, reacted: false },
    { emoji: '🎉', count: 1, reacted: true },
  ] }
  const { current, next } = optimisticReactionChange(post, null, '🎉')
  assert.deepEqual(current['❤️'], { count: 2, reacted: false })
  assert.deepEqual(next['❤️'], current['❤️'])
  assert.deepEqual(next['🎉'], { count: 0, reacted: false })
  assert.deepEqual(reactionState(post, next), next)
})

test('visible Social surfaces refresh quickly after activity and relax when idle', () => {
  assert.equal(boardRefreshDelay(10_000, 20_000), 2500)
  assert.equal(boardRefreshDelay(1_000, 20_000), 15000)
  assert.equal(threadRefreshDelay(10_000, 20_000), 1500)
  assert.equal(threadRefreshDelay(1_000, 20_000), 5000)
})
