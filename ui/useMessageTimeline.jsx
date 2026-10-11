import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, Clock, Warning } from '@openai/apps-sdk-ui/components/Icon'
import Composer, { ComposerAttachmentButton, ComposerFooter } from './Composer.jsx'
import { ReplyTarget } from './MessageBubble.jsx'
import { prepareImage, SelectedImageStrip } from './Media.jsx'
import { prependedScrollTop } from './interactionRules.js'
import { reachedEarlierHistory } from './historyScroll.js'
import {
  addUnseenMessages, deliveryLabel, isDefinitePrecommitRejection, markDeliveryUnknown, reconcileLatestPage,
  reconcileOlderPage, settleMessage,
} from '../message_ui_state.js'

// Direct and group threads share one timeline: history paging, reading
// position, the composer and stable-identity sends. Each conversation mounts
// its own thread (keyed by peer or group id), so nothing here resets for a
// different conversation.
export function useMessageTimeline({
  version, loadPage, watchLatest, refreshExtra, onRefreshed, pinnedTop = false,
  sendBlocked = false, deliver, retrySaved, onSent, retryFailedText, signals, showToast,
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
  const earlierInFlight = useRef(false)
  const earlierFailed = useRef(false)
  const lastScrollTop = useRef(null)
  const scrollRef = useRef(null)
  const messagesRef = useRef(null)
  const refreshRequest = useRef(0)
  const latestPage = useRef(null)
  const paginationGeneration = useRef(0)
  const seenVersion = useRef(version)
  const stickToBottom = useRef(true)
  const prepended = useRef(null)
  const inputRef = useRef(null)
  const fileRef = useRef(null)

  function updateMessages(next) {
    const value = typeof next === 'function' ? next(messagesRef.current) : next
    messagesRef.current = value
    setMessages(value)
  }

  async function refresh({ replace = false, background = false } = {}) {
    const request = ++refreshRequest.current
    try {
      const [page, extra] = await Promise.all([
        loadPage(null, { background }), refreshExtra?.(),
      ])
      if (request !== refreshRequest.current) return false
      const reconciled = reconcileLatestPage(messagesRef.current, page, { replace })
      updateMessages(reconciled.messages)
      if (reconciled.resetCursor) {
        paginationGeneration.current += 1
        setNextCursor(reconciled.nextCursor)
      }
      if (refreshExtra) onRefreshed(extra)
      if (!earlierFailed.current) setLoadError('')
      return true
    } catch {
      if (request === refreshRequest.current && !earlierFailed.current) {
        setLoadError('Messages couldn’t be refreshed. Your saved history hasn’t been removed.')
      }
      return false
    }
  }

  useEffect(() => {
    const watch = watchLatest((page) => {
      if (messagesRef.current === null) {
        if (!page.messages.length) return
        const reconciled = reconcileLatestPage(null, page, { replace: true })
        updateMessages(reconciled.messages)
        setNextCursor(reconciled.nextCursor)
        return
      }
      updateMessages((prior) => addUnseenMessages(prior, page))
    })
    latestPage.current = watch
    refresh({ replace: true })
    return () => {
      watch.stop()
      latestPage.current = null
      refreshRequest.current += 1
      paginationGeneration.current += 1
    }
  }, [])

  useEffect(() => {
    if (version > 0 && version !== seenVersion.current) {
      seenVersion.current = version
      // The published page shows a new message within one storage read; the
      // authoritative history then settles statuses without jumping the queue.
      latestPage.current?.recheck()
      refresh({ background: true })
    }
  }, [version])

  async function loadEarlier() {
    if (!nextCursor || earlierInFlight.current) return
    earlierInFlight.current = true
    earlierFailed.current = false
    setLoadError('')
    stickToBottom.current = false
    setLoadingEarlier(true)
    const generation = paginationGeneration.current
    try {
      const page = await loadPage(nextCursor)
      const reconciled = reconcileOlderPage(
        messagesRef.current, page, generation, paginationGeneration.current,
      )
      if (!reconciled) return
      // Measure just before the prepend; it is restored once committed.
      const el = scrollRef.current
      prepended.current = el && { el, top: el.scrollTop, height: el.scrollHeight }
      updateMessages(reconciled.messages)
      setNextCursor(reconciled.nextCursor)
      setLoadError('')
    } catch {
      if (generation === paginationGeneration.current) {
        earlierFailed.current = true
        setLoadError('Earlier messages couldn’t be loaded. Your saved history hasn’t been removed.')
      }
    } finally {
      earlierInFlight.current = false
      setLoadingEarlier(false)
    }
  }

  // Browser scroll anchoring may already hold the view after a prepend. An
  // absolute target, set before paint, is right with or without it.
  function restorePrependedPosition() {
    const before = prepended.current
    prepended.current = null
    if (!before || before.el !== scrollRef.current) return
    before.el.scrollTop = prependedScrollTop(before.top, before.height, before.el.scrollHeight)
    lastScrollTop.current = before.el.scrollTop
  }
  useLayoutEffect(restorePrependedPosition, [messages])

  // Before paint, so opening a conversation never flashes its oldest messages.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (pinnedTop) el.scrollTop = 0
    else if (stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [messages?.length, selectedImage, replyTarget, pinnedTop])

  function trackScroll() {
    const el = scrollRef.current
    if (!el || pinnedTop) return
    const shouldLoad = reachedEarlierHistory(lastScrollTop.current, el)
    lastScrollTop.current = el.scrollTop
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 72
    if (shouldLoad && nextCursor && !earlierFailed.current) loadEarlier()
  }

  async function chooseImage(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    await selectImage(file)
  }

  async function selectImage(file) {
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

  function replyTo(target) {
    setReplyTarget(target)
    inputRef.current?.focus()
  }

  function cancelReply() {
    setReplyTarget(null)
    inputRef.current?.focus()
  }

  async function send(event) {
    event.preventDefault()
    const text = draft.trim()
    const image = selectedImage
    const reply = replyTarget
    if ((!text && !image) || sending || processingImage || sendBlocked) return

    // Your own new message is always shown, even when sent while reading back.
    stickToBottom.current = true
    setSending(true)
    // One client identity per message: a retry can never create a duplicate.
    const messageId = crypto.randomUUID()
    updateMessages((prior) => [...(prior || []), {
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
    }])
    setDraft('')
    setSelectedImage(null)
    setReplyTarget(null)
    try {
      const result = await deliver({ id: messageId, text, attachment: image?.payload, reply })
      window.mobius?.signal?.('item_created', { type: signals.created })
      // The send response is authoritative even when the follow-up history
      // refresh is offline; never leave a delivered message looking retryable.
      updateMessages((prior) => settleMessage(prior, messageId, result))
      onSent(result)
    } catch (error) {
      window.mobius?.signal?.('error', { message: error.message, source: signals.error })
      if (isDefinitePrecommitRejection(error)) {
        updateMessages((prior) => (prior || []).filter((message) => message.id !== messageId))
        setDraft((current) => (current.trim() ? `${text}\n${current}` : text))
        setSelectedImage(image)
        setReplyTarget(reply)
        showToast(
          (error.status === 400 || error.status === 404) && (image || reply)
            ? 'Photo attachments and quoted replies aren’t available on this server yet.'
            : error.message,
          'error',
        )
      } else {
        updateMessages((prior) => markDeliveryUnknown(
          prior, messageId, 'Confirmation was interrupted; this message may have arrived.',
        ))
        showToast('Delivery was interrupted. Retry the saved message below.', 'error')
      }
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
    await refresh()
  }

  async function retry(message) {
    if (retrying || sending) return
    const messageId = message.id
    setRetrying(messageId)
    try {
      let result
      try {
        // The server re-sends its saved copy, photo included, under this id.
        result = await retrySaved(messageId)
      } catch (error) {
        // A send interrupted before the server saved it has nothing to retry,
        // so send it again from this device under the same id.
        if (error.status !== 404 || !message._client_retry) throw error
        result = await deliver({
          id: messageId, text: message.text || '',
          attachment: message._retry_attachment, reply: message.reply_to,
        })
      }
      updateMessages((prior) => settleMessage(prior, messageId, result))
      if (result.status === 'delivered') {
        showToast('Message delivered', 'success')
      } else {
        showToast(result.detail || retryFailedText, 'error')
      }
    } catch (error) {
      if (!isDefinitePrecommitRejection(error)) {
        updateMessages((prior) => markDeliveryUnknown(
          prior, messageId, 'Retry confirmation was interrupted; this message may have arrived.',
        ))
      }
      showToast(error.message || 'Delivery couldn’t be retried yet.', 'error')
    } finally {
      setRetrying('')
    }
    await refresh()
  }

  return {
    messages, nextCursor, loadingEarlier, loadError, earlierFailed, refresh, loadEarlier,
    trackScroll, scrollRef, inputRef, fileRef, draft, setDraft, sending, retrying, retry,
    processingImage, selectedImage, setSelectedImage, chooseImage, selectImage,
    replyTarget, replyTo, cancelReply, send, cancelRefresh: () => { refreshRequest.current += 1 },
  }
}

export function DeliveryTick({ status }) {
  const Icon = status === 'sending' ? Clock : status === 'failed' ? Warning : Check
  return (
    <span className="cn-tick" role="img" aria-label={deliveryLabel(status)}>
      <Icon aria-hidden="true" />
    </span>
  )
}

// An interrupted or failed own message keeps one retry beside it.
export function DeliveryNote({ message, timeline }) {
  const { sending, retrying, retry } = timeline
  if (message.status !== 'failed' && (message.status !== 'sending' || sending)) return null
  const failed = message.status === 'failed'
  return (
    <span className="cn-delivery-note">
      <button className="cn-failed-note" type="button" disabled={!!retrying}
              onClick={() => retry(message)}>
        <Warning aria-hidden="true" />
        {retrying === message.id ? 'Retrying…' : failed
          ? 'Delivery failed · Retry' : 'Delivery interrupted · Retry'}
      </button>
      {message.failure && <span className="cn-delivery-reason">{message.failure}</span>}
    </span>
  )
}

// Day separators restart message clustering, so each renderer is told when
// a new day began.
export function withDayDividers(messages, renderMessage) {
  const today = new Date().toDateString()
  let lastDay = ''
  return (messages || []).flatMap((message) => {
    const date = new Date(message.sent_at * 1000)
    const day = date.toDateString()
    const startsDay = day !== lastDay
    lastDay = day
    const rendered = renderMessage(message, startsDay)
    if (!startsDay) return rendered
    return [
      <div className="cn-day" key={`day-${day}`}>
        <span>{day === today ? 'Today' : date.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</span>
      </div>,
      ...rendered,
    ]
  })
}

export function MessageTimeline({ timeline, header, empty, children }) {
  const {
    scrollRef, trackScroll, nextCursor, loadingEarlier, loadEarlier, loadError,
    earlierFailed, refresh, messages,
  } = timeline
  return (
    <div className="cn-thread-msgs" ref={scrollRef} onScroll={trackScroll}>
      {header}
      {nextCursor && (
        <button className="cn-history-more" type="button" disabled={loadingEarlier}
                onClick={loadEarlier}>
          {loadingEarlier ? 'Loading earlier messages…' : 'Load earlier messages'}
        </button>
      )}
      {loadError && <div className="cn-directory-error" role="alert"><p>{loadError}</p><button className="cn-btn cn-btn-secondary" onClick={() => earlierFailed.current ? loadEarlier() : refresh()}>Try again</button></div>}
      {messages === null && !loadError && <div className="cn-center cn-history-loading" role="status"><div className="cn-spinner" /><span>Loading messages…</span></div>}
      {messages !== null && messages.length === 0 && empty}
      {/* The live region starts once history has loaded, so the backlog
          present at that moment is not announced; only later arrivals are. */}
      <div className="cn-message-log" role={messages === null ? undefined : 'log'}
           aria-label={messages === null ? undefined : 'Messages'} aria-busy={loadingEarlier}>
        {children}
      </div>
    </div>
  )
}

export function TimelineComposer({ timeline, onOpenImage }) {
  const {
    scrollRef, fileRef, inputRef, chooseImage, draft, setDraft, send, sending,
    processingImage, selectImage, selectedImage, setSelectedImage, replyTarget, cancelReply,
  } = timeline
  return (
    <ComposerFooter scrollRef={scrollRef}>
      <input ref={fileRef} className="cn-file-input" type="file" accept="image/*"
             onChange={chooseImage} tabIndex={-1} aria-hidden="true" />
      <Composer inputRef={inputRef} value={draft} onChange={setDraft} onSubmit={send}
                disabled={processingImage} onImagePaste={sending ? undefined : selectImage}
                sendDisabled={sending || processingImage || (!draft.trim() && !selectedImage)}
                attachmentAction={<ComposerAttachmentButton onClick={() => fileRef.current?.click()}
                  disabled={sending || processingImage} />}>
        {(replyTarget || selectedImage) && <>
          <ReplyTarget reply={replyTarget} onDismiss={cancelReply} />
          <SelectedImageStrip selected={selectedImage} onRemove={() => setSelectedImage(null)} onOpen={onOpenImage} />
        </>}
      </Composer>
    </ComposerFooter>
  )
}
