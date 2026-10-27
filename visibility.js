// Background refresh loops that run only while Social is on screen.
//
// The Möbius shell keeps recently used apps loaded but hidden, and a hidden
// frame's document stays "visible". Runtimes that publish
// runtimeFeatures.frameVisibility combine the shell's verdict with the tab's;
// older hosts only offer the document's own visibility.

// Calls `cb(visible)` now and on every change. Returns an unsubscribe function.
export function onFrameVisibility(cb, {
  mobius = globalThis.window?.mobius,
  doc = globalThis.document,
} = {}) {
  if (mobius?.runtimeFeatures?.frameVisibility && typeof mobius.onVisibilityChange === 'function') {
    return mobius.onVisibilityChange(cb)
  }
  const report = () => cb(doc.visibilityState !== 'hidden')
  report()
  doc.addEventListener('visibilitychange', report)
  return () => doc.removeEventListener('visibilitychange', report)
}

// Runs `tick({ resumed })` every `delay()` ms while the frame is visible. The
// first visible report only starts the cadence (the view loads itself on
// mount); a hidden frame makes no requests, and coming back into view ticks at
// once with `resumed: true`. A tick never overlaps another. Returns a stop
// function.
export function pollWhileVisible(tick, delay, options) {
  let timer = null
  let visible = false
  let started = false
  let running = false
  let stopped = false

  function schedule() {
    clearTimeout(timer)
    timer = null
    if (!stopped && visible) timer = setTimeout(() => run(false), delay())
  }

  async function run(resumed) {
    timer = null
    if (stopped || !visible || running) return
    running = true
    try {
      await tick({ resumed })
    } catch {
      // A failed background refresh waits for the next turn of the cadence.
    } finally {
      running = false
      schedule()
    }
  }

  const unsubscribe = onFrameVisibility((next) => {
    if (started && next === visible) return
    const resumed = started && next
    started = true
    visible = next
    if (!visible) {
      clearTimeout(timer)
      timer = null
    } else if (resumed) {
      clearTimeout(timer)
      run(true)
    } else {
      schedule()
    }
  }, options)

  return () => {
    stopped = true
    clearTimeout(timer)
    unsubscribe()
  }
}
