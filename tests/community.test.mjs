import assert from 'node:assert/strict'
import test from 'node:test'
import { SHARED_COMMUNITY_HOST, joinGlobalCommunity } from '../community.js'

const fresh = { host: 'fresh.example', community_host: 'fresh.example', joined: false }

test('all public browsing uses the canonical community host without membership writes', async () => {
  const api = await import('../api.js')
  const previous = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url: new URL(url, 'https://local.example'), options })
    return { ok: true, json: async () => ({}), blob: async () => new Blob() }
  }
  try {
    await api.getFeed()
    await api.searchPeople('@someone')
    await api.getReplies('post-1')
    await api.getBoardMedia('post-1')
    assert.deepEqual(calls.map(c => c.url.pathname), [
      '/api/common/feed', '/api/common/people', '/api/common/replies/post-1',
      '/api/common/board-media/post-1',
    ])
    for (const { url, options } of calls) {
      assert.equal(url.searchParams.get('community_host'), SHARED_COMMUNITY_HOST)
      assert.equal(options.method || 'GET', 'GET')
      assert.equal(options.body, undefined)
    }
  } finally { globalThis.fetch = previous }
})

test('joining automatically sets the canonical community destination', async () => {
  const calls = []
  await joinGlobalCommunity(fresh, async value => {
    calls.push(value)
    return { directory: 'not_joined' }
  }, async () => { calls.push('join'); return { directory: 'registered' } })
  assert.deepEqual(calls, [{ community_host: SHARED_COMMUNITY_HOST }, 'join'])
})

test('a failed registration stays a retryable failure, never success', async () => {
  await assert.rejects(joinGlobalCommunity({ ...fresh, joined: true }, async () => ({ directory: 'unreachable' }), () => assert.fail()), /Try joining again/)
  const profile = { ...fresh, joined: true, community_host: SHARED_COMMUNITY_HOST }
  assert.equal((await joinGlobalCommunity(profile, () => assert.fail(), async () => ({ directory: 'registered' }))).directory, 'registered')
})

test('a failed destination write prevents joining', async () => {
  await assert.rejects(joinGlobalCommunity(fresh, async () => { throw new Error('offline') }, () => assert.fail('wrong audience')), /offline/)
})

test('reopening detects a saved join that never reached the directory', async () => {
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

test('browsers do not check membership when unjoined', async () => {
  const { checkGlobalRegistration } = await import('../community.js')
  assert.equal(await checkGlobalRegistration(fresh, () => assert.fail('no check when unjoined')), 'not_joined')
})
