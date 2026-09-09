import { needsGlobalJoin } from './community.js'

export const PARTICIPATION_INTENT_PATH = 'drafts/board-participation.json'

const INTENT_VERSION = 1
const TEXT_LIMITS = { post: 4000, reply: 1000 }
const INTENT_KINDS = new Set(['post', 'reply', 'like'])
const POST_ID_RE = /^[a-z0-9-]{1,128}$/i
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

function normalizedAttachment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { mime, data_b64: data, w, h } = value
  if (
    !IMAGE_MIME_TYPES.has(mime)
    || typeof data !== 'string'
    || data.length > 1_400_000
    || !Number.isInteger(w) || w < 1 || w > 8192
    || !Number.isInteger(h) || h < 1 || h > 8192
  ) return null
  return { mime, data_b64: data, w, h }
}

export function createParticipationIntent(kind, values = {}) {
  if (!INTENT_KINDS.has(kind)) return null
  const intent = { version: INTENT_VERSION, kind }

  if (kind === 'post' || kind === 'reply') {
    const limit = TEXT_LIMITS[kind]
    intent.text = String(values.text || '').slice(0, limit)
  }
  if (kind === 'reply' || kind === 'like') {
    const postId = String(values.postId || values.post_id || '').trim()
    if (!POST_ID_RE.test(postId)) return null
    intent.post_id = postId
  }
  if (kind === 'post') {
    const attachment = normalizedAttachment(values.attachment)
    if (attachment) intent.attachment = attachment
  }
  return intent
}

export function parseParticipationIntent(value) {
  if (!value || value.version !== INTENT_VERSION) return null
  return createParticipationIntent(value.kind, value)
}

export function participationIntentMatches(first, second) {
  const a = parseParticipationIntent(first)
  const b = parseParticipationIntent(second)
  if (!a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

export async function loadParticipationIntent(storage) {
  if (!storage?.get) return null
  return parseParticipationIntent(await storage.get(PARTICIPATION_INTENT_PATH))
}

export async function saveParticipationIntent(storage, intent) {
  const safe = parseParticipationIntent(intent)
  if (!safe || !storage?.getWithVersion || !storage?.durableWrite) return false
  const { value, version, offline } = await storage.getWithVersion(PARTICIPATION_INTENT_PATH)
  if (offline) throw new Error('Reconnect before leaving Social so your draft can be saved safely.')
  if (value != null) {
    if (participationIntentMatches(value, safe)) return true
    throw new Error('You already have a saved action. Finish that draft before starting another; it has not been replaced.')
  }
  await storage.durableWrite(PARTICIPATION_INTENT_PATH, safe,
    version == null ? { ifNoneMatch: true } : { ifMatch: version })
  return true
}

export async function clearParticipationIntent(storage, expectedIntent) {
  if (!storage?.getWithVersion || !storage?.durableWrite) return false
  const { value, version, offline } = await storage.getWithVersion(PARTICIPATION_INTENT_PATH)
  if (offline || version == null || !participationIntentMatches(value, expectedIntent)) return false
  await storage.durableWrite(PARTICIPATION_INTENT_PATH, null, { ifMatch: version })
  return true
}

export function participationStep(profile) {
  if (profile?.joined && profile?.name && !needsGlobalJoin(profile)) return 'ready'
  if (profile?.connected) return 'join'
  return profile?.identity_app_id == null ? 'store' : 'identity'
}

export function participationActionLabel(step, intentKind = 'post') {
  if (step === 'ready') {
    if (intentKind === 'reply') return 'Review reply'
    if (intentKind === 'like') return 'Review reaction'
    return 'Review post'
  }
  if (step === 'join') return 'Join Social to continue'
  if (step === 'store') return 'Get Möbius · You'
  return 'Continue in Möbius · You'
}

// Navigation belongs to the shell. It resolves the installed numeric app id;
// when Identity is absent, the Store owns catalog resolution through its
// documented `app:<manifest-id>` intent rather than a guessed URL.
export function accountHandoff(profile, postMessage) {
  const installedId = profile?.identity_app_id
  const message = installedId == null
    ? { type: 'moebius:open-app', appId: 'store', intent: 'app:identity' }
    : { type: 'moebius:open-app', appId: installedId }
  postMessage(message, '*')
  return installedId == null ? 'store' : 'identity'
}
