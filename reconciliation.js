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

// Sending again may confirm a reply already learned from a server snapshot.
// Keep that authoritative row (including its timestamp/reactions), and let
// only an unresolved optimistic row be replaced by a send receipt.
export function upsertReplyAttempt(current, incoming) {
  const confirmed = current.find(reply => reply.id === incoming.id && !reply.pending)
  return [...current.filter(reply => reply.id !== incoming.id), confirmed || incoming]
    .sort(chronological)
}

export function replyActionLabel(count) {
  const replies = Math.max(0, Number(count) || 0)
  if (replies === 0) return 'Reply'
  return `${replies} ${replies === 1 ? 'reply' : 'replies'}`
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

// Every reaction this version can draw, in presentation order; mirrors
// BOARD_REACTION_EMOJIS in common_public.py. ':mobius:' is the Möbius logo.
export const BOARD_REACTION_EMOJIS = [
  '❤️', ':mobius:', '👍', '👎', '😂', '😮', '😢', '😡', '🎉', '🚀', '👀', '🙌', '🔥',
  '✅', '💯', '🤔', '👏', '🙏', '💪', '🤝', '✨', '😍', '🤯', '🫡', '🫶',
  '😊', '🥰', '😎', '🥳', '😭', '😅', '🙃', '😬', '🤗', '🤩', '😴', '🫠',
  '💔', '💙', '💚', '💜', '👋', '✌️', '👌', '💡', '🎯', '🏆', '⭐',
]

// What a host accepted before it advertised its own list. Offering more than
// this to such a host would only produce a refused tap.
const LEGACY_BOARD_REACTIONS = [
  '❤️', '👍', '👎', '😂', '😮', '😢', '😡', '🎉', '🚀', '👀', '🙌', '🔥',
  '✅', '💯', '🤔', '👏', '🙏', '💪', '🤝', '✨', '😍', '🤯', '🫡', '🫶',
]

const REACTION_NAMES = { ':mobius:': 'Möbius logo' }

/** The reactions to offer in the picker: what both this app and the host know. */
export function offeredReactions(capabilities) {
  const advertised = Array.isArray(capabilities?.reactions) ? capabilities.reactions : LEGACY_BOARD_REACTIONS
  const accepted = new Set(advertised)
  return BOARD_REACTION_EMOJIS.filter(emoji => accepted.has(emoji))
}

/** A spoken name: the emoji itself, or the name of a picture reaction. */
export function reactionName(emoji) {
  return REACTION_NAMES[emoji] || emoji
}

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

export function reactionActionLabel(reaction, emoji) {
  const count = Math.max(0, Number(reaction?.count) || 0)
  const action = reaction?.reacted ? 'Remove' : 'Add'
  return `${action} ${reactionName(emoji)} reaction. ${count} ${count === 1 ? 'reaction' : 'reactions'}`
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

export function reactionKey({ postId, replyId }) {
  return replyId ? `${postId}:${replyId}` : postId
}

export function confirmedReactions(result) {
  return Object.fromEntries(BOARD_REACTION_EMOJIS.map(emoji => [emoji, {
    count: Math.max(0, Number(result.reaction_counts?.[emoji]
      ?? (emoji === '❤️' ? result.likes : 0) ?? 0)),
    reacted: Array.isArray(result.reacted)
      ? result.reacted.includes(emoji)
      : emoji === '❤️' && Boolean(result.liked),
  }]))
}

export function boardRefreshDelay(lastActivityAt, now = Date.now()) {
  return now - lastActivityAt < ACTIVE_WINDOW_MS ? 2500 : 15000
}

export function threadRefreshDelay(lastActivityAt, now = Date.now()) {
  return now - lastActivityAt < ACTIVE_WINDOW_MS ? 1500 : 5000
}
