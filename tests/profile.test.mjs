import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AVATAR_FAILURE_RETRY_MS, AVATAR_NOT_FOUND_RETRY_MS,
  AVATAR_SUCCESS_RETRY_MS,
  avatarBlob, avatarCacheIsFresh, avatarFailureState, focusProfileReturnTarget,
  membershipDuration,
} from '../profile.js'

test('profile membership is expressed as a stable month and year', () => {
  assert.equal(membershipDuration({ member_since: '2026-09-01T00:00:00Z' }), 'Member since Sep 2026')
  assert.equal(membershipDuration({ joined_at: Date.UTC(2025, 0, 12) / 1000 }), 'Member since Jan 2025')
  assert.equal(membershipDuration({}), 'New member')
})

test('avatar wire data becomes a typed blob and rejects invalid payloads', async () => {
  const blob = avatarBlob({ mime: 'image/png', data_b64: 'AQID' })
  assert.equal(blob.type, 'image/png')
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3])
  assert.equal(avatarBlob({ mime: 'text/plain', data_b64: 'AQID' }), null)
  assert.equal(avatarBlob({ mime: 'image/png', data_b64: '%' }), null)
})

test('avatar cache distinguishes retryable failures from confirmed absence', () => {
  const now = 1_000_000
  const missing = avatarFailureState({ status: 404 }, now)
  const unavailable = avatarFailureState({ status: 502 }, now)

  assert.equal(avatarCacheIsFresh(missing, now + AVATAR_NOT_FOUND_RETRY_MS - 1), true)
  assert.equal(avatarCacheIsFresh(missing, now + AVATAR_NOT_FOUND_RETRY_MS), false)
  assert.equal(avatarCacheIsFresh(unavailable, now + AVATAR_FAILURE_RETRY_MS - 1), true)
  assert.equal(avatarCacheIsFresh(unavailable, now + AVATAR_FAILURE_RETRY_MS), false)
})

test('avatar cache refreshes a successful URL after its finite freshness window', () => {
  const now = 1_000_000
  const cached = { url: 'blob:avatar', fetchedAt: now }
  assert.equal(avatarCacheIsFresh(cached, now + AVATAR_SUCCESS_RETRY_MS - 1), true)
  assert.equal(avatarCacheIsFresh(cached, now + AVATAR_SUCCESS_RETRY_MS), false)
})

test('profile dismissal focuses the connected opener or the visible fallback', () => {
  const focused = []
  const opener = { isConnected: true, focus: () => focused.push('opener') }
  const detached = { isConnected: false, focus: () => focused.push('detached') }
  const fallback = { isConnected: true, focus: () => focused.push('fallback') }

  assert.equal(focusProfileReturnTarget(opener, fallback), true)
  assert.equal(focusProfileReturnTarget(detached, fallback), true)
  assert.deepEqual(focused, ['opener', 'fallback'])
})
