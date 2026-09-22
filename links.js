const URL_RE = /https?:\/\/[^\s<]+/gi
const TRAILING_PUNCTUATION = /[),.!?:;]+$/

export function textParts(text) {
  const source = String(text || '')
  const parts = []
  let cursor = 0
  for (const match of source.matchAll(URL_RE)) {
    const raw = match[0]
    const url = raw.replace(TRAILING_PUNCTUATION, '')
    if (match.index > cursor) parts.push({ type: 'text', value: source.slice(cursor, match.index) })
    parts.push({ type: 'link', value: url })
    const punctuation = raw.slice(url.length)
    if (punctuation) parts.push({ type: 'text', value: punctuation })
    cursor = match.index + raw.length
  }
  if (cursor < source.length) parts.push({ type: 'text', value: source.slice(cursor) })
  return parts
}

const SOCIAL_DOMAINS = new Map([
  ['x.com', 'X'], ['twitter.com', 'X'], ['instagram.com', 'Instagram'],
  ['youtube.com', 'YouTube'], ['youtu.be', 'YouTube'], ['tiktok.com', 'TikTok'],
  ['linkedin.com', 'LinkedIn'], ['github.com', 'GitHub'],
])

export function previewFor(text) {
  const first = textParts(text).find(part => part.type === 'link')?.value
  if (!first) return null
  try {
    const parsed = new URL(first)
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    const social = [...SOCIAL_DOMAINS].find(([domain]) => host === domain || host.endsWith(`.${domain}`))
    return {
      url: first,
      label: social?.[1] || host,
      detail: decodeURIComponent(`${host}${parsed.pathname === '/' ? '' : parsed.pathname}`),
      social: Boolean(social),
    }
  } catch {
    return null
  }
}
