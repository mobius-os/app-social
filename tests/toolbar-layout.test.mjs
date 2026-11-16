import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CSS } from '../theme.js'
import { renderLayout } from './helpers/layoutBrowser.mjs'

const chrome = process.env.CHROME_BIN

// The header as index.jsx renders it: the large title and account chip on one
// row, then one full-width segmented Community / Chats / People control.
const header = cog => `<header class="cn-header"><div class="cn-header-top"><h1 class="cn-title">Social</h1><div class="cn-header-chip"><span class="cn-avatar is-small"></span><span>@member-with-a-long-handle</span></div></div><nav class="cn-nav cn-nav-seg"><span class="cn-nav-slot${cog ? ' has-cog' : ''}"><button class="cn-nav-item is-active"><svg></svg><span class="cn-tab-label">Community</span></button>${cog ? '<button class="cn-nav-cog"><svg></svg></button>' : ''}</span>${['Chats', 'People'].map(name => `<button class="cn-nav-item"><svg></svg><span class="cn-tab-label">${name}</span></button>`).join('')}</nav></header>`

test('header keeps the title, account and segmented tabs in bounds without shrinking touch targets', { skip: !chrome && 'CHROME_BIN is not configured' }, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'social-toolbar-'))
  try {
    for (const cog of [false, true]) {
      for (const width of [320, 426, 720, 1280]) {
        const file = join(folder, `test-${width}-${cog}.html`)
        const markup = `<style>:root{--font:sans-serif;--text:#111;--bg:#fff;--border:#ccc}*{box-sizing:border-box}body{margin:0}${CSS}</style>${header(cog)}<pre id="result"></pre><script>const box=e=>e.getBoundingClientRect(),h=document.querySelector('.cn-header'),cs=getComputedStyle(h),inner=[box(h).left+parseFloat(cs.paddingLeft),box(h).right-parseFloat(cs.paddingRight)],title=box(document.querySelector('.cn-title')),chip=box(document.querySelector('.cn-header-chip')),nav=document.querySelector('.cn-nav-seg'),n=box(nav);document.querySelector('#result').textContent=JSON.stringify({width:innerWidth,height:box(h).height,overflow:document.documentElement.scrollWidth>innerWidth,inner,titleChipGap:chip.left-title.right,chipRight:chip.right,sameRow:Math.abs((chip.top+chip.bottom)/2-(title.top+title.bottom)/2)<8,navBelow:n.top>=Math.max(title.bottom,chip.bottom),nav:[n.left,n.right],buttons:[...nav.querySelectorAll('.cn-nav-item')].map(b=>{const r=box(b);return[r.width,r.height]}),labels:[...nav.querySelectorAll('.cn-tab-label')].map(l=>getComputedStyle(l).display)})</script>`
        const source = JSON.stringify(markup).replaceAll('<', '\\u003c')
        writeFileSync(file, `<iframe id="frame" style="width:${width}px;height:860px;border:0"></iframe><pre id="result"></pre><script>const f=document.querySelector('#frame');f.onload=()=>document.querySelector('#result').textContent=f.contentDocument.querySelector('#result').textContent;f.srcdoc=${source}</script>`)
        const g = await renderLayout(chrome, file, { width })
        const label = JSON.stringify({ cog, ...g })
        assert.equal(g.width, width)
        assert.equal(g.overflow, false, label)
        assert.ok(g.sameRow && g.titleChipGap >= 0 && g.chipRight <= g.inner[1] + 0.5, `title and account share one row: ${label}`)
        assert.ok(g.navBelow, label)
        assert.ok(Math.abs(g.nav[0] - g.inner[0]) < 1 && Math.abs(g.nav[1] - g.inner[1]) < 1, `tabs span the header: ${label}`)
        assert.ok(g.buttons.every(([w, h]) => w >= 44 && h >= 44), label)
        assert.ok(g.labels.every(display => display !== 'none'), `labels show at every width: ${label}`)
        assert.ok(g.height <= 160, label)
      }
    }
  } finally { rmSync(folder, { recursive: true, force: true }) }
})
