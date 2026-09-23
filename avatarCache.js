import { getPeerAvatars } from './api.js'
import { avatarBlob, avatarCacheIsFresh, avatarFailureState } from './profile.js'

// A service process has a hard lifetime budget. Eight worst-case guarded
// decodes leave room for transport cleanup before the process deadline.
const AVATAR_BATCH_SIZE = 8
const MAX_IDLE_AVATARS = AVATAR_BATCH_SIZE * 8
const cache = new Map()
const queue = []
let flushActive = false
let accessSequence = 0

const hostKey = (host) => String(host || '').trim().toLowerCase()

function newRecord() {
  return {
    url: null,
    promise: null,
    failedAt: null,
    notFoundAt: null,
    fetchedAt: null,
    generation: 0,
    lastUsed: ++accessSequence,
    listeners: new Set(),
  }
}

function touch(record) {
  record.lastUsed = ++accessSequence
}

function pruneIdleAvatars() {
  if (cache.size <= MAX_IDLE_AVATARS) return
  const idle = [...cache.entries()]
    .filter(([, record]) => !record.promise && record.listeners.size === 0)
    .sort((left, right) => left[1].lastUsed - right[1].lastUsed)
  while (cache.size > MAX_IDLE_AVATARS && idle.length) {
    const [key, record] = idle.shift()
    cache.delete(key)
    if (record.url) URL.revokeObjectURL(record.url)
  }
}

function updateRecord(record, wire, error = null, expectedGeneration = null) {
  if (expectedGeneration !== null && record.generation !== expectedGeneration) return
  touch(record)
  const blob = avatarBlob(wire)
  const oldUrl = record.url
  if (blob?.size) {
    Object.assign(record, {
      url: URL.createObjectURL(blob), failedAt: null, notFoundAt: null,
      fetchedAt: Date.now(),
    })
  } else {
    Object.assign(record, avatarFailureState(error))
    if (error?.status === 404) {
      record.url = null
      record.fetchedAt = null
    }
  }
  record.generation += 1
  for (const listener of record.listeners) listener(record.url)
  if (oldUrl && oldUrl !== record.url) URL.revokeObjectURL(oldUrl)
}

function scheduleFlush() {
  if (flushActive) return
  flushActive = true
  queueMicrotask(async () => {
    try {
      while (queue.length) {
        const jobs = queue.splice(0, AVATAR_BATCH_SIZE)
        let result = null
        try {
          result = await getPeerAvatars(jobs.map(job => job.key))
        } catch {
          // A shared transport failure stays retryable for every host.
        }
        const missing = new Set(result?.missing || [])
        for (const job of jobs) {
          updateRecord(
            job.record,
            result?.avatars?.[job.key],
            { status: missing.has(job.key) ? 404 : 502 },
            job.generation,
          )
          if (job.record.promise === job.promise) job.record.promise = null
          job.resolve()
        }
        pruneIdleAvatars()
      }
    } finally {
      flushActive = false
      if (queue.length) scheduleFlush()
    }
  })
}

export function cachedAvatar(host) {
  const key = hostKey(host)
  const now = Date.now()
  let record = cache.get(key)
  if (avatarCacheIsFresh(record, now)) {
    touch(record)
    return record
  }
  record = record || newRecord()
  let resolveJob
  const promise = new Promise((resolve) => { resolveJob = resolve })
  record.promise = promise
  queue.push({
    key, record, promise, resolve: resolveJob, generation: record.generation,
  })
  cache.set(key, record)
  pruneIdleAvatars()
  scheduleFlush()
  return record
}

export function cachedAvatarUrl(host) {
  return cache.get(hostKey(host))?.url || null
}

export function primeAvatar(host, wire) {
  const key = hostKey(host)
  if (!key) return
  const record = cache.get(key) || newRecord()
  touch(record)
  if (!wire) {
    const oldUrl = record.url
    Object.assign(record, {
      url: null, failedAt: null, notFoundAt: null, fetchedAt: null,
    })
    record.generation += 1
    for (const listener of record.listeners) listener(null)
    if (oldUrl) URL.revokeObjectURL(oldUrl)
    cache.set(key, record)
    pruneIdleAvatars()
    return
  }
  updateRecord(record, wire, { status: 404 })
  cache.set(key, record)
  pruneIdleAvatars()
}

export function subscribeAvatar(record, listener) {
  touch(record)
  record.listeners.add(listener)
  return () => {
    record.listeners.delete(listener)
    pruneIdleAvatars()
  }
}

export function discardAvatar(host, url) {
  const record = cache.get(hostKey(host))
  if (!record || record.url !== url) return
  URL.revokeObjectURL(record.url)
  record.url = null
  record.fetchedAt = null
  record.generation += 1
  for (const listener of record.listeners) listener(null)
  pruneIdleAvatars()
}
