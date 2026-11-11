import { useEffect, useRef, useState } from 'react'
import { EmojiAdd } from '@openai/apps-sdk-ui/components/Icon'
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
 */
export function useMessageReactions({ ownHost, send, onError }) {
  const [overrides, setOverrides] = useState({})
  const [pending, setPending] = useState({})
  const inFlight = useRef(new Set())

  function stateFor(message) {
    const override = overrides[message.id]
    if (override && (pending[message.id] || override.basis === clockOf(message))) return override.state
    return messageReactionState(message, ownHost)
  }

  async function toggle(message, emoji) {
    if (inFlight.current.has(message.id)) return
    inFlight.current.add(message.id)
    const basis = clockOf(message)
    const current = stateFor(message)
    const was = current[emoji]
    const next = { ...current, [emoji]: {
      reacted: !was.reacted, count: Math.max(0, was.count + (was.reacted ? -1 : 1)),
    } }
    setOverrides(prior => ({ ...prior, [message.id]: { state: next, basis } }))
    setPending(prior => ({ ...prior, [message.id]: true }))
    try {
      const result = await send(message.id, emoji, !was.reacted)
      setOverrides(prior => ({ ...prior, [message.id]: {
        state: messageReactionState({ reactions: result?.reactions }, ownHost), basis,
      } }))
    } catch (error) {
      setOverrides(prior => {
        const remaining = { ...prior }
        delete remaining[message.id]
        return remaining
      })
      onError(error)
    } finally {
      inFlight.current.delete(message.id)
      setPending(prior => {
        const remaining = { ...prior }
        delete remaining[message.id]
        return remaining
      })
    }
  }

  return { stateFor, toggle, pending }
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
