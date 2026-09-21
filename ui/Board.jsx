import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp, Chat, EmojiAdd, Heart, ImageSquare, Trash, X,
} from '@openai/apps-sdk-ui/components/Icon'
import {
  avatarHue, deletePost, getPeer, getPeerAvatar, getReplies, initials,
  postDateTime, postReply, publishPost, reactToPost, timeAgo,
} from '../api.js'
import {
  BOARD_REACTION_EMOJIS, boardRefreshDelay, optimisticReactionChange,
  reactionState, reconcileReplies, threadRefreshDelay,
} from '../reconciliation.js'
import { useModalFocus } from './modalFocus.js'
import { BoardImage, prepareImage, SelectedImagesStrip } from './Media.jsx'
import RichText from './RichText.jsx'
import { membershipDuration } from '../profile.js'
import { EMOJI_ART } from '../emoji_art.js'

const MAX_POST_IMAGES = 4
const GALLERY_BUDGET_BYTES = 1.05 * 1024 * 1024
import {
  createParticipationIntent, participationActionLabel, participationStep,
} from '../participation.js'

const avatarCache = new Map()
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
  replyCache.set(key, { result, updatedAt: Date.now(), promise: null })
  while (replyCache.size > REPLY_CACHE_LIMIT) {
    replyCache.delete(replyCache.keys().next().value)
  }
}

function cachedReplies(postId, { force = false } = {}) {
  const key = String(postId)
  const existing = replyCache.get(key)
  const fresh = existing?.result && Date.now() - existing.updatedAt < REPLY_CACHE_TTL_MS
  if (!force && fresh) return Promise.resolve(existing.result)
  if (existing?.promise) return existing.promise

  const promise = getReplies(key).then((result) => {
    rememberReplies(key, result)
    return result
  }).catch((error) => {
    if (existing?.result) replyCache.set(key, { ...existing, promise: null })
    else replyCache.delete(key)
    throw error
  })
  replyCache.set(key, {
    result: existing?.result || null,
    updatedAt: existing?.updatedAt || 0,
    promise,
  })
  return promise
}

function FlatEmoji({ emoji }) {
  return <img className="cn-flat-emoji" src={EMOJI_ART[emoji]} alt="" aria-hidden="true" draggable="false" />
}

const AVATAR_RETRY_MS = 45_000
const AVATAR_CONCURRENCY = 4
let avatarActive = 0
const avatarQueue = []
function pumpAvatars() {
  while (avatarActive < AVATAR_CONCURRENCY && avatarQueue.length) {
    const job = avatarQueue.shift()
    avatarActive += 1
    job().finally(() => { avatarActive -= 1; pumpAvatars() })
  }
}

function cachedAvatar(host) {
  const key = hostKey(host)
  const now = Date.now()
  let record = avatarCache.get(key)
  if (record) {
    // Resolved image, a known 404 (no avatar), or an in-flight request: reuse.
    if (record.url || record.notFound || record.promise) return record
    // A transient failure recently: keep showing initials until the retry window.
    if (record.failedAt && now - record.failedAt < AVATAR_RETRY_MS) return record
  }
  record = record || { url: null, promise: null }
  // One request per unique host, shared across every visible post, and capped:
  // each peer-avatar call is a cold per-request process, so a screenful of new
  // hosts must not spawn dozens of federation fetches at once.
  record.promise = new Promise((resolve) => {
    avatarQueue.push(() => Promise.resolve(getPeerAvatar(key))
      .then((blob) => {
        if (blob?.size) { record.url = URL.createObjectURL(blob); record.failedAt = null }
        else { record.notFound = true }
      })
      .catch((error) => {
        if (error?.status === 404) record.notFound = true
        else record.failedAt = Date.now()
      })
      .finally(() => { record.promise = null; resolve() }))
    pumpAvatars()
  })
  avatarCache.set(key, record)
  return record
}

function Avatar({ name, host, size, remote = false, lazy = false, onOpen = null }) {
  const elementRef = useRef(null)
  const key = remote && host ? hostKey(host) : ''
  // An already-cached avatar paints immediately even when lazy — otherwise every
  // remount (tab switch) flashes initials before the observer fires.
  const cachedUrl = key ? (avatarCache.get(key)?.url || null) : null
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
    record.promise?.then(() => { if (active) setAvatarUrl(record.url) })
    return () => { active = false }
  }, [cacheKey])

  function handleImageError() {
    const record = avatarCache.get(cacheKey)
    if (record?.url === avatarUrl) {
      URL.revokeObjectURL(record.url)
      record.url = null
    }
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
        className={`${className} cn-avatar-btn`}
        style={{ background }}
        onClick={(event) => { event.stopPropagation(); onOpen() }}
        aria-label={`View ${name ? `@${name}` : 'member'} profile`}
        title={name ? `@${name}` : 'View profile'}
      >
        {inner}
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
  composing, setComposing, canInteract, participationIntent, intentState,
  participationBusy, onRetryIntent, onRequestParticipation,
  onCompleteParticipation, onPostConfirmed, emojiReactions = false, onThreadOpenChange,
}) {
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)
  const [pending, setPending] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [hiddenIds, setHiddenIds] = useState(() => new Set())
  const [selectedImages, setSelectedImages] = useState([])
  const [reactionOverrides, setReactionOverrides] = useState({})
  const [reactionPickerFor, setReactionPickerFor] = useState(null)
  const [previewPost, setPreviewPost] = useState(null)
  const [replyPost, setReplyPost] = useState(null)
  const [replies, setReplies] = useState([])
  const [replyState, setReplyState] = useState('idle')
  const [replyError, setReplyError] = useState('')
  const [replyDraft, setReplyDraft] = useState('')
  const [replySending, setReplySending] = useState(false)
  const [handoffBusy, setHandoffBusy] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [earlierError, setEarlierError] = useState('')
  const replyRequest = useRef(0)
  const replySendingRef = useRef(false)
  const lastActivityAt = useRef(Date.now())
  const restoreDeleteFocus = useRef(true)
  const fileRef = useRef(null)
  const composeRef = useModalFocus(composing, () => {
    if (!posting && !handoffBusy) setComposing(false)
  })
  const deleteRef = useModalFocus(
    Boolean(deleteTarget),
    () => setDeleteTarget(null),
    () => restoreDeleteFocus.current,
  )
  replySendingRef.current = replySending

  useEffect(() => {
    onThreadOpenChange?.(Boolean(replyPost))
    return () => onThreadOpenChange?.(false)
  }, [Boolean(replyPost), onThreadOpenChange])

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
    if (!before || loadingEarlier) return
    setLoadingEarlier(true)
    setEarlierError('')
    try {
      await onLoadEarlier(before)
    } catch {
      setEarlierError('Earlier posts couldn’t be loaded. The posts already here are unchanged.')
    } finally {
      setLoadingEarlier(false)
    }
  }

  function markActivity() {
    lastActivityAt.current = Date.now()
  }

  async function loadReplies(post, { background = false, force = false } = {}) {
    const request = ++replyRequest.current
    if (!force && Number(post.reply_count || 0) === 0) {
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
      const result = await cachedReplies(post.id, { force })
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

  function openReplies(post, restoredDraft = '') {
    if (replyPost?.id === post.id && !restoredDraft) {
      closeReplies()
      return
    }
    markActivity()
    setReactionPickerFor(null)
    setPreviewPost(null)
    const cached = replyCache.get(String(post.id))?.result
    setReplyPost(post)
    setReplies(cached?.replies || [])
    setReplyState(cached ? 'ready' : 'idle')
    setReplyDraft(restoredDraft)
    loadReplies(post, { background: Boolean(cached) })
  }

  function closeReplies() {
    replyRequest.current += 1
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
      if (replySendingRef.current) {
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
      .filter((post) => Number(post.reply_count || 0) > 0)
      .slice(0, REPLY_PREFETCH_LIMIT)
    const warm = async () => {
      for (const post of posts) {
        if (cancelled) return
        try { await cachedReplies(post.id) } catch { /* normal open path shows recovery */ }
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
      postId: replyPost?.id, text: replyDraft,
    })
    const text = replyDraft.trim()
    const post = replyPost
    if (!text || !post || replySending || handoffBusy) return
    if (!canInteract) {
      await continueParticipation('reply', { postId: post.id, text: replyDraft })
      return
    }

    const localId = `local-${Date.now()}`
    const optimistic = {
      id: localId,
      host: me?.host,
      handle: me?.handle,
      text,
      created_at: Date.now() / 1000,
      pending: true,
    }
    markActivity()
    replySendingRef.current = true
    setReplySending(true)
    setReplies((prior) => [...prior, optimistic])
    setReplyDraft('')
    try {
      await postReply(post.id, text)
      setReplies((prior) => prior.map((reply) => (
        reply.id === localId ? { ...reply, pending: false } : reply
      )))
      await loadReplies(post, { background: true, force: true })
      window.mobius?.signal?.('item_created', { type: 'board_reply' })
      onCompleteParticipation?.('reply', post.id, completedIntent)
      onRefresh(true)
    } catch (error) {
      setReplies((prior) => prior.filter((reply) => reply.id !== localId))
      setReplyDraft(text)
      showToast(error.status === 404
        ? 'Replies aren’t available on this server yet.'
        : error.message, 'error')
    } finally {
      replySendingRef.current = false
      setReplySending(false)
    }
  }

  async function toggleReaction(post, emoji) {
    markActivity()
    const { current, next } = optimisticReactionChange(
      post, reactionOverrides[post.id], emoji,
    )
    setReactionPickerFor(null)
    setReactionOverrides((prior) => ({ ...prior, [post.id]: next }))
    try {
      const result = await reactToPost(post.id, emoji)
      const confirmed = Object.fromEntries(BOARD_REACTION_EMOJIS.map((item) => [item, {
        count: Number(result.reaction_counts?.[item]
          ?? (item === '❤️' ? result.likes : 0) ?? 0),
        reacted: Array.isArray(result.reacted)
          ? result.reacted.includes(item)
          : item === '❤️' && Boolean(result.liked),
      }]))
      setReactionOverrides((prior) => ({
        ...prior, [post.id]: confirmed,
      }))
      const refreshed = await onRefresh(true)
      if (refreshed) {
        setReactionOverrides((prior) => {
          const nextOverrides = { ...prior }
          delete nextOverrides[post.id]
          return nextOverrides
        })
      }
      onCompleteParticipation?.('like', post.id)
    } catch (error) {
      setReactionOverrides((prior) => ({ ...prior, [post.id]: current }))
      showToast(error.message, 'error')
    }
  }

  async function continueParticipation(kind, values) {
    if (handoffBusy || participationBusy) return
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
        attachments: intent.attachments,
        thumbnails: intent.thumbnails,
        emoji: intent.emoji,
      })
      return
    }
    if (intent.kind === 'post') {
      setDraft(intent.text || '')
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
      openReplies(post, intent.text || '')
      return
    }
    setReactionPickerFor(post.id)
    const button = document.getElementById(`cn-react-${post.id}`)
    button?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    button?.focus?.()
  }

  async function doDelete() {
    const post = deleteTarget
    if (!post) return
    // The trigger is about to disappear. Do not restore focus to it: browsers
    // may scroll the feed to a focused node just before React removes it.
    restoreDeleteFocus.current = false
    // Remove it from view in the same commit as the dialog; restore it only if
    // the server rejects the deletion.
    setHiddenIds((prior) => new Set(prior).add(post.id))
    setDeleteTarget(null)
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
    showToast('Post deleted', 'success')
    onRefresh(true)
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
    if (additions.length) setSelectedImages(prior => [...prior, ...additions])
  }

  function removeImage(index) {
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
  async function collectImagePayloads(images) {
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
    return payloads.length === 1
      ? { attachment: payloads[0], attachments: undefined, thumbnails, previews }
      : { attachment: undefined, attachments: payloads, thumbnails, previews }
  }

  async function publish() {
    const text = draft.trim()
    const images = selectedImages
    if (!text && !images.length) return
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
      ({ attachment, attachments, thumbnails, previews } = await collectImagePayloads(images))
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
      const receipt = await publishPost(text, attachment, attachments, thumbnails)
      onPostConfirmed?.({
        id: receipt.id,
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
      onCompleteParticipation?.('post', null, completedIntent)
      // Release the local previews now that the post succeeded (on failure we
      // restore them for a retry, so only revoke on the happy path).
      for (const image of images) {
        if (image.file && image.previewUrl?.startsWith('blob:')) {
          URL.revokeObjectURL(image.previewUrl)
        }
      }
      showToast('Posted to the board', 'success')
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

  async function submitPost() {
    if (canInteract) return publish()
    // Not joined yet: compress now, then save the draft to resume after joining.
    setPosting(true)
    let payloads
    try {
      payloads = await collectImagePayloads(selectedImages)
    } catch (error) {
      setPosting(false)
      showToast(error.message || 'An image couldn’t be prepared.', 'error')
      return
    }
    setPosting(false)
    await continueParticipation('post', {
      text: draft,
      attachment: payloads.attachment,
      attachments: payloads.attachments,
      thumbnails: payloads.thumbnails,
    })
  }

  return (
    <div className={`cn-content cn-screen${composing ? ' has-dialog' : ''}`}>
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
        <section className="cn-intent-notice" aria-label="Pending board action">
          <div>
            <strong>{participationIntent.kind === 'post'
              ? 'Your post draft is saved'
              : participationIntent.kind === 'reply'
                ? 'Your reply draft is saved'
                : 'Your reaction is waiting'}</strong>
            <span>{canInteract
              ? 'Nothing was shared automatically. Review the action when you’re ready.'
              : 'Nothing was shared. Continue with your account when you’re ready.'}</span>
          </div>
          <button className="cn-btn cn-btn-secondary" onClick={resumeParticipation}
                  disabled={handoffBusy || participationBusy}>
            {handoffBusy || participationBusy
              ? 'Please wait…'
              : participationActionLabel(participationStep(me), participationIntent.kind)}
          </button>
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
          <div className="cn-empty-title">The board is unreachable</div>
          <p className="cn-empty-text">Your community host couldn’t be reached right now.</p>
          <button className="cn-btn cn-btn-secondary" onClick={() => onRefresh()}>Try again</button>
        </div>
      )}
      {feedState === 'ready' && feed.length === 0 && !pending && (
        <div className="cn-empty">
          <div className="cn-empty-mark" aria-hidden="true"><Chat /></div>
          <div className="cn-empty-title">Your board is quiet</div>
          <p className="cn-empty-text">
            Posts from everyone on your community appear here. Share Social
            with friends so their servers can join yours.
          </p>
        </div>
      )}
      <div className="cn-feed">
        {pending && (
          <article className="cn-post is-pending" aria-label="Posting">
            <div className="cn-post-head">
              <Avatar name={pending.handle} host={pending.host} remote />
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
                      <img src={image.url} alt={`Post photo ${index + 1}`} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </article>
        )}
        {feed.filter((post) => !hiddenIds.has(post.id)).map((post) => {
          const reactions = reactionState(post, reactionOverrides[post.id])
          const visibleReactions = BOARD_REACTION_EMOJIS.filter((emoji) => (
            reactions[emoji].count > 0 || reactions[emoji].reacted
          ))
          const replyCount = countFor(post)
          const threadOpen = replyPost?.id === post.id
          const togglePreview = () => setPreviewPost(
            previewPost?.id === post.id ? null : { id: post.id, host: post.host },
          )
          return (
            <article className={`cn-post${threadOpen ? ' has-thread' : ''}${me?.host && post.host === me.host ? ' is-mine' : ''}`} key={post.id}
                     onClick={(event) => {
                       if (!event.target.closest('button, input, textarea, a')) openReplies(post)
                     }}>
              <div className="cn-post-head">
                <Avatar name={post.handle} host={post.host} remote lazy onOpen={togglePreview} />
                <button className="cn-person" onClick={togglePreview}>
                  <span className="cn-person-name">{post.handle ? `@${post.handle}` : 'Social member'}</span>
                  <span className="cn-post-dot" aria-hidden="true">·</span>
                  <span className="cn-meta">{postDateTime(post.created_at)}</span>
                </button>
                {me?.host && post.host === me.host && (
                  <button
                    className="cn-post-delete"
                    onClick={() => { restoreDeleteFocus.current = true; setDeleteTarget(post) }}
                    aria-label="Delete post"
                    title="Delete post"
                  >
                    <Trash aria-hidden="true" />
                  </button>
                )}
              </div>
              <div className="cn-post-body">
                {previewPost?.id === post.id && (
                  <ProfilePreview host={post.host} seed={{ host: post.host, handle: post.handle }}
                                  onClose={() => setPreviewPost(null)}
                                  onViewProfile={onOpenPerson} onMessage={onMessageUser}
                                  canMessage={canInteract && post.host !== me?.host} />
                )}
                {post.text && <RichText text={post.text} className="cn-post-copy" preview />}
                <BoardImage
                  post={post}
                  onOpen={onOpenImage}
                  onUnavailable={(error) => showToast(
                    error?.status === 404
                      ? 'Board photos aren’t available on this server yet.'
                      : 'This photo couldn’t be loaded.',
                    'error',
                  )}
                />
                <div className="cn-post-actions">
                {replyCount > 0 && (
                  <button
                    className={`cn-react cn-reply-summary${threadOpen ? ' is-active' : ''}`}
                    onClick={() => openReplies(post)}
                    aria-expanded={threadOpen}
                    aria-controls={`cn-thread-${post.id}`}
                    aria-label={`${threadOpen ? 'Hide' : 'Show'} ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`}
                  >
                  {Array.isArray(post.reply_authors) && post.reply_authors.length > 0 && (
                    <span className="cn-reply-avatars" aria-hidden="true">
                      {post.reply_authors.map((author) => (
                        <Avatar key={author.host} name={author.handle} host={author.host} size="micro" remote lazy />
                      ))}
                    </span>
                  )}
                  <span>{replyCount} {replyCount === 1 ? 'reply' : 'replies'}</span>
                  </button>
                )}
                <div className="cn-reactions" aria-label="Post reactions">
                  {visibleReactions.map((emoji) => (
                    <button key={emoji} id={!emojiReactions && emoji === '❤️' ? `cn-react-${post.id}` : undefined}
                            className={`cn-reaction-chip${reactions[emoji].reacted ? ' is-reacted' : ''}`}
                            onClick={() => canInteract
                              ? toggleReaction(post, emoji)
                              : continueParticipation('like', { postId: post.id, emoji })}
                            disabled={handoffBusy || participationBusy}
                            aria-label={`${reactions[emoji].reacted ? 'Remove' : 'Add'} ${emoji} reaction`}>
                      <FlatEmoji emoji={emoji} />
                      {reactions[emoji].count > 0 && <b>{reactions[emoji].count}</b>}
                    </button>
                  ))}
                  {(emojiReactions || visibleReactions.length === 0) && (
                  <button id={`cn-react-${post.id}`} className="cn-react cn-add-reaction"
                          onClick={() => emojiReactions
                            ? setReactionPickerFor(reactionPickerFor === post.id ? null : post.id)
                            : (canInteract
                              ? toggleReaction(post, '❤️')
                              : continueParticipation('like', { postId: post.id, emoji: '❤️' }))}
                          disabled={handoffBusy || participationBusy}
                          aria-expanded={emojiReactions ? reactionPickerFor === post.id : undefined}
                          aria-label={emojiReactions ? 'Add reaction' : 'Like'}>
                    {emojiReactions ? <EmojiAdd aria-hidden="true" /> : <Heart aria-hidden="true" />}
                  </button>
                  )}
                  {emojiReactions && reactionPickerFor === post.id && (
                    <div className="cn-reaction-picker" role="group" aria-label="Choose a reaction">
                      <span className="cn-reaction-picker-title">Choose a reaction</span>
                      <div className="cn-reaction-grid">
                        {BOARD_REACTION_EMOJIS.map((emoji) => (
                          <button key={emoji} type="button"
                                  className={reactions[emoji].reacted ? 'is-reacted' : ''}
                                  onClick={() => canInteract
                                    ? toggleReaction(post, emoji)
                                    : continueParticipation('like', { postId: post.id, emoji })}
                                  aria-label={`React ${emoji}`}><FlatEmoji emoji={emoji} /></button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                </div>
                {threadOpen && (
                  <section className="cn-inline-thread" id={`cn-thread-${post.id}`}
                           aria-label="Replies" onClick={(event) => event.stopPropagation()}>
                    <div className="cn-inline-thread-head">
                      <strong>{replyCount === 0 ? 'Start the conversation' : `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`}</strong>
                      <button type="button" onClick={closeReplies}>Hide</button>
                    </div>
                    <div className="cn-inline-replies" aria-live="polite">
                      {replyState === 'loading' && <div className="cn-thread-loading" role="status">Loading replies…</div>}
                      {replyState === 'error' && (
                        <div className="cn-thread-loading">
                          <span>{replyError}</span>
                          <button className="cn-btn cn-btn-secondary" onClick={() => loadReplies(post)}>Try again</button>
                        </div>
                      )}
                      {replyState === 'ready' && replies.length === 0 && (
                        <p className="cn-reply-empty">No replies yet.</p>
                      )}
                      {replies.map((reply) => (
                        <article className={`cn-reply-row${reply.pending ? ' is-pending' : ''}`} key={reply.id}>
                          <Avatar name={reply.handle} host={reply.host} size="small" remote />
                          <div className="cn-reply-copy">
                            <div className="cn-reply-meta">
                              <strong>{reply.handle ? `@${reply.handle}` : 'Social member'}</strong>
                              <span className="cn-time">{reply.pending ? 'Sending…' : timeAgo(reply.created_at)}</span>
                            </div>
                            <RichText text={reply.text} />
                          </div>
                        </article>
                      ))}
                    </div>
                    <form className={`cn-reply-composer${canInteract ? '' : ' is-gated'}`} onSubmit={sendReply}>
                      <input value={replyDraft} onChange={(event) => setReplyDraft(event.target.value)}
                             placeholder="Post your reply" aria-label="Post your reply" autoComplete="off"
                             maxLength={1000} disabled={replySending || handoffBusy || participationBusy} />
                      <button className={canInteract ? 'cn-reply-send' : 'cn-btn cn-btn-primary cn-reply-account'}
                              type="submit" disabled={replySending || handoffBusy || participationBusy || !replyDraft.trim()}
                              aria-label={canInteract ? 'Send reply' : undefined}>
                        {canInteract ? <ArrowUp aria-hidden="true" /> : participationActionLabel(participationStep(me), 'reply')}
                      </button>
                    </form>
                  </section>
                )}
              </div>
            </article>
          )
        })}
      </div>
      {feedState === 'ready' && hasEarlier && (
        <button className="cn-history-more" type="button" disabled={loadingEarlier}
                onClick={loadEarlierPosts}>
          {loadingEarlier ? 'Loading earlier posts…' : 'Load earlier posts'}
        </button>
      )}
      {earlierError && <p className="cn-inline-error" role="status">{earlierError}</p>}


      {composing && (
        <div className="cn-scrim" role="dialog" aria-modal="true" aria-label="New post"
             onClick={posting || handoffBusy ? null : () => setComposing(false)}>
          <div ref={composeRef} tabIndex={-1} className="cn-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="cn-grabber" aria-hidden="true" />
            <h3 className="cn-sheet-title">New post</h3>
            <p className="cn-sheet-body">{canInteract
              ? 'Posting to everyone on your community board.'
              : participationStep(me) === 'join'
                ? 'Joining shares your handle and profile picture. You’ll still review this post before sharing it.'
                : 'Write now, then continue in Möbius · You. Nothing will be posted automatically.'}</p>
            <div className="cn-post-compose">
              <Avatar name={me?.handle} host={me?.host} size="small" remote />
              <textarea
                className="cn-textarea"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="What’s happening?"
                aria-label="Post text"
                maxLength={4000}
              />
            </div>
            <SelectedImagesStrip selected={selectedImages} onRemove={removeImage} />
            <input ref={fileRef} className="cn-file-input" type="file" accept="image/*" multiple
                   onChange={chooseImage} tabIndex={-1} aria-hidden="true" />
            <div className="cn-post-sheet-actions">
              <button className="cn-compose-image" type="button" onClick={() => fileRef.current?.click()}
                      disabled={posting || selectedImages.length >= MAX_POST_IMAGES}
                      aria-label="Attach photo"
                      title={selectedImages.length >= MAX_POST_IMAGES ? `Up to ${MAX_POST_IMAGES} images` : 'Attach photo'}>
                <ImageSquare aria-hidden="true" />
              </button>
              <button className="cn-btn cn-btn-secondary" onClick={() => setComposing(false)} disabled={posting || handoffBusy}>
                Cancel
              </button>
              <button className="cn-btn cn-btn-primary" onClick={submitPost}
                      disabled={posting || handoffBusy || participationBusy || (!draft.trim() && !selectedImages.length)}>
                {posting ? 'Posting…' : handoffBusy || participationBusy
                  ? 'Please wait…'
                  : canInteract ? 'Post' : participationActionLabel(participationStep(me), 'post')}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="cn-scrim" role="dialog" aria-modal="true" aria-label="Delete post"
             onClick={() => setDeleteTarget(null)}>
          <div ref={deleteRef} tabIndex={-1} className="cn-sheet cn-confirm-sheet"
               onClick={(e) => e.stopPropagation()}>
            <div className="cn-grabber" aria-hidden="true" />
            <h3 className="cn-sheet-title">Delete this post?</h3>
            <p className="cn-sheet-body">
              This removes your post from the community board for everyone. This
              can’t be undone.
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
