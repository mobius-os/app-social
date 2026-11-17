import { useEffect, useRef, useState } from 'react'
import { Search, Telescope } from '@openai/apps-sdk-ui/components/Icon'
import { searchPeople, sendMessage, setCommunityRole } from '../api.js'
import { TEXT_LIMITS } from '../text_limits.js'
import Composer from './Composer.jsx'
import { GifButton, GifPicker, SelectedGifStrip, useGifChoice } from './Gifs.jsx'
import { gifCaptionLimit, gifTextOverflow, withGif } from '../gifs.js'
import { noteAvatarDigests } from '../avatarHints.js'
import { Avatar, RoleLabel, useProfile } from './Board.jsx'
import { useModalFocus } from './modalFocus.js'
import { focusProfileReturnTarget, membershipDuration, profileSendIdentity } from '../profile.js'
import { roleChangedMessage, roleOf as roleIn, sortByRole } from './communityRoles.js'

const DIRECTORY_CACHE_MAX_AGE_MS = 60_000

export default function People({
  me, canMessage, onMessage, showToast, requestedProfile, onProfileRequestHandled,
  communityRoles = {}, onRolesChanged,
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [state, setState] = useState('loading')
  const [searchAttempt, setSearchAttempt] = useState(0)
  const [selectedHost, setSelectedHost] = useState(null)
  const [selectedSeed, setSelectedSeed] = useState(null)
  const [profileAttempt, setProfileAttempt] = useState(0)
  const peopleSearchRef = useRef(null)
  const profileReturnFocus = useRef(null)
  const restoreProfileFocus = useRef(false)
  const closeProfile = () => {
    restoreProfileFocus.current = true
    setSelectedHost(null)
  }
  const gifChoice = useGifChoice()
  // The GIF picker is its own modal (portalled outside this sheet), so the
  // profile hands over Escape and Tab while it is open and keeps its focus.
  const profileRef = useModalFocus(Boolean(selectedHost) && !gifChoice.picking, closeProfile,
                                   !gifChoice.picking)

  // A profile opened from the Board crosses into this People surface, so its
  // original avatar button is already disconnected when the sheet closes.
  // Restore to a visible People control instead of leaving keyboard focus on
  // BODY (or on a detached feed button).
  useEffect(() => {
    if (selectedHost || !restoreProfileFocus.current) return
    restoreProfileFocus.current = false
    const target = profileReturnFocus.current
    profileReturnFocus.current = null
    focusProfileReturnTarget(target, peopleSearchRef.current)
  }, [selectedHost])

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
          noteAvatarDigests(cached.users)
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
  const roleOf = (host) => roleIn(communityRoles, host)
  const isOwner = Boolean(canMessage && me?.host && roleOf(me.host) === 'owner')
  const [roleBusy, setRoleBusy] = useState(false)
  const [confirmHandover, setConfirmHandover] = useState(false)
  useEffect(() => { setConfirmHandover(false) }, [selectedHost])
  // The profile sheet carries its own message box, so a first message needs
  // no detour through an empty thread. Sending opens the conversation.
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  // The message whose reply was lost, so pressing Send again resends it.
  const unconfirmed = useRef(null)
  useEffect(() => { setDraft(''); gifChoice.setGif(null); gifChoice.close() }, [selectedHost])
  const profileOverLimit = gifTextOverflow(draft, gifChoice.gif, TEXT_LIMITS.message)
  async function sendFromProfile(event) {
    event.preventDefault()
    const gif = gifChoice.gif
    const text = withGif(draft, gif)
    if (!text || sending || !profile || gifTextOverflow(draft, gif, TEXT_LIMITS.message)) return
    const target = profile
    setSending(true)
    const attempt = profileSendIdentity(unconfirmed.current, target.host, text)
    unconfirmed.current = attempt
    try {
      const result = await sendMessage(attempt.id, target.host, text, target.handle)
      unconfirmed.current = null
      if (result?.status === 'failed') {
        showToast(result.detail || 'This person couldn’t be reached.', 'error')
      }
      setDraft('')
      gifChoice.setGif(null)
      closeProfile()
      onMessage(target.host, target.handle)
    } catch (error) {
      // No reply (or a server error) means it may already be saved or
      // delivered: its id is kept, so Send again confirms this same message.
      const uncertain = !error.status || error.status >= 500
      showToast(uncertain
        ? 'Your message wasn’t confirmed. Send again to make sure; it won’t be sent twice.'
        : error.message || 'The message couldn’t be sent.', 'error')
    } finally {
      setSending(false)
    }
  }

  async function changeRole(target, role) {
    setRoleBusy(true)
    try {
      await setCommunityRole(target.host, role)
      showToast(roleChangedMessage(target, role), 'success')
      setConfirmHandover(false)
      await onRolesChanged?.()
    } catch (error) {
      showToast(error.message || 'The role couldn’t be changed.', 'error')
    } finally {
      setRoleBusy(false)
    }
  }

  return (
    <div className={`cn-content cn-screen${selectedHost ? ' has-dialog' : ''}`}>
      <div className="cn-search">
        <Search aria-hidden="true" />
        <input
          ref={peopleSearchRef}
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
        {sortByRole(results || [], communityRoles).map((user) => (
          <button className="cn-row" key={user.host}
                  onClick={(event) => {
                    profileReturnFocus.current = event.currentTarget
                    setSelectedHost(user.host)
                    setSelectedSeed(user)
                  }}>
            <Avatar name={user.handle} host={user.host} remote lazy />
            <span className="cn-row-copy">
              <span className="cn-row-top">
                <span className="cn-row-name">
                  <strong>{user.handle ? `@${user.handle}` : 'Social member'}{user.host === me?.host ? ' (you)' : ''}</strong>
                  <RoleLabel role={roleOf(user.host)} />
                </span>
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
                    <h3 className="cn-profile-name">{profile.handle ? `@${profile.handle}` : 'Social member'}
                      <RoleLabel role={roleOf(profile.host)} /></h3>
                    {profileTenure && <p className="cn-profile-tenure">{profileTenure}</p>}
                  </div>
                </div>
                {profile.bio ? <p className="cn-bio">{profile.bio}</p> : null}
                {canMessage && profile.host !== me?.host && (
                  <Composer className="cn-profile-composer" value={draft}
                            onChange={setDraft}
                            onSubmit={sendFromProfile} disabled={sending}
                            sendDisabled={sending || profileOverLimit > 0 || (!draft.trim() && !gifChoice.gif)}
                            maxLength={gifCaptionLimit(TEXT_LIMITS.message, gifChoice.gif)}
                            overLimit={profileOverLimit}
                            placeholder={profile.handle ? `Message @${profile.handle}` : 'Message'}
                            gifAction={<GifButton onClick={gifChoice.open} disabled={sending} />}>
                    {gifChoice.gif && <SelectedGifStrip gif={gifChoice.gif} disabled={sending}
                                                        onRemove={() => gifChoice.setGif(null)} />}
                  </Composer>
                )}
                <GifPicker open={gifChoice.picking} onClose={gifChoice.close} onPick={gifChoice.pick} />
                {isOwner && profile.host !== me?.host && (
                  <section className="cn-role-manage" aria-label="Community role">
                    <h4>Community role</h4>
                    {confirmHandover ? (
                      <>
                        <p className="cn-sheet-body">
                          Make {profile.handle ? `@${profile.handle}` : 'them'} the Community owner? You’ll become an admin,
                          and only the new owner can change roles after this.
                        </p>
                        <div className="cn-sheet-actions">
                          <button className="cn-btn cn-btn-secondary" disabled={roleBusy}
                                  onClick={() => setConfirmHandover(false)}>Cancel</button>
                          <button className="cn-btn cn-btn-danger" disabled={roleBusy}
                                  onClick={() => changeRole(profile, 'owner')}>Make owner</button>
                        </div>
                      </>
                    ) : (
                      <div className="cn-sheet-actions">
                        {roleOf(profile.host) === 'admin'
                          ? <button className="cn-btn cn-btn-secondary" disabled={roleBusy}
                                    onClick={() => changeRole(profile, 'none')}>Remove admin</button>
                          : <button className="cn-btn cn-btn-secondary" disabled={roleBusy}
                                    onClick={() => changeRole(profile, 'admin')}>Make admin</button>}
                        <button className="cn-btn cn-btn-ghost" disabled={roleBusy}
                                onClick={() => setConfirmHandover(true)}>Make owner…</button>
                      </div>
                    )}
                  </section>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
