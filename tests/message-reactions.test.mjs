import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../ui/MessageReactions.jsx', import.meta.url), 'utf8')

test('message reactions count every host and know which one is the owner', async () => {
  // The component file imports React and icons; evaluate only its pure helpers.
  const helpers = source.slice(source.indexOf('/** Counts'), source.indexOf('const clockOf'))
    .replace(/export function/g, 'function')
  const { messageReactionState, supportsMessageReactions } = new Function(
    'BOARD_REACTION_EMOJIS',
    `${helpers}; return { messageReactionState, supportsMessageReactions }`,
  )(['❤️', ':mobius:', '🎉'])
  const state = messageReactionState({ reactions: {
    ':mobius:': { 'me.example': 1, 'pal.example': 2 }, '🎉': { 'pal.example': 3 },
  } }, 'me.example')
  assert.deepEqual(state, {
    '❤️': { count: 0, reacted: false },
    ':mobius:': { count: 2, reacted: true },
    '🎉': { count: 1, reacted: false },
  })
  assert.equal(messageReactionState({}, 'me.example')['🎉'].count, 0)
  assert.equal(supportsMessageReactions({ features: ['message_reactions'] }), true)
  assert.equal(supportsMessageReactions({}), false)
})

test('bubbles offer reactions only for delivered messages and keep one action order', () => {
  const bubble = readFileSync(new URL('../ui/MessageBubble.jsx', import.meta.url), 'utf8')
  const theme = readFileSync(new URL('../theme.js', import.meta.url), 'utf8')
  assert.match(bubble, /const canReact = !!reactions\?\.canReact && message\.status === 'delivered'/)
  assert.match(theme, /\.cn-message-line\.is-mine \.cn-bubble-actions \{ order: -1; \}/)
  // The add button shares the reply button's hover and touch visibility.
  assert.match(source, /className="cn-bubble-reply cn-bubble-react"/)
  for (const file of ['../ui/Thread.jsx', '../ui/GroupThread.jsx']) {
    const thread = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.match(thread, /supportsMessageReactions\(/)
    assert.match(thread, /onClose: closePicker/)
  }
})
