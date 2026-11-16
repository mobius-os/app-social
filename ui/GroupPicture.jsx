import { useEffect, useState } from 'react'
import { initials } from '../api.js'

// A group's picture lives beside its meta as groups/<gid>/icon.json; meta
// carries only icon_hash, so a changed hash is the one signal to reload.
const loaded = new Map() // hash -> data URL

export function rememberGroupIcon(hash, wire) {
  if (hash && wire?.data_b64) loaded.set(hash, `data:${wire.mime};base64,${wire.data_b64}`)
}

export function useGroupIcon(gid, hash) {
  const [url, setUrl] = useState(() => (hash && loaded.get(hash)) || null)
  useEffect(() => {
    if (!hash) { setUrl(null); return undefined }
    if (loaded.has(hash)) { setUrl(loaded.get(hash)); return undefined }
    let active = true
    window.mobius?.storage?.get(`groups/${gid}/icon.json`).then(saved => {
      if (!active || !saved?.data_b64) return
      rememberGroupIcon(saved.hash || hash, saved)
      setUrl(`data:${saved.mime};base64,${saved.data_b64}`)
    }).catch(() => {})
    return () => { active = false }
  }, [gid, hash])
  return url
}

export default function GroupPicture({ gid, hash, name, preview, className = '' }) {
  const stored = useGroupIcon(gid, hash)
  const url = preview === undefined ? stored : preview
  return (
    <span className={`cn-avatar is-group${url ? ' has-picture' : ''} ${className}`} aria-hidden="true">
      {url ? <img src={url} alt="" draggable={false} /> : initials(name, name)}
    </span>
  )
}

// Crop to a centred square and shrink it; the server re-encodes the final 128px picture.
export async function prepareGroupPicture(file) {
  if (!file?.type?.startsWith('image/') || file.type === 'image/gif') {
    throw new Error('Choose a still photo for the group picture.')
  }
  const bitmap = await createImageBitmap(file)
  try {
    const side = Math.min(bitmap.width, bitmap.height)
    const size = Math.min(256, side)
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const context = canvas.getContext('2d')
    if (!context) throw new Error('This image couldn’t be prepared.')
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size)
    const dataUrl = canvas.toDataURL('image/webp', 0.86)
    const mime = dataUrl.slice(5, dataUrl.indexOf(';'))
    if (!['image/webp', 'image/png', 'image/jpeg'].includes(mime)) throw new Error('This image couldn’t be prepared.')
    return { wire: { mime, data_b64: dataUrl.split(',')[1], w: size, h: size }, preview: dataUrl }
  } finally {
    bitmap.close?.()
  }
}
