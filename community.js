export const SHARED_COMMUNITY_HOST = 'www.mobius.you'

function normalized(value) {
  return String(value || '').trim().toLowerCase()
}

export function needsGlobalJoin() {
  return false
}

export async function joinGlobalCommunity(profile, saveProfile, join) {
  let result
  if (normalized(profile?.community_host) !== SHARED_COMMUNITY_HOST) {
    const saved = await saveProfile({ community_host: SHARED_COMMUNITY_HOST })
    if (profile?.joined) result = saved
  }
  if (!result) result = await join()
  if (result.directory !== 'registered') {
    const detail = result.directory === 'verification_failed'
      ? 'The community host could not verify this Möbius identity. Try joining again; your saved conversations are unchanged.'
      : result.directory === 'rejected'
        ? 'The community host rejected this profile. Try joining again; your saved conversations are unchanged.'
        : 'The community host could not be reached. Try joining again; your saved conversations are unchanged.'
    throw new Error(detail)
  }
  return result
}

export async function checkGlobalRegistration(profile, searchPeople) {
  if (!profile.joined) return 'not_joined'
  try {
    const result = await searchPeople(profile.host)
    return result.users.some(user => normalized(user.host) === normalized(profile.host))
      ? 'registered' : 'missing'
  } catch {
    return 'unavailable'
  }
}
