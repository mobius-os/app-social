import test from 'node:test'
import assert from 'node:assert/strict'

import {
  cachedAvatar, cachedAvatarUrl, primeAvatar, subscribeAvatar,
} from '../avatarCache.js'

const wire = (byte) => ({ mime: 'image/webp', data_b64: Buffer.from([byte]).toString('base64') })
const response = (avatars = {}) => ({
  ok: true,
  json: async () => ({ avatars, missing: [], unavailable: [] }),
})

test('avatar cache batches peers, serializes batches, and preserves a newer profile prime', async () => {
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
    const one = cachedAvatar('one.example')
    const two = cachedAvatar('two.example')
    await Promise.all([one.promise, two.promise])
    assert.deepEqual(calls, [['one.example', 'two.example']])

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

    primeAvatar('owner.example', wire(9))
    assert.equal(cachedAvatarUrl('owner.example'), authoritativeUrl)
    primeAvatar('owner.example', wire(10))
    assert.notEqual(cachedAvatarUrl('owner.example'), authoritativeUrl)
    assert.deepEqual(revoked, [authoritativeUrl])
    unsubscribe()
  } finally {
    globalThis.fetch = originalFetch
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  }
})
