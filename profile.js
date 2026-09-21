function timestamp(value, unixSeconds = false) {
  if (value === null || value === undefined || value === '') return null
  const date = unixSeconds ? new Date(Number(value) * 1000) : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const monthYear = new Intl.DateTimeFormat(undefined, {
  month: 'short', year: 'numeric', timeZone: 'UTC',
})

export function membershipDuration(profile) {
  const started = timestamp(profile?.member_since) ?? timestamp(profile?.joined_at, true)
  return started ? `Member since ${monthYear.format(started)}` : 'New member'
}
