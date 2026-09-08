import { useMemo, useState } from 'react'
import { useApp } from '../../app/store'
import { useI18n } from '../../i18n'
import { Avatar, GroupAvatar, Modal } from '../components/primitives'
import { conversationTitle, isRequest } from '../screens/ChatList'
import type { ChatAddress, Conversation } from '../../core/models/types'

/** Where a conversation is reached: a group by its id, a person by their key. */
const addressOf = (conversation: Conversation): ChatAddress =>
  conversation.kind === 'group' ? conversation.id : conversation.peerPubkey

/**
 * Where to forward to: the conversations, most recent first, as Telegram lists
 * them (ADR-061). A copy is what goes, naming nobody it came from, so
 * forwarding never tells someone who said it to a person they never told.
 * Requests, blocked people and groups one has left are not offered.
 */
export function ForwardSheet({
  onPick,
  onClose,
}: {
  onPick: (to: ChatAddress) => void
  onClose: () => void
}) {
  const { t, locale } = useI18n()
  const conversations = useApp((s) => s.conversations)
  const contacts = useApp((s) => s.contacts)
  const [query, setQuery] = useState('')

  const targets = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return conversations
      .filter(
        (c) =>
          !isRequest(c, contacts) &&
          !c.mls?.left &&
          !(c.kind === 'direct' && contacts.get(c.peerPubkey)?.blocked),
      )
      .map((c) => ({ conversation: c, title: conversationTitle(c, contacts, locale) }))
      .filter(({ title }) => !needle || title.toLowerCase().includes(needle))
      .sort((a, b) => b.conversation.lastActivity - a.conversation.lastActivity)
  }, [conversations, contacts, locale, query])

  return (
    <Modal title={t('chat.forwardTitle')} onClose={onClose}>
      <div className="stack-sm">
        <input
          className="input"
          type="search"
          placeholder={t('chats.searchPlaceholder')}
          aria-label={t('chats.searchPlaceholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="forward-list">
          {targets.map(({ conversation, title }) => (
            <button
              key={conversation.id}
              type="button"
              className="list-row"
              onClick={() => onPick(addressOf(conversation))}
            >
              {conversation.kind === 'group' ? (
                <GroupAvatar seed={conversation.id} size="sm" />
              ) : (
                <Avatar
                  name={title}
                  seed={conversation.peerPubkey}
                  src={contacts.get(conversation.peerPubkey)?.avatar}
                  size="sm"
                />
              )}
              <span className="grow truncate" dir="auto">
                {title}
              </span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}
