export const SHARED_COMMUNITY_HOST = 'mobius.hamzamerzic.info'

function normalized(value) {
  return String(value || '').trim().toLowerCase()
}

export function needsGlobalJoin(profile) {
  return Boolean(profile?.joined && normalized(profile.community_host) !== SHARED_COMMUNITY_HOST)
}

export async function joinGlobalCommunity(profile, saveProfile, join) {
  let result
  if (normalized(profile?.community_host) !== SHARED_COMMUNITY_HOST) {
    const saved = await saveProfile({ community_host: SHARED_COMMUNITY_HOST })
    // The existing server re-registers joined profiles when their destination changes.
    if (profile?.joined) result = saved
  }
  if (!result) result = await join()
  if (result.directory !== 'registered') {
    throw new Error('Your profile is not listed in global Social yet. Try joining again; your saved conversations are unchanged.')
  }
  return result
}

export async function checkGlobalRegistration(profile, searchPeople) {
  if (!profile.joined || needsGlobalJoin(profile)) return 'not_joined'
  try {
    // Read the owning directory after reload instead of trusting joined_at,
    // which older servers save even when remote registration fails.
    const result = await searchPeople(profile.host)
    return result.users.some(user => normalized(user.host) === normalized(profile.host))
      ? 'registered' : 'missing'
  } catch {
    return 'unavailable'
  }
}
