import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { revokeLocalPreviews } from '../ui/boardEdits.js'

const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')

function owning(start, end, deps) {
  const a = board.indexOf(start)
  const b = board.indexOf(end, a)
  assert.ok(a >= 0 && b > a, `${start} exists`)
  return Function('deps', `with (deps) { return (${board.slice(a, b).trim()}) }`)(deps)
}

function withRevokes(run) {
  const original = URL.revokeObjectURL
  const revoked = []
  URL.revokeObjectURL = (url) => revoked.push(url)
  try { return [run(), revoked] } finally { URL.revokeObjectURL = original }
}

test('only previews picked on this device own an object URL to release', () => {
  const [, revoked] = withRevokes(() => revokeLocalPreviews([
    { file: {}, previewUrl: 'blob:picked' },
    { previewUrl: 'blob:resumed-draft' },
    { file: {}, previewUrl: 'https://host.example/photo' },
    null,
  ]))
  assert.deepEqual(revoked, ['blob:picked'])
})

test('a post that lands while its publish is in flight is not confirmed a second time', async () => {
  const run = async (landsDuringRequest) => {
    const confirmed = []
    const deps = {
      draft: 'Hello', selectedImages: [], postMessageId: null, me: { host: 'me.example', handle: 'me' },
      // The render that started publishing saw an empty feed.
      feed: [], feedRef: { current: [] },
      setPostMessageId: () => {}, markActivity: () => {}, setPosting: () => {}, setPending: () => {},
      setDraft: () => {}, setSelectedImages: () => {}, setComposing: () => {}, showToast: () => {},
      collectImagePayloads: async () => ({ previews: [] }),
      createParticipationIntent: () => ({}),
      publishPost: async (_text, _a, _b, _c, id) => {
        // A feed refresh delivers the post before this response returns.
        if (landsDuringRequest) deps.feedRef.current = [{ id }]
        return { id }
      },
      onPostConfirmed: (post) => confirmed.push(post.id),
      onCompleteParticipation: () => {}, revokeLocalPreviews, window: {},
    }
    await owning('async function publish() {', 'async function submitPost', deps)()
    return confirmed.length
  }
  assert.equal(await run(false), 1, 'a post not yet in the feed is shown at once')
  assert.equal(await run(true), 0, 'the landed post keeps its counts')
})

test('a landed post draft releases its picked previews when it is cleared', () => {
  const state = {}
  const deps = {
    postMessageId: 'post-1', posting: false, feed: [{ id: 'post-1' }],
    selectedImages: [{ file: {}, previewUrl: 'blob:one' }, { file: {}, previewUrl: 'blob:two' }],
    setDraft: (value) => { state.draft = value },
    setSelectedImages: (value) => { state.images = value },
    setPostMessageId: (value) => { state.id = value },
    revokeLocalPreviews,
  }
  const clear = owning('function clearLandedPostDraft() {', 'useEffect(clearLandedPostDraft', deps)
  const [, revoked] = withRevokes(clear)
  assert.deepEqual(revoked, ['blob:one', 'blob:two'])
  assert.deepEqual(state, { draft: '', images: [], id: null })

  deps.feed = []
  const [, untouched] = withRevokes(owning('function clearLandedPostDraft() {', 'useEffect(clearLandedPostDraft', deps))
  assert.deepEqual(untouched, [], 'a draft whose post has not landed keeps its previews')
})
