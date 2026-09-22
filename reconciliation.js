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

function uniquePosts(posts) {
  const seen = new Set()
  return (Array.isArray(posts) ? posts : []).filter((post) => {
    const id = post?.id
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

// A refresh owns only the first page. Its timestamp-only `before` cursor makes
// rows at the final timestamp ambiguous: they may have moved just beyond the
// page rather than been deleted. Keep that boundary and every loaded row below
// it, while replacing the range the response can prove authoritative.
export function reconcileFeedPage(authoritative, current, pageSize) {
  const incoming = Array.isArray(authoritative) ? authoritative : []
  const page = uniquePosts(incoming)
  if (incoming.length < pageSize) return page

  const boundary = Number(incoming.at(-1)?.created_at)
  if (!Number.isFinite(boundary)) {
    return uniquePosts([...page, ...(Array.isArray(current) ? current : [])])
  }

  const retained = (Array.isArray(current) ? current : []).filter((post) => {
    const createdAt = Number(post?.created_at)
    return !Number.isFinite(createdAt) || createdAt <= boundary
  })
  return uniquePosts([...page, ...retained])
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
