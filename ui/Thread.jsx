import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Lock } from '@openai/apps-sdk-ui/components/Icon'
import {
  acceptMessageRequest, blockMessageRequest, clearUnread, clockTime,
  declineMessageRequest, editMessage, getPeer, listMessages, reactToMessage, retryMessage, sendMessage,
  watchLatestMessages,
} from '../api.js'
import { BOARD_REACTION_EMOJIS } from '../reconciliation.js'
import { Avatar } from './Board.jsx'
import MessageBubble, { replyTargetFor } from './MessageBubble.jsx'
import { ReactionRetryNote, supportsMessageReactions, useMessageReactions } from './MessageReactions.jsx'
import { supportsMessageEdits, useMessageEdits } from './messageEdits.js'
import {
  DeliveryNote, DeliveryTick, MessageTimeline, TimelineComposer, useMessageTimeline,
  withDayDividers,
} from './useMessageTimeline.jsx'

export default function Thread({
  peer, peerHandle, me, version, foreground, request, onBack, showToast, onOpenImage,
}) {
  const [peerActor, setPeerActor] = useState(null)
  const [requestPending, setRequestPending] = useState(Boolean(request))
  const [requestBusy, setRequestBusy] = useState('')
  const [requestError, setRequestError] = useState('')
  const timeline = useMessageTimeline({
    version,
    showToast,
    loadPage: (cursor, options) => listMessages(peer, cursor, options),
    watchLatest: (onPage) => watchLatestMessages(peer, onPage),
    pinnedTop: requestPending,
    signals: { created: 'message', error: 'send' },
    deliver: ({ id, text, attachment, reply }) =>
      sendMessage(id, peer, text, peerHandle, attachment, reply),
    onSent: (result) => {
      if (result.status === 'failed') {
        showToast(result.detail || 'This person couldn’t be reached.', 'error')
      }
    },
    retrySaved: (id) => retryMessage(peer, id),
    retryFailedText: 'This person still couldn’t be reached.',
  })
  const { messages, refresh } = timeline
  const [pickerFor, setPickerFor] = useState(null)
  const closePicker = useCallback(() => setPickerFor(null), [])
  const messageReactions = useMessageReactions({
    ownHost: me?.host,
    send: (id, emoji, on, updateId) => reactToMessage(peer, id, emoji, on, updateId),
    onError: error => showToast(error.message || 'The reaction couldn’t be sent.', 'error'),
  })
  const canReact = !requestPending && supportsMessageReactions(peerActor)
  const canEdit = !requestPending && supportsMessageEdits(peerActor)
  const saveEdit = useMessageEdits({
    timeline, showToast, save: (id, text, editId) => editMessage(peer, id, text, editId),
  })

  // Messages are read only while this pane is actually visible to the owner.
  useEffect(() => {
    if (foreground && !requestPending) clearUnread(peer).catch(() => {})
  }, [peer, version, foreground, requestPending])

  useEffect(() => {
    let active = true
    setPeerActor(null)
    if (requestPending) return () => { active = false }
    getPeer(peer, undefined, { background: true })
      .then((actor) => { if (active) setPeerActor(actor) })
      .catch(() => {})
    return () => { active = false }
  }, [peer, requestPending])

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

  const handle = peerHandle || peerActor?.handle || messages?.find((message) => message.peer_handle)?.peer_handle
  const displayName = handle ? `@${String(handle).replace(/^@+/, '')}` : 'Direct message'
  const encryptionActive = !!peerActor?.encryption_key ||
    !!messages?.some((message) => message.encrypted === true)

  let lastDir = null
  const rendered = withDayDividers(messages, (message, startsDay) => {
    if (startsDay) lastDir = null
    const mine = message.dir === 'out'
    const firstOfCluster = mine || lastDir !== 'in'
    lastDir = message.dir
    const author = mine ? me?.handle : message.author_handle || message.peer_handle || handle
    return [
      <MessageBubble
        key={message.id}
        message={{ ...message, time: clockTime(message.sent_at) }}
        mine={mine}
        author={author}
        tick={mine && <DeliveryTick status={message.status} />}
        avatar={!mine && firstOfCluster ? <Avatar name={handle} host={requestPending ? undefined : peer} size="small" remote /> : null}
        indent={!mine && !firstOfCluster}
        conversationPath={`conversations/${peer}`}
        onOpenImage={onOpenImage}
        onImageUnavailable={() => showToast('This photo couldn’t be loaded.', 'error')}
        onReply={requestPending ? undefined : () => timeline.replyTo(replyTargetFor(message, author))}
        reactions={{
          state: messageReactions.stateFor(message),
          choices: BOARD_REACTION_EMOJIS,
          canReact,
          disabled: Boolean(messageReactions.pending[message.id]),
          open: pickerFor === message.id,
          onToggle: () => setPickerFor(open => open === message.id ? null : message.id),
          onClose: closePicker,
          onReact: emoji => messageReactions.toggle(message, emoji),
        }}
        edits={{ canEdit, onSave: saveEdit }}
      />,
      <DeliveryNote key={`fail-${message.id}`} message={message} timeline={timeline} />,
      <ReactionRetryNote key={`react-${message.id}`} message={message} mine={mine} reactions={messageReactions} />,
    ]
  })

  const requestPanel = requestPending && (
    <section className="cn-request-panel" aria-labelledby="cn-request-title">
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
    </section>
  )
  const emptyState = (
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
  )

  return (
    <div className="cn-thread">
      <div className="cn-thread-bar">
        <button className="cn-btn cn-btn-ghost cn-btn-icon" onClick={onBack} aria-label="Back">
          <ArrowLeft />
        </button>
        <Avatar name={displayName} host={requestPending ? undefined : peer} size="small" remote />
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
      <MessageTimeline timeline={timeline} header={requestPanel} empty={emptyState}>
        {rendered}
      </MessageTimeline>
      {requestPending ? (
        <div className="cn-request-quiet" role="status">Accept this request to reply.</div>
      ) : <TimelineComposer timeline={timeline} onOpenImage={onOpenImage} />}
    </div>
  )
}
