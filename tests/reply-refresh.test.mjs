import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import { createParticipationIntent } from '../participation.js'
import { reconcileReplies, upsertReplyAttempt } from '../reconciliation.js'

const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')

// Exercise the actual cache and event handlers without React or live federation.
function section(start, end) {
  const first = board.indexOf(start)
  const last = board.indexOf(end, first)
  assert.ok(first >= 0 && last > first, `Missing Board handler: ${start}`)
  return board.slice(first, last)
}

const handlers = [
  section('const profileCache =', 'function Avatar('),
  section('  async function loadReplies(', '  function openReplies('),
  section('  async function sendReply(', '  const { overrides: reactionOverrides'),
].join('\n')

const reply = (id, text = id) => ({
  id, text, host: 'member.example', handle: 'member', created_at: 1,
})

function thread({ count = 0, read, send, image = null } = {}) {
  const post = { id: 'test-post', reply_count: count }
  let rows = []
  let serverRows = []
  let reads = 0
  let state = 'idle'
  const errors = []
  const context = vm.createContext({
    Date, Map, Set, String, Number, Promise, crypto: { randomUUID },
    createParticipationIntent, reconcileReplies, upsertReplyAttempt,
    replyRequest: { current: 0 }, replySendingRef: { current: false },
    replyPost: post, replyDraft: 'My reply', replySending: false,
    replyImage: image, replyMessageId: null, preparingReplyImage: false,
    replyDrafts: { current: new Map() }, replyPostIdRef: { current: post.id },
    canInteract: true, handoffBusy: false,
    me: { host: 'member.example', handle: 'member' },
    window: { mobius: { signal() {} } },
    markActivity() {}, onCompleteParticipation() {}, async onRefresh() {},
    showToast(message) { errors.push(message) },
    setReplies(value) { rows = typeof value === 'function' ? value(rows) : value },
    setReplyState(value) { state = value }, setReplyError() {},
    setReplyDraft(value) { context.replyDraft = value },
    setReplyImage(value) { context.replyImage = value },
    setReplyMessageId(value) { context.replyMessageId = value },
    setReplySending(value) { context.replySending = value },
    async getReplies() {
      reads += 1
      return read ? read(reads) : { replies: serverRows }
    },
    async postReply(postId, text, options) {
      if (send) return send(postId, text, options)
      const landed = reply('confirmed', context.replyDraft || 'My reply')
      serverRows = [...serverRows, landed]
      return { id: landed.id, reply_count: serverRows.length }
    },
  })
  vm.runInContext(handlers, context)
  return {
    post, context, errors,
    get ids() { return Array.from(rows, row => row.id) },
    get rows() { return rows },
    get reads() { return reads }, get state() { return state },
    set serverRows(value) { serverRows = value },
    set rows(value) { rows = value },
    load(options) { return context.loadReplies(post, options) },
    send() { return context.sendReply({ preventDefault() {} }) },
  }
}

test('initially empty threads still open immediately without a network read', async () => {
  const view = thread()
  await view.load()
  assert.equal(view.reads, 0)
  assert.equal(view.state, 'ready')
  assert.deepEqual(view.ids, [])
})

const photo = {
  payload: { mime: 'image/png', data_b64: 'cGhvdG8=', w: 40, h: 30 },
  thumbnailPayload: { mime: 'image/webp', data_b64: 'dGh1bWI=', w: 40, h: 30 },
  previewUrl: 'data:image/png;base64,cGhvdG8=',
}

test('a reply sends caption and photo together and clears both only after success', async () => {
  let sent
  const view = thread({ image: photo, send: async (...args) => {
    sent = args
    assert.equal(view.context.replyDraft, 'My reply')
    assert.equal(view.context.replyImage, photo)
    assert.equal(view.rows.at(-1).attachment.preview_url, photo.previewUrl)
    return { id: args[2].id }
  } })
  await view.send()
  assert.equal(sent[1], 'My reply')
  assert.equal(sent[2].attachment, photo.payload)
  assert.equal(sent[2].thumbnail, photo.thumbnailPayload)
  assert.equal(view.context.replyDraft, '')
  assert.equal(view.context.replyImage, null)
})

test('a photo-only reply is valid while an empty reply never sends', async () => {
  let sends = 0
  const view = thread({ image: photo, send: async (_post, _text, options) => {
    sends++
    return { id: options.id }
  } })
  view.context.replyDraft = ''
  await view.send()
  assert.equal(sends, 1)
  await view.send()
  assert.equal(sends, 1)
})

test('an interrupted photo reply retains caption, attachment and the same retry identity', async () => {
  const ids = []
  const view = thread({ image: photo, send: async (_post, _text, options) => {
    ids.push(options.id)
    throw new Error('Connection interrupted')
  } })
  await view.send()
  assert.equal(view.context.replyImage, photo)
  assert.equal(view.context.replyDraft, 'My reply')
  await view.send()
  assert.equal(ids[0], ids[1])
  assert.deepEqual(view.ids, [])
})

for (const retryFails of [false, true]) {
  test(`timeout then polling then ${retryFails ? 'failed' : 'successful'} retry preserves one authoritative reply`, async () => {
    let sends = 0, canonical = null, readFails = false
    const view = thread({ image: photo,
      read: () => {
        if (readFails) throw new Error('Confirmation read unavailable')
        return { replies: canonical ? [canonical] : [] }
      },
      send: async (_post, _text, options) => {
        sends++
        if (sends === 1) {
          canonical = { ...reply(options.id, 'My reply'), created_at: 5,
            attachment: { mime: 'image/png', w: 40, h: 30 },
            reactions: [{ emoji: '❤️', count: 1 }] }
          throw new Error('Delivery confirmation timed out')
        }
        assert.deepEqual(view.ids, [canonical.id])
        assert.equal(view.rows[0], canonical, 'retry never replaces known history with a pending row')
        readFails = true
        if (retryFails) throw new Error('Retry confirmation timed out')
        return { id: options.id }
      },
    })
    await view.send()
    assert.deepEqual(view.ids, [])
    await view.load({ background: true })
    assert.deepEqual(view.ids, [canonical.id])
    await view.send()
    assert.deepEqual(view.ids, [canonical.id])
    assert.equal(view.rows[0], canonical, 'canonical time, image metadata and reactions survive settlement')
    assert.equal(view.rows[0].pending, undefined)
    assert.equal(view.context.replyDraft, retryFails ? 'My reply' : '')
    assert.equal(view.context.replyImage, retryFails ? photo : null)
    view.rows = []
    await view.load()
    assert.deepEqual(view.ids, [canonical.id])
    assert.equal(view.rows[0], canonical, 'reopening from cache keeps the same authoritative row')
  })
}

test('removing the photo preserves its caption and editing starts a new send identity', () => {
  const view = thread({ image: photo })
  view.context.replyMessageId = 'previous-attempt'
  view.context.removeReplyImage()
  assert.equal(view.context.replyDraft, 'My reply')
  assert.equal(view.context.replyImage, null)
  assert.equal(view.context.replyMessageId, null)
  view.context.replyMessageId = 'previous-attempt'
  view.context.changeReplyDraft('Changed caption')
  assert.equal(view.context.replyMessageId, null)
})

test('reply drafts restore photo and caption by post without leaking into a different post', () => {
  const view = thread()
  view.context.replyDrafts.current.set('one', { text: 'Caption', image: photo, id: 'retry-id' })
  view.context.restoreReplyDraft('one')
  assert.equal(view.context.replyImage, photo)
  assert.equal(view.context.replyDraft, 'Caption')
  view.context.restoreReplyDraft('two')
  assert.equal(view.context.replyImage, null)
  assert.equal(view.context.replyDraft, '')
  assert.equal(view.context.replyMessageId, null)
})

test('a confirmed first reply survives successive polls with the original zero feed count', async () => {
  const view = thread()
  await view.load()
  await view.send()
  assert.deepEqual(view.ids, ['confirmed'])
  await view.load({ background: true })
  await view.load({ background: true })
  assert.deepEqual(view.ids, ['confirmed'])
  assert.equal(view.reads, 3)
  assert.equal(view.post.reply_count, 0, 'the feed count is only an opening hint')
})

test('reopening before the feed catches up retains a cached confirmed reply', async () => {
  const view = thread()
  await view.load()
  await view.send()
  await view.load()
  assert.deepEqual(view.ids, ['confirmed'])
})

test('a sent first reply survives reopening when its confirmation read fails', async () => {
  const view = thread({ read: () => { throw new Error('Offline') } })
  await view.load()
  await view.send()
  assert.deepEqual(view.ids, ['confirmed'])
  assert.equal(view.context.replyDraft, '')
  assert.deepEqual(view.errors, [], 'a failed read must not turn a successful write into a failed send')
  view.rows = []
  await view.load()
  assert.deepEqual(view.ids, ['confirmed'], 'reopening must retain the successful write despite the stale zero count')
  assert.equal(await view.load({ background: true }), false)
  assert.deepEqual(view.ids, ['confirmed'])
})

test('failed confirmation retains earlier replies, while a later canonical read can remove them', async () => {
  const view = thread({ count: 1, read: (number) => {
    if (number === 1) return { replies: [reply('earlier')] }
    if (number === 2) throw new Error('Offline')
    return { replies: [] }
  } })
  await view.load()
  await view.send()
  view.rows = []
  await view.load()
  assert.deepEqual(view.ids, ['earlier', 'confirmed'])
  await view.load({ background: true })
  assert.deepEqual(view.ids, [], 'successful snapshots remain authoritative, including deletion')
})

test('an open empty thread discovers a peer reply without waiting for cache expiry', async () => {
  const view = thread()
  await view.load()
  view.serverRows = [reply('peer-reply')]
  await view.load({ background: true })
  assert.deepEqual(view.ids, ['peer-reply'])
  assert.equal(view.reads, 1)
})

test('background checks revalidate a recently cached nonempty thread and preserve a draft', async () => {
  const view = thread({ count: 1 })
  view.serverRows = [reply('first')]
  await view.load()
  view.context.replyDraft = 'Unsent draft'
  view.serverRows = [reply('first'), reply('second')]
  await view.load({ background: true })
  assert.deepEqual(view.ids, ['first', 'second'])
  assert.equal(view.context.replyDraft, 'Unsent draft')
  assert.equal(view.reads, 2)
})

test('confirmation does not reuse a thread read started before the reply was sent', async () => {
  let releaseStale
  const view = thread({ count: 1, read: (number) => number === 1
    ? new Promise(resolve => { releaseStale = resolve })
    : { replies: [reply('confirmed')] } })
  const stale = view.load({ background: true })
  const sending = view.send()
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
  try {
    assert.equal(view.reads, 2, 'confirmation must start a post-write read')
  } finally {
    releaseStale({ replies: [] })
    await Promise.all([stale, sending])
  }
  assert.deepEqual(view.ids, ['confirmed'])
  await view.load()
  assert.deepEqual(view.ids, ['confirmed'], 'late pre-write response cannot overwrite the cache')
})

test('a failed background read keeps replies and the unsent draft intact', async () => {
  const view = thread({ count: 1, read: (number) => {
    if (number > 1) throw new Error('Offline')
    return { replies: [reply('confirmed')] }
  } })
  await view.load()
  view.context.replyDraft = 'Unsent draft'
  assert.equal(await view.load({ background: true }), false)
  assert.deepEqual(view.ids, ['confirmed'])
  assert.equal(view.context.replyDraft, 'Unsent draft')
  assert.equal(view.state, 'ready')
  assert.deepEqual(view.errors, [])
})

test('a failed send removes only its optimistic row and restores the reply draft', async () => {
  const view = thread({ count: 1, send: () => { throw new Error('Reply could not be sent') } })
  view.serverRows = [reply('earlier')]
  await view.load()
  await view.send()
  assert.deepEqual(view.ids, ['earlier'])
  assert.equal(view.context.replyDraft, 'My reply')
  assert.equal(view.context.replySending, false)
  assert.deepEqual(view.errors, ['Reply could not be sent'])
})

test('a reply whose post or retry id was deleted clears its draft and refreshes', async () => {
  let refreshed = 0
  const view = thread({ image: photo, send: () => {
    throw Object.assign(new Error('This reply was deleted.'), { status: 410 })
  } })
  view.context.onRefresh = async () => { refreshed += 1 }
  view.context.replyMessageId = 'deleted-retry'
  view.context.replyDrafts.current.set(view.post.id, { text: 'My reply', image: photo, id: 'deleted-retry' })
  await view.send()
  assert.equal(view.context.replyDraft, '')
  assert.equal(view.context.replyImage, null)
  assert.equal(view.context.replyMessageId, null)
  assert.equal(view.context.replyDrafts.current.has(view.post.id), false)
  assert.equal(refreshed, 1)
  assert.equal(view.reads, 1, 'the open thread is read again')
  assert.deepEqual(view.errors, ['This reply was deleted.'])
})

test('a forced read never joins a request that started before it', async () => {
  let releaseFirst
  const view = thread({ count: 1, read: (number) => number === 1
    ? new Promise(resolve => { releaseFirst = resolve })
    : { replies: [] } })
  const first = view.load()
  const forced = view.load({ background: true, force: true })
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
  assert.equal(view.reads, 2)
  releaseFirst({ replies: [reply('deleted')] })
  await Promise.all([first, forced])
  assert.deepEqual(view.ids, [], 'the stale read cannot bring the deleted reply back')
})

test('an ordinary background poll shares a read already in flight', async () => {
  let release
  const view = thread({ count: 1, read: (number) => number === 1
    ? new Promise(resolve => { release = resolve })
    : { replies: [] } })
  const first = view.load()
  const poll = view.load({ background: true })
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
  assert.equal(view.reads, 1, 'polls do not add duplicate reply reads on the service lane')
  release({ replies: [reply('kept')] })
  await Promise.all([first, poll])
  assert.deepEqual(view.ids, ['kept'])
})
