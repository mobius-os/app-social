import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CSS } from '../theme.js'
import { renderLayout } from './helpers/layoutBrowser.mjs'

const chrome = process.env.CHROME_BIN
// Three recent reactions, the full picker, Reply and More: an incoming
// message's whole toolbar (Edit is only offered on your own messages).
const tools = `${'<button class="cn-msg-tool"><svg></svg></button>'.repeat(4)}<button class="cn-bubble-reply"><svg></svg></button><span class="cn-msg-more"><button class="cn-msg-tool"><svg></svg></button></span>`
const line = (side, text) => `<div class="cn-message-line is-${side}">${side === 'theirs' ? '<span class="cn-message-avatar"></span>' : ''}<div class="cn-bubble-wrap"><div class="cn-bubble is-${side}"><span class="cn-bubble-copy">${text}</span><span class="cn-bubble-time">14:05</span></div><div class="cn-msg-toolbar is-open" role="toolbar">${tools}</div></div></div>`
const long = 'A longer incoming message that wraps across several lines in the conversation. '.repeat(3)

test('message toolbars stay inside the conversation for short and long messages', { skip: !chrome && 'CHROME_BIN is not configured' }, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'social-msg-toolbar-'))
  try {
    for (const touch of [false, true]) {
      // Phones use 44 px controls (the hover:none rule), mice 32 px. Headless
      // Chrome may match either, so each pass sets its size explicitly.
      const size = touch ? 44 : 32
      const touchCss = `.cn-msg-tool,.cn-msg-toolbar .cn-bubble-reply{width:${size}px;height:${size}px}`
      for (const width of [320, 390, 1280]) {
        const file = join(folder, `test-${width}-${touch}.html`)
        writeFileSync(file, `<style>:root{--font:sans-serif;--text:#111;--bg:#fff;--surface:#fff;--border:#ccc}*{box-sizing:border-box}body{margin:0}${CSS}${touchCss}</style>
          <div class="cn-thread" style="height:860px"><div class="cn-thread-msgs"><div class="cn-message-log" style="padding-top:60px">${line('theirs', long)}${line('theirs', 'Hi')}${line('mine', long)}${line('mine', 'Ok')}</div></div></div><pre id="result"></pre>
          <script>const lines=[...document.querySelectorAll('.cn-message-line')].map(l=>{const t=l.querySelector('.cn-msg-toolbar').getBoundingClientRect(),b=l.querySelector('.cn-bubble').getBoundingClientRect();return{left:Math.min(...[...l.querySelectorAll('.cn-msg-toolbar button')].map(n=>n.getBoundingClientRect().left)),right:Math.max(...[...l.querySelectorAll('.cn-msg-toolbar button')].map(n=>n.getBoundingClientRect().right)),height:t.height,above:t.top<b.top}});document.querySelector('#result').textContent=JSON.stringify({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,lines})</script>`)
        const geometry = await renderLayout(chrome, file, { width })
        const label = JSON.stringify({ width, touch, geometry })
        assert.equal(geometry.width, width)
        assert.equal(geometry.overflow, false, label)
        for (const toolbar of geometry.lines) {
          assert.ok(toolbar.left >= 0 && toolbar.right <= width, label)
          // Narrower than the toolbar (320 px with 44 px controls), it wraps rather than leave the conversation.
          if (width >= 390) assert.ok(toolbar.height <= (touch ? 52 : 40), `one row of controls: ${label}`)
          assert.ok(toolbar.above, `toolbar sits at the bubble's top edge: ${label}`)
        }
      }
    }
  } finally { rmSync(folder, { recursive: true, force: true }) }
})
