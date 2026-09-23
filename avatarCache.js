import { getPeerAvatars } from './api.js'
import { avatarBlob, avatarCacheIsFresh, avatarFailureState } from './profile.js'

const AVATAR_BATCH_SIZE = 24
const cache = new Map()
const queue = []
let flushActive = false

const hostKey = (host) => String(host || '').trim().toLowerCase()

function newRecord() {
  return {
    url: null,
    promise: null,
    failedAt: null,
    notFoundAt: null,
    generation: 0,
    mime: null,
    dataB64: null,
    listeners: new Set(),
  }
}

function updateRecord(record, wire, error = null, expectedGeneration = null) {
  if (expectedGeneration !== null && record.generation !== expectedGeneration) return
  if (wire && wire.mime === record.mime && wire.data_b64 === record.dataB64) return
  const blob = avatarBlob(wire)
  const oldUrl = record.url
  if (blob?.size) {
    Object.assign(record, {
      url: URL.createObjectURL(blob), mime: wire.mime, dataB64: wire.data_b64,
      failedAt: null, notFoundAt: null,
    })
  } else if (!record.url) {
    Object.assign(record, avatarFailureState(error))
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
  if (avatarCacheIsFresh(record, now)) return record
  record = record || newRecord()
  let resolveJob
  const promise = new Promise((resolve) => { resolveJob = resolve })
  record.promise = promise
  queue.push({
    key, record, promise, resolve: resolveJob, generation: record.generation,
  })
  cache.set(key, record)
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
  if (!wire) {
    const oldUrl = record.url
    Object.assign(record, {
      url: null, mime: null, dataB64: null,
      failedAt: null, notFoundAt: null,
    })
    record.generation += 1
    for (const listener of record.listeners) listener(null)
    if (oldUrl) URL.revokeObjectURL(oldUrl)
    cache.set(key, record)
    return
  }
  updateRecord(record, wire, { status: 404 })
  cache.set(key, record)
}

export function subscribeAvatar(record, listener) {
  record.listeners.add(listener)
  return () => record.listeners.delete(listener)
}

export function discardAvatar(host, url) {
  const record = cache.get(hostKey(host))
  if (!record || record.url !== url) return
  URL.revokeObjectURL(record.url)
  record.url = null
  record.mime = null
  record.dataB64 = null
  record.generation += 1
  for (const listener of record.listeners) listener(null)
}
