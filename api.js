
// Social owns signing, delivery, persistence, and peer verification behind
// the platform's reviewed app-service boundary.

import { noteAvatarDigests, noteBoardAvatarDigests } from './avatarHints.js'

let bearer = null
export function setToken(token) { bearer = token }

async function request(path, options, responseType) {
  const { timeoutMs, ...init } = options
  // The deadline covers the service's work, not time spent waiting its turn.
  const deadline = timeoutMs ? new AbortController() : null
  const timer = deadline ? setTimeout(() => deadline.abort(), timeoutMs) : null
  const signal = deadline && init.signal
    ? AbortSignal.any([init.signal, deadline.signal])
    : deadline?.signal || init.signal
  try {
    const response = await fetch(`/api/services/social/${path}`, {
      ...init,
      ...(signal ? { signal } : {}),
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
    })
    if (!response.ok) {
      let detail = ''
      try { detail = (await response.json()).detail || '' } catch { /* opaque */ }
      const error = new Error(detail || `Request failed (${response.status}).`)
      error.status = response.status
      throw error
    }
    if (responseType === 'blob') return await response.blob()
    if (responseType === 'none') return null
    return await response.json()
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// Möbius runs one private Social request at a time, and on hosts that cannot
// preload the service each one starts a fresh process (about a second), so
// anything queued ahead of a request the owner is waiting on delays it.
// Owner-visible requests go straight out; upkeep (polls, prefetches, read
// receipts, identity reconciliation) waits until no owner-visible request is
// outstanding and then runs one at a time, so at most one upkeep request can
// ever sit ahead of one the owner asked for.
let foregroundInFlight = 0
let backgroundActive = false
const backgroundQueue = []

function abortError() {
  return new DOMException('The request was aborted.', 'AbortError')
}

function pumpBackground() {
  while (!backgroundActive && foregroundInFlight === 0 && backgroundQueue.length) {
    const job = backgroundQueue.shift()
    if (job.signal?.aborted) {
      job.reject(abortError())
      continue
    }
    backgroundActive = true
    job.run().finally(() => {
      backgroundActive = false
      pumpBackground()
    })
  }
}

async function call(path, options = {}, responseType = 'json') {
  const { background = false, ...init } = options
  if (background) {
    return new Promise((resolve, reject) => {
      const job = {
        signal: init.signal,
        reject,
        run: () => request(path, init, responseType).then(resolve, reject),
      }
      init.signal?.addEventListener('abort', () => {
        const index = backgroundQueue.indexOf(job)
        if (index === -1) return
        backgroundQueue.splice(index, 1)
        reject(abortError())
      }, { once: true })
      backgroundQueue.push(job)
      pumpBackground()
    })
  }
  foregroundInFlight += 1
  try {
    return await request(path, init, responseType)
  } finally {
    foregroundInFlight -= 1
    pumpBackground()
  }
}

export const getMe = ({ includeAvatar = true, background = false } = {}) =>
  call(`me?include_avatar=${includeAvatar ? 'true' : 'false'}`, { background })
export const getBootstrap = () => call('bootstrap').then((result) => {
  noteBoardAvatarDigests(result?.feed?.posts)
  return result
})
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
export const BOARD_PAGE_SIZE = 30
export const getFeed = (before = null, { background = false, signal } = {}) => {
  const query = new URLSearchParams({ limit: String(BOARD_PAGE_SIZE) })
  if (before !== null && before !== undefined) query.set('before', String(before))
  return call(`feed?${query}`, { background, signal }).then((result) => {
    noteBoardAvatarDigests(result?.posts)
    return result
  })
}
// `mime` is the type the post records for a full image; it lets Social's
// server ask the community host for the copy the site's CDN keeps.
export const getBoardMedia = (postId, index, { thumbnail = false, mime } = {}) => {
  const path = index === undefined || index === null
    ? `board-media/${encodeURIComponent(postId)}`
    : `board-media/${encodeURIComponent(postId)}/${index}`
  const query = new URLSearchParams({ thumbnail: thumbnail ? 'true' : 'false' })
  if (!thumbnail && mime) query.set('mime', mime)
  return call(`${path}?${query}`, {}, 'blob')
}
export const getReplyMedia = (postId, replyId, { thumbnail = false, mime } = {}) => {
  const query = new URLSearchParams({ thumbnail: thumbnail ? 'true' : 'false' })
  if (!thumbnail && mime) query.set('mime', mime)
  return call(`reply-media/${encodeURIComponent(postId)}/${encodeURIComponent(replyId)}?${query}`, {}, 'blob')
}
export const reactToPost = (postId, emoji, replyId) =>
  call('reaction', { method: 'POST', body: JSON.stringify({
    post_id: postId, emoji, ...(replyId ? { reply_id: replyId } : {}),
  }) })
export const deletePost = (postId) =>
  call('delete', { method: 'POST', body: JSON.stringify({ post_id: postId }) })
export const deleteReply = (postId, replyId) =>
  call('reply/delete', { method: 'POST', body: JSON.stringify({ post_id: postId, reply_id: replyId }) })
export const editBoardText = (postId, text, replyId) =>
  call('edit', { method: 'POST', body: JSON.stringify({
    post_id: postId, text, ...(replyId ? { reply_id: replyId } : {}),
  }) })
export const getReplies = (postId, { background = false } = {}) =>
  call(`replies/${encodeURIComponent(postId)}`, { background }).then((result) => {
    noteAvatarDigests(result?.replies)
    return result
  })
export const postReply = (postId, text, { id, attachment, thumbnail } = {}) =>
  call('reply', { method: 'POST', body: JSON.stringify({
    post_id: postId, text,
    ...(id ? { id } : {}),
    ...(attachment ? { attachment } : {}),
    ...(thumbnail ? { thumbnail } : {}),
  }) })
export const searchPeople = (q, signal, { background = false } = {}) =>
  call(`people?q=${encodeURIComponent(q.trim().replace(/^@/, ''))}`, { signal, background })
    .then((result) => {
      noteAvatarDigests(result?.users)
      return result
    })
export const getPeer = (host, signal, { background = false } = {}) =>
  call(`peer/${encodeURIComponent(host)}`, { signal, background })
export async function getAppIcon(appId) {
  const response = await fetch(`/api/apps/${appId}/icon`, {
    headers: { Authorization: `Bearer ${bearer}` },
  })
  if (!response.ok) throw new Error('icon unavailable')
  return response.blob()
}
export const getPeerAvatars = (hosts, { background = false, digests = {} } = {}) =>
  call('peer-avatars', {
    method: 'POST', body: JSON.stringify({ hosts, avatars: digests }), background,
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

const HISTORY_TIMEOUT_MS = 10_000

function validHistoryPage(value) {
  return value && Array.isArray(value.messages)
    && (value.next_cursor === null || typeof value.next_cursor === 'string')
}

async function listHistory(path, fallbackPrefix, before, { background = false } = {}) {
  const query = new URLSearchParams({ limit: '50' })
  if (before) query.set('before', before)
  try {
    return await call(`${path}?${query}`, { timeoutMs: HISTORY_TIMEOUT_MS, background })
  } catch (error) {
    // Canonical per-message records own offline recovery, so an older
    // first-paint page can never hide a newer saved message.
    if (before || error.status) throw error
    const messages = (await listStoredMessages(fallbackPrefix)).slice(-50)
    if (messages.length) return { messages, next_cursor: null }
    throw error
  }
}

// Social's service rewrites each conversation's newest page at these paths
// whenever one of its messages changes (message_history._publish_latest_page),
// so the page is as current as the saved messages themselves. Möbius storage
// answers from the device copy first and then delivers the server's copy when
// it differs: a watcher paints at once and still receives a message that
// arrived while the app was closed, without waiting for the service.
const directHistoryCachePath = peer => `cache/message-history/dm/${encodeURIComponent(peer)}.json`
const groupHistoryCachePath = gid => `cache/message-history/group/${encodeURIComponent(gid)}.json`

function watchLatestPage(path, onPage) {
  const store = window.mobius?.storage
  if (typeof store?.subscribe !== 'function') return { stop() {}, recheck() {} }
  let active = true
  let subscription = null
  try {
    subscription = store.subscribe(path, (value) => {
      if (active && validHistoryPage(value)) onPage(value)
    })
  } catch {
    return { stop() {}, recheck() {} }
  }
  return {
    stop() {
      active = false
      if (typeof subscription === 'function') subscription()
    },
    // A read revalidates the device copy and notifies the watcher on change.
    recheck() {
      if (active) Promise.resolve(store.get(path)).catch(() => null)
    },
  }
}

export const watchLatestMessages = (peer, onPage) =>
  watchLatestPage(directHistoryCachePath(peer), onPage)
export const watchLatestGroupMessages = (gid, onPage) =>
  watchLatestPage(groupHistoryCachePath(gid), onPage)

export const listMessages = (peer, before = null, options = {}) => listHistory(
  `conversations/${encodeURIComponent(peer)}/messages`,
  `conversations/${peer}/msgs/`,
  before,
  options,
)

// Read receipts are upkeep: nothing on screen waits for them.
export const clearUnread = peer =>
  call(`conversations/${encodeURIComponent(peer)}/read`, {
    method: 'POST', body: JSON.stringify({}), background: true,
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
export const sendGroupMessage = (id, gid, text, attachment, replyTo) =>
  call(`groups/${encodeURIComponent(gid)}/send`, {
    method: 'POST',
    body: JSON.stringify({
      id,
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

export const listGroupMessages = (gid, before = null, options = {}) => listHistory(
  `groups/${encodeURIComponent(gid)}/messages`,
  `groups/${gid}/msgs/`,
  before,
  options,
)

export const clearGroupUnread = gid =>
  call(`groups/${encodeURIComponent(gid)}/read`, {
    method: 'POST', body: JSON.stringify({}), background: true,
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
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
}

export function clockTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
}
