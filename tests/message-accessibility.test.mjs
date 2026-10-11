import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CSS } from '../theme.js'
import { canResendGroupMessage, deliveryLabel } from '../message_ui_state.js'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('delivery ticks and unread dots are named images in plain words', () => {
  assert.equal(deliveryLabel('sending'), 'Sending')
  assert.equal(deliveryLabel('failed'), 'Not delivered')
  assert.equal(deliveryLabel('delivered'), 'Delivered')
  assert.equal(deliveryLabel(undefined), 'Delivered')
  const timeline = read('ui/useMessageTimeline.jsx')
  assert.match(timeline, /<span className="cn-tick" role="img" aria-label=\{deliveryLabel\(status\)\}>/)
  for (const file of ['ui/Thread.jsx', 'ui/GroupThread.jsx']) {
    assert.match(read(file), /tick=\{mine && <DeliveryTick status=\{message\.status\} \/>\}/)
  }
  const inbox = read('ui/Messages.jsx')
  assert.equal(inbox.match(/<span className="cn-unread-dot" role="img" aria-label="Unread messages" \/>/g).length, 2)
})

test('a failed group photo offers retry only while its exact payload is still held', () => {
  assert.equal(canResendGroupMessage({ text: 'Hi' }), true)
  assert.equal(canResendGroupMessage({ attachment: { mime: 'image/png' }, _retry_attachment: { mime: 'image/png' } }), true)
  assert.equal(canResendGroupMessage({ attachment: { mime: 'image/png' } }), false)
})

test('reply focuses the composer and names whose message it answers', () => {
  const timeline = read('ui/useMessageTimeline.jsx')
  assert.match(timeline, /function replyTo\(target\) \{\n\s*setReplyTarget\(target\)\n\s*inputRef\.current\?\.focus\(\)/)
  assert.match(timeline, /function cancelReply\(\) \{\n\s*setReplyTarget\(null\)\n\s*inputRef\.current\?\.focus\(\)/)
  assert.match(timeline, /<ReplyTarget reply=\{replyTarget\} onDismiss=\{cancelReply\} \/>/)
  const bubble = read('ui/MessageBubble.jsx')
  // One DOM order for every bubble: the reply button always follows it.
  assert.equal(bubble.match(/className="cn-bubble-reply"/g).length, 1)
  assert.ok(bubble.indexOf('className={`cn-bubble ') < bubble.indexOf('className="cn-bubble-reply"'))
  assert.match(bubble, /mine \? 'Reply to your message' : author \? `Reply to \$\{handleLabel\(author\)\}`/)
  assert.match(CSS, /\.cn-message-line\.is-mine \.cn-bubble-reply \{ order: -1; \}/)
})

test('the inbox switch is a pair of pressed toggle buttons, not an incomplete tab widget', () => {
  const inbox = read('ui/Messages.jsx')
  assert.doesNotMatch(inbox, /role="tab"|role="tablist"|aria-selected/)
  assert.match(inbox, /role="group" aria-label="Message inbox"/)
  assert.equal(inbox.match(/aria-pressed=\{!?showingRequests\}/g).length, 2)
})

test('message chrome stays legible, uncopied and at least 44px to touch', () => {
  assert.match(CSS, /\.cn-bubble-time \{[^}]*user-select: none; -webkit-user-select: none;/)
  assert.match(CSS, /\.cn-bubble\.is-mine \.cn-bubble-time \{ opacity: 1; \}/)
  assert.match(CSS, /\.cn-bubble\.is-mine \.cn-quote span \{ opacity: 1; \}/)
  assert.match(CSS, /\.cn-failed-note \{[^}]*min-height: 44px;[^}]*color: var\(--text\);/)
  assert.match(CSS, /\.cn-failed-note svg \{[^}]*color: var\(--danger\);/)
  assert.match(CSS, /\.cn-history-more \{[^}]*min-height: 44px;/)
  assert.match(CSS, /\.cn-message-tabs button \{[^}]*min-height: 44px;[^}]*background-clip: padding-box;/)
  assert.match(CSS, /\.cn-message-log \{ display: flex; flex-direction: column; gap: 8px; \}/)
})
