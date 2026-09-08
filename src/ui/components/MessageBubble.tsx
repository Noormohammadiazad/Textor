import { memo, useState } from 'react'
import type { Message } from '../../core/models/types'
import { useI18n, type TranslationKey } from '../../i18n'
import { formatTime } from '../format'
import { AlertIcon, BoltIcon, CheckIcon, ClockIcon, DoubleCheckIcon, MoreIcon, ReplyIcon } from './Icons'
import { AttachmentView } from './AttachmentView'
import { Popover } from './Popover'

/**
 * Delivery state, rendered the way people already read it:
 *   clock  -> waiting to leave this device
 *   tick   -> a relay accepted it
 *   double -> their device has it
 *   filled -> they opened the conversation
 *
 * Every icon carries a text label for screen readers and as a tooltip: a tick
 * glyph alone conveys nothing to anyone not looking at it, and "did this
 * actually send?" is the question a serverless messenger must always answer.
 */
const STATUS_LABEL: Record<Message['status'], TranslationKey> = {
  queued: 'status.queued',
  sending: 'status.sending',
  sent: 'status.sent',
  delivered: 'status.delivered',
  read: 'status.read',
  failed: 'status.failed',
}

function StatusIcon({ status, label }: { status: Message['status']; label: string }) {
  const shared = { size: 13, className: 'tick', role: 'img' as const, 'aria-label': label }
  switch (status) {
    case 'queued':
    case 'sending':
      return <ClockIcon {...shared} />
    case 'sent':
      return <CheckIcon {...shared} />
    case 'delivered':
      return <DoubleCheckIcon {...shared} />
    case 'read':
      return <DoubleCheckIcon {...shared} className="tick tick-read" />
    case 'failed':
      return <AlertIcon {...shared} />
  }
}

export interface MessageBubbleProps {
  message: Message
  groupStart: boolean
  quoted?: Message | null
  onReply: (message: Message) => void
  onRetry: (message: Message) => void
  onDelete: (message: Message) => void
  onDeleteForEveryone: (message: Message) => void
  /** Announced before the first message of a run, so a screen reader knows who is speaking. */
  senderLabel: string
}

export const MessageBubble = memo(function MessageBubble({
  message,
  groupStart,
  quoted,
  onReply,
  onRetry,
  onDelete,
  onDeleteForEveryone,
  senderLabel,
}: MessageBubbleProps) {
  const { t, locale } = useI18n()
  const outgoing = message.direction === 'out'
  const [menuOpen, setMenuOpen] = useState(false)
  // The menu positions itself against this button, so it has to be a real node
  // rather than a ref the popover cannot measure.
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement | null>(null)

  const statusLabel = t(STATUS_LABEL[message.status])

  return (
    <div
      className={`bubble-row ${outgoing ? 'out' : 'in'}${groupStart ? ' group-start' : ''}${
        message.status === 'failed' ? ' failed' : ''
      }`}
      id={`msg-${message.id}`}
    >
      <div className="bubble">
        {/*
          Bubbles are visually attributed by side and colour, which conveys
          nothing to a screen reader. Announcing the sender once per run matches
          how the list reads visually without repeating a name on every line.
        */}
        {groupStart ? <span className="visually-hidden">{senderLabel}</span> : null}

        {quoted ? (
          <a
            className="bubble-quote"
            dir="auto"
            href={`#msg-${quoted.id}`}
            onClick={(event) => {
              event.preventDefault()
              document.getElementById(`msg-${quoted.id}`)?.scrollIntoView({ block: 'center' })
            }}
          >
            {quoted.body}
          </a>
        ) : null}

        {/*
          `dir="auto"` per message, not per app.
          A Persian UI carrying an English message (or the reverse) otherwise
          renders trailing punctuation at the wrong end — ".Hello there" — which
          is the single most visible bidi failure in a mixed-language messenger.
          Letting each bubble take its direction from its own first strong
          character fixes it without guessing at the language.
        */}
        {message.attachment ? <AttachmentView attachment={message.attachment} /> : null}

        {/* An attachment's caption is optional; an empty one must not leave a
            blank line above the timestamp. */}
        {message.body ? (
          <span className="bubble-body" dir="auto">
            {message.body}
          </span>
        ) : null}

        <div className="bubble-meta">
          {message.via === 'direct' ? (
            <BoltIcon size={11} role="img" aria-label={t('status.direct')} />
          ) : null}
          <time dateTime={new Date(message.ts).toISOString()}>{formatTime(message.ts, locale)}</time>
          {outgoing ? <StatusIcon status={message.status} label={statusLabel} /> : null}
        </div>

        <div className="bubble-actions">
          <button
            type="button"
            className="bubble-action"
            aria-label={t('chat.reply')}
            title={t('chat.reply')}
            onClick={() => onReply(message)}
          >
            <ReplyIcon size={13} />
          </button>
          <button
            type="button"
            className="bubble-action"
            ref={setMenuAnchor}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t('chat.messageActions')}
            title={t('chat.messageActions')}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <MoreIcon size={13} />
          </button>
        </div>

        {menuOpen ? (
          <Popover anchor={menuAnchor} onClose={() => setMenuOpen(false)} label={t('chat.messageActions')}>
            {message.body ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  void navigator.clipboard?.writeText(message.body).catch(() => undefined)
                  setMenuOpen(false)
                }}
              >
                {t('chat.copyText')}
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false)
                onDelete(message)
              }}
            >
              {t('chat.deleteLocal')}
              <span className="hint">{t('chat.deleteLocalHint')}</span>
            </button>
            {/* Only our own messages: asking a peer to delete something they
                wrote is not ours to do, and their client would refuse. */}
            {outgoing ? (
              <button
                type="button"
                role="menuitem"
                className="menuitem-danger"
                onClick={() => {
                  setMenuOpen(false)
                  onDeleteForEveryone(message)
                }}
              >
                {t('chat.deleteEveryone')}
                <span className="hint">{t('chat.deleteEveryoneHint')}</span>
              </button>
            ) : null}
          </Popover>
        ) : null}
      </div>

      {message.status === 'failed' ? (
        <div className="bubble-failed">
          <span className="danger-text small">{t('chat.failed')}</span>
          <button type="button" className="btn btn-ghost small" onClick={() => onRetry(message)}>
            {t('chat.retrySend')}
          </button>
        </div>
      ) : null}
    </div>
  )
})
