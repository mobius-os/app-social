import { SHARED_COMMUNITY_HOST } from './community.js'

// Social owns signing, delivery, persistence, and peer verification behind
// the platform's reviewed app-service boundary.

let bearer = null
export function setToken(token) { bearer = token }

async function call(path, options = {}, responseType = 'json') {
  const response = await fetch(`/api/services/social/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  })
  if (!response.ok) {
    let detail = ''
    try { detail = (await response.json()).detail || '' } catch { /* opaque */ }
    const error = new Error(detail || `Request failed (${response.status}).`)
    error.status = response.status
    throw error
  }
  if (responseType === 'blob') return response.blob()
  if (responseType === 'none') return null
  return response.json()
}

export const getMe = () => call('me')
export const getBootstrap = () => call(`bootstrap?community_host=${encodeURIComponent(SHARED_COMMUNITY_HOST)}`)
export const join = () => call('join', { method: 'POST', body: JSON.stringify({}) })
export const saveMe = (settings) =>
  call('me', { method: 'PUT', body: JSON.stringify(settings) })
export const sendMessage = (id, to, text, peerHandle, attachment, replyTo) =>
  call('send', {
    method: 'POST',
    body: JSON.stringify({
      id,
      to,
      text,
      ...(peerHandle ? { peer_handle: peerHandle } : {}),
      ...(attachment ? { attachment } : {}),
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  })
export const retryMessage = (peer, id) =>
  call(`conversations/${encodeURIComponent(peer)}/messages/${encodeURIComponent(id)}/retry`, {
    method: 'POST', body: JSON.stringify({}),
  })
export const publishPost = (text, attachment, attachments, thumbnails) =>
  call('publish', {
    method: 'POST',
    body: JSON.stringify({
      text,
      ...(attachment ? { attachment } : {}),
      ...(attachments && attachments.length ? { attachments } : {}),
      ...(thumbnails && thumbnails.length ? { thumbnails } : {}),
    }),
  })
const browseQuery = `community_host=${encodeURIComponent(SHARED_COMMUNITY_HOST)}`
export const BOARD_PAGE_SIZE = 30
export const getFeed = (before = null) => {
  const query = new URLSearchParams({
    community_host: SHARED_COMMUNITY_HOST,
    limit: String(BOARD_PAGE_SIZE),
  })
  if (before) query.set('before', String(before))
  return call(`feed?${query}`)
}
export const getBoardMedia = (postId, index, { thumbnail = false } = {}) =>
  call(
    index === undefined || index === null
      ? `board-media/${encodeURIComponent(postId)}?${browseQuery}&thumbnail=${thumbnail ? 'true' : 'false'}`
      : `board-media/${encodeURIComponent(postId)}/${index}?${browseQuery}&thumbnail=${thumbnail ? 'true' : 'false'}`,
    {}, 'blob',
  )
export const reactToPost = (postId, emoji) =>
  call('reaction', { method: 'POST', body: JSON.stringify({ post_id: postId, emoji }) })
export const deletePost = (postId) =>
  call('delete', { method: 'POST', body: JSON.stringify({ post_id: postId }) })
export const getReplies = (postId) =>
  call(`replies/${encodeURIComponent(postId)}?${browseQuery}`)
export const postReply = (postId, text) =>
  call('reply', { method: 'POST', body: JSON.stringify({ post_id: postId, text }) })
export const searchPeople = (q, signal) => call(`people?q=${encodeURIComponent(q.trim().replace(/^@/, ''))}&${browseQuery}`, { signal })
export const getPeer = (host, signal) => call(`peer/${encodeURIComponent(host)}`, { signal })
export async function getAppIcon(appId) {
  const response = await fetch(`/api/apps/${appId}/icon`, {
    headers: { Authorization: `Bearer ${bearer}` },
  })
  if (!response.ok) throw new Error('icon unavailable')
  return response.blob()
}
export const getPeerAvatars = (hosts) =>
  call('peer-avatars', {
    method: 'POST', body: JSON.stringify({ hosts }),
  })

// ── conversation storage (each side keeps only its own copy) ────────────────

async function listMetadata(prefix) {
  const store = window.mobius?.storage
  if (!store) throw new Error('Conversation storage is unavailable.')
  const entries = await store.list(prefix)
  const directories = entries.filter(entry => entry.type === 'directory')
  const records = await Promise.all(directories.map(entry => store.get(`${prefix}${entry.name}/meta.json`)))
  return records.filter(Boolean)
}

export async function listConversations() {
  return (await listMetadata('conversations/')).sort((a, b) => (b.last_at || 0) - (a.last_at || 0))
}

async function listStoredMessages(prefix) {
  const store = window.mobius?.storage
  if (!store) return []
  const entries = await store.list(prefix, { includeContent: true })
  const loaded = await Promise.all(
    entries.map((e) => (e.content !== undefined ? e.content : store.get(e.path).catch(() => null)))
  )
  return loaded.filter(Boolean).sort((a, b) => (a.sent_at || 0) - (b.sent_at || 0))
}

async function listHistory(path, fallbackPrefix, before) {
  const query = new URLSearchParams({ limit: '50' })
  if (before) query.set('before', before)
  try {
    return await call(`${path}?${query}`)
  } catch (error) {
    // Keep already-cached history readable offline. Online service failures
    // remain visible rather than being mistaken for an empty conversation.
    if (before || error.status) throw error
    return {
      messages: await listStoredMessages(fallbackPrefix),
      next_cursor: null,
    }
  }
}

export const listMessages = (peer, before = null) => listHistory(
  `conversations/${encodeURIComponent(peer)}/messages`,
  `conversations/${peer}/msgs/`,
  before,
)

export const clearUnread = peer =>
  call(`conversations/${encodeURIComponent(peer)}/read`, {
    method: 'POST', body: JSON.stringify({}),
  })
export const acceptMessageRequest = peer =>
  call(`requests/dm/${encodeURIComponent(peer)}/accept`, { method: 'POST', body: JSON.stringify({}) })
export const declineMessageRequest = peer =>
  call(`requests/dm/${encodeURIComponent(peer)}/decline`, { method: 'POST', body: JSON.stringify({}) })
export const blockMessageRequest = peer =>
  call(`requests/dm/${encodeURIComponent(peer)}/block`, { method: 'POST', body: JSON.stringify({}) })

// ── groups ──────────────────────────────────────────────────────────────────

export const createGroup = (name, members) =>
  call('groups', { method: 'POST', body: JSON.stringify({ name, members }) })
export const addGroupMember = (gid, host) =>
  call(`groups/${encodeURIComponent(gid)}/members`, { method: 'POST', body: JSON.stringify({ host }) })
export const deleteGroup = (gid) =>
  call(`groups/${encodeURIComponent(gid)}`, { method: 'DELETE' })
export const sendGroupMessage = (gid, text, attachment, replyTo) =>
  call(`groups/${encodeURIComponent(gid)}/send`, {
    method: 'POST',
    body: JSON.stringify({
      text,
      ...(attachment ? { attachment } : {}),
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  })
export const acceptGroupInvitation = gid =>
  call(`groups/${encodeURIComponent(gid)}/accept`, { method: 'POST', body: JSON.stringify({}) })
export const declineGroupInvitation = gid =>
  call(`groups/${encodeURIComponent(gid)}/decline`, { method: 'POST', body: JSON.stringify({}) })

export const listGroups = () => listMetadata('groups/')

export async function getGroup(gid) {
  // Creation writes metadata on the server. Read that exact record fresh;
  // neither a cached directory nor a background refresh owns navigation.
  const store = window.mobius?.storage
  if (!store) throw new Error('Conversation storage is unavailable.')
  const { value } = await store.getWithVersion(`groups/${gid}/meta.json`)
  if (!value || value.gid !== gid) throw new Error('The group was saved, but could not be opened. Try opening it again.')
  return value
}

export const listGroupMessages = (gid, before = null) => listHistory(
  `groups/${encodeURIComponent(gid)}/messages`,
  `groups/${gid}/msgs/`,
  before,
)

export const clearGroupUnread = gid =>
  call(`groups/${encodeURIComponent(gid)}/read`, {
    method: 'POST', body: JSON.stringify({}),
  })

// The creator removes a deleted group from Messages; other members retain history.
export const groupIsVisible = (group, ownHost) => !group.deleted_at || group.host !== ownHost

// Metadata without an explicit state predates Message Requests and is an
// established conversation. This deliberate interpretation prevents an
// upgrade from moving existing chats back behind consent.
export function requestStatus(item) {
  return ['pending', 'accepted', 'declined', 'blocked'].includes(item?.request_status)
    ? item.request_status
    : 'accepted'
}

// ── helpers ─────────────────────────────────────────────────────────────────

const AVATAR_HUES = [258, 12, 165, 205, 32, 315, 122, 352]
export function avatarHue(host) {
  let hash = 0
  for (const ch of String(host)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return AVATAR_HUES[hash % AVATAR_HUES.length]
}

export function initials(name, host) {
  const source = (name || '').trim() || String(host || '?')
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return source.slice(0, 2).toUpperCase()
}

export function timeAgo(ts) {
  if (!ts) return ''
  const seconds = Math.max(0, Date.now() / 1000 - ts)
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  const date = new Date(ts * 1000)
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function postDateTime(ts) {
  if (!ts) return ''
  return new Date(ts * 1000).toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

export function clockTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit',
  })
}
