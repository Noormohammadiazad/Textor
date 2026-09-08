import { useMemo } from 'react'
import { useApp } from '../../app/store'
import { useI18n } from '../../i18n'
import { goBack, useNavigate } from '../../app/router'
import { Avatar, EmptyState, GroupAvatar } from '../components/primitives'
import { BackIcon, ShieldCheckIcon, TrashIcon } from '../components/Icons'
import { conversationTitle, displayName } from '../screens/ChatList'
import { SecureGroupPanel } from './SecureGroupPanel'

/**
 * Who is in a group, and what can be done to it here.
 *
 * For a small group, one thing: leave it behind. There is no "add member" —
 * under NIP-17 a group is exactly the set of people in it, so a different set
 * is a different conversation — and the screen says so rather than offering
 * a control that cannot exist. A forward-secret group is the opposite case,
 * an MLS group whose membership is its to change: see `SecureGroupPanel`.
 */
export function GroupInfo({ id }: { id: string }) {
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  const conversations = useApp((s) => s.conversations)
  const contacts = useApp((s) => s.contacts)
  const identity = useApp((s) => s.identity)
  const deleteConversation = useApp((s) => s.deleteConversation)
  const conversationsLoaded = useApp((s) => s.conversationsLoaded)
  const group = useMemo(
    () => conversations.find((conversation) => conversation.id === id && conversation.kind === 'group'),
    [conversations, id],
  )

  if (!group) {
    // Nothing to say until the list has been read; then, that it is not here.
    return (
      <div className="screen">
        <header className="app-header">
          <button className="btn btn-icon" aria-label={t('common.back')} onClick={() => goBack()}>
            <BackIcon />
          </button>
        </header>
        {conversationsLoaded ? (
          <EmptyState title={t('groups.notFound')} body={t('groups.notFoundBody')} />
        ) : null}
      </div>
    )
  }

  const remove = async () => {
    if (!confirm(t('groups.deleteConfirm'))) return
    await deleteConversation(group.id)
    navigate({ name: 'chats' }, true)
  }

  return (
    <div className="screen">
      <header className="app-header">
        <button className="btn btn-icon" aria-label={t('common.back')} onClick={() => goBack()}>
          <BackIcon />
        </button>
        <h1 className="grow">{t('groups.info')}</h1>
      </header>

      <div className="screen-scroll">
        <div className="container stack" style={{ maxWidth: '34rem' }}>
          <div className="stack-sm center group-hero">
            <GroupAvatar seed={group.id} size="lg" />
            <h2 dir="auto">{conversationTitle(group, contacts, locale)}</h2>
            <span className="muted small">{t('groups.members', { n: group.members.length + 1 })}</span>
          </div>

          {group.mls ? (
            <SecureGroupPanel group={group} />
          ) : (
            <>
              <div className="card-section">
                {identity ? (
                  <div className="list-row">
                    <Avatar name={identity.name} seed={identity.pubkey} src={identity.avatar} size="sm" />
                    <span className="grow truncate">
                      <bdi>{identity.name}</bdi>
                    </span>
                    <span className="hint">{t('groups.you')}</span>
                  </div>
                ) : null}
                {[...group.members]
                  // Stored in key order, which is meaningless to read; listed by name.
                  .sort((a, b) =>
                    displayName(contacts.get(a), a).localeCompare(displayName(contacts.get(b), b), locale),
                  )
                  .map((pubkey) => {
                    const contact = contacts.get(pubkey)
                    const name = displayName(contact, pubkey)
                    const known = contact?.accepted === true
                    const body = (
                      <>
                        <Avatar name={name} seed={pubkey} src={contact?.avatar} size="sm" />
                        <span className="grow stack-sm" style={{ minWidth: 0 }}>
                          <span className="truncate">
                            <bdi>{name}</bdi>
                          </span>
                          {known ? null : <span className="hint">{t('groups.notInContacts')}</span>}
                        </span>
                        {contact?.verification === 'verified' ? (
                          <ShieldCheckIcon size={15} style={{ color: 'var(--success)' }} />
                        ) : null}
                      </>
                    )
                    // Someone in the address book opens their contact page, where
                    // they can be verified; a stranger has nothing to open yet.
                    return contact ? (
                      <button
                        key={pubkey}
                        type="button"
                        className="list-row"
                        onClick={() => navigate({ name: 'contact', peer: pubkey })}
                      >
                        {body}
                      </button>
                    ) : (
                      <div key={pubkey} className="list-row">
                        {body}
                      </div>
                    )
                  })}
              </div>

              <p className="hint">{t('groups.fixedMembers')}</p>

              <button type="button" className="btn btn-danger-soft btn-block" onClick={() => void remove()}>
                <TrashIcon size={16} />
                {t('groups.delete')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
