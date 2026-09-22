function timestamp(value, unixSeconds = false) {
  if (value === null || value === undefined || value === '') return null
  const date = unixSeconds ? new Date(Number(value) * 1000) : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const monthYear = new Intl.DateTimeFormat(undefined, {
  month: 'short', year: 'numeric', timeZone: 'UTC',
})

export const AVATAR_FAILURE_RETRY_MS = 45_000
export const AVATAR_NOT_FOUND_RETRY_MS = 15 * 60_000

export function avatarCacheIsFresh(record, now = Date.now()) {
  if (!record) return false
  if (record.url || record.promise) return true
  if (record.notFoundAt) return now - record.notFoundAt < AVATAR_NOT_FOUND_RETRY_MS
  if (record.failedAt) return now - record.failedAt < AVATAR_FAILURE_RETRY_MS
  return false
}

export function avatarFailureState(error, now = Date.now()) {
  return error?.status === 404
    ? { failedAt: null, notFoundAt: now }
    : { failedAt: now, notFoundAt: null }
}

export function focusProfileReturnTarget(primary, fallback) {
  const target = primary?.isConnected === false ? fallback : (primary || fallback)
  if (!target || typeof target.focus !== 'function') return false
  target.focus()
  return true
}

export function membershipDuration(profile) {
  const started = timestamp(profile?.member_since) ?? timestamp(profile?.joined_at, true)
  return started ? `Member since ${monthYear.format(started)}` : 'New member'
}
