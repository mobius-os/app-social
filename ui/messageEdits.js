/** Whether a peer's (or group host's) Social accepts edits to messages. */
export function supportsMessageEdits(actor) {
  return Array.isArray(actor?.features) && actor.features.includes('message_edits')
}

/** Saving the owner's edit to one message, then showing the saved text in place. */
export function useMessageEdits({ timeline, save, showToast }) {
  return async function saveEdit(message, text) {
    const result = await save(message.id, text, crypto.randomUUID())
    timeline.updateMessages(prior => (prior || []).map(row => row.id === message.id ? {
      ...row, text: result.text, edited_at: result.edited_at,
      edit: { pending: Boolean(result.pending), detail: result.detail || '' },
    } : row))
    if (result.pending && result.detail) showToast(result.detail, 'error')
  }
}
