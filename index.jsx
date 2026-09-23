import { useCallback, useEffect, useRef, useState } from 'react'
import { Chat, Globe, Plus, Users } from '@openai/apps-sdk-ui/components/Icon'
import { CSS } from './theme.js'
import * as api from './api.js'
import Board, { Avatar } from './ui/Board.jsx'
import { primeAvatar } from './avatarCache.js'
import Messages from './ui/Messages.jsx'
import Thread from './ui/Thread.jsx'
import GroupThread from './ui/GroupThread.jsx'
import People from './ui/People.jsx'
import { Lightbox } from './ui/Media.jsx'
import {
  needsGlobalJoin, joinGlobalCommunity, checkGlobalRegistration,
} from './community.js'
import {
  accountHandoff, clearParticipationIntent, loadParticipationIntent,
  participationActionLabel, participationIntentMatches, participationStep,
  saveParticipationIntent,
} from './participation.js'
import { reconcileFeedPage } from './reconciliation.js'

function ParticipationNotice({ me, state, busy, onJoin, onAccount, onCheck }) {
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

  if (me?.joined && me?.name) {
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

  const connected = me?.connected
  const step = participationStep(me)
  return (
    <section className="cn-welcome" aria-labelledby="cn-welcome-title">
      <span className="cn-welcome-mark" aria-hidden="true"><Globe /></span>
      <div className="cn-welcome-copy">
        <h2 id="cn-welcome-title">
          {connected ? `Browse as @${me.handle}` : 'Browse without signing in'}
        </h2>
        <p>
          {connected
            ? 'The board and people directory are public. Join only when you want to post, reply, react or message.'
            : 'The board and people directory are open. Use Möbius · You only when you want to participate.'}
        </p>
        {connected && (
          <span className="cn-welcome-privacy">
            Joining shares your handle and profile picture. Your name and email stay private.
          </span>
        )}
      </div>
      <div className="cn-welcome-actions">
        {connected ? (
          <button className="cn-btn cn-btn-primary" onClick={onJoin} disabled={busy}>
            {busy ? 'Joining…' : `Join as @${me.handle}`}
          </button>
        ) : (
          <>
            <button className="cn-btn cn-btn-ghost" onClick={onAccount}>
              {participationActionLabel(step)}
            </button>
            <button className="cn-btn cn-btn-ghost" onClick={onCheck} disabled={busy}>
              Check again
            </button>
          </>
        )}
      </div>
    </section>
  )
}

export default function App({ appId, token }) {
  api.setToken(token)

  const [me, setMe] = useState(null)
  const [meState, setMeState] = useState('loading')
  const [tab, setTab] = useState('board')
  const [feed, setFeed] = useState([])
  const [feedState, setFeedState] = useState('loading')
  const [feedHasEarlier, setFeedHasEarlier] = useState(false)
  const [feedCapabilities, setFeedCapabilities] = useState({})
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
  const [threadExpanded, setThreadExpanded] = useState(false)
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [participationIntent, setParticipationIntent] = useState(null)
  const [intentState, setIntentState] = useState('loading')
  const [appIconUrl, setAppIconUrl] = useState(null)
  const navHandle = useRef(null)
  const toastTimer = useRef(null)
  const readySignalled = useRef(false)
  const freshFeedLoaded = useRef(false)

  function showToast(text, kind) {
    setToast({ text, kind })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2600)
  }

  async function loadMe({ background = false } = {}) {
    try {
      const loaded = await api.getMe()
      const profile = loaded
      // Identity is useful context, not a prerequisite for the public board.
      // Reveal it after the local profile read while directory verification
      // continues in the background.
      primeAvatar(profile.host, profile.avatar)
      setMe(profile)
      setMeState('ready')
      const registration = await checkGlobalRegistration(profile, api.searchPeople)
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

  const acceptFeed = useCallback((posts, background = false, capabilities = null) => {
    freshFeedLoaded.current = true
    setFeed((current) => {
      if (!background) return posts
      return reconcileFeedPage(posts, current, api.BOARD_PAGE_SIZE)
    })
    if (!background || posts.length < api.BOARD_PAGE_SIZE) {
      setFeedHasEarlier(posts.length === api.BOARD_PAGE_SIZE)
    }
    setFeedState('ready')
    if (capabilities) setFeedCapabilities(capabilities)
    window.mobius?.storage?.set('cache/board.json', {
      posts: posts.slice(0, api.BOARD_PAGE_SIZE),
      cached_at: Date.now(),
    }).catch(() => null)
    if (!readySignalled.current) {
      readySignalled.current = true
      window.mobius?.signal?.('app_ready', { item_count: posts.length })
    }
  }, [])

  const loadFeed = useCallback(async (background = false) => {
    try {
      const result = await api.getFeed()
      const posts = result.posts || []
      acceptFeed(posts, background, result.capabilities)
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
      acceptFeed(result.feed?.posts || [], false, result.feed?.capabilities)
      setMe(result.me || null)
      setMeState('ready')
      // Bootstrap paints saved identity immediately; the account owner still
      // reconciles every launch so a connected profile cannot remain stale.
      loadMe({ background: true })
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
    const result = await api.getFeed(before)
    const older = result.posts || []
    setFeed((current) => {
      const seen = new Set(current.map((post) => post.id))
      return [...current, ...older.filter((post) => !seen.has(post.id))]
    })
    setFeedHasEarlier(older.length === api.BOARD_PAGE_SIZE)
    return older.length
  }, [])

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
        if (freshFeedLoaded.current || !Array.isArray(cached?.posts)) return
        setFeed(cached.posts)
        setFeedHasEarlier(cached.posts.length === api.BOARD_PAGE_SIZE)
        setFeedState('ready')
      })
      .catch(() => null)
    loadBootstrap()
    loadConversations()
    loadSavedParticipationIntent()
    const loadDeferred = () => {
      api.getAppIcon(appId)
        .then((blob) => setAppIconUrl(URL.createObjectURL(blob)))
        .catch(() => {})
      api.searchPeople('')
        .then((found) => window.mobius?.storage?.set('cache/people.json', {
          users: found.users,
          cached_at: Date.now(),
        }))
        .catch(() => null)
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
  useEffect(() => {
    let refreshing = false
    const refreshAfterHandoff = async () => {
      if (document.visibilityState === 'hidden' || refreshing) return
      refreshing = true
      try {
        const profile = await loadMe({ background: true })
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
    if (version > 0) loadConversations()
  }, [version])

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

  // ── thread navigation with a real shell back target ───────────────────────
  function openAnyThread(next) {
    navHandle.current?.close()
    let handle = null
    handle = window.mobius?.nav?.open?.('common-thread', {
      onBack: () => { navHandle.current = null; setThread(null); loadConversations() },
      onForward: () => { navHandle.current = handle; setThread(next) },
    })
    navHandle.current = handle || null
    setTab('messages')
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
    accountHandoff(me, (message, target) => window.parent.postMessage(message, target))
  }

  async function join() {
    setSaving(true)
    setJoinError(null)
    try {
      await joinGlobalCommunity(me, api.saveMe, api.join)
      const profile = await loadMe()
      if (!profile) return false
      await loadFeed()
      if (profile.registration === 'registered') showToast('Welcome to global Social', 'success')
      return profile.registration === 'registered'
    } catch (error) {
      setJoinError(error.message)
      return false
    } finally {
      setSaving(false)
    }
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

  const activeConversations = conversations.filter(item => api.requestStatus(item) === 'accepted')
  const pendingConversations = conversations.filter(item => api.requestStatus(item) === 'pending')
  const activeGroups = groups.filter(group =>
    api.requestStatus(group) === 'accepted' && api.groupIsVisible(group, me?.host))
  const pendingGroups = groups.filter(group =>
    api.requestStatus(group) === 'pending' && !group.deleted_at)
  const unread =
    activeConversations.reduce((sum, c) => sum + (c.unread || 0), 0) +
    activeGroups.reduce((sum, g) => sum + (g.unread || 0), 0)
  const canParticipate = Boolean(me?.joined && me?.name)

  // ── render ────────────────────────────────────────────────────────────────
  if (thread) {
    return (
      <div className="cn-root"><style>{CSS}</style>
        {thread.kind === 'group' ? (
          <GroupThread
            key={thread.group.gid}
            group={groups.find((g) => g.gid === thread.group.gid) || thread.group}
            me={me}
            version={version}
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
          <h1 className="cn-title">{tab === 'board' ? 'Home' : tab === 'messages' ? 'Messages' : 'People'}</h1>
        </div>
        <div className="cn-header-chip">
          <Avatar name={me?.handle || '?'} host={me?.host} size="small" remote />
          <span>{me?.handle ? `@${me.handle}` : 'Browsing'}</span>
        </div>
      </header>

      <nav className="cn-nav" aria-label="Main navigation">
        <button className={`cn-nav-item${tab === 'board' ? ' is-active' : ''}`} aria-current={tab === 'board' ? 'page' : undefined} onClick={() => setTab('board')}>
          {boardActivity && <span className="cn-nav-dot" aria-label="New board activity" />}
          <Globe aria-hidden="true" /><span>Board</span>
        </button>
        <button className={`cn-nav-item${tab === 'messages' ? ' is-active' : ''}`} aria-current={tab === 'messages' ? 'page' : undefined} onClick={() => setTab('messages')}>
          {unread > 0 && <span className="cn-badge">{unread}</span>}
          <Chat aria-hidden="true" /><span>Messages</span>
        </button>
        <button className={`cn-nav-item${tab === 'people' ? ' is-active' : ''}`} aria-current={tab === 'people' ? 'page' : undefined} onClick={() => setTab('people')}>
          <Users aria-hidden="true" /><span>People</span>
        </button>
      </nav>

      <div className="cn-scroll">
        <div className="cn-content">
          <ParticipationNotice
            me={me}
            state={meState}
            busy={saving}
            onJoin={join}
            onAccount={openIdentityApp}
            onCheck={() => loadMe()}
          />
          {joinError && <div className="cn-directory-error" role="alert">
            <p>{joinError}</p>
          </div>}
          {me?.account_error && !me?.connected && (
            <p className="cn-inline-error" role="status">{me.account_error}</p>
          )}
        </div>
        {tab === 'board' && (
          <Board me={me} feed={feed} feedState={feedState} onRefresh={loadFeed}
                 hasEarlier={feedHasEarlier} onLoadEarlier={loadEarlierFeed}
                 composing={composing} setComposing={setComposing}
                 canInteract={canParticipate}
                 participationIntent={participationIntent}
                 intentState={intentState}
                 participationBusy={saving}
                 emojiReactions={Boolean(feedCapabilities.emoji_reactions)}
                 onThreadOpenChange={setThreadExpanded}
                 onRetryIntent={loadSavedParticipationIntent}
                 onRequestParticipation={requestParticipation}
                 onCompleteParticipation={completeParticipationIntent}
                 onPostConfirmed={acceptPublishedPost}
                 onOpenPerson={(host) => { setProfileRequest(host); setTab('people') }} showToast={showToast}
                 onMessageUser={(host, name) => openThread(host, name)}
                 onOpenImage={openLightbox} />
        )}
        {tab === 'messages' && (
          me?.joined && me?.name ? (
            <Messages canCreate={canParticipate} me={me} conversations={activeConversations} groups={activeGroups}
                      messageRequests={pendingConversations} groupRequests={pendingGroups}
                      loadState={messagesState} onRetry={loadConversations}
                      creating={creatingGroup} setCreating={setCreatingGroup}
                      onOpenThread={(peer) => openThread(peer)}
                      onOpenMessageRequest={(peer, name) => openThread(peer, name, true)}
                      onOpenGroup={openGroup}
                      onFindPeople={() => setTab('people')}
                      onGroupsChanged={openCreatedGroup}
                      showToast={showToast} />
          ) : (
            <div className="cn-content cn-screen">
              <div className="cn-empty">
                <div className="cn-empty-mark" aria-hidden="true"><Chat /></div>
                <div className="cn-empty-title">Join before you message</div>
                <p className="cn-empty-text">
                  You can browse people first. Join Social when you’re ready to start a private conversation.
                </p>
                <button className="cn-btn cn-btn-secondary" onClick={() => setTab('people')}>Browse people</button>
              </div>
            </div>
          )
        )}
        {tab === 'people' && (
          <People me={me} canMessage={canParticipate}
                  onMessage={(host, name) => openThread(host, name)} showToast={showToast}
                  requestedProfile={profileRequest}
                  onProfileRequestHandled={() => setProfileRequest(null)} />
        )}
      </div>

      {tab === 'board' && !composing && !threadExpanded && (
        <button className="cn-compose-fab" type="button" onClick={() => setComposing(true)}
                aria-label={canParticipate ? 'Create post' : 'Write a post to share after joining'}>
          <Plus aria-hidden="true" />
        </button>
      )}

      {toast && <div className={`cn-toast${toast.kind ? ` is-${toast.kind}` : ''}`} role="status">{toast.text}</div>}
      <Lightbox image={lightbox} onClose={() => setLightbox(null)} />
    </div>
  )
}
