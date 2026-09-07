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
  needsGlobalJoin, prepareCommunity, joinGlobalCommunity, checkGlobalRegistration,
} from './community.js'

function ParticipationNotice({ me, busy, onJoin, onConnect, onCheck }) {
  if (needsGlobalJoin(me)) {
    return (
      <section className="cn-welcome" aria-labelledby="cn-welcome-title">
        <span className="cn-welcome-mark" aria-hidden="true"><Globe /></span>
        <div className="cn-welcome-copy">
          <h2 id="cn-welcome-title">Join global Social</h2>
          <p>
            Social now has one global board and people directory. Join to share your
            handle and profile picture there. Your existing private conversations stay here.
          </p>
        </div>
        <button className="cn-btn cn-btn-primary" onClick={onJoin} disabled={busy}>
          {busy ? 'Joining…' : 'Join global Social'}
        </button>
      </section>
    )
  }

  if (me?.joined && me?.name) {
    if (me.registration === 'registered') return null
    const missing = me.registration === 'missing'
    return (
      <section className="cn-welcome" aria-labelledby="cn-registration-title">
        <div className="cn-welcome-copy">
          <h2 id="cn-registration-title">{missing ? 'Finish joining global Social' : 'Global directory unavailable'}</h2>
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
  return (
    <section className="cn-welcome" aria-labelledby="cn-welcome-title">
      <span className="cn-welcome-mark" aria-hidden="true"><Globe /></span>
      <div className="cn-welcome-copy">
        <h2 id="cn-welcome-title">
          {connected ? `Welcome, @${me.handle}` : 'Explore Social first'}
        </h2>
        <p>
          {connected
            ? 'Browse the global board and people now. Join when you’re ready to post or message.'
            : 'The global board and directory are open to browse. Connect your Möbius profile when you want to post or message.'}
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
            <button className="cn-btn cn-btn-primary" onClick={onConnect} disabled={!me?.identity_app_id}>
              Connect profile
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
  const [appIconUrl, setAppIconUrl] = useState(null)
  const navHandle = useRef(null)
  const toastTimer = useRef(null)
  const readySignalled = useRef(false)

  function showToast(text, kind) {
    setToast({ text, kind })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2600)
  }

  async function loadMe() {
    try {
      const loaded = await api.getMe()
      const profile = await prepareCommunity(loaded, api.saveMe)
      const registration = await checkGlobalRegistration(profile, api.searchPeople)
      const checked = { ...profile, registration }
      setMe(checked)
      setMeState('ready')
      return checked
    } catch (error) {
      window.mobius?.signal?.('error', { message: error.message, source: 'me' })
      setMeState('error')
      return null
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
      if (profile && !needsGlobalJoin(profile)) loadFeed()
    })
    loadConversations()
    api.getAppIcon(appId)
      .then((blob) => setAppIconUrl(URL.createObjectURL(blob)))
      .catch(() => {})
  }, [])

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

  const openThread = (peer, name) => openAnyThread({ kind: 'dm', peer, name })
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
    if (me?.identity_app_id) {
      window.parent.postMessage({ type: 'moebius:open-app', appId: me.identity_app_id }, '*')
    }
  }

  async function join() {
    setSaving(true)
    setJoinError(null)
    try {
      await joinGlobalCommunity(me, api.saveMe, api.join)
      const profile = await loadMe()
      if (!profile) return
      await loadFeed()
      if (profile.registration === 'registered') showToast('Welcome to global Social', 'success')
    } catch (error) {
      setJoinError(error.message)
    } finally {
      setSaving(false)
    }
  }

  const visibleGroups = groups.filter(group => api.groupIsVisible(group, me?.host))
  const unread =
    conversations.reduce((sum, c) => sum + (c.unread || 0), 0) +
    visibleGroups.reduce((sum, g) => sum + (g.unread || 0), 0)
  const needsJoin = needsGlobalJoin(me)
  const canParticipate = Boolean(me?.joined && me?.name && !needsJoin)

  // ── render ────────────────────────────────────────────────────────────────
  if (meState === 'loading') {
    return (
      <div className="cn-root"><style>{CSS}</style>
        <div className="cn-center" style={{ flex: 1 }}><div className="cn-spinner" /></div>
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
            peer={thread.peer}
            peerHandle={thread.name || conversations.find((c) => c.peer === thread.peer)?.peer_handle}
            me={me}
            version={version}
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
            onConnect={openIdentityApp}
            onCheck={() => loadMe()}
          />
          {joinError && <div className="cn-directory-error" role="alert">
            <p>{joinError}</p>
          </div>}
          {me?.account_error && !me?.connected && (
            <p className="cn-inline-error" role="status">{me.account_error}</p>
          )}
        </div>
        {tab === 'board' && !needsJoin && (
          <Board me={me} feed={feed} feedState={feedState} onRefresh={loadFeed}
                 composing={composing} setComposing={setComposing}
                 canInteract={canParticipate}
                 onOpenPerson={(host) => { setProfileRequest(host); setTab('people') }} showToast={showToast}
                 onOpenImage={(url, alt) => setLightbox({ url, alt })} />
        )}
        {tab === 'messages' && (
          me?.joined && me?.name ? (
            <Messages canCreate={canParticipate} me={me} conversations={conversations} groups={visibleGroups}
                      loadState={messagesState} onRetry={loadConversations}
                      creating={creatingGroup} setCreating={setCreatingGroup}
                      onOpenThread={(peer) => openThread(peer)}
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
        {tab === 'people' && !needsJoin && (
          <People me={me} onMessage={(host, name) => openThread(host, name)} showToast={showToast}
                  canMessage={canParticipate}
                  requestedProfile={profileRequest}
                  onProfileRequestHandled={() => setProfileRequest(null)} />
        )}
      </div>

      {tab === 'board' && canParticipate && (
        <button className="cn-fab" onClick={() => setComposing(true)} aria-label="New post">
          <Plus aria-hidden="true" /><span>New post</span>
        </button>
      )}

      {toast && <div className={`cn-toast${toast.kind ? ` is-${toast.kind}` : ''}`} role="status">{toast.text}</div>}
      <Lightbox image={lightbox} onClose={() => setLightbox(null)} />
    </div>
  )
}
