import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Chat, Globe, Users } from '@openai/apps-sdk-ui/components/Icon'
import { CSS } from './theme.js'
import * as api from './api.js'
import Board, { Avatar } from './ui/Board.jsx'
import { primeAvatar } from './avatarCache.js'
import { noteBoardAvatarDigests } from './avatarHints.js'
import Messages from './ui/Messages.jsx'
import Thread from './ui/Thread.jsx'
import GroupThread from './ui/GroupThread.jsx'
import People from './ui/People.jsx'
import { Lightbox } from './ui/Media.jsx'
import { joinGlobalCommunity, checkGlobalRegistration } from './community.js'
import {
  accountHandoff, clearParticipationIntent, loadParticipationIntent,
  participationIntentMatches, participationStep,
  saveParticipationIntent,
} from './participation.js'
import { reconcileFeedPage } from './reconciliation.js'
import { discoveryExtendsFeed, locateBoardPost, mergeDiscoveredPosts, parseBoardIntent } from './boardNavigation.js'

function ParticipationNotice({ me, state, busy, onJoin, onCheck }) {
  if (state === 'loading') {
    return null
  }

  if (state === 'error') {
    return (
      <section className="cn-welcome is-quiet" aria-label="Account status unavailable">
        <div className="cn-welcome-copy">
          <h2>Keep browsing</h2>
          <p>Your account details couldn’t be checked. The public board is still available.</p>
        </div>
        <button className="cn-btn cn-btn-secondary" onClick={onCheck}>Check again</button>
      </section>
    )
  }

  if (!me?.joined) return null

  if (me?.joined && me?.handle) {
    if (!me.registration) return null
    if (me.registration === 'registered') return null
    const missing = me.registration === 'missing'
    return (
      <section className="cn-welcome" aria-labelledby="cn-registration-title">
        <div className="cn-welcome-copy">
          <h2 id="cn-registration-title">{missing ? 'Finish joining Social' : 'Directory unavailable'}</h2>
          <p>{missing
            ? 'Your profile is not listed yet. Try joining again so people can find you. Your saved conversations are unchanged.'
            : 'We couldn’t check whether your profile is listed. Your saved conversations are still available.'}</p>
        </div>
        <button className="cn-btn cn-btn-primary" onClick={missing ? onJoin : onCheck} disabled={busy}>
          {busy ? (missing ? 'Joining…' : 'Checking…') : missing ? 'Try joining again' : 'Check again'}
        </button>
      </section>
    )
  }

  return null
}

function JoinAccess({ area, me, loading, busy, error, onJoin }) {
  return (
    <div className="cn-content cn-screen">
      <div className="cn-empty cn-join-access">
        <div className="cn-empty-mark" aria-hidden="true">{area === 'Chats' ? <Chat /> : <Users />}</div>
        <h2 className="cn-empty-title">Join Social to see {area}</h2>
        <p className="cn-empty-text">Community is open to read. Join to see {area.toLowerCase()} and take part.</p>
        <button className="cn-btn cn-btn-primary" type="button" onClick={onJoin}
                disabled={loading || busy}>
          {loading ? 'Checking account…' : busy ? 'Joining…' : 'Join Social'}
        </button>
        {error && <p className="cn-inline-error" role="alert">{error}</p>}
        {!loading && me?.handle && <p className="cn-join-privacy">Joining shares @{me.handle} and your profile photo, not your name or email.</p>}
      </div>
    </div>
  )
}

function MainNavigation({ className = '', tab, unread, boardActivity, onSelect }) {
  return (
    <nav className={`cn-nav ${className}`.trim()} aria-label="Main navigation">
      <button className={`cn-nav-item${tab === 'board' ? ' is-active' : ''}`} aria-label="Community" title="Community" aria-current={tab === 'board' ? 'page' : undefined} onClick={() => onSelect('board')}>
        {boardActivity && <span className="cn-nav-dot" aria-label="New board activity" />}
        <Globe aria-hidden="true" /><span className="cn-tab-label">Community</span>
      </button>
      <button className={`cn-nav-item${tab === 'messages' ? ' is-active' : ''}`} aria-label={unread ? `Chats, ${unread} unread` : 'Chats'} title="Chats" aria-current={tab === 'messages' ? 'page' : undefined} onClick={() => onSelect('messages')}>
        {unread > 0 && <span className="cn-badge">{unread}</span>}
        <Chat aria-hidden="true" /><span className="cn-tab-label">Chats</span>
      </button>
      <button className={`cn-nav-item${tab === 'people' ? ' is-active' : ''}`} aria-label="People" title="People" aria-current={tab === 'people' ? 'page' : undefined} onClick={() => onSelect('people')}>
        <Users aria-hidden="true" /><span className="cn-tab-label">People</span>
      </button>
    </nav>
  )
}

export default function App({ appId, token }) {
  api.setToken(token)

  const [me, setMe] = useState(null)
  const [meState, setMeState] = useState('loading')
  const [tab, setTab] = useState('board')
  const [feed, setFeed] = useState([])
  const feedRef = useRef(feed)
  feedRef.current = feed
  const [feedState, setFeedState] = useState('loading')
  const [feedHasEarlier, setFeedHasEarlier] = useState(false)
  const [feedNextCursor, setFeedNextCursor] = useState(null)
  // Keep the cursor tri-state: undefined means a legacy response with no
  // stable boundary, while null explicitly means the first page is complete.
  const feedNextCursorRef = useRef(undefined)
  const [feedCapabilities, setFeedCapabilities] = useState({})
  const [boardTarget, setBoardTarget] = useState(null)
  const targetRequest = useRef(null)
  const boardScrollRef = useRef(null)
  const [composerMount, setComposerMount] = useState(null)
  // These lists share the board's scroller, not its reading position. Board
  // owns its latest-post/notification positioning when it mounts again.
  useLayoutEffect(() => {
    if (tab !== 'board' && boardScrollRef.current) boardScrollRef.current.scrollTop = 0
  }, [tab])
  const finishBoardTarget = useCallback(() => {
    targetRequest.current?.abort()
    targetRequest.current = null
    setBoardTarget(null)
  }, [])

  function selectTab(next) {
    if (next !== 'board') finishBoardTarget()
    setTab(next)
  }
  const [conversations, setConversations] = useState([])
  const [groups, setGroups] = useState([])
  const [messagesState, setMessagesState] = useState('loading')
  const conversationLoad = useRef(0)
  const [thread, setThread] = useState(null) // { kind: 'dm'|'group', peer?, name?, group? }
  const [version, setVersion] = useState(0)
  const [boardActivity, setBoardActivity] = useState(false)
  const seenActivity = useRef(null)
  const [toast, setToast] = useState(null)
  const [lightbox, setLightbox] = useState(null)
  const [profileRequest, setProfileRequest] = useState(null)
  const [composing, setComposing] = useState(false)
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [participationIntent, setParticipationIntent] = useState(null)
  const [intentState, setIntentState] = useState('loading')
  const [appIconUrl, setAppIconUrl] = useState(null)
  const navHandle = useRef(null)
  // The shell hides background panes without changing document visibility.
  const [foreground, setForeground] = useState(true)
  const onShellMessage = useRef(null)
  const toastTimer = useRef(null)
  const readySignalled = useRef(false)
  const freshFeedLoaded = useRef(false)
  // Serialized posts + cursor last persisted to cache/board.json. Background
  // reloads usually return the same page; skipping identical writes avoids a
  // storage PUT and a change event for every refresh.
  const boardCacheSnapshot = useRef(null)
  const meRef = useRef(null)
  meRef.current = me
  const handoffPending = useRef(false)
  const hasPrivateAccess = Boolean(me?.joined && me?.registration !== 'missing')

  function showToast(text, kind) {
    setToast({ text, kind })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2600)
  }

  async function loadMe({ background = false, verified = null } = {}) {
    try {
      const profile = await api.getMe({ includeAvatar: !background, background })
      // Identity is useful context, not a prerequisite for the public board.
      // Reveal it after the local profile read while directory verification
      // continues in the background.
      if ('avatar' in profile) primeAvatar(profile.host, profile.avatar)
      if (
        profile.joined && verified?.registration === 'registered'
        && verified.host === profile.host
      ) {
        // Bootstrap just verified this identity in the directory.
        const checked = { ...profile, registration: 'registered' }
        setMe(checked)
        setMeState('ready')
        return checked
      }
      setMe(profile)
      setMeState('ready')
      const registration = await checkGlobalRegistration(
        profile, (query) => api.searchPeople(query, undefined, { background }),
      )
      const checked = { ...profile, registration }
      setMe(checked)
      setMeState('ready')
      return checked
    } catch (error) {
      window.mobius?.signal?.('error', { message: error.message, source: 'me' })
      if (!background) setMeState('error')
      return null
    }
  }

  async function loadSavedParticipationIntent() {
    setIntentState('loading')
    try {
      const intent = await loadParticipationIntent(window.mobius?.storage)
      setParticipationIntent(intent)
      setIntentState('ready')
    } catch {
      setIntentState('error')
    }
  }

  const acceptFeed = useCallback((
    posts, background = false, capabilities = null, nextCursor = undefined,
  ) => {
    freshFeedLoaded.current = true
    setFeed((current) => {
      if (!background) return posts
      return reconcileFeedPage(posts, current, api.BOARD_PAGE_SIZE)
    })
    if (!background || posts.length < api.BOARD_PAGE_SIZE) {
      const stableCursor = nextCursor !== undefined
      setFeedHasEarlier(stableCursor ? Boolean(nextCursor) : posts.length === api.BOARD_PAGE_SIZE)
      setFeedNextCursor(stableCursor ? nextCursor : null)
      feedNextCursorRef.current = nextCursor
    }
    setFeedState('ready')
    if (capabilities) setFeedCapabilities(capabilities)
    const cachedPosts = posts.slice(0, api.BOARD_PAGE_SIZE)
    const cachedCursor = nextCursor === undefined ? feedNextCursorRef.current : nextCursor
    const snapshot = JSON.stringify([cachedPosts, cachedCursor ?? null])
    if (snapshot !== boardCacheSnapshot.current) {
      boardCacheSnapshot.current = snapshot
      window.mobius?.storage?.set('cache/board.json', {
        posts: cachedPosts,
        next_cursor: cachedCursor,
        cached_at: Date.now(),
      }).catch(() => { boardCacheSnapshot.current = null })
    }
    if (!readySignalled.current) {
      readySignalled.current = true
      window.mobius?.signal?.('app_ready', { item_count: posts.length })
    }
  }, [])

  const loadFeed = useCallback(async (background = false) => {
    try {
      const result = await api.getFeed(null, { background })
      const posts = result.posts || []
      acceptFeed(posts, background, result.capabilities, result.next_cursor)
      return true
    } catch {
      if (!background) setFeedState('error')
      return false
    }
  }, [acceptFeed])

  async function loadBootstrap() {
    try {
      const result = await api.getBootstrap()
      primeAvatar(result.me?.host, result.me?.avatar)
      acceptFeed(
        result.feed?.posts || [], false, result.feed?.capabilities,
        result.feed?.next_cursor,
      )
      setMe(result.me || null)
      setMeState('ready')
      // Bootstrap paints saved identity immediately; the account owner still
      // reconciles every launch so a connected profile cannot remain stale.
      loadMe({ background: true, verified: result.me })
      return true
    } catch {
      // A partially updated installation still gets the established separate
      // paths rather than losing both public browsing and identity context.
      loadFeed()
      loadMe()
      return false
    }
  }

  const loadEarlierFeed = useCallback(async (before) => {
    const result = await api.getFeed(feedNextCursor ?? before)
    const older = result.posts || []
    setFeed((current) => {
      const seen = new Set(current.map((post) => post.id))
      return [...current, ...older.filter((post) => !seen.has(post.id))]
    })
    const stableCursor = result.next_cursor !== undefined
    setFeedHasEarlier(stableCursor ? Boolean(result.next_cursor) : older.length === api.BOARD_PAGE_SIZE)
    setFeedNextCursor(stableCursor ? result.next_cursor : null)
    feedNextCursorRef.current = result.next_cursor
    return older.length
  }, [feedNextCursor])

  async function revealBoardTarget(target) {
    targetRequest.current?.abort()
    const controller = new AbortController()
    targetRequest.current = controller
    const request = { ...target, requestId: crypto.randomUUID(), status: 'loading' }
    setBoardTarget(request)
    try {
      const result = await locateBoardPost(target.postId, api.getFeed, api.BOARD_PAGE_SIZE, { signal: controller.signal })
      if (targetRequest.current !== controller) return
      if (!result.post) {
        setBoardTarget(null)
        showToast('That post is no longer available. The community is still here.', 'error')
        return
      }
      setFeed(current => mergeDiscoveredPosts(current, result.posts))
      if (discoveryExtendsFeed(feedRef.current, result.posts)) {
        setFeedHasEarlier(result.hasEarlier)
        setFeedNextCursor(result.nextCursor ?? null)
        feedNextCursorRef.current = result.nextCursor
      }
      if (result.capabilities) setFeedCapabilities(result.capabilities)
      setFeedState('ready')
      setBoardTarget({ ...request, status: 'ready' })
    } catch (error) {
      if (controller.signal.aborted) return
      setBoardTarget(null)
      showToast('That post couldn’t be opened. Tap the notification again to retry.', 'error')
    }
  }

  useEffect(() => () => targetRequest.current?.abort(), [])

  const acceptPublishedPost = useCallback((post) => {
    setFeed((current) => [post, ...current.filter((item) => item.id !== post.id)])
    setFeedState('ready')
  }, [])

  async function loadConversations() {
    const request = ++conversationLoad.current
    try {
      const [loaded, loadedGroups] = await Promise.all([
        api.listConversations(), api.listGroups(),
      ])
      if (request !== conversationLoad.current) return
      setConversations(loaded)
      setGroups(loadedGroups)
      setMessagesState('ready')
    } catch {
      if (request === conversationLoad.current) setMessagesState('error')
    }
  }

  useEffect(() => {
    // Public browsing does not depend on profile or directory verification.
    // Start the visible board first so two slower identity checks cannot hold
    // the primary surface behind them on every launch.
    window.mobius?.storage?.get('cache/board.json')
      .then((cached) => {
        if (!Array.isArray(cached?.posts)) return
        if (boardCacheSnapshot.current === null) {
          const savedCursor = cached.next_cursor === undefined ? null : cached.next_cursor
          boardCacheSnapshot.current = JSON.stringify([cached.posts, savedCursor])
        }
        if (freshFeedLoaded.current) return
        noteBoardAvatarDigests(cached.posts)
        setFeed(cached.posts)
        const cachedCursor = cached.next_cursor === null || typeof cached.next_cursor === 'string'
          ? cached.next_cursor : undefined
        feedNextCursorRef.current = cachedCursor
        setFeedNextCursor(cachedCursor ?? null)
        setFeedHasEarlier(
          cachedCursor !== undefined
            ? Boolean(cachedCursor)
            : cached.posts.length === api.BOARD_PAGE_SIZE,
        )
        setFeedState('ready')
      })
      .catch(() => null)
    loadBootstrap()
    loadSavedParticipationIntent()
    const loadDeferred = () => {
      api.getAppIcon(appId)
        .then((blob) => setAppIconUrl(URL.createObjectURL(blob)))
        .catch(() => {})
      if (meRef.current?.joined && meRef.current?.registration !== 'missing') {
        api.searchPeople('', undefined, { background: true })
          .then((found) => window.mobius?.storage?.set('cache/people.json', {
            users: found.users,
            cached_at: Date.now(),
          }))
          .catch(() => null)
      }
    }
    const idleId = window.requestIdleCallback
      ? window.requestIdleCallback(loadDeferred, { timeout: 1800 })
      : window.setTimeout(loadDeferred, 800)
    return () => {
      if (window.cancelIdleCallback) window.cancelIdleCallback(idleId)
      else window.clearTimeout(idleId)
    }
  }, [])

  // Identity linking happens in Möbius · You. When the owner returns, read the
  // authoritative profile again; never infer success from the app switch and
  // never turn a completed sign-in into an automatic directory join or post.
  // Only an unfinished account handoff can change on return; a joined owner's
  // profile reconciles once per launch instead of on every pane focus.
  useEffect(() => {
    let refreshing = false
    const refreshAfterHandoff = async () => {
      if (document.visibilityState === 'hidden' || refreshing) return
      const joined = meRef.current?.joined && meRef.current?.name
      if (joined && !handoffPending.current) return
      refreshing = true
      try {
        const profile = await loadMe({ background: true })
        // Returning before linking finished keeps the handoff pending.
        if (profile?.connected) handoffPending.current = false
        if (profile) await loadFeed(true)
      } finally {
        refreshing = false
      }
    }
    document.addEventListener('visibilitychange', refreshAfterHandoff)
    window.addEventListener('focus', refreshAfterHandoff)
    window.addEventListener('pageshow', refreshAfterHandoff)
    return () => {
      document.removeEventListener('visibilitychange', refreshAfterHandoff)
      window.removeEventListener('focus', refreshAfterHandoff)
      window.removeEventListener('pageshow', refreshAfterHandoff)
    }
  }, [loadFeed])

  // Incoming federation deliveries bump state/version.json on the server.
  // Poll it while visible (get() revalidates in the background and notifies
  // the subscriber below when the server value changed).
  useEffect(() => {
    const store = window.mobius?.storage
    if (!store) return
    let unsubscribe = null
    let cancelled = false
    store
      .subscribe('state/version.json', (value) => {
        if (cancelled || !value) return
        setVersion((prior) => (value.v !== prior ? value.v : prior))
      })
      .then?.((u) => { if (typeof u === 'function') unsubscribe = u })
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') {
        store.get('state/version.json').catch(() => null)
      }
    }, 5000)
    return () => {
      cancelled = true
      clearInterval(poll)
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (hasPrivateAccess) loadConversations()
    else {
      conversationLoad.current += 1
      setConversations([])
      setGroups([])
      setMessagesState('loading')
      navHandle.current?.close()
      navHandle.current = null
      setThread(null)
    }
  }, [hasPrivateAccess, version])

  // Surface new likes/replies on the owner's own posts as a dot on the Board
  // tab. The community host holds those posts, so the app can't be pushed about
  // them; instead it compares counts each time the feed reloads. Viewing the
  // board resets the baseline and clears the dot.
  useEffect(() => {
    if (!me?.host || feedState !== 'ready') return
    const mine = feed.filter((post) => post.host === me.host)
    const counts = new Map(
      mine.map((post) => [post.id, (post.like_count || 0) + (post.reply_count || 0)]),
    )
    const prior = seenActivity.current
    if (tab === 'board' || prior === null) {
      // Viewing the board (or the first load) sets the baseline and clears the dot.
      seenActivity.current = counts
      if (tab === 'board') setBoardActivity(false)
      return
    }
    // Off the board: flag a rise on a known post, and start tracking posts that
    // appeared since the baseline (recorded at their current count, not flagged)
    // so later activity on them is caught too. Known baselines are left intact
    // until the next board view, so a rise is measured against last-seen.
    const next = new Map(prior)
    let rose = false
    for (const [id, count] of counts) {
      if (!prior.has(id)) {
        next.set(id, count)
      } else if (count > prior.get(id)) {
        rose = true
      }
    }
    seenActivity.current = next
    if (rose) setBoardActivity(true)
  }, [feed, tab, me, feedState])

  // ── shell messages: pane visibility and notification taps ────────────────
  // Board activity names the exact post, and optionally the affected reply.
  onShellMessage.current = async ({ type, visible, intent }) => {
    if (type === 'moebius:frame-visibility') {
      setForeground(visible !== false)
      return
    }
    if (type !== 'moebius:app-intent' || typeof intent !== 'string') return
    const [kind, id] = intent.split(/:(.*)/)
    if (kind === 'board') {
      if (thread) closeThread()
      setTab('board')
      const target = parseBoardIntent(intent)
      if (target?.postId) revealBoardTarget(target)
      else {
        targetRequest.current?.abort()
        setBoardTarget(null)
        if (!target) showToast('This community notification couldn’t be opened.', 'error')
      }
    } else if (kind === 'dm') {
      selectTab('messages')
      if (!meRef.current?.joined || meRef.current?.registration === 'missing') return
      const convo = (await api.listConversations()).find((item) => item.peer === id)
      openThread(id, convo?.peer_handle, api.requestStatus(convo) === 'pending')
    } else if (kind === 'group') {
      selectTab('messages')
      if (!meRef.current?.joined || meRef.current?.registration === 'missing') return
      openGroup(await api.getGroup(id))
    }
  }
  useEffect(() => {
    const listener = (event) => {
      if (event.source !== window.parent || !event.data) return
      onShellMessage.current(event.data).catch(() => selectTab('messages'))
    }
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  }, [])

  // ── thread navigation with a real shell back target ───────────────────────
  function openAnyThread(next) {
    selectTab('messages')
    navHandle.current?.close()
    let handle = null
    handle = window.mobius?.nav?.open?.('common-thread', {
      onBack: () => { navHandle.current = null; setThread(null); loadConversations() },
      onForward: () => { selectTab('messages'); navHandle.current = handle; setThread(next) },
    })
    navHandle.current = handle || null
    setThread(next)
  }

  const openThread = (peer, name, request = false) => openAnyThread({ kind: 'dm', peer, name, request })
  const openGroup = (group) => openAnyThread({ kind: 'group', group })

  async function openCreatedGroup(gid) {
    const created = await api.getGroup(gid)
    // An older list response must not remove the group we just opened.
    conversationLoad.current += 1
    setGroups(prior => [created, ...prior.filter(group => group.gid !== gid)])
    openGroup(created)
  }

  function closeThread() {
    navHandle.current?.close()
    navHandle.current = null
    setThread(null)
    loadConversations()
  }

  function openLightbox(url, alt, cleanup) {
    setLightbox({ url, alt, cleanup })
  }

  // ── onboarding: join with the shared Möbius identity ──────────────────────
  const [saving, setSaving] = useState(false)
  const [joinError, setJoinError] = useState(null)

  function openIdentityApp() {
    handoffPending.current = true
    accountHandoff(me, (message, target) => window.parent.postMessage(message, target))
  }

  async function join() {
    setSaving(true)
    setJoinError(null)
    try {
      await joinGlobalCommunity(api.join)
      const profile = await loadMe()
      if (!profile) {
        setJoinError('Social couldn’t check your account. Try joining again.')
        return false
      }
      await loadFeed()
      if (profile.registration === 'registered') showToast('Welcome to global Social', 'success')
      else setJoinError('Social couldn’t confirm your membership yet. Try joining again.')
      return profile.registration === 'registered'
    } catch (error) {
      setJoinError(error.message)
      return false
    } finally {
      setSaving(false)
    }
  }

  function beginJoin() {
    if (meState === 'error' || !me) return loadMe()
    if (me.registration === 'missing' || participationStep(me) === 'join') return join()
    openIdentityApp()
  }

  async function requestParticipation(intent) {
    const saved = await saveParticipationIntent(window.mobius?.storage, intent)
    if (!saved) throw new Error('Social couldn’t save this draft. Try again before leaving.')
    setParticipationIntent(intent)
    if (participationStep(me) === 'join') {
      const joined = await join()
      if (!joined) throw new Error('Social couldn’t finish joining. Your draft is still saved.')
      return true
    }
    openIdentityApp()
    return true
  }

  async function completeParticipationIntent(completedIntent) {
    if (!participationIntentMatches(participationIntent, completedIntent)) return
    try {
      await clearParticipationIntent(window.mobius?.storage, participationIntent)
      setParticipationIntent(await loadParticipationIntent(window.mobius?.storage))
    } catch {
      // The explicit action already succeeded. A stale saved draft remains
      // harmless because Social never auto-submits restored intent.
    }
  }

  async function discardParticipationIntent() {
    try {
      await clearParticipationIntent(window.mobius?.storage, participationIntent)
      setParticipationIntent(await loadParticipationIntent(window.mobius?.storage))
    } catch {
      showToast('Social couldn’t discard this draft. Try again.', 'error')
    }
  }

  const activeConversations = conversations.filter(item => api.requestStatus(item) === 'accepted')
  const pendingConversations = conversations.filter(item => api.requestStatus(item) === 'pending')
  const activeGroups = groups.filter(group =>
    api.requestStatus(group) === 'accepted' && api.groupIsVisible(group, me?.host))
  const pendingGroups = groups.filter(group =>
    api.requestStatus(group) === 'pending' && !group.deleted_at)
  const unread =
    activeConversations.reduce((sum, c) => sum + (c.unread || 0), 0) +
    activeGroups.reduce((sum, g) => sum + (g.unread || 0), 0)
  const canParticipate = participationStep(me) === 'ready' && me?.registration !== 'missing'

  // ── render ────────────────────────────────────────────────────────────────
  if (thread && canParticipate) {
    return (
      <div className="cn-root"><style>{CSS}</style>
        {thread.kind === 'group' ? (
          <GroupThread
            key={thread.group.gid}
            group={groups.find((g) => g.gid === thread.group.gid) || thread.group}
            me={me}
            version={version}
            foreground={foreground}
            onBack={closeThread}
            showToast={showToast}
            onOpenImage={(url, alt) => setLightbox({ url, alt })}
          />
        ) : (
          <Thread
            key={thread.peer}
            peer={thread.peer}
            peerHandle={thread.name || conversations.find((c) => c.peer === thread.peer)?.peer_handle}
            me={me}
            version={version}
            foreground={foreground}
            request={thread.request}
            onBack={closeThread}
            showToast={showToast}
            onOpenImage={(url, alt) => setLightbox({ url, alt })}
          />
        )}
        {toast && <div className={`cn-toast${toast.kind ? ` is-${toast.kind}` : ''}`} role="status">{toast.text}</div>}
        <Lightbox image={lightbox} onClose={() => setLightbox(null)} />
      </div>
    )
  }

  return (
    <div className="cn-root">
      <style>{CSS}</style>
      <header className="cn-header">
        <div className="cn-brand">
          {appIconUrl
            ? <img className="cn-app-icon" src={appIconUrl} alt="" draggable="false" />
            : <span className="cn-mark" aria-hidden="true"><span className="cn-mark-orbit" /></span>}
          <h1 className="cn-title">Social</h1>
        </div>
        <MainNavigation className="cn-nav-wide" tab={tab} unread={unread}
                        boardActivity={boardActivity} onSelect={selectTab} />
        <MainNavigation className="cn-nav-mobile" tab={tab} unread={unread}
                        boardActivity={boardActivity} onSelect={selectTab} />
        {meState === 'loading' ? (
          <div className="cn-header-chip is-loading" aria-hidden="true">
            <span className="cn-header-chip-avatar-skeleton" />
            <span className="cn-header-chip-line-skeleton" />
          </div>
        ) : me?.handle ? (
          <div className="cn-header-chip">
            <Avatar name={me.handle} host={me?.host} size="small" remote />
            <span>{`@${me.handle}`}</span>
          </div>
        ) : null}
      </header>

      <div ref={boardScrollRef} className={`cn-scroll${tab === 'board' ? ' is-board' : ''}`}>
        {tab === 'board' && <div className="cn-content">
          <ParticipationNotice
            me={me}
            state={meState}
            busy={saving}
            onJoin={join}
            onCheck={() => loadMe()}
          />
          {joinError && <div className="cn-directory-error" role="alert">
            <p>{joinError}</p>
          </div>}
          {me?.account_error && !me?.connected && (
            <p className="cn-inline-error" role="status">{me.account_error}</p>
          )}
        </div>}
        {tab === 'board' && (
          <Board me={me} feed={feed} feedState={feedState} onRefresh={loadFeed}
                 hasEarlier={feedHasEarlier} onLoadEarlier={loadEarlierFeed}
                 composing={composing} setComposing={setComposing}
                 canInteract={canParticipate} accountState={meState}
                 participationIntent={participationIntent}
                 intentState={intentState}
                 participationBusy={saving}
                 onJoin={beginJoin} joinBusy={saving || meState === 'loading'}
                 emojiReactions={Boolean(feedCapabilities.emoji_reactions)}
                 replyReactions={Boolean(feedCapabilities.reply_reactions)}
                 authorEdits={Boolean(feedCapabilities.author_edits)}
                 replyAttachments={Boolean(feedCapabilities.reply_attachments)}
                 boardTarget={boardTarget} onTargetHandled={finishBoardTarget}
                 composerMount={composerMount} scrollRef={boardScrollRef}
                 onRetryIntent={loadSavedParticipationIntent}
                 onRequestParticipation={requestParticipation}
                 onCompleteParticipation={completeParticipationIntent}
                 onDiscardParticipation={discardParticipationIntent}
                 onPostConfirmed={acceptPublishedPost}
                 onOpenPerson={(host) => { setProfileRequest(host); selectTab('people') }} showToast={showToast}
                 onMessageUser={(host, name) => openThread(host, name)}
                 onOpenImage={openLightbox} />
        )}
        {tab === 'messages' && (
          canParticipate ? (
            <Messages canCreate={canParticipate} me={me} conversations={activeConversations} groups={activeGroups}
                      messageRequests={pendingConversations} groupRequests={pendingGroups}
                      loadState={messagesState} onRetry={loadConversations}
                      creating={creatingGroup} setCreating={setCreatingGroup}
                      onOpenThread={(peer) => openThread(peer)}
                      onOpenMessageRequest={(peer, name) => openThread(peer, name, true)}
                      onOpenGroup={openGroup}
                      onFindPeople={() => selectTab('people')}
                      onGroupsChanged={openCreatedGroup}
                      showToast={showToast} />
          ) : (
            <JoinAccess area="Chats" me={me} loading={meState === 'loading'}
                        busy={saving} error={joinError} onJoin={beginJoin} />
          )
        )}
        {tab === 'people' && (
          canParticipate ? <People me={me} canMessage={canParticipate}
                  onMessage={(host, name) => openThread(host, name)} showToast={showToast}
                  requestedProfile={profileRequest}
                  onProfileRequestHandled={() => setProfileRequest(null)} />
            : <JoinAccess area="People" me={me} loading={meState === 'loading'}
                          busy={saving} error={joinError} onJoin={beginJoin} />
        )}
      </div>

      {tab === 'board' && <div ref={setComposerMount} className="cn-board-composer-mount" />}

      {toast && <div className={`cn-toast${toast.kind ? ` is-${toast.kind}` : ''}`} role="status">{toast.text}</div>}
      <Lightbox image={lightbox} onClose={() => setLightbox(null)} />
    </div>
  )
}
