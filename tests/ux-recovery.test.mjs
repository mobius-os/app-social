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
