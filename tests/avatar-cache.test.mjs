import test from 'node:test'
import assert from 'node:assert/strict'

import {
  cachedAvatar, cachedAvatarUrl, primeAvatar, subscribeAvatar,
} from '../avatarCache.js'

const wire = (byte) => ({ mime: 'image/webp', data_b64: Buffer.from([byte]).toString('base64') })
const response = (avatars = {}, missing = []) => ({
  ok: true,
  json: async () => ({ avatars, missing, unavailable: [] }),
})

test('avatar cache batches peers, serializes batches, and tracks authoritative profile changes', async () => {
  const originalFetch = globalThis.fetch
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  const calls = []
  const created = []
  const revoked = []
  let releaseFirst
  let releaseSecond
  URL.createObjectURL = () => {
    const url = `blob:test-${created.length + 1}`
    created.push(url)
    return url
  }
  URL.revokeObjectURL = (url) => revoked.push(url)

  try {
    globalThis.fetch = async (_url, options) => {
      const hosts = JSON.parse(options.body).hosts
      calls.push(hosts)
      return response(Object.fromEntries(hosts.map((host, index) => [host, wire(index + 1)])))
    }
    const initial = Array.from({ length: 10 }, (_, index) => (
      cachedAvatar(`initial-${index}.example`)
    ))
    await Promise.all(initial.map(record => record.promise))
    assert.deepEqual(calls, [
      Array.from({ length: 8 }, (_, index) => `initial-${index}.example`),
      ['initial-8.example', 'initial-9.example'],
    ])

    calls.length = 0
    globalThis.fetch = async (_url, options) => {
      const hosts = JSON.parse(options.body).hosts
      calls.push(hosts)
      if (calls.length === 1) return new Promise(resolve => { releaseFirst = resolve })
      return new Promise(resolve => { releaseSecond = resolve })
    }
    const early = cachedAvatar('early.example')
    const earlyPromise = early.promise
    await new Promise(resolve => setImmediate(resolve))
    const lateOne = cachedAvatar('late-one.example')
    const lateTwo = cachedAvatar('late-two.example')
    assert.equal(calls.length, 1)
    releaseFirst(response({ 'early.example': wire(3) }))
    await earlyPromise
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, [
      ['early.example'],
      ['late-one.example', 'late-two.example'],
    ])
    releaseSecond(response({
      'late-one.example': wire(4), 'late-two.example': wire(5),
    }))
    await Promise.all([lateOne.promise, lateTwo.promise])

    let releaseStale
    globalThis.fetch = async () => new Promise(resolve => { releaseStale = resolve })
    const owner = cachedAvatar('owner.example')
    const ownerPromise = owner.promise
    await new Promise(resolve => setImmediate(resolve))
    const updates = []
    const unsubscribe = subscribeAvatar(owner, url => updates.push(url))
    primeAvatar('owner.example', wire(9))
    const authoritativeUrl = cachedAvatarUrl('owner.example')
    releaseStale(response({ 'owner.example': wire(1) }))
    await ownerPromise
    assert.equal(cachedAvatarUrl('owner.example'), authoritativeUrl)
    assert.deepEqual(updates, [authoritativeUrl])

    primeAvatar('owner.example', wire(10))
    const changedUrl = cachedAvatarUrl('owner.example')
    assert.notEqual(changedUrl, authoritativeUrl)
    assert.deepEqual(revoked, [authoritativeUrl])
    primeAvatar('owner.example', null)
    assert.equal(cachedAvatarUrl('owner.example'), null)
    assert.deepEqual(updates, [authoritativeUrl, changedUrl, null])
    assert.equal(revoked.length, 2)
    unsubscribe()

    const revokedBeforePrune = revoked.length
    for (let index = 0; index < 70; index += 1) {
      primeAvatar(`idle-${index}.example`, wire(index % 255))
    }
    assert.ok(revoked.length > revokedBeforePrune)
  } finally {
    globalThis.fetch = originalFetch
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  }
})

test('expired mounted avatar refreshes stale-while-refresh and clears confirmed removal', async () => {
  const originalFetch = globalThis.fetch
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  const originalNow = Date.now
  const revoked = []
  let now = 1_000_000
  let first = true
  Date.now = () => now
  URL.createObjectURL = () => 'blob:expiry-avatar'
  URL.revokeObjectURL = url => revoked.push(url)
  try {
    globalThis.fetch = async (_url, options) => {
      const hosts = JSON.parse(options.body).hosts
      if (first) {
        first = false
        return response({ 'expiry.example': wire(7) })
      }
      return response({}, hosts.includes('expiry.example') ? hosts : [])
    }
    const record = cachedAvatar('expiry.example')
    await record.promise
    const oldUrl = cachedAvatarUrl('expiry.example')
    const revokedBeforeRefresh = revoked.length
    const updates = []
    const unsubscribe = subscribeAvatar(record, url => updates.push(url))

    now += 24 * 60 * 60_000
    const refreshing = cachedAvatar('expiry.example')
    assert.equal(cachedAvatarUrl('expiry.example'), oldUrl)
    await refreshing.promise

    assert.equal(cachedAvatarUrl('expiry.example'), null)
    assert.deepEqual(updates, [null])
    assert.deepEqual(revoked.slice(revokedBeforeRefresh), [oldUrl])
    unsubscribe()
  } finally {
    Date.now = originalNow
    globalThis.fetch = originalFetch
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  }
})
