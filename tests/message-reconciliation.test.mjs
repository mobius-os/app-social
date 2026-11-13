import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  addUnseenMessages, isDefinitePrecommitRejection, loadedBefore, markDeliveryUnknown, mergeMessages,
  reconcileLatestPage, reconcileOlderPage, refreshLoadedRows, settleMessage, unconfirmedReactions,
} from '../message_ui_state.js'

const message = (id, sentAt, status = 'delivered') => ({
  id, sent_at: sentAt, status,
})

test('first successful recovery establishes its older-history cursor', () => {
  const result = reconcileLatestPage(null, {
    messages: [message('new', 2)], next_cursor: 'older-page',
  })
  assert.equal(result.resetCursor, true)
  assert.equal(result.nextCursor, 'older-page')
  assert.deepEqual(result.messages.map(({ id }) => id), ['new'])
})

test('an initially empty thread establishes its older-history cursor', () => {
  const result = reconcileLatestPage([], {
    messages: [message('new', 2)], next_cursor: 'older-page',
  })
  assert.equal(result.resetCursor, true)
  assert.equal(result.nextCursor, 'older-page')
  assert.deepEqual(result.messages.map(({ id }) => id), ['new'])
})

test('overlapping latest refresh preserves already-loaded continuous history', () => {
  const result = reconcileLatestPage([
    message('old', 1), message('boundary', 2),
  ], {
    messages: [message('boundary', 2), message('new', 3)],
    next_cursor: 'newest-page-cursor',
  })
  assert.equal(result.resetCursor, false)
  assert.deepEqual(result.messages.map(({ id }) => id), ['old', 'boundary', 'new'])
})

test('non-overlapping full refresh restarts pagination instead of hiding a gap', () => {
  const result = reconcileLatestPage([
    message('old-a', 1), message('old-b', 2),
  ], {
    messages: [message('new-a', 100), message('new-b', 101)],
    next_cursor: 'restart-here',
  })
  assert.equal(result.resetCursor, true)
  assert.equal(result.nextCursor, 'restart-here')
  assert.deepEqual(result.messages.map(({ id }) => id), ['new-a', 'new-b'])
})

test('gap recovery preserves an ambiguous local submission identity', () => {
  const pending = { ...message('local-pending', 3, 'sending'), _client_retry: true }
  const result = reconcileLatestPage([
    message('old-a', 1), message('old-b', 2), pending,
  ], {
    messages: [message('new-a', 100), message('new-b', 101)],
    next_cursor: 'restart-here',
  })
  assert.equal(result.resetCursor, true)
  assert.deepEqual(result.messages.map(({ id }) => id), [
    'local-pending', 'new-a', 'new-b',
  ])
})

test('gap recovery prefers an authoritative row over its pending copy', () => {
  const pending = { ...message('same', 3, 'sending'), _client_retry: true }
  const result = reconcileLatestPage([message('old', 1), pending], {
    messages: [message('same', 3, 'delivered')], next_cursor: 'restart-here',
  })
  assert.equal(result.resetCursor, true)
  assert.deepEqual(result.messages, [message('same', 3, 'delivered')])
})

test('a pending identity overlap cannot hide an intervening history gap', () => {
  const pending = { ...message('same', 1000, 'sending'), _client_retry: true }
  const result = reconcileLatestPage([
    message('old', 1), pending,
  ], {
    messages: [message('new', 999), message('same', 1000)],
    next_cursor: 'restart-at-999',
  })
  assert.equal(result.resetCursor, true)
  assert.equal(result.nextCursor, 'restart-at-999')
  assert.deepEqual(result.messages.map(({ id }) => id), ['new', 'same'])
})

test('a send settles in place under its one client identity, direct or group', () => {
  const result = settleMessage([
    message('before', 1),
    { ...message('one', 2, 'sending'), _client_retry: true, _retry_attachment: { mime: 'image/png' } },
  ], 'one', { id: 'one', status: 'delivered', failed_members: [] })
  assert.deepEqual(result.map(({ id, status }) => [id, status]), [
    ['before', 'delivered'], ['one', 'delivered'],
  ])
  assert.equal(result[1]._retry_attachment, undefined)
  // The server row has the same id, so a refresh replaces rather than duplicates it.
  assert.equal(mergeMessages(result, [message('one', 2)]).length, 2)
})

test('an interrupted send already polled from the server never shows twice', () => {
  const pending = [{ ...message('one', 2, 'sending'), _client_retry: true, _client_unconfirmed_history: true }]
  const polled = addUnseenMessages(pending, { messages: [message('one', 2, 'delivered')] })
  assert.equal(polled.length, 1)
  const refreshed = reconcileLatestPage(polled, { messages: [message('one', 2, 'delivered')], next_cursor: null })
  assert.deepEqual(refreshed.messages, [message('one', 2, 'delivered')])
})

test('only a definite local rejection restores a draft for a new send', () => {
  assert.equal(isDefinitePrecommitRejection({ status: 409 }), true)
  assert.equal(isDefinitePrecommitRejection({ status: 500 }), false)
  assert.equal(isDefinitePrecommitRejection(new TypeError('lost response')), false)
})

test('an unconfirmed send keeps its id and attachment for a safe retry', () => {
  const photo = { mime: 'image/png', data_b64: 'cGhvdG8=' }
  const pending = [{ id: 'one', status: 'sending', _client_retry: true, _retry_attachment: photo }]
  const [unknown] = markDeliveryUnknown(pending, 'one', 'Confirmation interrupted')
  assert.equal(unknown.id, 'one')
  assert.equal(unknown.status, 'sending')
  assert.equal(unknown.failure, 'Confirmation interrupted')
  assert.equal(unknown._retry_attachment, photo)
  assert.equal(unknown._client_retry, true)
  assert.equal(markDeliveryUnknown([{ id: 'one', status: 'delivered' }], 'one', 'lost')[0].status, 'delivered')
})

test('retry settles an older loaded row without depending on the newest page', () => {
  const result = settleMessage([
    message('old-failed', 1, 'failed'), message('latest', 100),
  ], 'old-failed', { status: 'delivered' })
  assert.deepEqual(result.map(({ id, status }) => [id, status]), [
    ['old-failed', 'delivered'], ['latest', 'delivered'],
  ])
})

test('a successful direct-send response settles before any refresh result', () => {
  const result = settleMessage([
    { ...message('sent', 1, 'sending'), _client_retry: true },
  ], 'sent', { id: 'sent', status: 'delivered' })
  assert.deepEqual(result.map(({ id, status, _client_retry }) => ({
    id, status, _client_retry,
  })), [{ id: 'sent', status: 'delivered', _client_retry: undefined }])
})

test('a failed direct-send response settles to retryable failure immediately', () => {
  const result = settleMessage([
    { ...message('sent', 1, 'sending'), _client_retry: true },
  ], 'sent', { id: 'sent', status: 'failed', detail: 'Peer unavailable' })
  assert.equal(result[0].status, 'failed')
  assert.equal(result[0].failure, 'Peer unavailable')
  assert.equal(result[0]._client_retry, undefined)
})

test('settled local send cannot falsely prove newest-page continuity', () => {
  const settled = settleMessage([
    message('old', 1), {
      ...message('same', 1000, 'sending'),
      _client_retry: true,
      _client_unconfirmed_history: true,
    },
  ], 'same', { id: 'same', status: 'delivered' })
  const result = reconcileLatestPage(settled, {
    messages: [message('remote', 999), message('same', 1000, 'delivered')],
    next_cursor: 'restart-at-999',
  })
  assert.equal(result.resetCursor, true)
  assert.equal(result.nextCursor, 'restart-at-999')
  assert.deepEqual(result.messages, [
    message('remote', 999), message('same', 1000, 'delivered'),
  ])
})

test('deferred older page cannot overwrite a reset pagination chain', () => {
  let generation = 0
  const olderRequestGeneration = generation
  const reset = reconcileLatestPage([
    message('old', 100),
  ], {
    messages: [message('latest', 200)], next_cursor: 'before-200',
  })
  assert.equal(reset.resetCursor, true)
  generation += 1

  const deferred = reconcileOlderPage(reset.messages, {
    messages: [message('earlier', 50)], next_cursor: 'before-50',
  }, olderRequestGeneration, generation)
  assert.equal(deferred, null)
  assert.deepEqual(reset.messages, [message('latest', 200)])
  assert.equal(reset.nextCursor, 'before-200')
})

test('a published first-paint page only adds unseen messages and never rewinds one on screen', () => {
  const shown = [
    { id: 'a', sent_at: 1, status: 'delivered' },
    { id: 'b', sent_at: 2, status: 'delivered' },
  ]
  const olderPage = { messages: [{ id: 'b', sent_at: 2, status: 'sending' }], next_cursor: null }
  assert.equal(addUnseenMessages(shown, olderPage), shown)

  const arrived = { messages: [
    { id: 'b', sent_at: 2, status: 'sending' },
    { id: 'c', sent_at: 3, dir: 'in' },
  ], next_cursor: null }
  assert.deepEqual(addUnseenMessages(shown, arrived), [
    { id: 'a', sent_at: 1, status: 'delivered' },
    { id: 'b', sent_at: 2, status: 'delivered' },
    { id: 'c', sent_at: 3, dir: 'in' },
  ])
})

// 51 saved messages: the newest page holds 50, the oldest arrives on scroll.
const history = Array.from({ length: 51 }, (_, index) => message(`m-${String(index).padStart(2, '0')}`, index + 1))
const reacted = (row, rev = 1) => ({
  ...row, reactions: { '🎉': { 'pal.example': 9 } }, reaction_clock: { 'pal.example 🎉': 9 }, reaction_rev: rev,
})
// The service's newest-first pages, returned in display order like load_page.
function serverPage(rows, cursor) {
  const end = cursor == null ? rows.length : rows.findIndex(row => row.id === cursor)
  const start = Math.max(0, end - 50)
  return { messages: rows.slice(start, end), next_cursor: start > 0 ? rows[start].id : null }
}

test('an older page can never let a stale row hide a newer reaction, in either order', () => {
  const stale = history[0]
  const fresh = reacted(stale)
  const page = { messages: [stale], next_cursor: null }
  // The view already refreshed the row; a deferred older page brings it stale.
  const kept = reconcileOlderPage([fresh, ...history.slice(1)], page, 1, 1)
  assert.deepEqual(kept.messages[0].reactions, fresh.reactions)
  // The view holds it stale; the older page brings the refreshed copy.
  const updated = reconcileOlderPage(history.slice(1).concat(), { messages: [fresh] }, 1, 1)
  assert.deepEqual(updated.messages[0], fresh)
  assert.deepEqual(reconcileOlderPage([stale, ...history.slice(1)], { messages: [fresh] }, 1, 1).messages[0], fresh)
  // A removal is a newer change too: it wins over the older "on" copy.
  const removed = { ...stale, reactions: {}, reaction_clock: { 'pal.example 🎉': 10 }, reaction_rev: 2 }
  assert.deepEqual(mergeMessages([removed], [fresh])[0].reactions, {})
  assert.deepEqual(mergeMessages([fresh], [removed])[0].reactions, {})
})

test('a re-read of loaded history refreshes rows on screen and never adds any', () => {
  const shown = history.slice(10)
  assert.equal(loadedBefore(shown, history[11]), true)
  assert.equal(loadedBefore(shown, history[10]), false)
  assert.equal(loadedBefore([{ ...history[0], _client_retry: true }], history[5]), false)
  const rows = [reacted(history[9]), reacted(history[10])]
  const next = refreshLoadedRows(shown, rows)
  assert.equal(next.length, shown.length)
  assert.deepEqual(next[0].reactions, rows[1].reactions)
  assert.equal(refreshLoadedRows(next, rows), next, 'an unchanged re-read keeps the same rows')
})

const timelineSource = readFileSync(new URL('../ui/useMessageTimeline.jsx', import.meta.url), 'utf8')
function owning(start, end, deps) {
  const a = timelineSource.indexOf(start)
  const b = timelineSource.indexOf(end, a)
  assert.ok(a >= 0 && b > a, `${start} exists`)
  return Function('deps', `with (deps) { return (${timelineSource.slice(a, b).trim()}) }`)(deps)
}

function timeline(server) {
  const deps = {
    messagesRef: { current: null }, refreshRequest: { current: 0 }, paginationGeneration: { current: 0 },
    earlierFailed: { current: false }, refreshExtra: null, onRefreshed() {},
    requests: [],
    loadPage: async (cursor) => { deps.requests.push(cursor); return serverPage(server.rows, cursor) },
    updateMessages: (next) => { deps.messagesRef.current = typeof next === 'function' ? next(deps.messagesRef.current) : next },
    setNextCursor: (cursor) => { deps.nextCursor = cursor },
    setLoadError() {},
    reconcileLatestPage, reconcileOlderPage, loadedBefore, refreshLoadedRows,
  }
  deps.refresh = owning('async function refresh(', '  // The newest page refreshes only', deps)
  deps.refreshLoadedHistory = owning('async function refreshLoadedHistory(', '\n  useEffect(() => {', deps)
  deps.loadEarlier = async () => {
    const generation = deps.paginationGeneration.current
    const page = await deps.loadPage(deps.nextCursor)
    const reconciled = reconcileOlderPage(deps.messagesRef.current, page, generation, deps.paginationGeneration.current)
    deps.updateMessages(reconciled.messages)
    deps.setNextCursor(reconciled.nextCursor)
  }
  return deps
}

test('a reaction on the oldest of 51 loaded messages shows after the next refresh', async () => {
  const server = { rows: history.slice() }
  const view = timeline(server)
  await view.refresh({ replace: true })
  assert.equal(view.messagesRef.current.length, 50)
  await view.loadEarlier()
  assert.equal(view.messagesRef.current.length, 51)
  assert.equal(view.nextCursor, null)

  // Someone reacts to the oldest message; the app's version changes.
  server.rows[0] = reacted(server.rows[0])
  view.requests.length = 0
  await view.refresh({ background: true })
  assert.deepEqual(view.requests, [null, server.rows[1].id], 'the newest page, then the loaded range below it')
  assert.deepEqual(view.messagesRef.current[0].reactions, { '🎉': { 'pal.example': 9 } })
  assert.equal(view.messagesRef.current.length, 51)

  // Removing it shows too, and a view holding only the newest page reads no more.
  server.rows[0] = { ...history[0], reactions: {}, reaction_clock: { 'pal.example 🎉': 10 }, reaction_rev: 2 }
  await view.refresh({ background: true })
  assert.deepEqual(view.messagesRef.current[0].reactions, {})
  const fresh = timeline(server)
  await fresh.refresh({ replace: true })
  fresh.requests.length = 0
  await fresh.refresh({ background: true })
  assert.deepEqual(fresh.requests, [null])
})

test('a superseded refresh never applies its older-range rows', async () => {
  const server = { rows: history.slice() }
  const view = timeline(server)
  await view.refresh({ replace: true })
  await view.loadEarlier()
  server.rows[0] = reacted(server.rows[0])
  const loadPage = view.loadPage
  view.loadPage = async (cursor) => {
    if (cursor) view.refreshRequest.current += 1  // a newer refresh started meanwhile
    return loadPage(cursor)
  }
  await view.refresh({ background: true })
  assert.equal(view.messagesRef.current[0].reactions, undefined)
})

test('own reaction updates still owed are found locally first, then from the saved message', () => {
  const saved = { id: 'm', reaction_updates: {
    '🎉': { id: 'u-1', on: true, pending: true, detail: 'lost' },
    '❤️': { id: 'u-2', on: false, pending: false },
  } }
  assert.deepEqual(unconfirmedReactions(saved, null, new Set()), [{ emoji: '🎉', on: true, id: 'u-1', detail: 'lost' }])
  assert.deepEqual(unconfirmedReactions(saved, null, new Set(['u-1'])), [])
  const local = { '🎉': { emoji: '🎉', on: false, id: 'u-3', detail: 'interrupted' } }
  assert.deepEqual(unconfirmedReactions(saved, local, new Set()).map(update => update.id), ['u-3'])
})
