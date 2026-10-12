import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { CSS } from '../theme.js'

test('direct and group chat bubbles use the shared safe link renderer', () => {
  const bubble = readFileSync(new URL('../ui/MessageBubble.jsx', import.meta.url), 'utf8')
  assert.match(bubble, /<RichText className="cn-bubble-copy" text=\{message.text\}/)
  for (const name of ['Thread', 'GroupThread']) {
    assert.match(readFileSync(new URL(`../ui/${name}.jsx`, import.meta.url), 'utf8'), /<MessageBubble/)
  }
})

test('message text and link descendants remain selectable with legible links on both bubble colors', () => {
  assert.match(CSS, /\.cn-bubble-copy \* \{ user-select: text; -webkit-user-select: text;/)
  assert.match(CSS, /\.cn-bubble-copy a \{ color: inherit; text-decoration: underline;/)
  assert.match(CSS, /\.cn-bubble-copy \{[^}]*margin: 0;/)
})

test('selected text stays visible, including inside accent-filled own bubbles', () => {
  const root = CSS.slice(0, CSS.indexOf('/* /mobius-ui:Root */'))
  assert.doesNotMatch(root, /::selection/, 'Social-specific selection rules stay below the shared Root block')
  assert.match(CSS, /\.cn-root ::selection \{ background: color-mix\(in srgb, var\(--accent\) 48%, transparent\); color: var\(--text\); \}/)
  // An accent tint would vanish on the accent fill, so own bubbles invert it.
  assert.match(CSS, /\.cn-bubble\.is-mine ::selection \{ background: var\(--accent-fg\); color: var\(--accent\); \}/)
})
