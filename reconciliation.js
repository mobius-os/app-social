const ACTIVE_WINDOW_MS = 15_000

function chronological(left, right) {
  return Number(left?.created_at || 0) - Number(right?.created_at || 0)
}

// The server owns canonical reply ids. Keep only genuinely in-flight local rows
// while folding a fresh thread snapshot into the rendered conversation.
export function reconcileReplies(authoritative, current) {
  const landed = Array.isArray(authoritative) ? authoritative.filter(Boolean) : []
  const landedIds = new Set(landed.map(reply => reply?.id).filter(Boolean))
  const pending = (Array.isArray(current) ? current : []).filter(reply => (
    reply?.pending && !landedIds.has(reply.id)
  ))
  return [...landed, ...pending].sort(chronological)
}

export const BOARD_REACTION_EMOJIS = [
  '❤️', '👍', '👎', '😂', '😮', '😢', '😡', '🎉', '🚀', '👀', '🙌', '🔥',
  '✅', '💯', '🤔', '👏', '🙏', '💪', '🤝', '✨', '😍', '🤯', '🫡', '🫶',
]

export function reactionState(post, override) {
  if (override) return override
  const state = Object.fromEntries(BOARD_REACTION_EMOJIS.map(emoji => [emoji, {
    count: 0, reacted: false,
  }]))
  for (const item of Array.isArray(post?.reactions) ? post.reactions : []) {
    if (!state[item?.emoji]) continue
    state[item.emoji] = {
      count: Math.max(0, Number(item.count || 0)),
      reacted: Boolean(item.reacted),
    }
  }
  if (!state['❤️'].count && post?.like_count) {
    state['❤️'] = {
      count: Math.max(0, Number(post.like_count || 0)),
      reacted: Boolean(post.liked),
    }
  }
  return state
}

export function optimisticReactionChange(post, override, emoji) {
  const current = reactionState(post, override)
  const item = current[emoji] || { count: 0, reacted: false }
  return {
    current,
    next: {
      ...current,
      [emoji]: {
        reacted: !item.reacted,
        count: Math.max(0, item.count + (item.reacted ? -1 : 1)),
      },
    },
  }
}

export function boardRefreshDelay(lastActivityAt, now = Date.now()) {
  return now - lastActivityAt < ACTIVE_WINDOW_MS ? 2500 : 15000
}

export function threadRefreshDelay(lastActivityAt, now = Date.now()) {
  return now - lastActivityAt < ACTIVE_WINDOW_MS ? 1500 : 5000
}
