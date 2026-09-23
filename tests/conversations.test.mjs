import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getCachedMessages, getGroup, listConversations, listGroupMessages, listGroups, listMessages,
  requestStatus,
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

test('the newest direct history page is cached for an immediate reopen', async () => {
  const writes = []
  const page = { messages: [{ id: 'one', sent_at: 1 }], next_cursor: 'next' }
  globalThis.window = { mobius: { storage: {
    async set(path, value) { writes.push([path, value]) },
    async get(path) {
      assert.equal(path, 'cache/message-history/dm/peer.example.json')
      return page
    },
  } } }
  globalThis.fetch = async () => ({ ok: true, async json() { return page } })

  assert.deepEqual(await listMessages('peer.example'), page)
  assert.deepEqual(writes, [['cache/message-history/dm/peer.example.json', page]])
  assert.deepEqual(await getCachedMessages('peer.example'), page)
})

test('a stalled history request ends at its deadline and uses the bounded cache', async () => {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const cached = { messages: [{ id: 'saved', sent_at: 1 }], next_cursor: null }
  globalThis.window = { mobius: { storage: {
    async get(path) {
      assert.equal(path, 'cache/message-history/dm/peer.example.json')
      return cached
    },
  } } }
  globalThis.setTimeout = (callback) => { queueMicrotask(callback); return 1 }
  globalThis.clearTimeout = () => {}
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  })

  try {
    assert.deepEqual(await listMessages('peer.example'), cached)
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
})
