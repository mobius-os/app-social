import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CSS } from '../theme.js'
import { deliveryLabel } from '../message_ui_state.js'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('delivery ticks and unread dots are named images in plain words', () => {
  assert.equal(deliveryLabel('sending'), 'Sending')
  assert.equal(deliveryLabel('failed'), 'Delivery failed')
  assert.equal(deliveryLabel('delivered'), 'Delivered')
  assert.equal(deliveryLabel(undefined), 'Delivered')
  const timeline = read('ui/useMessageTimeline.jsx')
  assert.match(timeline, /<span className="cn-tick" role="img" aria-label=\{deliveryLabel\(status\)\}>/)
  for (const file of ['ui/Thread.jsx', 'ui/GroupThread.jsx']) {
    assert.match(read(file), /tick=\{mine && <DeliveryTick status=\{message\.status\} \/>\}/)
  }
  const inbox = read('ui/Messages.jsx')
  assert.match(inbox, /<span className="cn-unread-count" role="img" aria-label=\{`\$\{unread\} unread`\}>/)
})

test('reply buttons name whose message they answer, in one reading order', () => {
  // Focus after reply and dismiss is exercised in message-retry.test.mjs.
  assert.match(read('ui/useMessageTimeline.jsx'), /<ReplyTarget reply=\{replyTarget\} onDismiss=\{cancelReply\} \/>/)
  const bubble = read('ui/MessageBubble.jsx')
  // One DOM order for every bubble: the action toolbar, with its one Reply, follows it.
  assert.equal(bubble.match(/onClick=\{onReply\}/g).length, 1)
  assert.ok(bubble.indexOf('className={`cn-bubble ') < bubble.indexOf('<MessageToolbar '))
  assert.match(bubble, /mine \? 'Reply to your message' : author \? `Reply to \$\{handleLabel\(author\)\}`/)
  // Your own messages keep the same toolbar order as everyone else's.
  assert.match(CSS, /\.cn-message-line\.is-mine \.cn-msg-toolbar \.cn-bubble-reply \{ order: 0; \}/)
})

test('inbox sections are disclosure buttons, not an incomplete tab widget', () => {
  const inbox = read('ui/Messages.jsx')
  assert.doesNotMatch(inbox, /role="tab"|role="tablist"|aria-selected/)
  assert.match(inbox, /aria-expanded=\{open\} aria-controls=\{`\$\{id\}-rows`\}/)
  assert.match(inbox, /className="cn-fab" aria-label="New conversation"/)
})

test('message chrome stays legible, uncopied and at least 44px to touch', () => {
  assert.match(CSS, /\.cn-bubble-time \{[^}]*user-select: none; -webkit-user-select: none;/)
  // Own bubbles share the dark outlined fill, so their time and quotes read like everyone else's.
  assert.doesNotMatch(CSS, /\.cn-bubble\.is-mine \{[^}]*background: var\(--accent\)/)
  assert.match(CSS, /\.cn-failed-note \{[^}]*min-height: 44px;[^}]*color: var\(--text\);/)
  assert.match(CSS, /\.cn-failed-note svg \{[^}]*color: var\(--danger\);/)
  assert.match(CSS, /\.cn-history-more \{[^}]*min-height: 44px;/)
  assert.match(CSS, /\.cn-inbox-heading button \{[^}]*min-height: 44px;/)
  assert.match(CSS, /\.cn-message-log \{ display: flex; flex-direction: column; gap: 8px;[^}]*\}/)
})

test('the message log announces arrivals, not the backlog present when it opens', () => {
  const timeline = read('ui/useMessageTimeline.jsx')
  assert.match(timeline, /role=\{messages === null \? undefined : 'log'\}/)
  assert.match(timeline, /aria-busy=\{loadingEarlier\}/)
})
