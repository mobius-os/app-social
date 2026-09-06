import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp, Chat, Heart, HeartFilled, ImageSquare, Plus,
} from '@openai/apps-sdk-ui/components/Icon'
import {
  avatarHue, getPeerAvatar, getReplies, initials, likePost, postReply,
  publishPost, timeAgo,
} from '../api.js'
import {
  boardRefreshDelay, optimisticLikeChange, reconcileReplies, threadRefreshDelay,
} from '../reconciliation.js'
import { useModalFocus } from './modalFocus.js'
import { LANDING_DATA_URL } from './landingImage.js'
import { BoardImage, prepareImage, SelectedImageStrip } from './Media.jsx'

const avatarCache = new Map()

function cachedAvatar(host) {
  const key = String(host)
  let record = avatarCache.get(key)
  if (record) return record

  record = { url: null, promise: null }
  record.promise = getPeerAvatar(key)
    .then((blob) => {
      if (!blob?.size) return
      record.url = URL.createObjectURL(blob)
    })
    .catch(() => {})
  avatarCache.set(key, record)
  return record
}

function Avatar({ name, host, size }) {
  const hue = avatarHue(host)
  const cacheKey = host ? String(host) : ''
  const [avatarUrl, setAvatarUrl] = useState(() => avatarCache.get(cacheKey)?.url || null)

  useEffect(() => {
    let active = true
    if (!cacheKey) {
      setAvatarUrl(null)
      return () => { active = false }
    }
    const record = cachedAvatar(cacheKey)
    setAvatarUrl(record.url)
    record.promise.then(() => { if (active) setAvatarUrl(record.url) })
    return () => { active = false }
  }, [cacheKey])

  function useFallback() {
    const record = avatarCache.get(cacheKey)
    if (record?.url === avatarUrl) {
      URL.revokeObjectURL(record.url)
      record.url = null
    }
    setAvatarUrl(null)
  }

  return (
    <span
      className={`cn-avatar${size ? ` is-${size}` : ''}${avatarUrl ? ' has-image' : ''}`}
      style={{ background: `linear-gradient(150deg, hsl(${hue} 62% 58%), hsl(${(hue + 24) % 360} 55% 38%))` }}
      aria-hidden="true"
    >
      {avatarUrl
        ? <img className="cn-avatar-image" src={avatarUrl} alt="" draggable="false" onError={useFallback} />
        : initials(name, host)}
    </span>
  )
}

export { Avatar }

export default function Board({
  me, feed, feedState, onRefresh, onOpenPerson, showToast, onOpenImage,
  composing, setComposing, canInteract,
}) {
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)
  const [processingImage, setProcessingImage] = useState(false)
  const [selectedImage, setSelectedImage] = useState(null)
  const [likeOverrides, setLikeOverrides] = useState({})
  const [replyPost, setReplyPost] = useState(null)
  const [replies, setReplies] = useState([])
  const [replyState, setReplyState] = useState('idle')
  const [replyError, setReplyError] = useState('')
  const [replyDraft, setReplyDraft] = useState('')
  const [replySending, setReplySending] = useState(false)
  const replyRequest = useRef(0)
  const replySendingRef = useRef(false)
  const lastActivityAt = useRef(Date.now())
  const fileRef = useRef(null)
  const composeRef = useModalFocus(composing && canInteract, () => { if (!posting) setComposing(false) })
  const repliesRef = useModalFocus(Boolean(replyPost), () => { if (!replySending) closeReplies() })
  replySendingRef.current = replySending

  function countFor(post) {
    const count = Number(
      replyPost?.id === post.id && replyState === 'ready'
        ? replies.length
        : post.reply_count ?? 0,
    )
    return Number.isFinite(count) ? count : 0
  }

  function markActivity() {
    lastActivityAt.current = Date.now()
  }

  async function loadReplies(post, { background = false } = {}) {
    const request = ++replyRequest.current
    if (!background) {
      setReplyState('loading')
      setReplyError('')
    }
    try {
      const result = await getReplies(post.id)
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

  function openReplies(post) {
    markActivity()
    setReplyPost(post)
    setReplies([])
    setReplyDraft('')
    loadReplies(post)
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

  async function sendReply(event) {
    event.preventDefault()
    const text = replyDraft.trim()
    const post = replyPost
    if (!text || !post || replySending) return

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
      await loadReplies(post, { background: true })
      window.mobius?.signal?.('item_created', { type: 'board_reply' })
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

  async function toggleLike(post) {
    markActivity()
    const { current, next } = optimisticLikeChange(post, likeOverrides[post.id])
    setLikeOverrides((prior) => ({ ...prior, [post.id]: next }))
    try {
      const result = await likePost(post.id)
      setLikeOverrides((prior) => ({
        ...prior, [post.id]: { liked: result.liked, count: result.likes },
      }))
      const refreshed = await onRefresh(true)
      if (refreshed) {
        setLikeOverrides((prior) => {
          const nextOverrides = { ...prior }
          delete nextOverrides[post.id]
          return nextOverrides
        })
      }
    } catch (error) {
      setLikeOverrides((prior) => ({ ...prior, [post.id]: current }))
      showToast(error.message, 'error')
    }
  }

  async function chooseImage(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setProcessingImage(true)
    try {
      setSelectedImage(await prepareImage(file))
    } catch (error) {
      showToast(error.message, 'error')
    } finally {
      setProcessingImage(false)
    }
  }

  async function publish() {
    const text = draft.trim()
    const image = selectedImage
    if (!text && !image) return
    markActivity()
    setPosting(true)
    try {
      await publishPost(text, image?.payload)
      window.mobius?.signal?.('item_created', { type: 'board_post' })
      setDraft('')
      setSelectedImage(null)
      setComposing(false)
      showToast('Posted to the board', 'success')
      onRefresh(true)
    } catch (error) {
      window.mobius?.signal?.('error', { message: error.message, source: 'publish' })
      showToast(
        (error.status === 400 || error.status === 404) && image
          ? 'Photo posts aren’t available on this server yet.'
          : error.message,
        'error',
      )
    } finally {
      setPosting(false)
    }
  }

  return (
    <div className={`cn-content cn-screen${composing || replyPost ? ' has-dialog' : ''}`}>


      {feedState === 'loading' && <div className="cn-center"><div className="cn-spinner" /></div>}
      {feedState === 'error' && (
        <div className="cn-empty">
          <div className="cn-empty-title">The board is unreachable</div>
          <p className="cn-empty-text">Your community host couldn’t be reached right now.</p>
          <button className="cn-btn cn-btn-secondary" onClick={() => onRefresh()}>Try again</button>
        </div>
      )}
      {feedState === 'ready' && feed.length === 0 && (
        <div className="cn-empty">
          {LANDING_DATA_URL
            ? <img className="cn-landing" style={{ maxWidth: 180, opacity: 0.9 }} src={LANDING_DATA_URL} alt="" />
            : <div className="cn-empty-mark" aria-hidden="true"><Chat /></div>}
          <div className="cn-empty-title">Your board is quiet</div>
          <p className="cn-empty-text">
            Posts from everyone on your community appear here. Share Social
            with friends so their servers can join yours.
          </p>
        </div>
      )}
      <div className="cn-feed">
        {feed.map((post) => {
          const like = likeOverrides[post.id] || {
            liked: !!post.liked, count: post.like_count || 0,
          }
          const replyCount = countFor(post)
          return (
            <article className="cn-post" key={post.id}>
              <div className="cn-post-head">
                <Avatar name={post.handle} host={post.host} />
                <button className="cn-person" onClick={() => onOpenPerson(post.host)}>
                  <span>
                    <span className="cn-person-name">{post.handle ? `@${post.handle}` : 'Social member'}</span>
                    <span className="cn-meta" style={{ display: 'block' }}>
                      {timeAgo(post.created_at)}
                    </span>
                  </span>
                </button>
              </div>
              {post.text && <p className="cn-post-copy">{post.text}</p>}
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
                <button
                  className={`cn-react${like.liked ? ' is-liked' : ''}`}
                  onClick={() => toggleLike(post)}
                  disabled={!canInteract}
                  aria-label={canInteract ? (like.liked ? 'Unlike' : 'Like') : 'Join Social to like'}
                >
                  {like.liked ? <HeartFilled aria-hidden="true" /> : <Heart aria-hidden="true" />}
                  {like.count > 0 && <span>{like.count}</span>}
                </button>
                <button
                  className="cn-react"
                  onClick={() => openReplies(post)}
                  aria-label={`View ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`}
                >
                  <Chat aria-hidden="true" />
                  <span>{replyCount}</span>
                </button>
              </div>
            </article>
          )
        })}
      </div>


      {composing && canInteract && (
        <div className="cn-scrim" role="dialog" aria-modal="true" aria-label="New post"
             onClick={posting ? null : () => setComposing(false)}>
          <div ref={composeRef} tabIndex={-1} className="cn-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="cn-grabber" aria-hidden="true" />
            <h3 className="cn-sheet-title">New post</h3>
            <p className="cn-sheet-body">Posting to everyone on your community board.</p>
            <SelectedImageStrip selected={selectedImage} onRemove={() => setSelectedImage(null)} />
            <div className="cn-post-compose">
              <textarea
                className="cn-textarea"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="What would you like to share?"
                aria-label="Post text"
              />
              <input ref={fileRef} className="cn-file-input" type="file" accept="image/*"
                     onChange={chooseImage} tabIndex={-1} aria-hidden="true" />
              <button className="cn-compose-image" type="button" onClick={() => fileRef.current?.click()}
                      disabled={posting || processingImage} aria-label="Attach photo">
                {processingImage ? <span className="cn-spinner" /> : <ImageSquare aria-hidden="true" />}
              </button>
            </div>
            <div className="cn-post-sheet-actions">
              <button className="cn-btn cn-btn-secondary" onClick={() => setComposing(false)} disabled={posting}>
                Cancel
              </button>
              <button className="cn-btn cn-btn-primary" onClick={publish}
                      disabled={posting || processingImage || (!draft.trim() && !selectedImage)}>
                {posting ? 'Posting…' : 'Post'}
              </button>
            </div>
          </div>
        </div>
      )}

      {replyPost && (
        <div className="cn-scrim" role="dialog" aria-modal="true" aria-label="Conversation on post"
             onClick={replySending ? null : closeReplies}>
          <div ref={repliesRef} tabIndex={-1} className="cn-sheet cn-reply-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="cn-grabber" aria-hidden="true" />
            <div className="cn-reply-sheet-head">
              <div>
                <h3 className="cn-sheet-title">Conversation</h3>
                <p className="cn-sheet-body">
                  {countFor(replyPost)} {countFor(replyPost) === 1 ? 'reply' : 'replies'} to this post
                </p>
              </div>
              <button className="cn-btn cn-btn-ghost" onClick={closeReplies} disabled={replySending}>
                Close
              </button>
            </div>

            <article className="cn-reply-parent" aria-label="Original post">
              <div className="cn-post-head">
                <Avatar name={replyPost.handle} host={replyPost.host} size="small" />
                <button className="cn-person" onClick={() => onOpenPerson(replyPost.host)}>
                  <span>
                    <span className="cn-person-name">
                      {replyPost.handle ? `@${replyPost.handle}` : 'Social member'}
                    </span>
                    <span className="cn-meta" style={{ display: 'block' }}>
                      {timeAgo(replyPost.created_at)}
                    </span>
                  </span>
                </button>
              </div>
              {replyPost.text && <p className="cn-post-copy">{replyPost.text}</p>}
              <BoardImage
                post={replyPost}
                onOpen={onOpenImage}
                onUnavailable={() => {}}
              />
            </article>

            <div className="cn-reply-list" aria-live="polite">
              {replyState === 'loading' && <div className="cn-center"><div className="cn-spinner" /></div>}
              {replyState === 'error' && (
                <div className="cn-reply-empty">
                  <p>{replyError}</p>
                  <button className="cn-btn cn-btn-secondary" onClick={() => loadReplies(replyPost)}>
                    Try again
                  </button>
                </div>
              )}
              {replyState === 'ready' && replies.length === 0 && (
                <p className="cn-reply-empty">No replies yet — start the conversation.</p>
              )}
              {replies.map((reply) => (
                <article className={`cn-reply-row${reply.pending ? ' is-pending' : ''}`} key={reply.id}>
                  <Avatar name={reply.handle} host={reply.host} size="small" />
                  <div className="cn-reply-copy">
                    <div className="cn-reply-meta">
                      <strong>{reply.handle ? `@${reply.handle}` : 'Social member'}</strong>
                      <span className="cn-time">{reply.pending ? 'Sending…' : timeAgo(reply.created_at)}</span>
                    </div>
                    <p>{reply.text}</p>
                  </div>
                </article>
              ))}
            </div>

            {canInteract ? (
              <form className="cn-reply-composer" onSubmit={sendReply}>
                <input
                  value={replyDraft}
                  onChange={(e) => setReplyDraft(e.target.value)}
                  placeholder="Write a reply"
                  aria-label="Write a reply"
                  autoComplete="off"
                  disabled={replySending}
                />
                <button className="cn-reply-send" type="submit"
                        disabled={replySending || !replyDraft.trim()}
                        aria-label="Send reply">
                  <ArrowUp aria-hidden="true" />
                </button>
              </form>
            ) : (
              <p className="cn-reply-gate">Join Social to reply to this conversation.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
