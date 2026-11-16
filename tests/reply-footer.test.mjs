import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CSS } from '../theme.js'
import { renderLayout } from './helpers/layoutBrowser.mjs'

// Exercise the owning footer effect against real layout, not a second copy of
// its clearance calculation. React supplies these refs in the mounted app.
const source = readFileSync(new URL('../ui/Composer.jsx', import.meta.url), 'utf8')
const effect = source.slice(source.indexOf('export function ComposerFooter')).match(/useLayoutEffect\(\(\) => \{([\s\S]*?)\n  \}, \[scrollRef\]\)/)[1]

test('reply overlay reserves growing draft clearance, stays transparent and restores the scroller on unmount', {
  skip: !process.env.CHROME_BIN && 'CHROME_BIN is not configured',
}, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'social-reply-footer-'))
  const file = join(folder, 'test.html')
  try {
    writeFileSync(file, `<style>:root{--font:sans-serif;--bg:#111;--surface:#222;--text:#fff;--border:#555;--mobius-safe-bottom:24px}*{box-sizing:border-box}body{margin:0}${CSS}</style>
      <section class="cn-inline-thread"><div class="cn-inline-replies">${'<article class="cn-reply-row" style="height:80px">Reply</article>'.repeat(12)}</div><div class="cn-composer-footer cn-reply-footer"><form class="cn-composer cn-reply-composer"><button class="cn-composer-attach"><svg></svg></button><div class="cn-composer-pill"><div class="cn-composer-input-line"><textarea rows="1"></textarea><button class="cn-composer-send">Send</button></div></div></form></div></section><pre id="result"></pre>
      <script>(async()=>{const t=document.querySelector('.cn-inline-thread'),scroll=t.querySelector('.cn-inline-replies'),footer=t.querySelector('.cn-reply-footer'),input=t.querySelector('textarea');const base=parseFloat(getComputedStyle(scroll).paddingBottom)||0;const scrollRef={current:scroll},footerRef={current:footer};const cleanup=(()=>{${effect}})();const measure=()=>({base,height:t.clientHeight,padding:parseFloat(scroll.style.paddingBottom),footerHeight:footer.getBoundingClientRect().height,bottom:getComputedStyle(footer).bottom,transparent:getComputedStyle(footer).backgroundColor,innerFirst:getComputedStyle(scroll).overscrollBehaviorY,targets:[...t.querySelectorAll('button')].map(b=>b.getBoundingClientRect().height),overflow:t.scrollWidth>t.clientWidth});const initial=measure();scroll.scrollTop=100;input.style.height='100px';await new Promise(resolve=>{const o=new ResizeObserver(()=>{if(footer.getBoundingClientRect().height>initial.footerHeight){o.disconnect();requestAnimationFrame(resolve)}});o.observe(footer)});const grown=measure();grown.readingPosition=scroll.scrollTop;scroll.scrollTop=scroll.scrollHeight;grown.lastReplyReachable=scroll.lastElementChild.getBoundingClientRect().bottom<=footer.getBoundingClientRect().top;cleanup();document.querySelector('#result').textContent=JSON.stringify({initial,grown,restored:scroll.style.paddingBottom})})()</script>`)
    for (const width of [320, 426, 1280]) {
      const { initial, grown, restored } = await renderLayout(process.env.CHROME_BIN, file, { width })
      assert.equal(initial.bottom, '0px', 'local reply footer does not inherit the viewport safe inset')
      assert.equal(initial.transparent, 'rgba(0, 0, 0, 0)')
      assert.equal(initial.innerFirst, 'auto', 'preserve the chosen native edge handoff')
      assert.ok(initial.targets.every(h => h >= 44))
      // The list's own bottom padding stays under the clearance the footer adds.
      assert.ok(Math.abs(initial.padding - initial.base - initial.footerHeight - 8) < 1, JSON.stringify(initial))
      assert.ok(grown.padding > initial.padding)
      assert.equal(grown.readingPosition, 100, 'growth must not pull a reader to the bottom')
      assert.equal(grown.lastReplyReachable, true)
      assert.equal(grown.overflow, false)
      assert.equal(restored, '')
    }
  } finally { rmSync(folder, { recursive: true, force: true }) }
})

test('native focus scrolling clears the overlay in partially read reply and main histories', {
  skip: !process.env.CHROME_BIN && 'CHROME_BIN is not configured',
}, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'social-footer-focus-'))
  const file = join(folder, 'test.html')
  try {
    for (const reply of [true, false]) {
      for (const tall of [false, true]) {
        writeFileSync(file, `<style>:root{--font:sans-serif;--bg:#111;--surface:#222;--text:#fff;--border:#555;--mobius-safe-bottom:0px}*{box-sizing:border-box}body{margin:0}${CSS}</style>
          <section class="${reply ? 'cn-inline-thread' : ''}" style="position:relative;height:343px;display:flex;flex-direction:column;overflow:hidden"><div class="cn-inline-replies" style="flex:1;scroll-padding-bottom:3px">${'<article style="height:80px;padding-top:36px"><button style="height:44px">React</button></article>'.repeat(12)}</div><div class="cn-composer-footer ${reply ? 'cn-reply-footer' : ''}"><form class="cn-composer ${reply ? 'cn-reply-composer' : ''}"><button class="cn-composer-attach">Attach</button><div class="cn-composer-pill"><div class="cn-composer-input-line"><textarea rows="1" ${tall ? 'style="height:100px"' : ''}></textarea><button class="cn-composer-send">Send</button></div></div></form></div></section><pre id="result"></pre>
          <script>(async()=>{const scroll=document.querySelector('.cn-inline-replies'),footer=document.querySelector('.cn-composer-footer');const scrollRef={current:scroll},footerRef={current:footer};const cleanup=(()=>{${effect}})();scroll.scrollTop=600;const action=scroll.lastElementChild.querySelector('button');action.focus();await new Promise(requestAnimationFrame);const rect=action.getBoundingClientRect(),f=footer.getBoundingClientRect();const clear=rect.bottom<=f.top;const hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)===action;const padding=scroll.style.paddingBottom,focusPadding=scroll.style.scrollPaddingBottom;cleanup();document.querySelector('#result').textContent=JSON.stringify({clear,hit,padding,focusPadding,restored:scroll.style.scrollPaddingBottom})})()</script>`)
        for (const width of [320, 426, 1280]) {
          const result = await renderLayout(process.env.CHROME_BIN, file, { width })
          assert.equal(result.clear, true, `focused action clears ${reply ? 'reply' : 'main'} overlay at ${width}px`)
          assert.equal(result.hit, true, 'composer controls cannot intercept the focused action')
          assert.equal(result.focusPadding, result.padding, 'one measured clearance owns native focus and bottom reachability')
          assert.equal(result.restored, '3px', 'unmount restores prior native clearance')
        }
      }
    }
  } finally { rmSync(folder, { recursive: true, force: true }) }
})
