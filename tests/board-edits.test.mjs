import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isEditTarget, postEditSettled, withoutReply, withPostEdit, withReplyEdit, withRestoredReply,
} from '../ui/boardEdits.js'

test('a confirmed post edit shows until the feed delivers it or a newer edit', () => {
  const post = { id: 'p', text: 'old' }
  const edit = { text: 'new', edited_at: 10 }
  assert.deepEqual(withPostEdit(post, edit), { id: 'p', text: 'new', edited_at: 10 })
  const caughtUp = { id: 'p', text: 'new', edited_at: 10 }
  assert.equal(withPostEdit(caughtUp, edit), caughtUp)
  assert.equal(postEditSettled(caughtUp, edit), true)
  const newer = { id: 'p', text: 'newer', edited_at: 12 }
  assert.equal(withPostEdit(newer, edit), newer)
  assert.equal(withPostEdit(post, { text: 'same', edited_at: null }), post)
})

test('a failed reply delete restores the reply once, in creation order', () => {
  const a = { id: 'a', created_at: 1 }
  const b = { id: 'b', created_at: 2 }
  const c = { id: 'c', created_at: 3 }
  const removed = withoutReply([a, b, c], 'b')
  assert.deepEqual(removed.map(r => r.id), ['a', 'c'])
  assert.deepEqual(withRestoredReply(removed, b).map(r => r.id), ['a', 'b', 'c'])
  const restored = withRestoredReply([a, b, c], b)
  assert.deepEqual(restored.map(r => r.id), ['a', 'b', 'c'])
})

test('a reply edit changes only that reply and keeps its edit time optional', () => {
  const replies = [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }]
  assert.deepEqual(withReplyEdit(replies, 'a', { text: 'z', edited_at: 5 }),
    [{ id: 'a', text: 'z', edited_at: 5 }, { id: 'b', text: 'y' }])
  assert.deepEqual(withReplyEdit(replies, 'a', { text: 'x', edited_at: null })[0], { id: 'a', text: 'x' })
})

test('only the item being edited matches the editor target', () => {
  const editing = { postId: 'p', replyId: 'r', saving: false }
  assert.equal(isEditTarget(editing, 'p', 'r'), true)
  assert.equal(isEditTarget(editing, 'p'), false)
  assert.equal(isEditTarget({ postId: 'p', replyId: null }, 'p'), true)
  assert.equal(isEditTarget(null, 'p'), false)
})
