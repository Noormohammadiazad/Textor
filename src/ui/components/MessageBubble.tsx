import { memo, Suspense, useState, type ReactNode } from 'react'
import type { Message, Reaction } from '../../core/models/types'
import type { InteractiveUpdate } from '../../core/models/interactive'
import { useI18n, type TranslateFn, type TranslationKey } from '../../i18n'
import { ChecklistCard, LocationCard, PollCard } from '../lazyViews'
import { formatTime } from '../format'
import { AlertIcon, BoltIcon, CheckIcon, ClockIcon, DoubleCheckIcon, MoreIcon, ReplyIcon } from './Icons'
import { EntryRow, MenuItem, type EntryProps } from './EntryRow'
import { AttachmentView } from './AttachmentView'
import { Popover } from './Popover'
import { LazyPicker } from './LazyPicker'
import { QUICK_REACTIONS } from './quickReactions'
import { usePress } from './hold'

/**
 * Delivery state, rendered the way Telegram's readers already read it
 * (ADR-061):
 *   clock  -> waiting to leave this device
 *   tick   -> on its way: a relay accepted it, or their device has it
 *   double -> they opened the conversation and read it
 *
 * Only reading earns the second tick. "Delivered" is a fact about a device,
 * not about a person, and a second tick for it taught people to read two ticks
 * as "seen" when nobody had looked. It is in the message's details instead,
 * with when.
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
    case 'delivered':
      return <CheckIcon {...shared} />
    case 'read':
      return <DoubleCheckIcon {...shared} className="tick tick-read" />
    case 'failed':
      return <AlertIcon {...shared} />
  }
}

export interface MessageBubbleProps extends EntryProps {
  message: Message
  quoted?: Message | null
  /** Everyone's reactions to this message, ours included. */
  reactions?: Reaction[]
  /** Our own key, so our reaction reads as pressed and toggles rather than adds. */
  selfPubkey: string
  onReact: (message: Message, emoji: string) => void
  onReply: (message: Message) => void
  onRetry: (message: Message) => void
  /** Sending a copy elsewhere; absent where there is nothing to copy. */
  onForward?: (message: Message) => void
  /** When it was delivered and read; for what we sent. */
  onInfo?: (message: Message) => void
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
  groupEnd,
  selecting,
  selected,
  onSelect,
  quoted,
  reactions,
  selfPubkey,
  onReact,
  onReply,
  onRetry,
  onDelete,
  onForward,
  onInfo,
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
  // Each panel is kept as the element it hangs from — a button beside the
  // bubble, or the bubble itself when a finger held it — and null while it is
  // closed. A real node rather than a ref, because the popover measures it.
  const [menuAt, setMenuAt] = useState<HTMLElement | null>(null)
  const [reactAt, setReactAt] = useState<HTMLElement | null>(null)
  const [pickerAt, setPickerAt] = useState<HTMLElement | null>(null)
  const press = usePress({ hold: () => onSelect(message), menu: setMenuAt })

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
  } else if (message.location) {
    content = (
      <Suspense fallback={body}>
        <LocationCard message={message} />
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
    setReactAt(null)
    setPickerAt(null)
    setMenuAt(null)
    onReact(message, emoji)
  }
  const quick = (
    <div className="quick-reactions">
      {QUICK_REACTIONS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          role="menuitem"
          className={grouped.some((e) => e.mine && e.emoji === emoji) ? 'quick-emoji on' : 'quick-emoji'}
          onClick={() => react(emoji)}
        >
          <span>{emoji}</span>
        </button>
      ))}
    </div>
  )

  const act = (run: () => void) => () => {
    setMenuAt(null)
    run()
  }
  const item = (label: ReactNode, run: () => void, danger?: boolean) => (
    <MenuItem onClick={act(run)} danger={danger}>
      {label}
    </MenuItem>
  )

  return (
    <EntryRow
      message={message}
      groupStart={groupStart}
      groupEnd={groupEnd}
      selecting={selecting}
      selected={selected}
      onSelect={onSelect}
      afterHold={press.afterHold}
      failed={message.status === 'failed'}
    >
      <div className="bubble" {...press.handlers}>
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
            aria-haspopup="menu"
            aria-expanded={reactAt !== null}
            aria-label={t('emoji.react')}
            title={t('emoji.react')}
            onClick={(event) => setReactAt(reactAt ? null : event.currentTarget)}
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
            aria-haspopup="menu"
            aria-expanded={menuAt !== null}
            aria-label={t('chat.messageActions')}
            title={t('chat.messageActions')}
            onClick={(event) => setMenuAt(menuAt ? null : event.currentTarget)}
          >
            <MoreIcon size={13} />
          </button>
        </div>

        {reactAt ? (
          <Popover anchor={reactAt} onClose={() => setReactAt(null)} label={t('emoji.react')}>
            {quick}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setReactAt(null)
                setPickerAt(reactAt)
              }}
            >
              {t('emoji.more')}
            </button>
          </Popover>
        ) : null}

        {pickerAt ? (
          <Popover
            anchor={pickerAt}
            onClose={() => setPickerAt(null)}
            label={t('emoji.title')}
            className="popover-picker"
          >
            <LazyPicker mode="reaction" onPickEmoji={react} />
          </Popover>
        ) : null}

        {/* Everything that can be done to a message, reactions first, in
            Telegram's order: what a tap opens on a touch screen, where the
            buttons beside the bubble are out of reach. */}
        {menuAt ? (
          <Popover anchor={menuAt} onClose={() => setMenuAt(null)} label={t('chat.messageActions')}>
            {quick}
            {item(t('emoji.more'), () => setPickerAt(menuAt))}
            {item(t('chat.reply'), () => onReply(message))}
            {message.body
              ? item(t('chat.copyText'), () => {
                  void navigator.clipboard?.writeText(message.body).catch(() => undefined)
                })
              : null}
            {onForward ? item(t('chat.forward'), () => onForward(message)) : null}
            {item(t('chat.select'), () => onSelect(message))}
            {onInfo ? item(t('chat.info'), () => onInfo(message)) : null}
            {item(t('chat.delete'), () => onDelete(message), true)}
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
    </EntryRow>
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
