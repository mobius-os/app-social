import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const read = name => readFileSync(new URL(`../ui/${name}.jsx`, import.meta.url), 'utf8')

test('pending request rows cannot supply a remote avatar host', () => {
  assert.match(read('Messages'), /<Avatar name=\{item.peer_handle\} host=\{showingRequests \? undefined : item.peer\}/)
})

test('pending DM previews gate actor discovery and every peer avatar until acceptance', () => {
  const source = read('Thread')
  assert.match(source, /if \(requestPending\) return[^\n]*\n\s*getPeer\(peer\)/)
  assert.match(source, /\[peer, requestPending\]/)
  const avatars = source.match(/<Avatar[^>]+>/g)
  assert.equal(avatars.length, 2)
  for (const avatar of avatars) assert.match(avatar, /host=\{requestPending \? undefined : peer\}/)
})

test('pending group previews cannot supply participant avatar hosts', () => {
  const avatars = read('GroupThread').match(/<Avatar[^>]+>/g)
  assert.equal(avatars.length, 1)
  assert.match(avatars[0], /host=\{requestStatus\(currentGroup\) === 'pending' \? undefined : message.author\}/)
})

test('an avatar without a host stops before remote cache lookup', () => {
  const source = read('Board')
  assert.match(source, /if \(!cacheKey\) \{\s*setAvatarUrl\(null\)\s*return[^}]*\}[^}]*\}\s*const record = cachedAvatar\(cacheKey\)/)
})


test('pending group details keep all member avatars local and cannot open invitation search', () => {
  const source = read('GroupDetails')
  assert.match(source, /const accepted = requestStatus\(group\) === 'accepted'/)
  assert.match(source, /const canManage = accepted && group.host/)
  assert.match(source, /if \(!canManage \|\| mode !== 'invite'\) return/)
  const avatars = source.match(/<Avatar[^>]+>/g)
  assert.equal(avatars.length, 2)
  for (const avatar of avatars) assert.match(avatar, /host=\{accepted \? (member|person).host : undefined\}/)
  assert.match(read('GroupThread'), /<GroupDetails group=\{currentGroup\}/)
})
