import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('the host names owner and admins: both get a label and delete-only moderation', () => {
  const board = read('ui/Board.jsx')
  const app = read('index.jsx')
  assert.match(app, /const communityRoles = feedCapabilities\.roles && typeof feedCapabilities\.roles === 'object' \? feedCapabilities\.roles : \{\}/)
  assert.match(app, /communityRoles=\{communityRoles\}/)
  assert.match(board, /const ROLE_LABELS = \{ owner: 'Owner', admin: 'Admin' \}/)
  assert.match(board, /\['owner', 'admin'\]\.includes\(roleOf\(me\.host\)\)/)
  assert.equal(board.match(/<RoleLabel role=\{roleOf\((post|reply)\.host\)\} \/>/g).length, 2)
  // Moderators may delete anyone's post or reply, but edit only their own.
  assert.match(board, /\(mine \|\| moderating\) && !editingPost/)
  assert.match(board, /onEdit=\{mine && authorEdits \?/)
  assert.match(board, /onEdit=\{reply\.host === me\.host && authorEdits \?/)
})

test('only the owner sees role controls, and handing over asks first', () => {
  const people = read('ui/People.jsx')
  const app = read('index.jsx')
  assert.match(people, /const myRole = canMessage && me\?\.host \? roleOf\(me\.host\) : null\n  const isOwner = myRole === 'owner'/)
  assert.match(people, /\{isOwner && \(roleOf\(profile\.host\) === 'admin'/)
  assert.match(people, /confirmHandover \?/)
  assert.match(people, /onClick=\{\(\) => changeRole\(profile, 'owner'\)\}>Make owner</)
  assert.match(app, /onRolesChanged=\{\(\) => loadFeed\(\)\}/)
  assert.match(read('api.js'), /call\('community\/role'/)
})

test('People shows each member’s role, sorted owner first; there is no separate settings popup', () => {
  const people = read('ui/People.jsx')
  const app = read('index.jsx')
  assert.match(people, /sortByRole\(results \|\| \[\], communityRoles\)\.map/)
  assert.match(people, /<RoleLabel role=\{roleOf\(user\.host\)\} \/>/)
  assert.doesNotMatch(app, /CommunitySettings|cn-nav-cog|onCommunitySettings/)
  assert.doesNotMatch(read('mobius.json'), /CommunitySettings/)
})

test('members sort owner first, then admins, then everyone else by handle', async () => {
  const { sortByRole, roleOf } = await import('../ui/communityRoles.js')
  const roles = { 'b.example': 'admin', 'z.example': 'owner' }
  const people = [{ host: 'c.example', handle: 'cat' }, { host: 'b.example', handle: 'bob' },
    { host: 'a.example', handle: 'amy' }, { host: 'z.example', handle: 'zed' }]
  assert.deepEqual(sortByRole(people, roles).map((p) => p.handle), ['zed', 'bob', 'amy', 'cat'])
  assert.equal(roleOf(roles, 'a.example'), null)
  assert.equal(roleOf(roles, 'toString'), null)
})

test('owners and admins ban ordinary members from their People row, not the profile', async () => {
  const people = read('ui/People.jsx')
  const app = read('index.jsx')
  assert.match(app, /const bannedHosts = Array\.isArray\(feedCapabilities\.banned\) \? feedCapabilities\.banned : \[\]/)
  assert.match(app, /bannedHosts=\{bannedHosts\}/)
  assert.match(people, /const canModerate = myRole === 'owner' \|\| myRole === 'admin'/)
  // Never a moderator, and never yourself.
  assert.match(people, /const quickBan = canModerate && !roleOf\(user\.host\) && user\.host !== me\?\.host/)
  assert.match(people, /onClick=\{\(\) => changeBan\(user, !isBanned\(user\.host\)\)\}/)
  // The profile only manages roles, so only the owner sees that section.
  assert.match(people, /\{isOwner && profile\.host !== me\?\.host && \(/)
  assert.doesNotMatch(people, /changeBan\(profile/)
  assert.match(people, /isBanned\(user\.host\) && <span className="cn-role-label is-banned">Banned/)
  assert.match(read('api.js'), /call\('community\/ban'/)
  const { banChangedMessage } = await import('../ui/communityRoles.js')
  assert.equal(banChangedMessage({ handle: 'sam' }, true), '@sam is banned from the Community.')
  assert.equal(banChangedMessage({ handle: 'sam' }, false), '@sam can use the Community again.')
})

test('a banned member is locked out of the whole app', () => {
  const app = read('index.jsx')
  assert.match(app, /if \(bannedFromCommunity\) \{\s*return \(/)
  assert.match(app, /You’ve been banned from this Community/)
  // The lockout comes before any open chat, so a ban closes Chats too.
  assert.ok(app.indexOf('if (bannedFromCommunity) {') < app.indexOf('if (thread && canParticipate) {'))
})

test('the row Ban shows on hover with a pointer and always on touch', () => {
  const theme = read('theme.js')
  assert.match(theme, /\.cn-people-item:hover \.cn-quick-ban, \.cn-people-item:focus-within \.cn-quick-ban \{ opacity: 1; pointer-events: auto; \}/)
  assert.match(theme, /@media \(hover: none\) \{ \.cn-quick-ban \{ opacity: 1; pointer-events: auto; \}/)
})
