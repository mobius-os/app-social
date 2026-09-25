import { useLayoutEffect } from 'react'

// Matches the service limit for direct and group messages.
const MAX_MESSAGE_CHARS = 40000

// A multi-line message box that grows with its text. On a physical keyboard
// Enter sends and Shift+Enter adds a line; touch keyboards keep Enter as a
// newline and send with the button.
export default function MessageInput({ inputRef, value, onChange, disabled }) {
  useLayoutEffect(() => {
    const el = inputRef.current
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value, inputRef])

  function onKeyDown(event) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    if (window.matchMedia('(pointer: coarse)').matches) return
    event.preventDefault()
    event.currentTarget.form.requestSubmit()
  }

  return (
    <textarea ref={inputRef} rows={1} value={value} maxLength={MAX_MESSAGE_CHARS}
              onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown}
              disabled={disabled} placeholder="Message" autoComplete="off" aria-label="Message" />
  )
}
