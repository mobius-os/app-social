import { useEffect, useRef, useState } from 'react'
import { Mail, Plus } from '@openai/apps-sdk-ui/components/Icon'
import { timeAgo, initials, createGroup, searchPeople } from '../api.js'
import { Avatar } from './Board.jsx'
import { useModalFocus } from './modalFocus.js'

function GroupAvatar({ name }) {
  return (
    <span className="cn-avatar is-group" aria-hidden="true">
      {initials(name, name)}
    </span>
  )
}

export { GroupAvatar }

function lastMessagePreview(item) {
  const text = String(item.last_text || '').trim()
  if (text) return text
  if (item.last_attachment || item.last_message?.attachment || item.attachment) return '📷 Photo'
  return ''
}

export default function Messages({
  canCreate, me, conversations, groups, onOpenThread, onOpenGroup, onFindPeople,
  onGroupsChanged, showToast, creating, setCreating, loadState, onRetry,
}) {

  const merged = [
    ...conversations.map((c) => ({ kind: 'dm', key: c.peer, at: c.last_at || 0, item: c })),
    ...groups.map((g) => ({ kind: 'group', key: g.gid, at: g.last_at || 0, item: g })),
  ].sort((a, b) => b.at - a.at)

  return (
    <div className={`cn-content cn-screen${creating ? ' has-dialog' : ''}`}>
      <div className="cn-view-heading">
        <div><h2>Messages</h2><p>Your conversations, together.</p></div>
        <div className="cn-view-actions">
          <button className="cn-btn cn-btn-primary" onClick={onFindPeople}>New message</button>
          <button className="cn-btn cn-btn-secondary" disabled={!canCreate} onClick={() => setCreating(true)}><Plus aria-hidden="true" /> New group</button>
        </div>
      </div>
      {loadState === 'error' && <div className="cn-directory-error" role="alert">
        <p>Conversations couldn’t be loaded. Your saved messages haven’t been removed.</p>
        <button className="cn-btn cn-btn-secondary" onClick={onRetry}>Try again</button>
      </div>}
      {loadState === 'loading' && <div className="cn-center" role="status">Loading conversations…</div>}
      {merged.length === 0 && loadState === 'ready' ? (
        <div className="cn-empty">
          <div className="cn-empty-mark" aria-hidden="true"><Mail /></div>
          <div className="cn-empty-title">No conversations yet</div>
          <p className="cn-empty-text">
            Find someone in People and say hello — your message goes straight to their server.
          </p>
        </div>
      ) : (
        <div>
          {merged.map(({ kind, key, item }) => (
            kind === 'dm' ? (
              <button className="cn-row" key={`dm-${key}`} onClick={() => onOpenThread(item.peer)}>
                <Avatar name={item.peer_handle} host={item.peer} />
                <span className="cn-row-copy">
                  <span className="cn-row-top">
                    <strong>{item.peer_handle ? `@${item.peer_handle}` : 'Direct message'}</strong>
                    <span className="cn-time">{timeAgo(item.last_at)}</span>
                  </span>
                  <span className="cn-preview">
                    {item.last_dir === 'out' ? 'You: ' : ''}{lastMessagePreview(item)}
                  </span>
                </span>
                {item.unread > 0 && <span className="cn-unread-dot" aria-label="Unread" />}
              </button>
            ) : (
              <button className="cn-row" key={`g-${key}`} onClick={() => onOpenGroup(item)}>
                <GroupAvatar name={item.name} />
                <span className="cn-row-copy">
                  <span className="cn-row-top">
                    <strong>{item.name}</strong>
                    <span className="cn-time">{timeAgo(item.last_at)}</span>
                  </span>
                  <span className="cn-preview">
                    {item.deleted_at ? 'Group closed' : lastMessagePreview(item)
                      ? `${item.last_dir === 'out'
                        ? 'You'
                        : item.last_from_handle ? `@${item.last_from_handle}` : 'Someone'}: ${lastMessagePreview(item)}`
                      : `${(item.members || []).length} ${(item.members || []).length === 1 ? 'person' : 'people'}`}
                  </span>
                </span>
                {item.unread > 0 && <span className="cn-unread-dot" aria-label="Unread" />}
              </button>
            )
          ))}
        </div>
      )}

      {creating && (
        <NewGroupSheet
          me={me}
          onClose={() => setCreating(false)}
          onCreated={async (gid) => { await onGroupsChanged(gid); setCreating(false) }}
          showToast={showToast}
        />
      )}
    </div>
  )
}

function NewGroupSheet({ me, onClose, onCreated, showToast }) {
  const [name, setName] = useState('')
  const [people, setPeople] = useState(null)
  const [selected, setSelected] = useState({})
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState(null)
  const [error, setError] = useState('')
  const [peopleError, setPeopleError] = useState(false)
  const [peopleAttempt, setPeopleAttempt] = useState(0)
  const submitting = useRef(false)
  const sheetRef = useModalFocus(true, () => { if (!submitting.current) onClose() })

  useEffect(() => {
    const controller = new AbortController()
    setPeopleError(false)
    setPeople(null)
    searchPeople('', controller.signal)
      .then(found => { if (!controller.signal.aborted) setPeople(found.users.filter(user => user.host !== me?.host)) })
      .catch(() => { if (!controller.signal.aborted) { setPeople([]); setPeopleError(true) } })
    return () => controller.abort()
  }, [me?.host, peopleAttempt])

  async function create(event) {
    event.preventDefault()
    const groupName = name.trim()
    if ((!groupName && !created) || submitting.current) return
    submitting.current = true
    setBusy(true)
    setError('')
    let saved = created
    try {
      if (!saved) {
        saved = await createGroup(groupName, Object.keys(selected).filter(host => selected[host]))
        setCreated(saved)
        window.mobius?.signal?.('item_created', { type: 'group' })
      }
      await onCreated(saved.gid)
      const failed = Object.values(saved.invited || {}).filter(ok => !ok).length
      showToast(failed ? `Group created. ${failed} invitation${failed === 1 ? '' : 's'} could not be delivered.` : 'Group created', failed ? 'error' : 'success')
    } catch (failure) {
      window.mobius?.signal?.('error', { message: failure.message, source: 'group_create' })
      setError(saved
        ? 'Your group was created, but couldn’t be opened. Open it again below—this won’t create a duplicate.'
        : failure.message || 'The group couldn’t be created. Please try again.')
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  const selectedCount = Object.values(selected).filter(Boolean).length
  const visiblePeople = (people || []).filter(user => `${user.handle || ''} ${user.host}`.toLowerCase().includes(query.trim().toLowerCase()))
  return (
    <div className="cn-scrim" role="dialog" aria-modal="true" aria-label="New group" onClick={busy ? undefined : onClose}>
      <form ref={sheetRef} tabIndex={-1} className="cn-sheet cn-group-create" onClick={event => event.stopPropagation()} onSubmit={create}>
        <div className="cn-grabber" aria-hidden="true" />
        <div className="cn-group-create-body">
          <h3 className="cn-sheet-title">New group</h3>
          <p className="cn-sheet-body">A shared conversation for your people. Start with a name, then choose who to invite.</p>
          <label className="cn-field-label" htmlFor="cn-group-name">Group name</label>
          <input id="cn-group-name" className="cn-input" value={name} onChange={event => setName(event.target.value)} maxLength={80}
                 placeholder="e.g. Weekend plans" aria-label="Group name" disabled={busy || !!created} required />
          <div className="cn-group-members-head">
            <h4>Invite people</h4><span>{selectedCount ? `${selectedCount} selected` : 'Optional'}</span>
          </div>
          {people === null && <div className="cn-group-status" role="status">Loading people…</div>}
          {peopleError && <div className="cn-directory-error" role="alert">
            <p>People couldn’t be loaded. Try again, or create a group with just yourself.</p>
            <button type="button" className="cn-btn cn-btn-secondary" onClick={() => setPeopleAttempt(value => value + 1)}>Try again</button>
          </div>}
          {!peopleError && people?.length === 0 && <p className="cn-sheet-body">No one else is in your directory yet. You can still start a group with just yourself.</p>}
          {!!people?.length && <>
            <input className="cn-input" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find someone" aria-label="Find group members" disabled={busy || !!created} />
            <div className="cn-group-member-list">
              {visiblePeople.map(user => <label className="cn-member-row" key={user.host}>
                <input type="checkbox" checked={!!selected[user.host]} disabled={busy || !!created}
                       onChange={event => setSelected(prior => ({ ...prior, [user.host]: event.target.checked }))} />
                <Avatar name={user.handle} host={user.host} size="small" />
                <span className="cn-row-copy"><strong>{user.handle ? `@${user.handle}` : 'Social member'}</strong><span className="cn-meta">{user.host}</span></span>
              </label>)}
              {visiblePeople.length === 0 && <p className="cn-group-status">No matching people in this directory.</p>}
            </div>
          </>}
        </div>
        <div className="cn-group-create-footer">
          {error && <div className="cn-directory-error" role="alert">{error}</div>}
          <div className="cn-sheet-actions">
            <button type="button" className="cn-btn cn-btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="cn-btn cn-btn-primary" type="submit" disabled={busy || (!created && !name.trim())}>
              {busy ? (created ? 'Opening…' : 'Creating…') : created ? 'Open group' : 'Create group'}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
