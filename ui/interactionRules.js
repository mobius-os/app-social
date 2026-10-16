export const MIN_LIGHTBOX_SCALE = 1
export const MAX_LIGHTBOX_SCALE = 4
export const LIGHTBOX_ZOOM_STEP = 0.25
export const TOUCH_PRIMARY_QUERY = '(hover: none) and (pointer: coarse)'

export function isTouchPrimary(scope = globalThis) {
  return scope?.matchMedia?.(TOUCH_PRIMARY_QUERY)?.matches === true
}

export function shouldSubmitMessageKey(event, isTouchPrimary = false) {
  return event?.key === 'Enter'
    && !event.shiftKey
    && !event.isComposing
    && !event.nativeEvent?.isComposing
    && Boolean(event.metaKey || event.ctrlKey || !isTouchPrimary)
}

export function prependedScrollTop(previousTop, previousHeight, nextHeight) {
  return Number(previousTop) + Math.max(0, Number(nextHeight) - Number(previousHeight))
}

// Prefer below unless it would clip. On a cramped viewport, keep every
// choice reachable by scrolling the menu rather than moving the post.
export function reactionPickerPlacement(anchor, menuHeight, viewport, gap = 6) {
  const below = Math.max(0, viewport.bottom - anchor.bottom - gap)
  const above = Math.max(0, anchor.top - viewport.top - gap)
  const side = menuHeight > below && above > below ? 'above' : 'below'
  return { side, maxHeight: side === 'above' ? above : below }
}

export function clampLightboxScale(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return MIN_LIGHTBOX_SCALE
  return Math.min(MAX_LIGHTBOX_SCALE, Math.max(MIN_LIGHTBOX_SCALE, numeric))
}

export function wheelLightboxScale(current, deltaY) {
  const direction = Number(deltaY) < 0 ? 1 : -1
  return clampLightboxScale(Number(current) + direction * LIGHTBOX_ZOOM_STEP)
}

export function pinchLightboxScale(startScale, startDistance, currentDistance) {
  const initial = Number(startDistance)
  if (!Number.isFinite(initial) || initial <= 0) return clampLightboxScale(startScale)
  return clampLightboxScale(Number(startScale) * (Number(currentDistance) / initial))
}

// Only deliberate horizontal drags browse images; vertical movement and
// pinch/pan gestures are left to the viewer's own zoom surface.
export function gallerySwipeDirection(dx, dy) {
  return Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy) * 1.5
    ? dx < 0 ? 1 : -1 : 0
}

// Clipboard images use the same preparation path as the photo picker. Text-only
// pastes remain native; chat supports one photo per outgoing message.
export function clipboardImageFile(clipboardData) {
  for (const item of Array.from(clipboardData?.items || [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) return file
  }
  return null
}
