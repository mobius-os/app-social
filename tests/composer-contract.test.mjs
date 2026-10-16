import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { shouldSubmitMessageKey } from '../ui/interactionRules.js'

const composer = readFileSync(new URL('../ui/Composer.jsx', import.meta.url), 'utf8')
const messageInput = readFileSync(new URL('../ui/MessageInput.jsx', import.meta.url), 'utf8')
const thread = readFileSync(new URL('../ui/Thread.jsx', import.meta.url), 'utf8')
const group = readFileSync(new URL('../ui/GroupThread.jsx', import.meta.url), 'utf8')
const timeline = readFileSync(new URL('../ui/useMessageTimeline.jsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../theme.js', import.meta.url), 'utf8')
const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
const shell = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
const media = readFileSync(new URL('../ui/Media.jsx', import.meta.url), 'utf8')

test('single and multiple attachments share the image-only composer tray', () => {
  assert.match(media, /return <SelectedImagesStrip selected=\{\[selected\]\}/)
  assert.doesNotMatch(media, /Photo ready|cn-selected-image/)
  assert.match(media, /disabled=\{disabled\}/)
  assert.match(media, /onOpen\?\.\(image\.previewUrl/)
  for (const source of [timeline, board]) {
    assert.match(source, /<SelectedImages?Strip\b[^\n]*onOpen=\{onOpenImage\}/)
  }
})

test('empty replies show the composer without redundant empty-state copy', () => {
  assert.doesNotMatch(board, /No replies yet|cn-reply-empty/)
  assert.match(board, /replyState === 'loading'/)
  assert.match(board, /replyState === 'error'/)
  assert.match(board, /<ComposerFooter scrollRef=\{replyScrollRef\} className="cn-reply-footer">/)
  assert.match(board, /<div ref=\{replyScrollRef\} className="cn-inline-replies"/)
  assert.doesNotMatch(css, /\.cn-inline-replies:not\(:empty\)\s*\{[^}]*border-bottom:/)
})

test('Community shares the shell-owned scroller for reading, anchoring and composer clearance', () => {
  assert.match(shell, /ref=\{boardScrollRef\}/)
  assert.match(shell, /scrollRef=\{boardScrollRef\}/)
  assert.match(board, /const scroller = scrollRef\.current/)
  assert.match(board, /<ComposerFooter scrollRef=\{scrollRef\}/)
  assert.doesNotMatch(board, /bottomMarkerRef|closest\('\.cn-scroll'\)/)
  assert.match(board, /scroller\.addEventListener\('scroll', trackPosition/)
  assert.match(board, /scroller\.removeEventListener\('scroll', trackPosition/)
  assert.match(board, /prependedScrollTop\(previousTop, previousHeight, scroller\.scrollHeight\)/)
})

test('shared composer keeps MessageInput keyboard semantics and input focus on send', () => {
  assert.match(composer, /<MessageInput\b/)
  assert.match(composer, /onMouseDown=\{keepMessageFocus\}/)
  assert.match(messageInput, /shouldSubmitMessageKey\(event, isTouchPrimary\(\)\)/)
  assert.equal(shouldSubmitMessageKey({ key: 'Enter', nativeEvent: {} }, false), true)
  assert.equal(shouldSubmitMessageKey({ key: 'Enter', nativeEvent: {} }, true), false)
  assert.equal(shouldSubmitMessageKey({ key: 'Enter', ctrlKey: true, nativeEvent: {} }, true), true)
  assert.equal(shouldSubmitMessageKey({ key: 'Enter', nativeEvent: { isComposing: true } }, false), false)
})

test('direct and group threads use the shared overlay without disabling input during sends', () => {
  for (const source of [thread, group]) {
    assert.match(source, /<TimelineComposer timeline=\{timeline\}/)
  }
  for (const source of [timeline]) {
    assert.match(source, /<ComposerFooter scrollRef=\{scrollRef\}>/)
    assert.match(source, /<Composer inputRef=\{inputRef\}/)
    assert.match(source, /disabled=\{processingImage\}/)
    assert.match(source, /sendDisabled=\{sending \|\| processingImage/)
    assert.match(source, /<Composer[^>]*disabled=\{processingImage\}/s)
  }
})

test('footer is transparent and measured, while only long inline replies scroll', () => {
  assert.match(composer, /ResizeObserver\(update\)/)
  assert.match(composer, /scroll\.style\.paddingBottom/)
  assert.match(css, /\.cn-composer-footer\s*\{[^}]*background:\s*transparent;[^}]*pointer-events:\s*none/s)
  assert.match(css, /\.cn-composer-footer::before\s*\{[^}]*linear-gradient/s)
  assert.match(css, /\.cn-inline-thread\s*\{[^}]*max-height:/s)
  assert.doesNotMatch(css, /\.cn-inline-thread\s*\{[^}]*[;\s]height:\s*min\(/s)
  assert.match(css, /\.cn-inline-replies\s*\{[^}]*overflow-y:\s*auto/s)
  assert.match(css, /\.cn-reactions\.is-reply \.cn-reaction-picker\s*\{[^}]*position:\s*relative/s)
})


test('reply overlay inherits shared opacity instead of adding a darker local treatment', () => {
  assert.doesNotMatch(css, /\.cn-inline-thread \.cn-reply-footer::before\s*\{[^}]*background:/s)
  assert.doesNotMatch(css, /\.cn-reply-composer \.cn-composer-pill\s*\{[^}]*background:/s)
})
