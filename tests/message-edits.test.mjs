import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mergeMessages, refreshLoadedRows } from '../message_ui_state.js'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('an older copy of a message never brings back text that was edited since', () => {
  const edited = { id: 'm', sent_at: 1, text: 'Hello', edited_at: 20 }
  const stale = { id: 'm', sent_at: 1, text: 'Hi', reaction_rev: 3 }
  const [merged] = mergeMessages([edited], [stale])
  assert.equal(merged.text, 'Hello')
  assert.equal(merged.edited_at, 20)
  // Reactions still come from the copy that has seen more reaction changes.
  assert.equal(merged.reaction_rev, 3)
  assert.equal(refreshLoadedRows([edited], [stale])[0].text, 'Hello')
  // A newer edit wins whichever way round the copies arrive.
  const newer = { id: 'm', sent_at: 1, text: 'Hey', edited_at: 30 }
  assert.equal(mergeMessages([newer], [edited])[0].text, 'Hey')
  assert.equal(mergeMessages([edited], [newer])[0].text, 'Hey')
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
})

test('both conversations only offer Edit where the other side supports edits', () => {
  assert.match(read('ui/Thread.jsx'), /const canEdit = !requestPending && supportsMessageEdits\(peerActor\)/)
  assert.match(read('ui/GroupThread.jsx'), /\(hostedHere \|\| hostEdits\)/)
  assert.match(read('ui/messageEdits.js'), /actor\.features\.includes\('message_edits'\)/)
})
