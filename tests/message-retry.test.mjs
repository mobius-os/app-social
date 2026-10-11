import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { retryGroupMessage, retryMessage, sendGroupMessage, sendMessage } from '../api.js'
import { isDefinitePrecommitRejection, markDeliveryUnknown, settleMessage } from '../message_ui_state.js'

const timelineSource = readFileSync(new URL('../ui/useMessageTimeline.jsx', import.meta.url), 'utf8')

// Run the hook's own function bodies with their React state mocked.
function owning(source, start, end, deps) {
  const a = source.indexOf(start)
  const b = source.indexOf(end, a)
  assert.ok(a >= 0 && b > a, `${start} exists`)
  return Function('deps', `with (deps) { return (${source.slice(a, b).trim()}) }`)(deps)
}

function server(routes) {
  const requests = []
  globalThis.fetch = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null
    requests.push({ url, body })
    const [status, payload] = routes(url, body)
    return { ok: status < 400, status, async json() { return payload } }
  }
  return requests
}

// The group thread wires exactly these: the saved-copy retry route, and the
// stable-id send used only when the server never saved the message.
function retryHarness(conversation, messages) {
  const toasts = []
  const deps = {
    retrying: '', sending: false, retryFailedText: 'Still unreachable.',
    setRetrying: (value) => { deps.retrying = value },
    messages, settleMessage, markDeliveryUnknown, isDefinitePrecommitRejection,
    updateMessages: (next) => { deps.messages = next(deps.messages) },
    showToast: (text, kind) => toasts.push([kind, text]),
    refresh: async () => {},
    ...conversation,
  }
  return { deps, toasts, retry: owning(timelineSource, 'async function retry(message) {', '\n  return {', deps) }
}

const group = {
  retrySaved: (id) => retryGroupMessage('deadbeef', id),
  deliver: ({ id, text, attachment, reply }) => sendGroupMessage(id, 'deadbeef', text, attachment, reply),
}

test('a failed group photo, even after a reload, retries from the server’s saved copy', async () => {
  // Loaded from history: no local photo payload remains on this device.
  const failed = { id: 'm-1', dir: 'out', text: 'Look', status: 'failed', attachment: { mime: 'image/png', w: 4, h: 3 } }
  const requests = server(() => [200, { status: 'delivered', id: 'm-1', detail: null }])
  const view = retryHarness(group, [failed])
  try {
    await view.retry(failed)
  } finally { delete globalThis.fetch }
  assert.deepEqual(requests, [{ url: '/api/services/social/groups/deadbeef/messages/m-1/retry', body: {} }])
  assert.deepEqual(view.deps.messages.map(({ id, status }) => [id, status]), [['m-1', 'delivered']])
  assert.deepEqual(view.toasts, [['success', 'Message delivered']])
  assert.equal(view.deps.retrying, '')
})

test('a group send interrupted before the server saved it is re-sent once under the same id', async () => {
  const photo = { mime: 'image/png', data_b64: 'cGhvdG8=', w: 4, h: 3 }
  const reply = { id: 'r-1', author_handle: 'friend', excerpt: 'Hi' }
  const interrupted = { id: 'm-2', dir: 'out', text: 'Look', status: 'sending', _client_retry: true, _retry_attachment: photo, reply_to: reply }
  const requests = server((url) => url.endsWith('/retry')
    ? [404, { detail: 'Message not found.' }]
    : [200, { status: 'delivered', id: 'm-2', failed_members: [] }])
  const view = retryHarness(group, [interrupted])
  try {
    await view.retry(interrupted)
  } finally { delete globalThis.fetch }
  assert.deepEqual(requests.map(({ url }) => url), [
    '/api/services/social/groups/deadbeef/messages/m-2/retry',
    '/api/services/social/groups/deadbeef/send',
  ])
  assert.deepEqual(requests[1].body, { id: 'm-2', text: 'Look', attachment: photo, reply_to: reply })
  assert.equal(view.deps.messages.length, 1)
  assert.equal(view.deps.messages[0].status, 'delivered')
  assert.equal(view.deps.messages[0]._retry_attachment, undefined)
})

test('a saved message the server can’t find is not re-sent from content', async () => {
  const failed = { id: 'm-3', dir: 'out', text: 'Hi', status: 'failed' }
  const requests = server(() => [404, { detail: 'Message not found.' }])
  const view = retryHarness(group, [failed])
  try {
    await view.retry(failed)
  } finally { delete globalThis.fetch }
  assert.equal(requests.length, 1)
  assert.deepEqual(view.toasts, [['error', 'Message not found.']])
  assert.equal(view.deps.messages[0].status, 'failed')
})

test('a retry that still fails stays retryable with the server’s reason', async () => {
  const failed = { id: 'm-4', dir: 'out', text: 'Hi', status: 'failed' }
  server(() => [200, { status: 'failed', id: 'm-4', detail: 'The group host host.example could not be reached.' }])
  const view = retryHarness(group, [failed])
  try {
    await view.retry(failed)
  } finally { delete globalThis.fetch }
  assert.equal(view.deps.messages[0].status, 'failed')
  assert.match(view.deps.messages[0].failure, /host\.example/)
  assert.match(view.toasts[0][1], /host\.example/)
})

test('retry indicator clears before a following history refresh settles', async () => {
  const failed = { id: 'm-5', status: 'failed', failure: 'Earlier failure' }
  server(() => [200, { status: 'failed', id: 'm-5', detail: 'Still offline' }])
  let releaseRefresh
  const view = retryHarness(group, [failed])
  view.deps.refresh = () => new Promise((resolve) => { releaseRefresh = resolve })
  try {
    const pending = view.retry(failed)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(view.deps.retrying, '')
    assert.equal(view.deps.messages[0].failure, 'Still offline')
    releaseRefresh()
    await pending
  } finally { delete globalThis.fetch }
})

test('direct messages retry through the same timeline path', async () => {
  const failed = { id: 'd-1', dir: 'out', text: 'Hi', status: 'failed' }
  const requests = server(() => [200, { status: 'delivered', id: 'd-1' }])
  const view = retryHarness({
    retrySaved: (id) => retryMessage('peer.example', id),
    deliver: ({ id, text, attachment, reply }) => sendMessage(id, 'peer.example', text, 'peer', attachment, reply),
  }, [failed])
  try {
    await view.retry(failed)
  } finally { delete globalThis.fetch }
  assert.deepEqual(requests.map(({ url }) => url), ['/api/services/social/conversations/peer.example/messages/d-1/retry'])
  for (const file of ['Thread.jsx', 'GroupThread.jsx']) {
    const source = readFileSync(new URL(`../ui/${file}`, import.meta.url), 'utf8')
    assert.match(source, /retrySaved: \(id\) => retry(?:Group)?Message\((?:peer|gid), id\)/)
    assert.doesNotMatch(source, /redeliver|canResend/)
  }
})

test('send and saved-copy retry have a finite queue-aware request deadline', async () => {
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const timers = []
  const cleared = []
  globalThis.setTimeout = (fn, ms) => {
    const timer = { fn, ms }
    timers.push(timer)
    return timer
  }
  globalThis.clearTimeout = (timer) => { cleared.push(timer) }
  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  })
  try {
    for (const operation of [
      () => sendMessage('stable', 'peer.example', 'Hi'),
      () => retryMessage('peer.example', 'stable'),
      () => sendGroupMessage('stable', 'group', 'Hi'),
      () => retryGroupMessage('group', 'stable'),
    ]) {
      const pending = operation()
      const timer = timers.at(-1)
      assert.equal(timer.ms, 60_000)
      timer.fn()
      await assert.rejects(pending, { name: 'AbortError' })
      assert.ok(cleared.includes(timer), 'deadline timer clears after settlement')
    }
  } finally {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
})

test('reply and dismissing a reply both return focus to the composer', () => {
  const focused = []
  const deps = {
    inputRef: { current: { focus: () => focused.push(deps.replyTarget) } },
    setReplyTarget: (value) => { deps.replyTarget = value },
  }
  const replyTo = owning(timelineSource, 'function replyTo(target) {', 'function cancelReply', deps)
  const cancelReply = owning(timelineSource, 'function cancelReply() {', 'async function send', deps)
  replyTo({ id: 'm-1' })
  cancelReply()
  assert.deepEqual(focused, [{ id: 'm-1' }, null], 'focus follows each state change')
})

test('sending while reading back returns to the newest message with one stable id', async () => {
  const sent = []
  const deps = {
    draft: 'Hello', selectedImage: null, replyTarget: null, sending: false, processingImage: false,
    sendBlocked: false, stickToBottom: { current: false }, messages: [],
    signals: { created: 'group_message', error: 'group_send' },
    setSending: () => {}, setDraft: () => {}, setSelectedImage: () => {}, setReplyTarget: () => {},
    updateMessages: (next) => { deps.messages = typeof next === 'function' ? next(deps.messages) : next },
    deliver: async (message) => { sent.push(message); return { status: 'delivered', id: message.id } },
    settleMessage, onSent: () => {}, refresh: async () => {}, showToast: () => {},
    inputRef: { current: null }, window: {},
    isDefinitePrecommitRejection: () => false,
  }
  const send = owning(timelineSource, 'async function send(event) {', 'async function retry', deps)
  await send({ preventDefault() {} })
  assert.equal(deps.stickToBottom.current, true)
  assert.equal(sent.length, 1)
  assert.deepEqual(deps.messages.map(({ id, status }) => [id, status]), [[sent[0].id, 'delivered']])
  assert.match(sent[0].id, /^[0-9a-f-]{36}$/)
})

test('a finished send releases the composer before a stalled history refresh', async () => {
  let releaseRefresh
  const deps = {
    draft: 'Hello', selectedImage: null, replyTarget: null, sending: false, processingImage: false,
    sendBlocked: false, stickToBottom: { current: false }, messages: [],
    signals: { created: 'message', error: 'send' },
    setSending: value => { deps.sending = value }, setDraft: () => {}, setSelectedImage: () => {}, setReplyTarget: () => {},
    updateMessages: next => { deps.messages = typeof next === 'function' ? next(deps.messages) : next },
    deliver: async message => ({ status: 'delivered', id: message.id }),
    settleMessage, onSent: () => {}, refresh: () => new Promise(resolve => { releaseRefresh = resolve }), showToast: () => {},
    inputRef: { current: null }, window: {}, isDefinitePrecommitRejection: () => false,
  }
  const send = owning(timelineSource, 'async function send(event) {', 'async function retry', deps)
  const pending = send({ preventDefault() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(deps.sending, false)
  assert.equal(deps.messages[0].status, 'delivered')
  releaseRefresh()
  await pending
})
