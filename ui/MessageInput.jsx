import { useLayoutEffect } from 'react'
import { isTouchPrimary, shouldSubmitMessageKey } from './interactionRules.js'
import { TEXT_LIMITS } from '../text_limits.js'

// Phones close the keyboard whenever the message box loses focus, so the box
// stays enabled while a message sends and the send button never takes focus.
// Put this on the send button's onMouseDown: the tap still submits the form.
export function keepMessageFocus(event) {
  event.preventDefault()
}

// A multi-line message box that grows with its text. Physical-keyboard Enter
// sends; touch-keyboard Enter and Shift+Enter add a line. IME composition is
// never interrupted.
export default function MessageInput({
  inputRef, value, onChange, disabled, className, maxLength = TEXT_LIMITS.message,
  maxHeight, placeholder = 'Message', label = placeholder, invalid = false,
}) {
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${maxHeight ? Math.min(el.scrollHeight, maxHeight) : el.scrollHeight}px`
  }, [value, inputRef, maxHeight])

  function onKeyDown(event) {
    if (!shouldSubmitMessageKey(event, isTouchPrimary())) return
    event.preventDefault()
    event.currentTarget.form.requestSubmit()
  }

  return (
    <textarea ref={inputRef} className={className} rows={1} value={value} maxLength={maxLength}
              onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown}
              disabled={disabled} placeholder={placeholder} autoComplete="off" aria-label={label}
              aria-invalid={invalid || undefined} />
  )
}
