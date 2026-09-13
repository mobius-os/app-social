import test from 'node:test'
import assert from 'node:assert/strict'
import {
  acceptGroupInvitation, acceptMessageRequest, addGroupMember, blockMessageRequest,
  clearGroupUnread, clearUnread, declineGroupInvitation, declineMessageRequest,
  deleteGroup, groupIsVisible, setToken,
} from '../api.js'

const originalFetch = globalThis.fetch
test.afterEach(() => { globalThis.fetch = originalFetch; delete globalThis.window })

test('inviting into an existing group uses its exact id and chosen deployment', async () => {
  setToken('scoped-test')
  const receipt = { status: 'added', members: [{ host: 'friend.example' }], delivered: { 'friend.example': true } }
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/services/common/groups/group-id/members')
    assert.equal(options.method, 'POST')
    assert.equal(options.headers.Authorization, 'Bearer scoped-test')
    assert.deepEqual(JSON.parse(options.body), { host: 'friend.example' })
    return Response.json(receipt)
  }
  assert.deepEqual(await addGroupMember('group-id', 'friend.example'), receipt)
})

test('deleting uses the group authority, never a local storage wipe', async () => {
  globalThis.window = { mobius: { storage: { remove() { assert.fail('deletion must be owned by the group host') } } } }
  const receipt = { status: 'deleted', delivered: { 'offline.example': false } }
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/services/common/groups/group-id')
    assert.equal(options.method, 'DELETE')
    return Response.json(receipt)
  }
  assert.deepEqual(await deleteGroup('group-id'), receipt)
})

test('a failed delete remains a failure rather than claiming the group disappeared', async () => {
  globalThis.fetch = async () => Response.json({ detail: 'Only the creator can delete this group.' }, { status: 403 })
  await assert.rejects(() => deleteGroup('group-id'), error => error.status === 403 && /creator/.test(error.message))
})

test('message-request decisions use server-owned authenticated actions', async () => {
  setToken('scoped-test')
  const expected = [
    ['/api/services/common/requests/dm/peer.example/accept', { status: 'accepted' }],
    ['/api/services/common/requests/dm/peer.example/decline', { status: 'declined' }],
    ['/api/services/common/requests/dm/peer.example/block', { status: 'blocked' }],
  ]
  globalThis.fetch = async (url, options) => {
    const [nextUrl, receipt] = expected.shift()
    assert.equal(url, nextUrl)
    assert.equal(options.method, 'POST')
    assert.equal(options.headers.Authorization, 'Bearer scoped-test')
    return Response.json(receipt)
  }
  assert.deepEqual(await acceptMessageRequest('peer.example'), { status: 'accepted' })
  assert.deepEqual(await declineMessageRequest('peer.example'), { status: 'declined' })
  assert.deepEqual(await blockMessageRequest('peer.example'), { status: 'blocked' })
  assert.equal(expected.length, 0)
})

test('group invitations are accepted or declined through group authority', async () => {
  setToken('scoped-test')
  const expected = [
    ['/api/services/common/groups/group-id/accept', { status: 'accepted' }],
    ['/api/services/common/groups/group-id/decline', { status: 'declined', host_notified: false }],
  ]
  globalThis.fetch = async (url, options) => {
    const [nextUrl, receipt] = expected.shift()
    assert.equal(url, nextUrl)
    assert.equal(options.method, 'POST')
    assert.equal(options.headers.Authorization, 'Bearer scoped-test')
    return Response.json(receipt)
  }
  assert.deepEqual(await acceptGroupInvitation('group-id'), { status: 'accepted' })
  assert.deepEqual(await declineGroupInvitation('group-id'), {
    status: 'declined', host_notified: false,
  })
  assert.equal(expected.length, 0)
})

test('deletion hides only the creator’s group and preserves other members’ readable history', () => {
  const group = { gid: 'one', host: 'creator.example', deleted_at: 123 }
  assert.equal(groupIsVisible(group, 'creator.example'), false)
  assert.equal(groupIsVisible(group, 'member.example'), true)
  assert.equal(groupIsVisible({ ...group, deleted_at: undefined }, 'creator.example'), true)
})

for (const [label, clear, path] of [
  ['group', clearGroupUnread, 'groups/one/meta.json'],
  ['direct conversation', clearUnread, 'conversations/one/meta.json'],
]) {
  test(`marking a ${label} read cannot overwrite a concurrent membership, deletion or message update`, async () => {
    globalThis.window = { mobius: { storage: {
      async getWithVersion(got) { assert.equal(got, path); return { value: { unread: 1 }, version: 'before-change' } },
      async durableWrite(got, value, options) {
        assert.equal(got, path)
        assert.deepEqual(value, { unread: 0 })
        assert.deepEqual(options, { ifMatch: 'before-change' })
        throw new Error('conflict')
      },
      set() { assert.fail('an unconditional write could revive deleted metadata') },
    } } }
    await assert.rejects(() => clear('one'), /conflict/)
  })
}
