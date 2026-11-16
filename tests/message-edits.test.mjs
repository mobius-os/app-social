import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mergeMessages, refreshLoadedRows } from '../message_ui_state.js'
import { applyEditResult, editIdFor } from '../ui/messageEdits.js'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('the copy with the newer edit state wins, including a rollback after a refusal', () => {
  const edited = { id: 'm', sent_at: 1, text: 'Hello', edited_at: 20, edit_rev: 1 }
  const stale = { id: 'm', sent_at: 1, text: 'Hi', reaction_rev: 3 }
  const [merged] = mergeMessages([edited], [stale])
  assert.equal(merged.text, 'Hello')
  // Reactions still come from the copy that has seen more reaction changes.
  assert.equal(merged.reaction_rev, 3)
  assert.equal(refreshLoadedRows([edited], [stale])[0].text, 'Hello')
  // A refused edit rolls back to the old text with a higher revision, and that wins.
  const rolledBack = { id: 'm', sent_at: 1, text: 'Hi', edit_rev: 3 }
  assert.equal(mergeMessages([edited], [rolledBack])[0].text, 'Hi')
  assert.equal(mergeMessages([rolledBack], [edited])[0].text, 'Hi')
  assert.equal(refreshLoadedRows([edited], [rolledBack])[0].text, 'Hi')
})

test('a late save reply never overwrites a newer edit state on screen', () => {
  const row = { id: 'm', text: 'Newer', edit_rev: 5 }
  assert.equal(applyEditResult(row, { text: 'Older', edit_rev: 2 }), row)
  const saved = applyEditResult(row, { text: 'Newest', edit_rev: 6, edit_id: 'e-9', pending: true, detail: 'lost' })
  assert.deepEqual([saved.text, saved.edit_rev, saved.edit.id, saved.edit.pending], ['Newest', 6, 'e-9', true])
})

test('saving a pending edit again reuses its id; anything else gets a new one', () => {
  const message = { edit: { id: 'e-1', text: 'Hello', pending: true } }
  assert.equal(editIdFor(message, 'Hello', () => 'fresh'), 'e-1')
  assert.equal(editIdFor(message, 'Different', () => 'fresh'), 'fresh')
  assert.equal(editIdFor({ edit: { id: 'e-1', text: 'Hello', pending: false } }, 'Hello', () => 'fresh'), 'fresh')
})

test('Edit is offered only on your own delivered text, right after the reaction button', () => {
  const bubble = read('ui/MessageBubble.jsx')
  assert.match(bubble, /const canEdit = mine && !!edits\?\.canEdit && message\.status === 'delivered'/)
  assert.match(bubble, /!splitGifMessage\(message\.text\)/)
  assert.ok(bubble.indexOf('<MessageReactButton') < bubble.indexOf('aria-label="Edit message"'))
  assert.ok(bubble.indexOf('aria-label="Edit message"') < bubble.indexOf('className="cn-bubble-reply" type="button" onClick={onReply}'))
  // Enter saves and Escape cancels, inside the bubble.
  assert.match(bubble, /event\.key === 'Escape'[\s\S]*onCancel\(\)/)
  assert.match(bubble, /event\.key === 'Enter' && !event\.shiftKey/)
  // Saving unchanged text resends an unconfirmed edit instead of just closing.
  assert.match(bubble, /if \(unchanged && !resendable\) \{ onCancel\(\); return \}/)
})

test('both conversations only offer Edit where the other side supports edits', () => {
  assert.match(read('ui/Thread.jsx'), /const canEdit = !requestPending && supportsMessageEdits\(peerActor\)/)
  assert.match(read('ui/GroupThread.jsx'), /\(hostedHere \|\| hostEdits\)/)
  assert.match(read('ui/messageEdits.js'), /actor\.features\.includes\('message_edits'\)/)
})
