import { useMemo, useState } from 'react'
import { useApp } from '../../app/store'
import { useI18n } from '../../i18n'
import { useNavigate } from '../../app/router'
import { Avatar, EmptyState, GroupAvatar } from '../components/primitives'
import { ContactsIcon, PlusIcon, ShieldCheckIcon } from '../components/Icons'
import { formatListTimestamp } from '../format'
import { shortNpub, toNpub } from '../../core/identity/keys'
import type { Contact, Conversation } from '../../core/models/types'
import type { LocaleCode } from '../../core/models/types'
import { ConnectionBadge } from '../components/ConnectionStatus'
import { callSummary, isCallEntry } from '../components/CallBubble'

export function displayName(contact: Contact | undefined, pubkey: string): string {
  return contact?.name || contact?.remoteName || shortNpub(toNpub(pubkey))
}

/**
 * Names as a sentence would list them, in the reader's language — "Bob,
 * Carol and Dave" / «باب، کارول و دیو» — rather than joined with a Latin
 * comma that reads wrongly in Persian.
 */
export function listNames(names: readonly string[], locale: LocaleCode): string {
  try {
    return new Intl.ListFormat(locale, { style: 'short', type: 'conjunction' }).format(names)
  } catch {
    return names.join(', ')
  }
}

/** What a conversation is called: its person, or its group's name, or who is in it. */
export function conversationTitle(
  conversation: Conversation,
  contacts: ReadonlyMap<string, Contact>,
  locale: LocaleCode,
): string {
  if (conversation.kind !== 'group') {
    return displayName(contacts.get(conversation.peerPubkey), conversation.peerPubkey)
  }
  if (conversation.subject) return conversation.subject
  const names = conversation.members.map((pubkey) => displayName(contacts.get(pubkey), pubkey))
  return listNames(names, locale)
}

/**
 * A request is a conversation the user has not taken: a direct one with a
 * contact they have not accepted, or a group started by someone outside their
 * address book.
 */
export const isRequest = (conversation: Conversation, contacts: ReadonlyMap<string, Contact>): boolean =>
  conversation.kind === 'group'
    ? !conversation.accepted
    : contacts.get(conversation.peerPubkey)?.accepted === false

export function ChatList() {
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  const conversations = useApp((s) => s.conversations)
  const contacts = useApp((s) => s.contacts)
  const typingPeers = useApp((s) => s.typingPeers)
  const previews = useApp((s) => s.previews)
  const [query, setQuery] = useState('')

  const { accepted, requests } = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = (conversation: Conversation) => {
      if (!needle) return true
      // A group matches on its name and on anyone in it.
      return (
        conversationTitle(conversation, contacts, locale).toLowerCase().includes(needle) ||
        conversation.members.some(
          (pubkey) =>
            pubkey.includes(needle) ||
            displayName(contacts.get(pubkey), pubkey).toLowerCase().includes(needle),
        )
      )
    }
    const visible = conversations.filter(matches)
    return {
      accepted: visible.filter((c) => !isRequest(c, contacts)),
      requests: visible.filter((c) => isRequest(c, contacts)),
    }
  }, [conversations, contacts, query, locale])

  const renderRow = (conversation: Conversation) => {
    const group = conversation.kind === 'group'
    const contact = group ? undefined : contacts.get(conversation.peerPubkey)
    const name = conversationTitle(conversation, contacts, locale)
    const typing = !group && typingPeers.has(conversation.peerPubkey)
    const preview = previews.get(conversation.id)
    // In a group the preview says who wrote it, as the list in every group
    // messenger does; "You:" already covers our own.
    const author =
      group && preview?.direction === 'in'
        ? `${displayName(contacts.get(preview.authorPubkey), preview.authorPubkey)}: `
        : null
    return (
      <button
        key={conversation.id}
        className="convo-row"
        onClick={() =>
          navigate(
            group ? { name: 'group', id: conversation.id } : { name: 'chat', peer: conversation.peerPubkey },
          )
        }
      >
        {group ? (
          <GroupAvatar seed={conversation.id} />
        ) : (
          <Avatar name={name} seed={conversation.peerPubkey} src={contact?.avatar} />
        )}
        <span className="convo-main">
          <span className="convo-top">
            <span className="convo-name" dir="auto">
              {name}
              {contact?.verification === 'verified' ? (
                <ShieldCheckIcon
                  size={14}
                  style={{ display: 'inline', marginInlineStart: 4, color: 'var(--success)' }}
                />
              ) : null}
            </span>
            <span className="convo-time">{formatListTimestamp(conversation.lastActivity, locale)}</span>
          </span>
          <span className="convo-preview">
            <span className="convo-preview-text" dir="auto">
              {typing ? (
                <em>{t('chat.typing')}</em>
              ) : contact?.blocked ? (
                t('chat.blocked')
              ) : conversation.draft ? (
                <>
                  <span style={{ color: 'var(--warning)' }}>{t('chats.draft')}: </span>
                  {conversation.draft}
                </>
              ) : preview && isCallEntry(preview) ? (
                <span className={preview.call.outcome === 'missed' ? 'convo-preview-missed' : undefined}>
                  {callSummary(preview, t)}
                </span>
              ) : preview ? (
                <>
                  {preview.direction === 'out' ? <span className="faint">{t('chats.you')}</span> : null}
                  {author ? <span className="faint">{author}</span> : null}
                  {preview.body}
                </>
              ) : null}
            </span>
            {conversation.unread > 0 ? (
              <span className="unread-dot" aria-label={String(conversation.unread)}>
                {conversation.unread > 99 ? '99+' : conversation.unread}
              </span>
            ) : null}
          </span>
        </span>
      </button>
    )
  }

  return (
    <div className="screen">
      <header className="app-header">
        <h1 className="grow">{t('chats.title')}</h1>
        <ConnectionBadge />
        <button
          className="btn btn-icon"
          aria-label={t('groups.newGroup')}
          title={t('groups.newGroup')}
          onClick={() => navigate({ name: 'new-group' })}
        >
          <ContactsIcon />
        </button>
        <button
          className="btn btn-icon"
          aria-label={t('contacts.add')}
          title={t('contacts.add')}
          onClick={() => navigate({ name: 'add-contact' })}
        >
          <PlusIcon />
        </button>
      </header>

      {conversations.length > 4 ? (
        <div style={{ padding: 'var(--space-2) var(--space-3)' }}>
          <input
            className="input"
            type="search"
            placeholder={t('chats.searchPlaceholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      ) : null}

      <div className="screen-scroll">
        {conversations.length === 0 ? (
          <EmptyState
            title={t('chats.empty')}
            body={t('chats.emptyBody')}
            action={
              <button className="btn btn-primary" onClick={() => navigate({ name: 'add-contact' })}>
                {t('chats.addContact')}
              </button>
            }
          />
        ) : (
          <>
            {requests.length > 0 ? (
              <>
                <div className="stack-sm" style={{ padding: 'var(--space-3) var(--space-4) var(--space-1)' }}>
                  <span className="section-title">{t('chats.requests')}</span>
                  <span className="hint">{t('chats.requestsBody')}</span>
                </div>
                {requests.map(renderRow)}
              </>
            ) : null}
            {accepted.map(renderRow)}
          </>
        )}
      </div>
    </div>
  )
}
