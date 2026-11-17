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

test('a profile send keeps its id until the recipient or text changes', async () => {
  const { profileSendIdentity } = await import('../profile.js')
  let next = 0
  const newId = () => `id-${++next}`
  const first = profileSendIdentity(null, 'ada.example', 'Hello', newId)
  assert.deepEqual(first, { id: 'id-1', host: 'ada.example', text: 'Hello' })
  // The reply was lost: Send again reuses the same message.
  assert.equal(profileSendIdentity(first, 'ada.example', 'Hello', newId), first)
  assert.equal(profileSendIdentity(first, 'ada.example', 'Hello!', newId).id, 'id-2')
  assert.equal(profileSendIdentity(first, 'bo.example', 'Hello', newId).id, 'id-3')
})

test('the profile composer sends under the kept id and forgets it once confirmed', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../ui/People.jsx', import.meta.url), 'utf8')
  const send = source.slice(source.indexOf('async function sendFromProfile'), source.indexOf('async function changeRole'))
  assert.match(send, /profileSendIdentity\(unconfirmed\.current, target\.host, text\)/)
  assert.match(send, /sendMessage\(attempt\.id, /)
  assert.doesNotMatch(send, /randomUUID/)
  assert.ok(send.indexOf('unconfirmed.current = null') > send.indexOf('await sendMessage'))
})
