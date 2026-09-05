import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SHARED_COMMUNITY_HOST,
  isSeparateLocalCommunity,
  prepareCommunity,
  shouldAdoptSharedCommunity,
} from '../community.js'

const freshRemoteProfile = {
  host: 'fresh.example',
  community_host: 'fresh.example',
  joined: false,
}

test('a fresh remote install starts in the shared Social community', async () => {
  const writes = []
  const prepared = await prepareCommunity(freshRemoteProfile, async (value) => writes.push(value))

  assert.equal(prepared.community_host, SHARED_COMMUNITY_HOST)
  assert.deepEqual(writes, [{ community_host: SHARED_COMMUNITY_HOST }])
})

test('an already joined local community is never changed silently', async () => {
  const profile = { ...freshRemoteProfile, joined: true }
  const writes = []
  const prepared = await prepareCommunity(profile, async (value) => writes.push(value))

  assert.strictEqual(prepared, profile)
  assert.deepEqual(writes, [])
  assert.equal(isSeparateLocalCommunity(profile), true)
})

test('a chosen third-party community remains selected', () => {
  const profile = { ...freshRemoteProfile, community_host: 'friends.example' }
  assert.equal(shouldAdoptSharedCommunity(profile), false)
  assert.equal(isSeparateLocalCommunity({ ...profile, joined: true }), false)
})

test('the shared host owner keeps its local community without a redundant write', () => {
  const profile = {
    host: SHARED_COMMUNITY_HOST,
    community_host: SHARED_COMMUNITY_HOST,
    joined: false,
  }
  assert.equal(shouldAdoptSharedCommunity(profile), false)
})
