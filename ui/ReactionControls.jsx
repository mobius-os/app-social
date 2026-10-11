import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { EmojiAdd, Heart } from '@openai/apps-sdk-ui/components/Icon'
import { reactToPost } from '../api.js'
import {
  BOARD_REACTION_EMOJIS, confirmedReactions, optimisticReactionChange,
  reactionActionLabel, reactionKey, reactionState,
} from '../reconciliation.js'
import { EMOJI_ART } from '../emoji_art.js'
import { reactionPickerPlacement } from './interactionRules.js'

function FlatEmoji({ emoji }) {
  return <img className="cn-flat-emoji" src={EMOJI_ART[emoji]} alt="" aria-hidden="true" draggable="false" />
}

// A single owner for optimistic state and rollback, whether the target is a
// post or a reply. Polling can keep running without erasing an in-flight tap.
export function useBoardReactions({ refreshTarget, onError, onSettled }) {
  const [overrides, setOverrides] = useState({})
  const [pending, setPending] = useState({})
  const inFlight = useRef(new Set())

  async function toggle(item, emoji, target) {
    const key = reactionKey(target)
    if (inFlight.current.has(key)) return
    inFlight.current.add(key)
    const { current, next } = optimisticReactionChange(item, overrides[key], emoji)
    setOverrides(prior => ({ ...prior, [key]: next }))
    setPending(prior => ({ ...prior, [key]: true }))
    try {
      let result
      try {
        result = await reactToPost(target.postId, emoji, target.replyId)
      } catch (error) {
        setOverrides(prior => ({ ...prior, [key]: current }))
        onError(error, target)
        return
      }
      setOverrides(prior => ({ ...prior, [key]: confirmedReactions(result) }))
      onSettled?.(target, emoji)
      // A failed refresh is not a failed write: retain the confirmed reaction.
      let refreshed = false
      try { refreshed = await refreshTarget(target) } catch { /* next poll reconciles */ }
      if (refreshed) setOverrides(prior => {
        const remaining = { ...prior }
        delete remaining[key]
        return remaining
      })
    } finally {
      inFlight.current.delete(key)
      setPending(prior => {
        const remaining = { ...prior }
        delete remaining[key]
        return remaining
      })
    }
  }

  return { overrides, pending, toggle }
}

export default function ReactionControls({
  item, target, override, emojiReactions, canInteract, disabled,
  pickerFor, setPickerFor, onReact, onJoin, scrollRef,
}) {
  const key = reactionKey(target)
  const open = emojiReactions && pickerFor === key
  const rootRef = useRef(null)
  const triggerRef = useRef(null)
  const pickerRef = useRef(null)
  const [placement, setPlacement] = useState(null)
  const reactions = reactionState(item, override)
  const visible = BOARD_REACTION_EMOJIS.filter(emoji => reactions[emoji].count || reactions[emoji].reacted)

  function close(restoreFocus = false) {
    setPickerFor(null)
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true })
  }

  useLayoutEffect(() => {
    const scroll = scrollRef?.current
    const menu = pickerRef.current
    if (!open || target.replyId || !scroll || !menu) return undefined
    const update = () => {
      const bounds = scroll.getBoundingClientRect()
      // ComposerFooter owns this measured clearance, including attachments
      // and multiline growth. Choices must stay above that same boundary.
      const clearance = parseFloat(getComputedStyle(scroll).paddingBottom) || 0
      const next = reactionPickerPlacement(rootRef.current.getBoundingClientRect(),
        menu.scrollHeight + menu.offsetHeight - menu.clientHeight,
        { top: bounds.top, bottom: bounds.bottom - clearance })
      setPlacement(prior => prior?.side === next.side && prior?.maxHeight === next.maxHeight ? prior : next)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(scroll)
    observer.observe(menu)
    // Footer growth changes padding without necessarily resizing the feed.
    const paddingObserver = new MutationObserver(update)
    paddingObserver.observe(scroll, { attributes: true, attributeFilter: ['style'] })
    scroll.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      paddingObserver.disconnect()
      scroll.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [open, scrollRef, target.replyId])

  useEffect(() => {
    if (!open) return undefined
    pickerRef.current?.querySelector('button')?.focus({ preventScroll: !target.replyId })
    const dismiss = event => {
      if (!rootRef.current?.contains(event.target)) setPickerFor(null)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open, setPickerFor, target.replyId])

  function choose(emoji) {
    if (canInteract) onReact(emoji)
    else onJoin()
    close(true)
  }

  return <div ref={rootRef} className={`cn-reactions${target.replyId ? ' is-reply' : ''}`} aria-label={target.replyId ? 'Reply reactions' : 'Post reactions'}>
    {visible.map(emoji => <button key={emoji} type="button"
      id={!emojiReactions && emoji === '❤️' ? `cn-react-${key}` : undefined}
      ref={!emojiReactions && emoji === '❤️' ? triggerRef : undefined}
      className={`cn-reaction-chip${reactions[emoji].reacted ? ' is-reacted' : ''}`}
      onClick={() => canInteract ? onReact(emoji) : onJoin()} disabled={disabled}
      aria-pressed={reactions[emoji].reacted}
      aria-label={canInteract ? reactionActionLabel(reactions[emoji], emoji) : 'Join Social to react'}>
      <span className="cn-reaction-visual"><FlatEmoji emoji={emoji} />
        {reactions[emoji].count > 0 && <b>{reactions[emoji].count}</b>}
      </span>
    </button>)}
    {(emojiReactions || visible.length === 0) && <button ref={triggerRef} id={`cn-react-${key}`}
      type="button" className="cn-react cn-add-reaction" disabled={disabled}
      aria-expanded={emojiReactions ? open : undefined}
      aria-controls={open ? `cn-picker-${key}` : undefined}
      aria-label={!canInteract ? 'Join Social to react' : emojiReactions ? 'Add reaction' : 'Like'}
      onClick={() => !canInteract ? onJoin() : emojiReactions
        ? setPickerFor(open ? null : key) : onReact('❤️')}>
      {emojiReactions ? <EmojiAdd aria-hidden="true" /> : <Heart aria-hidden="true" />}
    </button>}
    {open && <div ref={pickerRef} id={`cn-picker-${key}`}
      className={`cn-reaction-picker${!target.replyId && placement ? ` is-bounded${placement.side === 'above' ? ' is-above' : ''}` : ''}`}
      style={!target.replyId && placement ? { maxHeight: placement.maxHeight } : undefined}
      role="group" aria-label="Choose a reaction" onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); close(true) }
      }}>
      <span className="cn-reaction-picker-title">Choose a reaction</span>
      <div className="cn-reaction-grid">{BOARD_REACTION_EMOJIS.map(emoji => <button
        key={emoji} type="button" className={reactions[emoji].reacted ? 'is-reacted' : ''}
        disabled={disabled} onClick={() => choose(emoji)} aria-pressed={reactions[emoji].reacted}
        aria-label={`${reactions[emoji].reacted ? 'Remove' : 'Add'} ${emoji} reaction`}>
        <FlatEmoji emoji={emoji} />
      </button>)}</div>
    </div>}
  </div>
}
