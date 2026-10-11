import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { reachedEarlierHistory } from '../ui/historyScroll.js'
import { prependedScrollTop } from '../ui/interactionRules.js'

function owningFunction(file, start, end, deps) {
  const source = readFileSync(new URL(`../ui/${file}`, import.meta.url), 'utf8')
  const a = source.indexOf(start)
  const b = source.indexOf(end, a)
  assert.ok(a >= 0 && b > a, `${file}: owning function exists`)
  // Execute the actual component function body with its hook values mocked;
  // no alternate pagination implementation is introduced by these tests.
  return Function('deps', `with (deps) { return (${source.slice(a, b).trim()}) }`)(deps)
}

test('near-top means an upward user scroll, never initial position or prepend anchoring', () => {
  const el = { scrollTop: 0, scrollHeight: 1000, clientHeight: 300 }
  assert.equal(reachedEarlierHistory(null, el), false)
  assert.equal(reachedEarlierHistory(0, el), false)
  el.scrollTop = 40
  assert.equal(reachedEarlierHistory(200, el), true)
  assert.equal(reachedEarlierHistory(20, el), false)
  el.scrollHeight = el.clientHeight
  assert.equal(reachedEarlierHistory(200, el), false)
})

// Chromium and Firefox anchor scroll on prepend by themselves; Safari may not.
// The restored position must be the same either way, never applied twice.
for (const anchoring of [false, true]) {
  test(`the shared timeline owns near-top pagination, dedupe, retry and prepend restore (${anchoring ? 'with' : 'without'} scroll anchoring)`, async () => {
    const el = { scrollTop: 200, scrollHeight: 1000, clientHeight: 300 }
    const calls = []
    let resolve, reject
    const deps = {
      nextCursor: 'first', loadingEarlier: false, earlierInFlight: { current: false },
      earlierFailed: { current: false }, lastScrollTop: { current: 200 },
      paginationGeneration: { current: 1 }, prepended: { current: null },
      scrollRef: { current: el }, stickToBottom: { current: true },
      reachedEarlierHistory, prependedScrollTop, pinnedTop: false,
      loadPage: (...args) => { calls.push(args); return new Promise((yes, no) => { resolve = yes; reject = no }) },
      reconcileOlderPage: (_prior, page) => page,
      messagesRef: { current: [{ id: 'latest' }] },
      // React commits the prepend, the browser may anchor, then the layout
      // effect restores the position before paint.
      updateMessages: rows => {
        deps.messagesRef.current = rows
        el.scrollHeight += 100
        if (anchoring) el.scrollTop += 100
        deps.restorePrependedPosition()
      },
      setNextCursor: cursor => { deps.nextCursor = cursor },
      setLoadingEarlier: value => { deps.loadingEarlier = value },
      setLoadError: value => { deps.loadError = value },
    }
    const file = 'useMessageTimeline.jsx'
    deps.restorePrependedPosition = owningFunction(file, 'function restorePrependedPosition() {', 'useLayoutEffect(restorePrependedPosition', deps)
    const load = owningFunction(file, 'async function loadEarlier() {', '// Browser scroll anchoring may', deps)
    deps.loadEarlier = load
    const track = owningFunction(file, 'function trackScroll() {', 'async function chooseImage', deps)

    el.scrollTop = 40
    track()
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], 'first')
    assert.equal(deps.stickToBottom.current, false, 'reading back stops pinning to the newest message')
    el.scrollTop = 30
    track()
    assert.equal(calls.length, 1, 'one page request in flight')
    resolve({ messages: [{ id: 'older' }], nextCursor: null })
    await new Promise(setImmediate)
    assert.equal(el.scrollTop, 130, 'prepend keeps the visible message in place, measured at prepend time')
    assert.equal(deps.nextCursor, null)
    el.scrollTop = 20
    track()
    assert.equal(calls.length, 1, 'no cursor means no more requests')

    deps.nextCursor = 'retry'
    el.scrollTop = 150
    track()
    el.scrollTop = 25
    track()
    assert.equal(calls.length, 2)
    reject(new Error('offline'))
    await new Promise(setImmediate)
    assert.match(deps.loadError, /Earlier messages couldn’t be loaded/)
    el.scrollTop = 20
    track()
    assert.equal(calls.length, 2, 'failure stays visible rather than auto-retrying')
    const retry = load()
    assert.equal(calls.length, 3, 'explicit retry is possible')
    resolve({ messages: [{ id: 'oldest' }], nextCursor: null })
    await retry
    assert.equal(el.scrollTop, 120)
    assert.equal(deps.prepended.current, null, 'a restore applies once')
    assert.equal(deps.loadError, '')
  })
}

test('pending previews stay at the top and never page history by scrolling', () => {
  const el = { scrollTop: 10, scrollHeight: 1000, clientHeight: 300 }
  let requested = false
  const deps = {
    scrollRef: { current: el }, pinnedTop: true, lastScrollTop: { current: 200 },
    stickToBottom: { current: true }, reachedEarlierHistory, nextCursor: 'first',
    earlierFailed: { current: false }, loadEarlier: () => { requested = true },
  }
  owningFunction('useMessageTimeline.jsx', 'function trackScroll() {', 'async function chooseImage', deps)()
  assert.equal(requested, false)
})

test('direct and group threads share the timeline owner instead of duplicating it', () => {
  for (const [file, listName] of [['Thread.jsx', 'listMessages'], ['GroupThread.jsx', 'listGroupMessages']]) {
    const source = readFileSync(new URL(`../ui/${file}`, import.meta.url), 'utf8')
    assert.match(source, /useMessageTimeline\(\{/)
    assert.match(source, new RegExp(`loadPage: \\(cursor, options\\) => ${listName}\\(`))
    assert.doesNotMatch(source, /function (loadEarlier|trackScroll|send)\(/)
  }
})

test('Community owner only triggers on upward near-top scroll and preserves prepend offset', async () => {
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  assert.match(board, /reachedEarlierHistory\(lastScrollTop\.current, scroller\)/)
  assert.match(board, /shouldLoad && feedState === 'ready' && hasEarlier && !earlierFailed\.current/)
  assert.match(board, /earlierInFlight\.current = true/)
  assert.match(board, /earlierFailed\.current = true/)
  assert.match(board, /onClick=\{loadEarlierPosts\}>Try again/)
  const el = { scrollTop: 24, scrollHeight: 1000, clientHeight: 300 }
  let resolve
  const deps = {
    feed: [{ created_at: 12 }], hasEarlier: true,
    earlierInFlight: { current: false }, earlierFailed: { current: false },
    scrollRef: { current: el },
    setLoadingEarlier: value => { deps.loadingEarlier = value },
    setEarlierError: value => { deps.error = value },
    onLoadEarlier: () => new Promise(yes => { resolve = yes }),
    requestAnimationFrame: callback => { deps.frame = callback },
    prependedScrollTop,
  }
  const load = owningFunction('Board.jsx', 'async function loadEarlierPosts() {', 'function markActivity', deps)
  const first = load()
  load()
  assert.equal(deps.loadingEarlier, true)
  assert.equal(deps.earlierInFlight.current, true)
  el.scrollHeight = 1150
  resolve()
  await first
  deps.frame()
  assert.equal(el.scrollTop, 174)
  assert.equal(deps.earlierInFlight.current, false)
  deps.onLoadEarlier = () => Promise.reject(new Error('offline'))
  await load()
  assert.match(deps.error, /Earlier posts couldn’t be loaded/)
  assert.equal(deps.earlierFailed.current, true)
  deps.onLoadEarlier = () => Promise.resolve()
  await load() // the visible Try again button calls this owner function
  assert.equal(deps.error, '')
  deps.hasEarlier = false
  deps.onLoadEarlier = () => { throw new Error('must not fetch') }
  await load()
})
