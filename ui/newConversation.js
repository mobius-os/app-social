// What the New conversation picker does with the people chosen. One person
// opens a direct chat unless "Create a group" is on; two or more always make
// a group; a group can also start with one invitee or with nobody yet.
export const memberLabel = user => (user.handle ? `@${user.handle}` : 'Social member')

export function newConversationPlan({ chosen, asGroup, name, canCreateGroup, created = null, busy = false }) {
  const isGroup = !!created || asGroup || chosen.length > 1
  // A blank name falls back to the members' handles; alone, a name is needed.
  const defaultName = chosen.map(memberLabel).join(', ').slice(0, 80)
  const groupName = name.trim() || defaultName
  const only = chosen[0]
  const action = created ? 'Open group'
    : isGroup ? 'Create group'
    : only ? `Message ${only.handle ? `@${only.handle}` : 'them'}`
    : 'Choose someone'
  const disabled = busy || (!created && (
    isGroup ? !canCreateGroup || !groupName : chosen.length === 0
  ))
  return { isGroup, groupForced: chosen.length > 1, defaultName, groupName, action, disabled }
}
