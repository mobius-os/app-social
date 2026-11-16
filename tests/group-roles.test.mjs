import test from 'node:test'
import assert from 'node:assert/strict'
import { canManageGroup, groupRole, memberActions, roleLabel } from '../ui/groupRoles.js'
import { removeGroupMember, renameGroup, setGroupAdmin, setToken } from '../api.js'

const group = {
  gid: 'g1', host: 'creator.example', name: 'Friends', request_status: 'accepted',
  members: [
    { host: 'creator.example', handle: 'cara', role: 'creator' },
    { host: 'admin.example', handle: 'ada', role: 'admin' },
    { host: 'member.example', handle: 'mo' },
  ],
}
const as = host => ({ host })
const row = host => group.members.find(member => member.host === host)

test('roles come from the host and the roster', () => {
  assert.equal(groupRole(group, 'creator.example'), 'creator')
  assert.equal(groupRole(group, 'ADMIN.example'), 'admin')
  assert.equal(groupRole(group, 'member.example'), 'member')
  assert.equal(groupRole(group, 'stranger.example'), 'none')
  assert.deepEqual(['creator', 'admin', 'member'].map(roleLabel), ['Creator', 'Admin', ''])
})

test('the creator manages everyone but themselves', () => {
  assert.deepEqual(memberActions(group, as('creator.example'), row('admin.example')), ['remove_admin', 'remove'])
  assert.deepEqual(memberActions(group, as('creator.example'), row('member.example')), ['make_admin', 'remove'])
  assert.deepEqual(memberActions(group, as('creator.example'), row('creator.example')), [])
})

test('an admin can only remove ordinary members', () => {
  assert.deepEqual(memberActions(group, as('admin.example'), row('member.example')), ['remove'])
  assert.deepEqual(memberActions(group, as('admin.example'), row('creator.example')), [])
  assert.deepEqual(memberActions(group, as('admin.example'), row('admin.example')), [])
})

test('members, pending invitations and closed or left groups offer no management', () => {
  assert.equal(canManageGroup(group, as('member.example')), false)
  assert.equal(canManageGroup({ ...group, request_status: 'pending' }, as('admin.example')), false)
  assert.equal(canManageGroup({ ...group, deleted_at: 1 }, as('creator.example')), false)
  assert.equal(canManageGroup({ ...group, removed_at: 1 }, as('admin.example')), false)
  assert.equal(canManageGroup({ ...group, request_status: undefined }, as('admin.example')), true)
})

test('management calls go to the group authority with exact targets', async () => {
  setToken('scoped-test')
  const expected = [
    ['/api/services/social/groups/g1/members/member.example', 'DELETE', undefined],
    ['/api/services/social/groups/g1', 'PATCH', { name: 'Best friends' }],
    ['/api/services/social/groups/g1/admins', 'POST', { host: 'member.example', admin: true }],
  ]
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    const [nextUrl, method, body] = expected.shift()
    assert.equal(url, nextUrl)
    assert.equal(options.method, method)
    assert.equal(options.headers.Authorization, 'Bearer scoped-test')
    assert.deepEqual(options.body === undefined ? undefined : JSON.parse(options.body), body)
    return Response.json({ status: 'ok', members: [] })
  }
  try {
    await removeGroupMember('g1', 'member.example')
    await renameGroup('g1', 'Best friends')
    await setGroupAdmin('g1', 'member.example', true)
  } finally { globalThis.fetch = originalFetch }
  assert.equal(expected.length, 0)
})
