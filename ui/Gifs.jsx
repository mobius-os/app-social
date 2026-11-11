import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Search, X } from '@openai/apps-sdk-ui/components/Icon'
import { fetchGifs, resolveGifKey, splitGifMessage } from '../gifs.js'
import { getGifKey } from '../api.js'
import { keepMessageFocus } from './MessageInput.jsx'
import { useModalFocus } from './modalFocus.js'

// The composer's GIF button: a labelled text mark, since "GIF" is the domain
// object itself rather than interface chrome.
export function GifButton({ onClick, disabled, label = 'Add a GIF' }) {
  return <button className="cn-gif-button" type="button" onClick={onClick}
                 onMouseDown={keepMessageFocus} disabled={disabled} aria-label={label}>
    GIF
  </button>
}

// A chosen GIF waits in the composer, like a photo, until Send.
export function SelectedGifStrip({ gif, onRemove, disabled = false }) {
  if (!gif) return null
  return (
    <div className="cn-selected-gallery">
      <div className="cn-selected-thumb">
        <img src={gif.preview?.url || gif.url} alt={gif.title} referrerPolicy="no-referrer" />
        <button className="cn-selected-remove" type="button" onClick={onRemove}
                onPointerDown={event => event.preventDefault()} disabled={disabled}
                aria-label="Remove GIF">
          <X aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

// A KLIPY link shown as the GIF itself. If the device can't load it (an older
// Möbius without direct-site access, or KLIPY removed it), the link stays.
export function KlipyGif({ url }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return <a className="cn-gif-fallback" href={url} target="_blank" rel="noopener noreferrer"
              onClick={(event) => event.stopPropagation()}>{url}</a>
  }
  return (
    <span className="cn-gif-frame">
      <img className="cn-gif" src={url} alt="GIF" loading="lazy" decoding="async"
           referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      <span className="cn-gif-credit" aria-hidden="true">KLIPY</span>
    </span>
  )
}

export function GifText({ text, className, children }) {
  const gif = splitGifMessage(text)
  if (!gif) return children
  return <>
    {gif.caption && <p className={className}>{gif.caption}</p>}
    <KlipyGif url={gif.url} />
  </>
}

export function GifPicker({ open, onClose, onPick }) {
  const dialogRef = useModalFocus(open, onClose)
  const [query, setQuery] = useState('')
  const [state, setState] = useState({ gifs: [], page: 0, hasMore: false, status: 'idle', error: '' })
  const request = useRef(null)
  // The key comes from this installation or, for members, the community host.
  const [key, setKey] = useState({ status: 'idle', value: null, error: '' })
  const [keyAttempt, setKeyAttempt] = useState(0)
  const available = key.status === 'ready'

  useEffect(() => {
    if (!open) return undefined
    const controller = new AbortController()
    setKey((prior) => (prior.value ? prior : { status: 'loading', value: null, error: '' }))
    resolveGifKey(getGifKey, { signal: controller.signal })
      .then((value) => setKey({ status: 'ready', value, error: '' }))
      .catch((error) => {
        if (error?.name === 'AbortError') return
        setKey({ status: error.code === 'unconfigured' ? 'unconfigured' : 'error', value: null, error: error.message })
      })
    return () => controller.abort()
  }, [open, keyAttempt])

  async function load(q, page) {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setState((prior) => ({ ...prior, status: 'loading', error: '', ...(page === 1 ? { gifs: [] } : {}) }))
    try {
      const result = await fetchGifs({ query: q, page, signal: controller.signal, key: key.value })
      if (controller.signal.aborted) return
      setState((prior) => ({
        gifs: page === 1 ? result.gifs : [...prior.gifs, ...result.gifs],
        page, hasMore: result.hasMore, status: 'ready', error: '',
      }))
    } catch (error) {
      if (error?.name === 'AbortError') return
      setState((prior) => ({ ...prior, status: 'error', error: error.message }))
    }
  }

  useEffect(() => {
    if (!open || !available) return undefined
    const timer = setTimeout(() => load(query, 1), query.trim() ? 350 : 0)
    return () => clearTimeout(timer)
  }, [open, query, available])

  useEffect(() => {
    if (open) return undefined
    request.current?.abort()
    setQuery('')
    setState({ gifs: [], page: 0, hasMore: false, status: 'idle', error: '' })
    return undefined
  }, [open])

  if (!open) return null
  const { gifs, status, error, hasMore, page } = state
  const searching = query.trim()
  return createPortal(
    <div className="cn-scrim cn-gif-scrim" onClick={onClose}>
      <div className="cn-sheet cn-gif-sheet" role="dialog" aria-modal="true" aria-label="Choose a GIF"
           ref={dialogRef} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <div className="cn-grabber" aria-hidden="true" />
        <div className="cn-gif-head">
          <label className="cn-gif-search">
            <Search aria-hidden="true" />
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
                   placeholder="Search KLIPY" aria-label="Search KLIPY" autoComplete="off"
                   enterKeyHint="search" inputMode="search" maxLength={100} disabled={!available} />
          </label>
          <button className="cn-icon-btn cn-gif-close" type="button" onClick={onClose} aria-label="Close">
            <X aria-hidden="true" />
          </button>
        </div>
        <p className="cn-gif-heading">{searching ? 'Results' : 'Trending'}</p>
        {key.status === 'unconfigured' ? (
          <p className="cn-gif-note">GIF search isn’t set up yet.</p>
        ) : key.status === 'error' ? (
          <div className="cn-gif-note" role="alert">
            <p>{key.error}</p>
            <button className="cn-btn cn-btn-secondary" type="button" onClick={() => setKeyAttempt((n) => n + 1)}>Try again</button>
          </div>
        ) : !available ? (
          <div className="cn-gif-grid" aria-busy="true">
            {Array.from({ length: 9 }, (_, i) => <span key={i} className="cn-gif-tile is-loading" aria-hidden="true" />)}
          </div>
        ) : status === 'error' && !gifs.length ? (
          <div className="cn-gif-note" role="alert">
            <p>{error}</p>
            <button className="cn-btn cn-btn-secondary" type="button" onClick={() => load(query, 1)}>Try again</button>
          </div>
        ) : status === 'ready' && !gifs.length ? (
          <p className="cn-gif-note">No GIFs found for “{searching}”.</p>
        ) : (
          <div className="cn-gif-grid" aria-busy={status === 'loading'}>
            {gifs.map((gif, index) => gif.send ? (
              <button key={`${gif.id}-${index}`} className="cn-gif-tile" type="button"
                      onClick={() => onPick(gif)} aria-label={gif.title}>
                <img src={gif.preview.url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
              </button>
            ) : (
              <span key={`${gif.id}-${index}`} className="cn-gif-tile is-unavailable" role="img"
                    aria-label={`${gif.title} (unavailable)`} />
            ))}
            {status === 'loading' && Array.from({ length: gifs.length ? 3 : 9 }, (_, i) => (
              <span key={`skeleton-${i}`} className="cn-gif-tile is-loading" aria-hidden="true" />
            ))}
          </div>
        )}
        {available && hasMore && status !== 'loading' && gifs.length > 0 && (
          <button className="cn-btn cn-btn-secondary cn-gif-more" type="button" onClick={() => load(query, page + 1)}>
            {status === 'error' ? 'Try loading more again' : 'Load more'}
          </button>
        )}
        <p className="cn-gif-powered">Powered by KLIPY</p>
      </div>
    </div>,
    document.body,
  )
}

// One staged GIF per composer, shared by messages, posts and replies.
export function useGifChoice() {
  const [gif, setGif] = useState(null)
  const [picking, setPicking] = useState(false)
  return {
    gif, setGif, picking,
    open: () => setPicking(true),
    close: () => setPicking(false),
    pick: (chosen) => {
      setGif({ url: chosen.send.url, title: chosen.title, preview: chosen.preview })
      setPicking(false)
    },
  }
}
