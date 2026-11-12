// Standard GIFs come from KLIPY. Its terms require searches and image loads to
// come straight from the person's device, unaltered, so Social never proxies
// or stores them: a GIF travels as its KLIPY link on the last line of a
// message, and every viewer's device loads it from KLIPY. The platform's
// `network.direct` grant (see mobius.json) is what lets this frame reach
// those exact sites.
import { KLIPY_APP_KEY } from './gif_config.js'

export const KLIPY_API = 'https://api.klipy.com'
// KLIPY's documented media hosts. A link to anything else is plain text.
export const KLIPY_MEDIA_HOSTS = new Set(['static.klipy.com', 'static1.klipy.com', 'static2.klipy.com'])
export const GIF_PAGE_SIZE = 24
const GIF_PATH = /\.(gif|webp)$/i

export function gifSearchAvailable(key = KLIPY_APP_KEY) {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(key)
}

// An exact https KLIPY media link and nothing else: no credentials, port, or
// other host. The link is used exactly as KLIPY gave it.
export function isKlipyGifUrl(value) {
  if (typeof value !== 'string' || value.length > 512 || /\s/.test(value)) return false
  let url
  try { url = new URL(value) } catch { return false }
  return url.protocol === 'https:' && KLIPY_MEDIA_HOSTS.has(url.hostname)
    && !url.port && !url.username && !url.password && GIF_PATH.test(url.pathname)
}

// A GIF message is optional caption lines followed by one KLIPY link alone on
// the last line. Anything else renders as ordinary text with links.
export function splitGifMessage(text) {
  const source = String(text || '').replace(/\s+$/, '')
  const cut = source.lastIndexOf('\n')
  const last = source.slice(cut + 1).trim()
  if (!isKlipyGifUrl(last)) return null
  return { caption: cut < 0 ? '' : source.slice(0, cut).trim(), url: last }
}

// What a composer stages from a picked result: the link that is sent, plus
// the title and light preview shown until Send.
export function stagedGif(chosen) {
  return { url: chosen.send.url, title: chosen.title, preview: chosen.preview }
}

export function withGif(text, gif) {
  const caption = String(text || '').trim()
  if (!gif?.url) return caption
  return caption ? `${caption}\n${gif.url}` : gif.url
}

// The caption's share of a text limit once a GIF is staged: its link and the
// newline before it are sent as part of the text, so they count too.
export function gifCaptionLimit(limit, gif) {
  return gif?.url ? Math.max(0, limit - gif.url.length - 1) : limit
}

// How many characters the complete outgoing text (caption plus GIF link) is
// over the limit; 0 when it fits. A GIF picked after a long caption can push
// it over: the composer shows that and keeps Send off rather than cutting.
export function gifTextOverflow(text, gif, limit) {
  return Math.max(0, withGif(text, gif).length - limit)
}

// Chat lists and notifications say "GIF" rather than showing a long link.
export function gifPreviewText(text) {
  const gif = splitGifMessage(text)
  if (!gif) return text
  return gif.caption ? `${gif.caption} · GIF` : 'GIF'
}

// The key to search with: this installation's own override if set, otherwise
// the shared key the community host gives joined members. `load` fetches the
// latter; the answer is kept for this page only.
let sharedKey = null
export async function resolveGifKey(load, { localKey = KLIPY_APP_KEY, signal } = {}) {
  if (gifSearchAvailable(localKey)) return localKey
  if (sharedKey) return sharedKey
  let result
  try {
    result = await load({ signal })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    if (error?.status === 404) throw Object.assign(new Error('GIF search isn’t set up yet.'), { code: 'unconfigured' })
    throw Object.assign(new Error(error?.message || 'GIF search is unavailable right now.'), { code: 'unreachable' })
  }
  if (!gifSearchAvailable(result?.app_key)) {
    throw Object.assign(new Error('GIF search isn’t set up yet.'), { code: 'unconfigured' })
  }
  sharedKey = result.app_key
  return sharedKey
}

export function forgetSharedGifKey() { sharedKey = null }

function rendition(file, sizes, formats) {
  for (const size of sizes) {
    for (const format of formats) {
      const item = file?.[size]?.[format]
      if (item && isKlipyGifUrl(item.url)) {
        return { url: item.url, w: Number(item.width) || 0, h: Number(item.height) || 0 }
      }
    }
  }
  return null
}

// One result: a light grid preview and the GIF that is sent. Results keep
// KLIPY's order; one without a usable GIF link is shown as unavailable rather
// than silently dropped.
export function normalizeGif(item) {
  const file = item?.file
  const send = rendition(file, ['md', 'hd', 'sm'], ['gif'])
  const preview = rendition(file, ['sm', 'xs', 'md'], ['webp', 'gif']) || send
  return {
    id: String(item?.id ?? item?.slug ?? ''),
    title: typeof item?.title === 'string' && item.title.trim() ? item.title.trim() : 'GIF',
    preview, send,
  }
}

function deviceLocale() {
  const region = (navigator.language || '').split('-')[1]
  return region && /^[A-Za-z]{2}$/.test(region) ? region.toLowerCase() : null
}

// Trending when the query is empty, otherwise search. No customer id is sent,
// so KLIPY cannot tie searches to a person.
export async function fetchGifs({ query = '', page = 1, signal, key = KLIPY_APP_KEY } = {}) {
  if (!gifSearchAvailable(key)) throw Object.assign(new Error('GIF search isn’t set up yet.'), { code: 'unconfigured' })
  const q = query.trim()
  const url = new URL(`/api/v1/${encodeURIComponent(key)}/gifs/${q ? 'search' : 'trending'}`, KLIPY_API)
  url.searchParams.set('page', String(page))
  url.searchParams.set('per_page', String(GIF_PAGE_SIZE))
  url.searchParams.set('content_filter', 'medium')
  if (q) url.searchParams.set('q', q.slice(0, 100))
  const locale = deviceLocale()
  if (locale) url.searchParams.set('locale', locale)
  let response
  try {
    response = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw Object.assign(new Error('GIF search is unavailable right now.'), { code: 'unreachable' })
  }
  if (!response.ok) throw Object.assign(new Error('GIF search is unavailable right now.'), { code: 'failed' })
  const body = await response.json()
  const page_ = body?.data
  const items = Array.isArray(page_?.data) ? page_.data : []
  return {
    gifs: items.map(normalizeGif),
    hasMore: typeof page_?.has_next === 'boolean' ? page_.has_next : items.length >= GIF_PAGE_SIZE,
  }
}
