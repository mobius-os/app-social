import { editRev } from '../message_ui_state.js'

/** Whether a peer's (or group host's) Social accepts edits to messages. */
export function supportsMessageEdits(actor) {
  return Array.isArray(actor?.features) && actor.features.includes('message_edits')
}

/** The id to save this text under: a pending edit of the same text is resent under its own id. */
export function editIdFor(message, text, newId = () => crypto.randomUUID()) {
  const pending = message?.edit?.pending ? message.edit : null
  return pending && typeof pending.id === 'string' && pending.text === text ? pending.id : newId()
}

/** A saved edit's result, applied only if the view has not already seen a newer edit state. */
export function applyEditResult(row, result) {
  if (editRev(row) > editRev(result)) return row
  return {
    ...row, text: result.text, edited_at: result.edited_at, edit_rev: result.edit_rev,
    edit: { id: result.edit_id, text: result.text, pending: Boolean(result.pending), detail: result.detail || '' },
  }
}

/** Saving the owner's edit to one message, then showing the saved text in place. */
export function useMessageEdits({ timeline, save, showToast }) {
  return async function saveEdit(message, text) {
    const result = await save(message.id, text, editIdFor(message, text))
    timeline.updateMessages(prior => (prior || []).map(row => row.id === message.id ? applyEditResult(row, result) : row))
    if (result.pending && result.detail) showToast(result.detail, 'error')
  }
}
