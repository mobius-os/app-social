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
  assert.match(people, /const isOwner = Boolean\(canMessage && me\?\.host && roleOf\(me\.host\) === 'owner'\)/)
  assert.match(people, /\{isOwner && profile\.host !== me\?\.host && \(/)
  assert.match(people, /confirmHandover \?/)
  assert.match(people, /onClick=\{\(\) => changeRole\(profile, 'owner'\)\}>Make owner</)
  assert.match(app, /onRolesChanged=\{\(\) => loadFeed\(\)\}/)
  assert.match(read('api.js'), /call\('community\/role'/)
})

test('only the owner or an admin gets the Community settings cog', () => {
  const app = read('index.jsx')
  const sheet = read('ui/CommunitySettings.jsx')
  assert.match(app, /const canEditCommunity = canParticipate && \(myRole === 'owner' \|\| myRole === 'admin'\)/)
  // The cog lives inside the Community tab's pill, and only for an owner or admin.
  assert.match(app, /onCommunitySettings=\{canEditCommunity \? \(\) => setCommunitySettingsOpen\(true\) : null\}/)
  assert.match(app, /\{tab === 'board' && onCommunitySettings && \(\s*<button type="button" className="cn-nav-cog" aria-label="Community settings"/)
  assert.match(sheet, /useModalFocus\(true,/)
})

test('Community settings has Permissions; only the owner gets role pickers', () => {
  const sheet = read('ui/CommunitySettings.jsx')
  // A section list whose current entry is marked as the page.
  assert.match(sheet, /permissions: \{ label: 'Permissions'/)
  assert.match(sheet, /aria-current=\{view === key \? 'page' : undefined\}/)
  assert.doesNotMatch(sheet, /role="tab"|role="tablist"|aria-selected/)
  assert.match(sheet, /const isOwner = roleOf\(roles, me\?\.host\) === 'owner'/)
  assert.match(sheet, /\{isOwner && !self && \(/)
  // Choosing Owner asks first; other choices apply at once.
  assert.match(sheet, /if \(next === 'owner'\) setHandover\(person\)/)
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
