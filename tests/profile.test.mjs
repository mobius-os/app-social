import test from 'node:test'
import assert from 'node:assert/strict'
import { membershipDuration } from '../profile.js'

test('profile membership is expressed as a stable month and year', () => {
  assert.equal(membershipDuration({ member_since: '2026-09-01T00:00:00Z' }), 'Member since Sep 2026')
  assert.equal(membershipDuration({ joined_at: Date.UTC(2025, 0, 12) / 1000 }), 'Member since Jan 2025')
  assert.equal(membershipDuration({}), 'New member')
})
