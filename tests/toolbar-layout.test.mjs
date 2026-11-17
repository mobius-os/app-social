import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CSS } from '../theme.js'
import { renderLayout } from './helpers/layoutBrowser.mjs'

const chrome = process.env.CHROME_BIN

test('compact toolbar groups navigation against the account without shrinking touch targets', { skip: !chrome && 'CHROME_BIN is not configured' }, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'social-toolbar-'))
  const nav = kind => `<nav class="cn-nav cn-nav-${kind}">${['Community','Chats','People'].map(name=>`<button class="cn-nav-item"><svg></svg><span class="cn-tab-label">${name}</span></button>`).join('')}</nav>`
  try {
    for (const width of [320,426,720,1280]) {
      const file = join(folder, `test-${width}.html`)
      const markup = `<style>:root{--font:sans-serif;--text:#111;--bg:#fff;--border:#ccc}*{box-sizing:border-box}body{margin:0}${CSS}</style><header class="cn-header"><div class="cn-brand"><span class="cn-app-icon"></span><h1 class="cn-title">Social</h1></div>${nav('wide')}${nav('mobile')}<div class="cn-header-chip"><span class="cn-avatar is-small"></span><span>@member</span></div></header><pre id="result"></pre><script>const nav=document.querySelector('.cn-nav-${width<720?'mobile':'wide'}'),r=nav.getBoundingClientRect(),a=document.querySelector('.cn-header-chip').getBoundingClientRect();document.querySelector('#result').textContent=JSON.stringify({width:innerWidth,height:document.querySelector('.cn-header').getBoundingClientRect().height,gap:a.left-r.right,overflow:document.documentElement.scrollWidth>innerWidth,buttons:[...nav.children].map(b=>{const r=b.getBoundingClientRect();return[r.width,r.height]}),labels:[...nav.querySelectorAll('.cn-tab-label')].map(n=>getComputedStyle(n).display)})</script>`
      const source = JSON.stringify(markup).replaceAll('<', '\\u003c')
      writeFileSync(file, `<iframe id="frame" style="width:${width}px;height:860px;border:0"></iframe><pre id="result"></pre><script>const f=document.querySelector('#frame');f.onload=()=>document.querySelector('#result').textContent=f.contentDocument.querySelector('#result').textContent;f.srcdoc=${source}</script>`)
      const geometry = await renderLayout(chrome, file, { width })
      assert.equal(geometry.width,width)
      assert.equal(geometry.overflow,false,JSON.stringify(geometry))
      assert.ok(geometry.gap>=0 && geometry.gap<=8,JSON.stringify(geometry))
      assert.ok(geometry.height<=60,JSON.stringify(geometry))
      assert.ok(geometry.buttons.every(([w,h])=>w>=44 && h>=44),JSON.stringify(geometry))
      assert.ok(geometry.labels.every(d=>width<720?d==='none':d!=='none'))
    }
  } finally { rmSync(folder,{recursive:true,force:true}) }
})
