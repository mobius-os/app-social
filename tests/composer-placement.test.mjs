import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CSS } from '../theme.js'
import { reactionPickerPlacement } from '../ui/interactionRules.js'
import { renderLayout } from './helpers/layoutBrowser.mjs'

test('reaction menus stay below a top post and above a bottom post', () => {
  const viewport = { top: 52, bottom: 720 }
  assert.deepEqual(reactionPickerPlacement({ top: 100, bottom: 144 }, 230, viewport),
    { side: 'below', maxHeight: 570 })
  assert.deepEqual(reactionPickerPlacement({ top: 660, bottom: 704 }, 230, viewport),
    { side: 'above', maxHeight: 602 })
})

test('a cramped viewport bounds the picker on the roomier side', () => {
  assert.deepEqual(reactionPickerPlacement({ top: 180, bottom: 224 }, 230,
    { top: 52, bottom: 280 }), { side: 'above', maxHeight: 122 })
  assert.deepEqual(reactionPickerPlacement({ top: 60, bottom: 104 }, 230,
    { top: 52, bottom: 280 }), { side: 'below', maxHeight: 170 })
})

test('startup allows drafting without impersonating a member or sending before access is known', () => {
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  assert.match(board, /canInteract \|\| accountState === 'loading' \? <>/)
  assert.doesNotMatch(board, /accountState === 'loading' \? null/)
  assert.match(board, /sendDisabled=\{!canInteract \|\|/)
  assert.match(board, /disabled=\{!canInteract \|\| posting \|\| selectedImages/)
  assert.match(board, /async function submitPost\(event\) \{\s*event\?\.preventDefault\(\)\s*if \(canInteract\) await publish\(\)/)
  assert.match(board, /<div className="cn-board-join">/)
})

test('picker tracks the feed clearance and keeps reply menus in flow', () => {
  const controls = readFileSync(new URL('../ui/ReactionControls.jsx', import.meta.url), 'utf8')
  assert.match(controls, /useLayoutEffect\(/)
  assert.match(controls, /if \(!open \|\| target\.replyId \|\| !scroll \|\| !menu\)/)
  assert.match(controls, /bottom: bounds\.bottom - clearance/)
  assert.match(controls, /scroll\.addEventListener\('scroll', update/)
  assert.match(controls, /scroll\.removeEventListener\('scroll', update/)
  assert.match(controls, /paddingObserver\.disconnect\(\)/)
})

test('one-line text is centered, multiline send stays low, and bottom picker choices remain reachable', {
  skip: !process.env.CHROME_BIN && 'CHROME_BIN is not configured',
}, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'social-composer-placement-'))
  const file = join(folder, 'test.html')
  const composer = (id, height) => `<form id="${id}" class="cn-composer"><button class="cn-composer-attach"><svg></svg></button><div class="cn-composer-pill"><div class="cn-composer-input-line"><textarea rows="1" style="height:${height}px">Draft</textarea><button class="cn-composer-send">Send</button></div></div></form>`
  writeFileSync(file, `<style>:root{--font:sans-serif;--bg:#fff;--surface:#fff;--text:#111;--border:#ccc}*{box-sizing:border-box}body{margin:0}${CSS}.cn-reaction-picker{animation:none}.cn-reactions{position:absolute;left:16px;top:340px;width:288px;height:44px}</style>
    ${composer('one',32)}${composer('many',100)}
    <div class="cn-reactions"><div class="cn-reaction-picker is-above is-bounded" style="max-height:160px"><span class="cn-reaction-picker-title">Choose a reaction</span><div class="cn-reaction-grid">${Array.from({ length: 24 }, () => '<button>R</button>').join('')}</div></div></div><pre id="result"></pre>
    <script>const rect=n=>n.getBoundingClientRect();const rows=['one','many'].map(id=>{const form=document.getElementById(id),input=rect(form.querySelector('textarea')),pill=rect(form.querySelector('.cn-composer-pill')),sendButton=form.querySelector('.cn-composer-send'),send={bottom:rect(sendButton).bottom-parseFloat(getComputedStyle(sendButton,'::before').bottom)},plus=rect(form.querySelector('svg'));return{inputCenter:(input.top+input.bottom)/2,pillCenter:(pill.top+pill.bottom)/2,inputBottom:input.bottom,sendBottom:send.bottom,sendTarget:rect(sendButton).height,plusWidth:plus.width}});const menu=document.querySelector('.cn-reaction-picker'),trigger=rect(document.querySelector('.cn-reactions')),before=rect(menu);menu.scrollTop=menu.scrollHeight;const last=rect(menu.querySelector('button:last-child')),after=rect(menu);document.getElementById('result').textContent=JSON.stringify({rows,menuTop:before.top,menuBottom:before.bottom,triggerTop:trigger.top,lastVisible:last.bottom<=after.bottom,lastTarget:last.width===44&&last.height===44,scrolls:menu.scrollHeight>menu.clientHeight});</script>`)
  try {
    const result = await renderLayout(process.env.CHROME_BIN, file, { width: 426 })
    assert.ok(Math.abs(result.rows[0].inputCenter - result.rows[0].pillCenter) < 1, JSON.stringify(result))
    assert.ok(Math.abs(result.rows[1].inputBottom - result.rows[1].sendBottom) < 1, JSON.stringify(result))
    assert.ok(result.rows.every(row => row.plusWidth === 24))
    // The drawn send circle aligns with the text; its touch target is 44px.
    assert.ok(result.rows.every(row => row.sendTarget === 44), JSON.stringify(result))
    assert.ok(result.menuTop >= 0 && result.menuBottom < result.triggerTop)
    assert.equal(result.scrolls, true)
    assert.equal(result.lastVisible, true)
    assert.equal(result.lastTarget, true)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test('reply upload matches the input height while send stays compact with full-size targets', {
  skip: !process.env.CHROME_BIN && 'CHROME_BIN is not configured',
}, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'social-compact-reply-'))
  const file = join(folder, 'test.html')
  try {
    writeFileSync(file, `<style>:root{--font:sans-serif;--bg:#fff;--surface:#fff;--text:#111;--border:#ccc;--accent:#7048e8}*{box-sizing:border-box}body{margin:0}${CSS}</style><form class="cn-composer cn-reply-composer"><button class="cn-composer-attach"><svg></svg></button><div class="cn-composer-pill"><div class="cn-composer-input-line"><textarea rows="1">Reply</textarea><button class="cn-composer-send"><svg></svg></button></div></div></form><pre id="result"></pre><script>document.querySelector('#result').textContent=JSON.stringify([...document.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect(),p=getComputedStyle(b,'::before'),s=b.querySelector('svg').getBoundingClientRect();return{w:r.width,h:r.height,circle:r.width-parseFloat(p.left)-parseFloat(p.right),icon:s.width}}))</script>`)
    for (const width of [320, 426, 1280]) {
      const buttons = await renderLayout(process.env.CHROME_BIN, file, { width })
      assert.ok(buttons.every(b=>b.w>=44 && b.h>=44),JSON.stringify(buttons))
      assert.equal(buttons[0].h,46,JSON.stringify(buttons))
      assert.equal(buttons[0].icon,24)
      assert.equal(buttons[1].circle,32)
      assert.equal(buttons[1].icon,18)
    }
  } finally { rmSync(folder,{recursive:true,force:true}) }
})


test('inline reply fields scale with compact controls without shrinking targets or mobile text', {
  skip: !process.env.CHROME_BIN && 'CHROME_BIN is not configured',
}, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'social-compact-reply-field-'))
  const file = join(folder, 'test.html')
  try {
    const composer = (id, cls, content = '') => `<form id="${id}" class="cn-composer ${cls}"><button class="cn-composer-attach"><svg></svg></button><div class="cn-composer-pill"><div class="cn-composer-input-line"><textarea rows="1">${content}</textarea><button class="cn-composer-send"><svg></svg></button></div></div></form>`
    writeFileSync(file, `<style>:root{--font:sans-serif;--bg:#fff;--surface:#fff;--text:#111;--border:#ccc;--accent:#7048e8}*{box-sizing:border-box}body{margin:0}${CSS}</style>${composer('main', '')}<section class="cn-inline-thread">${composer('reply', 'cn-reply-composer')}</section><pre id="result"></pre><script>const rect=n=>n.getBoundingClientRect();document.querySelector('#result').textContent=JSON.stringify(['main','reply'].map(id=>{const form=document.getElementById(id),pill=rect(form.querySelector('.cn-composer-pill')),input=form.querySelector('textarea');return {id,viewportWidth:innerWidth,pillHeight:pill.height,font:parseFloat(getComputedStyle(input).fontSize),overflow:form.scrollWidth>form.clientWidth,targets:[...form.querySelectorAll('button')].map(b=>({w:rect(b).width,h:rect(b).height}))}}))</script>`)
    for (const width of [320, 426, 1280]) {
      const [main, reply] = await renderLayout(process.env.CHROME_BIN, file, { width })
      assert.equal(reply.viewportWidth, width, 'the fixture uses the requested viewport')
      assert.equal(main.pillHeight, 50, 'the main composer is unchanged')
      assert.equal(reply.pillHeight, 46, 'reply field fits its 44px controls and border')
      assert.ok(reply.targets.every(b=>b.w>=44&&b.h>=44))
      assert.equal(reply.font, 16, 'mobile inputs retain readable non-zooming type')
      assert.equal(reply.overflow, false)
    }
  } finally { rmSync(folder, { recursive: true, force: true }) }
})
