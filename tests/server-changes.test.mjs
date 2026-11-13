import test from 'node:test'
import assert from 'node:assert/strict'
import { watchServerChanges } from '../api.js'

const settle = () => new Promise((resolve) => setImmediate(resolve))

function fakeStore() {
  const reads = []
  return { reads, async get(path) { reads.push(path); return { v: reads.length } } }
}

// The Möbius runtime's activity nudge and frame visibility signal.
function shellRuntime(visible = true) {
  const activity = new Set()
  const visibility = new Set()
  return {
    runtimeFeatures: { frameVisibility: true, appActivity: true },
    visible,
    onActivity(cb) {
      activity.add(cb)
      return () => activity.delete(cb)
    },
    onVisibilityChange(cb) {
      visibility.add(cb)
      cb(this.visible)
      return () => visibility.delete(cb)
    },
    nudge() { for (const cb of [...activity]) cb() },
    show(next) {
      this.visible = next
      for (const cb of [...visibility]) cb(next)
    },
    listeners() { return activity.size + visibility.size },
  }
}

test('a Möbius activity nudge checks for new messages at once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const store = fakeStore()
  const mobius = shellRuntime(true)
  const stop = watchServerChanges(store, { mobius })
  mobius.nudge()
  assert.deepEqual(store.reads, ['state/version.json'])
  stop()
  assert.equal(mobius.listeners(), 0)
  mobius.nudge()
  assert.equal(store.reads.length, 1)
})

test('a hidden pane ignores nudges and catches up when shown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const store = fakeStore()
  const mobius = shellRuntime(false)
  const stop = watchServerChanges(store, { mobius })
  mobius.nudge()
  assert.equal(store.reads.length, 0)
  mobius.show(true)
  await settle()
  assert.equal(store.reads.length, 1)
  stop()
})

test('polling remains the fallback, only while visible', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const store = fakeStore()
  const mobius = shellRuntime(true)
  const stop = watchServerChanges(store, { mobius, intervalMs: 5000 })
  t.mock.timers.tick(5000)
  await settle()
  assert.equal(store.reads.length, 1)
  mobius.show(false)
  t.mock.timers.tick(10000)
  await settle()
  assert.equal(store.reads.length, 1)
  stop()
  mobius.show(true)
  t.mock.timers.tick(10000)
  await settle()
  assert.equal(store.reads.length, 1)
})

test('an older Möbius without the nudge keeps polling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const store = fakeStore()
  const mobius = shellRuntime(true)
  delete mobius.onActivity
  const stop = watchServerChanges(store, { mobius, intervalMs: 5000 })
  t.mock.timers.tick(5000)
  await settle()
  assert.equal(store.reads.length, 1)
  stop()
})
