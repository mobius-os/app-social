import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CSS } from '../theme.js'
import { renderLayout } from './helpers/layoutBrowser.mjs'

const chrome = process.env.CHROME_BIN

// Markup mirrors MessageBubble and DeliveryNote: a short own bubble (its reply
// button sits right beside the note), the note, then the next bubble.
const line = (mine, text) => `<div class="cn-message-line ${mine ? 'is-mine' : 'is-theirs'}">${mine ? '' : '<span class="cn-message-avatar"></span>'}<div class="cn-bubble ${mine ? 'is-mine' : 'is-theirs'}"><span class="cn-bubble-copy">${text}</span><span class="cn-bubble-time">12:00</span></div><button class="cn-bubble-reply" type="button">R</button></div>`
const note = '<button class="cn-failed-note" type="button"><svg viewBox="0 0 1 1"></svg>Not delivered · Retry</button>'

test('the failed-delivery note is a 44px target that never covers a neighbouring control', { skip: !chrome && 'CHROME_BIN is not configured' }, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'social-failed-note-'))
  const file = join(folder, 'test.html')
  writeFileSync(file, `<style>:root{--font:sans-serif;--bg:#fff;--surface:#fff;--text:#111;--border:#ccc;--accent:#7048e8;--accent-fg:#fff;--muted:#666;--danger:#c00}*{box-sizing:border-box}body{margin:0;width:390px}${CSS}.cn-bubble{animation:none}.cn-bubble-reply{opacity:1;pointer-events:auto}</style>
    <div class="cn-thread-msgs"><div class="cn-message-log">${line(true, 'hi')}${note}${line(false, 'Next message')}${line(true, 'A longer message of mine that wraps onto a second line here')}${note}${line(true, 'mine again')}</div></div><pre id="result"></pre>
    <script>const r=n=>n.getBoundingClientRect();const overlap=(a,b)=>Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top)&&Math.min(a.right,b.right)>Math.max(a.left,b.left);document.querySelector('#result').textContent=JSON.stringify([...document.querySelectorAll('.cn-failed-note')].map(n=>{const box=r(n),neighbours=[n.previousElementSibling,n.nextElementSibling].flatMap(l=>[...l.querySelectorAll('.cn-bubble,.cn-bubble-reply')]);let missed=0;for(let x=box.left+1;x<box.right;x+=3)for(let y=box.top+1;y<box.bottom;y+=3)if(!n.contains(document.elementFromPoint(x,y)))missed++;return{height:box.height,overlaps:neighbours.filter(t=>overlap(box,r(t))).length,missed,neighboursReachable:neighbours.every(t=>{const b=r(t);return t.contains(document.elementFromPoint((b.left+b.right)/2,b.bottom-1))&&t.contains(document.elementFromPoint((b.left+b.right)/2,b.top+1))})}}))</script>`)
  try {
    const notes = await renderLayout(chrome, file, { width: 390 })
    assert.equal(notes.length, 2)
    for (const result of notes) {
      assert.ok(result.height >= 44, JSON.stringify(result))
      assert.equal(result.overlaps, 0, JSON.stringify(result))
      assert.equal(result.missed, 0, JSON.stringify(result))
      assert.equal(result.neighboursReachable, true, JSON.stringify(result))
    }
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})
