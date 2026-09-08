import { useMemo, useState } from 'react'
import { useApp } from '../../app/store'
import { useI18n } from '../../i18n'
import { useNavigate } from '../../app/router'
import { Avatar, EmptyState } from '../components/primitives'
import { PlusIcon, ShieldCheckIcon } from '../components/Icons'
import { formatListTimestamp } from '../format'
import { shortNpub, toNpub } from '../../core/identity/keys'
import type { Contact, Conversation } from '../../core/models/types'
import { ConnectionBadge } from '../components/ConnectionStatus'

export function displayName(contact: Contact | undefined, pubkey: string): string {
  return contact?.name || contact?.remoteName || shortNpub(toNpub(pubkey))
}

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
      const contact = contacts.get(conversation.peerPubkey)
      return (
        displayName(contact, conversation.peerPubkey).toLowerCase().includes(needle) ||
        conversation.peerPubkey.includes(needle)
      )
    }
    const visible = conversations.filter(matches)
    return {
      accepted: visible.filter((c) => contacts.get(c.peerPubkey)?.accepted !== false),
      requests: visible.filter((c) => contacts.get(c.peerPubkey)?.accepted === false),
    }
  }, [conversations, contacts, query])

  const renderRow = (conversation: Conversation) => {
    const contact = contacts.get(conversation.peerPubkey)
    const name = displayName(contact, conversation.peerPubkey)
    const typing = typingPeers.has(conversation.peerPubkey)
    const preview = previews.get(conversation.id)
    return (
      <button
        key={conversation.id}
        className="convo-row"
        onClick={() => navigate({ name: 'chat', peer: conversation.peerPubkey })}
      >
        <Avatar name={name} seed={conversation.peerPubkey} src={contact?.avatar} />
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
              ) : preview ? (
                <>
                  {preview.direction === 'out' ? <span className="faint">{t('chats.you')}</span> : null}
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
          aria-label={t('contacts.add')}
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
