import { useCallback, useEffect, useRef, useState } from 'react'
import { Chat, Globe, Plus, Users } from '@openai/apps-sdk-ui/components/Icon'
import { CSS } from './theme.js'
import * as api from './api.js'
import Board, { Avatar } from './ui/Board.jsx'
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

function ParticipationNotice({ me, busy, onJoin, onAccount, onCheck }) {
  if (me?.joined && me?.name) {
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
  const [conversations, setConversations] = useState([])
  const [groups, setGroups] = useState([])
  const [messagesState, setMessagesState] = useState('loading')
  const conversationLoad = useRef(0)
  const [thread, setThread] = useState(null) // { kind: 'dm'|'group', peer?, name?, group? }
  const [version, setVersion] = useState(0)
  const [toast, setToast] = useState(null)
  const [lightbox, setLightbox] = useState(null)
  const [profileRequest, setProfileRequest] = useState(null)
  const [composing, setComposing] = useState(false)
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [participationIntent, setParticipationIntent] = useState(null)
  const [intentState, setIntentState] = useState('loading')
  const [appIconUrl, setAppIconUrl] = useState(null)
  const navHandle = useRef(null)
  const toastTimer = useRef(null)
  const readySignalled = useRef(false)

  function showToast(text, kind) {
    setToast({ text, kind })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2600)
  }

  async function loadMe({ background = false } = {}) {
    try {
      const loaded = await api.getMe()
      const profile = loaded
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

  const loadFeed = useCallback(async (background = false) => {
    try {
      const result = await api.getFeed()
      setFeed(result.posts || [])
      setFeedState('ready')
      return true
    } catch {
      if (!background) setFeedState('error')
      return false
    }
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
      if (!readySignalled.current) {
        readySignalled.current = true
        window.mobius?.signal?.('app_ready', {
          item_count: loaded.length + loadedGroups.length,
        })
      }
    } catch {
      if (request === conversationLoad.current) setMessagesState('error')
    }
  }

  useEffect(() => {
    loadMe().then((profile) => {
      if (profile) loadFeed()
    })
    loadConversations()
    loadSavedParticipationIntent()
    api.getAppIcon(appId)
      .then((blob) => setAppIconUrl(URL.createObjectURL(blob)))
      .catch(() => {})
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

  async function completeParticipationIntent(kind, postId, completedIntent) {
    if (!participationIntent || participationIntent.kind !== kind) return
    if (postId && participationIntent.post_id !== postId) return
    if (completedIntent && !participationIntentMatches(participationIntent, completedIntent)) return
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
  if (meState === 'loading') {
    return (
      <div className="cn-root"><style>{CSS}</style>
        <div className="cn-center" style={{ flex: 1 }} role="status" aria-label="Loading Social">
          <div className="cn-spinner" aria-hidden="true" />
        </div>
      </div>
    )
  }

  if (meState === 'error') {
    return (
      <div className="cn-root"><style>{CSS}</style>
        <div className="cn-empty" style={{ margin: 'auto' }}>
          <div className="cn-empty-title">Social couldn’t connect</div>
          <p className="cn-empty-text">
            Your profile couldn’t be loaded. Check your connection and try again.
          </p>
          <button className="cn-btn cn-btn-secondary" onClick={loadMe}>Try again</button>
        </div>
      </div>
    )
  }

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
          <h1 className="cn-title">Social</h1>
        </div>
        <div className="cn-header-chip">
          <Avatar name={me?.handle || '?'} host={me?.host} size="small" />
          <span>{me?.handle ? `@${me.handle}` : 'Browsing'}</span>
        </div>
      </header>

      <nav className="cn-nav" aria-label="Main navigation">
        <button className={`cn-nav-item${tab === 'board' ? ' is-active' : ''}`} aria-current={tab === 'board' ? 'page' : undefined} onClick={() => setTab('board')}>
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
                 composing={composing} setComposing={setComposing}
                 canInteract={canParticipate}
                 participationIntent={participationIntent}
                 intentState={intentState}
                 participationBusy={saving}
                 onRetryIntent={loadSavedParticipationIntent}
                 onRequestParticipation={requestParticipation}
                 onCompleteParticipation={completeParticipationIntent}
                 onOpenPerson={(host) => { setProfileRequest(host); setTab('people') }} showToast={showToast}
                 onOpenImage={(url, alt) => setLightbox({ url, alt })} />
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
          <People me={me} onMessage={(host, name) => openThread(host, name)} showToast={showToast}
                  canMessage={canParticipate}
                  requestedProfile={profileRequest}
                  onProfileRequestHandled={() => setProfileRequest(null)} />
        )}
      </div>

      {tab === 'board' && (
        <button className="cn-fab" onClick={() => setComposing(true)} aria-label="New post">
          <Plus aria-hidden="true" /><span>New post</span>
        </button>
      )}

      {toast && <div className={`cn-toast${toast.kind ? ` is-${toast.kind}` : ''}`} role="status">{toast.text}</div>}
      <Lightbox image={lightbox} onClose={() => setLightbox(null)} />
    </div>
  )
}
