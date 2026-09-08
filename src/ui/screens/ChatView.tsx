import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../../app/store'
import { useI18n } from '../../i18n'
import { goBack, useNavigate } from '../../app/router'
import { Avatar, Banner, EmptyState } from '../components/primitives'
import { BackIcon, BoltIcon, CloseIcon, SendIcon, ShieldCheckIcon, ShieldIcon } from '../components/Icons'
import { AttachButton, VoiceButton } from '../components/Composer'
import { MessageBubble } from '../components/MessageBubble'
import { formatDayLabel, isSameDay } from '../format'
import { displayName } from './ChatList'
import type { Message } from '../../core/models/types'

/** Read a saved draft synchronously, so the composer is populated on first paint. */
function readStoredDraft(peer: string): string {
  return useApp.getState().conversations.find((c) => c.peerPubkey === peer)?.draft ?? ''
}

/** Messages closer together than this from the same sender render as one run. */
const GROUP_WINDOW_MS = 4 * 60 * 1000

export function ChatView({ peer }: { peer: string }) {
  const { t, locale } = useI18n()
  const navigate = useNavigate()

  const messages = useApp((s) => s.messages)
  const contacts = useApp((s) => s.contacts)
  const typingPeers = useApp((s) => s.typingPeers)
  const directStates = useApp((s) => s.directStates)
  const openConversation = useApp((s) => s.openConversation)
  const closeConversation = useApp((s) => s.closeConversation)
  const sendMessage = useApp((s) => s.sendMessage)
  const retryMessage = useApp((s) => s.retryMessage)
  const deleteMessageLocally = useApp((s) => s.deleteMessageLocally)
  const deleteMessageForEveryone = useApp((s) => s.deleteMessageForEveryone)
  const hasEarlierMessages = useApp((s) => s.hasEarlierMessages)
  const loadEarlierMessages = useApp((s) => s.loadEarlierMessages)
  const setTyping = useApp((s) => s.setTyping)
  const updateContact = useApp((s) => s.updateContact)
  const saveDraft = useApp((s) => s.saveDraft)
  const settings = useApp((s) => s.settings)

  // Seeded once at mount. The route gives this component a `key` of the peer's
  // key, so switching conversations remounts and re-seeds — no effect needed,
  // and no render cascade from mirroring store state into component state.
  const [draft, setDraft] = useState(() => readStoredDraft(peer))
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  // The latest draft, readable from the unmount cleanup without making the
  // effect depend on every keystroke.
  const draftRef = useRef(draft)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const stickToBottom = useRef(true)

  const contact = contacts.get(peer)
  const name = displayName(contact, peer)
  // Captured for the memoised row builder below, which must not depend on the
  // whole contact map.
  const peerName = name
  const direct = directStates.get(peer) === 'connected'
  const typing = typingPeers.has(peer)

  useEffect(() => {
    void openConversation(peer)
    return () => {
      // Persist whatever was typed but not sent, so switching conversations
      // (or locking) does not throw it away.
      void saveDraft(peer, draftRef.current)
      closeConversation()
    }
  }, [peer, openConversation, closeConversation, saveDraft])

  // Keep the newest message in view, but do not yank the scroll position out
  // from under someone who has deliberately scrolled back through history.
  useLayoutEffect(() => {
    const node = listRef.current
    if (node && stickToBottom.current) node.scrollTop = node.scrollHeight
  }, [messages, typing])

  const onScroll = useCallback(() => {
    const node = listRef.current
    if (!node) return
    stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
  }, [])

  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    draftRef.current = ''
    setReplyTo(null)
    stickToBottom.current = true
    setTyping(false)
    await sendMessage(text, replyTo?.id)
    inputRef.current?.focus()
  }, [draft, replyTo, sendMessage, setTyping])

  const rows = useMemo(() => {
    const output: { key: string; node: React.ReactNode }[] = []
    let previous: Message | null = null

    for (const message of messages) {
      if (!previous || !isSameDay(previous.ts, message.ts)) {
        output.push({
          key: `day-${message.ts}`,
          node: (
            <div className="day-separator">
              {formatDayLabel(message.ts, locale, { today: t('chat.today'), yesterday: t('chat.yesterday') })}
            </div>
          ),
        })
      }

      const groupStart =
        !previous ||
        previous.direction !== message.direction ||
        message.ts - previous.ts > GROUP_WINDOW_MS ||
        !isSameDay(previous.ts, message.ts)

      output.push({
        key: message.id,
        node: (
          <MessageBubble
            message={message}
            groupStart={groupStart}
            senderLabel={
              message.direction === 'out' ? t('chat.fromYou') : t('chat.fromThem', { name: peerName })
            }
            quoted={message.replyTo ? (byId.get(message.replyTo) ?? null) : null}
            onReply={setReplyTo}
            onRetry={(m) => void retryMessage(m.id)}
            onDelete={(m) => void deleteMessageLocally(m.id)}
            onDeleteForEveryone={(m) => {
              if (confirm(t('chat.deleteEveryoneConfirm'))) void deleteMessageForEveryone(m.id)
            }}
          />
        ),
      })
      previous = message
    }
    return output
  }, [messages, byId, locale, t, peerName, retryMessage, deleteMessageLocally, deleteMessageForEveryone])

  return (
    <div className="chat-screen">
      <header className="chat-header">
        <button className="btn btn-icon" aria-label={t('common.back')} onClick={() => goBack()}>
          <BackIcon />
        </button>
        <Avatar name={name} seed={peer} src={contact?.avatar} size="sm" />
        <button
          className="chat-header-info"
          aria-label={t('chat.openContact', { name })}
          onClick={() => navigate({ name: 'contact', peer })}
        >
          <span className="chat-header-name">
            {name}
            {contact?.verification === 'verified' ? (
              <ShieldCheckIcon size={14} style={{ color: 'var(--success)' }} />
            ) : null}
          </span>
          <span className="chat-header-status">
            {typing ? (
              t('chat.typing')
            ) : direct ? (
              <>
                <BoltIcon size={11} /> {t('status.direct')}
              </>
            ) : (
              t('status.relayed')
            )}
          </span>
        </button>
      </header>

      {contact && !contact.accepted ? (
        <div style={{ padding: 'var(--space-3)' }}>
          <Banner tone="warning">
            <span className="grow">{t('chat.requestBanner')}</span>
            <button
              className="btn btn-ghost small"
              onClick={() => void updateContact(peer, { accepted: true, source: 'manual' })}
            >
              {t('chat.accept')}
            </button>
            <button
              className="btn btn-ghost small danger-text"
              onClick={() => void updateContact(peer, { blocked: true })}
            >
              {t('chat.block')}
            </button>
          </Banner>
        </div>
      ) : null}

      {contact?.blocked ? (
        <div style={{ padding: 'var(--space-3)' }}>
          <Banner tone="danger">
            <span className="grow">{t('chat.blocked')}</span>
            <button
              className="btn btn-ghost small"
              onClick={() => void updateContact(peer, { blocked: false })}
            >
              {t('chat.unblock')}
            </button>
          </Banner>
        </div>
      ) : null}

      {contact && contact.verification !== 'verified' && messages.length > 0 ? (
        <div style={{ padding: 'var(--space-2) var(--space-3) 0' }}>
          <Banner tone="accent">
            <ShieldIcon size={16} />
            <span className="grow">{t('chat.verifyPromptBody')}</span>
            <button className="btn btn-ghost small" onClick={() => navigate({ name: 'verify', peer })}>
              {t('contacts.verify')}
            </button>
          </Banner>
        </div>
      ) : null}

      <div className="message-list" ref={listRef} onScroll={onScroll} role="log" aria-live="polite">
        {messages.length === 0 ? (
          <EmptyState title={t('chats.noMessages')} body={t('chat.encryptedNote')} />
        ) : (
          <>
            {hasEarlierMessages ? (
              <button
                className="btn btn-ghost small"
                style={{ alignSelf: 'center', marginBottom: 'var(--space-3)' }}
                disabled={loadingEarlier}
                onClick={async () => {
                  // Hold the scroll position: growing the list upwards would
                  // otherwise jump the reader away from where they were.
                  const node = listRef.current
                  const before = node?.scrollHeight ?? 0
                  setLoadingEarlier(true)
                  stickToBottom.current = false
                  await loadEarlierMessages()
                  setLoadingEarlier(false)
                  requestAnimationFrame(() => {
                    if (node) node.scrollTop += node.scrollHeight - before
                  })
                }}
              >
                {loadingEarlier ? t('common.loading') : t('chat.loadEarlier')}
              </button>
            ) : (
              <p className="faint center" style={{ marginBottom: 'var(--space-3)' }}>
                {t('chat.startOfConversation')}
              </p>
            )}
            {rows.map((row) => (
              <div key={row.key} style={{ display: 'contents' }}>
                {row.node}
              </div>
            ))}
          </>
        )}
        {typing ? (
          <div className="typing-indicator" aria-label={t('chat.typing')}>
            <span />
            <span />
            <span />
          </div>
        ) : null}
      </div>

      {replyTo ? (
        <div className="reply-preview">
          <span className="reply-preview-body truncate" dir="auto">
            <span className="faint" style={{ display: 'block' }}>
              {t('chat.replyingTo')}
            </span>
            {replyTo.body}
          </span>
          <button className="btn btn-icon" aria-label={t('common.close')} onClick={() => setReplyTo(null)}>
            <CloseIcon size={16} />
          </button>
        </div>
      ) : null}

      <div className="composer">
        <AttachButton disabled={contact?.blocked} />
        <textarea
          ref={inputRef}
          className="composer-input"
          dir="auto"
          rows={1}
          placeholder={t('chat.placeholder')}
          aria-label={t('chat.placeholder')}
          value={draft}
          disabled={contact?.blocked}
          onChange={(event) => {
            setDraft(event.target.value)
            draftRef.current = event.target.value
            setTyping(event.target.value.length > 0)
            // Grow with content up to the CSS max-height, then scroll.
            const node = event.target
            node.style.height = 'auto'
            node.style.height = `${Math.min(node.scrollHeight, 144)}px`
          }}
          onBlur={() => setTyping(false)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            const shouldSend = settings.enterToSend ? !event.shiftKey : event.ctrlKey || event.metaKey
            if (!shouldSend) return
            event.preventDefault()
            void send()
          }}
        />
        {/* The microphone takes the place of send while there is nothing to
            send, the way every messenger does it — one control, two jobs. */}
        {draft.trim() ? (
          <button
            className="composer-send"
            aria-label={t('chat.send')}
            disabled={contact?.blocked}
            onClick={() => void send()}
          >
            <SendIcon size={18} />
          </button>
        ) : (
          <VoiceButton disabled={contact?.blocked} />
        )}
      </div>
    </div>
  )
}
