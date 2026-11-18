// Who may do what in a group, as the member UI sees it. The group's host
// enforces the same rules; this only decides which controls to offer.

const sameHost = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase()

export function groupRole(group, host) {
  if (sameHost(host, group?.host)) return 'creator'
  const member = (group?.members || []).find(entry => sameHost(entry.host, host))
  if (!member) return 'none'
  return member.role === 'admin' ? 'admin' : 'member'
}

export function canManageGroup(group, me) {
  if (!group || group.deleted_at || group.removed_at) return false
  // Older copies have no request status; they were accepted conversations.
  if (['pending', 'declined', 'blocked'].includes(group.request_status)) return false
  const role = groupRole(group, me?.host)
  return role === 'creator' || role === 'admin'
}

// The actions one manager may take on one member's row.
export function memberActions(group, me, member) {
  if (!canManageGroup(group, me) || sameHost(member.host, me?.host)) return []
  const mine = groupRole(group, me?.host)
  const theirs = groupRole(group, member.host)
  if (theirs === 'creator') return []
  if (mine === 'creator') return [theirs === 'admin' ? 'remove_admin' : 'make_admin', 'remove']
  return theirs === 'member' ? ['remove'] : []
}

export const roleLabel = role => role === 'creator' ? 'Creator' : role === 'admin' ? 'Admin' : ''
