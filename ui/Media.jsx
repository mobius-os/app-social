import { useEffect, useRef, useState } from 'react'
import { ImageSquare, X } from '@openai/apps-sdk-ui/components/Icon'
import { getBoardMedia } from '../api.js'

const MAX_BYTES = 1024 * 1024
const MAX_SIDE = 1600
const THUMBNAIL_MAX_BYTES = 120 * 1024

function canvasBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('This image couldn’t be prepared.'))),
      mime,
      quality ?? (mime === 'image/jpeg' ? 0.82 : undefined),
    )
  })
}

function blobBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = () => reject(new Error('This image couldn’t be read.'))
    reader.readAsDataURL(blob)
  })
}

function hasTransparency(context, width, height) {
  const pixels = context.getImageData(0, 0, width, height).data
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] < 255) return true
  }
  return false
}

export async function prepareImage(file, maxBytes = MAX_BYTES) {
  if (!file?.type?.startsWith('image/')) throw new Error('Choose an image file.')

  let bitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('That image format isn’t supported.')
  }

  try {
    const originalWidth = bitmap.width
    const originalHeight = bitmap.height
    if (!originalWidth || !originalHeight) throw new Error('That image has no visible content.')

    let scale = Math.min(1, MAX_SIDE / Math.max(originalWidth, originalHeight))
    let width = Math.max(1, Math.round(originalWidth * scale))
    let height = Math.max(1, Math.round(originalHeight * scale))
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d', { alpha: true, willReadFrequently: true })
    if (!context) throw new Error('This image couldn’t be prepared.')

    const draw = (opaque = false) => {
      canvas.width = width
      canvas.height = height
      context.clearRect(0, 0, width, height)
      if (opaque) {
        context.fillStyle = '#fff'
        context.fillRect(0, 0, width, height)
      }
      context.drawImage(bitmap, 0, 0, width, height)
    }

    // Keep transparency for ANY source that actually has it (PNG, WebP, …) by
    // checking the decoded pixels rather than trusting the source mime; only a
    // fully opaque image is flattened to JPEG for size.
    draw()
    const mime = hasTransparency(context, width, height) ? 'image/png' : 'image/jpeg'
    if (mime === 'image/jpeg') draw(true)
    let blob = await canvasBlob(canvas, mime)

    // Keep within the (possibly per-image) byte budget without changing the
    // promised JPEG quality. Very detailed images get progressively smaller.
    while (blob.size > maxBytes && Math.max(width, height) > 320) {
      width = Math.max(1, Math.round(width * 0.86))
      height = Math.max(1, Math.round(height * 0.86))
      draw(mime === 'image/jpeg')
      blob = await canvasBlob(canvas, mime)
    }
    if (blob.size > maxBytes) {
      throw new Error('This image is still too large after resizing. Try a simpler image.')
    }

    const data_b64 = await blobBase64(blob)

    // Upload a compact display rendition beside the original. Community
    // hosts can serve it immediately, without decoding the full photo on the
    // first feed view or needing an image-processing dependency of their own.
    const thumbScale = Math.min(1, 640 / Math.max(width, height))
    let thumbWidth = Math.max(1, Math.round(width * thumbScale))
    let thumbHeight = Math.max(1, Math.round(height * thumbScale))
    const thumbCanvas = document.createElement('canvas')
    const transparent = mime === 'image/png'
    const thumbContext = thumbCanvas.getContext('2d', { alpha: transparent })
    if (!thumbContext) throw new Error('This image couldn’t be prepared.')
    const drawThumbnail = () => {
      thumbCanvas.width = thumbWidth
      thumbCanvas.height = thumbHeight
      if (!transparent) {
        thumbContext.fillStyle = '#fff'
        thumbContext.fillRect(0, 0, thumbWidth, thumbHeight)
      }
      thumbContext.drawImage(canvas, 0, 0, width, height, 0, 0, thumbWidth, thumbHeight)
    }
    drawThumbnail()
    let thumbBlob = await canvasBlob(thumbCanvas, 'image/webp', 0.74)
    while (thumbBlob.size > THUMBNAIL_MAX_BYTES && Math.max(thumbWidth, thumbHeight) > 96) {
      thumbWidth = Math.max(1, Math.round(thumbWidth * 0.84))
      thumbHeight = Math.max(1, Math.round(thumbHeight * 0.84))
      drawThumbnail()
      thumbBlob = await canvasBlob(thumbCanvas, 'image/webp', 0.7)
    }
    if (thumbBlob.size > THUMBNAIL_MAX_BYTES) {
      throw new Error('This image is too detailed to prepare a preview. Try a simpler image.')
    }
    const thumbnail_b64 = await blobBase64(thumbBlob)
    return {
      payload: { mime, data_b64, w: width, h: height },
      thumbnailPayload: {
        mime: 'image/webp', data_b64: thumbnail_b64, w: thumbWidth, h: thumbHeight,
      },
      previewUrl: `data:${mime};base64,${data_b64}`,
    }
  } finally {
    bitmap.close?.()
  }
}

function ManagedImage({ attachment, storagePath, postId, index, className, alt, onOpen, onUnavailable, square }) {
  const directUrl = attachment?.preview_url || null
  const [url, setUrl] = useState(directUrl)
  const [failed, setFailed] = useState(false)
  const reported = useRef(false)
  const width = Number(attachment?.w) || 4
  const height = Number(attachment?.h) || 3

  useEffect(() => {
    let active = true
    let objectUrl = null
    setFailed(false)
    reported.current = false
    if (directUrl) {
      setUrl(directUrl)
      return () => { active = false }
    }
    setUrl(null)
    const load = postId
      ? getBoardMedia(postId, index, { thumbnail: true })
      : window.mobius?.storage?.getBlob?.(storagePath)
    if (!load?.then) {
      setFailed(true)
      onUnavailable?.(new Error('Photo storage is unavailable.'))
      reported.current = true
      return () => { active = false }
    }
    load
      .then((blob) => {
        if (!active || !blob?.size) {
          if (active) {
            setFailed(true)
            if (!reported.current) onUnavailable?.(new Error('This photo is empty.'))
            reported.current = true
          }
          return
        }
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch((error) => {
        if (!active) return
        setFailed(true)
        if (!reported.current) onUnavailable?.(error)
        reported.current = true
      })
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [directUrl, postId, index, storagePath])

  return (
    <button
      className={`cn-media ${className}${attachment?.mime === 'image/png' ? ' is-transparent' : ''}`}
      type="button"
      style={square ? undefined : { aspectRatio: `${width} / ${height}` }}
      onClick={async () => {
        if (!url) return
        if (!postId) {
          onOpen(url, alt)
          return
        }
        try {
          const full = await getBoardMedia(postId, index)
          const fullUrl = URL.createObjectURL(full)
          onOpen(fullUrl, alt, () => URL.revokeObjectURL(fullUrl))
        } catch {
          onOpen(url, alt)
        }
      }}
      disabled={!url}
      aria-label={url ? `Open ${alt}` : failed ? `${alt} unavailable` : `Loading ${alt}`}
    >
      {url && (
        <img
          src={url}
          alt={alt}
          draggable="false"
          onError={() => {
            setUrl(null)
            setFailed(true)
            if (!reported.current) onUnavailable?.(new Error('This photo couldn’t be displayed.'))
            reported.current = true
          }}
        />
      )}
      {!url && (
        <span className="cn-media-state" aria-hidden="true">
          {failed && <ImageSquare />}
        </span>
      )}
    </button>
  )
}

export function MessageImage({ attachment, conversationPath, onOpen, onUnavailable }) {
  if (!attachment) return null
  const storagePath = attachment.preview_url
    ? null
    : `${conversationPath}/${String(attachment.file || '').replace(/^\/+/, '')}`
  return (
    <ManagedImage
      attachment={attachment}
      storagePath={storagePath}
      className="cn-message-image"
      alt="photo attachment"
      onOpen={onOpen}
      onUnavailable={onUnavailable}
    />
  )
}

export function BoardImage({ post, onOpen, onUnavailable }) {
  const gallery = Array.isArray(post?.attachments) && post.attachments.length
    ? post.attachments.slice(0, 4)
    : null
  if (gallery) {
    if (gallery.length === 1) {
      return (
        <ManagedImage
          attachment={gallery[0]} postId={post.id} index={0}
          className="cn-board-image" alt="post photo"
          onOpen={onOpen} onUnavailable={onUnavailable}
        />
      )
    }
    return (
      <div className={`cn-gallery cn-gallery-${gallery.length}`}>
        {gallery.map((attachment, i) => (
          <ManagedImage
            key={i} attachment={attachment} postId={post.id} index={i}
            className="cn-gallery-item" alt={`post photo ${i + 1}`} square
            onOpen={onOpen} onUnavailable={onUnavailable}
          />
        ))}
      </div>
    )
  }
  if (!post?.attachment) return null
  return (
    <ManagedImage
      attachment={post.attachment}
      postId={post.id}
      className="cn-board-image"
      alt="post photo"
      onOpen={onOpen}
      onUnavailable={onUnavailable}
    />
  )
}

export function SelectedImageStrip({ selected, onRemove }) {
  if (!selected) return null
  return (
    <div className="cn-selected-image">
      <img src={selected.previewUrl} alt="Selected attachment preview" />
      <span>
        <strong>Photo ready</strong>
        <small>{selected.payload.w} × {selected.payload.h}</small>
      </span>
      <button type="button" onClick={onRemove} aria-label="Remove photo">
        <X aria-hidden="true" />
      </button>
    </div>
  )
}

export function SelectedImagesStrip({ selected, onRemove }) {
  if (!selected?.length) return null
  return (
    <div className="cn-selected-gallery">
      {selected.map((image, i) => (
        <div className="cn-selected-thumb" key={image.id ?? i}>
          <img src={image.previewUrl} alt={`Selected image ${i + 1}`} />
          <button type="button" onClick={() => onRemove(i)}
                  aria-label={`Remove image ${i + 1}`}>
            <X aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  )
}

export function Lightbox({ image, onClose }) {
  const closeRef = useRef(null)
  const closeAction = useRef(onClose)
  const returnFocus = useRef(null)
  closeAction.current = onClose

  useEffect(() => {
    if (!image) return undefined
    returnFocus.current = document.activeElement
    const onKeyDown = (event) => {
      if (event.key === 'Escape') closeAction.current()
      if (event.key === 'Tab') {
        event.preventDefault()
        closeRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    closeRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      image.cleanup?.()
      returnFocus.current?.focus?.()
    }
  }, [image?.url])

  if (!image) return null
  return (
    <div className="cn-lightbox" role="dialog" aria-modal="true" aria-label="Image preview"
         onClick={onClose}>
      <button ref={closeRef} className="cn-lightbox-close" type="button"
              onClick={(event) => { event.stopPropagation(); onClose() }} aria-label="Close image preview">
        <X aria-hidden="true" />
      </button>
      <img src={image.url} alt={image.alt || 'Expanded image'} onClick={(event) => event.stopPropagation()} />
    </div>
  )
}
