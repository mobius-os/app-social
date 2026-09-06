export const SHARED_COMMUNITY_HOST = 'mobius.hamzamerzic.info'

function normalized(value) {
  return String(value || '').trim().toLowerCase()
}

export function isSeparateLocalCommunity(profile) {
  const ownHost = normalized(profile?.host)
  return Boolean(
    profile?.joined
      && ownHost
      && ownHost !== SHARED_COMMUNITY_HOST
      && normalized(profile?.community_host) === ownHost,
  )
}

export function shouldAdoptSharedCommunity(profile) {
  const ownHost = normalized(profile?.host)
  return Boolean(
    !profile?.joined
      && ownHost
      && ownHost !== SHARED_COMMUNITY_HOST
      && normalized(profile?.community_host) === ownHost,
  )
}

export async function prepareCommunity(profile, saveProfile) {
  if (!shouldAdoptSharedCommunity(profile)) return profile
  await saveProfile({ community_host: SHARED_COMMUNITY_HOST })
  return { ...profile, community_host: SHARED_COMMUNITY_HOST }
}
