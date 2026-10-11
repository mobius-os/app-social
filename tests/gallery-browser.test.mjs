import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { CSS } from '../theme.js'
import { renderLayout } from './helpers/layoutBrowser.mjs'

const modules = process.env.SOCIAL_NODE_MODULES
test('gallery opens the clicked image, browses, preserves zoom gestures and recovers failed loads', {
  skip: (!process.env.CHROME_BIN || !modules) && 'CHROME_BIN and SOCIAL_NODE_MODULES are required',
}, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'social-gallery-'))
  try {
    const require = createRequire(join(modules, 'package.json'))
    const { rolldown } = await import(pathToFileURL(require.resolve('rolldown')))
    const media = fileURLToPath(new URL('../ui/Media.jsx', import.meta.url))
    const fixture = join(folder, 'fixture.jsx')
    await writeFile(fixture, `
      import { useState } from 'react'
      import { createRoot } from 'react-dom/client'
      import { Lightbox, BoardImage } from ${JSON.stringify(media)}
      const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII='
      const blob=await (await fetch(png)).blob()
      let fail=false, revoked=0
      const revoke=URL.revokeObjectURL.bind(URL)
      URL.revokeObjectURL=url=>{revoked++;revoke(url)}
      window.fetch=async()=>{if(fail)throw new Error('Offline');return new Response(blob)}
      const post={id:'fixture',attachments:Array.from({length:3},()=>({mime:'image/png',w:1,h:1}))}
      function App(){const [image,setImage]=useState(null);return <><BoardImage post={post}
        onOpen={(url,alt,cleanup,gallery)=>setImage({url,alt,cleanup,gallery})}/>
        <Lightbox image={image} onClose={()=>setImage(null)}/></>}
      createRoot(document.querySelector('#app')).render(<App/>);
      const wait=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,10))}throw new Error('Fixture transition timed out')}
      const button=name=>document.querySelector('button[aria-label="'+name+'"]')
      const stage=()=>document.querySelector('.cn-lightbox-stage')
      const alt=()=>stage()?.querySelector('img')?.alt
      const counter=()=>document.querySelector('.cn-lightbox-gallery span')?.textContent
      const key=value=>document.dispatchEvent(new KeyboardEvent('keydown',{key:value,bubbles:true}))
      // Synthetic pointer events exercise the owning handlers, not OS gestures.
      const pointer=(type,id,x,y)=>{const el=stage();el.setPointerCapture=()=>{};el.hasPointerCapture=()=>false;el.dispatchEvent(new PointerEvent(type,{pointerId:id,clientX:x,clientY:y,bubbles:true}))}
      (async()=>{try{
        await wait(()=>document.querySelectorAll('.cn-gallery-item:not([disabled])').length===3)
        document.querySelectorAll('.cn-gallery-item')[1].focus()
        document.querySelectorAll('.cn-gallery-item')[1].click()
        await wait(()=>alt()==='post photo 2')
        const opened=counter()
        button('Next image').click();await wait(()=>alt()==='post photo 3')
        const lastDisabled=button('Next image').disabled
        key('ArrowLeft');await wait(()=>alt()==='post photo 2')
        button('Zoom in').click();await wait(()=>document.querySelector('.cn-lightbox-reset').textContent==='125%')
        pointer('pointerdown',1,200,200);pointer('pointermove',1,100,200);pointer('pointerup',1,100,200)
        await new Promise(r=>requestAnimationFrame(r));const zoomPanStays=counter()==='2 / 3'
        button('Next image').click();await wait(()=>alt()==='post photo 3')
        const zoomReset=document.querySelector('.cn-lightbox-reset').textContent==='100%'
        pointer('pointerdown',1,100,200);pointer('pointerdown',2,200,200);pointer('pointercancel',2,220,200);pointer('pointerup',1,100,200)
        await new Promise(r=>requestAnimationFrame(r));const cancelledPinchStays=counter()==='3 / 3'
        pointer('pointerdown',1,100,200);pointer('pointermove',1,200,200);pointer('pointerup',1,200,200)
        await wait(()=>alt()==='post photo 2')
        const swipeWorked=counter()==='2 / 3'
        fail=true;button('Next image').click();await wait(()=>document.querySelector('.cn-lightbox-status button'))
        const failureNavigable=!!button('Previous image')&&!button('Previous image').disabled
        fail=false;document.querySelector('.cn-lightbox-status button').click();await wait(()=>alt()==='post photo 3')
        const recovered=counter()==='3 / 3'
        key('ArrowLeft');await wait(()=>alt()==='post photo 2');key('ArrowLeft');await wait(()=>alt()==='post photo 1')
        const firstDisabled=button('Previous image').disabled
        const target=button('Next image').getBoundingClientRect();const touchTarget=target.width>=44&&target.height>=44
        stage().querySelector('img').dispatchEvent(new PointerEvent('pointerdown',{pointerId:1,clientX:200,clientY:200,bubbles:true}))
        pointer('pointerup',1,200,200);stage().click()
        await new Promise(r=>requestAnimationFrame(r));const imageTapStays=!!stage()
        pointer('pointerdown',1,300,20);pointer('pointerup',1,300,20);stage().click()
        await wait(()=>!document.querySelector('.cn-lightbox'));const backdropCloses=true
        document.querySelectorAll('.cn-gallery-item')[1].focus();document.querySelectorAll('.cn-gallery-item')[1].click()
        await wait(()=>alt()==='post photo 2')
        key('Escape');await wait(()=>!document.querySelector('.cn-lightbox'))
        document.querySelector('#result').textContent=JSON.stringify({opened,lastDisabled,firstDisabled,zoomPanStays,zoomReset,cancelledPinchStays,swipeWorked,failureNavigable,recovered,touchTarget,imageTapStays,backdropCloses,released:revoked>0,focusRestored:document.activeElement===document.querySelectorAll('.cn-gallery-item')[1]})
      }catch(error){document.querySelector('#result').textContent=JSON.stringify({error:error.stack})}})()
    `)
    const bundle = await rolldown({
      input: fixture, platform: 'browser', tsconfig: false,
      resolve: { alias: {
        '@openai/apps-sdk-ui/components/Icon': join(modules, '@openai/apps-sdk-ui/dist/es/components/Icon/index.js'),
        react: join(modules, 'react'), 'react-dom': join(modules, 'react-dom'),
      } },
      transform: { define: { 'process.env.NODE_ENV': "'production'" }, jsx: 'react-jsx', target: 'es2022' },
    })
    let output
    try { output = await bundle.generate({ format: 'es', codeSplitting: false }) }
    finally { await bundle.close() }
    const html = join(folder, 'fixture.html')
    await writeFile(html, `<style>:root{--font:sans-serif;--bg:#111;--text:#fff;--surface:#222;--muted:#aaa;--border:#444}*{box-sizing:border-box}body{margin:0}${CSS}</style><div id="app"></div><pre id="result"></pre><script type="module">${output.output[0].code}</script>`)
    const result = await renderLayout(process.env.CHROME_BIN, html, { width: 426, height: 860 })
    assert.equal(result.error, undefined, result.error)
    assert.equal(result.opened, '2 / 3')
    for (const [key, value] of Object.entries(result)) if (key !== 'opened') assert.equal(value, true, key)
  } finally { await rm(folder, { recursive: true, force: true }) }
})
