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
import {
  createParticipationIntent, participationActionLabel, participationStep,
} from '../participation.js'

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
  composing, setComposing, canInteract, participationIntent, intentState,
  participationBusy, onRetryIntent, onRequestParticipation,
  onCompleteParticipation,
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
  const [handoffBusy, setHandoffBusy] = useState(false)
  const replyRequest = useRef(0)
  const replySendingRef = useRef(false)
  const lastActivityAt = useRef(Date.now())
  const fileRef = useRef(null)
  const composeRef = useModalFocus(composing, () => {
    if (!posting && !handoffBusy) setComposing(false)
  })
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

  function openReplies(post, restoredDraft = '') {
    markActivity()
    setReplyPost(post)
    setReplies([])
    setReplyDraft(restoredDraft)
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
      await loadReplies(post, { background: true })
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
      onCompleteParticipation?.('like', post.id)
    } catch (error) {
      setLikeOverrides((prior) => ({ ...prior, [post.id]: current }))
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
      })
      return
    }
    if (intent.kind === 'post') {
      setDraft(intent.text || '')
      setSelectedImage(intent.attachment ? {
        payload: intent.attachment,
        previewUrl: `data:${intent.attachment.mime};base64,${intent.attachment.data_b64}`,
      } : null)
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
    const button = document.getElementById(`cn-like-${post.id}`)
    button?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    button?.focus?.()
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
    const completedIntent = createParticipationIntent('post', {
      text: draft, attachment: selectedImage?.payload,
    })
    const text = draft.trim()
    const image = selectedImage
    if (!text && !image) return
    markActivity()
    setPosting(true)
    try {
      await publishPost(text, image?.payload)
      window.mobius?.signal?.('item_created', { type: 'board_post' })
      onCompleteParticipation?.('post', null, completedIntent)
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
        <div className="cn-center" role="status" aria-label="Loading the board">
          <div className="cn-spinner" aria-hidden="true" />
        </div>
      )}
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
                  id={`cn-like-${post.id}`}
                  className={`cn-react${like.liked ? ' is-liked' : ''}`}
                  onClick={() => canInteract
                    ? toggleLike(post)
                    : continueParticipation('like', { postId: post.id })}
                  disabled={handoffBusy || participationBusy}
                  aria-label={canInteract
                    ? (like.liked ? 'Unlike' : 'Like')
                    : participationActionLabel(participationStep(me), 'like')}
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
            <SelectedImageStrip selected={selectedImage} onRemove={() => setSelectedImage(null)} />
            <div className="cn-post-compose">
              <textarea
                className="cn-textarea"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="What would you like to share?"
                aria-label="Post text"
                maxLength={4000}
              />
              <input ref={fileRef} className="cn-file-input" type="file" accept="image/*"
                     onChange={chooseImage} tabIndex={-1} aria-hidden="true" />
              <button className="cn-compose-image" type="button" onClick={() => fileRef.current?.click()}
                      disabled={posting || processingImage} aria-label="Attach photo">
                {processingImage ? <span className="cn-spinner" /> : <ImageSquare aria-hidden="true" />}
              </button>
            </div>
            <div className="cn-post-sheet-actions">
              <button className="cn-btn cn-btn-secondary" onClick={() => setComposing(false)} disabled={posting || handoffBusy}>
                Cancel
              </button>
              <button className="cn-btn cn-btn-primary" onClick={() => canInteract
                        ? publish()
                        : continueParticipation('post', {
                          text: draft, attachment: selectedImage?.payload,
                        })}
                      disabled={posting || handoffBusy || participationBusy || processingImage || (!draft.trim() && !selectedImage)}>
                {posting ? 'Posting…' : handoffBusy || participationBusy
                  ? 'Please wait…'
                  : canInteract ? 'Post' : participationActionLabel(participationStep(me), 'post')}
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
              {replyState === 'loading' && (
                <div className="cn-center" role="status" aria-label="Loading replies">
                  <div className="cn-spinner" aria-hidden="true" />
                </div>
              )}
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

            <form className={`cn-reply-composer${canInteract ? '' : ' is-gated'}`} onSubmit={sendReply}>
              <input
                value={replyDraft}
                onChange={(e) => setReplyDraft(e.target.value)}
                placeholder="Write a reply"
                aria-label="Write a reply"
                autoComplete="off"
                maxLength={1000}
                disabled={replySending || handoffBusy || participationBusy}
              />
              {canInteract ? (
                <button className="cn-reply-send" type="submit"
                        disabled={replySending || !replyDraft.trim()}
                        aria-label="Send reply">
                  <ArrowUp aria-hidden="true" />
                </button>
              ) : (
                <button className="cn-btn cn-btn-primary cn-reply-account" type="submit"
                        disabled={handoffBusy || participationBusy || !replyDraft.trim()}>
                  {handoffBusy || participationBusy
                    ? 'Please wait…'
                    : participationActionLabel(participationStep(me), 'reply')}
                </button>
              )}
              {!canInteract && (
                <span className="cn-reply-gate">Your draft stays here. Nothing is sent automatically.</span>
              )}
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
