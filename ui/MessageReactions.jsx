import { useEffect, useRef, useState } from 'react'
import { EmojiAdd, Warning } from '@openai/apps-sdk-ui/components/Icon'
import { isDefinitePrecommitRejection, unconfirmedReactions } from '../message_ui_state.js'
import { BOARD_REACTION_EMOJIS, reactionActionLabel, reactionName } from '../reconciliation.js'
import { FlatEmoji } from './ReactionControls.jsx'

/** Counts and the owner's own state from a stored message's `reactions`. */
export function messageReactionState(message, ownHost) {
  const stored = message?.reactions && typeof message.reactions === 'object' ? message.reactions : {}
  return Object.fromEntries(BOARD_REACTION_EMOJIS.map((emoji) => {
    const hosts = stored[emoji] && typeof stored[emoji] === 'object' ? Object.keys(stored[emoji]) : []
    return [emoji, { count: hosts.length, reacted: Boolean(ownHost) && hosts.includes(ownHost) }]
  }))
}

/** Whether a peer's (or group host's) Social accepts message reactions. */
export function supportsMessageReactions(actor) {
  return Array.isArray(actor?.features) && actor.features.includes('message_reactions')
}

const clockOf = message => JSON.stringify(message?.reaction_clock || {})

/**
 * Optimistic reactions for one conversation. A tap shows at once; the
 * confirmed answer replaces it, and the saved message takes over as soon as a
 * refresh brings a newer copy of it.
 *
 * Every update carries an id chosen here. Like a message send, a lost answer
 * is no proof that the update failed: the reaction stays shown, with a retry
 * that re-sends the same update under the same id, until it is confirmed.
 * Only a definite refusal takes it back.
 */
export function useMessageReactions({ ownHost, send, onError, newId = () => crypto.randomUUID() }) {
  const [overrides, setOverrides] = useState({})
  const [pending, setPending] = useState({})
  const [unconfirmed, setUnconfirmed] = useState({})
  const inFlight = useRef(new Set())
  const settled = useRef(new Set())

  function stateFor(message) {
    const override = overrides[message.id]
    if (override && (pending[message.id] || override.basis === clockOf(message))) return override.state
    return messageReactionState(message, ownHost)
  }

  function unconfirmedFor(message) {
    return unconfirmedReactions(message, unconfirmed[message.id], settled.current)[0] || null
  }

  function forget(messageId, emoji) {
    setUnconfirmed((prior) => {
      if (!prior[messageId]?.[emoji]) return prior
      const { [emoji]: _done, ...rest } = prior[messageId]
      const next = { ...prior, [messageId]: rest }
      if (!Object.keys(rest).length) delete next[messageId]
      return next
    })
  }

  function remember(messageId, update, detail) {
    setUnconfirmed(prior => ({
      ...prior, [messageId]: { ...prior[messageId], [update.emoji]: { ...update, detail } },
    }))
  }

  async function submit(message, update, optimistic) {
    if (inFlight.current.has(message.id)) return
    inFlight.current.add(message.id)
    const basis = clockOf(message)
    if (optimistic) setOverrides(prior => ({ ...prior, [message.id]: { state: optimistic, basis } }))
    setPending(prior => ({ ...prior, [message.id]: true }))
    try {
      const result = await send(message.id, update.emoji, update.on, update.id)
      setOverrides(prior => ({ ...prior, [message.id]: {
        state: messageReactionState({ reactions: result?.reactions }, ownHost), basis,
      } }))
      if (result?.status === 'pending') {
        const detail = result.detail || 'This reaction isn’t confirmed yet.'
        remember(message.id, update, detail)
        onError(new Error(detail))
      } else {
        settled.current.add(update.id)
        forget(message.id, update.emoji)
      }
    } catch (error) {
      if (isDefinitePrecommitRejection(error)) {
        settled.current.add(update.id)
        forget(message.id, update.emoji)
        setOverrides((prior) => {
          const remaining = { ...prior }
          delete remaining[message.id]
          return remaining
        })
      } else {
        // The tap stays shown: it may have arrived. Offer the same update again.
        remember(message.id, update, 'Confirmation was interrupted; this reaction may have arrived.')
      }
      onError(error)
    } finally {
      inFlight.current.delete(message.id)
      setPending((prior) => {
        const remaining = { ...prior }
        delete remaining[message.id]
        return remaining
      })
    }
  }

  async function toggle(message, emoji) {
    const current = stateFor(message)
    const was = current[emoji]
    const next = { ...current, [emoji]: {
      reacted: !was.reacted, count: Math.max(0, was.count + (was.reacted ? -1 : 1)),
    } }
    await submit(message, { emoji, on: !was.reacted, id: newId() }, next)
  }

  async function retry(message) {
    const update = unconfirmedFor(message)
    if (update) await submit(message, { emoji: update.emoji, on: update.on, id: update.id }, null)
  }

  return { stateFor, toggle, retry, unconfirmedFor, pending }
}

/** An unconfirmed own reaction, with one retry, under its message. */
export function ReactionRetryNote({ message, mine, reactions }) {
  const update = reactions.unconfirmedFor(message)
  if (!update) return null
  const busy = Boolean(reactions.pending[message.id])
  return (
    <span className={`cn-delivery-note cn-reaction-note ${mine ? 'is-mine' : 'is-theirs'}`}>
      <button className="cn-failed-note" type="button" disabled={busy} onClick={() => reactions.retry(message)}>
        <Warning aria-hidden="true" />
        {busy ? 'Retrying…' : `${update.on ? 'Reaction' : 'Removed reaction'} ${reactionName(update.emoji)} not confirmed · Retry`}
      </button>
      {update.detail && <span className="cn-delivery-reason">{update.detail}</span>}
    </span>
  )
}

/** The add-reaction button that sits beside a bubble's reply button. */
export function MessageReactButton({ messageId, open, disabled, onToggle }) {
  return (
    <button id={`cn-msg-react-${messageId}`} className="cn-bubble-reply cn-bubble-react" type="button"
            aria-expanded={open} aria-controls={open ? `cn-msg-picker-${messageId}` : undefined}
            disabled={disabled} onClick={onToggle} aria-label="Add reaction">
      <EmojiAdd aria-hidden="true" />
    </button>
  )
}

/** Reaction chips under a bubble, and the picker when it is open. */
export function MessageReactionRow({
  messageId, mine, state, choices, canReact, disabled, open, onClose, onReact,
}) {
  const pickerRef = useRef(null)
  const visible = BOARD_REACTION_EMOJIS.filter(emoji => state[emoji]?.count || state[emoji]?.reacted)

  function close(restoreFocus) {
    onClose()
    if (restoreFocus) document.getElementById(`cn-msg-react-${messageId}`)?.focus({ preventScroll: true })
  }

  useEffect(() => {
    if (!open) return undefined
    pickerRef.current?.querySelector('button')?.focus({ preventScroll: true })
    const dismiss = (event) => {
      const trigger = document.getElementById(`cn-msg-react-${messageId}`)
      if (!pickerRef.current?.contains(event.target) && !trigger?.contains(event.target)) onClose()
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open, messageId, onClose])

  if (!visible.length && !open) return null
  return (
    <div className={`cn-reactions cn-message-reactions ${mine ? 'is-mine' : 'is-theirs'}`} aria-label="Message reactions">
      {visible.map(emoji => (
        <button key={emoji} type="button"
                className={`cn-reaction-chip${state[emoji].reacted ? ' is-reacted' : ''}`}
                disabled={disabled || !canReact} aria-pressed={state[emoji].reacted}
                aria-label={reactionActionLabel(state[emoji], emoji)} onClick={() => onReact(emoji)}>
          <span className="cn-reaction-visual"><FlatEmoji emoji={emoji} />
            {state[emoji].count > 0 && <b>{state[emoji].count}</b>}
          </span>
        </button>
      ))}
      {open && (
        <div ref={pickerRef} id={`cn-msg-picker-${messageId}`} className="cn-reaction-picker"
             role="group" aria-label="Choose a reaction"
             onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); close(true) } }}>
          <span className="cn-reaction-picker-title">Choose a reaction</span>
          <div className="cn-reaction-grid">{choices.map(emoji => (
            <button key={emoji} type="button" className={state[emoji]?.reacted ? 'is-reacted' : ''}
                    disabled={disabled} aria-pressed={Boolean(state[emoji]?.reacted)}
                    aria-label={`${state[emoji]?.reacted ? 'Remove' : 'Add'} ${reactionName(emoji)} reaction`}
                    onClick={() => { onReact(emoji); close(true) }}>
              <FlatEmoji emoji={emoji} />
            </button>
          ))}</div>
        </div>
      )}
    </div>
  )
}
