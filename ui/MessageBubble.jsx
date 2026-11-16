import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, Copy, DotsHorizontal, EditPencil, Reply, X } from '@openai/apps-sdk-ui/components/Icon'
import { splitGifMessage } from '../gifs.js'
import { MessageImage } from './Media.jsx'
import { MessageReactButton, MessageReactionRow } from './MessageReactions.jsx'
import { FlatEmoji } from './ReactionControls.jsx'
import { onRecentReactionsChange, recentReactions, rememberReaction } from './recentReactions.js'
import RichText from './RichText.jsx'

function handleLabel(handle) {
  const clean = String(handle || 'Unknown').replace(/^@/, '')
  return clean === 'Unknown' ? clean : `@${clean}`
}

export function replyTargetFor(message, authorHandle) {
  const text = String(message.text || '').trim()
  return {
    id: message.id,
    author_handle: String(authorHandle || 'Unknown').replace(/^@/, ''),
    excerpt: Array.from(text || '📷 Photo').slice(0, 140).join(''),
  }
}

export function ReplyTarget({ reply, onDismiss }) {
  if (!reply) return null
  return (
    <div className="cn-reply-target">
      <span className="cn-reply-target-copy">
        <strong>{handleLabel(reply.author_handle)}</strong>
        <span>{reply.excerpt}</span>
      </span>
      <button type="button" onClick={onDismiss} aria-label="Cancel reply">
        <X aria-hidden="true" />
      </button>
    </div>
  )
}

function Quote({ reply }) {
  if (!reply) return null
  return (
    <div className="cn-quote">
      <strong>{handleLabel(reply.author_handle)}</strong>
      <span>{reply.excerpt}</span>
    </div>
  )
}

export default function MessageBubble({
  message, mine, author, tick, avatar, indent, conversationPath, onOpenImage, onImageUnavailable, onReply,
  reactions, edits,
}) {
  const [editing, setEditing] = useState(false)
  // Plain text you wrote and that arrived can be edited; a GIF's link cannot.
  const canEdit = mine && !!edits?.canEdit && message.status === 'delivered'
    && !!message.text?.trim() && !splitGifMessage(message.text)
  const canReply = !!onReply && message.status !== 'sending'
  // Reactions need a message both copies already hold.
  const canReact = !!reactions?.canReact && message.status === 'delivered'
  const react = (emoji) => { rememberReaction(emoji); reactions.onReact(emoji) }

  return (
    <>
      <div className={`cn-message-line ${mine ? 'is-mine' : 'is-theirs'}${indent ? ' no-avatar' : ''}${editing ? ' is-editing' : ''}`} tabIndex={-1}>
        {!mine && <span className="cn-message-avatar">{avatar}</span>}
        <div className="cn-bubble-wrap">
        <div
          className={`cn-bubble ${mine ? 'is-mine' : 'is-theirs'}${message.status === 'failed' ? ' is-failed' : ''}${message.attachment ? ' has-attachment' : ''}${editing ? ' is-editing' : ''}`}
        >
          <Quote reply={message.reply_to} />
          <MessageImage attachment={message.attachment} conversationPath={conversationPath}
                        onOpen={onOpenImage} onUnavailable={onImageUnavailable} />
          {editing
            ? <MessageEditor text={message.text} resendable={!!message.edit?.pending} onCancel={() => setEditing(false)}
                             onSave={async (text) => { await edits.onSave(message, text); setEditing(false) }} />
            : <>
                {message.text && <RichText className="cn-bubble-copy" text={message.text} />}
                <span className="cn-bubble-time">
                  {message.edited_at ? <span className="cn-bubble-edited" title={message.edit?.pending ? 'Edit not confirmed yet' : undefined}>
                    edited{message.edit?.pending ? ' · unconfirmed' : ''}</span> : null}
                  {message.time}{tick}
                </span>
              </>}
        </div>
        <MessageToolbar message={message} mine={mine} author={author} canReply={canReply} onReply={onReply}
                        canReact={canReact} reactions={reactions} react={react}
                        onEdit={canEdit && !editing ? () => setEditing(true) : null} />
        </div>
      </div>
      {/* Its own line under the bubble, so the bubble's row keeps its shape. */}
      {/* Reaction chips, and the full picker when the toolbar's emoji button opens it. */}
      {reactions && (
        <MessageReactionRow messageId={message.id} mine={mine} state={reactions.state}
                            choices={reactions.choices} canReact={canReact} disabled={reactions.disabled}
                            open={reactions.open} onClose={reactions.onClose} onReact={react} />
      )}
    </>
  )
}

/** Hover toolbar: three recent reactions, the full picker, Reply, and More. */
function MessageToolbar({ message, mine, author, canReply, onReply, canReact, reactions, react, onEdit }) {
  const [, setTick] = useState(0)
  useEffect(() => onRecentReactionsChange(() => setTick(n => n + 1)), [])
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef(null)
  useEffect(() => {
    if (!moreOpen) return undefined
    const dismiss = (event) => { if (!moreRef.current?.contains(event.target)) setMoreOpen(false) }
    const onKey = (event) => { if (event.key === 'Escape') setMoreOpen(false) }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', onKey) }
  }, [moreOpen])
  const quick = canReact ? recentReactions(reactions.choices) : []
  const hasText = Boolean(message.text)
  if (!canReact && !canReply && !hasText && !onEdit) return null

  async function copyText() {
    setMoreOpen(false)
    try { await navigator.clipboard.writeText(message.text) } catch { /* clipboard blocked */ }
  }

  return (
    <div className={`cn-msg-toolbar${moreOpen || reactions?.open ? ' is-open' : ''}`} role="toolbar" aria-label="Message actions">
      {quick.map(emoji => (
        <button key={emoji} type="button" className={`cn-msg-tool${reactions.state[emoji]?.reacted ? ' is-reacted' : ''}`}
                disabled={reactions.disabled} aria-pressed={Boolean(reactions.state[emoji]?.reacted)}
                aria-label={`React with ${emoji}`} onClick={() => react(emoji)}>
          <FlatEmoji emoji={emoji} />
        </button>
      ))}
      {canReact && reactions.onToggle && (
        <MessageReactButton messageId={message.id} open={reactions.open} disabled={reactions.disabled}
                            onToggle={reactions.onToggle} />
      )}
      {onEdit && (
        <button className="cn-msg-tool" type="button" onClick={onEdit} title="Edit" aria-label="Edit message">
          <EditPencil aria-hidden="true" />
        </button>
      )}
      {canReply && (
        <button className="cn-msg-tool" type="button" onClick={onReply} title="Reply"
                aria-label={mine ? 'Reply to your message' : author ? `Reply to ${handleLabel(author)}` : 'Reply to message'}>
          <Reply aria-hidden="true" />
        </button>
      )}
      {hasText && (
        <span className="cn-msg-more" ref={moreRef}>
          <button className="cn-msg-tool" type="button" title="More" aria-label="More actions"
                  aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen(open => !open)}>
            <DotsHorizontal aria-hidden="true" />
          </button>
          {moreOpen && (
            <div className="cn-msg-menu" role="menu">
              <button type="button" role="menuitem" onClick={copyText}><Copy aria-hidden="true" /> Copy text</button>
            </div>
          )}
        </span>
      )}
    </div>
  )
}

/** In-place editor for one of your messages: Enter saves, Escape cancels. */
function MessageEditor({ text, resendable, onSave, onCancel }) {
  const [value, setValue] = useState(text || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fieldRef = useRef(null)
  useEffect(() => {
    const field = fieldRef.current
    if (!field) return
    field.focus()
    field.setSelectionRange(field.value.length, field.value.length)
  }, [])
  // Grow with the text, wrapped lines included, so the whole message stays in view.
  useLayoutEffect(() => {
    const field = fieldRef.current
    if (!field) return
    field.style.height = 'auto'
    field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`
  }, [value])
  const unchanged = value.trim() === (text || '').trim()

  async function save() {
    if (busy || !value.trim()) return
    // Saving the same text again only matters for an edit not confirmed yet: it resends it.
    if (unchanged && !resendable) { onCancel(); return }
    setBusy(true)
    setError('')
    try {
      await onSave(value.trim())
    } catch (failure) {
      setError(failure.message || 'The edit couldn’t be saved.')
      setBusy(false)
    }
  }

  return (
    <div className="cn-bubble-editor">
      <textarea ref={fieldRef} value={value} rows={1}
                aria-label="Edit message" disabled={busy}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() }
                  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); save() }
                }} />
      {error && <p className="cn-bubble-editor-error" role="alert">{error}</p>}
      <div className="cn-bubble-editor-actions">
        <button type="button" className="cn-edit-icon" onClick={onCancel} disabled={busy}
                aria-label="Cancel edit" title="Cancel (Esc)">
          <X aria-hidden="true" />
        </button>
        <button type="button" className="cn-edit-icon is-save" onClick={save} disabled={busy || !value.trim()}
                aria-label={busy ? 'Saving edit' : 'Save edit'} title="Save (Enter)">
          <Check aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
