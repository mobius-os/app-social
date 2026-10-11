import assert from 'node:assert/strict'
import test from 'node:test'

import { readFileSync } from 'node:fs'

import { TEXT_LIMITS } from '../participation.js'
import {
  editorHasChanges, editTargetShown, isEditTarget, postEditSettled, withoutReply, withPostEdit, withReplyEdit, withRestoredReply,
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

test('only unsaved text holds the editor open against another edit', () => {
  assert.equal(editorHasChanges(null), false)
  assert.equal(editorHasChanges({ initial: 'Hi', text: 'Hi ' }), false)
  assert.equal(editorHasChanges({ initial: 'Hi', text: 'Hi there' }), true)
  assert.equal(editorHasChanges({ initial: '', text: '' }), false)
})

test('an editor closes once its post or reply is no longer shown', () => {
  const view = {
    feed: [{ id: 'p' }, { id: 'q' }], hiddenIds: new Set(['q']),
    replyPostId: 'p', replies: [{ id: 'r' }],
  }
  assert.equal(editTargetShown({ postId: 'p', replyId: null }, view), true)
  assert.equal(editTargetShown({ postId: 'q', replyId: null }, view), false, 'deleted here')
  assert.equal(editTargetShown({ postId: 'gone', replyId: null }, view), false, 'deleted elsewhere')
  assert.equal(editTargetShown({ postId: 'p', replyId: 'r' }, view), true)
  assert.equal(editTargetShown({ postId: 'p', replyId: 'x' }, view), false, 'reply deleted')
  assert.equal(editTargetShown({ postId: 'p', replyId: 'r' }, { ...view, replyPostId: null }), false, 'thread closed')
  assert.equal(editTargetShown(null, view), false)
})

test('editor and composer limits match the protocol limits', () => {
  const protocol = readFileSync(new URL('../common_protocol.py', import.meta.url), 'utf8')
  const limit = (name) => Number(protocol.match(new RegExp(`^${name}\\s*=\\s*([\\d_]+)`, 'm'))?.[1].replaceAll('_', ''))
  assert.equal(TEXT_LIMITS.post, limit('MAX_POST_TEXT_CHARS'))
  assert.equal(TEXT_LIMITS.reply, limit('MAX_REPLY_TEXT_CHARS'))
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(board, /maxLength=\{\d/, 'Board takes every text limit from TEXT_LIMITS')
})
