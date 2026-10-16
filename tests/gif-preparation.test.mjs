import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { renderLayout } from './helpers/layoutBrowser.mjs'

const chrome = process.env.CHROME_BIN
const limits = (await readFile(new URL('../media_limits.js', import.meta.url), 'utf8')).replaceAll('export ', '')
const source = (await readFile(new URL('../ui/Media.jsx', import.meta.url), 'utf8'))
  .split('const MAX_BYTES')[1].split('function ManagedImage')[0]
  .replace('export async function prepareImage', 'async function prepareImage')
// Two 12x8 frames, 80/120ms, looping; exact bytes matter more than a screenshot.
const animation = 'R0lGODlhDAAIAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACAAAACwAAAAADAAIAAAIEgABCBxIsKDBgwgTKlzIsGHBgAAh+QQBDAABACwAAAAADAAIAIEAAP8AAAAAAAAAAAAIEgABCBxIsKDBgwgTKlzIsGHBgAA7'

test('GIF preparation preserves every original byte while making a still poster and rejecting resizing budgets', { skip: !chrome }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'social-gif-'))
  try {
    const file = join(directory, 'fixture.html')
    await writeFile(file, `<pre id="result"></pre><script>${limits};const MAX_BYTES${source}
      (async()=>{try {
        const bytes = Uint8Array.from(atob('${animation}'), c=>c.charCodeAt(0));
        const gif = new File([bytes], 'animation.gif', {type:'image/gif'});
        const prepared = await prepareImage(gif);
        const mislabeled = await prepareImage(new File([bytes], 'image.png', {type:'image/png'}));
        let budgetError;try {await prepareImage(gif, bytes.length-1)} catch(e){budgetError=e.message}
        const tooWide = bytes.slice();tooWide[6]=0x41;tooWide[7]=0x06;
        let dimensionError;try{await prepareImage(new File([tooWide],'wide.gif',{type:'image/gif'}))}catch(e){dimensionError=e.message}
        const poster = await gifPoster(gif);
        const posterBitmap = await createImageBitmap(poster);
        const staticCanvas = document.createElement('canvas');staticCanvas.width=12;staticCanvas.height=8;
        const transparent = await prepareImage(new File([await canvasBlob(staticCanvas,'image/png')],'alpha.png',{type:'image/png'}));
        const context=staticCanvas.getContext('2d');context.fillStyle='red';context.fillRect(0,0,12,8);
        const opaque = await prepareImage(new File([await canvasBlob(staticCanvas,'image/png')],'opaque.png',{type:'image/png'}));
        document.querySelector('#result').textContent=JSON.stringify({prepared,mislabeled:mislabeled.payload.mime,
          budgetError,dimensionError,poster:{type:poster.type,w:posterBitmap.width,h:posterBitmap.height},
          transparent:transparent.payload.mime,opaque:opaque.payload.mime});posterBitmap.close();
      } catch(e){document.querySelector('#result').textContent=JSON.stringify({error:e.stack})}})();</script>`)
    const result = await renderLayout(chrome, file)
    assert.equal(result.error, undefined)
    assert.deepEqual(result.prepared.payload, { mime:'image/gif', data_b64:animation, w:12, h:8 })
    assert.equal(result.prepared.thumbnailPayload.mime, 'image/webp')
    assert.equal(result.prepared.previewUrl, `data:image/gif;base64,${animation}`)
    assert.equal(result.mislabeled, 'image/gif')
    assert.match(result.budgetError, /smaller GIF/)
    assert.match(result.dimensionError, /1600 pixels/)
    assert.deepEqual(result.poster, {type:'image/webp',w:12,h:8})
    assert.equal(result.transparent, 'image/png')
    assert.equal(result.opaque, 'image/jpeg')
  } finally { await rm(directory, {recursive:true, force:true}) }
})

test('a real 20 MiB GIF retains original bytes while larger files fail before decoding', { skip: !chrome }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'social-large-gif-'))
  try {
    const file = join(directory, 'fixture.html')
    await writeFile(file, `<pre id="result"></pre><script>${limits};const MAX_BYTES${source}
      (async()=>{try {
        const original=Uint8Array.from(atob('${animation}'),c=>c.charCodeAt(0));
        // A bounded comment extension enlarges the container without adding
        // frames or decoded canvas work. Both frames remain unchanged.
        const bytes=new Uint8Array(GIF_MAX_BYTES);bytes.set(original.subarray(0,-1));
        let at=original.length-1,total=bytes.length-original.length-3;
        if(total%256===1){bytes.set([0x21,0xfe,0],at);at+=3;total-=3}
        bytes.set([0x21,0xfe],at);at+=2;
        while(total>=256){bytes[at++]=255;bytes.fill(65,at,at+255);at+=255;total-=256}
        if(total){bytes[at++]=total-1;bytes.fill(65,at,at+total-1);at+=total-1}
        bytes[at++]=0;bytes[at++]=0x3b;
        if(at!==bytes.length)throw new Error('Invalid comment fixture size');
        const prepared=await prepareImage(new File([bytes],'large.gif',{type:'image/gif'}));
        const returned=await fetch(prepared.previewUrl).then(r=>r.arrayBuffer());
        const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',value))).join(',');
        const matches=await hash(bytes)===await hash(returned);
        let oversized;try{await prepareImage(new File([bytes,new Uint8Array(1)],'too-large.gif',{type:'image/gif'}))}catch(e){oversized=e.message}
        const canvas=document.createElement('canvas');canvas.width=1600;canvas.height=1600;
        const context=canvas.getContext('2d'),pixels=context.createImageData(1600,1600);
        for(let i=0;i<pixels.data.length;i+=65536)crypto.getRandomValues(pixels.data.subarray(i,Math.min(i+65536,pixels.data.length)));
        context.putImageData(pixels,0,0);
        const photo=await prepareImage(new File([await canvasBlob(canvas,'image/png')],'detailed.png',{type:'image/png'}));
        document.querySelector('#result').textContent=JSON.stringify({matches,size:returned.byteLength,mime:prepared.payload.mime,oversized,
          posterMime:prepared.thumbnailPayload.mime,photoBytes:attachmentBytes(photo.payload),photoWidth:photo.payload.w});
      }catch(e){document.querySelector('#result').textContent=JSON.stringify({error:e.stack})}})();</script>`)
    const result = await renderLayout(chrome, file)
    assert.equal(result.error, undefined)
    assert.equal(result.size, 20 * 1024 * 1024)
    assert.equal(result.matches, true)
    assert.equal(result.mime, 'image/gif')
    assert.equal(result.posterMime, 'image/webp')
    assert.match(result.oversized, /up to 20 MB/)
    assert.ok(result.photoBytes > 1024 * 1024)
    assert.ok(result.photoBytes <= 5 * 1024 * 1024)
    assert.ok(result.photoWidth > 320)
  } finally { await rm(directory, {recursive:true,force:true}) }
})

const media = await readFile(new URL('../ui/Media.jsx', import.meta.url), 'utf8')
const effect = media.split('function ManagedImage')[1].split('useEffect(() => {')[1].split('  }, [directUrl')[0]
const click = media.split('function ManagedImage')[1].split('onClick={async () => {')[1].split('      }}')[0]
test('quiet GIF previews open intact originals and release URLs when media unmounts', { skip: !chrome }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'social-gif-display-'))
  try {
    const file = join(directory, 'fixture.html')
    await writeFile(file, `<pre id="result"></pre><script>${limits};const MAX_BYTES${source}
      (async()=>{try {
        const attachment={mime:'image/gif'},directUrl=null,gif=true,index=undefined,storagePath='private/original.gif';
        let postId=null,replyId=null,url=null,fullUrl=null,alt='photo attachment',opened=null,cleanup;
        let resolveLoaded;const loaded=()=>new Promise(resolve=>{resolveLoaded=resolve});
        const setUrl=value=>{url=value;if(value)resolveLoaded?.()},setFullUrl=value=>{fullUrl=value},setFailed=()=>{},reported={current:false};
        const bytes=Uint8Array.from(atob('${animation}'),c=>c.charCodeAt(0)),original=new Blob([bytes],{type:'image/gif'});
        window.mobius={storage:{getBlob:()=>Promise.resolve(original)}};
        const onUnavailable=error=>{throw error},onOpen=(value,label,release)=>{opened={value,label,release}};
        let fullFetches=0;const getReplyMedia=()=>{fullFetches++;return Promise.resolve(original)},getBoardMedia=getReplyMedia;
        const boardThumbnail=()=>gifPoster(original);
        let ready=loaded();cleanup=(()=>{${effect}})();await ready;
        const privatePoster=await fetch(url).then(r=>r.blob()),privateFull=await fetch(fullUrl).then(r=>r.blob());
        await (async()=>{${click}})();
        const privateResult={poster:privatePoster.type,original:privateFull.type,bytes:await blobBase64(privateFull),opened:opened.value===fullUrl};
        const revoked=[];const originalRevoke=URL.revokeObjectURL;URL.revokeObjectURL=value=>{revoked.push(value);originalRevoke.call(URL,value)};
        cleanup();const privateReleased=revoked.length;
        postId='abcdef12';replyId='abcdef34';ready=loaded();cleanup=(()=>{${effect}})();await ready;
        const beforeClick=fullFetches;await(async()=>{${click}})();const publicOriginal=await fetch(opened.value).then(r=>r.blob());
        opened.release();cleanup();
        document.querySelector('#result').textContent=JSON.stringify({privateResult,privateReleased,beforeClick,fullFetches,publicOriginal:publicOriginal.type,released:revoked.length});
      }catch(e){document.querySelector('#result').textContent=JSON.stringify({error:e.stack})}})();</script>`)
    const result = await renderLayout(chrome, file)
    assert.equal(result.error, undefined)
    assert.deepEqual(result.privateResult, {poster:'image/webp',original:'image/gif',bytes:animation,opened:true})
    assert.equal(result.privateReleased, 2)
    assert.equal(result.beforeClick, 0)
    assert.equal(result.fullFetches, 1)
    assert.equal(result.publicOriginal, 'image/gif')
    assert.equal(result.released, 4)
  } finally { await rm(directory, {recursive:true,force:true}) }
})
