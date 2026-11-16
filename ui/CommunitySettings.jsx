import { useEffect, useState } from 'react'
import { X } from '@openai/apps-sdk-ui/components/Icon'
import { searchPeople, setCommunityRole } from '../api.js'
import { useModalFocus } from './modalFocus.js'
import { Avatar, RoleLabel } from './Board.jsx'
import { roleChangedMessage, roleOf, sortByRole } from './communityRoles.js'

const SECTIONS = {
  permissions: { label: 'Permissions', title: 'Community Permissions', subtitle: 'Use roles to decide who can moderate and manage this Community.' },
}

/** Owner/admin settings popup: a section list on the left, the chosen section on the right. */
export default function CommunitySettings({
  me, roles, onClose, onRolesChanged, showToast,
}) {
  const [view, setView] = useState('permissions')
  const [busy, setBusy] = useState(false)
  const close = () => { if (!busy) onClose() }
  const pageRef = useModalFocus(true, close)
  const section = SECTIONS[view]

  return (
    <div className="cn-settings-scrim" onClick={close}>
    <div ref={pageRef} tabIndex={-1} className="cn-settings-page" role="dialog" aria-modal="true"
         aria-labelledby="cn-community-settings-title" onClick={(event) => event.stopPropagation()}>
      <nav className="cn-settings-nav" aria-label="Community settings sections">
        <p className="cn-settings-nav-heading">Community <span>Settings</span></p>
        {Object.entries(SECTIONS).map(([key, item]) => (
          <button key={key} type="button" className={`cn-settings-nav-item${view === key ? ' is-active' : ''}`}
                  aria-current={view === key ? 'page' : undefined} disabled={busy} onClick={() => setView(key)}>
            {item.label}
          </button>
        ))}
      </nav>
      <main className="cn-settings-main">
        <div className="cn-settings-content">
          <h3 id="cn-community-settings-title" className="cn-settings-title">{section.title}</h3>
          <p className="cn-settings-subtitle">{section.subtitle}</p>
          {view === 'permissions' && <PermissionSettings me={me} roles={roles} busy={busy} setBusy={setBusy}
                                  onRolesChanged={onRolesChanged} showToast={showToast} />}
        </div>
        <div className="cn-settings-close">
          <button type="button" onClick={close} disabled={busy} aria-label="Close settings"><X aria-hidden="true" /></button>
          <span aria-hidden="true">ESC</span>
        </div>
      </main>
    </div>
    </div>
  )
}

function PermissionSettings({ me, roles, busy, setBusy, onRolesChanged, showToast }) {
  const [people, setPeople] = useState(null)
  const [loadError, setLoadError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [query, setQuery] = useState('')
  const [handover, setHandover] = useState(null)
  const isOwner = roleOf(roles, me?.host) === 'owner'

  useEffect(() => {
    const controller = new AbortController()
    setLoadError(false)
    searchPeople('', controller.signal)
      .then((found) => { if (!controller.signal.aborted) setPeople(found.users || []) })
      .catch(() => { if (!controller.signal.aborted) setLoadError(true) })
    return () => controller.abort()
  }, [attempt])

  async function change(person, role) {
    setBusy(true)
    try {
      await setCommunityRole(person.host, role)
      showToast(roleChangedMessage(person, role), 'success')
      setHandover(null)
      await onRolesChanged()
    } catch (failure) {
      showToast(failure.message || 'The role couldn’t be changed.', 'error')
    } finally {
      setBusy(false)
    }
  }

  const needle = query.trim().replace(/^@/, '').toLowerCase()
  const visible = sortByRole(people || [], roles)
    .filter((person) => !needle || `${person.handle || ''} ${person.host}`.toLowerCase().includes(needle))

  return (
    <div className="cn-permissions">
      <div className="cn-settings-card cn-role-guide">
        <div><strong>Owner</strong><span>Everything admins can do, plus choosing admins and handing over ownership.</span></div>
        <div><strong>Admin</strong><span>Can delete any post or reply.</span></div>
        <div><strong>Member</strong><span>Can post, reply and react.</span></div>
        <p className="cn-role-guide-note">{isOwner ? 'Only you, the owner, can change roles.' : 'Only the owner can change roles.'}</p>
      </div>
      <h4 className="cn-settings-section-title">Members</h4>
      {handover && (
        <div className="cn-handover" role="alert">
          <p>Make {handover.handle ? `@${handover.handle}` : 'them'} the Community owner? You’ll become an admin,
            and only the new owner can change roles after this.</p>
          <div className="cn-sheet-actions">
            <button type="button" className="cn-btn cn-btn-secondary" disabled={busy}
                    onClick={() => setHandover(null)}>Cancel</button>
            <button type="button" className="cn-btn cn-btn-danger" disabled={busy}
                    onClick={() => change(handover, 'owner')}>Make owner</button>
          </div>
        </div>
      )}
      <input className="cn-input" type="search" value={query} onChange={(event) => setQuery(event.target.value)}
             placeholder="Find a member" aria-label="Find a member" autoComplete="off" enterKeyHint="search" />
      {people === null && !loadError && <div className="cn-group-status" role="status">Loading members…</div>}
      {loadError && (
        <div className="cn-directory-error" role="alert">
          <p>Members couldn’t be loaded.</p>
          <button type="button" className="cn-btn cn-btn-secondary" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
        </div>
      )}
      {people && (
        <ul className="cn-permission-list cn-settings-card" aria-label="Community members">
          {visible.map((person) => {
            const role = roleOf(roles, person.host)
            const self = person.host === me?.host
            return (
              <li key={person.host} className="cn-permission-row">
                <Avatar name={person.handle} host={person.host} size="small" remote lazy />
                <span className="cn-permission-name">
                  <strong>{person.handle ? `@${person.handle}` : 'Social member'}{self ? ' (you)' : ''}</strong>
                  {role ? <RoleLabel role={role} /> : <span className="cn-permission-member">Member</span>}
                </span>
                {isOwner && !self && (
                  <select className="cn-role-select" value={role || 'none'} disabled={busy}
                          aria-label={`Role for ${person.handle ? `@${person.handle}` : 'this member'}`}
                          onChange={(event) => {
                            const next = event.target.value
                            if (next === 'owner') setHandover(person)
                            else change(person, next)
                          }}>
                    <option value="none">Member</option>
                    <option value="admin">Admin</option>
                    <option value="owner">Owner…</option>
                  </select>
                )}
              </li>
            )
          })}
          {visible.length === 0 && <li className="cn-group-status">No matching members.</li>}
        </ul>
      )}
    </div>
  )
}
