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

// Run the real hook with a minimal React state stand-in: each render reads the
// state the previous calls left, the way React would on the next render.
async function reactionHook({ send, ownHost = 'me.example' }) {
  const { isDefinitePrecommitRejection, unconfirmedReactions } = await import('../message_ui_state.js')
  const body = source.slice(source.indexOf('/** Counts'), source.indexOf('/** An unconfirmed own reaction'))
    .replace(/export function/g, 'function')
  const slots = []
  let index = 0
  const useState = (initial) => {
    const slot = index++
    if (!(slot in slots)) slots[slot] = initial
    return [slots[slot], (next) => { slots[slot] = typeof next === 'function' ? next(slots[slot]) : next }]
  }
  const useRef = (initial) => {
    const slot = index++
    if (!(slot in slots)) slots[slot] = { current: initial }
    return slots[slot]
  }
  const useMessageReactions = new Function(
    'useState', 'useRef', 'BOARD_REACTION_EMOJIS', 'isDefinitePrecommitRejection', 'unconfirmedReactions',
    `${body}; return useMessageReactions`,
  )(useState, useRef, ['❤️', ':mobius:', '🎉'], isDefinitePrecommitRejection, unconfirmedReactions)
  const errors = []
  let ids = 0
  const render = () => {
    index = 0
    return useMessageReactions({
      ownHost, send, onError: error => errors.push(error.message), newId: () => `u-${++ids}`,
    })
  }
  return { render, errors }
}

const delivered = { id: 'm-1', dir: 'in', status: 'delivered', reactions: {} }
const lost = () => Object.assign(new Error('Request timed out'), { status: undefined })

test('a reaction whose answer was lost stays shown and retries the same update', async () => {
  const sent = []
  let answer = () => { throw lost() }
  const hook = await reactionHook({ send: async (...args) => { sent.push(args); return answer() } })
  await hook.render().toggle(delivered, ':mobius:')
  let view = hook.render()
  assert.equal(view.stateFor(delivered)[':mobius:'].reacted, true, 'the tap is not silently dropped')
  assert.deepEqual(view.unconfirmedFor(delivered), {
    emoji: ':mobius:', on: true, id: 'u-1', detail: 'Confirmation was interrupted; this reaction may have arrived.',
  })
  assert.deepEqual(hook.errors, ['Request timed out'])

  answer = () => ({ status: 'delivered', reactions: { ':mobius:': { 'me.example': 5 } } })
  await view.retry(delivered)
  view = hook.render()
  assert.deepEqual(sent, [['m-1', ':mobius:', true, 'u-1'], ['m-1', ':mobius:', true, 'u-1']])
  assert.equal(view.unconfirmedFor(delivered), null)
  assert.equal(view.stateFor(delivered)[':mobius:'].reacted, true)
})

test('a reaction the service saved as pending offers a retry, even after a reload', async () => {
  const sent = []
  const hook = await reactionHook({ send: async (...args) => {
    sent.push(args)
    return { status: 'pending', detail: 'The reply was lost.', reactions: { '🎉': { 'me.example': 5 } } }
  } })
  await hook.render().toggle(delivered, '🎉')
  assert.deepEqual(hook.render().unconfirmedFor(delivered), { emoji: '🎉', on: true, id: 'u-1', detail: 'The reply was lost.' })
  assert.deepEqual(hook.errors, ['The reply was lost.'])

  // A fresh view knows the pending update only from the saved message.
  const saved = { ...delivered, reactions: { '🎉': { 'me.example': 5 } }, reaction_updates: {
    '🎉': { id: 'u-9', on: true, at: 5, pending: true, detail: 'The reply was lost.' },
  } }
  const reloaded = await reactionHook({ send: async (...args) => { sent.push(args); return { status: 'delivered', reactions: saved.reactions } } })
  const view = reloaded.render()
  assert.equal(view.stateFor(saved)['🎉'].reacted, true)
  await view.retry(saved)
  assert.deepEqual(sent.at(-1), ['m-1', '🎉', true, 'u-9'])
  assert.equal(reloaded.render().unconfirmedFor(saved), null)
})

test('only a definite refusal takes a reaction back', async () => {
  const hook = await reactionHook({ send: async () => {
    throw Object.assign(new Error('This person’s Social refused the reaction.'), { status: 409 })
  } })
  await hook.render().toggle(delivered, '❤️')
  const view = hook.render()
  assert.equal(view.stateFor(delivered)['❤️'].reacted, false)
  assert.equal(view.unconfirmedFor(delivered), null)
})

test('threads show the reaction retry beside each message', () => {
  for (const file of ['../ui/Thread.jsx', '../ui/GroupThread.jsx']) {
    const thread = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.match(thread, /<ReactionRetryNote key=\{`react-\$\{message\.id\}`\} message=\{message\} mine=\{mine\} reactions=\{messageReactions\} \/>/)
    assert.match(thread, /send: \(id, emoji, on, updateId\) =>/)
  }
})

test('every reaction request carries its update id', async () => {
  const { reactToGroupMessage, reactToMessage } = await import('../api.js')
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push([url, JSON.parse(options.body)])
    return { ok: true, status: 200, async json() { return { status: 'delivered' } } }
  }
  try {
    await reactToMessage('peer.example', 'm-1', '🎉', true, 'u-1')
    await reactToGroupMessage('deadbeef', 'm-2', '🎉', false, 'u-2')
  } finally { delete globalThis.fetch }
  assert.deepEqual(requests.map(([, body]) => body), [
    { emoji: '🎉', on: true, id: 'u-1' }, { emoji: '🎉', on: false, id: 'u-2' },
  ])
})
