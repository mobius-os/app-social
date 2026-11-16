import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AddMember, AvatarProfile, Camera, Chat, ChevronLeft, ChevronRight, Search, ShieldPerson, Trash, X,
} from '@openai/apps-sdk-ui/components/Icon'
import {
  addGroupMember, deleteGroup, searchPeople, getGroup, removeGroupMember, renameGroup, requestStatus,
  setGroupAdmin, setGroupIcon,
} from '../api.js'
import { Avatar } from './Board.jsx'
import { useModalFocus } from './modalFocus.js'
import { canManageGroup, groupRole, memberActions, roleLabel } from './groupRoles.js'
import GroupPicture, { prepareGroupPicture, rememberGroupIcon } from './GroupPicture.jsx'

const memberName = member => member?.handle ? `@${member.handle}` : 'Social member'
const unreached = result => Object.entries(result?.delivered || {}).filter(([, ok]) => !ok).map(([peer]) => peer)

// The host's reply carries the authoritative name, picture and roster.
const mergeReply = (group, result) => {
  const next = { ...group, members: result.members || group.members, name: result.name || group.name }
  if ('icon_hash' in (result || {})) {
    if (result.icon_hash) next.icon_hash = result.icon_hash
    else delete next.icon_hash
  }
  if (result?.icon && result.icon_hash) rememberGroupIcon(result.icon_hash, result.icon)
  return next
}

// One host-confirmed change at a time; outcomes are reported through toasts.
function useGroupChange(group, onUpdated, showToast) {
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  async function change(run, { source, success, after }) {
    if (submitting.current) return false
    submitting.current = true; setBusy(true)
    try {
      const result = await run()
      onUpdated(mergeReply(group, result))
      const failed = unreached(result)
      showToast(failed.length
        ? `${success} ${failed.length === 1 ? 'One member’s' : `${failed.length} members’`} Social couldn’t be reached yet.`
        : success, failed.length ? 'error' : 'success')
      after?.(result)
      return true
    } catch (failure) {
      showToast(failure.message || 'That change couldn’t be saved.', 'error')
      window.mobius?.signal?.('error', { message: failure.message, source })
      return false
    } finally { submitting.current = false; setBusy(false) }
  }
  return { busy, change }
}

/* ── Group settings: a Discord-style window with a section sidebar ─────── */

function managerSummary(group, role) {
  if (group.deleted_at) return 'The creator closed this group. Your existing messages are still here.'
  if (group.removed_at) return 'You were removed from this group. Your existing messages are still here.'
  if (role === 'creator') return 'You created this group. You and its admins can add and remove people and change its name and picture; you choose the admins.'
  if (role === 'admin') return 'You’re an admin. You can add and remove members and change the group’s name and picture. The creator chooses admins.'
  return 'The creator and admins manage this group.'
}

// Below this window width the sidebar becomes its own screen, as on Discord mobile.
const SETTINGS_SPLIT_MIN_WIDTH = 640
function useWideWindow(min) {
  const query = `(min-width: ${min}px)`
  const [wide, setWide] = useState(() => window.matchMedia?.(query).matches ?? true)
  useEffect(() => {
    const media = window.matchMedia?.(query)
    if (!media) return undefined
    const update = () => setWide(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])
  return wide
}

export default function GroupSettings({
  group, me, knownHandles, onClose, onUpdated, onDeleted, onOpenPerson, onMessage, showToast,
}) {
  const wide = useWideWindow(SETTINGS_SPLIT_MIN_WIDTH)
  const [section, setSection] = useState('overview')
  const [showingNav, setShowingNav] = useState(true) // narrow windows only
  const [adding, setAdding] = useState(false)
  const [locked, setLocked] = useState(false) // a save or delete is in flight
  const [deleted, setDeleted] = useState(false)
  const role = groupRole(group, me?.host)
  const accepted = requestStatus(group) === 'accepted'
  const canManage = accepted && canManageGroup(group, me)
  const isCreator = canManage && role === 'creator'
  const close = () => { if (locked) return; if (deleted) onDeleted(); else onClose() }
  const sheetRef = useModalFocus(true, close)
  const open = next => { setSection(next); setShowingNav(false) }
  const sections = [
    { id: 'overview', label: 'Overview' },
    { id: 'members', label: 'Members', count: (group.members || []).length },
  ]
  const titles = { overview: 'Overview', members: 'Members', delete: deleted ? 'Group deleted' : 'Delete group' }
  const nav = <nav className="cn-gs-nav" aria-label="Group settings sections">
    <div className="cn-gs-nav-head">
      <GroupPicture gid={group.gid} hash={group.icon_hash} name={group.name} className="cn-gs-nav-picture" />
      <span className="cn-gs-nav-name">{group.name}</span>
    </div>
    {sections.map(item => <button key={item.id} type="button" className={`cn-gs-nav-item${wide && section === item.id ? ' is-active' : ''}`}
                                   aria-current={wide && section === item.id ? 'page' : undefined} onClick={() => open(item.id)}>
      <span>{item.label}</span>{item.count != null && <span className="cn-gs-nav-count">{item.count}</span>}
      {!wide && <ChevronRight className="cn-gs-nav-chevron" aria-hidden="true" />}
    </button>)}
    {isCreator && <>
      <div className="cn-gs-nav-divider" role="separator" />
      <button type="button" className={`cn-gs-nav-item is-danger${wide && section === 'delete' ? ' is-active' : ''}`} onClick={() => open('delete')}>
        <span>Delete group</span><Trash className="cn-gs-nav-trailing" aria-hidden="true" />
      </button>
    </>}
  </nav>
  const content = <section className="cn-gs-content" aria-label={titles[section]}>
    <header className="cn-gs-content-head">
      {!wide && <button type="button" className="cn-gs-back" onClick={() => setShowingNav(true)} aria-label="Back to group settings"><ChevronLeft aria-hidden="true" /></button>}
      <h3>{titles[section]}</h3>
    </header>
    {section === 'overview' && <OverviewSection group={group} me={me} canManage={canManage}
      onUpdated={onUpdated} showToast={showToast} onLock={setLocked} />}
    {section === 'members' && <MembersSection group={group} me={me} knownHandles={knownHandles} showToast={showToast}
      onUpdated={onUpdated} onAddPeople={() => setAdding(true)}
      onOpenPerson={host => { onClose(); onOpenPerson(host) }}
      onMessage={(host, handle) => { onClose(); onMessage(host, handle) }} />}
    {section === 'delete' && isCreator && <DeleteSection group={group} onLock={setLocked}
      onDeleted={() => setDeleted(true)} onFinished={onDeleted} onCancel={() => open('overview')} deleted={deleted} />}
  </section>

  return <div className="cn-scrim cn-gs-scrim" onClick={close}>
    <div ref={sheetRef} tabIndex={-1} className="cn-gs" role="dialog" aria-modal="true" aria-label="Group settings"
         onClick={event => event.stopPropagation()}>
      {wide ? <>{nav}{content}</> : showingNav ? nav : content}
      <button type="button" className="cn-gs-close" onClick={close} disabled={locked} aria-label="Close group settings">
        <span className="cn-gs-close-ring"><X aria-hidden="true" /></span>
        {wide && <span className="cn-gs-close-key" aria-hidden="true">ESC</span>}
      </button>
    </div>
    {adding && <AddPeople group={group} me={me} onClose={() => setAdding(false)} onUpdated={onUpdated} />}
  </div>
}

function OverviewSection({ group, me, canManage, onUpdated, showToast, onLock }) {
  const [name, setName] = useState(group.name)
  const [picture, setPicture] = useState(undefined) // undefined: unchanged, null: remove
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef(null)
  const hasPicture = picture === undefined ? !!group.icon_hash : !!picture
  const nameChanged = !!name.trim() && name.trim() !== group.name
  const dirty = nameChanged || picture !== undefined

  async function choose(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError(''); setPreparing(true)
    try { setPicture(await prepareGroupPicture(file)) } catch (failure) { setError(failure.message) } finally { setPreparing(false) }
  }
  const reset = () => { setName(group.name); setPicture(undefined); setError('') }

  async function save(event) {
    event?.preventDefault()
    if (!dirty || busy) return
    setBusy(true); onLock(true); setError('')
    let current = group
    const failed = new Set()
    try {
      if (picture !== undefined) {
        const result = await setGroupIcon(group.gid, picture ? picture.wire : null)
        current = mergeReply(current, result)
        unreached(result).forEach(host => failed.add(host))
        onUpdated(current)
      }
      if (nameChanged) {
        const result = await renameGroup(group.gid, name.trim())
        current = mergeReply(current, result)
        unreached(result).forEach(host => failed.add(host))
        onUpdated(current)
      }
      setPicture(undefined)
      setName(current.name)
      showToast(failed.size ? 'Saved. Some members’ Social couldn’t be reached yet.' : 'Changes saved', failed.size ? 'error' : 'success')
    } catch (failure) {
      setError(failure.message || 'That change couldn’t be saved.')
      window.mobius?.signal?.('error', { message: failure.message, source: 'group_customize' })
    } finally { setBusy(false); onLock(false) }
  }

  if (!canManage) {
    return <div className="cn-gs-overview is-readonly">
      <GroupPicture gid={group.gid} hash={group.icon_hash} name={group.name} className="cn-gs-picture-avatar" />
      <div><p className="cn-gs-readonly-name">{group.name}</p>
        <p className="cn-gs-help">{managerSummary(group, groupRole(group, me?.host))}</p></div>
    </div>
  }
  return <form className="cn-gs-form" onSubmit={save}>
    <div className="cn-gs-overview">
      <div className="cn-gs-picture-col">
        <button type="button" className="cn-gs-picture" onClick={() => fileRef.current?.click()} disabled={busy || preparing}
                aria-label={hasPicture ? 'Change group picture' : 'Upload group picture'}>
          <GroupPicture gid={group.gid} hash={group.icon_hash} name={name || group.name}
                        preview={picture === undefined ? undefined : picture?.preview || null} className="cn-gs-picture-avatar" />
          <span className="cn-gs-picture-hover" aria-hidden="true"><Camera /><span>Change<br />picture</span></span>
          <span className="cn-gs-picture-badge" aria-hidden="true"><Camera /></span>
        </button>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/heic,image/heif" hidden onChange={choose} />
        <p className="cn-gs-help">At least 128×128 looks best.</p>
        <div className="cn-gs-picture-actions">
          <button type="button" className="cn-btn cn-btn-secondary cn-btn-small" disabled={busy || preparing} onClick={() => fileRef.current?.click()}>
            {preparing ? 'Preparing…' : 'Upload image'}
          </button>
          {hasPicture && <button type="button" className="cn-gs-link" disabled={busy} onClick={() => setPicture(null)}>Remove</button>}
        </div>
      </div>
      <div className="cn-gs-fields">
        <label className="cn-gs-label" htmlFor="cn-gs-name">Group name</label>
        <input id="cn-gs-name" className="cn-input" value={name} onChange={event => setName(event.target.value)} maxLength={80}
               autoComplete="off" enterKeyHint="done" disabled={busy} required />
        <p className="cn-gs-help">Everyone in the group sees the name and picture.</p>
        <p className="cn-gs-help cn-gs-role-note">{managerSummary(group, groupRole(group, me?.host))}</p>
      </div>
    </div>
    {error && <div className="cn-directory-error" role="alert">{error}</div>}
    {dirty && <div className="cn-gs-unsaved" role="status">
      <span>Careful — you have unsaved changes!</span>
      <button type="button" className="cn-gs-link" onClick={reset} disabled={busy}>Reset</button>
      <button type="submit" className="cn-btn cn-btn-small cn-gs-save" disabled={busy || preparing || !name.trim()}>{busy ? 'Saving…' : 'Save changes'}</button>
    </div>}
  </form>
}

function DeleteSection({ group, deleted, onLock, onDeleted, onFinished, onCancel }) {
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [failedNotices, setFailedNotices] = useState([])
  async function remove(event) {
    event.preventDefault()
    if ((!deleted && confirmation !== group.name) || busy) return
    setBusy(true); onLock(true); setError('')
    let finished = false
    try {
      const result = await deleteGroup(group.gid)
      onDeleted()
      const failed = unreached(result)
      setFailedNotices(failed)
      window.mobius?.signal?.('item_deleted', { type: 'group' })
      finished = !failed.length
    } catch (failure) {
      setError(failure.status === 404 || failure.status === 405
        ? 'Group deletion is unavailable on this deployment. The group-service update may still need to be activated.'
        : failure.message || 'The group couldn’t be deleted.')
      window.mobius?.signal?.('error', { message: failure.message, source: 'group_delete' })
    } finally { setBusy(false); onLock(false) }
    if (finished) onFinished()
  }
  return <form className="cn-gs-form" onSubmit={remove}>
    <div className="cn-gs-danger-card">
      <p>{deleted ? 'New messages are blocked and the group will be removed from your Chats. Some deployments haven’t received the closure notice yet; older versions may not support it.' : 'This stops new messages for everyone and removes the group from your Chats. Copies already held by other members are not erased.'}</p>
      {!deleted && <><label className="cn-gs-label" htmlFor="cn-delete-name">Type “{group.name}” to confirm</label>
        <input id="cn-delete-name" className="cn-input" value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" disabled={busy} /></>}
      {!!failedNotices.length && <div className="cn-directory-error" role="status"><strong>Not reached</strong><ul>{failedNotices.map(host => <li key={host}>{host}</li>)}</ul></div>}
      {error && <div className="cn-directory-error" role="alert">{error}</div>}
      <div className="cn-gs-danger-actions">
        {!deleted && <button type="button" className="cn-btn cn-btn-secondary cn-btn-small" disabled={busy} onClick={onCancel}>Cancel</button>}
        {deleted && <button type="button" className="cn-btn cn-btn-secondary cn-btn-small" disabled={busy} onClick={onFinished}>Done</button>}
        <button type="submit" className={`cn-btn cn-btn-small ${deleted ? 'cn-btn-secondary' : 'cn-btn-danger'}`} disabled={busy || (!deleted && confirmation !== group.name)}>
          {busy ? (deleted ? 'Notifying…' : 'Deleting…') : deleted ? 'Retry notification' : 'Delete group'}
        </button>
      </div>
    </div>
  </form>
}

/* ── Add people ─────────────────────────────────────────────────────────── */

export function AddPeople({ group, me, onClose, onUpdated }) {
  const [address, setAddress] = useState('')
  const [people, setPeople] = useState([])
  const [directoryError, setDirectoryError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [failedNotices, setFailedNotices] = useState([])
  const submitting = useRef(false)
  const accepted = requestStatus(group) === 'accepted'
  const canManage = accepted && canManageGroup(group, me)
  const close = () => { if (!submitting.current) onClose() }
  const sheetRef = useModalFocus(true, close)

  useEffect(() => {
    // A pending invitation must never query the directory on the group's behalf.
    if (!canManage) return undefined
    const controller = new AbortController()
    setDirectoryError(false)
    searchPeople('', controller.signal).then(result => {
      if (!controller.signal.aborted) setPeople(result.users || [])
    }).catch(() => { if (!controller.signal.aborted) setDirectoryError(true) })
    return () => controller.abort()
  }, [attempt, canManage])

  async function invite(event) {
    event.preventDefault()
    const host = address.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '')
    if (!host || submitting.current) return
    submitting.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const result = await addGroupMember(group.gid, host)
      // Older deployed servers return delivery only; read the exact roster fresh.
      const updated = result.members ? mergeReply(group, result) : await getGroup(group.gid)
      onUpdated(updated)
      const failed = unreached(result)
      setFailedNotices(failed)
      setNotice(failed.length
        ? 'Membership saved, but some deployments could not be reached. You can retry the invitation.'
        : result.status === 'already_member' ? (result.delivered ? 'Invitation sent again.' : 'Already a member. Retrying delivery requires the updated group service.') : 'Person added. They can receive new messages; earlier history stays with existing members.')
      if (!failed.length) setAddress('')
      window.mobius?.signal?.('item_created', { type: 'group_member' })
    } catch (failure) {
      setError(failure.message || 'The invitation couldn’t be sent.')
      window.mobius?.signal?.('error', { message: failure.message, source: 'group_invite' })
    } finally { submitting.current = false; setBusy(false) }
  }

  const members = group.members || []
  const matches = people.filter(person => person.host !== me?.host
    && `${person.handle || ''} ${person.host}`.toLowerCase().includes(address.trim().toLowerCase()))
  return <div className="cn-scrim" role="dialog" aria-modal="true" aria-label="Add people" onClick={close}>
    <div ref={sheetRef} tabIndex={-1} className="cn-sheet cn-group-create" onClick={event => event.stopPropagation()}>
      <div className="cn-grabber" aria-hidden="true" />
      <div className="cn-group-create-body">
        <div className="cn-dialog-head"><h3 className="cn-sheet-title">Add people</h3></div>
        <form id="cn-add-member" onSubmit={invite}>
          <p className="cn-sheet-body">Choose someone or enter their Möbius address—even if they use a different community.</p>
          <label className="cn-field-label" htmlFor="cn-invite-address">Möbius address</label>
          <input id="cn-invite-address" className="cn-input" value={address} onChange={event => setAddress(event.target.value)} placeholder="friend.example.com" autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={busy} required />
          {directoryError && <div className="cn-directory-error"><p>The directory couldn’t be loaded. You can still enter an address.</p><button className="cn-btn cn-btn-secondary" type="button" onClick={() => setAttempt(value => value + 1)}>Retry directory</button></div>}
          <div className="cn-group-member-list">{matches.map(person => <button type="button" className="cn-row" key={person.host} disabled={busy} onClick={() => setAddress(person.host)}>
            <Avatar name={person.handle} host={accepted ? person.host : undefined} size="small" remote /><span className="cn-row-copy"><strong>{memberName(person)}</strong><span className="cn-meta">{person.host}</span></span>
            {members.some(member => member.host === person.host) && <span className="cn-meta">Member</span>}
          </button>)}</div>
          {notice && <p className="cn-group-status" role="status">{notice}</p>}
          {!!failedNotices.length && <div className="cn-directory-error" role="status"><strong>Not reached</strong><ul>{failedNotices.map(host => <li key={host}>{host}</li>)}</ul></div>}
        </form>
      </div>
      <div className="cn-group-create-footer">
        {error && <div className="cn-directory-error" role="alert">{error}</div>}
        <div className="cn-sheet-actions">
          <button className="cn-btn cn-btn-secondary" disabled={busy} onClick={close}>Done</button>
          <button className="cn-btn cn-btn-primary" form="cn-add-member" type="submit" disabled={busy || !address.trim()}>{busy ? 'Inviting…' : 'Send invitation'}</button>
        </div>
      </div>
    </div>
  </div>
}

/* ── Members section, with a per-member menu ────────────────────────────── */

const LONG_PRESS_MS = 450

function MemberMenu({ menu, onClose }) {
  const ref = useRef(null)
  const [position, setPosition] = useState({ left: menu.x, top: menu.y })
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    const margin = 8
    setPosition({
      left: Math.max(margin, Math.min(menu.x, window.innerWidth - box.width - margin)),
      top: Math.max(margin, Math.min(menu.y, window.innerHeight - box.height - margin)),
    })
    ref.current.querySelector('button')?.focus()
  }, [menu.x, menu.y])
  useEffect(() => {
    const away = event => { if (!ref.current?.contains(event.target)) onClose() }
    const key = event => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(true) }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const items = [...ref.current.querySelectorAll('button')]
        const at = items.indexOf(document.activeElement)
        items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
      }
    }
    // Window capture runs before any open dialog's document listener, so
    // Escape closes only this menu.
    document.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])
  // Rendered at the document root: a transformed or filtered ancestor would
  // otherwise become the fixed-position box and offset the menu.
  return createPortal(<div ref={ref} className="cn-gm-menu" role="menu" aria-label={`${memberName(menu.member)} options`}
              style={{ left: position.left, top: position.top }}>
    {menu.items.map((item, index) => item === 'divider'
      ? <div key={`d${index}`} className="cn-gm-menu-divider" role="separator" />
      : <button key={item.label} type="button" role="menuitem" className={item.danger ? 'is-danger' : ''}
                onClick={() => { onClose(); item.run() }}>
          {item.icon}<span>{item.label}</span>
        </button>)}
  </div>, document.body)
}

function MembersSection({
  group, me, knownHandles = {}, onUpdated, onAddPeople, onOpenPerson, onMessage, showToast,
}) {
  const [menu, setMenu] = useState(null)
  const [query, setQuery] = useState('')
  const [removing, setRemoving] = useState(null)
  const { busy, change } = useGroupChange(group, onUpdated, showToast)
  const press = useRef(null)
  const accepted = requestStatus(group) === 'accepted'
  const canManage = accepted && canManageGroup(group, me)
  // A member saved without a handle borrows it from the cached people list.
  const members = (group.members || []).map(member => (
    member.handle || !knownHandles[member.host] ? member : { ...member, handle: knownHandles[member.host] }
  )).sort((a, b) => {
    const rank = member => ({ creator: 0, admin: 1 }[groupRole(group, member.host)] ?? 2)
    return rank(a) - rank(b) || memberName(a).localeCompare(memberName(b))
  })

  function itemsFor(member) {
    const self = member.host === me?.host
    const actions = memberActions(group, me, member)
    const items = [{ label: 'View profile', icon: <AvatarProfile aria-hidden="true" />, run: () => onOpenPerson(member.host) }]
    if (!self) items.push({ label: 'Message', icon: <Chat aria-hidden="true" />, run: () => onMessage(member.host, member.handle) })
    if (actions.length) items.push('divider')
    if (actions.includes('make_admin') || actions.includes('remove_admin')) {
      const makeAdmin = actions.includes('make_admin')
      items.push({
        label: makeAdmin ? 'Make admin' : 'Remove admin', icon: <ShieldPerson aria-hidden="true" />,
        run: () => change(() => setGroupAdmin(group.gid, member.host, makeAdmin), {
          source: 'group_admin',
          success: makeAdmin ? `${memberName(member)} is now an admin.` : `${memberName(member)} is no longer an admin.`,
        }),
      })
    }
    if (actions.includes('remove')) {
      items.push({ label: 'Remove from group', icon: <X aria-hidden="true" />, danger: true, run: () => setRemoving(member) })
    }
    return items
  }

  const openMenu = (member, x, y, opener) => {
    if (busy) return
    setMenu({ member, x, y, opener, items: itemsFor(member) })
  }
  const closeMenu = (restore) => {
    setMenu(current => {
      if (restore && current?.opener) setTimeout(() => current.opener.focus?.(), 0)
      return null
    })
  }
  const fromElement = (member, element) => {
    const box = element.getBoundingClientRect()
    openMenu(member, box.left + Math.min(box.width - 8, 56), box.bottom + 4, element)
  }
  const touchStart = (member, event) => {
    if (event.pointerType !== 'touch') return
    const target = event.currentTarget
    clearTimeout(press.current)
    press.current = setTimeout(() => { press.current = 'fired'; fromElement(member, target) }, LONG_PRESS_MS)
  }
  const touchEnd = () => { if (press.current !== 'fired') clearTimeout(press.current) }

  // A removal whose notice didn't reach the person keeps this dialog open, so
  // it can be sent again; repeating a removal never adds them back.
  function confirmRemove() {
    const member = removing
    change(() => removeGroupMember(group.gid, member.host), {
      source: 'group_remove_member',
      success: member.unreached
        ? `Retried the removal notice for ${memberName(member)}.`
        : `${memberName(member)} was removed. They keep earlier messages but won’t get new ones.`,
      after: result => setRemoving(result?.delivered?.[member.host] === false ? { ...member, unreached: true } : null),
    })
  }

  const needle = query.trim().toLowerCase().replace(/^@/, '')
  const shown = needle ? members.filter(member => `${member.handle || ''} ${member.host}`.toLowerCase().includes(needle)) : members
  return <div className="cn-gm">
    <div className="cn-gm-toolbar">
      <label className="cn-gm-search">
        <Search aria-hidden="true" />
        <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search members"
               aria-label="Search members" autoComplete="off" autoCapitalize="none" spellCheck={false} enterKeyHint="search" />
      </label>
      {canManage && <button type="button" className="cn-btn cn-btn-primary cn-btn-small cn-gm-add" onClick={onAddPeople}>
        <AddMember aria-hidden="true" />Add people
      </button>}
    </div>
    <h4 className="cn-gm-count">{needle ? `${shown.length} of ${members.length}` : `${members.length} ${members.length === 1 ? 'member' : 'members'}`}</h4>
    <ul className="cn-gm-list">
      {shown.map(member => {
        const role = roleLabel(groupRole(group, member.host))
        const self = member.host === me?.host
        return <li key={member.host} className={menu?.member.host === member.host ? 'is-active' : ''}>
          <button type="button" className="cn-gm-row" aria-haspopup="menu"
                  title={member.host}
                  onClick={event => {
                    if (press.current === 'fired') { press.current = null; return }
                    fromElement(member, event.currentTarget)
                  }}
                  onContextMenu={event => { event.preventDefault(); clearTimeout(press.current); press.current = null; openMenu(member, event.clientX, event.clientY, event.currentTarget) }}
                  onPointerDown={event => touchStart(member, event)} onPointerUp={touchEnd} onPointerCancel={touchEnd} onPointerLeave={touchEnd}>
            <Avatar name={member.handle} host={accepted ? member.host : undefined} size="small" remote />
            <span className="cn-gm-name">{memberName(member)}{self && <span className="cn-gm-you">you</span>}</span>
            {role && <span className={`cn-role-tag${role === 'Admin' ? ' is-admin' : ''}`}>{role}</span>}
          </button>
        </li>
      })}
    </ul>
    {needle && !shown.length && <p className="cn-gm-note">No members match “{query.trim()}”.</p>}
    {menu && <MemberMenu menu={menu} onClose={closeMenu} />}
    {removing && <RemoveConfirm member={removing} busy={busy} onCancel={() => setRemoving(null)} onConfirm={confirmRemove} />}
  </div>
}

function RemoveConfirm({ member, busy, onCancel, onConfirm }) {
  const sheetRef = useModalFocus(true, () => { if (!busy) onCancel() })
  return <div className="cn-scrim" role="dialog" aria-modal="true" aria-label={`Remove ${memberName(member)}`} onClick={() => { if (!busy) onCancel() }}>
    <div ref={sheetRef} tabIndex={-1} className="cn-sheet cn-gc cn-gc-small" onClick={event => event.stopPropagation()}>
      <div className="cn-grabber" aria-hidden="true" />
      {member.unreached ? <>
        <h3 className="cn-gc-title is-left">{memberName(member)} hasn’t been told yet</h3>
        <p className="cn-sheet-body">They’re removed from the group, but their Social couldn’t be reached. Send the notice again so their copy shows it. This won’t add them back.</p>
      </> : <>
        <h3 className="cn-gc-title is-left">Remove {memberName(member)}?</h3>
        <p className="cn-sheet-body">They keep the messages they already have but won’t get new ones. You can add them again later.</p>
      </>}
      <div className="cn-gc-footer">
        <span className="cn-gc-spacer" />
        <button type="button" className="cn-btn cn-btn-secondary" disabled={busy} onClick={onCancel}>{member.unreached ? 'Close' : 'Cancel'}</button>
        {member.unreached
          ? <button type="button" className="cn-btn cn-btn-primary" disabled={busy} onClick={onConfirm}>{busy ? 'Sending…' : 'Send again'}</button>
          : <button type="button" className="cn-btn cn-btn-danger" disabled={busy} onClick={onConfirm}>{busy ? 'Removing…' : 'Remove'}</button>}
      </div>
    </div>
  </div>
}
