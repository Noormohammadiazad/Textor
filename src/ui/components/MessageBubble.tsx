import { memo, Suspense, useState } from 'react'
import type { Message, Reaction } from '../../core/models/types'
import type { InteractiveUpdate } from '../../core/models/interactive'
import { useI18n, type TranslateFn, type TranslationKey } from '../../i18n'
import { ChecklistCard, PollCard } from '../lazyViews'
import { formatTime } from '../format'
import { AlertIcon, BoltIcon, CheckIcon, ClockIcon, DoubleCheckIcon, MoreIcon, ReplyIcon } from './Icons'
import { AttachmentView } from './AttachmentView'
import { Popover } from './Popover'
import { LazyPicker } from './LazyPicker'
import { QUICK_REACTIONS } from './quickReactions'

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

const RANK: Record<Message['status'], number> = {
  failed: 0,
  queued: 1,
  sending: 2,
  sent: 3,
  delivered: 4,
  read: 5,
}

/**
 * What a group message's tick means, per person. The icon shows the least
 * advanced member — the same rule every group messenger uses — and the label
 * says how far the rest have got, which is the question actually being asked
 * when someone hovers over it.
 */
function statusLabel(message: Message, t: TranslateFn): string {
  const receipts = message.receipts ? Object.values(message.receipts) : []
  const total = receipts.length
  const reached = (status: Message['status']) => receipts.filter((r) => RANK[r] >= RANK[status]).length
  if (total > 0 && message.status !== 'failed' && message.status !== 'read') {
    for (const [status, key] of [
      ['read', 'groups.readBy'],
      ['delivered', 'groups.deliveredTo'],
      ['sent', 'groups.sentTo'],
    ] as const) {
      const n = reached(status)
      if (n > 0 && n < total) return t(key, { n, total })
    }
  }
  return t(STATUS_LABEL[message.status])
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
  /** Everyone's reactions to this message, ours included. */
  reactions?: Reaction[]
  /** Our own key, so our reaction reads as pressed and toggles rather than adds. */
  selfPubkey: string
  onReact: (message: Message, emoji: string) => void
  onReply: (message: Message) => void
  onRetry: (message: Message) => void
  onDelete: (message: Message) => void
  onDeleteForEveryone: (message: Message) => void
  /** Announced before the first message of a run, so a screen reader knows who is speaking. */
  senderLabel: string
  /**
   * Shown above the first message of a run in a group, where side and colour
   * alone cannot say which of several people is speaking.
   */
  authorLabel?: string
  /** Votes or checklist changes on this message, when it is a poll or checklist. */
  updates?: InteractiveUpdate[]
  nameOf?: (pubkey: string) => string
  onVote?: (message: Message, choices: string[]) => void
  onCheck?: (message: Message, itemId: string, done: boolean) => void
  onAddItem?: (message: Message, label: string) => void
}

export const MessageBubble = memo(function MessageBubble({
  message,
  groupStart,
  quoted,
  reactions,
  selfPubkey,
  onReact,
  onReply,
  onRetry,
  onDelete,
  onDeleteForEveryone,
  senderLabel,
  authorLabel,
  updates,
  nameOf = (pubkey) => pubkey.slice(0, 8),
  onVote,
  onCheck,
  onAddItem,
}: MessageBubbleProps) {
  const { t, locale } = useI18n()
  const outgoing = message.direction === 'out'
  const [menuOpen, setMenuOpen] = useState(false)
  // The menu positions itself against this button, so it has to be a real node
  // rather than a ref the popover cannot measure.
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement | null>(null)
  const [reactOpen, setReactOpen] = useState(false)
  const [reactAnchor, setReactAnchor] = useState<HTMLButtonElement | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  const status = statusLabel(message, t)
  const grouped = groupReactions(reactions, selfPubkey)
  // The body of a poll or checklist is its plain-text rendering for other
  // clients. It is shown while the card's chunk loads, and never beside it.
  const body = message.body ? (
    <span className="bubble-body" dir="auto">
      {message.body}
    </span>
  ) : null
  let content = body
  if (message.poll && onVote) {
    content = (
      <Suspense fallback={body}>
        <PollCard
          poll={message.poll}
          convoId={message.convoId}
          messageId={message.id}
          updates={updates}
          selfPubkey={selfPubkey}
          nameOf={nameOf}
          onVote={(choices) => onVote(message, choices)}
        />
      </Suspense>
    )
  } else if (message.checklist && onCheck && onAddItem) {
    content = (
      <Suspense fallback={body}>
        <ChecklistCard
          checklist={message.checklist}
          convoId={message.convoId}
          messageId={message.id}
          updates={updates}
          nameOf={nameOf}
          onCheck={(itemId, done) => onCheck(message, itemId, done)}
          onAdd={(label) => onAddItem(message, label)}
        />
      </Suspense>
    )
  }

  const react = (emoji: string) => {
    setReactOpen(false)
    setPickerOpen(false)
    onReact(message, emoji)
  }

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
        {groupStart && authorLabel ? (
          <span className="bubble-author" dir="auto">
            {authorLabel}
          </span>
        ) : groupStart ? (
          <span className="visually-hidden">{senderLabel}</span>
        ) : null}

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
        {content}

        <div className="bubble-meta">
          {message.via === 'direct' ? (
            <BoltIcon size={11} role="img" aria-label={t('status.direct')} />
          ) : null}
          <time dateTime={new Date(message.ts).toISOString()}>{formatTime(message.ts, locale)}</time>
          {outgoing ? (
            <span className="tick-wrap" title={status}>
              <StatusIcon status={message.status} label={status} />
            </span>
          ) : null}
        </div>

        {grouped.length > 0 ? (
          <div className="reaction-bar" role="group" aria-label={t('emoji.reactions')}>
            {grouped.map((entry) => (
              <button
                key={entry.emoji}
                type="button"
                className={entry.mine ? 'reaction reaction-mine' : 'reaction'}
                aria-pressed={entry.mine}
                // Tapping our own reaction takes it back, which is what
                // `react` with the same emoji does.
                onClick={() => onReact(message, entry.emoji)}
              >
                {/* Not hidden from assistive technology: the character is the
                    button's accessible name, and a screen reader announces the
                    emoji's own Unicode name — better than anything invented
                    here. Hiding it left the button nameless. */}
                <span>{entry.emoji}</span>
                {entry.count > 1 ? <span className="reaction-count">{entry.count}</span> : null}
              </button>
            ))}
          </div>
        ) : null}

        <div className="bubble-actions">
          <button
            type="button"
            className="bubble-action"
            ref={setReactAnchor}
            aria-haspopup="menu"
            aria-expanded={reactOpen}
            aria-label={t('emoji.react')}
            title={t('emoji.react')}
            onClick={() => setReactOpen((open) => !open)}
          >
            <span aria-hidden="true" className="bubble-action-emoji">
              ☺
            </span>
          </button>
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

        {reactOpen ? (
          <Popover anchor={reactAnchor} onClose={() => setReactOpen(false)} label={t('emoji.react')}>
            <div className="quick-reactions">
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  role="menuitem"
                  className={
                    grouped.some((e) => e.mine && e.emoji === emoji) ? 'quick-emoji on' : 'quick-emoji'
                  }
                  onClick={() => react(emoji)}
                >
                  <span>{emoji}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setReactOpen(false)
                setPickerOpen(true)
              }}
            >
              {t('emoji.more')}
            </button>
          </Popover>
        ) : null}

        {pickerOpen ? (
          <Popover
            anchor={reactAnchor}
            onClose={() => setPickerOpen(false)}
            label={t('emoji.title')}
            className="popover-picker"
          >
            <LazyPicker mode="reaction" onPickEmoji={react} />
          </Popover>
        ) : null}

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

/**
 * Collapse reactions into one entry per emoji.
 *
 * Aggregated here rather than stored that way: the wire carries one reaction
 * per person, and counting them on render keeps the stored form the thing that
 * actually arrived.
 */
function groupReactions(
  reactions: Reaction[] | undefined,
  selfPubkey: string,
): { emoji: string; count: number; mine: boolean }[] {
  if (!reactions || reactions.length === 0) return []
  const byEmoji = new Map<string, { emoji: string; count: number; mine: boolean }>()
  for (const reaction of reactions) {
    const entry = byEmoji.get(reaction.emoji)
    if (entry) {
      entry.count += 1
      entry.mine ||= reaction.authorPubkey === selfPubkey
    } else {
      byEmoji.set(reaction.emoji, {
        emoji: reaction.emoji,
        count: 1,
        mine: reaction.authorPubkey === selfPubkey,
      })
    }
  }
  return [...byEmoji.values()]
}
