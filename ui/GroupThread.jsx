import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, SettingsCog } from '@openai/apps-sdk-ui/components/Icon'
import {
  acceptGroupInvitation, clearGroupUnread, clockTime, declineGroupInvitation,
  editGroupMessage, getGroup, getPeer, listGroupMessages, reactToGroupMessage, requestStatus, retryGroupMessage,
  sendGroupMessage, watchLatestGroupMessages,
} from '../api.js'
import { BOARD_REACTION_EMOJIS } from '../reconciliation.js'
import GroupPicture from './GroupPicture.jsx'
import { Avatar } from './Board.jsx'
import MessageBubble, { replyTargetFor } from './MessageBubble.jsx'
import { ReactionRetryNote, supportsMessageReactions, useMessageReactions } from './MessageReactions.jsx'
import { supportsMessageEdits, useMessageEdits } from './messageEdits.js'
import GroupSettings from './GroupDetails.jsx'
import {
  DeliveryNote, DeliveryTick, MessageTimeline, TimelineComposer, useMessageTimeline,
  withDayDividers,
} from './useMessageTimeline.jsx'

export default function GroupThread({
  group, me, version, foreground, onBack, showToast, onOpenImage, onOpenPerson, onMessageUser,
}) {
  const [details, setDetails] = useState(false)
  const [currentGroup, setCurrentGroup] = useState(group)
  const [requestBusy, setRequestBusy] = useState('')
  const [requestError, setRequestError] = useState('')
  const gid = group.gid
  const pending = requestStatus(currentGroup) === 'pending'
  const timeline = useMessageTimeline({
    version,
    showToast,
    loadPage: (cursor, options) => listGroupMessages(gid, cursor, options),
    watchLatest: (onPage) => watchLatestGroupMessages(gid, onPage),
    refreshExtra: () => getGroup(gid),
    onRefreshed: setCurrentGroup,
    pinnedTop: pending,
    sendBlocked: !!(currentGroup.deleted_at || currentGroup.removed_at),
    signals: { created: 'group_message', error: 'group_send' },
    deliver: ({ id, text, attachment, reply }) =>
      sendGroupMessage(id, gid, text, attachment, reply),
    onSent: (result) => {
      if (result.status === 'failed') {
        showToast(result.detail || 'The group host couldn’t be reached.', 'error')
      } else if (result.failed_members?.length) {
        const count = result.failed_members.length
        showToast(`Sent — ${count} ${count === 1 ? 'person is' : 'people are'} unreachable right now.`, 'error')
      }
    },
    retrySaved: (id) => retryGroupMessage(gid, id),
    retryFailedText: 'The group host still couldn’t be reached.',
  })
  const { messages } = timeline

  // Messages are read only while this pane is actually visible to the owner.
  const isMember = requestStatus(currentGroup) === 'accepted'
  const hostedHere = !!me?.host && currentGroup.host === me.host
  const [hostReacts, setHostReacts] = useState(false)
  const [hostEdits, setHostEdits] = useState(false)
  useEffect(() => {
    let active = true
    setHostReacts(false)
    setHostEdits(false)
    if (hostedHere || !currentGroup.host) return () => { active = false }
    getPeer(currentGroup.host, undefined, { background: true })
      .then(actor => {
        if (!active) return
        setHostReacts(supportsMessageReactions(actor))
        setHostEdits(supportsMessageEdits(actor))
      })
      .catch(() => {})
    return () => { active = false }
  }, [currentGroup.host, hostedHere])
  const [pickerFor, setPickerFor] = useState(null)
  const closePicker = useCallback(() => setPickerFor(null), [])
  const messageReactions = useMessageReactions({
    ownHost: me?.host,
    send: (id, emoji, on, updateId) => reactToGroupMessage(gid, id, emoji, on, updateId),
    onError: error => showToast(error.message || 'The reaction couldn’t be sent.', 'error'),
  })
  const canReact = isMember && !currentGroup.deleted_at && !currentGroup.removed_at && (hostedHere || hostReacts)
  const canEdit = isMember && !currentGroup.deleted_at && !currentGroup.removed_at && (hostedHere || hostEdits)
  const saveEdit = useMessageEdits({
    timeline, showToast, save: (id, text, editId) => editGroupMessage(gid, id, text, editId),
  })
  useEffect(() => {
    if (foreground && isMember) clearGroupUnread(gid).catch(() => {})
  }, [gid, version, foreground, isMember])

  async function decideInvitation(action) {
    if (requestBusy) return
    setRequestBusy(action)
    setRequestError('')
    try {
      if (action === 'accept') {
        await acceptGroupInvitation(gid)
        const accepted = await getGroup(gid)
        setCurrentGroup(accepted)
        showToast('Joined group', 'success')
      } else {
        await declineGroupInvitation(gid)
        onBack()
      }
    } catch (error) {
      setRequestError(error.message || 'This invitation couldn’t be updated. Try again.')
    } finally {
      setRequestBusy('')
    }
  }

  const memberCount = (currentGroup.members || []).length
  // Who is in the group, shown after the count: "You" first, then handles.
  // A member saved without a handle borrows it from the cached people list.
  const [knownHandles, setKnownHandles] = useState({})
  useEffect(() => {
    let active = true
    window.mobius?.storage?.get('cache/people.json').then(cached => {
      if (!active || !Array.isArray(cached?.users)) return
      setKnownHandles(Object.fromEntries(cached.users.filter(user => user.handle).map(user => [user.host, user.handle])))
    }).catch(() => null)
    return () => { active = false }
  }, [])
  const memberNames = (currentGroup.members || [])
    .map(member => {
      if (member.host === me?.host) return 'You'
      const handle = member.handle || knownHandles[member.host]
      return handle ? `@${handle}` : 'Social member'
    })
    .sort((a, b) => (a === 'You' ? -1 : b === 'You' ? 1 : 0))
    .join(', ')
  let lastAuthor = null
  const rendered = withDayDividers(messages, (message, startsDay) => {
    if (startsDay) lastAuthor = null
    const mine = message.dir === 'out'
    const firstOfCluster = !mine && message.author !== lastAuthor
    lastAuthor = mine ? null : message.author
    const author = mine ? me?.handle : message.author_handle
    return [
      firstOfCluster && (
        <span className="cn-author" key={`author-${message.id}`}>
          {message.author_handle ? `@${message.author_handle}` : 'Social member'}
        </span>
      ),
      <MessageBubble
        key={message.id}
        message={{ ...message, time: clockTime(message.sent_at) }}
        mine={mine}
        author={author}
        tick={mine && <DeliveryTick status={message.status} />}
        avatar={!mine && firstOfCluster
          ? <Avatar name={message.author_handle} host={requestStatus(currentGroup) === 'pending' ? undefined : message.author} size="small" remote />
          : null}
        indent={!mine && !firstOfCluster}
        conversationPath={`groups/${gid}`}
        onOpenImage={onOpenImage}
        onImageUnavailable={() => showToast('This photo couldn’t be loaded.', 'error')}
        onReply={pending ? undefined : () => timeline.replyTo(replyTargetFor(
          message, author || 'Social member',
        ))}
        reactions={{
          state: messageReactions.stateFor(message),
          choices: BOARD_REACTION_EMOJIS,
          canReact,
          disabled: Boolean(messageReactions.pending[message.id]),
          open: pickerFor === message.id,
          onToggle: () => setPickerFor(open => open === message.id ? null : message.id),
          onClose: closePicker,
          onReact: emoji => messageReactions.toggle(message, emoji),
        }}
        edits={{ canEdit, onSave: saveEdit }}
      />,
      <DeliveryNote key={`fail-${message.id}`} message={message} timeline={timeline} />,
      <ReactionRetryNote key={`react-${message.id}`} message={message} mine={mine} reactions={messageReactions} />,
    ]
  })

  const invitationPanel = pending && (
    <section className="cn-request-panel" aria-labelledby="cn-group-request-title">
      <div>
        <strong id="cn-group-request-title">Group invitation</strong>
        <p>
          {currentGroup.invited_by_handle ? `@${currentGroup.invited_by_handle}` : currentGroup.host} invited you to join.
          Messages stay quiet, and previewing them doesn’t join the group.
        </p>
      </div>
      {requestError && <p className="cn-request-error" role="alert">{requestError}</p>}
      <div className="cn-request-actions">
        <button className="cn-btn cn-btn-primary" type="button" disabled={!!requestBusy}
                onClick={() => decideInvitation('accept')}>
          {requestBusy === 'accept' ? 'Joining…' : 'Accept and join'}
        </button>
        <button className="cn-btn cn-btn-secondary" type="button" disabled={!!requestBusy}
                onClick={() => decideInvitation('decline')}>Decline</button>
      </div>
    </section>
  )
  const emptyState = (
    <div className="cn-empty">
      <div className="cn-empty-title">Say hello</div>
      <p className="cn-empty-text">
        Messages go to the group’s home server and on to every member’s own server.
      </p>
    </div>
  )

  return (
    <div className={`cn-thread cn-screen${details ? ' has-dialog' : ''}`}>
      <div className="cn-thread-back-row">
        <button type="button" className="cn-back-link" onClick={onBack} aria-label="Back to Chats">
          <ChevronLeft aria-hidden="true" /><span>Chats</span>
        </button>
      </div>
      <div className="cn-thread-bar">
        <GroupPicture gid={gid} hash={currentGroup.icon_hash} name={currentGroup.name} />
        <span className="cn-thread-heading">
          <span className="cn-person-name">{currentGroup.name}</span>
          <span className="cn-meta cn-group-members-line" title={memberNames}>{currentGroup.deleted_at ? 'Group closed' : currentGroup.removed_at ? 'Removed' : `${memberCount} ${memberCount === 1 ? 'person' : 'people'}${memberNames ? ` · ${memberNames}` : ''}`}</span>
        </span>
        <button type="button" className="cn-header-cog" onClick={() => setDetails(true)} aria-label="Group settings"
                title="Group settings" aria-haspopup="dialog">
          <SettingsCog aria-hidden="true" />
        </button>
      </div>
      <MessageTimeline timeline={timeline} header={invitationPanel} empty={emptyState}>
        {rendered}
      </MessageTimeline>
      {currentGroup.deleted_at ? <div className="cn-group-closed" role="status">This group has been closed. You can still read its earlier messages.</div>
        : currentGroup.removed_at ? <div className="cn-group-closed" role="status">You were removed from this group. You can still read its earlier messages.</div>
        : pending ? <div className="cn-request-quiet" role="status">Accept this invitation to send messages.</div>
        : <TimelineComposer timeline={timeline} onOpenImage={onOpenImage} />}
      {details && <GroupSettings group={currentGroup} me={me} knownHandles={knownHandles} showToast={showToast}
        onClose={() => setDetails(false)}
        onUpdated={updated => { timeline.cancelRefresh(); setCurrentGroup(updated) }}
        onDeleted={() => { setDetails(false); showToast('Group deleted', 'success'); onBack() }}
        onOpenPerson={host => onOpenPerson?.(host)}
        onMessage={(host, handle) => onMessageUser?.(host, handle)} />}
    </div>
  )
}
