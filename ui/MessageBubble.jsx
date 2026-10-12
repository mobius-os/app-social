import { Reply, X } from '@openai/apps-sdk-ui/components/Icon'
import { MessageImage } from './Media.jsx'
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
}) {
  const canReply = !!onReply && message.status !== 'sending'

  return (
    <div className={`cn-message-line ${mine ? 'is-mine' : 'is-theirs'}${indent ? ' no-avatar' : ''}`}>
      {!mine && <span className="cn-message-avatar">{avatar}</span>}
      <div
        className={`cn-bubble ${mine ? 'is-mine' : 'is-theirs'}${message.status === 'failed' ? ' is-failed' : ''}${message.attachment ? ' has-attachment' : ''}`}
      >
        <Quote reply={message.reply_to} />
        <MessageImage attachment={message.attachment} conversationPath={conversationPath}
                      onOpen={onOpenImage} onUnavailable={onImageUnavailable} />
        {message.text && <RichText className="cn-bubble-copy" text={message.text} />}
        <span className="cn-bubble-time">{message.time}{tick}</span>
      </div>
      {/* One reading order for every bubble; CSS places your own reply first. */}
      {canReply && (
        <button className="cn-bubble-reply" type="button" onClick={onReply}
                aria-label={mine ? 'Reply to your message' : author ? `Reply to ${handleLabel(author)}` : 'Reply to message'}>
          <Reply aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
