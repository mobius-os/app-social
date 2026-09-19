import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { searchPeople, getPeer } from '../api.js'

for (const [name, request] of [['people search', signal => searchPeople('a b', signal)], ['profile', signal => getPeer('example.test', signal)]]) {
  test(`${name} passes cancellation through to the network`, async () => {
    const original = globalThis.fetch
    const controller = new AbortController()
    let received
    globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
      received = options.signal
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    })
    try {
      const response = request(controller.signal)
      controller.abort()
      await assert.rejects(response, { name: 'AbortError' })
      assert.equal(received, controller.signal)
    } finally { globalThis.fetch = original }
  })
}

test('closing a profile invalidates its request instead of allowing it to reopen', () => {
  const source = readFileSync(new URL('../ui/People.jsx', import.meta.url), 'utf8')
  assert.match(source, /const closeProfile = \(\) => setSelectedHost\(null\)/)
  assert.match(source, /return \(\) => \{ active = false; controller.abort\(\) \}/)
  assert.match(source, /\{selectedHost && \(/)
})

test('Social modal focus owns initial focus so it can restore the actual opener', () => {
  for (const file of ['Board.jsx', 'People.jsx', 'Messages.jsx']) {
    const source = readFileSync(new URL(`../ui/${file}`, import.meta.url), 'utf8')
    assert.match(source, /useModalFocus/)
    assert.doesNotMatch(source, /autoFocus/)
  }
})

test('conversation recovery is visible and new messages do not steal the reading position', () => {
  for (const file of ['Thread.jsx', 'GroupThread.jsx']) {
    const source = readFileSync(new URL(`../ui/${file}`, import.meta.url), 'utf8')
    assert.match(source, /Messages couldn’t be refreshed/)
    assert.match(source, /onClick=\{refresh\}>Try again/)
    assert.match(source, /stickToBottom/)
    assert.match(source, /scrollHeight - el\.scrollTop - el\.clientHeight < 72/)
    assert.match(source, /paginationGeneration\.current \+= 1/)
    assert.match(source, /reconcileOlderPage/)
    assert.match(source, /generation === paginationGeneration\.current/)
  }
})

test('direct messages keep one client identity and expose interrupted delivery retry', () => {
  const thread = readFileSync(new URL('../ui/Thread.jsx', import.meta.url), 'utf8')
  const api = readFileSync(new URL('../api.js', import.meta.url), 'utf8')
  assert.match(thread, /const messageId = crypto\.randomUUID\(\)/)
  assert.match(thread, /sendMessage\(messageId, peer/)
  assert.match(thread, /Delivery interrupted · Retry/)
  assert.match(thread, /retryMessage\(peer, messageId\)/)
  assert.match(api, /id,\s*\n\s*to,/)
  assert.match(api, /messages\/\$\{encodeURIComponent\(id\)\}\/retry/)
})
test('handle search accepts the displayed @handle form and surrounding spaces', async () => {
  const original = globalThis.fetch
  let url
  globalThis.fetch = async path => {
    url = path
    return { ok: true, json: async () => ({ users: [] }) }
  }
  try {
    await searchPeople(' @example ')
    assert.equal(new URL(url, 'https://local.example').searchParams.get('q'), 'example')
  } finally { globalThis.fetch = original }
})
