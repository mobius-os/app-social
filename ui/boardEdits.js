// Pure state rules for author edits and reply deletion on the Board.

// A confirmed post edit shows until the feed delivers that edit or a newer one.
export function withPostEdit(post, edit) {
  if (!edit || typeof edit.edited_at !== 'number') return post
  if (typeof post.edited_at === 'number' && post.edited_at >= edit.edited_at) return post
  return { ...post, text: edit.text, edited_at: edit.edited_at }
}

// Whether a post edit override has been superseded by the feed and can be dropped.
export function postEditSettled(post, edit) {
  return withPostEdit(post, edit) === post
}

export function withoutReply(replies, replyId) {
  return replies.filter((reply) => reply.id !== replyId)
}

// Put a reply back after a failed delete, in creation order, without duplicating it.
export function withRestoredReply(replies, reply) {
  if (replies.some((item) => item.id === reply.id)) return replies
  return [...replies, reply].sort((a, b) => (a.created_at || 0) - (b.created_at || 0))
}

export function withReplyEdit(replies, replyId, edit) {
  return replies.map((reply) => reply.id === replyId
    ? { ...reply, text: edit.text, ...(typeof edit.edited_at === 'number' ? { edited_at: edit.edited_at } : {}) }
    : reply)
}

export function isEditTarget(editing, postId, replyId = null) {
  return Boolean(editing) && editing.postId === postId && (editing.replyId || null) === (replyId || null)
}
