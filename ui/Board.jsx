import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Chat, X,
} from '@openai/apps-sdk-ui/components/Icon'
import { EditedMark, InlineEditor, OwnActions } from './OwnActions.jsx'
import {
  editorHasChanges, editTargetShown, isEditTarget, postEditSettled, withoutReply, withPostEdit,
  withReplyEdit, withRestoredReply,
} from './boardEdits.js'
import {
  avatarHue, deletePost, deleteReply, editBoardText, getPeer, getReplies, initials,
  postDateTime, postReply, publishPost, timeAgo,
} from '../api.js'
import {
  boardRefreshDelay, reactionKey, reconcileReplies, replyActionLabel,
  threadRefreshDelay, upsertReplyAttempt,
} from '../reconciliation.js'
import { useModalFocus } from './modalFocus.js'
import { BoardImage, ReplyImage, prepareImage, SelectedImageStrip, SelectedImagesStrip } from './Media.jsx'
import RichText from './RichText.jsx'
import { membershipDuration } from '../profile.js'
import {
  cachedAvatar, cachedAvatarUrl, discardAvatar, subscribeAvatar,
} from '../avatarCache.js'
import ReactionControls, { useBoardReactions } from './ReactionControls.jsx'
import { boardPostFitsWireLimit } from '../board_payload.js'
import Composer, { ComposerAttachmentButton, ComposerFooter } from './Composer.jsx'
import { prependedScrollTop } from './interactionRules.js'
import { reachedEarlierHistory } from './historyScroll.js'

const MAX_POST_IMAGES = 4
const GALLERY_BUDGET_BYTES = 960 * 1024
import {
  createParticipationIntent, participationActionLabel, participationStep, TEXT_LIMITS,
} from '../participation.js'

const profileCache = new Map()
const replyCache = new Map()
const REPLY_CACHE_TTL_MS = 60_000
const REPLY_CACHE_LIMIT = 64
const REPLY_PREFETCH_LIMIT = 8

// One canonical host key for both caches: peer hosts are lowercase on the wire,
// but a typed "connect directly" host is not, so normalize before caching.
const hostKey = (h) => String(h || '').trim().toLowerCase()

function rememberReplies(key, result) {
  replyCache.delete(key)
  replyCache.set(key, { result, updatedAt: Date.now(), promise: null, background: false })
  while (replyCache.size > REPLY_CACHE_LIMIT) {
    replyCache.delete(replyCache.keys().next().value)
  }
}

function cachedReplies(postId, { force = false, background = false } = {}) {
  const key = String(postId)
  const existing = replyCache.get(key)
  const fresh = existing?.result && Date.now() - existing.updatedAt < REPLY_CACHE_TTL_MS
  if (!force && fresh) return Promise.resolve(existing.result)
  // A tap must not wait behind queued prefetches: only share an in-flight
  // request that is at least as urgent as this one. A forced read must also
  // postdate any change just made, so it never joins an earlier request.
  if (!force && existing?.promise && (background || !existing.background)) return existing.promise

  // A superseded request (a prefetch overtaken by a tap) must not overwrite
  // the entry its successor now owns.
  const owns = () => replyCache.get(key)?.promise === promise
  const promise = getReplies(key, { background }).then((result) => {
    if (owns()) rememberReplies(key, result)
    return result
  }).catch((error) => {
    if (owns()) {
      if (existing?.result) replyCache.set(key, { ...existing, promise: null })
      else replyCache.delete(key)
    }
    throw error
  })
  replyCache.set(key, {
    result: existing?.result || null,
    updatedAt: existing?.updatedAt || 0,
    promise,
    background,
  })
  return promise
}

// The feed already reports each post's reply count; cached replies that match
// it need no prefetch.
function repliesMatchCount(post) {
  const replies = replyCache.get(String(post.id))?.result?.replies
  return Array.isArray(replies) && replies.length === Number(post.reply_count || 0)
}

function Avatar({ name, host, size, remote = false, lazy = false, onOpen = null }) {
  const elementRef = useRef(null)
  const key = remote && host ? hostKey(host) : ''
  // An already-cached avatar paints immediately even when lazy — otherwise every
  // remount (tab switch) flashes initials before the observer fires.
  const cachedUrl = key ? cachedAvatarUrl(key) : null
  const hasCached = Boolean(cachedUrl)
  const [nearViewport, setNearViewport] = useState(!lazy || hasCached)
  const hue = avatarHue(host)
  const cacheKey = remote && nearViewport && host ? key : ''
  const [avatarUrl, setAvatarUrl] = useState(cachedUrl)

  useEffect(() => {
    if (!lazy || hasCached) {
      setNearViewport(true)
      return undefined
    }
    const element = elementRef.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setNearViewport(true)
      return undefined
    }
    setNearViewport(false)
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      setNearViewport(true)
      observer.disconnect()
    }, { rootMargin: '160px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [lazy, key, hasCached])

  useEffect(() => {
    let active = true
    if (!cacheKey) {
      setAvatarUrl(null)
      return () => { active = false }
    }
    const record = cachedAvatar(cacheKey)
    setAvatarUrl(record.url)
    const update = (url) => { if (active) setAvatarUrl(url) }
    const unsubscribe = subscribeAvatar(record, update)
    return () => { active = false; unsubscribe() }
  }, [cacheKey])

  function handleImageError() {
    discardAvatar(cacheKey, avatarUrl)
    setAvatarUrl(null)
  }

  const inner = avatarUrl
    ? <img className="cn-avatar-image" src={avatarUrl} alt="" draggable="false" onError={handleImageError} />
    : initials(name, host)
  const background = `linear-gradient(150deg, hsl(${hue} 62% 58%), hsl(${(hue + 24) % 360} 55% 38%))`
  const className = `cn-avatar${size ? ` is-${size}` : ''}${avatarUrl ? ' has-image' : ''}`

  if (typeof onOpen === 'function' && host) {
    return (
      <button
        ref={elementRef}
        type="button"
        className="cn-avatar-btn"
        onClick={(event) => { event.stopPropagation(); onOpen() }}
        aria-label={`View ${name ? `@${name}` : 'member'} profile`}
        title={name ? `@${name}` : 'View profile'}
      >
        <span className={`${className} cn-avatar-visual`} style={{ background }}>
          {inner}
        </span>
      </button>
    )
  }

  return (
    <span ref={elementRef} className={className} style={{ background }} aria-hidden="true">
      {inner}
    </span>
  )
}

export { Avatar, profileCache, useProfile }

// Shared, in-flight-deduped profile fetch. profileCache stores { actor, at }.
const PROFILE_TTL_MS = 5 * 60_000
const profileInflight = new Map()

function fetchProfile(host) {
  const key = hostKey(host)
  const existing = profileInflight.get(key)
  if (existing) return existing
  const promise = getPeer(host).then((actor) => {
    profileCache.set(key, { actor, at: Date.now() })
    profileInflight.delete(key)
    return actor
  }).catch((error) => { profileInflight.delete(key); throw error })
  profileInflight.set(key, promise)
  return promise
}

// Paints a cached or seed profile at once ({ host, handle, bio } from a post or
// directory row), revalidates quietly past a short TTL, and shares one request
// per host across Board and People. On error it keeps the seed rather than
// blanking to "unavailable".
function useProfile(host, seed = null, attempt = 0) {
  const key = host ? hostKey(host) : ''
  const seedActor = () => (seed && seed.host
    ? { host: seed.host, handle: seed.handle, bio: seed.bio, _partial: true }
    : null)
  const [profile, setProfile] = useState(() => (key && profileCache.get(key)?.actor) || seedActor())
  const [state, setState] = useState(() => (profile ? 'ready' : host ? 'loading' : 'idle'))

  useEffect(() => {
    if (!host) { setProfile(null); setState('idle'); return undefined }
    if (attempt > 0) { profileCache.delete(key); profileInflight.delete(key) }
    const cached = profileCache.get(key)
    const shown = cached?.actor || seedActor()
    if (shown) { setProfile(shown); setState('ready') } else { setProfile(null); setState('loading') }
    const fresh = cached && !cached.actor._partial && Date.now() - cached.at < PROFILE_TTL_MS
    if (fresh) return undefined
    let active = true
    fetchProfile(host)
      .then((actor) => { if (active) { setProfile(actor); setState('ready') } })
      .catch(() => { if (active && !shown) setState('error') })
    return () => { active = false }
  }, [key, attempt])

  return { profile, state }
}

function ProfilePreview({ host, seed, onClose, onViewProfile, onMessage, canMessage }) {
  const { profile, state } = useProfile(host, seed)

  return (
    <section className="cn-profile-preview" aria-label="Profile preview">
      {state === 'loading' && <span className="cn-profile-preview-status">Loading profile…</span>}
      {state === 'error' && <span className="cn-profile-preview-status">Profile unavailable right now.</span>}
      {state === 'ready' && profile && (
        <>
          <Avatar name={profile.handle} host={profile.host} remote />
          <div className="cn-profile-preview-copy">
            <strong>{profile.handle ? `@${profile.handle}` : 'Social member'}</strong>
            <span>{membershipDuration(profile)}</span>
            {profile.bio ? <span className="cn-profile-preview-bio">{profile.bio}</span> : null}
          </div>
          <div className="cn-profile-preview-actions">
            {canMessage && (
              <button className="cn-btn cn-btn-primary" type="button"
                      onClick={() => onMessage(profile.host, profile.handle)}>Message</button>
            )}
            <button className="cn-btn cn-btn-secondary" type="button" onClick={() => onViewProfile(host)}>
              Profile
            </button>
          </div>
        </>
      )}
      <button className="cn-profile-preview-close" type="button" onClick={onClose} aria-label="Close profile preview"><X aria-hidden="true" /></button>
    </section>
  )
}

export default function Board({
  me, feed, feedState, onRefresh, onOpenPerson, onMessageUser, showToast, onOpenImage,
  hasEarlier, onLoadEarlier,
  composing, setComposing, canInteract, accountState, participationIntent, intentState,
  participationBusy, onJoin, joinBusy, onRetryIntent, onRequestParticipation,
  onCompleteParticipation, onDiscardParticipation, onPostConfirmed, emojiReactions = false, replyReactions = false,
  replyAttachments = false, authorEdits = false,
  boardTarget, onTargetHandled,
  composerMount, scrollRef,
}) {
  const [draft, setDraft] = useState('')
  // One stable id per post draft, so a retry after a lost confirmation lands once.
  const [postMessageId, setPostMessageId] = useState(null)
  const [posting, setPosting] = useState(false)
  const [pending, setPending] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [hiddenIds, setHiddenIds] = useState(() => new Set())
  // Editing one item at a time: { postId, replyId, initial, text, saving }.
  const [editing, setEditing] = useState(null)
  // Confirmed post edits shown before the next feed refresh delivers them.
  const [postEdits, setPostEdits] = useState({})
  const [selectedImages, setSelectedImages] = useState([])
  const [reactionPickerFor, setReactionPickerFor] = useState(null)
  const [previewPost, setPreviewPost] = useState(null)
  const [replyPost, setReplyPost] = useState(null)
  const [replies, setReplies] = useState([])
  const [replyState, setReplyState] = useState('idle')
  const [replyError, setReplyError] = useState('')
  const [replyDraft, setReplyDraft] = useState('')
  const [replyImage, setReplyImage] = useState(null)
  const [replyMessageId, setReplyMessageId] = useState(null)
  const [preparingReplyImage, setPreparingReplyImage] = useState(false)
  const [replySending, setReplySending] = useState(false)
  const [notificationReveal, setNotificationReveal] = useState(null)
  const openedTarget = useRef(null)
  const replyDrafts = useRef(new Map())
  const [handoffBusy, setHandoffBusy] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [earlierError, setEarlierError] = useState('')
  const earlierInFlight = useRef(false)
  const earlierFailed = useRef(false)
  const lastScrollTop = useRef(null)
  const replyRequest = useRef(0)
  const replySendingRef = useRef(false)
  // Reply deletes in flight; a poll that started before one could restore it.
  const replyDeletingRef = useRef(0)
  // Start relaxed: the launch just delivered the feed, and every early poll
  // would queue ahead of avatars and history on the single service lane.
  const lastActivityAt = useRef(0)
  const restoreDeleteFocus = useRef(true)
  const fileRef = useRef(null)
  const composerInputRef = useRef(null)
  const replyInputRef = useRef(null)
  const replyScrollRef = useRef(null)
  const replyFileRef = useRef(null)
  const replyPostIdRef = useRef(null)
  const stickToBottom = useRef(true)
  const initialScrollDone = useRef(false)
  const threadAnchor = useRef(null)
  const deleteRef = useModalFocus(
    Boolean(deleteTarget),
    () => setDeleteTarget(null),
    () => restoreDeleteFocus.current,
  )
  replySendingRef.current = replySending

  useEffect(() => {
    setPostEdits((prior) => {
      const ids = Object.keys(prior)
      if (!ids.length) return prior
      const posts = new Map(feed.map((post) => [String(post.id), post]))
      const next = Object.fromEntries(ids
        .filter((id) => posts.has(id) && !postEditSettled(posts.get(id), prior[id]))
        .map((id) => [id, prior[id]]))
      return Object.keys(next).length === ids.length ? prior : next
    })
  }, [feed])
  replyPostIdRef.current = replyPost?.id

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return undefined
    const trackPosition = () => {
      const shouldLoad = reachedEarlierHistory(lastScrollTop.current, scroller)
      lastScrollTop.current = scroller.scrollTop
      stickToBottom.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 96
      if (shouldLoad && feedState === 'ready' && hasEarlier && !earlierFailed.current) loadEarlierPosts()
    }
    lastScrollTop.current = scroller.scrollTop
    scroller.addEventListener('scroll', trackPosition, { passive: true })
    return () => scroller.removeEventListener('scroll', trackPosition)
  }, [scrollRef, feedState, hasEarlier, feed, onLoadEarlier])

  useEffect(() => {
    if (!composing) return
    composerInputRef.current?.focus()
    const scroller = scrollRef.current
    if (scroller) scroller.scrollTop = scroller.scrollHeight
    setComposing(false)
  }, [composing, setComposing, scrollRef])

  useEffect(() => {
    if (feedState !== 'ready') return undefined
    if (boardTarget || replyPost) return undefined
    const firstReadyScroll = !initialScrollDone.current
    if (!firstReadyScroll && !stickToBottom.current) return undefined
    const frame = requestAnimationFrame(() => {
      const scroller = scrollRef.current
      if (!scroller) return
      scroller.scrollTop = scroller.scrollHeight
      initialScrollDone.current = true
      stickToBottom.current = true
    })
    return () => cancelAnimationFrame(frame)
  }, [feedState, feed.length, pending?.id, boardTarget, replyPost?.id, scrollRef])

  // A thread swap can remove a tall section above the tapped post. Keep that
  // post in place before paint; while replies load, don't let native anchoring
  // choose a different row below it. Notification navigation owns its own scroll.
  useLayoutEffect(() => {
    const scroller = scrollRef?.current
    if (!scroller) return
    const previousAnchor = scroller.style.overflowAnchor
    if (replyPost) scroller.style.overflowAnchor = 'none'
    const anchor = threadAnchor.current
    threadAnchor.current = null
    const post = anchor && document.getElementById(`cn-post-${anchor.id}`)
    if (post) scroller.scrollTop += post.getBoundingClientRect().top - anchor.top
    return () => { scroller.style.overflowAnchor = previousAnchor }
  }, [replyPost?.id, scrollRef])

  function keepPostPosition(post) {
    const element = post && document.getElementById(`cn-post-${post.id}`)
    if (element) threadAnchor.current = { id: post.id, top: element.getBoundingClientRect().top }
    initialScrollDone.current = true
    stickToBottom.current = false
  }

  useEffect(() => {
    if (!replyPost) return
    replyDrafts.current.set(replyPost.id, { text: replyDraft, image: replyImage, id: replyMessageId })
    while (replyDrafts.current.size > REPLY_CACHE_LIMIT) {
      replyDrafts.current.delete(replyDrafts.current.keys().next().value)
    }
  }, [replyPost?.id, replyDraft, replyImage, replyMessageId])

  // A retained retry id whose reply has since landed (a timed-out send the
  // thread now shows) is finished: clear the draft rather than resend it.
  useEffect(() => {
    if (!replyPost || !replyMessageId || replySending) return
    if (replies.some((reply) => reply.id === replyMessageId && !reply.pending
        && !reply.id.startsWith('local-'))) clearReplyDraft(replyPost.id)
  }, [replyPost?.id, replyMessageId, replySending, replies])

  // A post deleted here or elsewhere takes its open thread with it.
  useEffect(() => {
    if (feedState === 'ready' && replyPost && !feed.some((post) => post.id === replyPost.id)) {
      closeReplies()
    }
  }, [feed, feedState, replyPost?.id])

  // An editor whose post or reply is no longer shown has nothing to save.
  useEffect(() => {
    if (editing && !editTargetShown(editing, { feed, hiddenIds, replyPostId: replyPost?.id, replies })) {
      setEditing(null)
    }
  }, [editing?.postId, editing?.replyId, feed, hiddenIds, replyPost?.id, replies])

  useEffect(() => {
    if (boardTarget?.status !== 'ready' || openedTarget.current === boardTarget.requestId) return
    const post = feed.find(item => item.id === boardTarget.postId)
    if (!post) return
    openedTarget.current = boardTarget.requestId
    initialScrollDone.current = true
    stickToBottom.current = false
    setNotificationReveal(boardTarget)
    setReplyPost(post)
    setReplies([])
    restoreReplyDraft(post.id)
    setReactionPickerFor(null)
    loadReplies(post, { force: true })
  }, [boardTarget, feed])

  useEffect(() => {
    if (!notificationReveal || !['ready', 'error'].includes(replyState)) return undefined
    const target = notificationReveal
    const frame = requestAnimationFrame(() => {
      let element = target.replyId && replyState === 'ready'
        ? document.getElementById(`cn-reply-${target.replyId}`) : null
      if (target.replyId && replyState === 'ready' && !element) {
        showToast('That reply is no longer available. Here’s the original post.', 'error')
      }
      element ||= document.getElementById(`cn-post-${target.postId}`)
      element?.scrollIntoView({ block: 'center' })
      element?.focus({ preventScroll: true })
      setNotificationReveal(null)
      onTargetHandled?.()
    })
    return () => cancelAnimationFrame(frame)
  }, [notificationReveal, replyState, replies, onTargetHandled])

  function countFor(post) {
    const count = Number(
      replyPost?.id === post.id && replyState === 'ready'
        ? replies.length
        : post.reply_count ?? 0,
    )
    return Number.isFinite(count) ? count : 0
  }

  async function loadEarlierPosts() {
    const before = feed.at(-1)?.created_at
    if (before === null || before === undefined || !hasEarlier || earlierInFlight.current) return
    earlierInFlight.current = true
    earlierFailed.current = false
    const scroller = scrollRef.current
    const previousHeight = scroller?.scrollHeight
    const previousTop = scroller?.scrollTop
    setLoadingEarlier(true)
    setEarlierError('')
    try {
      await onLoadEarlier(before)
      if (scroller && previousHeight !== undefined && previousTop !== undefined) {
        requestAnimationFrame(() => {
          scroller.scrollTop = prependedScrollTop(previousTop, previousHeight, scroller.scrollHeight)
        })
      }
    } catch {
      earlierFailed.current = true
      setEarlierError('Earlier posts couldn’t be loaded. The posts already here are unchanged.')
    } finally {
      earlierInFlight.current = false
      setLoadingEarlier(false)
    }
  }

  function markActivity() {
    lastActivityAt.current = Date.now()
  }

  async function loadReplies(post, { background = false, force = false } = {}) {
    const request = ++replyRequest.current
    // The feed count is only a hint for the first open, never authority over
    // a cached conversation or an ongoing check of the open thread.
    if (!force && !background && Number(post.reply_count || 0) === 0
        && !replyCache.has(String(post.id))) {
      const result = { replies: [] }
      rememberReplies(String(post.id), result)
      setReplies([])
      setReplyState('ready')
      return true
    }
    if (!background) {
      setReplyState('loading')
      setReplyError('')
    }
    try {
      const result = await cachedReplies(post.id, { force: force || background, background })
      if (request !== replyRequest.current) return
      const loaded = result.replies || []
      setReplies(prior => reconcileReplies(loaded, prior))
      setReplyState('ready')
      return true
    } catch (error) {
      if (request !== replyRequest.current) return
      if (background) return false
      setReplyError(error.status === 404
        ? 'Replies aren’t available on this server yet.'
        : 'Replies couldn’t be loaded right now.')
      setReplyState('error')
      return false
    }
  }

  function restoreReplyDraft(postId, restoredDraft) {
    const saved = restoredDraft || replyDrafts.current.get(postId)
    setReplyDraft(saved?.text || '')
    setReplyImage(saved?.image || null)
    setReplyMessageId(saved?.id || null)
  }

  function clearReplyDraft(postId) {
    replyDrafts.current.delete(postId)
    if (replyPostIdRef.current !== postId) return
    setReplyDraft('')
    setReplyImage(null)
    setReplyMessageId(null)
  }

  function changeReplyDraft(text) {
    setReplyDraft(text)
    setReplyMessageId(null)
  }

  function removeReplyImage() {
    setReplyImage(null)
    setReplyMessageId(null)
  }

  async function chooseReplyImage(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    const postId = replyPost?.id
    if (!file || !postId) return
    setPreparingReplyImage(true)
    try {
      const image = await prepareImage(file)
      if (replyPostIdRef.current === postId) {
        setReplyImage(image)
        setReplyMessageId(null)
      } else {
        const saved = replyDrafts.current.get(postId) || {}
        replyDrafts.current.set(postId, { ...saved, image, id: null })
      }
    } catch (error) {
      showToast(error.message, 'error')
    } finally {
      setPreparingReplyImage(false)
      if (replyPostIdRef.current === postId) replyInputRef.current?.focus()
    }
  }

  function openReplies(post, restoredDraft) {
    if (replyPost?.id === post.id && !restoredDraft) {
      closeReplies()
      return
    }
    if (replyPost?.id !== post.id) keepPostPosition(post)
    markActivity()
    if (notificationReveal) {
      setNotificationReveal(null)
      onTargetHandled?.()
    }
    setReactionPickerFor(null)
    setPreviewPost(null)
    const cached = replyCache.get(String(post.id))?.result
    setReplyPost(post)
    setReplies(cached?.replies || [])
    setReplyState(cached ? 'ready' : 'idle')
    restoreReplyDraft(post.id, restoredDraft)
    loadReplies(post, { background: Boolean(cached) })
  }

  function closeReplies() {
    keepPostPosition(replyPost)
    replyRequest.current += 1
    setNotificationReveal(null)
    onTargetHandled?.()
    setReplyPost(null)
    setReplyState('idle')
    setReplyError('')
    onRefresh(true)
  }

  // The board itself stays current while it is visible. Opening or using a
  // conversation temporarily tightens the cadence; an idle board relaxes.
  useEffect(() => {
    let alive = true
    let timer = null
    let refreshing = false
    const schedule = () => {
      if (!alive) return
      timer = setTimeout(tick, boardRefreshDelay(lastActivityAt.current))
    }
    const tick = async () => {
      if (!alive) return
      if (document.visibilityState !== 'visible') return
      if (refreshing) {
        schedule()
        return
      }
      refreshing = true
      try { await onRefresh(true) } finally {
        refreshing = false
        schedule()
      }
    }
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      clearTimeout(timer)
      markActivity()
      tick()
    }
    schedule()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      alive = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [onRefresh])

  // Only an open conversation gets the tighter thread refresh. Background
  // checks never replace the sheet with a spinner or surface a transient error.
  useEffect(() => {
    if (!replyPost) return undefined
    let alive = true
    let timer = null
    const schedule = () => {
      if (!alive) return
      timer = setTimeout(tick, threadRefreshDelay(lastActivityAt.current))
    }
    const tick = async () => {
      if (!alive) return
      if (document.visibilityState !== 'visible') return
      if (replySendingRef.current || replyDeletingRef.current) {
        schedule()
        return
      }
      try { await loadReplies(replyPost, { background: true }) } finally { schedule() }
    }
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      clearTimeout(timer)
      markActivity()
      tick()
    }
    schedule()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      alive = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [replyPost?.id])

  // A thread click should reveal content, not begin a full network round-trip.
  // Warm only the small, visible set that is known to contain replies; empty
  // posts skip the request entirely and open their composer immediately.
  useEffect(() => {
    let cancelled = false
    const posts = feed
      .filter((post) => Number(post.reply_count || 0) > 0 && !repliesMatchCount(post))
      .slice(0, REPLY_PREFETCH_LIMIT)
    const warm = async () => {
      for (const post of posts) {
        if (cancelled) return
        try {
          await cachedReplies(post.id, { background: true })
        } catch { /* normal open path shows recovery */ }
      }
    }
    const idleId = window.requestIdleCallback
      ? window.requestIdleCallback(warm, { timeout: 1200 })
      : window.setTimeout(warm, 250)
    return () => {
      cancelled = true
      if (window.cancelIdleCallback) window.cancelIdleCallback(idleId)
      else window.clearTimeout(idleId)
    }
  }, [feed])

  async function sendReply(event) {
    event.preventDefault()
    const completedIntent = createParticipationIntent('reply', {
      postId: replyPost?.id, text: replyDraft, attachment: replyImage?.payload,
      thumbnail: replyImage?.thumbnailPayload,
    })
    const text = replyDraft.trim()
    const post = replyPost
    const image = replyImage
    if (!canInteract || (!text && !image) || !post || replySending || handoffBusy || preparingReplyImage) return

    const localId = replyMessageId || crypto.randomUUID()
    setReplyMessageId(localId)
    const optimistic = {
      id: localId,
      host: me?.host,
      handle: me?.handle,
      text,
      created_at: Date.now() / 1000,
      pending: true,
      ...(image ? { attachment: {
        mime: image.payload.mime, w: image.payload.w, h: image.payload.h,
        preview_url: image.previewUrl,
      } } : {}),
    }
    markActivity()
    replySendingRef.current = true
    setReplySending(true)
    setReplies((prior) => upsertReplyAttempt(prior, optimistic))
    try {
      const receipt = await postReply(post.id, text, {
        id: localId, attachment: image?.payload, thumbnail: image?.thumbnailPayload,
      })
      const confirmed = { ...optimistic, id: receipt.id || localId, pending: false }
      if (replyPostIdRef.current === post.id) {
        setReplies((prior) => upsertReplyAttempt(
          prior.filter(reply => reply.id !== localId || !reply.pending), confirmed,
        ))
      }
      clearReplyDraft(post.id)
      // Replace any pre-write request without discarding the confirmed write
      // if its fresh confirmation read fails or the thread is reopened.
      const key = String(post.id)
      const cached = replyCache.get(key)?.result?.replies || []
      rememberReplies(key, { replies: upsertReplyAttempt(cached, confirmed) })
      if (replyPostIdRef.current === post.id) await loadReplies(post, { background: true, force: true })
      window.mobius?.signal?.('item_created', { type: 'board_reply' })
      onCompleteParticipation?.(completedIntent)
      onRefresh(true)
    } catch (error) {
      if (replyPostIdRef.current === post.id) {
        setReplies((prior) => prior.filter((reply) => reply.id !== localId || !reply.pending))
      }
      if (error.status === 410) {
        // The reply or its post was deleted: this draft can never land.
        clearReplyDraft(post.id)
        if (replyPostIdRef.current === post.id) loadReplies(post, { background: true, force: true })
        onRefresh(true)
      }
      showToast(error.status === 404
        ? 'Replies aren’t available on this server yet.'
        : error.message, 'error')
    } finally {
      replySendingRef.current = false
      setReplySending(false)
    }
  }

  async function refreshReactionTarget(target) {
    if (!target.replyId) return onRefresh(true)
    if (replyPost?.id !== target.postId) return false
    return loadReplies(replyPost, { background: true, force: true })
  }

  const { overrides: reactionOverrides, pending: reactionPending, toggle: toggleItemReaction } = useBoardReactions({
    refreshTarget: refreshReactionTarget,
    onError: (error, target) => {
      showToast(error.message, 'error')
      // The post or reply was deleted: show the board as it is now.
      if (error.status === 410) refreshReactionTarget(target).catch(() => {})
    },
    onSettled: (target, emoji) => {
      if (!target.replyId) onCompleteParticipation?.(createParticipationIntent('like', {
        postId: target.postId, emoji,
      }))
    },
  })

  function toggleReaction(item, emoji, target = { postId: item.id }) {
    markActivity()
    setReactionPickerFor(null)
    return toggleItemReaction(item, emoji, target)
  }

  async function continueParticipation(kind, values) {
    if (handoffBusy || participationBusy) return
    // The board paints from cache before the profile arrives. Until it does,
    // a member's tap must not be saved as a draft and sent to sign-up.
    if (!me) {
      showToast('Social is still loading your profile. Try again in a moment.', 'error')
      return
    }
    const intent = createParticipationIntent(kind, values)
    if (!intent) {
      showToast('This draft couldn’t be prepared. Check it and try again.', 'error')
      return
    }
    setHandoffBusy(true)
    try {
      await onRequestParticipation(intent)
    } catch (error) {
      showToast(error.message || 'Social couldn’t continue to your account.', 'error')
    } finally {
      setHandoffBusy(false)
    }
  }

  function resumeParticipation() {
    const intent = participationIntent
    if (!intent) return
    if (!canInteract) {
      void continueParticipation(intent.kind, {
        postId: intent.post_id,
        text: intent.text,
        attachment: intent.attachment,
        thumbnail: intent.thumbnail,
        attachments: intent.attachments,
        thumbnails: intent.thumbnails,
        emoji: intent.emoji,
      })
      return
    }
    if (intent.kind === 'post') {
      changeDraft(intent.text || '')
      const saved = Array.isArray(intent.attachments) && intent.attachments.length
        ? intent.attachments
        : (intent.attachment ? [intent.attachment] : [])
      setSelectedImages(saved.map((attachment, i) => ({
        id: `resumed-${i}`,
        payload: attachment,
        thumbnailPayload: intent.thumbnails?.[i],
        previewUrl: `data:${attachment.mime};base64,${attachment.data_b64}`,
      })))
      setComposing(true)
      return
    }
    const post = feed.find(item => item.id === intent.post_id)
    if (!post) {
      showToast('That post isn’t in this view. Refresh the board and try again.', 'error')
      return
    }
    if (intent.kind === 'reply') {
      const image = intent.attachment ? {
        payload: intent.attachment, thumbnailPayload: intent.thumbnail,
        previewUrl: `data:${intent.attachment.mime};base64,${intent.attachment.data_b64}`,
      } : null
      openReplies(post, { text: intent.text || '', image })
      return
    }
    setReactionPickerFor(reactionKey({ postId: post.id }))
    const button = document.getElementById(`cn-react-${post.id}`)
    button?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    button?.focus?.()
  }

  async function doDelete() {
    if (deleteTarget?.reply) return doDeleteReply()
    const post = deleteTarget
    if (!post) return
    // The trigger is about to disappear. Do not restore focus to it: browsers
    // may scroll the feed to a focused node just before React removes it.
    restoreDeleteFocus.current = false
    // Remove it from view in the same commit as the dialog; restore it only if
    // the server rejects the deletion.
    setHiddenIds((prior) => new Set(prior).add(post.id))
    setDeleteTarget(null)
    if (replyPostIdRef.current === post.id) closeReplies()
    try {
      await deletePost(post.id)
    } catch (error) {
      // Only a failed delete un-hides the post; a later refresh failure must not
      // resurrect a post the server already removed.
      setHiddenIds((prior) => {
        const next = new Set(prior)
        next.delete(post.id)
        return next
      })
      showToast(error.message || 'This post couldn’t be deleted.', 'error')
      return
    }
    onRefresh(true)
  }

  function updateReplies(postId, change) {
    const key = String(postId)
    if (replyPostIdRef.current === postId) {
      // A reply load already in flight predates this change; drop its result.
      replyRequest.current += 1
      setReplies(change)
    }
    const cached = replyCache.get(key)?.result?.replies
    if (cached) rememberReplies(key, { ...replyCache.get(key).result, replies: change(cached) })
  }

  function refreshOpenThread(post) {
    if (replyPostIdRef.current === post.id) loadReplies(post, { background: true })
  }

  // Keep keyboard and screen-reader users in place when an editor or a reply
  // they were acting on goes away.
  function focusItem(postId, replyId) {
    requestAnimationFrame(() => {
      const target = (replyId && document.getElementById(`cn-reply-${replyId}`))
        || document.getElementById(`cn-post-${postId}`)
      target?.focus?.({ preventScroll: true })
    })
  }

  async function doDeleteReply() {
    const { post, reply } = deleteTarget
    restoreDeleteFocus.current = false
    setDeleteTarget(null)
    updateReplies(post.id, (prior) => withoutReply(prior, reply.id))
    focusItem(post.id)
    replyDeletingRef.current += 1
    try {
      await deleteReply(post.id, reply.id)
    } catch (error) {
      updateReplies(post.id, (prior) => withRestoredReply(prior, reply))
      showToast(error.message || 'This reply couldn’t be deleted.', 'error')
      refreshOpenThread(post)
      return
    } finally {
      replyDeletingRef.current -= 1
    }
    // A read that began before the delete may have restored it meanwhile.
    updateReplies(post.id, (prior) => withoutReply(prior, reply.id))
    refreshOpenThread(post)
    onRefresh(true)
  }

  function closeEditor(postId, replyId) {
    setEditing((current) => isEditTarget(current, postId, replyId) ? null : current)
    focusItem(postId, replyId)
  }

  function startEdit(postId, reply, initial) {
    // Another edit request must not discard text the author hasn't saved.
    if (editorHasChanges(editing)) {
      const field = document.querySelector('.cn-inline-edit-field')
      field?.focus({ preventScroll: true })
      field?.scrollIntoView?.({ block: 'nearest' })
      return
    }
    setEditing({ postId, replyId: reply?.id || null, initial: initial || '', text: initial || '', saving: false })
  }

  function changeEdit(text) {
    setEditing((current) => current ? { ...current, text } : current)
  }

  async function saveEdit(post, reply, text) {
    const replyId = reply?.id || null
    setEditing((current) => isEditTarget(current, post.id, replyId) ? { ...current, saving: true } : current)
    try {
      const result = await editBoardText(post.id, text, replyId)
      const edit = { text: result.text ?? text, edited_at: result.edited_at }
      if (reply) {
        updateReplies(post.id, (prior) => withReplyEdit(prior, reply.id, edit))
        refreshOpenThread(post)
      } else if (typeof edit.edited_at === 'number') {
        setPostEdits((prior) => ({ ...prior, [post.id]: edit }))
      }
      if (result.applied === false) {
        showToast('A newer edit already exists, so this one wasn’t saved.', 'error')
        onRefresh(true)
      }
      closeEditor(post.id, replyId)
    } catch (error) {
      showToast(error.message || 'Your edit couldn’t be saved.', 'error')
      if (error.status === 410) {
        // It was deleted meanwhile: there is nothing left to edit.
        closeEditor(post.id, replyId)
        if (reply) refreshOpenThread(post)
        else onRefresh(true)
        return
      }
      setEditing((current) => isEditTarget(current, post.id, replyId) ? { ...current, saving: false } : current)
    }
  }

  function isEditing(postId, replyId = null) {
    return isEditTarget(editing, postId, replyId)
  }

  function changeDraft(text) {
    setDraft(text)
    setPostMessageId(null)
  }

  function chooseImage(event) {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (!files.length) return
    const additions = []
    for (const file of files) {
      if (selectedImages.length + additions.length >= MAX_POST_IMAGES) {
        showToast(`You can attach up to ${MAX_POST_IMAGES} images.`, 'error')
        break
      }
      if (!file.type?.startsWith('image/')) {
        showToast('Choose image files only.', 'error')
        continue
      }
      additions.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        previewUrl: URL.createObjectURL(file),
      })
    }
    if (additions.length) {
      setSelectedImages(prior => [...prior, ...additions])
      setPostMessageId(null)
    }
  }

  function removeImage(index) {
    setPostMessageId(null)
    setSelectedImages((prior) => {
      const image = prior[index]
      if (image?.file && image.previewUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(image.previewUrl)
      }
      return prior.filter((_, i) => i !== index)
    })
  }

  // Compress each selected image now, sharing a byte budget so the whole
  // gallery (plus the first image kept for old hosts) fits one federation
  // envelope. Items resumed from a saved draft already carry a payload.
  async function collectImagePayloads(images, text = '') {
    if (!images.length) return {
      attachment: undefined, attachments: undefined, thumbnails: undefined, previews: [],
    }
    const budget = images.length <= 1
      ? undefined
      : Math.floor(GALLERY_BUDGET_BYTES / (images.length + 1))
    const payloads = []
    const thumbnails = []
    const previews = []
    for (const image of images) {
      const prepared = image.payload
        ? { payload: image.payload, thumbnailPayload: image.thumbnailPayload, previewUrl: image.previewUrl }
        : await prepareImage(image.file, budget)
      payloads.push(prepared.payload)
      if (prepared.thumbnailPayload) thumbnails.push(prepared.thumbnailPayload)
      previews.push({
        mime: prepared.payload.mime,
        w: prepared.payload.w,
        h: prepared.payload.h,
        preview_url: prepared.previewUrl,
      })
    }
    const result = payloads.length === 1
      ? { attachment: payloads[0], attachments: undefined, thumbnails, previews }
      : { attachment: undefined, attachments: payloads, thumbnails, previews }
    if (!boardPostFitsWireLimit({ text, ...result })) {
      throw new Error('These photos are too large to send together. Remove one or choose smaller images.')
    }
    return result
  }

  async function publish() {
    const text = draft.trim()
    const images = selectedImages
    if (!text && !images.length) return
    // Kept across a failure (the draft is restored unchanged) and cleared on
    // success or any edit, like a reply's retry id.
    const postId = postMessageId || crypto.randomUUID()
    setPostMessageId(postId)
    markActivity()
    setPosting(true)
    const startedAt = Date.now() / 1000
    setPending({
      id: `pending-${Date.now()}`,
      host: me?.host,
      handle: me?.handle || '',
      text,
      images: images.map((image) => ({ url: image.previewUrl })),
      phase: images.length ? 'preparing' : 'sending',
      created_at: startedAt,
    })
    setDraft('')
    setSelectedImages([])
    setComposing(false)
    let attachment
    let attachments
    let thumbnails
    let previews
    try {
      ({ attachment, attachments, thumbnails, previews } = await collectImagePayloads(images, text))
      setPending((current) => current ? { ...current, phase: 'sending' } : current)
    } catch (error) {
      setPending(null)
      setDraft(text)
      setSelectedImages(images)
      setComposing(true)
      setPosting(false)
      showToast(error.message || 'An image couldn’t be prepared.', 'error')
      return
    }
    const completedIntent = createParticipationIntent('post', {
      text, attachment, attachments, thumbnails,
    })
    try {
      const receipt = await publishPost(text, attachment, attachments, thumbnails, postId)
      setPostMessageId(null)
      onPostConfirmed?.({
        id: receipt.id || postId,
        host: me?.host,
        handle: me?.handle || '',
        text,
        created_at: startedAt,
        ...(previews.length === 1 ? { attachment: previews[0] } : {}),
        ...(previews.length > 1 ? { attachments: previews } : {}),
        like_count: 0,
        liked: false,
        reactions: [],
        reply_count: 0,
        reply_authors: [],
      })
      setPending(null)
      window.mobius?.signal?.('item_created', { type: 'board_post' })
      onCompleteParticipation?.(completedIntent)
      // Release the local previews now that the post succeeded (on failure we
      // restore them for a retry, so only revoke on the happy path).
      for (const image of images) {
        if (image.file && image.previewUrl?.startsWith('blob:')) {
          URL.revokeObjectURL(image.previewUrl)
        }
      }
    } catch (error) {
      setPending(null)
      setDraft(text)
      setSelectedImages(images)
      setComposing(true)
      window.mobius?.signal?.('error', { message: error.message, source: 'publish' })
      showToast(
        (error.status === 400 || error.status === 404) && images.length
          ? 'Photo posts aren’t available on this server yet.'
          : error.message,
        'error',
      )
    } finally {
      setPosting(false)
    }
  }

  async function submitPost(event) {
    event?.preventDefault()
    if (canInteract) await publish()
  }

  const chronologicalFeed = feed
    .filter((post) => !hiddenIds.has(post.id))
    .slice()
    .reverse()

  return (
    <div className="cn-content cn-screen cn-board-chat">
      {boardTarget?.status === 'loading' && <p className="cn-intent-status" role="status">Opening the community conversation…</p>}
      {intentState === 'loading' && (
        <p className="cn-intent-status" role="status">Checking for a saved draft…</p>
      )}
      {intentState === 'error' && (
        <div className="cn-intent-notice is-error" role="alert">
          <div>
            <strong>Saved draft unavailable</strong>
            <span>Keep Social open while you continue, or try loading it again.</span>
          </div>
          <button className="cn-btn cn-btn-secondary" onClick={onRetryIntent}>Try again</button>
        </div>
      )}
      {participationIntent && (
        <section className="cn-intent-notice" aria-label="Pending community action">
          <div>
            <strong>{participationIntent.kind === 'post'
              ? 'Your message draft is saved'
              : participationIntent.kind === 'reply'
                ? 'Your reply draft is saved'
                : 'Your reaction is waiting'}</strong>
            <span>{canInteract
              ? 'Nothing was shared automatically. Review the action when you’re ready.'
              : 'Nothing was shared. Continue with your account when you’re ready.'}</span>
          </div>
          <div className="cn-intent-actions">
            <button className="cn-btn cn-btn-ghost" onClick={onDiscardParticipation}
                    disabled={handoffBusy || participationBusy}>
              Discard
            </button>
            <button className="cn-btn cn-btn-secondary" onClick={resumeParticipation}
                    disabled={handoffBusy || participationBusy}>
              {handoffBusy || participationBusy
                ? 'Please wait…'
                : participationActionLabel(participationStep(me), participationIntent.kind)}
            </button>
          </div>
        </section>
      )}
      {feedState === 'loading' && (
        <div className="cn-feed-skeleton" role="status" aria-label="Loading the board">
          {[0, 1, 2].map((row) => (
            <div className="cn-post-skeleton" key={row} aria-hidden="true">
              <span className="cn-skeleton-avatar" />
              <span className="cn-skeleton-copy"><i /><i /><i /></span>
            </div>
          ))}
        </div>
      )}
      {feedState === 'error' && (
        <div className="cn-empty">
          <div className="cn-empty-title">The community chat is unreachable</div>
          <p className="cn-empty-text">Your community host couldn’t be reached right now.</p>
          <button className="cn-btn cn-btn-secondary" onClick={() => onRefresh()}>Try again</button>
        </div>
      )}
      {feedState === 'ready' && feed.length === 0 && !pending && (
        <div className="cn-empty">
          <div className="cn-empty-mark" aria-hidden="true"><Chat /></div>
          <div className="cn-empty-title">The community is quiet</div>
          <p className="cn-empty-text">
            Messages from everyone in Social appear here. Say hello when
            you’re ready to start the conversation.
          </p>
        </div>
      )}
      {feedState === 'ready' && hasEarlier && (
        <button className="cn-history-more" type="button" disabled={loadingEarlier}
                onClick={loadEarlierPosts}>
          {loadingEarlier ? 'Loading earlier messages…' : 'Load earlier messages'}
        </button>
      )}
      {earlierError && <p className="cn-inline-error" role="alert">{earlierError} <button className="cn-btn cn-btn-secondary" type="button" onClick={loadEarlierPosts}>Try again</button></p>}
      <div className="cn-feed">
        {chronologicalFeed.map((feedPost) => {
          const post = withPostEdit(feedPost, postEdits[feedPost.id])
          const replyCount = countFor(post)
          const mine = canInteract && me?.host && post.host === me.host
          const editingPost = isEditing(post.id)
          const threadOpen = replyPost?.id === post.id
          const togglePreview = canInteract
            ? () => setPreviewPost(previewPost?.id === post.id ? null : { id: post.id, host: post.host })
            : null
          return (
            <article id={`cn-post-${post.id}`} tabIndex={-1} className={`cn-post${threadOpen ? ' has-thread' : ''}${me?.host && post.host === me.host ? ' is-mine' : ''}`} key={post.id}
                     onClick={(event) => {
                       if (!event.target.closest('button, input, textarea, a, .cn-avatar')) openReplies(post)
                     }}>
              <Avatar name={post.handle} host={post.host} remote lazy onOpen={togglePreview} />
              <div className="cn-post-main">
                <div className="cn-post-head">
                  <button className="cn-person" onClick={togglePreview} disabled={!canInteract}>
                    <span className="cn-person-name">{post.handle ? `@${post.handle}` : 'Social member'}</span>
                    <span className="cn-post-dot" aria-hidden="true">·</span>
                    <span className="cn-meta">{postDateTime(post.created_at)}</span>
                    <EditedMark editedAt={post.edited_at} />
                  </button>
                  {mine && !editingPost && (
                    <OwnActions kind="message" disabled={handoffBusy || participationBusy || Boolean(editing?.saving)}
                      onEdit={authorEdits ? () => startEdit(post.id, null, post.text) : null}
                      onDelete={() => { restoreDeleteFocus.current = true; setDeleteTarget(post) }} />
                  )}
                </div>
                <div className="cn-post-body">
                {previewPost?.id === post.id && (
                  <ProfilePreview host={post.host} seed={{ host: post.host, handle: post.handle }}
                                  onClose={() => setPreviewPost(null)}
                                  onViewProfile={onOpenPerson} onMessage={onMessageUser}
                                  canMessage={canInteract && post.host !== me?.host} />
                )}
                {editingPost
                  ? <InlineEditor kind="message" initial={editing.initial} value={editing.text} onChange={changeEdit}
                      maxLength={TEXT_LIMITS.post} saving={editing.saving}
                      allowEmpty={Boolean(post.attachment || post.attachments?.length)}
                      onCancel={() => closeEditor(post.id, null)} onSave={(text) => saveEdit(post, null, text)} />
                  : post.text && <RichText text={post.text} className="cn-post-copy" preview />}
                <BoardImage
                  post={post}
                  onOpen={onOpenImage}
                  onUnavailable={(error) => showToast(
                    error?.status === 404
                      ? 'Community photos aren’t available on this server yet.'
                      : 'This photo couldn’t be loaded.',
                    'error',
                  )}
                />
                <div className="cn-post-actions">
                <button
                  className={`cn-react cn-reply-summary${threadOpen ? ' is-active' : ''}`}
                  onClick={() => openReplies(post)}
                  aria-expanded={threadOpen}
                  aria-controls={`cn-thread-${post.id}`}
                  aria-label={replyCount === 0
                    ? 'Reply to post'
                    : `${threadOpen ? 'Hide' : 'Show'} ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`}
                >
                  {Array.isArray(post.reply_authors) && post.reply_authors.length > 0 && (
                    <span className="cn-reply-avatars" aria-hidden="true">
                      {post.reply_authors.map((author) => (
                        <Avatar key={author.host} name={author.handle} host={author.host} size="micro" remote lazy />
                      ))}
                    </span>
                  )}
                  <span>{replyActionLabel(replyCount)}</span>
                </button>
                <ReactionControls item={post} target={{ postId: post.id }}
                  scrollRef={scrollRef}
                  override={reactionOverrides[post.id]} emojiReactions={emojiReactions}
                  canInteract={canInteract} disabled={handoffBusy || participationBusy || reactionPending[post.id]}
                  pickerFor={reactionPickerFor} setPickerFor={setReactionPickerFor}
                  onReact={(emoji) => toggleReaction(post, emoji)} onJoin={onJoin} />
                </div>
                {threadOpen && (
                  <section className="cn-inline-thread" id={`cn-thread-${post.id}`}
                           aria-label="Replies" onClick={(event) => event.stopPropagation()}>
                    {/* Announce the count, not the rows: their relative times tick on every poll. */}
                    <span className="cn-sr-only" role="status">
                      {replyState === 'ready' ? `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}` : ''}
                    </span>
                    <div ref={replyScrollRef} className="cn-inline-replies">
                      {replyState === 'loading' && <div className="cn-thread-loading" role="status">Loading replies…</div>}
                      {replyState === 'error' && (
                        <div className="cn-thread-loading">
                          <span>{replyError}</span>
                          <button className="cn-btn cn-btn-secondary" onClick={() => loadReplies(post)}>Try again</button>
                        </div>
                      )}
                      {replies.map((reply) => (
                        <article id={`cn-reply-${reply.id}`} tabIndex={-1} className={`cn-reply-row${reply.pending ? ' is-pending' : ''}`} key={reply.id}>
                          <Avatar name={reply.handle} host={reply.host} size="small" remote />
                          <div className="cn-reply-copy">
                            <div className="cn-reply-meta">
                              <strong>{reply.handle ? `@${reply.handle}` : 'Social member'}</strong>
                              <span className="cn-time">
                                {reply.pending ? 'Sending…' : timeAgo(reply.created_at)}
                                <EditedMark editedAt={reply.edited_at} />
                              </span>
                              {authorEdits && canInteract && me?.host && reply.host === me.host && !reply.pending
                                && !reply.id.startsWith('local-') && !isEditing(post.id, reply.id) && (
                                <OwnActions kind="reply" compact disabled={handoffBusy || participationBusy || Boolean(editing?.saving)}
                                  onEdit={() => startEdit(post.id, reply, reply.text)}
                                  onDelete={() => { restoreDeleteFocus.current = true; setDeleteTarget({ post, reply }) }} />
                              )}
                            </div>
                            {isEditing(post.id, reply.id)
                              ? <InlineEditor kind="reply" initial={editing.initial} value={editing.text} onChange={changeEdit}
                                  maxLength={TEXT_LIMITS.reply} saving={editing.saving}
                                  allowEmpty={Boolean(reply.attachment)}
                                  onCancel={() => closeEditor(post.id, reply.id)} onSave={(text) => saveEdit(post, reply, text)} />
                              : <RichText text={reply.text} />}
                            <ReplyImage postId={post.id} reply={reply} onOpen={onOpenImage}
                              onUnavailable={(error) => showToast(error.message, 'error')} />
                            {replyReactions && !reply.pending && !reply.id.startsWith('local-') && <ReactionControls item={reply}
                              target={{ postId: post.id, replyId: reply.id }}
                              override={reactionOverrides[reactionKey({ postId: post.id, replyId: reply.id })]}
                              emojiReactions canInteract={canInteract}
                              disabled={handoffBusy || participationBusy || reactionPending[reactionKey({ postId: post.id, replyId: reply.id })]}
                              pickerFor={reactionPickerFor} setPickerFor={setReactionPickerFor}
                              onReact={(emoji) => toggleReaction(reply, emoji, { postId: post.id, replyId: reply.id })}
                              onJoin={onJoin} />}
                          </div>
                        </article>
                      ))}
                    </div>
                    {canInteract ? <>
                    <input ref={replyFileRef} className="cn-file-input" type="file" accept="image/*"
                      onChange={chooseReplyImage} tabIndex={-1} aria-hidden="true" />
                    <ComposerFooter scrollRef={replyScrollRef} className="cn-reply-footer">
                    <Composer className="cn-reply-composer" onSubmit={sendReply}
                      inputRef={replyInputRef} value={replyDraft} onChange={changeReplyDraft}
                      maxLength={TEXT_LIMITS.reply} placeholder="Post your reply" label="Post your reply"
                      disabled={replySending || handoffBusy || participationBusy || preparingReplyImage}
                      sendDisabled={replySending || handoffBusy || participationBusy || preparingReplyImage || (!replyDraft.trim() && !replyImage)}
                      attachmentAction={<ComposerAttachmentButton onClick={() => replyFileRef.current?.click()}
                        disabled={!replyAttachments || replySending || preparingReplyImage || handoffBusy || participationBusy}
                        label={!replyAttachments ? 'Photo replies need a Community server update' : preparingReplyImage ? 'Preparing photo…' : 'Attach photo to reply'} />}
                      sendLabel="Send reply">
                      {replyImage && <SelectedImageStrip selected={replyImage} onRemove={removeReplyImage}
                        disabled={replySending || preparingReplyImage} onOpen={onOpenImage} />}
                    </Composer></ComposerFooter></> : <button className="cn-btn cn-btn-primary cn-reply-join" type="button"
                                      onClick={onJoin} disabled={joinBusy}>Join Social to reply</button>}
                  </section>
                )}
                </div>
              </div>
            </article>
          )
        })}
        {pending && (
          <article className="cn-post is-pending" aria-label="Sending message">
            <Avatar name={pending.handle} host={pending.host} remote />
            <div className="cn-post-main">
              <div className="cn-post-head">
                <span className="cn-person">
                  <span className="cn-person-name">
                    {pending.handle ? `@${pending.handle}` : 'You'}
                  </span>
                  <span className="cn-post-dot" aria-hidden="true">·</span>
                  <span className="cn-meta cn-pending-status">
                    {pending.phase === 'preparing' ? 'Preparing photo…' : 'Sending…'}
                  </span>
                </span>
              </div>
              <div className="cn-post-body">
                {pending.text && <RichText text={pending.text} className="cn-post-copy" preview />}
                {!!pending.images?.length && (
                  <div className={pending.images.length === 1
                    ? 'cn-pending-image'
                    : `cn-gallery cn-gallery-${pending.images.length} cn-pending-gallery`}>
                    {pending.images.map((image, index) => (
                      <div className={pending.images.length === 1 ? undefined : 'cn-gallery-item'} key={index}>
                        <img src={image.url} alt={`Message photo ${index + 1}`} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </article>
        )}
      </div>
      {composerMount && createPortal(<ComposerFooter scrollRef={scrollRef} className="cn-board-footer">
        {canInteract || accountState === 'loading' ? <>
          <input ref={fileRef} className="cn-file-input" type="file" accept="image/*" multiple
                 onChange={chooseImage} tabIndex={-1} aria-hidden="true" />
          <Composer className="cn-board-composer" onSubmit={submitPost}
            inputRef={composerInputRef} value={draft} onChange={changeDraft}
            maxLength={TEXT_LIMITS.post} placeholder="Message everyone…" label="Message everyone"
            disabled={posting || handoffBusy || participationBusy}
            sendDisabled={!canInteract || posting || handoffBusy || participationBusy || (!draft.trim() && !selectedImages.length)}
            sendLabel={accountState === 'loading' ? 'Checking your account…' : 'Send message'}
            attachmentAction={<ComposerAttachmentButton onClick={() => fileRef.current?.click()}
              disabled={!canInteract || posting || selectedImages.length >= MAX_POST_IMAGES}
              label={selectedImages.length >= MAX_POST_IMAGES ? `Up to ${MAX_POST_IMAGES} images` : 'Attach photo'} />}>
            {selectedImages.length > 0 && <SelectedImagesStrip selected={selectedImages} onRemove={removeImage} onOpen={onOpenImage} />}
          </Composer>
        </> : <div className="cn-board-join">
          <button className="cn-btn cn-btn-primary" type="button" onClick={onJoin}
                  disabled={joinBusy}>Join Social to message</button>
          <p className="cn-composer-disclosure">Community is open to read. Join to message and open Chats and People.</p>
        </div>}
      </ComposerFooter>, composerMount)}

      {deleteTarget && (
        <div className="cn-scrim" role="dialog" aria-modal="true" aria-labelledby="cn-delete-title"
             onClick={() => setDeleteTarget(null)}>
          <div ref={deleteRef} tabIndex={-1} className="cn-sheet cn-confirm-sheet"
               onClick={(e) => e.stopPropagation()}>
            <div className="cn-grabber" aria-hidden="true" />
            <h3 id="cn-delete-title" className="cn-sheet-title">{deleteTarget.reply ? 'Delete this reply?' : 'Delete this message?'}</h3>
            <p className="cn-sheet-body">
              {deleteTarget.reply
                ? 'This removes your reply from the conversation for everyone. This can’t be undone.'
                : 'This removes your message from the community chat for everyone. This can’t be undone.'}
            </p>
            <div className="cn-sheet-actions">
              <button className="cn-btn cn-btn-secondary" onClick={() => setDeleteTarget(null)}>
                Cancel
              </button>
              <button className="cn-btn cn-btn-danger" onClick={doDelete}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
