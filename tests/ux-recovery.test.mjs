import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { searchPeople, getPeer } from '../api.js'

for (const [name, request] of [['people search', signal => searchPeople('a b', signal)], ['profile', signal => getPeer('example.test', signal)]]) {
  test(`${name} passes cancellation through to the network`, async () => {
    const original = globalThis.fetch
    const controller = new AbortController()
    let received
    globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
      received = options.signal
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    })
    try {
      const response = request(controller.signal)
      controller.abort()
      await assert.rejects(response, { name: 'AbortError' })
      assert.equal(received, controller.signal)
    } finally { globalThis.fetch = original }
  })
}

test('closing a profile invalidates its request instead of allowing it to reopen', () => {
  const source = readFileSync(new URL('../ui/People.jsx', import.meta.url), 'utf8')
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  assert.match(source, /const closeProfile = \(\) => \{[\s\S]*restoreProfileFocus\.current = true[\s\S]*setSelectedHost\(null\)/)
  // Profile fetching lives in the shared useProfile hook. Closing sets
  // selectedHost to null, which changes the hook key and runs its cleanup, so an
  // in-flight result cannot reopen the sheet. (A shared in-flight request can't
  // be per-consumer-aborted, so an active flag guards the stale apply.)
  assert.match(source, /useProfile\(selectedHost,/)
  assert.match(board, /function useProfile\(/)
  assert.match(board, /let active = true[\s\S]*?return \(\) => \{ active = false \}/)
  assert.match(source, /\{selectedHost && \(/)
})

test('Social modal focus owns initial focus so it can restore the actual opener', () => {
  for (const file of ['Board.jsx', 'People.jsx', 'Messages.jsx']) {
    const source = readFileSync(new URL(`../ui/${file}`, import.meta.url), 'utf8')
    assert.match(source, /useModalFocus/)
    assert.doesNotMatch(source, /autoFocus/)
  }
})

test('conversation recovery is visible and new messages do not steal the reading position', () => {
  for (const file of ['Thread.jsx', 'GroupThread.jsx']) {
    const source = readFileSync(new URL(`../ui/${file}`, import.meta.url), 'utf8')
    assert.match(source, /Messages couldn’t be refreshed/)
    assert.match(source, /onClick=\{refresh\}>Try again/)
    assert.match(source, /stickToBottom/)
    assert.match(source, /scrollHeight - el\.scrollTop - el\.clientHeight < 72/)
    assert.match(source, /paginationGeneration\.current \+= 1/)
    assert.match(source, /reconcileOlderPage/)
    assert.match(source, /generation === paginationGeneration\.current/)
  }
})

test('direct messages keep one client identity and expose interrupted delivery retry', () => {
  const thread = readFileSync(new URL('../ui/Thread.jsx', import.meta.url), 'utf8')
  const api = readFileSync(new URL('../api.js', import.meta.url), 'utf8')
  assert.match(thread, /const messageId = crypto\.randomUUID\(\)/)
  assert.match(thread, /sendMessage\(messageId, peer/)
  assert.match(thread, /Delivery interrupted · Retry/)
  assert.match(thread, /retryMessage\(peer, messageId\)/)
  assert.match(api, /id,\s*\n\s*to,/)
  assert.match(api, /messages\/\$\{encodeURIComponent\(id\)\}\/retry/)
})

test('public board startup is not gated by identity and avoids oversized empty-state artwork', () => {
  const app = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(app, /if \(meState === 'loading'\) \{\s*return/)
  assert.match(app, /storage\?\.get\('cache\/board\.json'\)/)
  assert.match(app, /api\.getBootstrap\(\)/)
  const bootstrap = app.slice(app.indexOf('async function loadBootstrap()'), app.indexOf('const loadEarlierFeed'))
  assert.match(bootstrap, /loadMe\(\{ background: true \}\)/)
  assert.doesNotMatch(bootstrap, /if \(!result\.me\?\.connected\)/)
  assert.match(app, /reconcileFeedPage\(posts, current, api\.BOARD_PAGE_SIZE\)/)
  assert.match(app, /loadEarlierFeed/)
  assert.doesNotMatch(board, /cn-board-composer/)
  assert.match(app, /cn-compose-fab/)
  assert.match(board, /Load earlier posts/)
  assert.doesNotMatch(board, /landingImage/)
})

test('board warms real threads without fetching known empty threads', () => {
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
  assert.match(board, /REPLY_PREFETCH_LIMIT = 8/)
  assert.match(board, /REPLY_CACHE_LIMIT = 64/)
  assert.match(board, /Number\(post\.reply_count \|\| 0\) === 0/)
  assert.match(board, /className="cn-post-delete"/)
  assert.match(app, /host=\{me\?\.host\} size="small" remote/)
})

test('people and accepted messages use real avatars without flooding a large directory', () => {
  const people = readFileSync(new URL('../ui/People.jsx', import.meta.url), 'utf8')
  const messages = readFileSync(new URL('../ui/Messages.jsx', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
  assert.match(people, /<Avatar name=\{user\.handle\} host=\{user\.host\} remote lazy \/>/)
  assert.match(messages, /remote=\{!showingRequests\}/)
  assert.match(messages, /host=\{showingRequests \? undefined : item\.peer\}/)
  assert.match(messages, /className="cn-request-banner"/)
  assert.match(people, /cache\/people\.json/)
  assert.match(people, /DIRECTORY_CACHE_MAX_AGE_MS = 60_000/)
  assert.match(app, /api\.searchPeople\(''\)/)
})

test('publishing swaps one optimistic row into the confirmed feed without a second fetch', () => {
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
  const publish = board.slice(board.indexOf('async function publish()'), board.indexOf('async function submitPost()'))
  assert.ok(publish.indexOf('setPending({') < publish.indexOf('await collectImagePayloads(images, text)'))
  assert.match(publish, /const receipt = await publishPost/)
  assert.match(publish, /onPostConfirmed\?\.\(\{/)
  assert.doesNotMatch(publish, /await onRefresh\(true\)/)
  assert.match(board, /<Avatar name=\{pending\.handle\} host=\{pending\.host\} remote \/>/)
  assert.match(app, /const acceptPublishedPost = useCallback/)
  assert.match(app, /onPostConfirmed=\{acceptPublishedPost\}/)
})

test('confirmed deletion never restores focus to the disappearing trigger', () => {
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const focus = readFileSync(new URL('../ui/modalFocus.js', import.meta.url), 'utf8')
  assert.match(board, /restoreDeleteFocus\.current = false/)
  assert.match(board, /\(\) => restoreDeleteFocus\.current/)
  assert.match(focus, /if \(restore && opener/)
})

test('main navigation stays in the bottom-tab position at every width', () => {
  const theme = readFileSync(new URL('../theme.js', import.meta.url), 'utf8')
  const wide = theme.slice(theme.indexOf('@media (min-width: 720px)'), theme.indexOf('@media (max-width: 480px)'))
  assert.match(theme, /\.cn-nav \{\s*order: 2;/)
  assert.match(theme, /width: min\(100%, 712px\); margin-inline: auto;/)
  assert.doesNotMatch(wide, /\.cn-nav\s*\{/)
  assert.doesNotMatch(wide, /\.cn-compose-fab\s*\{/)
})
test('handle search accepts the displayed @handle form and surrounding spaces', async () => {
  const original = globalThis.fetch
  let url
  globalThis.fetch = async path => {
    url = path
    return { ok: true, json: async () => ({ users: [] }) }
  }
  try {
    await searchPeople(' @example ')
    assert.equal(new URL(url, 'https://local.example').searchParams.get('q'), 'example')
  } finally { globalThis.fetch = original }
})
