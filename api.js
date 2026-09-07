// Common — calls to this instance's federation endpoints. The backend owns
// signing, delivery, and peer verification; the app only ever talks to its
// own server.

let bearer = null
export function setToken(token) { bearer = token }

async function call(path, options = {}, responseType = 'json') {
  const response = await fetch(`/api/common/${path}`, {
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
export const join = () => call('join', { method: 'POST', body: JSON.stringify({}) })
export const saveMe = (settings) =>
  call('me', { method: 'PUT', body: JSON.stringify(settings) })
export const sendMessage = (to, text, peerHandle, attachment, replyTo) =>
  call('send', {
    method: 'POST',
    body: JSON.stringify({
      to,
      text,
      ...(peerHandle ? { peer_handle: peerHandle } : {}),
      ...(attachment ? { attachment } : {}),
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  })
export const publishPost = (text, attachment) =>
  call('publish', {
    method: 'POST',
    body: JSON.stringify({ text, ...(attachment ? { attachment } : {}) }),
  })
export const getFeed = () => call('feed')
export const getBoardMedia = (postId) =>
  call(`board-media/${encodeURIComponent(postId)}`, {}, 'blob')
export const likePost = (postId) =>
  call('like', { method: 'POST', body: JSON.stringify({ post_id: postId }) })
export const getReplies = (postId) =>
  call(`board/${encodeURIComponent(postId)}/replies`)
export const postReply = (postId, text) =>
  call('reply', { method: 'POST', body: JSON.stringify({ post_id: postId, text }) })
export const searchPeople = (q, signal) => call(`people?q=${encodeURIComponent(q.trim().replace(/^@/, ''))}`, { signal })
export const getPeer = (host, signal) => call(`peer/${encodeURIComponent(host)}`, { signal })
export async function getAppIcon(appId) {
  const response = await fetch(`/api/apps/${appId}/icon`, {
    headers: { Authorization: `Bearer ${bearer}` },
  })
  if (!response.ok) throw new Error('icon unavailable')
  return response.blob()
}
export const getPeerAvatar = (host) =>
  call(`peer-avatar/${encodeURIComponent(host)}`, {}, 'blob')

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

export async function listMessages(peer) {
  const store = window.mobius?.storage
  if (!store) return []
  const entries = await store.list(`conversations/${peer}/msgs/`, { includeContent: true })
  const loaded = await Promise.all(
    entries.map((e) => (e.content !== undefined ? e.content : store.get(e.path).catch(() => null)))
  )
  return loaded.filter(Boolean).sort((a, b) => (a.sent_at || 0) - (b.sent_at || 0))
}

async function markConversationRead(path) {
  const store = window.mobius?.storage
  if (!store) return
  const { value: meta, version } = await store.getWithVersion(path)
  if (meta?.unread) await store.durableWrite(path, { ...meta, unread: 0 }, { ifMatch: version })
}

export const clearUnread = peer => markConversationRead(`conversations/${peer}/meta.json`)

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

export async function listGroupMessages(gid) {
  const store = window.mobius?.storage
  if (!store) return []
  const entries = await store.list(`groups/${gid}/msgs/`, { includeContent: true })
  const loaded = await Promise.all(
    entries.map((e) => (e.content !== undefined ? e.content : store.get(e.path)))
  )
  return loaded.filter(Boolean).sort((a, b) => (a.sent_at || 0) - (b.sent_at || 0))
}

export const clearGroupUnread = gid => markConversationRead(`groups/${gid}/meta.json`)

// The creator removes a deleted group from Messages; other members retain history.
export const groupIsVisible = (group, ownHost) => !group.deleted_at || group.host !== ownHost

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

export function clockTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit',
  })
}
