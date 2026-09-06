import test from 'node:test'
import assert from 'node:assert/strict'
import { listGroups, listConversations, getGroup } from '../api.js'

test.afterEach(() => { delete globalThis.window })

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
