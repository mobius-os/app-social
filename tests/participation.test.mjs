import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { setToken, postReply } from '../api.js'
import { SHARED_COMMUNITY_HOST } from '../community.js'
import {
  PARTICIPATION_INTENT_PATH, accountHandoff, clearParticipationIntent,
  createParticipationIntent, loadParticipationIntent, participationStep,
  participationIntentMatches, saveParticipationIntent,
} from '../participation.js'

const originalFetch = globalThis.fetch
test.afterEach(() => { globalThis.fetch = originalFetch })

function memoryStorage() {
  const values = new Map()
  let version = 0
  return {
    values,
    async get(path) { return values.get(path) ?? null },
    async getWithVersion(path) { return { value: values.get(path) ?? null, version: version || null } },
    async durableWrite(path, value, opts) {
      if ((opts.ifNoneMatch && version) || (opts.ifMatch != null && opts.ifMatch !== version)) {
        throw Object.assign(new Error('Draft changed in another window'), { code: 'conflict' })
      }
      values.set(path, value)
      version++
    },
    async set(path, value) { values.set(path, value) },
    async remove(path) { values.delete(path) },
  }
}

test('a post draft and attachment survive an account handoff without being submitted', async () => {
  const storage = memoryStorage()
  const attachment = {
    mime: 'image/jpeg', data_b64: 'cGhvdG8=', w: 640, h: 480,
  }
  const intent = createParticipationIntent('post', {
    text: 'Still mine until I press Post', attachment,
  })
  assert.equal(await saveParticipationIntent(storage, intent), true)

  const messages = []
  accountHandoff({ identity_app_id: 42 }, (...args) => messages.push(args))

  assert.deepEqual(await loadParticipationIntent(storage), intent)
  assert.deepEqual(messages, [[{ type: 'moebius:open-app', appId: 42 }, '*']])
  assert.equal(storage.values.has(PARTICIPATION_INTENT_PATH), true)
})

test('cancelled or incomplete sign-in leaves the exact reply draft waiting', async () => {
  const storage = memoryStorage()
  const intent = createParticipationIntent('reply', {
    postId: '12345678-abcd', text: 'I will decide when to send this',
  })
  await saveParticipationIntent(storage, intent)
  assert.deepEqual(await loadParticipationIntent(storage), intent)
})

test('a missing Identity installation opens its exact Store listing', () => {
  const messages = []
  assert.equal(accountHandoff({}, (...args) => messages.push(args)), 'store')
  assert.deepEqual(messages, [[{
    type: 'moebius:open-app', appId: 'store', intent: 'app:identity',
  }, '*']])
})

test('participation keeps account linking, directory consent and final action separate', () => {
  assert.equal(participationStep({ connected: false, joined: false }), 'store')
  assert.equal(participationStep({ connected: false, joined: false, identity_app_id: 8 }), 'identity')
  assert.equal(participationStep({ connected: true, joined: false, name: 'Ada' }), 'join')
  assert.equal(participationStep({
    connected: true, joined: true, name: 'Ada', community_host: SHARED_COMMUNITY_HOST,
  }), 'ready')
})

test('only explicit completion clears a pending action', async () => {
  const storage = memoryStorage()
  await saveParticipationIntent(storage, createParticipationIntent('like', { postId: '12345678' }))
  assert.ok(await loadParticipationIntent(storage))
  assert.equal(await clearParticipationIntent(storage, await loadParticipationIntent(storage)), true)
  assert.equal(await loadParticipationIntent(storage), null)
})

test('posting a different draft cannot consume the preserved one', () => {
  const pending = createParticipationIntent('post', { text: 'Keep this' })
  assert.equal(participationIntentMatches(
    pending, createParticipationIntent('post', { text: 'Something else' }),
  ), false)
  assert.equal(participationIntentMatches(
    pending, createParticipationIntent('post', { text: 'Keep this' }),
  ), true)
})

test('public board and directory render independently from global-directory membership', () => {
  const source = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
  assert.match(source, /if \(profile\) loadFeed\(\)/)
  assert.match(source, /\{tab === 'board' && \(/)
  assert.match(source, /\{tab === 'people' && \(/)
  assert.doesNotMatch(source, /tab === 'board' && !needsJoin/)
  assert.doesNotMatch(source, /tab === 'people' && !needsJoin/)
})

test('board replies use the owner route that signs and forwards remote replies', async () => {
  setToken('social-app-token')
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/common/reply')
    assert.equal(options.method, 'POST')
    assert.equal(options.headers.Authorization, 'Bearer social-app-token')
    assert.deepEqual(JSON.parse(options.body), { post_id: '12345678', text: 'Hello' })
    return Response.json({ status: 'ok' })
  }
  assert.deepEqual(await postReply('12345678', 'Hello'), { status: 'ok' })
})

test('the UI keeps a final explicit control for publish, reply and react', () => {
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  assert.match(board, /onClick=\{\(\) => canInteract\s*\? publish\(\)/)
  assert.match(board, /<form className=.*onSubmit=\{sendReply\}>/)
  assert.match(board, /onClick=\{\(\) => canInteract\s*\? toggleLike\(post\)/)
  assert.match(board, /Nothing was shared automatically/)
})


test('a Like cannot overwrite an existing photo post draft', async () => {
  const storage = memoryStorage()
  const post = createParticipationIntent('post', { text: 'Keep this photo',
    attachment: { mime: 'image/png', data_b64: 'cGhvdG8=', w: 12, h: 12 } })
  await saveParticipationIntent(storage, post)
  await assert.rejects(saveParticipationIntent(storage,
    createParticipationIntent('like', { postId: 'different-post' })), /already have a saved action/)
  assert.deepEqual(await loadParticipationIntent(storage), post)
})

test('concurrent first saves keep exactly one complete draft', async () => {
  const storage = memoryStorage()
  const post = createParticipationIntent('post', { text: 'First window' })
  const reply = createParticipationIntent('reply', { postId: 'post-1', text: 'Second window' })
  const results = await Promise.allSettled([
    saveParticipationIntent(storage, post), saveParticipationIntent(storage, reply),
  ])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.deepEqual(await loadParticipationIntent(storage), post)
})

test('stale completion cannot erase a different saved intent', async () => {
  const storage = memoryStorage()
  const old = createParticipationIntent('like', { postId: 'old-post' })
  const next = createParticipationIntent('post', { text: 'New window draft' })
  await saveParticipationIntent(storage, next)
  assert.equal(await clearParticipationIntent(storage, old), false)
  assert.deepEqual(await loadParticipationIntent(storage), next)
})

test('repeating the same saved draft is idempotent', async () => {
  const storage = memoryStorage()
  const post = createParticipationIntent('post', { text: 'Keep' })
  await saveParticipationIntent(storage, post)
  await saveParticipationIntent(storage, post)
  assert.equal((await storage.getWithVersion(PARTICIPATION_INTENT_PATH)).version, 1)
})
