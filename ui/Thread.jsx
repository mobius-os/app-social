import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft, ArrowUp, Check, Clock, ImageSquare, Lock, Warning,
} from '@openai/apps-sdk-ui/components/Icon'
import {
  acceptMessageRequest, blockMessageRequest, clearUnread, clockTime,
  declineMessageRequest, getPeer, listMessages, retryMessage, sendMessage,
} from '../api.js'
import { Avatar } from './Board.jsx'
import MessageBubble, { ReplyTarget, replyTargetFor } from './MessageBubble.jsx'
import { prepareImage, SelectedImageStrip } from './Media.jsx'
import {
  isDefinitePrecommitRejection, reconcileLatestPage, reconcileOlderPage,
  settleMessage,
} from '../message_ui_state.js'

export default function Thread({
  peer, peerHandle, me, version, request, onBack, showToast, onOpenImage,
}) {
  const [messages, setMessages] = useState(null)
  const [nextCursor, setNextCursor] = useState(null)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [retrying, setRetrying] = useState('')
  const [processingImage, setProcessingImage] = useState(false)
  const [selectedImage, setSelectedImage] = useState(null)
  const [replyTarget, setReplyTarget] = useState(null)
  const [peerActor, setPeerActor] = useState(null)
  const [requestPending, setRequestPending] = useState(Boolean(request))
  const [requestBusy, setRequestBusy] = useState('')
  const [requestError, setRequestError] = useState('')
  const scrollRef = useRef(null)
  const messagesRef = useRef(null)
  const refreshRequest = useRef(0)
  const paginationGeneration = useRef(0)
  const seenVersion = useRef(version)
  const stickToBottom = useRef(true)
  const inputRef = useRef(null)
  const fileRef = useRef(null)

  function updateMessages(next) {
    const value = typeof next === 'function' ? next(messagesRef.current) : next
    messagesRef.current = value
    setMessages(value)
  }

  async function refresh({ replace = false } = {}) {
    const request = ++refreshRequest.current
    try {
      const page = await listMessages(peer)
      if (request !== refreshRequest.current) return false
      const reconciled = reconcileLatestPage(messagesRef.current, page, { replace })
      updateMessages(reconciled.messages)
      if (reconciled.resetCursor) {
        paginationGeneration.current += 1
        setNextCursor(reconciled.nextCursor)
      }
      setLoadError('')
      return true
    } catch {
      if (request === refreshRequest.current) {
        setLoadError('Messages couldn’t be refreshed. Your saved history hasn’t been removed.')
      }
      return false
    }
  }

  useEffect(() => {
    seenVersion.current = version
    paginationGeneration.current += 1
    updateMessages(null)
    setNextCursor(null)
    refresh({ replace: true })
    if (!requestPending) clearUnread(peer).catch(() => {})
    return () => { refreshRequest.current += 1 }
  }, [peer])

  useEffect(() => {
    let active = true
    setPeerActor(null)
    if (requestPending) return () => { active = false }
    getPeer(peer)
      .then((actor) => { if (active) setPeerActor(actor) })
      .catch(() => {})
    return () => { active = false }
  }, [peer, requestPending])

  useEffect(() => {
    if (version > 0 && version !== seenVersion.current) {
      seenVersion.current = version
      refresh()
      if (!requestPending) clearUnread(peer).catch(() => {})
    }
  }, [version])

  async function loadEarlier() {
    if (!nextCursor || loadingEarlier) return
    const el = scrollRef.current
    const previousHeight = el?.scrollHeight || 0
    stickToBottom.current = false
    setLoadingEarlier(true)
    const generation = paginationGeneration.current
    try {
      const page = await listMessages(peer, nextCursor)
      const reconciled = reconcileOlderPage(
        messagesRef.current, page, generation, paginationGeneration.current,
      )
      if (!reconciled) return
      updateMessages(reconciled.messages)
      setNextCursor(reconciled.nextCursor)
      setLoadError('')
      requestAnimationFrame(() => {
        if (el) el.scrollTop += el.scrollHeight - previousHeight
      })
    } catch {
      if (generation === paginationGeneration.current) {
        setLoadError('Earlier messages couldn’t be loaded. Your saved history hasn’t been removed.')
      }
    } finally {
      setLoadingEarlier(false)
    }
  }

  async function decideRequest(action) {
    if (requestBusy) return
    setRequestBusy(action)
    setRequestError('')
    try {
      if (action === 'accept') {
        await acceptMessageRequest(peer)
        setRequestPending(false)
        await refresh()
        showToast('Message request accepted', 'success')
      } else if (action === 'decline') {
        await declineMessageRequest(peer)
        onBack()
      } else {
        await blockMessageRequest(peer)
        onBack()
      }
    } catch (error) {
      setRequestError(error.message || 'This request couldn’t be updated. Try again.')
    } finally {
      setRequestBusy('')
    }
  }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (requestPending) el.scrollTop = 0
    else if (stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [messages?.length, selectedImage, replyTarget, requestPending])

  function trackScroll() {
    const el = scrollRef.current
    if (!el || requestPending) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 72
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
      inputRef.current?.focus()
    }
  }

  async function send(event) {
    event.preventDefault()
    const text = draft.trim()
    const image = selectedImage
    const reply = replyTarget
    if ((!text && !image) || sending || processingImage) return

    setSending(true)
    const messageId = crypto.randomUUID()
    const optimistic = {
      id: messageId,
      dir: 'out',
      text,
      sent_at: Date.now() / 1000,
      status: 'sending',
      _client_retry: true,
      _client_unconfirmed_history: true,
      _retry_attachment: image?.payload,
      ...(image ? {
        attachment: {
          mime: image.payload.mime,
          w: image.payload.w,
          h: image.payload.h,
          preview_url: image.previewUrl,
        },
      } : {}),
      ...(reply ? { reply_to: reply } : {}),
    }
    updateMessages((prior) => [...(prior || []), optimistic])
    setDraft('')
    setSelectedImage(null)
    setReplyTarget(null)
    try {
      const result = await sendMessage(messageId, peer, text, peerHandle, image?.payload, reply)
      window.mobius?.signal?.('item_created', { type: 'message' })
      if (result.status === 'failed') {
        showToast(result.detail || 'This person couldn’t be reached.', 'error')
      }
      // The send response is authoritative even when the follow-up history
      // refresh is offline; never leave a delivered message looking retryable.
      updateMessages((prior) => settleMessage(prior, messageId, result))
      await refresh()
    } catch (error) {
      window.mobius?.signal?.('error', { message: error.message, source: 'send' })
      const rejectedBeforeSave = isDefinitePrecommitRejection(error)
      if (rejectedBeforeSave) {
        updateMessages((prior) => (prior || []).filter((message) => message.id !== messageId))
        setDraft(text)
        setSelectedImage(image)
        setReplyTarget(reply)
        showToast(
          (error.status === 400 || error.status === 404) && (image || reply)
            ? 'Photo attachments and quoted replies aren’t available on this server yet.'
            : error.message,
          'error',
        )
      } else {
        showToast('Delivery was interrupted. Retry the saved message below.', 'error')
      }
      await refresh()
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  async function retry(message) {
    if (retrying || sending) return
    const messageId = message.id
    setRetrying(messageId)
    try {
      let result
      try {
        result = await retryMessage(peer, messageId)
      } catch (error) {
        if (error.status !== 404 || !message._client_retry) throw error
        result = await sendMessage(
          messageId, peer, message.text || '', peerHandle,
          message._retry_attachment, message.reply_to,
        )
      }
      updateMessages((prior) => settleMessage(prior, messageId, result))
      if (result.status === 'delivered') {
        showToast('Message delivered', 'success')
      } else {
        showToast(result.detail || 'This person still couldn’t be reached.', 'error')
      }
      await refresh()
    } catch (error) {
      showToast(error.message || 'Delivery couldn’t be retried yet.', 'error')
      await refresh()
    } finally {
      setRetrying('')
    }
  }

  const handle = peerHandle || peerActor?.handle || messages?.find((message) => message.peer_handle)?.peer_handle
  const displayName = handle ? `@${String(handle).replace(/^@+/, '')}` : 'Direct message'
  const encryptionActive = !!peerActor?.encryption_key ||
    !!messages?.some((message) => message.encrypted === true)

  let lastDay = ''
  let lastDir = null
  const rendered = []
  const list = messages || []
  for (let index = 0; index < list.length; index += 1) {
    const message = list[index]
    const day = new Date(message.sent_at * 1000).toDateString()
    if (day !== lastDay) {
      lastDay = day
      lastDir = null
      const today = new Date().toDateString() === day
      rendered.push(
        <div className="cn-day" key={`day-${day}`}>
          <span>{today ? 'Today' : new Date(message.sent_at * 1000).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</span>
        </div>,
      )
    }
    const mine = message.dir === 'out'
    const tick = mine && (
      <span className="cn-tick" aria-label={message.status || 'delivered'}>
        {message.status === 'sending' ? <Clock aria-hidden="true" />
          : message.status === 'failed' ? <Warning aria-hidden="true" />
          : <Check aria-hidden="true" />}
      </span>
    )
    const firstOfCluster = mine || lastDir !== 'in'
    rendered.push(
      <MessageBubble
        key={message.id}
        message={{ ...message, time: clockTime(message.sent_at) }}
        mine={mine}
        tick={tick}
        avatar={!mine && firstOfCluster ? <Avatar name={handle} host={requestPending ? undefined : peer} size="small" /> : null}
        indent={!mine && !firstOfCluster}
        conversationPath={`conversations/${peer}`}
        onOpenImage={onOpenImage}
        onImageUnavailable={() => showToast('This photo couldn’t be loaded.', 'error')}
        onReply={requestPending ? undefined : () => setReplyTarget(replyTargetFor(
          message,
          mine ? me?.handle : message.author_handle || message.peer_handle || handle,
        ))}
      />,
    )
    lastDir = message.dir
    if (message.status === 'failed' || (message.status === 'sending' && !sending)) {
      rendered.push(
        <button className="cn-failed-note" type="button" key={`fail-${message.id}`}
                disabled={!!retrying} onClick={() => retry(message)}>
          {retrying === message.id ? 'Retrying…' : message.status === 'failed'
            ? 'Not delivered · Retry' : 'Delivery interrupted · Retry'}
        </button>,
      )
    }
  }

  return (
    <div className="cn-thread">
      <div className="cn-thread-bar">
        <button className="cn-btn cn-btn-ghost cn-btn-icon" onClick={onBack} aria-label="Back">
          <ArrowLeft />
        </button>
        <Avatar name={displayName} host={requestPending ? undefined : peer} size="small" />
        <span className="cn-thread-person">
          <span className="cn-thread-name">
            <span className="cn-person-name">{displayName}</span>
            {encryptionActive && (
              <span className="cn-encryption-indicator" role="img" aria-label="End-to-end encrypted">
                <Lock aria-hidden="true" />
              </span>
            )}
          </span>
        </span>
      </div>
      <div className="cn-thread-msgs" ref={scrollRef} onScroll={trackScroll}>
        {requestPending && <section className="cn-request-panel" aria-labelledby="cn-request-title">
          <div>
            <strong id="cn-request-title">Message request</strong>
            <p>Read this preview safely. They won’t know you opened it, and you can’t reply until you accept.</p>
          </div>
          {requestError && <p className="cn-request-error" role="alert">{requestError}</p>}
          <div className="cn-request-actions">
            <button className="cn-btn cn-btn-primary" type="button" disabled={!!requestBusy}
                    onClick={() => decideRequest('accept')}>
              {requestBusy === 'accept' ? 'Accepting…' : 'Accept'}
            </button>
            <button className="cn-btn cn-btn-secondary" type="button" disabled={!!requestBusy}
                    onClick={() => decideRequest('decline')}>Decline</button>
            <button className="cn-btn cn-btn-ghost is-danger" type="button" disabled={!!requestBusy}
                    onClick={() => decideRequest('block')}>Block</button>
          </div>
        </section>}
        {nextCursor && (
          <button className="cn-history-more" type="button" disabled={loadingEarlier}
                  onClick={loadEarlier}>
            {loadingEarlier ? 'Loading earlier messages…' : 'Load earlier messages'}
          </button>
        )}
        {loadError && <div className="cn-directory-error" role="alert"><p>{loadError}</p><button className="cn-btn cn-btn-secondary" onClick={refresh}>Try again</button></div>}
        {messages === null && !loadError && <div className="cn-center"><div className="cn-spinner" /></div>}
        {messages !== null && messages.length === 0 && (
          <div className="cn-empty">
            <div className="cn-empty-title">Say hello</div>
            <p className="cn-empty-text">
              {encryptionActive
                ? 'Messages are end-to-end encrypted.'
                : handle
                  ? `Your message travels straight to ${displayName}’s own server — no one in between.`
                  : 'Your message travels straight to this person’s own server — no one in between.'}
            </p>
          </div>
        )}
        {rendered}
      </div>
      {requestPending ? (
        <div className="cn-request-quiet" role="status">Accept this request to reply.</div>
      ) : <div className="cn-compose-shell">
        <ReplyTarget reply={replyTarget} onDismiss={() => setReplyTarget(null)} />
        <SelectedImageStrip selected={selectedImage} onRemove={() => setSelectedImage(null)} />
        <form className="cn-compose-bar" onSubmit={send}>
          <input ref={fileRef} className="cn-file-input" type="file" accept="image/*"
                 onChange={chooseImage} tabIndex={-1} aria-hidden="true" />
          <button className="cn-compose-image" type="button" onClick={() => fileRef.current?.click()}
                  disabled={sending || processingImage} aria-label="Attach photo">
            {processingImage ? <span className="cn-spinner" /> : <ImageSquare aria-hidden="true" />}
          </button>
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={sending || processingImage}
            placeholder="Message"
            autoComplete="off"
            aria-label="Message"
          />
          <button className="cn-send" type="submit"
                  disabled={sending || processingImage || (!draft.trim() && !selectedImage)} aria-label="Send">
            <ArrowUp />
          </button>
        </form>
      </div>}
    </div>
  )
}
