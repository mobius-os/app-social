import assert from 'node:assert/strict'
import test from 'node:test'
import { joinGlobalCommunity } from '../community.js'

const fresh = { host: 'fresh.example', joined: false }

test('public browsing is read-only and names no board host', async () => {
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
      '/api/services/social/feed', '/api/services/social/people', '/api/services/social/replies/post-1',
      '/api/services/social/board-media/post-1',
    ])
    for (const { url, options } of calls) {
      assert.equal(url.searchParams.get('community_host'), null)
      assert.equal(options.method || 'GET', 'GET')
      assert.equal(options.body, undefined)
    }
  } finally { globalThis.fetch = previous }
})

test('board paging forwards an opaque stable cursor unchanged', async () => {
  const api = await import('../api.js')
  const previous = globalThis.fetch
  let request
  globalThis.fetch = async (url) => {
    request = new URL(url, 'https://local.example')
    return { ok: true, json: async () => ({ posts: [] }) }
  }
  try {
    await api.getFeed('opaque-cursor+/=')
    assert.equal(request.searchParams.get('before'), 'opaque-cursor+/=')
  } finally { globalThis.fetch = previous }
})

test('board paging preserves a zero legacy boundary in the network query', async () => {
  const api = await import('../api.js')
  const previous = globalThis.fetch
  let request
  globalThis.fetch = async (url) => {
    request = new URL(url, 'https://local.example')
    return { ok: true, json: async () => ({ posts: [] }) }
  }
  try {
    await api.getFeed(0)
    assert.equal(request.searchParams.get('before'), '0')
  } finally { globalThis.fetch = previous }
})

test('a failed registration stays a retryable failure, never success', async () => {
  await assert.rejects(joinGlobalCommunity(async () => ({ directory: 'unreachable' })), /could not be reached/)
  await assert.rejects(joinGlobalCommunity(async () => ({ directory: 'verification_failed' })), /could not verify/)
  await assert.rejects(joinGlobalCommunity(async () => ({ directory: 'rejected' })), /rejected this profile/)
  assert.equal((await joinGlobalCommunity(async () => ({ directory: 'registered' }))).directory, 'registered')
})

test('reopening detects a saved join that never reached the directory', async () => {
  const { checkGlobalRegistration } = await import('../community.js')
  const profile = { ...fresh, joined: true }
  assert.equal(await checkGlobalRegistration(profile, async q => {
    assert.equal(q, profile.host)
    return { users: [{ host: 'not-fresh.example' }] }
  }), 'missing')
  assert.equal(await checkGlobalRegistration(profile, async () => ({ users: [{ host: profile.host }] })), 'registered')
})

test('directory outage is not misreported as missing membership', async () => {
  const { checkGlobalRegistration } = await import('../community.js')
  assert.equal(await checkGlobalRegistration({ ...fresh, joined: true }, async () => { throw Error('offline') }), 'unavailable')
})

test('browsers do not check membership when unjoined', async () => {
  const { checkGlobalRegistration } = await import('../community.js')
  assert.equal(await checkGlobalRegistration(fresh, () => assert.fail('no check when unjoined')), 'not_joined')
})
