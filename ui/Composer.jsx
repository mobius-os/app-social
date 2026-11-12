import { Children, useLayoutEffect, useRef } from 'react'
import { ArrowUp, Plus } from '@openai/apps-sdk-ui/components/Icon'
import MessageInput, { keepMessageFocus } from './MessageInput.jsx'
import { clipboardImageFile } from './interactionRules.js'

export function ComposerAttachmentButton({ onClick, disabled, label = 'Attach photo' }) {
  return <button className="cn-composer-attach" type="button" onClick={onClick}
                 onMouseDown={keepMessageFocus} disabled={disabled} aria-label={label}>
    <Plus aria-hidden="true" />
  </button>
}

export default function Composer({
  value, onChange, onSubmit, disabled, sendDisabled, placeholder = 'Message',
  maxLength, label = placeholder, sendLabel = 'Send', inputRef, attachmentAction, gifAction,
  children, className = '', onImagePaste, overLimit = 0,
}) {
  const fallbackRef = useRef(null)
  const textareaRef = inputRef || fallbackRef
  function onPaste(event) {
    if (!onImagePaste || disabled) return
    const file = clipboardImageFile(event.clipboardData)
    if (!file) return
    event.preventDefault()
    onImagePaste(file)
  }
  return <form onPaste={onPaste} className={`cn-composer ${className}`.trim()} onSubmit={onSubmit}>
    {attachmentAction}
    {/* Empty slots (false/null) are not attachments. */}
    <div className={`cn-composer-pill${Children.toArray(children).length ? ' has-children' : ''}`}>
      {children}
      <div className="cn-composer-input-line">
        <MessageInput inputRef={textareaRef} value={value} onChange={onChange}
                      disabled={disabled} placeholder={placeholder} label={label} maxLength={maxLength}
                      invalid={overLimit > 0} />
        {gifAction}
        <button className="cn-composer-send" type="submit" onMouseDown={keepMessageFocus}
                disabled={sendDisabled} aria-label={sendLabel}>
          <ArrowUp aria-hidden="true" />
        </button>
      </div>
      {/* The text with its GIF link is longer than the service accepts. */}
      {overLimit > 0 && <p className="cn-composer-over" role="alert">
        {overLimit === 1 ? '1 character' : `${overLimit.toLocaleString()} characters`} over the limit
      </p>}
    </div>
  </form>
}

// The overlay is transparent and click-through outside its controls. Reserve
// exactly its measured height in the supplied scroller, including multiline
// growth and attachments, so the last item remains reachable underneath it.
export function ComposerFooter({ scrollRef, children, className = '' }) {
  const footerRef = useRef(null)
  useLayoutEffect(() => {
    const footer = footerRef.current
    const scroll = scrollRef?.current
    if (!footer || !scroll) return
    const previous = scroll.style.paddingBottom
    const previousScrollPadding = scroll.style.scrollPaddingBottom
    const base = parseFloat(getComputedStyle(scroll).paddingBottom) || 0
    const update = () => {
      const pinned = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 72
      const safeBottom = parseFloat(getComputedStyle(footer).bottom) || 0
      scroll.style.paddingBottom = `${base + footer.getBoundingClientRect().height + safeBottom + 8}px`
      // Native focus scrolling must treat the overlay as outside the visible area.
      scroll.style.scrollPaddingBottom = scroll.style.paddingBottom
      if (pinned) scroll.scrollTop = scroll.scrollHeight
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(footer)
    return () => {
      observer.disconnect()
      scroll.style.paddingBottom = previous
      scroll.style.scrollPaddingBottom = previousScrollPadding
    }
  }, [scrollRef])
  return <div ref={footerRef} className={`cn-composer-footer ${className}`.trim()}>{children}</div>
}
