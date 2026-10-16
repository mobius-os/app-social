import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, ImageSquare, Minus, Plus, X } from '@openai/apps-sdk-ui/components/Icon'
import { getBoardMedia, getReplyMedia } from '../api.js'
import { boardThumbnail } from '../boardMediaCache.js'
import {
  clampLightboxScale, pinchLightboxScale, wheelLightboxScale, gallerySwipeDirection,
} from './interactionRules.js'
import { useModalFocus } from './modalFocus.js'
import { IMAGE_MAX_BYTES, GIF_MAX_BYTES, IMAGE_MAX_SIDE, THUMBNAIL_MAX_BYTES } from '../media_limits.js'

const MAX_BYTES = IMAGE_MAX_BYTES
const MAX_SIDE = IMAGE_MAX_SIDE

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

export async function prepareImage(file, maxBytes) {
  if (!file?.type?.startsWith('image/')) throw new Error('Choose an image file.')
  const header = await file.slice(0, 10).arrayBuffer()
  const signature = new TextDecoder().decode(header.slice(0, 6))
  const gif = file.type === 'image/gif' || signature === 'GIF87a' || signature === 'GIF89a'
  const originalLimit = gif ? GIF_MAX_BYTES : MAX_BYTES
  maxBytes = Math.min(maxBytes ?? originalLimit, originalLimit)
  // Never resize an animation by drawing its first frame as the original.
  // The signed service validates the complete container and decoded frames.
  if (gif && file.size > maxBytes) {
    throw new Error(`This GIF is too large. Choose a smaller GIF, up to ${Math.floor(maxBytes / (1024 * 1024))} MB.`)
  }
  if (gif && header.byteLength === 10) {
    const dimensions = new DataView(header)
    if (Math.max(dimensions.getUint16(6, true), dimensions.getUint16(8, true)) > MAX_SIDE) {
      throw new Error('This GIF is too wide or tall. Choose one up to 1600 pixels on its longest side.')
    }
  }

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
    if (gif && Math.max(originalWidth, originalHeight) > MAX_SIDE) {
      throw new Error('This GIF is too wide or tall. Choose one up to 1600 pixels on its longest side.')
    }

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
    const transparent = hasTransparency(context, width, height)
    const mime = gif ? 'image/gif' : transparent ? 'image/png' : 'image/jpeg'
    if (mime === 'image/jpeg') draw(true)
    let blob = gif ? file : await canvasBlob(canvas, mime)

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

async function gifPoster(blob) {
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height))
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('This GIF preview couldn’t be prepared.')
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return await canvasBlob(canvas, 'image/webp', 0.74)
  } finally {
    bitmap.close?.()
  }
}

function ManagedImage({ attachment, storagePath, postId, replyId, index, className, alt, onOpen, onUnavailable, square }) {
  const directUrl = attachment?.preview_url || null
  const gif = attachment?.mime === 'image/gif'
  const [url, setUrl] = useState(gif ? null : directUrl)
  const [fullUrl, setFullUrl] = useState(null)
  const [failed, setFailed] = useState(false)
  const reported = useRef(false)
  const width = Number(attachment?.w) || 4
  const height = Number(attachment?.h) || 3

  useEffect(() => {
    let active = true
    const objectUrls = []
    setFailed(false)
    reported.current = false
    setFullUrl(null)
    if (directUrl && !gif) {
      setUrl(directUrl)
      return () => { active = false }
    }
    setUrl(null)
    const load = directUrl
      ? fetch(directUrl).then(response => response.blob())
      : postId
      ? boardThumbnail(postId, index, replyId)
      : window.mobius?.storage?.getBlob?.(storagePath)
    if (!load?.then) {
      setFailed(true)
      onUnavailable?.(new Error('Photo storage is unavailable.'))
      reported.current = true
      return () => { active = false }
    }
    load
      .then(async (blob) => {
        if (!active || !blob?.size) {
          if (active) {
            setFailed(true)
            if (!reported.current) onUnavailable?.(new Error('This photo is empty.'))
            reported.current = true
          }
          return
        }
        // Public posters come from the host. Private originals stay local;
        // show a still frame until the owner explicitly opens the animation.
        const poster = gif && (!postId || directUrl) ? await gifPoster(blob) : blob
        if (!active) return
        const objectUrl = URL.createObjectURL(poster)
        objectUrls.push(objectUrl)
        if (poster !== blob) {
          const originalUrl = URL.createObjectURL(blob)
          objectUrls.push(originalUrl)
          setFullUrl(originalUrl)
        }
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
      objectUrls.forEach(objectUrl => URL.revokeObjectURL(objectUrl))
    }
  }, [directUrl, postId, replyId, index, storagePath, gif])

  return (
    <button
      className={`cn-media ${className}${attachment?.mime === 'image/png' ? ' is-transparent' : ''}`}
      type="button"
      style={square ? undefined : { aspectRatio: `${width} / ${height}` }}
      onClick={async () => {
        if (!url) return
        if (!postId || directUrl) {
          onOpen(fullUrl || url, gif ? 'GIF attachment' : alt)
          return
        }
        try {
          const full = replyId
            ? await getReplyMedia(postId, replyId, { mime: attachment?.mime })
            : await getBoardMedia(postId, index, { mime: attachment?.mime })
          const fullUrl = URL.createObjectURL(full)
          onOpen(fullUrl, alt, () => URL.revokeObjectURL(fullUrl))
        } catch (error) {
          if (gif) {
            onUnavailable?.(error)
            return
          }
          onOpen(url, alt)
        }
      }}
      disabled={!url}
      aria-label={url ? gif ? 'Play GIF attachment' : `Open ${alt}` : failed ? `${alt} unavailable` : `Loading ${alt}`}
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
      {url && gif && <span className="cn-media-gif" aria-hidden="true">GIF</span>}
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
            onOpen={(url, alt, cleanup) => onOpen(url, alt, cleanup, {
              index: i,
              items: gallery.map((item, index) => ({
                alt: `post photo ${index + 1}`,
                load: async () => {
                  let blob
                  try {
                    blob = await getBoardMedia(post.id, index, { mime: item.mime })
                  } catch (error) {
                    if (item.mime === 'image/gif') throw error
                    blob = await boardThumbnail(post.id, index)
                  }
                  const url = URL.createObjectURL(blob)
                  return { url, cleanup: () => URL.revokeObjectURL(url) }
                },
              })),
            })} onUnavailable={onUnavailable}
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

export function ReplyImage({ postId, reply, onOpen, onUnavailable }) {
  if (!reply?.attachment) return null
  return <ManagedImage attachment={reply.attachment} postId={postId} replyId={reply.id}
    className="cn-reply-image" alt="reply photo" onOpen={onOpen} onUnavailable={onUnavailable} />
}

export function SelectedImageStrip({ selected, onRemove, disabled = false, onOpen }) {
  if (!selected) return null
  return <SelectedImagesStrip selected={[selected]} onRemove={onRemove}
    disabled={disabled} onOpen={onOpen} />
}

export function SelectedImagesStrip({ selected, onRemove, disabled = false, onOpen }) {
  if (!selected?.length) return null
  return (
    <div className="cn-selected-gallery">
      {selected.map((image, i) => (
        <div className="cn-selected-thumb" key={image.id ?? i}>
          <button className="cn-selected-preview" type="button"
            onPointerDown={event => event.preventDefault()}
            onClick={() => onOpen?.(image.previewUrl, `Selected photo ${i + 1}`, undefined, {
              index: i,
              items: selected.map((item, index) => ({ url: item.previewUrl, alt: `Selected photo ${index + 1}` })),
            })}
            aria-label={`Preview selected photo ${i + 1}`}>
            <img src={image.previewUrl} alt="" />
          </button>
          <button className="cn-selected-remove" type="button" onClick={() => onRemove(i)}
                  onPointerDown={event => event.preventDefault()} disabled={disabled}
                  aria-label={selected.length === 1 ? 'Remove photo' : `Remove image ${i + 1}`}>
            <X aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  )
}

export function Lightbox({ image, onClose }) {
  return image ? <LightboxViewer key={image.url} image={image} onClose={onClose} /> : null
}

function LightboxViewer({ image, onClose }) {
  const rootRef = useModalFocus(true, onClose)
  const items = image.gallery?.items || [image]
  const initialIndex = image.gallery?.index || 0
  const [activeIndex, setActiveIndex] = useState(initialIndex)
  const [loaded, setLoaded] = useState(image)
  const [loadError, setLoadError] = useState('')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const pointers = useRef(new Map())
  const pinch = useRef(null)
  const swipe = useRef(null)
  const suppressClick = useRef(false)
  const startedOnBackdrop = useRef(false)
  const scaleRef = useRef(1)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })

  function moveGallery(delta) {
    setActiveIndex(current => Math.max(0, Math.min(items.length - 1, current + delta)))
  }

  useEffect(() => {
    let active = true
    let cleanup
    applyZoom(1)
    pointers.current.clear()
    pinch.current = null
    swipe.current = null
    setLoadError('')
    if (activeIndex === initialIndex) {
      setLoaded(image)
    } else {
      const item = items[activeIndex]
      setLoaded(null)
      Promise.resolve().then(() => item.load ? item.load() : item)
        .then(result => {
          if (!active) { result.cleanup?.(); return }
          cleanup = result.cleanup
          setLoaded({ ...result, alt: item.alt })
        })
        .catch(() => { if (active) setLoadError('This image couldn’t be loaded.') })
    }
    return () => { active = false; cleanup?.() }
  }, [activeIndex, loadAttempt])

  useEffect(() => () => image.cleanup?.(), [image])

  function applyZoom(next) {
    const current = scaleRef.current
    const value = clampLightboxScale(typeof next === 'function' ? next(current) : next)
    scaleRef.current = value
    setScale(value)
    if (value === 1) setOffset({ x: 0, y: 0 })
  }

  function zoomWithWheel(event) {
    event.preventDefault()
    applyZoom(wheelLightboxScale(scaleRef.current, event.deltaY))
  }

  function pointerDistance() {
    const points = [...pointers.current.values()]
    if (points.length < 2) return 0
    return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)
  }

  function startImageMove(event) {
    if (event.target.closest?.('button')) return
    event.stopPropagation()
    if (pointers.current.size === 0) {
      startedOnBackdrop.current = event.target === event.currentTarget
      suppressClick.current = false
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.current.size === 1 && scaleRef.current === 1) {
      suppressClick.current = false
      swipe.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
    } else {
      swipe.current = null
      suppressClick.current = true
    }
    if (pointers.current.size === 2) {
      pinch.current = { distance: pointerDistance(), scale: scaleRef.current }
    }
  }

  function moveImage(event) {
    const previous = pointers.current.get(event.pointerId)
    if (!previous) return
    event.preventDefault()
    if (Math.hypot(event.clientX - previous.x, event.clientY - previous.y) > 3) suppressClick.current = true
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.current.size >= 2 && pinch.current?.distance) {
      applyZoom(pinchLightboxScale(pinch.current.scale, pinch.current.distance, pointerDistance()))
      return
    }
    if (scaleRef.current > 1) {
      setOffset((current) => ({
        x: current.x + event.clientX - previous.x,
        y: current.y + event.clientY - previous.y,
      }))
    }
  }

  function endImageMove(event) {
    const start = swipe.current
    if (event.type === 'pointerup' && start?.id === event.pointerId && scaleRef.current === 1) {
      const delta = gallerySwipeDirection(event.clientX - start.x, event.clientY - start.y)
      if (delta) { suppressClick.current = true; moveGallery(delta) }
    }
    swipe.current = null
    pointers.current.delete(event.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  useEffect(() => {
    if (!image) return undefined
    setScale(1)
    scaleRef.current = 1
    setOffset({ x: 0, y: 0 })
    pointers.current.clear()
    pinch.current = null
    const onKeyDown = (event) => {
      const delta = event.key === '+' || event.key === '=' ? 0.25
        : event.key === '-' ? -0.25
          : null
      if (delta !== null) {
        event.preventDefault()
        applyZoom(scaleRef.current + delta)
      } else if (event.key === '0') {
        event.preventDefault()
        applyZoom(1)
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        event.stopPropagation()
        moveGallery(event.key === 'ArrowLeft' ? -1 : 1)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    const cancelGesture = () => {
      pointers.current.clear()
      pinch.current = null
      swipe.current = null
    }
    window.addEventListener('blur', cancelGesture)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', cancelGesture)
    }
  }, [image])

  if (!image) return null
  return (
    <div ref={rootRef} className="cn-lightbox" role="dialog" aria-modal="true" aria-label="Image preview"
         onClick={onClose}>
      <button className="cn-lightbox-close" type="button"
              onClick={(event) => { event.stopPropagation(); onClose() }} aria-label="Close image preview">
        <X aria-hidden="true" />
      </button>
      <div className={`cn-lightbox-stage${scale > 1 ? ' is-zoomed' : ''}`}
           onClick={(event) => {
             event.stopPropagation()
             if (suppressClick.current) { suppressClick.current = false; return }
             if (event.target === event.currentTarget && startedOnBackdrop.current) onClose()
           }} onWheel={zoomWithWheel}
           onPointerDown={startImageMove} onPointerMove={moveImage}
           onPointerUp={endImageMove} onPointerCancel={endImageMove} onLostPointerCapture={endImageMove}
           onDoubleClick={() => applyZoom(scale > 1 ? 1 : 2)}>
        {loaded && <img src={loaded.url} alt={loaded.alt || 'Expanded image'} draggable="false"
             onError={() => { setLoaded(null); setLoadError('This image couldn’t be displayed.') }}
             style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})` }} />}
        {!loaded && <div className="cn-lightbox-status" role="status">
          {loadError || 'Loading image…'}
          {loadError && <button type="button" onClick={() => setLoadAttempt(value => value + 1)}>Retry image</button>}
        </div>}
      </div>
      {items.length > 1 && <div className="cn-lightbox-gallery" aria-label="Gallery navigation" onClick={event => event.stopPropagation()}>
        <button type="button" onClick={() => moveGallery(-1)} disabled={activeIndex === 0} aria-label="Previous image"><ChevronLeft aria-hidden="true" /></button>
        <span role="status" aria-live="polite">{activeIndex + 1} / {items.length}</span>
        <button type="button" onClick={() => moveGallery(1)} disabled={activeIndex === items.length - 1} aria-label="Next image"><ChevronRight aria-hidden="true" /></button>
      </div>}
      <div className="cn-lightbox-controls" aria-label="Image zoom controls">
        <button type="button" onClick={(event) => { event.stopPropagation(); applyZoom(scale - 0.25) }}
                disabled={scale <= 1} aria-label="Zoom out"><Minus aria-hidden="true" /></button>
        <button type="button" className="cn-lightbox-reset"
                onClick={(event) => { event.stopPropagation(); applyZoom(1) }} aria-label="Reset zoom">
          {Math.round(scale * 100)}%
        </button>
        <button type="button" onClick={(event) => { event.stopPropagation(); applyZoom(scale + 0.25) }}
                disabled={scale >= 4} aria-label="Zoom in"><Plus aria-hidden="true" /></button>
      </div>
    </div>
  )
}
