import assert from 'node:assert/strict'
import test from 'node:test'
import { AVATAR_FAILURE_RETRY_MS } from '../profile.js'

const wire = { mime: 'image/webp', data_b64: 'AQ==' }
const settle = async () => {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}

async function mountedPicture(t, name, answer) {
  const previous = { fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document }
  const document = new EventTarget()
  document.visibilityState = 'visible'
  globalThis.document = document
  globalThis.window = { mobius: { storage: { async get() { return null }, async set() {}, async remove() {} } } }
  const requests = []
  globalThis.fetch = async (_url, options) => {
    const { hosts } = JSON.parse(options.body)
    requests.push(hosts)
    return { ok: true, json: async () => answer(requests.length, hosts) }
  }
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 })
  const cache = await import(`../avatarCache.js?recovery=${name}`)
  const host = `${name}.example`
  const record = cache.cachedAvatar(host)
  const shown = []
  let unsubscribe = cache.subscribeAvatar(record, url => shown.push(url))
  t.after(() => {
    unsubscribe()
    Object.assign(globalThis, previous)
  })
  await record.promise
  return { cache, host, record, requests, shown, document,
    unmount() { unsubscribe() },
    remount() { unsubscribe = cache.subscribeAvatar(record, url => shown.push(url)) },
  }
}

const unavailable = () => ({ avatars: {}, missing: [], unavailable: [] })
const found = hosts => ({ avatars: Object.fromEntries(hosts.map(host => [host, wire])), missing: [], unavailable: [] })

test('a mounted blank picture recovers after a transient failure without opening its profile', async t => {
  const view = await mountedPicture(t, 'mounted-recovery', (call, hosts) => call === 1 ? unavailable() : found(hosts))
  assert.equal(view.record.url, null)
  t.mock.timers.tick(AVATAR_FAILURE_RETRY_MS - 1)
  await settle()
  assert.equal(view.requests.length, 1, 'retain the existing failure cooldown')
  t.mock.timers.tick(1)
  await settle()
  assert.equal(view.requests.length, 2)
  assert.ok(view.record.url)
  assert.equal(view.shown.at(-1), view.record.url)
  t.mock.timers.tick(AVATAR_FAILURE_RETRY_MS * 3)
  await settle()
  assert.equal(view.requests.length, 2, 'a recovered picture has no recurring recovery work')
})

test('repeated transport failures remain paced by the existing cooldown', async t => {
  const view = await mountedPicture(t, 'still-unavailable', unavailable)
  t.mock.timers.tick(AVATAR_FAILURE_RETRY_MS)
  await settle()
  assert.equal(view.requests.length, 2)
  t.mock.timers.tick(AVATAR_FAILURE_RETRY_MS - 1)
  await settle()
  assert.equal(view.requests.length, 2)
  t.mock.timers.tick(1)
  await settle()
  assert.equal(view.requests.length, 3)
})

test('unmounting the last picture cancels recovery; remounting observes its remaining cooldown', async t => {
  const view = await mountedPicture(t, 'unmounted-recovery', (call, hosts) => call === 1 ? unavailable() : found(hosts))
  view.unmount()
  t.mock.timers.tick(AVATAR_FAILURE_RETRY_MS - 1)
  await settle()
  assert.equal(view.requests.length, 1)
  view.remount()
  t.mock.timers.tick(1)
  await settle()
  assert.equal(view.requests.length, 2)
})

test('hidden documents pause picture recovery and resume overdue work when visible', async t => {
  const view = await mountedPicture(t, 'hidden-recovery', (call, hosts) => call === 1 ? unavailable() : found(hosts))
  view.document.visibilityState = 'hidden'
  view.document.dispatchEvent(new Event('visibilitychange'))
  t.mock.timers.tick(AVATAR_FAILURE_RETRY_MS * 2)
  await settle()
  assert.equal(view.requests.length, 1)
  view.document.visibilityState = 'visible'
  view.document.dispatchEvent(new Event('visibilitychange'))
  t.mock.timers.tick(0)
  await settle()
  assert.equal(view.requests.length, 2)
})

test('a newer directory picture hint can recover a mounted blank without another mount', async t => {
  const view = await mountedPicture(t, 'changed-hint-recovery', (call, hosts) => call === 1 ? unavailable() : found(hosts))
  const { noteAvatarDigests } = await import('../avatarHints.js')
  noteAvatarDigests([{ host: view.host, avatar: 'f'.repeat(64) }])
  await settle()
  assert.equal(view.requests.length, 2)
  assert.ok(view.record.url)
  t.mock.timers.tick(AVATAR_FAILURE_RETRY_MS)
  await settle()
  assert.equal(view.requests.length, 2, 'the old failure deadline must not duplicate the successful hint refresh')
})

test('an authoritative profile picture supersedes scheduled recovery', async t => {
  const view = await mountedPicture(t, 'primed-recovery', unavailable)
  view.cache.primeAvatar(view.host, wire)
  t.mock.timers.tick(AVATAR_FAILURE_RETRY_MS)
  await settle()
  assert.equal(view.requests.length, 1)
  assert.ok(view.record.url)
})

test('directory hints cannot resurrect an authoritatively removed owner picture', async t => {
  const view = await mountedPicture(t, 'removed-owner-picture', (_call, hosts) => found(hosts))
  view.cache.primeAvatar(view.host, wire)
  view.cache.primeAvatar(view.host, null)
  const { noteAvatarDigests } = await import('../avatarHints.js')
  noteAvatarDigests([{ host: view.host, avatar: 'e'.repeat(64) }])
  await settle()
  t.mock.timers.tick(AVATAR_FAILURE_RETRY_MS * 2)
  await settle()
  assert.equal(view.requests.length, 1)
  assert.equal(view.record.url, null)
})

test('confirmed absence does not enter the transient-failure recovery loop', async t => {
  const view = await mountedPicture(t, 'confirmed-no-picture', (_call, hosts) => ({ avatars: {}, missing: hosts }))
  t.mock.timers.tick(AVATAR_FAILURE_RETRY_MS * 4)
  await settle()
  assert.equal(view.requests.length, 1)
  assert.equal(view.record.url, null)
})

test('a discarded undecodable picture recovers under the same cooldown instead of spinning', async t => {
  const view = await mountedPicture(t, 'decode-recovery', (_call, hosts) => found(hosts))
  view.cache.discardAvatar(view.host, view.record.url)
  t.mock.timers.tick(AVATAR_FAILURE_RETRY_MS - 1)
  await settle()
  assert.equal(view.requests.length, 1)
  t.mock.timers.tick(1)
  await settle()
  assert.equal(view.requests.length, 2)
  assert.ok(view.record.url)
})
