import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { EditPencil, Trash } from '@openai/apps-sdk-ui/components/Icon'

// Edit/Delete for the owner's own post or reply. Pointer devices reveal them on
// hover or keyboard focus (like Slack/Discord); touch devices always show them.
export function OwnActions({ kind, onEdit, onDelete, disabled, compact = false }) {
  return <div className={`cn-own-actions${compact ? ' is-compact' : ''}`}>
    <button type="button" className="cn-own-action" onClick={onEdit} disabled={disabled}
            aria-label={`Edit ${kind}`} title={`Edit ${kind}`}>
      <EditPencil aria-hidden="true" />
    </button>
    <button type="button" className="cn-own-action is-danger" onClick={onDelete} disabled={disabled}
            aria-label={`Delete ${kind}`} title={`Delete ${kind}`}>
      <Trash aria-hidden="true" />
    </button>
  </div>
}

// Inline editor in place of the message text. Enter saves, Shift+Enter adds a
// line, Escape cancels. Text may be emptied only when the item has an image.
export function InlineEditor({ kind = 'message', initial, maxLength, allowEmpty, saving, onSave, onCancel }) {
  const [value, setValue] = useState(initial || '')
  const ref = useRef(null)
  useLayoutEffect(() => {
    const field = ref.current
    if (!field) return
    field.style.height = 'auto'
    field.style.height = `${field.scrollHeight}px`
  }, [value])
  useEffect(() => {
    const field = ref.current
    if (!field) return
    field.focus({ preventScroll: true })
    field.setSelectionRange(field.value.length, field.value.length)
  }, [])
  const trimmed = value.trim()
  const unchanged = trimmed === (initial || '').trim()
  const canSave = !saving && (trimmed || allowEmpty)
  function save() {
    if (!canSave) return
    if (unchanged) { onCancel(); return }
    onSave(trimmed)
  }
  return <div className="cn-inline-edit" onClick={(event) => event.stopPropagation()}>
    <textarea ref={ref} className="cn-inline-edit-field" value={value} rows={1}
              maxLength={maxLength} readOnly={saving} aria-busy={saving} aria-label={`Edit ${kind}`}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!saving) onCancel() }
                else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault(); save()
                }
              }} />
    <div className="cn-inline-edit-bar">
      <span className="cn-inline-edit-hint">
        <kbd>Esc</kbd> to cancel · <kbd>Enter</kbd> to save
      </span>
      <button type="button" className="cn-btn cn-btn-secondary cn-btn-small" onClick={onCancel} disabled={saving}>
        Cancel
      </button>
      <button type="button" className="cn-btn cn-btn-primary cn-btn-small" onClick={save} disabled={!canSave}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  </div>
}

export function EditedMark({ editedAt }) {
  if (!editedAt) return null
  const when = new Date(editedAt * 1000)
  return <span className="cn-edited" title={`Edited ${when.toLocaleString()}`}>(edited)</span>
}
