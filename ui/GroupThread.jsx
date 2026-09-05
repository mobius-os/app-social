import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft, ArrowUp, Check, Clock, ImageSquare, Warning,
} from '@openai/apps-sdk-ui/components/Icon'
import { listGroupMessages, sendGroupMessage, clearGroupUnread, clockTime, getGroup } from '../api.js'
import { GroupAvatar } from './Messages.jsx'
import { Avatar } from './Board.jsx'
import MessageBubble, { ReplyTarget, replyTargetFor } from './MessageBubble.jsx'
import GroupDetails from './GroupDetails.jsx'
import { prepareImage, SelectedImageStrip } from './Media.jsx'

export default function GroupThread({
  group, me, version, onBack, showToast, onOpenImage,
}) {
  const [details, setDetails] = useState(false)
  const [currentGroup, setCurrentGroup] = useState(group)
  const [loadError, setLoadError] = useState('')
  const refreshRequest = useRef(0)
  const [messages, setMessages] = useState(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [processingImage, setProcessingImage] = useState(false)
  const [selectedImage, setSelectedImage] = useState(null)
  const [replyTarget, setReplyTarget] = useState(null)
  const scrollRef = useRef(null)
  const inputRef = useRef(null)
  const fileRef = useRef(null)
  const gid = group.gid

  async function refresh() {
    const request = ++refreshRequest.current
    try {
      const [loaded, metadata] = await Promise.all([listGroupMessages(gid), getGroup(gid)])
      if (request !== refreshRequest.current) return
      setMessages(loaded); setCurrentGroup(metadata); setLoadError('')
    } catch (error) {
      if (request === refreshRequest.current) setLoadError('Messages couldn’t be refreshed. Your saved history hasn’t been removed.')
    }
  }

  useEffect(() => {
    refresh()
    clearGroupUnread(gid).catch(() => {})
    return () => { refreshRequest.current += 1 }
  }, [gid, version])
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages?.length, selectedImage, replyTarget])

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
    if ((!text && !image) || sending || processingImage || currentGroup.deleted_at) return

    setSending(true)
    setMessages((prior) => [...(prior || []), {
      id: `local-${Date.now()}`,
      dir: 'out',
      text,
      sent_at: Date.now() / 1000,
      status: 'sending',
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
      const result = await sendGroupMessage(gid, text, image?.payload, reply)
      window.mobius?.signal?.('item_created', { type: 'group_message' })
      if (result.status === 'failed') {
        showToast(result.detail || 'The group host couldn’t be reached.', 'error')
      } else if (result.failed_members?.length) {
        const count = result.failed_members.length
        showToast(`Sent — ${count} ${count === 1 ? 'person is' : 'people are'} unreachable right now.`, 'error')
      }
      await refresh()
    } catch (error) {
      window.mobius?.signal?.('error', { message: error.message, source: 'group_send' })
      setDraft(text)
      setSelectedImage(image)
      setReplyTarget(reply)
      showToast(
        (error.status === 400 || error.status === 404) && (image || reply)
          ? 'Photo attachments and quoted replies aren’t available on this server yet.'
          : error.message,
        'error',
      )
      await refresh()
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  const memberCount = (currentGroup.members || []).length
  let lastDay = ''
  let lastAuthor = null
  const rendered = []
  for (const message of messages || []) {
    const day = new Date(message.sent_at * 1000).toDateString()
    if (day !== lastDay) {
      lastDay = day
      lastAuthor = null
      const today = new Date().toDateString() === day
      rendered.push(
        <div className="cn-day" key={`day-${day}`}>
          <span>{today ? 'Today' : new Date(message.sent_at * 1000).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</span>
        </div>,
      )
    }
    const mine = message.dir === 'out'
    const firstOfCluster = !mine && message.author !== lastAuthor
    if (firstOfCluster) {
      rendered.push(
        <span className="cn-author" key={`author-${message.id}`}>
          {message.author_handle ? `@${message.author_handle}` : 'Social member'}
        </span>,
      )
    }
    lastAuthor = mine ? null : message.author
    const tick = mine && (
      <span className="cn-tick" aria-label={message.status || 'delivered'}>
        {message.status === 'sending' ? <Clock aria-hidden="true" />
          : message.status === 'failed' ? <Warning aria-hidden="true" />
          : <Check aria-hidden="true" />}
      </span>
    )
    rendered.push(
      <MessageBubble
        key={message.id}
        message={{ ...message, time: clockTime(message.sent_at) }}
        mine={mine}
        tick={tick}
        avatar={!mine && firstOfCluster
          ? <Avatar name={message.author_handle} host={message.author} size="small" />
          : null}
        indent={!mine && !firstOfCluster}
        conversationPath={`groups/${gid}`}
        onOpenImage={onOpenImage}
        onImageUnavailable={() => showToast('This photo couldn’t be loaded.', 'error')}
        onReply={() => setReplyTarget(replyTargetFor(
          message,
          mine ? me?.handle : message.author_handle || 'Social member',
        ))}
      />,
    )
    if (message.status === 'failed') {
      rendered.push(<span className="cn-failed-note" key={`fail-${message.id}`}>Not delivered</span>)
    }
  }

  return (
    <div className={`cn-thread cn-screen${details ? ' has-dialog' : ''}`}>
      <div className="cn-thread-bar">
        <button className="cn-btn cn-btn-ghost cn-btn-icon" onClick={onBack} aria-label="Back">
          <ArrowLeft />
        </button>
        <GroupAvatar name={currentGroup.name} />
        <span className="cn-thread-heading">
          <span className="cn-person-name">{currentGroup.name}</span>
          <span className="cn-meta">{currentGroup.deleted_at ? 'Group closed' : `${memberCount} ${memberCount === 1 ? 'person' : 'people'}`}</span>
        </span>
        <button className="cn-btn cn-btn-secondary" onClick={() => setDetails(true)} aria-label="Group details">Details</button>
      </div>
      <div className="cn-thread-msgs" ref={scrollRef}>
        {loadError && <div className="cn-directory-error" role="alert"><p>{loadError}</p><button className="cn-btn cn-btn-secondary" onClick={refresh}>Try again</button></div>}
        {messages === null && !loadError && <div className="cn-center"><div className="cn-spinner" /></div>}
        {messages !== null && messages.length === 0 && (
          <div className="cn-empty">
            <div className="cn-empty-title">Say hello</div>
            <p className="cn-empty-text">
              Messages go to the group’s home server and on to every member’s own server.
            </p>
          </div>
        )}
        {rendered}
      </div>
      {currentGroup.deleted_at ? <div className="cn-group-closed" role="status">This group has been closed. You can still read its earlier messages.</div> : <div className="cn-compose-shell">
        <ReplyTarget reply={replyTarget} onDismiss={() => setReplyTarget(null)} />
        <SelectedImageStrip selected={selectedImage} onRemove={() => setSelectedImage(null)} />
        <form className="cn-compose-bar" onSubmit={send}>
          <input ref={fileRef} className="cn-file-input" type="file" accept="image/*"
                 onChange={chooseImage} tabIndex={-1} aria-hidden="true" />
          <button className="cn-compose-image" type="button" onClick={() => fileRef.current?.click()}
                  disabled={sending || processingImage} aria-label="Attach photo">
            {processingImage ? <span className="cn-spinner" /> : <ImageSquare aria-hidden="true" />}
          </button>
          <input ref={inputRef} value={draft} onChange={(event) => setDraft(event.target.value)}
                 placeholder="Message" autoComplete="off" aria-label="Message" />
          <button className="cn-send" type="submit"
                  disabled={sending || processingImage || (!draft.trim() && !selectedImage)} aria-label="Send">
            <ArrowUp />
          </button>
        </form>
      </div>}
      {details && <GroupDetails group={currentGroup} me={me} onClose={() => setDetails(false)}
        onUpdated={updated => { refreshRequest.current += 1; setCurrentGroup(updated) }}
        onDeleted={() => { showToast('Group deleted', 'success'); onBack() }} />}
    </div>
  )
}
