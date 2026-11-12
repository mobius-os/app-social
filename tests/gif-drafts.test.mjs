import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { completedParticipationIntent } from '../participation.js'
import { attachmentBytes, THUMBNAIL_MAX_BYTES } from '../media_limits.js'
import { reconcileReplies, upsertReplyAttempt } from '../reconciliation.js'
import { revokeLocalPreviews } from '../ui/boardEdits.js'
import { gifCaptionLimit, gifTextOverflow, stagedGif, withGif } from '../gifs.js'
import { TEXT_LIMITS } from '../text_limits.js'

const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
const timeline = readFileSync(new URL('../ui/useMessageTimeline.jsx', import.meta.url), 'utf8')

const FIRST = 'https://static.klipy.com/ii/0000000000000000000000000000000a/00/aa/first.gif'
const SECOND = 'https://static.klipy.com/ii/0000000000000000000000000000000b/00/bb/second.gif'
const result = (url, title = 'GIF') => ({ id: title, title, send: { url }, preview: { url } })

function section(source, start, end) {
  const a = source.indexOf(start)
  const b = source.indexOf(end, a)
  assert.ok(a >= 0 && b > a, `${start} exists`)
  return source.slice(a, b)
}

// Run the Board's own function bodies with their React state mocked.
function owning(source, start, end, deps) {
  return Function('deps', `with (deps) { return (${section(source, start, end).trim()}) }`)(deps)
}

// A stand-in for useGifChoice whose state lives on `holder[key]`.
function gifChoice(holder, key) {
  return {
    get gif() { return holder[key] },
    setGif(value) { holder[key] = value },
    pick(chosen) { holder[key] = stagedGif(chosen) },
  }
}

function postComposer({ draft = 'Look', gif = stagedGif(result(FIRST)), lose = true } = {}) {
  const sent = []
  let ids = 0
  const deps = {
    draft, selectedImages: [], postMessageId: null, posting: false, gif,
    me: { host: 'member.example', handle: 'member' }, feed: [], feedRef: { current: [] },
    withGif, gifTextOverflow, TEXT_LIMITS, revokeLocalPreviews, window: {},
    crypto: { randomUUID: () => `post-${++ids}` },
    setPostMessageId: (value) => { deps.postMessageId = value },
    setDraft: (value) => { deps.draft = value },
    setSelectedImages: (value) => { deps.selectedImages = value },
    setPosting: (value) => { deps.posting = value },
    markActivity() {}, setPending() {}, setComposing() {}, showToast() {},
    collectImagePayloads: async () => ({ previews: [] }),
    createParticipationIntent: () => ({}), completedParticipationIntent: () => ({}),
    publishPost: async (text, _a, _b, _c, id) => {
      sent.push({ text, id })
      // The post is stored but its response never arrives.
      if (deps.lose) throw new Error('Connection interrupted')
      return { id }
    },
    onPostConfirmed() {}, onCompleteParticipation() {},
    lose,
  }
  deps.postGif = gifChoice(deps, 'gif')
  return {
    deps, sent,
    publish: owning(board, 'async function publish() {', 'async function submitPost', deps),
    pick: owning(board, 'function pickPostGif(chosen) {', 'function removePostGif', deps),
    remove: owning(board, 'function removePostGif() {', 'function chooseImage', deps),
    clearLanded: owning(board, 'function clearLandedPostDraft() {', 'useEffect(clearLandedPostDraft', deps),
  }
}

test('a post retried unchanged after a lost response keeps its id and GIF', async () => {
  const view = postComposer()
  await view.publish()
  assert.equal(view.deps.postMessageId, 'post-1', 'the retry id is retained')
  assert.equal(view.deps.gif.url, FIRST, 'the GIF is restored with the draft')
  await view.publish()
  assert.deepEqual(view.sent, [
    { text: `Look\n${FIRST}`, id: 'post-1' }, { text: `Look\n${FIRST}`, id: 'post-1' },
  ])
})

test('replacing a post GIF after a lost response sends a new post with a new id', async () => {
  const view = postComposer()
  await view.publish()
  view.pick(result(SECOND))
  assert.equal(view.deps.postMessageId, null)
  view.deps.lose = false
  await view.publish()
  assert.deepEqual(view.sent.at(-1), { text: `Look\n${SECOND}`, id: 'post-2' })
  assert.notEqual(view.sent[0].id, view.sent[1].id)
})

test('removing a post GIF after a lost response sends a new post with a new id', async () => {
  const view = postComposer()
  await view.publish()
  view.remove()
  assert.equal(view.deps.gif, null)
  assert.equal(view.deps.postMessageId, null)
  await view.publish()
  assert.deepEqual(view.sent.at(-1), { text: 'Look', id: 'post-2' })
})

test('a late-confirmed post clears its staged GIF with the rest of the draft', async () => {
  const view = postComposer()
  await view.publish()
  view.clearLanded()
  assert.equal(view.deps.gif?.url, FIRST, 'nothing is cleared before the post lands')
  view.deps.feed = [{ id: 'post-1' }]
  view.clearLanded()
  assert.equal(view.deps.draft, '')
  assert.equal(view.deps.gif, null)
  assert.equal(view.deps.postMessageId, null)
})

const replyHandlers = [
  section(board, 'const profileCache =', 'function Avatar('),
  section(board, '  // A retained retry id whose reply has since landed', '  // A retained post retry id'),
  section(board, '  async function loadReplies(', '  function openReplies('),
  section(board, '  async function sendReply(', '  const { overrides: reactionOverrides'),
].join('\n')

function replyComposer({ draft = 'My reply', gif = stagedGif(result(FIRST)) } = {}) {
  const post = { id: 'test-post', reply_count: 0 }
  const sent = []
  let ids = 0
  const effects = []
  const context = vm.createContext({
    Date, Map, Set, String, Number, Promise,
    crypto: { randomUUID: () => `reply-${++ids}` },
    completedParticipationIntent, attachmentBytes, THUMBNAIL_MAX_BYTES, reconcileReplies, upsertReplyAttempt,
    withGif, gifTextOverflow, TEXT_LIMITS,
    useEffect(run) { effects.push(run) },
    replyRequest: { current: 0 }, replySendingRef: { current: false },
    replyPost: post, replyDraft: draft, replySending: false, replies: [],
    replyImage: null, replyMessageId: null, preparingReplyImage: false, gif,
    replyDrafts: { current: new Map() }, replyPostIdRef: { current: post.id },
    canInteract: true, handoffBusy: false, lose: true,
    me: { host: 'member.example', handle: 'member' },
    window: { mobius: { signal() {} } },
    markActivity() {}, onCompleteParticipation() {}, async onRefresh() {}, showToast() {},
    setReplies(value) { context.replies = typeof value === 'function' ? value(context.replies) : value },
    setReplyState() {}, setReplyError() {},
    setReplyDraft(value) { context.replyDraft = value },
    setReplyImage(value) { context.replyImage = value },
    setReplyMessageId(value) { context.replyMessageId = value },
    setReplySending(value) { context.replySending = value },
    async getReplies() { return { replies: context.replies } },
    async postReply(_postId, text, options) {
      sent.push({ text, id: options.id })
      if (context.lose) throw new Error('Connection interrupted')
      return { id: options.id }
    },
  })
  context.replyGif = gifChoice(context, 'gif')
  vm.runInContext(replyHandlers, context)
  return {
    post, context, sent,
    send: () => context.sendReply({ preventDefault() {} }),
    // Re-run the Board's reconciliation effect against the current replies.
    reconcile: () => effects.forEach((run) => run()),
  }
}

test('a reply retried unchanged after a lost response keeps its id and GIF', async () => {
  const view = replyComposer()
  await view.send()
  assert.equal(view.context.replyMessageId, 'reply-1')
  assert.equal(view.context.gif.url, FIRST)
  await view.send()
  assert.deepEqual(view.sent.map(({ id }) => id), ['reply-1', 'reply-1'])
})

test('replacing a reply GIF after a lost response sends a new reply with a new id', async () => {
  const view = replyComposer()
  await view.send()
  view.context.pickReplyGif(result(SECOND))
  assert.equal(view.context.replyMessageId, null)
  await view.send()
  assert.deepEqual(view.sent.at(-1), { text: `My reply\n${SECOND}`, id: 'reply-2' })
})

test('removing a reply GIF after a lost response sends a new reply with a new id', async () => {
  const view = replyComposer()
  await view.send()
  view.context.removeReplyGif()
  assert.equal(view.context.gif, null)
  assert.equal(view.context.replyMessageId, null)
  await view.send()
  assert.deepEqual(view.sent.at(-1), { text: 'My reply', id: 'reply-2' })
})

test('a late-confirmed reply clears its staged GIF with the rest of the draft', async () => {
  const view = replyComposer()
  await view.send()
  view.reconcile()
  assert.equal(view.context.gif?.url, FIRST, 'nothing is cleared before the reply lands')
  view.context.replies = [{ id: 'reply-1', text: `My reply\n${FIRST}`, created_at: 1 }]
  view.reconcile()
  assert.equal(view.context.replyDraft, '')
  assert.equal(view.context.gif, null)
  assert.equal(view.context.replyMessageId, null)
})

test('a reply GIF and its retry id travel together when the thread is left and reopened', () => {
  const view = replyComposer()
  const gif = stagedGif(result(SECOND))
  view.context.replyDrafts.current.set('other-post', { text: 'Elsewhere', gif, id: 'reply-9' })
  view.context.restoreReplyDraft('other-post')
  assert.equal(view.context.gif, gif)
  assert.equal(view.context.replyMessageId, 'reply-9')
  view.context.restoreReplyDraft('never-drafted')
  assert.equal(view.context.gif, null, 'another thread never inherits a GIF')
})

// Budgets: the GIF link and its newline count against each service limit.
const gif = stagedGif(result(FIRST))
const reserve = FIRST.length + 1

for (const [kind, limit] of [['post', 4000], ['reply', 1000], ['message', 40000]]) {
  test(`a ${kind} GIF picked before typing leaves exactly the caption budget`, () => {
    assert.equal(TEXT_LIMITS[kind], limit)
    const budget = gifCaptionLimit(limit, gif)
    assert.equal(budget, limit - reserve)
    const full = 'x'.repeat(budget)
    assert.equal(withGif(full, gif).length, limit)
    assert.equal(gifTextOverflow(full, gif, limit), 0)
    assert.equal(gifTextOverflow(`${full}x`, gif, limit), 1)
    assert.equal(gifCaptionLimit(limit, null), limit, 'no GIF, no reservation')
  })

  test(`a ${kind} GIF picked after a full caption shows how far over it is`, () => {
    const full = 'x'.repeat(limit)
    assert.equal(gifTextOverflow(full, null, limit), 0)
    assert.equal(gifTextOverflow(full, gif, limit), reserve)
    assert.equal(gifTextOverflow(`  ${'x'.repeat(limit - reserve)}  `, gif, limit), 0, 'trimmed text is what is sent')
  })
}

test('a post over the limit with its GIF is never sent or cut; at the limit it sends whole', async () => {
  const over = postComposer({ draft: 'x'.repeat(TEXT_LIMITS.post), gif, lose: false })
  await over.publish()
  assert.equal(over.sent.length, 0)
  assert.equal(over.deps.draft.length, TEXT_LIMITS.post, 'the caption is left as typed')
  assert.equal(over.deps.gif, gif)
  const exact = postComposer({ draft: 'x'.repeat(TEXT_LIMITS.post - reserve), gif, lose: false })
  await exact.publish()
  assert.equal(exact.sent[0].text.length, TEXT_LIMITS.post)
})

test('a reply over the limit with its GIF is never sent or cut; at the limit it sends whole', async () => {
  const over = replyComposer({ draft: 'x'.repeat(TEXT_LIMITS.reply), gif })
  await over.send()
  assert.equal(over.sent.length, 0)
  assert.equal(over.context.replyDraft.length, TEXT_LIMITS.reply)
  const exact = replyComposer({ draft: 'x'.repeat(TEXT_LIMITS.reply - reserve), gif })
  exact.context.lose = false
  await exact.send()
  assert.equal(exact.sent[0].text.length, TEXT_LIMITS.reply)
})

test('a message over the limit with its GIF is never sent or cut; at the limit it sends whole', async () => {
  const run = async (draft) => {
    const sent = []
    const deps = {
      draft, selectedImage: null, replyTarget: null, sending: false, processingImage: false,
      withGif, gifTextOverflow, TEXT_LIMITS, gif,
      sendBlocked: false, stickToBottom: { current: false }, messages: [],
      signals: { created: 'message', error: 'send' },
      setSending() {}, setDraft: (value) => { deps.draft = value }, setSelectedImage() {}, setReplyTarget() {},
      updateMessages: (next) => { deps.messages = typeof next === 'function' ? next(deps.messages) : next },
      deliver: async (message) => { sent.push(message); return { status: 'delivered', id: message.id } },
      settleMessage: (prior) => prior, onSent() {}, refresh: async () => {}, showToast() {},
      inputRef: { current: null }, window: {}, isDefinitePrecommitRejection: () => false,
    }
    deps.gifChoice = gifChoice(deps, 'gif')
    await owning(timeline, 'async function send(event) {', 'async function retry', deps)({ preventDefault() {} })
    return { sent, deps }
  }
  const over = await run('x'.repeat(TEXT_LIMITS.message))
  assert.equal(over.sent.length, 0)
  assert.equal(over.deps.draft.length, TEXT_LIMITS.message)
  const exact = await run('x'.repeat(TEXT_LIMITS.message - reserve))
  assert.equal(exact.sent[0].text.length, TEXT_LIMITS.message)
})

test('every composer reserves its staged GIF in its budget and shows the over-limit state', () => {
  assert.match(board, /maxLength=\{gifCaptionLimit\(TEXT_LIMITS\.post, postGif\.gif\)\} overLimit=\{postOverLimit\}/)
  assert.match(board, /maxLength=\{gifCaptionLimit\(TEXT_LIMITS\.reply, replyGif\.gif\)\} overLimit=\{replyOverLimit\}/)
  assert.match(board, /postOverLimit > 0 \|\|/)
  assert.match(board, /replyOverLimit > 0 \|\|/)
  assert.match(timeline, /maxLength=\{gifCaptionLimit\(TEXT_LIMITS\.message, gif\)\} overLimit=\{overLimit\}/)
  assert.match(timeline, /overLimit > 0 \|\|/)
  // GIF edits go through the Board's draft handlers, which reset the retry id.
  assert.match(board, /onPick=\{pickPostGif\}/)
  assert.match(board, /onPick=\{pickReplyGif\}/)
  assert.match(board, /onRemove=\{removePostGif\}/)
  assert.match(board, /onRemove=\{removeReplyGif\}/)
})
