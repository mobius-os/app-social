import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampLightboxScale, MAX_LIGHTBOX_SCALE, MIN_LIGHTBOX_SCALE,
  isTouchPrimary, pinchLightboxScale, prependedScrollTop, shouldSubmitMessageKey,
  TOUCH_PRIMARY_QUERY, wheelLightboxScale,
  gallerySwipeDirection,
} from '../ui/interactionRules.js'

test('gallery swipes require deliberate horizontal movement, not taps or vertical scrolling', () => {
  assert.equal(gallerySwipeDirection(-80, 12), 1)
  assert.equal(gallerySwipeDirection(80, -12), -1)
  assert.equal(gallerySwipeDirection(49, 0), 0)
  assert.equal(gallerySwipeDirection(-80, 100), 0)
  assert.equal(gallerySwipeDirection(0, 0), 0)
})

test('message keyboard rules match Möbius Chat across physical and touch keyboards', () => {
  assert.equal(TOUCH_PRIMARY_QUERY, '(hover: none) and (pointer: coarse)')
  assert.equal(shouldSubmitMessageKey({ key: 'Enter', nativeEvent: {} }, false), true)
  assert.equal(shouldSubmitMessageKey({ key: 'Enter', nativeEvent: {} }, true), false)
  assert.equal(shouldSubmitMessageKey({ key: 'Enter', metaKey: true, nativeEvent: {} }, true), true)
  assert.equal(shouldSubmitMessageKey({ key: 'Enter', ctrlKey: true, nativeEvent: {} }, true), true)
  assert.equal(shouldSubmitMessageKey({ key: 'Enter', shiftKey: true, nativeEvent: {} }), false)
  assert.equal(shouldSubmitMessageKey({
    key: 'Enter', metaKey: true, nativeEvent: { isComposing: true },
  }), false)
  assert.equal(shouldSubmitMessageKey({ key: 'Enter', ctrlKey: true, isComposing: true }), false)
  assert.equal(shouldSubmitMessageKey({ key: ' ', shiftKey: false, nativeEvent: {} }), false)
  assert.equal(shouldSubmitMessageKey(undefined), false)
})

test('touch detection follows the same live pointer query as Möbius Chat', () => {
  let touchPrimary = false
  const frame = {
    matchMedia: (query) => {
      assert.equal(query, TOUCH_PRIMARY_QUERY)
      return { matches: touchPrimary }
    },
    parent: { matchMedia: () => ({ matches: true }) },
  }
  assert.equal(isTouchPrimary(frame), false)
  touchPrimary = true
  assert.equal(isTouchPrimary(frame), true)
})

test('touch detection does not guess from a device name or touch hardware', () => {
  const phone = {
    matchMedia: () => ({ matches: false }),
    navigator: { maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' },
  }
  const touchLaptop = {
    matchMedia: () => ({ matches: false }),
    navigator: { maxTouchPoints: 10, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  }
  assert.equal(isTouchPrimary(phone), false)
  assert.equal(isTouchPrimary(touchLaptop), false)
  assert.equal(isTouchPrimary({ navigator: phone.navigator }), false)
})

test('prepending older messages keeps the message being read at the same viewport position', () => {
  assert.equal(prependedScrollTop(180, 800, 1200), 580)
  assert.equal(prependedScrollTop(0, 800, 1200), 400)
  assert.equal(prependedScrollTop(75, 800, 800), 75)
  assert.equal(prependedScrollTop(75, 800, 700), 75)
})

test('photo zoom stays within its supported range', () => {
  assert.equal(clampLightboxScale(-10), MIN_LIGHTBOX_SCALE)
  assert.equal(clampLightboxScale(2.5), 2.5)
  assert.equal(clampLightboxScale(99), MAX_LIGHTBOX_SCALE)
  assert.equal(clampLightboxScale(Number.NaN), MIN_LIGHTBOX_SCALE)
})

test('wheel and pinch zoom move predictably and clamp at both limits', () => {
  assert.equal(wheelLightboxScale(1, -1), 1.25)
  assert.equal(wheelLightboxScale(1, 1), 1)
  assert.equal(wheelLightboxScale(4, -1), 4)
  assert.equal(pinchLightboxScale(1.5, 100, 200), 3)
  assert.equal(pinchLightboxScale(3, 100, 20), 1)
  assert.equal(pinchLightboxScale(2, 0, 300), 2)
})
