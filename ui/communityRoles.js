// Community roles: an owner and admins; everyone else is a member.
export const ROLE_ORDER = { owner: 0, admin: 1 }

export function roleOf(roles, host) {
  return host && roles && Object.hasOwn(roles, host) ? roles[host] : null
}

/** Owner first, then admins, then members, each alphabetically by handle. */
export function sortByRole(people, roles) {
  const rank = (person) => ROLE_ORDER[roleOf(roles, person.host)] ?? 2
  return [...people].sort((a, b) => rank(a) - rank(b)
    || (a.handle || a.host).localeCompare(b.handle || b.host))
}

export function banChangedMessage(person, banned) {
  const name = person.handle ? `@${person.handle}` : 'This member'
  return banned ? `${name} is banned from the Community.` : `${name} can use the Community again.`
}

export function roleChangedMessage(person, role) {
  const name = person.handle ? `@${person.handle}` : 'They'
  if (role === 'owner') return `${name} is now the Community owner. You’re an admin.`
  if (role === 'admin') return `${name} is now an admin.`
  return `${name} is no longer an admin.`
}
