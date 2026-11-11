import test from 'node:test'
import assert from 'node:assert/strict'
import {
  fetchGifs, forgetSharedGifKey, gifPreviewText, gifSearchAvailable, isKlipyGifUrl, normalizeGif,
  resolveGifKey, splitGifMessage, withGif,
} from '../gifs.js'

const GIF = 'https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/af/um0L4dFH.gif'

test('only exact https links on KLIPY media hosts count as GIFs', () => {
  assert.equal(isKlipyGifUrl(GIF), true)
  assert.equal(isKlipyGifUrl(GIF.replace('static.', 'static2.')), true)
  assert.equal(isKlipyGifUrl(GIF.replace('.gif', '.webp')), true)
  for (const url of [
    GIF.replace('https:', 'http:'), GIF.replace('static.klipy.com', 'klipy.com.evil.test'),
    GIF.replace('static.klipy.com', 'user@static.klipy.com'), GIF.replace('.gif', '.mp4'),
    GIF.replace('static.klipy.com', 'static.klipy.com:8443'), `${GIF} x`, '', null,
  ]) assert.equal(isKlipyGifUrl(url), false, url)
})

test('a GIF message is an optional caption and the link alone on the last line', () => {
  assert.deepEqual(splitGifMessage(GIF), { caption: '', url: GIF })
  assert.deepEqual(splitGifMessage(`so true\n${GIF}\n`), { caption: 'so true', url: GIF })
  assert.equal(splitGifMessage(`look ${GIF}`), null)
  assert.equal(splitGifMessage(`${GIF}\nnice`), null)
  assert.equal(splitGifMessage('https://example.com/cat.gif'), null)
})

test('a staged GIF joins its caption only when sending', () => {
  assert.equal(withGif('  hi  ', { url: GIF }), `hi\n${GIF}`)
  assert.equal(withGif('', { url: GIF }), GIF)
  assert.equal(withGif(' hi ', null), 'hi')
  assert.deepEqual(splitGifMessage(withGif('two\nlines', { url: GIF })), { caption: 'two\nlines', url: GIF })
})

test('lists say GIF instead of showing the link', () => {
  assert.equal(gifPreviewText(GIF), 'GIF')
  assert.equal(gifPreviewText(`lol\n${GIF}`), 'lol · GIF')
  assert.equal(gifPreviewText('plain text'), 'plain text')
})

test('results keep KLIPY links unaltered and mark ones without a GIF unavailable', () => {
  const item = {
    id: 1, title: 'Hello',
    file: {
      md: { gif: { url: GIF, width: 320, height: 240 } },
      sm: { webp: { url: GIF.replace('.gif', '.webp'), width: 160, height: 120 } },
    },
  }
  assert.deepEqual(normalizeGif(item), {
    id: '1', title: 'Hello',
    send: { url: GIF, w: 320, h: 240 },
    preview: { url: GIF.replace('.gif', '.webp'), w: 160, h: 120 },
  })
  const foreign = normalizeGif({ id: 2, file: { md: { gif: { url: 'https://evil.test/a.gif' } } } })
  assert.equal(foreign.send, null)
  assert.equal(foreign.title, 'GIF')
})

test('search goes straight to KLIPY without a customer id, trending when empty', async (t) => {
  const seen = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push({ url: new URL(url), init })
    return { ok: true, json: async () => ({ result: true, data: { data: [], has_next: false } }) }
  })
  const key = 'test_key_123456'
  assert.equal(gifSearchAvailable(key), true)
  assert.equal(gifSearchAvailable(''), false)
  await fetchGifs({ key })
  await fetchGifs({ key, query: ' cats ', page: 2 })
  assert.equal(seen[0].url.origin, 'https://api.klipy.com')
  assert.equal(seen[0].url.pathname, `/api/v1/${key}/gifs/trending`)
  assert.equal(seen[1].url.pathname, `/api/v1/${key}/gifs/search`)
  assert.equal(seen[1].url.searchParams.get('q'), 'cats')
  assert.equal(seen[1].url.searchParams.get('page'), '2')
  for (const { url, init } of seen) {
    assert.equal(url.searchParams.has('customer_id'), false)
    assert.equal(init.credentials, 'omit')
  }
  await assert.rejects(fetchGifs({ key: '' }), { code: 'unconfigured' })
})

test('a local key wins; otherwise the shared key is fetched once per page', async () => {
  forgetSharedGifKey()
  let loads = 0
  const load = async () => { loads++; return { app_key: 'shared_key_123456' } }
  assert.equal(await resolveGifKey(load, { localKey: 'local_key_123456' }), 'local_key_123456')
  assert.equal(loads, 0)
  assert.equal(await resolveGifKey(load, { localKey: '' }), 'shared_key_123456')
  assert.equal(await resolveGifKey(load, { localKey: '' }), 'shared_key_123456')
  assert.equal(loads, 1)
  forgetSharedGifKey()
  await assert.rejects(resolveGifKey(async () => { throw Object.assign(new Error('x'), { status: 404 }) }, { localKey: '' }),
    { code: 'unconfigured' })
  await assert.rejects(resolveGifKey(async () => { throw Object.assign(new Error('offline'), { status: 502 }) }, { localKey: '' }),
    { code: 'unreachable' })
  await assert.rejects(resolveGifKey(async () => ({ app_key: 'bad key' }), { localKey: '' }), { code: 'unconfigured' })
})
