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
  for (const file of ['Board.jsx', 'People.jsx', 'Messages.jsx', 'Media.jsx']) {
    const source = readFileSync(new URL(`../ui/${file}`, import.meta.url), 'utf8')
    assert.match(source, /useModalFocus/)
    assert.doesNotMatch(source, /autoFocus/)
  }
  const focus = readFileSync(new URL('../ui/modalFocus.js', import.meta.url), 'utf8')
  assert.match(focus, /event\.key === 'Escape'/)
  assert.match(focus, /opener\.isConnected !== false/)
})

test('conversation recovery is visible and new messages do not steal the reading position', () => {
  for (const file of ['Thread.jsx', 'GroupThread.jsx']) {
    const source = readFileSync(new URL(`../ui/${file}`, import.meta.url), 'utf8')
    assert.match(source, /useMessageTimeline\(\{/)
    assert.match(source, /<MessageTimeline timeline=\{timeline\}/)
    assert.match(source, /watchLatest: \(onPage\) => watchLatest(?:Group)?Messages\(/)
  }
  {
    const source = readFileSync(new URL('../ui/useMessageTimeline.jsx', import.meta.url), 'utf8')
    assert.match(source, /Messages couldn’t be refreshed/)
    assert.match(source, /onClick=\{\(\) => earlierFailed\.current \? loadEarlier\(\) : refresh\(\)\}>Try again/)
    assert.match(source, /stickToBottom/)
    assert.match(source, /scrollHeight - el\.scrollTop - el\.clientHeight < 72/)
    assert.match(source, /paginationGeneration\.current \+= 1/)
    assert.match(source, /reconcileOlderPage/)
    assert.match(source, /generation === paginationGeneration\.current/)
    assert.match(source, /Loading messages…/)
    // Sending your own message returns to the newest message, and the first
    // position is set before paint.
    assert.match(source, /stickToBottom\.current = true\n\s*setSending\(true\)/)
    assert.match(source, /useLayoutEffect\(\(\) => \{\n\s*const el = scrollRef\.current/)
  }
})

test('message text stays selectable and reply uses an explicit touch target', () => {
  const bubble = readFileSync(new URL('../ui/MessageBubble.jsx', import.meta.url), 'utf8')
  const theme = readFileSync(new URL('../theme.js', import.meta.url), 'utf8')
  assert.doesNotMatch(bubble, /useReplyLongPress|onContextMenu|onPointerDown/)
  assert.match(bubble, /className="cn-bubble-reply"/)
  assert.match(theme, /\.cn-bubble-copy[\s\S]*user-select: text/)
  assert.match(theme, /@media \(hover: none\)[\s\S]*\.cn-bubble-reply \{ opacity: 1; pointer-events: auto; \}/)
  assert.doesNotMatch(theme, /\.cn-bubble-reply \{ display: none; \}/)
  assert.match(theme, /\.cn-composer-send svg \{[^}]*width: 24px; height: 24px; \}/)
  assert.match(theme, /\.cn-composer-send svg path \{[\s\S]*stroke-width: \.24;/)
})

test('all message composers use touch-aware Enter behavior', () => {
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const input = readFileSync(new URL('../ui/MessageInput.jsx', import.meta.url), 'utf8')
  assert.match(input, /shouldSubmitMessageKey\(event, isTouchPrimary\(\)\)/)
  assert.match(input, /event\.currentTarget\.form\.requestSubmit\(\)/)
  assert.doesNotMatch(input, /pointer: coarse/)
  const composer = readFileSync(new URL('../ui/Composer.jsx', import.meta.url), 'utf8')
  assert.match(composer, /<MessageInput /)
  assert.equal((board.match(/<Composer className=/g) || []).length, 2)
  assert.match(board, /inputRef=\{replyInputRef\} value=\{replyDraft\}/)
})

test('Community replaces the unjoined composer with Join and preserves earlier-message position', () => {
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  assert.match(board, /<Composer className="cn-board-composer" onSubmit=\{submitPost\}/)
  assert.match(board, /className="cn-board-join"/)
  assert.match(board, /Join Social to message/)
  assert.match(board, /onOpen=\{togglePreview\}/)
  assert.match(board, /onClick=\{togglePreview\} disabled=\{!canInteract\}/)
  assert.match(board, /canInteract && me\?\.host && post\.host === me\.host/)
  assert.match(board, /\.cn-avatar'\)\) openReplies\(post\)/)
  assert.doesNotMatch(board, /Continue to send message/)
  assert.match(board, /const previousHeight = scroller\?\.scrollHeight/)
  assert.match(board, /prependedScrollTop\(previousTop, previousHeight, scroller\.scrollHeight\)/)
})

test('Community and replies use the same Möbius chat composer primitive', () => {
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const composer = readFileSync(new URL('../ui/Composer.jsx', import.meta.url), 'utf8')
  const theme = readFileSync(new URL('../theme.js', import.meta.url), 'utf8')
  assert.equal((board.match(/<Composer className=/g) || []).length, 2)
  assert.match(board, /<ComposerAttachmentButton/)
  assert.match(board, /SelectedImagesStrip selected=\{selectedImages\}/)
  assert.match(composer, /className="cn-composer-input-line"/)
  assert.match(theme, /\.cn-composer-pill \{[^}]*min-height: 48px;[^}]*border-radius: 24px;/s)
  assert.match(theme, /\.cn-composer-pill:focus-within \{[^}]*box-shadow: 0 0 0 3px var\(--accent-dim\);/)
  // A 44px target that still draws the 40px send circle inside the pill.
  assert.match(theme, /\.cn-composer-send \{[^}]*width: 44px; height: 44px; margin: -2px;/s)
  assert.match(theme, /\.cn-composer-send::before \{[^}]*inset: 2px;[^}]*background: var\(--accent\);/s)
  assert.match(theme, /\.cn-composer-attach \{[^}]*width: 48px; height: 48px;/s)
})

test('Community success actions stay quiet and image previews expose real zoom controls', () => {
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const media = readFileSync(new URL('../ui/Media.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(board, /Message sent|Post deleted/)
  assert.match(media, /className="cn-lightbox-controls"/)
  assert.match(media, /if \(event\.target === event\.currentTarget\) onClose\(\)/)
  assert.match(media, /aria-label="Zoom out"/)
  assert.match(media, /aria-label="Reset zoom"/)
  assert.match(media, /aria-label="Zoom in"/)
  assert.match(media, /onWheel=\{zoomWithWheel\}/)
  assert.match(media, /onPointerMove=\{moveImage\}/)
  assert.match(media, /setPointerCapture\?\.\(event\.pointerId\)/)
  assert.match(media, /onPointerUp=\{endImageMove\}/)
  assert.match(media, /onPointerCancel=\{endImageMove\}/)
  assert.match(media, /event\.key === '\+' \|\| event\.key === '='/)
  assert.match(media, /event\.key === '0'/)
})

test('message tabs keep one position and startup identity never flashes a label', () => {
  const messages = readFileSync(new URL('../ui/Messages.jsx', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
  assert.ok(messages.indexOf('className="cn-message-tabs"') < messages.indexOf('className="cn-view-actions"'))
  assert.match(messages, /<h2>Chats<\/h2><p>Your accepted conversations and requests\.<\/p>/)
  assert.doesNotMatch(messages, /showingRequests \? 'Message requests'/)
  assert.doesNotMatch(app, /Browsing/)
  assert.match(app, /meState === 'loading'[\s\S]*cn-header-chip is-loading/)
})

test('direct and group messages keep one client identity and expose interrupted delivery retry', () => {
  const thread = readFileSync(new URL('../ui/Thread.jsx', import.meta.url), 'utf8')
  const group = readFileSync(new URL('../ui/GroupThread.jsx', import.meta.url), 'utf8')
  const timeline = readFileSync(new URL('../ui/useMessageTimeline.jsx', import.meta.url), 'utf8')
  const api = readFileSync(new URL('../api.js', import.meta.url), 'utf8')
  assert.match(timeline, /const messageId = crypto\.randomUUID\(\)/)
  assert.match(timeline, /deliver\(\{ id: messageId,/)
  assert.match(timeline, /settleMessage\(prior, messageId, result\)/)
  assert.match(timeline, /Delivery interrupted · Retry/)
  assert.match(thread, /sendMessage\(id, peer/)
  assert.match(thread, /retryMessage\(peer, id\)/)
  assert.match(group, /sendGroupMessage\(id, gid/)
  assert.match(group, /retryGroupMessage\(gid, id\)/)
  assert.match(api, /retryGroupMessage = \(gid, id\) =>\n\s*call\(`groups\/\$\{encodeURIComponent\(gid\)\}\/messages\/\$\{encodeURIComponent\(id\)\}\/retry`/)
  assert.doesNotMatch(group, /local-|settleOptimistic|_client_pending/)
  assert.match(api, /id,\s*\n\s*to,/)
  assert.match(api, /sendGroupMessage = \(id, gid,[^]*?body: JSON\.stringify\(\{\n\s*id,/)
  assert.match(api, /messages\/\$\{encodeURIComponent\(id\)\}\/retry/)
})

test('public board startup is not gated by identity and behaves like a chronological community chat', () => {
  const app = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(app, /if \(meState === 'loading'\) \{\s*return/)
  assert.match(app, /canInteract=\{canParticipate\} accountState=\{meState\}/)
  assert.match(board, /canInteract \|\| accountState === 'loading' \? <>/)
  assert.match(board, /sendDisabled=\{!canInteract \|\|/)
  assert.match(board, /if \(canInteract\) await publish\(\)/)
  assert.match(app, /storage\?\.get\('cache\/board\.json'\)/)
  assert.match(app, /api\.getBootstrap\(\)/)
  const bootstrap = app.slice(app.indexOf('async function loadBootstrap()'), app.indexOf('const loadEarlierFeed'))
  assert.match(bootstrap, /loadMe\(\{ background: true, verified: result\.me \}\)/)
  assert.doesNotMatch(bootstrap, /if \(!result\.me\?\.connected\)/)
  assert.match(app, /reconcileFeedPage\(posts, current, api\.BOARD_PAGE_SIZE\)/)
  assert.match(app, /loadEarlierFeed/)
  assert.match(app, /feedNextCursor \?\? before/)
  assert.match(app, /next_cursor !== undefined/)
  assert.match(app, /const cachedCursor = nextCursor === undefined \? feedNextCursorRef\.current : nextCursor/)
  assert.match(app, /next_cursor: cachedCursor,/)
  assert.match(app, /if \(snapshot !== boardCacheSnapshot\.current\)/, 'identical board pages are not rewritten to the cache')
  assert.match(app, /const cachedCursor = cached\.next_cursor === null \|\| typeof cached\.next_cursor === 'string'/)
  assert.match(app, /feedNextCursorRef\.current = cachedCursor/)
  assert.doesNotMatch(app, /feedNextCursorRef\.current = cachedCursor \?\? null/)
  assert.match(board, /const chronologicalFeed = feed[\s\S]*\.reverse\(\)/)
  assert.match(board, /chronologicalFeed\.map/)
  assert.match(board, /className="cn-board-composer"/)
  assert.match(board, /placeholder="Message everyone…"/)
  assert.match(board, /sendLabel=\{accountState === 'loading' \? 'Checking your account…' : 'Send message'\}/)
  const composer = readFileSync(new URL('../ui/Composer.jsx', import.meta.url), 'utf8')
  assert.match(composer, /<Plus aria-hidden="true" \/>/)
  assert.doesNotMatch(board, /<ImageSquare/)
  assert.match(board, /const initialScrollDone = useRef\(false\)/)
  assert.match(board, /const firstReadyScroll = !initialScrollDone\.current/)
  assert.match(board, /scroller\.scrollTop = scroller\.scrollHeight/)
  assert.doesNotMatch(app, /cn-compose-fab/)
  assert.doesNotMatch(board, /aria-label="New post"/)
  assert.match(board, /Load earlier messages/)
  assert.doesNotMatch(board, /landingImage/)
  assert.match(board, /before === null \|\| before === undefined \|\| !hasEarlier \|\| earlierInFlight\.current/)
})

test('board warms real threads without fetching known empty threads', () => {
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
  assert.match(board, /REPLY_PREFETCH_LIMIT = 8/)
  assert.match(board, /REPLY_CACHE_LIMIT = 64/)
  assert.match(board, /Number\(post\.reply_count \|\| 0\) === 0/)
  assert.match(board, /<OwnActions kind="message"/)
  assert.match(app, /host=\{me\?\.host\} size="small" remote/)
})

test('people and accepted messages use real avatars without flooding a large directory', () => {
  const people = readFileSync(new URL('../ui/People.jsx', import.meta.url), 'utf8')
  const messages = readFileSync(new URL('../ui/Messages.jsx', import.meta.url), 'utf8')
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
  assert.match(people, /<Avatar name=\{user\.handle\} host=\{user\.host\} remote lazy \/>/)
  assert.match(messages, /remote=\{!showingRequests\}/)
  assert.match(messages, /host=\{showingRequests \? undefined : item\.peer\}/)
  assert.match(messages, /className="cn-request-banner"/)
  assert.match(people, /cache\/people\.json/)
  assert.match(people, /DIRECTORY_CACHE_MAX_AGE_MS = 60_000/)
  assert.match(app, /api\.searchPeople\('', undefined, \{ background: true \}\)/)
  assert.match(board, /subscribeAvatar\(record, update\)/)
  assert.doesNotMatch(board, /AVATAR_CONCURRENCY/)
  assert.match(app, /primeAvatar\(result\.me\?\.host, result\.me\?\.avatar\)/)
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

test('navigation uses one component inside both desktop and mobile toolbars', () => {
  const app = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
  const theme = readFileSync(new URL('../theme.js', import.meta.url), 'utf8')
  const wide = theme.slice(theme.indexOf('@media (min-width: 720px)'), theme.indexOf('@media (max-width: 480px)'))
  assert.match(app, /function MainNavigation\(/)
  assert.match(app, /className="cn-nav-wide"/)
  assert.match(app, /className="cn-nav-mobile"/)
  assert.match(app, /<span className="cn-tab-label">Community<\/span>/)
  assert.match(app, /<span className="cn-tab-label">Chats<\/span>/)
  assert.match(app, /<span className="cn-tab-label">People<\/span>/)
  assert.match(app, /<h1 className="cn-title">Social<\/h1>/)
  assert.match(theme, /\.cn-nav-wide \{ display: none; \}/)
  assert.match(wide, /\.cn-nav-mobile \{ display: none; \}/)
  assert.match(wide, /\.cn-nav-wide \{[\s\S]*display: flex;[\s\S]*margin: 0 0 0 auto;/)
  assert.match(wide, /\.cn-nav-wide \.cn-nav-item \{[\s\S]*min-height: 44px;/)
  const header = app.slice(app.indexOf('<header className="cn-header">'), app.indexOf('</header>'))
  assert.match(header, /className="cn-nav-mobile"/)
  assert.match(theme, /\.cn-composer-footer\s*\{[^}]*position: absolute;[^}]*bottom:/s)
})

test('opening and switching threads preserves the tapped post before paint, not the bottom of the feed', () => {
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const theme = readFileSync(new URL('../theme.js', import.meta.url), 'utf8')
  assert.match(board, /function openReplies\([^]*?keepPostPosition\(post\)/)
  assert.match(board, /useLayoutEffect\(\(\) => \{[^]*?scroller\.scrollTop \+= post\.getBoundingClientRect\(\)\.top - anchor\.top/)
  assert.match(board, /if \(boardTarget \|\| replyPost\) return undefined/)
  assert.match(board, /scroller\.style\.overflowAnchor = previousAnchor/)
  assert.doesNotMatch(board, /cn-inline-thread-head/)
  assert.doesNotMatch(theme, /cn-inline-thread-head/)
  assert.match(board, /aria-expanded=\{threadOpen\}/)
  assert.match(board, /aria-label="Replies"/)
})

test('Chats and People start at their heading instead of inheriting the board scroll offset', () => {
  const app = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
  assert.match(app, /useLayoutEffect\(\(\) => \{[^]*?if \(tab !== 'board' && boardScrollRef\.current\) boardScrollRef\.current\.scrollTop = 0[^]*?\}, \[tab\]\)/)
})

test('compact reaction visuals keep real 44 pixel controls', () => {
  const board = readFileSync(new URL('../ui/ReactionControls.jsx', import.meta.url), 'utf8')
  const theme = readFileSync(new URL('../theme.js', import.meta.url), 'utf8')
  assert.match(board, /className="cn-reaction-visual"/)
  assert.match(theme, /\.cn-reaction-chip \{[\s\S]*width: auto; min-width: 44px; height: 44px;/)
  assert.match(theme, /\.cn-reaction-visual \{[\s\S]*height: 30px;/)
  assert.match(theme, /\.cn-reaction-grid button \{[\s\S]*width: 44px; height: 44px;/)
})

test('high-cardinality phone reactions wrap without clipping accessible controls', () => {
  const board = readFileSync(new URL('../ui/ReactionControls.jsx', import.meta.url), 'utf8')
  const theme = readFileSync(new URL('../theme.js', import.meta.url), 'utf8')
  assert.match(theme, /\.cn-post-actions \{[^}]*flex-wrap: wrap;/)
  assert.match(theme, /\.cn-reactions \{[\s\S]*flex: 1 1 180px; flex-wrap: wrap;/)
  assert.doesNotMatch(theme, /\.cn-reactions \{ flex-basis: 100%; \}/)
  assert.match(board, /visible\.map\(emoji =>/)
  assert.doesNotMatch(board, /visible\.slice/)
  assert.match(board, /canInteract \? reactionActionLabel\(reactions\[emoji\], emoji\) : 'Join Social to react'/)
  assert.doesNotMatch(board, /className="cn-reaction-anchor"/)
  assert.match(board, /aria-label=\{!canInteract \? 'Join Social to react'/)
  assert.match(board, /className=\{`cn-reaction-picker/)
})

test('reaction picker width fits every 44 pixel choice without horizontal spill', () => {
  const board = readFileSync(new URL('../ui/ReactionControls.jsx', import.meta.url), 'utf8')
  const theme = readFileSync(new URL('../theme.js', import.meta.url), 'utf8')
  assert.match(theme, /\.cn-reaction-picker \{[\s\S]*width: max-content;/)
  // Below is still the default for a first post; the measured placement
  // switches upward only when the feed/composer would obscure choices.
  assert.match(theme, /\.cn-reaction-picker \{[^}]*position: absolute;[^}]*top: calc\(100% \+ 6px\);/)
  assert.doesNotMatch(theme, /\.cn-reaction-picker \{[^}]*bottom:/)
  assert.match(theme, /\.cn-reaction-picker\.is-above \{ top: auto; bottom: calc\(100% \+ 6px\); \}/)
  assert.match(theme, /\.cn-reaction-grid \{ display: grid; grid-template-columns: repeat\(6, 44px\); gap: 3px; \}/)
  assert.match(theme, /\.cn-reaction-grid \{ grid-template-columns: repeat\(5, 44px\); \}/)
  assert.match(theme, /\.cn-reaction-grid \{ grid-template-columns: repeat\(4, 44px\); \}/)
  assert.match(board, /if \(event\.key === 'Escape'\)/)
  assert.match(board, /aria-pressed=\{reactions\[emoji\]\.reacted\}/)
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
