import { useEffect, useState } from 'react'
import { Search, Telescope } from '@openai/apps-sdk-ui/components/Icon'
import { searchPeople } from '../api.js'
import { Avatar, useProfile } from './Board.jsx'
import { useModalFocus } from './modalFocus.js'
import { membershipDuration } from '../profile.js'

const DIRECTORY_CACHE_MAX_AGE_MS = 60_000

export default function People({ me, canMessage, onMessage, showToast, requestedProfile, onProfileRequestHandled }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [state, setState] = useState('loading')
  const [searchAttempt, setSearchAttempt] = useState(0)
  const [selectedHost, setSelectedHost] = useState(null)
  const [selectedSeed, setSelectedSeed] = useState(null)
  const [profileAttempt, setProfileAttempt] = useState(0)
  const closeProfile = () => setSelectedHost(null)
  const profileRef = useModalFocus(Boolean(selectedHost), closeProfile)

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    let timer = null
    const normalizedQuery = query.trim()
    setState('loading')
    if (normalizedQuery) setResults(null)

    const search = async () => {
      try {
        const found = await searchPeople(query, controller.signal)
        if (!active) return
        setResults(found.users)
        setState('ready')
        if (!normalizedQuery) {
          window.mobius?.storage?.set('cache/people.json', {
            users: found.users,
            cached_at: Date.now(),
          }).catch(() => null)
        }
      } catch (error) {
        if (!active) return
        window.mobius?.signal?.('error', { message: error.message, source: 'people' })
        setState('error')
      }
    }

    if (normalizedQuery) {
      // Debounce belongs to this query; cleanup invalidates both timer and response.
      timer = setTimeout(search, 180)
    } else {
      window.mobius?.storage?.get('cache/people.json').then((cached) => {
        if (!active) return
        const hasPeople = Array.isArray(cached?.users)
        if (hasPeople) {
          setResults(cached.users)
          setState('ready')
        }
        if (hasPeople && Date.now() - Number(cached.cached_at || 0) < DIRECTORY_CACHE_MAX_AGE_MS) return
        search()
      }).catch(search)
    }
    return () => { active = false; clearTimeout(timer); controller.abort() }
  }, [query, searchAttempt])

  useEffect(() => {
    if (requestedProfile) {
      setSelectedHost(requestedProfile)
      setSelectedSeed(null)
      onProfileRequestHandled?.()
    }
  }, [requestedProfile])

  // Optimistic profile: paints the row's known handle/bio (or shared cache) at
  // once and reconciles the full actor quietly — no spinner when we already
  // know who this is, and no "unavailable" when the seed is enough.
  const { profile, state: profileState } = useProfile(selectedHost, selectedSeed, profileAttempt)

  const profileTenure = profileState === 'ready' && profile ? membershipDuration(profile) : ''

  return (
    <div className={`cn-content cn-screen${selectedHost ? ' has-dialog' : ''}`}>
      <div className="cn-view-heading"><div><h2>People</h2><p>Find someone by their Möbius handle.</p></div></div>
      <div className="cn-search">
        <Search aria-hidden="true" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          type="search" autoComplete="off" spellCheck={false}
          placeholder="Search people by handle"
          aria-label="Search people"
        />
        {query && <button className="cn-search-clear" onClick={() => setQuery('')} aria-label="Clear people search">Clear</button>}
      </div>

      {state === 'loading' && <p className="cn-search-status" role="status">Searching people…</p>}
      {state === 'error' && (
        <div className="cn-empty">
          <div className="cn-empty-title">Directory unavailable</div>
          <p className="cn-empty-text">The global directory couldn’t be reached right now.</p>
          <button className="cn-btn cn-btn-secondary" onClick={() => setSearchAttempt(attempt => attempt + 1)}>Try again</button>
        </div>
      )}

      <div className="cn-people-list">
        {(results || []).map((user) => (
          <button className="cn-row" key={user.host}
                  onClick={() => { setSelectedHost(user.host); setSelectedSeed(user) }}>
            <Avatar name={user.handle} host={user.host} remote lazy />
            <span className="cn-row-copy">
              <span className="cn-row-top">
                <strong>{user.handle ? `@${user.handle}` : 'Social member'}{user.host === me?.host ? ' (you)' : ''}</strong>
              </span>
              {user.bio ? <span className="cn-preview">{user.bio}</span> : null}
            </span>
          </button>
        ))}
        {state === 'ready' && (results || []).length === 0 && (
          <div className="cn-empty">
            <div className="cn-empty-mark" aria-hidden="true"><Telescope /></div>
            <div className="cn-empty-title">No one found</div>
            <p className="cn-empty-text">
              Try a different handle. If your friend is missing, ask them to join global Social.
            </p>
            {query && query.includes('.') && (
              <button
                className="cn-btn cn-btn-primary"
                style={{ marginTop: '0.75rem' }}
                onClick={() => { const h = query.trim().replace(/^@/, ''); setSelectedHost(h); setSelectedSeed({ host: h }) }}
              >
                Connect with {query.trim()} directly
              </button>
            )}
          </div>
        )}
      </div>

      {selectedHost && (
        <div className="cn-scrim" role="dialog" aria-modal="true" aria-label="Profile"
             onClick={closeProfile}>
          <div ref={profileRef} tabIndex={-1} className="cn-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="cn-dialog-head">
              <h3 className="cn-sheet-title">Profile</h3>
              <button className="cn-btn cn-btn-ghost" onClick={closeProfile}>Close</button>
            </div>
            {profileState === 'loading'  && <div className="cn-center"><div className="cn-spinner" /></div>}
            {profileState === 'error' && (
              <>
                <h3 className="cn-sheet-title">Profile unavailable</h3>
                <p className="cn-sheet-body">
                  This person couldn’t be reached. They may be offline right now.
                </p>
                <div className="cn-sheet-actions">
                  <button className="cn-btn cn-btn-secondary" onClick={() => setProfileAttempt(attempt => attempt + 1)}>Try again</button>
                </div>
              </>
            )}
            {profileState === 'ready' && profile && (
              <>
                <div className="cn-profile-head">
                  <Avatar name={profile.handle} host={profile.host} size="large" remote />
                  <div className="cn-profile-copy">
                    <h3 className="cn-profile-name">{profile.handle ? `@${profile.handle}` : 'Social member'}</h3>
                    {profileTenure && <p className="cn-profile-tenure">{profileTenure}</p>}
                  </div>
                </div>
                {profile.bio ? <p className="cn-bio">{profile.bio}</p> : null}
                <div className="cn-sheet-actions">
                  {canMessage && profile.host !== me?.host && (
                    <button
                      className="cn-btn cn-btn-primary"
                      onClick={() => { const p = profile; closeProfile(); onMessage(p.host, p.handle) }}
                    >
                      Message directly
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
