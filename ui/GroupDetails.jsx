import { useEffect, useRef, useState } from 'react'
import { addGroupMember, deleteGroup, searchPeople, getGroup } from '../api.js'
import { Avatar } from './Board.jsx'
import { useModalFocus } from './modalFocus.js'

export default function GroupDetails({ group, me, onClose, onUpdated, onDeleted }) {
  const [mode, setMode] = useState('details')
  const [address, setAddress] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [people, setPeople] = useState([])
  const [directoryError, setDirectoryError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [deleted, setDeleted] = useState(false)
  const [failedNotices, setFailedNotices] = useState([])
  const submitting = useRef(false)
  const canManage = group.host === me?.host && !group.deleted_at
  const close = () => { if (!submitting.current) { if (deleted) onDeleted(); else onClose() } }
  const sheetRef = useModalFocus(true, close)

  useEffect(() => {
    if (!canManage || mode !== 'invite') return
    const controller = new AbortController()
    setDirectoryError(false)
    searchPeople('', controller.signal).then(result => {
      if (!controller.signal.aborted) setPeople(result.users || [])
    }).catch(() => { if (!controller.signal.aborted) setDirectoryError(true) })
    return () => controller.abort()
  }, [mode, canManage, attempt])

  async function invite(event) {
    event.preventDefault()
    const host = address.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '')
    if (!host || submitting.current) return
    submitting.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const result = await addGroupMember(group.gid, host)
      // Older deployed servers return delivery only; read the exact roster fresh.
      const updated = result.members ? { ...group, members: result.members } : await getGroup(group.gid)
      onUpdated(updated)
      const failed = Object.entries(result.delivered || {}).filter(([, ok]) => !ok).map(([peer]) => peer)
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

  async function remove(event) {
    event.preventDefault()
    if ((!deleted && confirmation !== group.name) || submitting.current) return
    submitting.current = true; setBusy(true); setError('')
    try {
      const result = await deleteGroup(group.gid)
      setDeleted(true)
      const failed = Object.entries(result.delivered || {}).filter(([, ok]) => !ok).map(([host]) => host)
      setFailedNotices(failed)
      window.mobius?.signal?.('item_deleted', { type: 'group' })
      if (!failed.length) onDeleted()
    } catch (failure) {
      setError(failure.status === 404 || failure.status === 405
        ? 'Group deletion is unavailable on this deployment. The group-service update may still need to be activated.'
        : failure.message || 'The group couldn’t be deleted.')
      window.mobius?.signal?.('error', { message: failure.message, source: 'group_delete' })
    } finally { submitting.current = false; setBusy(false) }
  }

  const members = group.members || []
  const matches = people.filter(person => person.host !== me?.host
    && `${person.handle || ''} ${person.host}`.toLowerCase().includes(address.trim().toLowerCase()))
  const changeMode = next => { setMode(next); setError(''); setNotice(''); setFailedNotices([]) }

  return <div className="cn-scrim" role="dialog" aria-modal="true" aria-label="Group details" onClick={close}>
    <div ref={sheetRef} tabIndex={-1} className="cn-sheet cn-group-create" onClick={event => event.stopPropagation()}>
      <div className="cn-grabber" aria-hidden="true" />
      <div className="cn-group-create-body">
        <div className="cn-dialog-head"><h3 className="cn-sheet-title">{mode === 'delete' ? (deleted ? 'Group deleted' : 'Delete group?') : mode === 'invite' ? 'Add people' : 'Group details'}</h3></div>
        {mode === 'details' && <>
          <p className="cn-group-detail-name">{group.name}</p>
          <p className="cn-sheet-body">{group.deleted_at ? 'The creator closed this group. Your existing messages are still here.' : canManage ? 'You created this group. Manage its members here.' : 'Only the group creator can add people or delete this group.'}</p>
          <div className="cn-group-members-head"><h4>Members</h4><span>{members.length} / 64</span></div>
          <div className="cn-group-member-list">{members.map(member => <div className="cn-member-row cn-member-static" key={member.host}>
            <Avatar name={member.handle} host={member.host} size="small" />
            <span className="cn-row-copy"><strong>{member.handle ? `@${member.handle}` : 'Social member'}{member.host === me?.host ? ' (you)' : ''}</strong><span className="cn-meta">{member.host}</span></span>
            {member.host === group.host && <span className="cn-meta">Creator</span>}
          </div>)}</div>
          {canManage && <div className="cn-group-management">
            <button className="cn-btn cn-btn-primary" onClick={() => changeMode('invite')}>Add people</button>
            <button className="cn-btn cn-btn-ghost cn-danger-text" onClick={() => changeMode('delete')}>Delete group</button>
          </div>}
        </>}
        {mode === 'invite' && <form id="cn-add-member" onSubmit={invite}>
          <p className="cn-sheet-body">Choose someone or enter their Möbius address—even if they use a different community. This invitation goes to the selected deployment.</p>
          <label className="cn-field-label" htmlFor="cn-invite-address">Möbius address</label>
          <input id="cn-invite-address" className="cn-input" value={address} onChange={event => setAddress(event.target.value)} placeholder="friend.example.com" autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={busy} required />
          {directoryError && <div className="cn-directory-error"><p>The directory couldn’t be loaded. You can still enter an address.</p><button className="cn-btn cn-btn-secondary" type="button" onClick={() => setAttempt(value => value + 1)}>Retry directory</button></div>}
          <div className="cn-group-member-list">{matches.map(person => <button type="button" className="cn-row" key={person.host} disabled={busy} onClick={() => setAddress(person.host)}>
            <Avatar name={person.handle} host={person.host} size="small" /><span className="cn-row-copy"><strong>{person.handle ? `@${person.handle}` : 'Social member'}</strong><span className="cn-meta">{person.host}</span></span>
            {members.some(member => member.host === person.host) && <span className="cn-meta">Member</span>}
          </button>)}</div>
          {notice && <p className="cn-group-status" role="status">{notice}</p>}
        </form>}
        {mode === 'delete' && <form id="cn-delete-group" onSubmit={remove}>
          <p className="cn-sheet-body">{deleted ? 'New messages are blocked and the group will be removed from your Messages. Some deployments haven’t received the closure notice yet; older versions may not support it.' : 'This stops new messages for everyone and removes the group from your Messages. Copies already held by other members are not erased.'}</p>
          {!deleted && <><label className="cn-field-label" htmlFor="cn-delete-name">Type “{group.name}” to confirm</label><input id="cn-delete-name" className="cn-input" value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" disabled={busy} /></>}
        </form>}
        {!!failedNotices.length && <div className="cn-directory-error" role="status"><strong>Not reached</strong><ul>{failedNotices.map(host => <li key={host}>{host}</li>)}</ul></div>}
      </div>
      <div className="cn-group-create-footer">
        {error && <div className="cn-directory-error" role="alert">{error}</div>}
        <div className="cn-sheet-actions">
          <button className="cn-btn cn-btn-secondary" disabled={busy} onClick={mode === 'details' || deleted ? close : () => changeMode('details')}>{deleted ? 'Done' : mode === 'details' ? 'Close' : 'Back'}</button>
          {mode === 'invite' && <button className="cn-btn cn-btn-primary" form="cn-add-member" type="submit" disabled={busy || !address.trim()}>{busy ? 'Inviting…' : 'Send invitation'}</button>}
          {mode === 'delete' && <button className={`cn-btn ${deleted ? 'cn-btn-secondary' : 'cn-btn-danger'}`} form="cn-delete-group" type="submit" disabled={busy || (!deleted && confirmation !== group.name)}>{busy ? (deleted ? 'Notifying…' : 'Deleting…') : deleted ? 'Retry notification' : 'Delete group'}</button>}
        </div>
      </div>
    </div>
  </div>
}
