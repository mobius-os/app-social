import { useEffect, useState } from 'react'
import { ArrowLeft } from '@openai/apps-sdk-ui/components/Icon'
import {
  acceptGroupInvitation, clearGroupUnread, clockTime, declineGroupInvitation,
  getGroup, listGroupMessages, requestStatus, retryGroupMessage, sendGroupMessage,
  watchLatestGroupMessages,
} from '../api.js'
import { GroupAvatar } from './Messages.jsx'
import { Avatar } from './Board.jsx'
import MessageBubble, { replyTargetFor } from './MessageBubble.jsx'
import GroupDetails from './GroupDetails.jsx'
import {
  DeliveryNote, DeliveryTick, MessageTimeline, TimelineComposer, useMessageTimeline,
  withDayDividers,
} from './useMessageTimeline.jsx'

export default function GroupThread({
  group, me, version, foreground, onBack, showToast, onOpenImage,
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
    sendBlocked: !!currentGroup.deleted_at,
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
      />,
      <DeliveryNote key={`fail-${message.id}`} message={message} timeline={timeline} />,
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
      <div className="cn-thread-bar">
        <button className="cn-btn cn-btn-ghost cn-btn-icon" onClick={onBack} aria-label="Back">
          <ArrowLeft />
        </button>
        <GroupAvatar name={currentGroup.name} />
        <span className="cn-thread-heading">
          <span className="cn-person-name">{currentGroup.name}</span>
          <span className="cn-meta">{currentGroup.deleted_at ? 'Group closed' : `${memberCount} ${memberCount === 1 ? 'person' : 'people'}`}</span>
        </span>
        <button className="cn-btn cn-btn-secondary" onClick={() => setDetails(true)} aria-label="Group details">Details</button>
      </div>
      <MessageTimeline timeline={timeline} header={invitationPanel} empty={emptyState}>
        {rendered}
      </MessageTimeline>
      {currentGroup.deleted_at ? <div className="cn-group-closed" role="status">This group has been closed. You can still read its earlier messages.</div>
        : pending ? <div className="cn-request-quiet" role="status">Accept this invitation to send messages.</div>
        : <TimelineComposer timeline={timeline} onOpenImage={onOpenImage} />}
      {details && <GroupDetails group={currentGroup} me={me} onClose={() => setDetails(false)}
        onUpdated={updated => { timeline.cancelRefresh(); setCurrentGroup(updated) }}
        onDeleted={() => { showToast('Group deleted', 'success'); onBack() }} />}
    </div>
  )
}
