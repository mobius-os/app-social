import { useEffect, useState } from 'react'
import { Search, Telescope } from '@openai/apps-sdk-ui/components/Icon'
import { searchPeople, getPeer } from '../api.js'
import { Avatar } from './Board.jsx'
import { useModalFocus } from './modalFocus.js'

const monthYear = new Intl.DateTimeFormat(undefined, {
  month: 'short', year: 'numeric', timeZone: 'UTC',
})

function formatMonthYear(value, unixSeconds = false) {
  if (value === null || value === undefined || value === '') return ''
  const date = unixSeconds ? new Date(Number(value) * 1000) : new Date(value)
  return Number.isNaN(date.getTime()) ? '' : monthYear.format(date)
}

function tenureLine(profile) {
  const memberSince = formatMonthYear(profile.member_since)
  const joinedSocial = formatMonthYear(profile.joined_at, true)
  if (memberSince && joinedSocial) {
    return `On Möbius since ${memberSince} · joined Social ${joinedSocial}`
  }
  if (memberSince) return `On Möbius since ${memberSince}`
  if (joinedSocial) return `Joined Social ${joinedSocial}`
  return ''
}

function appInitial(name) {
  return Array.from(String(name || '').trim())[0]?.toLocaleUpperCase() || 'A'
}

export default function People({ me, canMessage, onMessage, showToast, requestedProfile, onProfileRequestHandled }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [state, setState] = useState('loading')
  const [profile, setProfile] = useState(null)
  const [profileState, setProfileState] = useState('idle')
  const [searchAttempt, setSearchAttempt] = useState(0)
  const [selectedHost, setSelectedHost] = useState(null)
  const [profileAttempt, setProfileAttempt] = useState(0)
  const closeProfile = () => setSelectedHost(null)
  const profileRef = useModalFocus(Boolean(selectedHost), closeProfile)

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setState('loading')
    setResults(null)
    // Debounce belongs to this query; cleanup invalidates both timer and response.
    const timer = setTimeout(async () => {
      try {
        const found = await searchPeople(query, controller.signal)
        if (!active) return
        setResults(found.users)
        setState('ready')
      } catch (error) {
        if (!active) return
        window.mobius?.signal?.('error', { message: error.message, source: 'people' })
        setState('error')
      }
    }, query ? 250 : 0)
    return () => { active = false; clearTimeout(timer); controller.abort() }
  }, [query, searchAttempt])

  useEffect(() => {
    if (requestedProfile) {
      setSelectedHost(requestedProfile)
      onProfileRequestHandled?.()
    }
  }, [requestedProfile])

  useEffect(() => {
    if (!selectedHost) return
    const controller = new AbortController()
    let active = true
    setProfile(null)
    setProfileState('loading')
    getPeer(selectedHost, controller.signal).then(actor => {
      if (!active) return
      setProfile(actor)
      setProfileState('ready')
    }).catch(() => {
      if (active) setProfileState('error')
    })
    return () => { active = false; controller.abort() }
  }, [selectedHost, profileAttempt])

  const profileTenure = profileState === 'ready' && profile ? tenureLine(profile) : ''
  const profileApps = profileState === 'ready' && Array.isArray(profile?.apps)
    ? profile.apps
      .map((app) => ({
        name: String(app?.name || '').trim(),
        description: String(app?.description || '').trim(),
      }))
      .filter((app) => app.name)
    : []

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
          <button className="cn-row" key={user.host} onClick={() => setSelectedHost(user.host)}>
            <Avatar name={user.handle} host={user.host} />
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
                onClick={() => setSelectedHost(query.trim().replace(/^@/, ''))}
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
                  <Avatar name={profile.handle} host={profile.host} size="large" />
                  <div className="cn-profile-copy">
                    <h3 className="cn-profile-name">{profile.handle ? `@${profile.handle}` : 'Social member'}</h3>
                    {profile.bio && <p className="cn-bio">{profile.bio}</p>}
                    {profileTenure && <p className="cn-profile-tenure">{profileTenure}</p>}
                  </div>
                </div>
                {profileApps.length > 0 && (
                  <section className="cn-profile-apps" aria-labelledby="cn-profile-apps-title">
                    <h4 className="cn-profile-section-title" id="cn-profile-apps-title">Apps</h4>
                    <div className="cn-profile-app-list">
                      {profileApps.map((app, index) => (
                        <div className="cn-profile-app-row" key={`${app.name}-${index}`}>
                          <span className="cn-profile-app-initial" aria-hidden="true">
                            {appInitial(app.name)}
                          </span>
                          <span className="cn-profile-app-copy">
                            <strong>{app.name}</strong>
                            <span>{app.description}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
                <div className="cn-sheet-actions">
                  {canMessage && profile.host !== me?.host && (
                    <button
                      className="cn-btn cn-btn-primary"
                      onClick={() => { const p = profile; closeProfile(); onMessage(p.host, p.handle) }}
                    >
                      Message
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
