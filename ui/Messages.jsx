import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Mail, Search } from '@openai/apps-sdk-ui/components/Icon'
import { chatListTime, createGroup, searchPeople } from '../api.js'
import GroupPicture from './GroupPicture.jsx'
import { Avatar } from './Board.jsx'
import { useModalFocus } from './modalFocus.js'
import { memberLabel, newConversationPlan } from './newConversation.js'
import { gifPreviewText } from '../gifs.js'
import { noteAvatarDigests } from '../avatarHints.js'

// The + picker keeps the people directory in memory so it opens with the list
// already drawn. It shares People's saved copy and refreshes in the background.
const DIRECTORY_FRESH_MS = 60_000
let directory = null // { users, at }
let directoryLoad = null

function rememberDirectory(users) {
  directory = { users, at: Date.now() }
  window.mobius?.storage?.set('cache/people.json', { users, cached_at: directory.at }).catch(() => null)
  return users
}

async function savedDirectory() {
  if (directory) return directory
  try {
    const cached = await window.mobius?.storage?.get('cache/people.json')
    if (Array.isArray(cached?.users) && !directory) {
      noteAvatarDigests(cached.users)
      directory = { users: cached.users, at: Number(cached.cached_at || 0) }
    }
  } catch { /* no saved copy yet */ }
  return directory
}

function refreshDirectory() {
  directoryLoad ||= searchPeople('', undefined, { background: true })
    .then(found => rememberDirectory(found.users))
    .finally(() => { directoryLoad = null })
  return directoryLoad
}

// Warm the directory while the Chats tab is open, before + is tapped.
async function prepareDirectory() {
  const saved = await savedDirectory()
  if (!saved || Date.now() - saved.at > DIRECTORY_FRESH_MS) refreshDirectory().catch(() => null)
}

function GroupAvatar({ name, gid, iconHash }) {
  return <GroupPicture gid={gid} hash={iconHash} name={name} />
}

export { GroupAvatar }

function lastMessagePreview(item) {
  const text = String(item.last_text || '').trim()
  if (text) return gifPreviewText(text)
  if (item.last_attachment || item.last_message?.attachment || item.attachment) return '📷 Photo'
  return ''
}

function groupPreview(item, isRequest) {
  const members = (item.members || []).length
  const people = `${members} ${members === 1 ? 'person' : 'people'}`
  if (isRequest) return `${item.invited_by_handle ? `@${item.invited_by_handle}` : item.host} invited you · ${people}`
  if (item.deleted_at) return 'Group closed'
  if (item.removed_at) return 'You were removed'
  const preview = lastMessagePreview(item)
  if (!preview) return people
  const who = item.last_dir === 'out' ? 'You' : item.last_from_handle ? `@${item.last_from_handle}` : 'Someone'
  return `${who}: ${preview}`
}

// A collapsible run of rows under a small "Title  N" heading.
function InboxSection({ id, title, count, open, onToggle, children }) {
  if (!count) return null
  return (
    <section className="cn-inbox-section" aria-labelledby={`${id}-heading`}>
      <h3 className="cn-inbox-heading" id={`${id}-heading`}>
        <button type="button" aria-expanded={open} aria-controls={`${id}-rows`} onClick={onToggle}>
          <ChevronDown className={`cn-inbox-chevron${open ? '' : ' is-closed'}`} aria-hidden="true" />
          <span>{title}</span><span className="cn-inbox-count">{count}</span>
        </button>
      </h3>
      {open && <div id={`${id}-rows`}>{children}</div>}
    </section>
  )
}

function RowEnd() {
  return (
    <span className="cn-row-end">
      <ChevronRight className="cn-row-chevron" aria-hidden="true" />
    </span>
  )
}

// The unread count is a small badge on the avatar's top-right corner.
function RowAvatar({ unread, children }) {
  return (
    <span className="cn-row-avatar">
      {children}
      {unread > 0 && <span className="cn-unread-count" role="img" aria-label={`${unread} unread`}>{unread > 99 ? '99+' : unread}</span>}
    </span>
  )
}

export default function Messages({
  canCreate, me, conversations, groups, onOpenThread, onOpenGroup,
  messageRequests, groupRequests, onOpenMessageRequest,
  onGroupsChanged, showToast, creating, setCreating, loadState, onRetry,
}) {
  const [closed, setClosed] = useState({})
  const toggle = (key) => setClosed((prior) => ({ ...prior, [key]: !prior[key] }))
  useEffect(() => { prepareDirectory() }, [])
  const byRecent = (a, b) => (b.last_at || 0) - (a.last_at || 0)
  const requests = [
    ...(groupRequests || []).map((item) => ({ kind: 'group', key: item.gid, item })),
    ...(messageRequests || []).map((item) => ({ kind: 'dm', key: item.peer, item })),
  ].sort((a, b) => byRecent(a.item, b.item))
  const sortedGroups = [...groups].sort(byRecent)
  const sortedDirect = [...conversations].sort(byRecent)
  const empty = !requests.length && !sortedGroups.length && !sortedDirect.length

  function directRow(item, isRequest) {
    return (
      <button className={`cn-row${!isRequest && item.unread > 0 ? ' is-unread' : ''}`} key={`dm-${item.peer}`} onClick={() => isRequest
        ? onOpenMessageRequest(item.peer, item.peer_handle)
        : onOpenThread(item.peer)}>
        {/* Requests never fetch a stranger's avatar. */}
        <RowAvatar unread={isRequest ? 0 : item.unread}>
          <Avatar name={item.peer_handle} host={isRequest ? undefined : item.peer} size="small"
                  remote={!isRequest} />
        </RowAvatar>
        <span className="cn-row-copy">
          <span className="cn-row-top">
            <strong>{item.peer_handle ? `@${item.peer_handle}` : 'Direct message'}</strong>
            <span className="cn-time">{chatListTime(item.last_at)}</span>
          </span>
          <span className="cn-preview">
            {isRequest ? 'Wants to message you · ' : item.last_dir === 'out' ? 'You: ' : ''}{lastMessagePreview(item)}
          </span>
        </span>
        <RowEnd />
      </button>
    )
  }

  function groupRow(item, isRequest) {
    return (
      <button className={`cn-row${!isRequest && item.unread > 0 ? ' is-unread' : ''}`} key={`g-${item.gid}`} onClick={() => onOpenGroup(item)}>
        <RowAvatar unread={isRequest ? 0 : item.unread}><GroupAvatar name={item.name} gid={item.gid} iconHash={item.icon_hash} /></RowAvatar>
        <span className="cn-row-copy">
          <span className="cn-row-top">
            <strong>{item.name}</strong>
            <span className="cn-time">{chatListTime(item.last_at)}</span>
          </span>
          <span className="cn-preview">{groupPreview(item, isRequest)}</span>
        </span>
        <RowEnd />
      </button>
    )
  }

  return (<>
    <div className={`cn-content cn-screen cn-inbox${creating ? ' has-dialog' : ''}`}>
      {loadState === 'error' && <div className="cn-directory-error" role="alert">
        <p>Conversations couldn’t be loaded. Your saved messages haven’t been removed.</p>
        <button className="cn-btn cn-btn-secondary" onClick={onRetry}>Try again</button>
      </div>}
      {loadState === 'loading' && <div className="cn-center" role="status">Loading conversations…</div>}
      {empty && loadState === 'ready' ? (
        <div className="cn-empty">
          <div className="cn-empty-mark" aria-hidden="true"><Mail /></div>
          <div className="cn-empty-title">No conversations yet</div>
          <p className="cn-empty-text">Find someone in People and say hello — your message goes straight to their server.</p>
        </div>
      ) : <>
        <InboxSection id="cn-inbox-requests" title="Requests" count={requests.length}
                      open={!closed.requests} onToggle={() => toggle('requests')}>
          {requests.map(({ kind, item }) => kind === 'dm' ? directRow(item, true) : groupRow(item, true))}
        </InboxSection>
        <InboxSection id="cn-inbox-groups" title="Groups" count={sortedGroups.length}
                      open={!closed.groups} onToggle={() => toggle('groups')}>
          {sortedGroups.map((item) => groupRow(item, false))}
        </InboxSection>
        <InboxSection id="cn-inbox-direct" title="Direct messages" count={sortedDirect.length}
                      open={!closed.direct} onToggle={() => toggle('direct')}>
          {sortedDirect.map((item) => directRow(item, false))}
        </InboxSection>
      </>}

      {creating && (
        <NewConversationSheet
          me={me}
          canCreateGroup={canCreate}
          onClose={() => setCreating(false)}
          onMessage={(host, handle) => { setCreating(false); onOpenThread(host, handle) }}
          onCreated={async (gid) => { await onGroupsChanged(gid); setCreating(false) }}
          showToast={showToast}
        />
      )}
    </div>
    {/* Outside the animated screen, so it pins to the frame's corner. */}
    <div className="cn-fab-wrap">
      <button type="button" className="cn-fab" aria-label="New conversation"
              aria-haspopup="dialog" onClick={() => setCreating(true)}>
        {/* A thin drawn plus: the icon set's Plus is a heavier filled shape. */}
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>
  </>)
}

// One picker for every new conversation: choosing one person opens your chat
// with them; choosing more, or turning on "Create a group", creates a group
// (which may start with one invitee or with nobody yet).
function NewConversationSheet({ me, canCreateGroup, onClose, onMessage, onCreated, showToast }) {
  const [name, setName] = useState('')
  const [asGroup, setAsGroup] = useState(false)
  const [selected, setSelected] = useState({})
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState(null)
  const [error, setError] = useState('')
  const [peopleError, setPeopleError] = useState(false)
  const [peopleAttempt, setPeopleAttempt] = useState(0)
  const submitting = useRef(false)
  const sheetRef = useModalFocus(true, () => { if (!submitting.current) onClose() })

  const others = users => users.filter(user => user.host !== me?.host)
  const [people, setPeople] = useState(() => (directory ? others(directory.users) : null))
  useEffect(() => {
    let active = true
    setPeopleError(false)
    ;(async () => {
      const saved = await savedDirectory()
      if (!active) return
      if (saved) setPeople(others(saved.users))
      if (saved && Date.now() - saved.at < DIRECTORY_FRESH_MS && !peopleAttempt) return
      try {
        const users = await refreshDirectory()
        if (active) setPeople(others(users))
      } catch {
        if (active && !saved) { setPeople([]); setPeopleError(true) }
      }
    })()
    return () => { active = false }
  }, [me?.host, peopleAttempt])

  const chosen = (people || []).filter(user => selected[user.host])
  const plan = newConversationPlan({ chosen, asGroup, name, canCreateGroup, created, busy })
  const { isGroup } = plan

  async function submit(event) {
    event.preventDefault()
    if (submitting.current) return
    if (!isGroup && !created) {
      if (chosen.length === 1) onMessage(chosen[0].host, chosen[0].handle)
      return
    }
    const { groupName } = plan
    if (!canCreateGroup || !groupName) return
    submitting.current = true
    setBusy(true)
    setError('')
    let saved = created
    try {
      if (!saved) {
        saved = await createGroup(groupName, chosen.map(user => user.host))
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

  const locked = busy || !!created
  const visiblePeople = (people || []).filter(user => (user.handle || '').toLowerCase().includes(query.trim().replace(/^@/, '').toLowerCase()))
  const { action, disabled: actionDisabled } = plan
  return (
    <div className="cn-scrim cn-scrim-plain" role="dialog" aria-modal="true" aria-label="New conversation" onClick={busy ? undefined : onClose}>
      <form ref={sheetRef} tabIndex={-1} className="cn-sheet cn-group-create" onClick={event => event.stopPropagation()} onSubmit={submit}>
        <div className="cn-grabber" aria-hidden="true" />
        {/* Outside the scrolling list, so it stays put while names scroll. */}
          <div className="cn-search cn-new-chat-search">
            <Search aria-hidden="true" />
            <input value={query} onChange={event => setQuery(event.target.value)}
                   type="search" autoComplete="off" spellCheck={false} enterKeyHint="search"
                   placeholder="Search people by handle" aria-label="Search people" disabled={locked} />
            {query && <button type="button" className="cn-search-clear" onClick={() => setQuery('')} aria-label="Clear people search">Clear</button>}
          </div>
        <div className="cn-group-create-body">
          {people === null && <div className="cn-group-status" role="status">Loading people…</div>}
          {peopleError && <div className="cn-directory-error" role="alert">
            <p>People couldn’t be loaded.</p>
            <button type="button" className="cn-btn cn-btn-secondary" onClick={() => setPeopleAttempt(value => value + 1)}>Try again</button>
          </div>}
          {!peopleError && people?.length === 0 && <p className="cn-sheet-body">No one else is in your directory yet.</p>}
          {!!people?.length && <div className="cn-group-member-list">
            {visiblePeople.map(user => <label className="cn-member-row" key={user.host}>
              <input type="checkbox" checked={!!selected[user.host]} disabled={locked}
                     onChange={event => setSelected(prior => ({ ...prior, [user.host]: event.target.checked }))} />
              <Avatar name={user.handle} host={user.host} size="small" remote lazy />
              <span className="cn-row-copy"><strong>{memberLabel(user)}</strong></span>
            </label>)}
            {visiblePeople.length === 0 && <p className="cn-group-status">No matching people in this directory.</p>}
          </div>}
        </div>
        <div className="cn-group-create-footer">
          {canCreateGroup && !created && <label className="cn-new-chat-toggle">
            <input type="checkbox" checked={isGroup} disabled={locked || plan.groupForced}
                   onChange={event => setAsGroup(event.target.checked)} />
            <span>Create a group</span>
          </label>}
          {isGroup && <div className="cn-new-chat-group">
            <label className="cn-field-label" htmlFor="cn-group-name">
              {plan.defaultName ? 'Group name (optional)' : 'Group name'} · {chosen.length === 0 ? 'just you for now' : chosen.length === 1 ? '1 person invited' : `${chosen.length} people invited`}
            </label>
            <input id="cn-group-name" className="cn-input" value={name} onChange={event => setName(event.target.value)} maxLength={80}
                   placeholder={plan.defaultName || 'Name your group'} disabled={locked} />
            {!canCreateGroup && <p className="cn-meta">You can’t create groups right now.</p>}
          </div>}
          {error && <div className="cn-directory-error" role="alert">{error}</div>}
          <div className="cn-sheet-actions">
            <button type="button" className="cn-btn cn-btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="cn-btn cn-btn-primary" type="submit" disabled={actionDisabled}>
              {busy ? (created ? 'Opening…' : 'Creating…') : action}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
