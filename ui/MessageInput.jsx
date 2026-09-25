import { useLayoutEffect } from 'react'

// Matches the server's private-message limit (Slack's hard cap is 40,000).
export const MAX_MESSAGE_CHARS = 40000
const COUNTER_FROM = MAX_MESSAGE_CHARS - 1000
const MAX_INPUT_HEIGHT = 168

// Chat-app convention: on a keyboard, Enter sends and Shift+Enter adds a line.
// Touch keyboards keep Enter as a newline and send with the button.
function enterSends() {
  return !window.matchMedia?.('(pointer: coarse)').matches
}

export default function MessageInput({ inputRef, value, onChange, disabled }) {
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`
  }, [value, inputRef])

  function onKeyDown(event) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    if (!enterSends()) return
    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }

  const remaining = MAX_MESSAGE_CHARS - value.length
  return (
    <div className="cn-compose-field">
      <textarea
        ref={inputRef}
        rows={1}
        value={value}
        maxLength={MAX_MESSAGE_CHARS}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        placeholder="Message"
        autoComplete="off"
        aria-label="Message"
      />
      {value.length > COUNTER_FROM && (
        <span className={`cn-compose-count${remaining === 0 ? ' is-full' : ''}`} aria-live="polite">
          {remaining === 0 ? 'Limit reached' : `${remaining.toLocaleString()} left`}
        </span>
      )}
    </div>
  )
}
