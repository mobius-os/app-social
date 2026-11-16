import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { discoveryExtendsFeed, locateBoardPost, mergeDiscoveredPosts, parseBoardIntent } from '../boardNavigation.js'
import { reactToPost } from '../api.js'
import { confirmedReactions, reactionKey } from '../reconciliation.js'

const id = 'abcdef12-1111'
const replyId = 'abcdef12-2222'

test('board navigation distinguishes legacy, post and reply destinations', () => {
  assert.deepEqual(parseBoardIntent('board'), { postId: null, replyId: null })
  assert.deepEqual(parseBoardIntent(`board:${id}`), { postId: id, replyId: null })
  assert.deepEqual(parseBoardIntent(`board:${id}:${replyId}`), { postId: id, replyId })
  for (const invalid of ['dm:host', 'board:', 'board::abcdef34', 'board:invalid', `board:${id}:invalid`, `board:${id}:${replyId}:extra`]) {
    assert.equal(parseBoardIntent(invalid), null)
  }
})

test('notification finds an unloaded post with the feed’s stable cursor', async () => {
  const requested = []
  const result = await locateBoardPost(id, async cursor => {
    requested.push(cursor)
    return cursor === null
      ? { posts: [{ id: 'new', created_at: 3 }], next_cursor: 'stable' }
      : { posts: [{ id, created_at: 1 }], next_cursor: null }
  }, 1)
  assert.deepEqual(requested, [null, 'stable'])
  assert.equal(result.post.id, id)
  assert.equal(result.posts.length, 2)
  assert.equal(result.nextCursor, null)
  assert.equal(result.hasEarlier, false)
  assert.deepEqual(mergeDiscoveredPosts([{ id: 'scrollback', created_at: 2 }], result.posts).map(p => p.id), ['new', 'scrollback', id])
})

test('notification discovery advances pagination but never rewinds an already-loaded boundary', () => {
  const post = (id, created_at) => ({ id, created_at })
  const current = [post('new', 5), post('old', 2)]
  assert.equal(discoveryExtendsFeed(current, [post('new', 5), post('older', 1)]), true)
  assert.equal(discoveryExtendsFeed(current, [post('new', 5), post('recent', 3)]), false)
  assert.equal(discoveryExtendsFeed(current, [post('old', 2)]), true)
  assert.equal(discoveryExtendsFeed([post('b', 2)], [post('a', 2)]), true)
  assert.equal(discoveryExtendsFeed([post('a', 2)], [post('b', 2)]), false)
})

test('legacy timestamp pages remain supported without cycling forever', async () => {
  const result = await locateBoardPost(id, async cursor => ({ posts: cursor === null ? [{ id: 'new', created_at: 5 }] : [] }), 1)
  assert.equal(result.post, null)
  await assert.rejects(locateBoardPost(id, async () => ({ posts: [{ id: 'new', created_at: 5 }] }), 1), /could not finish/)
})

test('an aborted target cannot reopen after a newer notification', async () => {
  const controller = new AbortController()
  await assert.rejects(locateBoardPost(id, async () => {
    controller.abort()
    return { posts: [{ id }], next_cursor: null }
  }, 30, { signal: controller.signal }), { name: 'AbortError' })
})

test('leaving Community cancels its target before a private notification lookup begins', () => {
  const source = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
  assert.match(source, /function showTab\(next\) \{\s*if \(next !== 'board'\) finishBoardTarget\(\)/)
  assert.match(source, /function selectTab\(next\) \{[\s\S]*?showTab\(next\)/)
  assert.doesNotMatch(source, /setTab\('(messages|people)'\)/)
  for (const kind of ['dm', 'group']) {
    const branch = source.slice(source.indexOf(`else if (kind === '${kind}')`)).split('\n    }')[0]
    assert.match(branch, /showTab\('messages'\)[\s\S]*await api\./)
  }
})

test('reply reactions carry their parent post explicitly; post wire shape stays unchanged', async () => {
  const previous = globalThis.fetch
  const bodies = []
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body))
    return { ok: true, json: async () => ({}) }
  }
  try {
    await reactToPost(id, '🎉')
    await reactToPost(id, '🔥', replyId)
    assert.deepEqual(bodies, [{ post_id: id, emoji: '🎉' }, { post_id: id, emoji: '🔥', reply_id: replyId }])
  } finally { globalThis.fetch = previous }
  assert.notEqual(reactionKey({ postId: id }), reactionKey({ postId: id, replyId }))
})

test('confirmation works for both emoji and legacy heart envelopes', () => {
  assert.deepEqual(confirmedReactions({ likes: 2, liked: true })['❤️'], { count: 2, reacted: true })
  assert.deepEqual(confirmedReactions({ reaction_counts: { '🎉': 3 }, reacted: ['🎉'] })['🎉'], { count: 3, reacted: true })
})
