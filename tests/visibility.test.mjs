import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { pollWhileVisible } from '../visibility.js'

const settle = () => new Promise((resolve) => setImmediate(resolve))

// The Möbius runtime's frame signal: visible only while the shell shows the
// frame and the tab is visible. It reports at once and on every change.
function shellRuntime(visible = true) {
  const listeners = new Set()
  return {
    runtimeFeatures: { frameVisibility: true },
    visible,
    onVisibilityChange(cb) {
      listeners.add(cb)
      cb(this.visible)
      return () => listeners.delete(cb)
    },
    show(next) {
      this.visible = next
      for (const cb of [...listeners]) cb(next)
    },
  }
}

// A document whose visibilityState never changes while the shell hides the pane.
function documentStub(state = 'visible') {
  const target = new EventTarget()
  target.visibilityState = state
  target.show = (visible) => {
    target.visibilityState = visible ? 'visible' : 'hidden'
    target.dispatchEvent(new Event('visibilitychange'))
  }
  return target
}

function recorder() {
  const calls = []
  const tick = async (info) => { calls.push(info) }
  return { calls, tick }
}

test('a pane the shell hides stops polling and refreshes once when shown again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const mobius = shellRuntime(true)
  const doc = documentStub('visible')
  const { calls, tick } = recorder()
  const stop = pollWhileVisible(tick, () => 5000, { mobius, doc })

  assert.equal(calls.length, 0, 'mounting does not refresh; the view loads itself')
  t.mock.timers.tick(5000)
  await settle()
  assert.deepEqual(calls, [{ resumed: false }])

  mobius.show(false)
  assert.equal(doc.visibilityState, 'visible', 'the document never reports the shell hiding the pane')
  t.mock.timers.tick(60_000)
  await settle()
  assert.equal(calls.length, 1, 'a hidden pane makes no requests')

  mobius.show(true)
  await settle()
  assert.deepEqual(calls.at(-1), { resumed: true }, 'returning to view refreshes at once')
  t.mock.timers.tick(5000)
  await settle()
  assert.equal(calls.length, 3, 'the cadence resumes after the catch-up refresh')
  stop()
})

test('a pane mounted while hidden waits for the shell to show it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const mobius = shellRuntime(false)
  const { calls, tick } = recorder()
  const stop = pollWhileVisible(tick, () => 1000, { mobius, doc: documentStub() })

  t.mock.timers.tick(10_000)
  await settle()
  assert.equal(calls.length, 0)
  mobius.show(true)
  await settle()
  assert.deepEqual(calls, [{ resumed: true }])
  stop()
})

test('older hosts without the frame signal fall back to the tab visibility', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const doc = documentStub('visible')
  const { calls, tick } = recorder()
  const stop = pollWhileVisible(tick, () => 1000, { mobius: {}, doc })

  doc.show(false)
  t.mock.timers.tick(10_000)
  await settle()
  assert.equal(calls.length, 0)
  doc.show(true)
  await settle()
  assert.deepEqual(calls, [{ resumed: true }])
  stop()
})

test('refreshes never overlap and stop ends the loop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const mobius = shellRuntime(true)
  let release = null
  let running = 0
  let most = 0
  let calls = 0
  const stop = pollWhileVisible(async () => {
    calls += 1
    running += 1
    most = Math.max(most, running)
    await new Promise((resolve) => { release = resolve })
    running -= 1
  }, () => 1000, { mobius, doc: documentStub() })

  t.mock.timers.tick(1000)
  await settle()
  assert.equal(calls, 1)
  mobius.show(false)
  mobius.show(true)
  await settle()
  assert.equal(most, 1, 'a return to view during a slow refresh does not start another')
  release()
  await settle()
  t.mock.timers.tick(1000)
  await settle()
  assert.equal(calls, 2)

  stop()
  release()
  await settle()
  t.mock.timers.tick(10_000)
  await settle()
  assert.equal(calls, 2)
})

test('Social background loops gate on the frame, not on document visibility', () => {
  const index = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  assert.match(index, /pollWhileVisible\(\s*\(\) => store\.get\('state\/version\.json'\)/)
  assert.equal((board.match(/pollWhileVisible\(/g) || []).length, 2)
  assert.doesNotMatch(board, /visibilityState|visibilitychange/)
  assert.doesNotMatch(index, /setInterval/)
})
