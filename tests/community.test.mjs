import assert from 'node:assert/strict'
import test from 'node:test'
import { SHARED_COMMUNITY_HOST, needsGlobalJoin, prepareCommunity, joinGlobalCommunity } from '../community.js'

const fresh = { host: 'fresh.example', community_host: 'fresh.example', joined: false }

for (const previous of ['fresh.example', 'friends.example', '']) {
  test(`unjoined installs browse global Social instead of ${previous || 'an absent default'}`, async () => {
    const writes = []
    const prepared = await prepareCommunity({ ...fresh, community_host: previous }, async value => writes.push(value))
    assert.equal(prepared.community_host, SHARED_COMMUNITY_HOST)
    assert.deepEqual(writes, [{ community_host: SHARED_COMMUNITY_HOST }])
  })
}

for (const previous of ['fresh.example', 'friends.example']) {
  test(`an existing ${previous} membership requires consent before global publication`, async () => {
    const profile = { ...fresh, joined: true, community_host: previous }
    const prepared = await prepareCommunity(profile, () => assert.fail('must not publish silently'))
    assert.strictEqual(prepared, profile)
    assert.equal(needsGlobalJoin(profile), true)
  })
}

test('global members and browsing installations need no redundant write', async () => {
  for (const joined of [false, true]) {
    const profile = { ...fresh, joined, community_host: SHARED_COMMUNITY_HOST }
    assert.strictEqual(await prepareCommunity(profile, () => assert.fail('redundant write')), profile)
    assert.equal(needsGlobalJoin(profile), false)
  }
})

test('explicit migration registers an existing member once at the global destination', async () => {
  const writes = []
  const result = await joinGlobalCommunity({ ...fresh, joined: true }, async value => {
    writes.push(value)
    return { directory: 'registered' }
  }, () => assert.fail('profile update already registers joined members'))
  assert.equal(result.directory, 'registered')
  assert.deepEqual(writes, [{ community_host: SHARED_COMMUNITY_HOST }])
})

test('fresh join selects the global destination before publishing', async () => {
  const calls = []
  await joinGlobalCommunity(fresh, async value => {
    calls.push(value)
    return { directory: 'not_joined' }
  }, async () => { calls.push('join'); return { directory: 'registered' } })
  assert.deepEqual(calls, [{ community_host: SHARED_COMMUNITY_HOST }, 'join'])
})

test('a failed global registration stays a retryable failure, never success', async () => {
  await assert.rejects(joinGlobalCommunity({ ...fresh, joined: true }, async () => ({ directory: 'unreachable' }), () => assert.fail()), /Try joining again/)
  const profile = { ...fresh, joined: true, community_host: SHARED_COMMUNITY_HOST }
  assert.equal((await joinGlobalCommunity(profile, () => assert.fail(), async () => ({ directory: 'registered' }))).directory, 'registered')
})

test('a failed destination write prevents joining the old directory', async () => {
  await assert.rejects(joinGlobalCommunity(fresh, async () => { throw new Error('offline') }, () => assert.fail('wrong audience')), /offline/)
})

test('reopening detects a saved join that never reached the global directory', async () => {
  const { checkGlobalRegistration } = await import('../community.js')
  const profile = { ...fresh, joined: true, community_host: SHARED_COMMUNITY_HOST }
  assert.equal(await checkGlobalRegistration(profile, async q => {
    assert.equal(q, profile.host)
    return { users: [{ host: 'not-fresh.example' }] }
  }), 'missing')
  assert.equal(await checkGlobalRegistration(profile, async () => ({ users: [{ host: profile.host }] })), 'registered')
})

test('directory outage is not misreported as missing membership', async () => {
  const { checkGlobalRegistration } = await import('../community.js')
  assert.equal(await checkGlobalRegistration({ ...fresh, joined: true, community_host: SHARED_COMMUNITY_HOST }, async () => { throw Error('offline') }), 'unavailable')
})

test('browsers and separate-community members do not publish or check global membership', async () => {
  const { checkGlobalRegistration } = await import('../community.js')
  for (const joined of [false, true]) {
    assert.equal(await checkGlobalRegistration({ ...fresh, joined }, () => assert.fail('no global membership')), 'not_joined')
  }
})
