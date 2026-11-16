// The three reactions offered first on a message's hover toolbar: the ones
// this person used most recently on this device, newest first.
const KEY = 'social.recentReactions'
const DEFAULTS = ['👍', '❤️', '😂']
const listeners = new Set()

export function recentReactions(choices = []) {
  let saved = []
  try { saved = JSON.parse(localStorage.getItem(KEY) || '[]') } catch { saved = [] }
  const allowed = choices.length ? new Set(choices) : null
  const pool = [...saved, ...DEFAULTS, ...choices].filter(emoji => !allowed || allowed.has(emoji))
  return [...new Set(pool)].slice(0, 3)
}

export function rememberReaction(emoji) {
  let saved = []
  try { saved = JSON.parse(localStorage.getItem(KEY) || '[]') } catch { saved = [] }
  const next = [emoji, ...saved.filter(item => item !== emoji)].slice(0, 8)
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* private mode */ }
  listeners.forEach(listener => listener())
}

export function onRecentReactionsChange(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
