import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getGroup, listConversations, listGroupMessages, listGroups, listMessages,
  requestStatus, watchLatestGroupMessages, watchLatestMessages,
} from '../api.js'

test.afterEach(() => {
  delete globalThis.window
  delete globalThis.fetch
})

for (const [label, list, prefix, record] of [
  ['groups', listGroups, 'groups/', { gid: 'group-1', name: 'Planning' }],
  ['direct messages', listConversations, 'conversations/', { peer: 'peer.example', last_at: 2 }],
]) {
  test(`${label} load from the runtime directory contract rather than disappearing`, async () => {
    const reads = []
    globalThis.window = { mobius: { storage: {
      async list(path) {
        assert.equal(path, prefix)
        return [{ name: 'one', type: 'directory' }, { name: 'ignored.json', type: 'file' }]
      },
      async get(path) { reads.push(path); return record },
    } } }
    assert.deepEqual(await list(), [record])
    assert.deepEqual(reads, [`${prefix}one/meta.json`])
  })
  test(`${label} report a read failure instead of claiming the conversation is absent`, async () => {
    globalThis.window = { mobius: { storage: {
      async list() { return [{ name: 'one', type: 'directory' }] },
      async get() { throw new Error('read failed') },
    } } }
    await assert.rejects(list, /read failed/)
  })
}

for (const [label, list, prefix] of [
  ['groups', listGroups, 'groups/'],
  ['direct messages', listConversations, 'conversations/'],
]) {
  test(`${label} reload the server copy so a delivered message appears without a refresh`, async () => {
    const cached = { unread: 1, last_text: 'older' }
    const fresh = { unread: 2, last_text: 'just arrived' }
    const storage = {
      async list() { return [{ name: 'one', type: 'directory' }] },
      async get() { return cached },
      async getWithVersion(path) {
        assert.equal(path, `${prefix}one/meta.json`)
        return { value: fresh, version: 'v2' }
      },
    }
    globalThis.window = { mobius: { storage } }
    assert.deepEqual(await list(), [fresh])
    storage.getWithVersion = async () => { throw new Error('server unreachable') }
    assert.deepEqual(await list(), [cached])
  })
}

test('opening a newly created group reads its exact fresh metadata without a directory refresh', async () => {
  const group = { gid: 'new-group', name: 'Planning', members: [] }
  globalThis.window = { mobius: { storage: {
    async list() { assert.fail('navigation must not depend on a directory listing') },
    async get() { assert.fail('navigation must not use a potentially stale cache') },
    async getWithVersion(path) {
      assert.equal(path, 'groups/new-group/meta.json')
      return { value: group, version: 'v1' }
    },
  } } }
  assert.equal(await getGroup('new-group'), group)
})

test('missing or different group metadata cannot silently close the creation flow', async () => {
  for (const value of [null, { gid: 'another-group' }]) {
    globalThis.window = { mobius: { storage: { async getWithVersion() { return { value } } } } }
    await assert.rejects(() => getGroup('new-group'), /could not be opened/)
  }
})

test('request metadata is persistent while legacy conversations remain accepted', () => {
  assert.equal(requestStatus({ request_status: 'pending' }), 'pending')
  assert.equal(requestStatus({ request_status: 'declined' }), 'declined')
  assert.equal(requestStatus({ request_status: 'blocked' }), 'blocked')
  assert.equal(requestStatus({ request_status: 'accepted' }), 'accepted')
  assert.equal(requestStatus({ peer: 'legacy.example', unread: 2 }), 'accepted')
  assert.equal(requestStatus(null), 'accepted')
})

for (const [label, load, expected] of [
  ['direct', () => listMessages('peer.example', 'older-page'), '/api/services/social/conversations/peer.example/messages?limit=50&before=older-page'],
  ['group', () => listGroupMessages('deadbeef', 'older-page'), '/api/services/social/groups/deadbeef/messages?limit=50&before=older-page'],
]) {
  test(`${label} history asks Social for one bounded cursor page`, async () => {
    globalThis.window = { mobius: { storage: {} } }
    globalThis.fetch = async (url) => {
      assert.equal(url, expected)
      return {
        ok: true,
        async json() {
          return { messages: [{ id: 'one', sent_at: 1 }], next_cursor: 'next' }
        },
      }
    }
    assert.deepEqual(await load(), {
      messages: [{ id: 'one', sent_at: 1 }], next_cursor: 'next',
    })
  })
}

test('cached direct history remains readable when the local service is offline', async () => {
  globalThis.fetch = async () => { throw new TypeError('offline') }
  globalThis.window = { mobius: { storage: {
    async list(path, options) {
      assert.equal(path, 'conversations/peer.example/msgs/')
      assert.deepEqual(options, { includeContent: true })
      return [
        { path: `${path}later.json`, content: { id: 'later', sent_at: 2 } },
        { path: `${path}earlier.json`, content: { id: 'earlier', sent_at: 1 } },
      ]
    },
  } } }
  assert.deepEqual(await listMessages('peer.example'), {
    messages: [
      { id: 'earlier', sent_at: 1 },
      { id: 'later', sent_at: 2 },
    ],
    next_cursor: null,
  })
})

test('an offline history miss remains visible instead of becoming a false empty conversation', async () => {
  globalThis.fetch = async () => { throw new TypeError('offline') }
  globalThis.window = { mobius: { storage: {
    async get() { return null },
    async list() { return [] },
  } } }
  await assert.rejects(() => listMessages('peer.example'), /offline/)
})

test('history reads leave the first-paint page to the service that publishes it', async () => {
  // The service republishes the newest page on every message change, so a
  // client write could only replace it with an older response.
  const page = { messages: [{ id: 'one', sent_at: 1 }], next_cursor: 'next' }
  globalThis.window = { mobius: { storage: {
    async set() { assert.fail('the client must not write the published page') },
  } } }
  globalThis.fetch = async () => ({ ok: true, async json() { return page } })
  assert.deepEqual(await listMessages('peer.example'), page)
  assert.deepEqual(await listGroupMessages('group-1'), page)
})

test('a conversation watcher paints the device copy, then the service copy, and skips malformed pages', () => {
  const device = { messages: [{ id: 'old', sent_at: 1 }], next_cursor: null }
  const current = { messages: [{ id: 'old', sent_at: 1 }, { id: 'new', sent_at: 2 }], next_cursor: null }
  let deliver = null
  let unsubscribed = 0
  const reads = []
  globalThis.window = { mobius: { storage: {
    subscribe(path, callback) {
      assert.equal(path, 'cache/message-history/dm/peer.example.json')
      deliver = callback
      return () => { unsubscribed += 1 }
    },
    async get(path) { reads.push(path); return current },
  } } }
  const pages = []
  const watch = watchLatestMessages('peer.example', page => pages.push(page))
  deliver(device)
  deliver({ messages: 'not a page' })
  deliver(null)
  watch.recheck()
  deliver(current)
  assert.deepEqual(pages, [device, current])
  assert.deepEqual(reads, ['cache/message-history/dm/peer.example.json'])
  watch.stop()
  deliver({ messages: [], next_cursor: null })
  assert.equal(pages.length, 2)
  assert.equal(unsubscribed, 1)
})

test('group watchers read the group page path and degrade without subscriptions', () => {
  let watched = null
  globalThis.window = { mobius: { storage: {
    subscribe(path) { watched = path; return () => {} },
  } } }
  watchLatestGroupMessages('group-1', () => {}).stop()
  assert.equal(watched, 'cache/message-history/group/group-1.json')
  globalThis.window = { mobius: { storage: {} } }
  const inert = watchLatestMessages('peer.example', () => assert.fail('no subscription'))
  inert.recheck()
  inert.stop()
})

test('offline direct history reads every canonical saved message, newest included', async () => {
  globalThis.fetch = async () => { throw new TypeError('offline') }
  globalThis.window = { mobius: { storage: {
    async list(path, options) {
      assert.equal(path, 'conversations/newer.example/msgs/')
      assert.deepEqual(options, { includeContent: true })
      return [
        { content: { id: 'earlier', sent_at: 1 } },
        { content: { id: 'newer', sent_at: 2 } },
      ]
    },
  } } }

  assert.deepEqual(await listMessages('newer.example'), {
    messages: [
      { id: 'earlier', sent_at: 1 },
      { id: 'newer', sent_at: 2 },
    ],
    next_cursor: null,
  })
})

test('canonical group history owns offline recovery', async () => {
  globalThis.fetch = async () => { throw new TypeError('offline') }
  globalThis.window = { mobius: { storage: {
    async list(path, options) {
      assert.equal(path, 'groups/group-1/msgs/')
      assert.deepEqual(options, { includeContent: true })
      return [
        { content: { id: 'earlier', sent_at: 1 } },
        { content: { id: 'newer', sent_at: 2 } },
      ]
    },
  } } }

  assert.deepEqual(await listGroupMessages('group-1'), {
    messages: [
      { id: 'earlier', sent_at: 1 },
      { id: 'newer', sent_at: 2 },
    ],
    next_cursor: null,
  })
})

test('a stalled history request ends at its deadline and uses canonical saved messages', async () => {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const saved = { id: 'saved', sent_at: 1 }
  globalThis.window = { mobius: { storage: {
    async list(path, options) {
      assert.equal(path, 'conversations/timeout.example/msgs/')
      assert.deepEqual(options, { includeContent: true })
      return [{ content: saved }]
    },
  } } }
  globalThis.setTimeout = (callback) => { queueMicrotask(callback); return 1 }
  globalThis.clearTimeout = () => {}
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  })

  try {
    assert.deepEqual(await listMessages('timeout.example'), {
      messages: [saved], next_cursor: null,
    })
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
})
