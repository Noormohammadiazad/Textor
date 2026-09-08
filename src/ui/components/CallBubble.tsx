import { memo, useState } from 'react'
import type { Message } from '../../core/models/types'
import type { CallRecord } from '../../core/models/call'
import { useI18n, type TranslateFn } from '../../i18n'
import { formatCallDuration, formatTime } from '../format'
import { CallInIcon, CallOutIcon, MoreIcon, PhoneIcon, VideoIcon } from './Icons'
import { Popover } from './Popover'
import { usePress } from './hold'
import { EntryRow, MenuItem, type EntryProps } from './EntryRow'

export type CallEntry = Message & { call: CallRecord }

type CallLike = Pick<Message, 'direction'> & { call: CallRecord }

/** What the call was: "Outgoing voice call", "Missed video call". */
export function callTitle(message: CallLike, t: TranslateFn): string {
  const video = message.call.media === 'video'
  if (message.call.outcome === 'missed') return t(video ? 'calls.missedVideo' : 'calls.missedVoice')
  return message.direction === 'in'
    ? t(video ? 'calls.incomingVideo' : 'calls.incomingVoice')
    : t(video ? 'calls.outgoingVideo' : 'calls.outgoingVoice')
}

/**
 * How it went, when there is more to say than the title: how long a call
 * lasted, or why one never started — "4:12", "No answer", "Declined". A missed
 * call's title already says everything, and a call that connected for less
 * than a second has no length worth reading.
 */
export function callOutcome(message: CallLike, t: TranslateFn): string | null {
  const { call } = message
  if (call.outcome === 'missed') return null
  if (call.outcome === 'completed') {
    // Isolated, so a clock keeps its digits in order inside Persian text.
    return call.durationMs !== undefined && call.durationMs >= 1000
      ? `\u2068${formatCallDuration(call.durationMs)}\u2069`
      : null
  }
  return t(`calls.${call.outcome}`)
}

/**
 * How a call reads as one line, in the chat list: "Missed video call",
 * "Outgoing voice call · 4:12", "Incoming voice call · Declined".
 */
export function callSummary(message: CallLike, t: TranslateFn): string {
  const title = callTitle(message, t)
  const outcome = callOutcome(message, t)
  return outcome ? `${title} · ${outcome}` : title
}

export interface CallBubbleProps extends EntryProps {
  message: CallEntry
  /** Absent when this person cannot be called from here. */
  onCallBack?: (media: CallRecord['media']) => void
}

/**
 * A call, as a bubble on the side of whoever placed it — the way people are
 * used to seeing one, and the way to act on it like any other entry.
 *
 * Written by this device alone and never sent, so it carries no delivery
 * ticks, reactions or reply action. What is left is calling back, and taking
 * it out of the conversation: here, or for both people. Either of them may do
 * the second, because a call has no author (ADR-047).
 */
export const CallBubble = memo(function CallBubble({
  message,
  groupStart,
  groupEnd,
  selecting,
  selected,
  onSelect,
  onCallBack,
  onDelete,
}: CallBubbleProps) {
  const { t, locale } = useI18n()
  // The element the menu hangs from — its button, or the held bubble — or null.
  const [menuAt, setMenuAt] = useState<HTMLElement | null>(null)
  const press = usePress({ hold: () => onSelect(message), menu: setMenuAt })
  const { call } = message
  const outgoing = message.direction === 'out'
  const Arrow = outgoing ? CallOutIcon : CallInIcon
  const Glyph = call.media === 'video' ? VideoIcon : PhoneIcon
  const outcome = callOutcome(message, t)
  const titleId = `call-title-${message.id}`

  const act = (run: () => void) => () => {
    setMenuAt(null)
    run()
  }

  return (
    <EntryRow
      message={message}
      groupStart={groupStart}
      groupEnd={groupEnd}
      selecting={selecting}
      selected={selected}
      onSelect={onSelect}
      afterHold={press.afterHold}
    >
      <div
        className="bubble call-bubble"
        data-outcome={call.outcome === 'completed' ? 'connected' : 'not-connected'}
        data-missed={call.outcome === 'missed' || undefined}
        {...press.handlers}
      >
        <div className="call-bubble-text">
          <span className="call-bubble-title" id={titleId}>
            {callTitle(message, t)}
          </span>
          <span className="call-bubble-detail">
            <Arrow size={14} className="call-bubble-arrow" />
            <time dateTime={new Date(message.ts).toISOString()}>{formatTime(message.ts, locale)}</time>
            {outcome ? (
              <>
                <span aria-hidden="true">·</span>
                {/* Two clocks side by side: say which one is the length. */}
                {call.outcome === 'completed' ? (
                  <span className="visually-hidden">{t('calls.duration')}</span>
                ) : null}
                <span>{outcome}</span>
              </>
            ) : null}
          </span>
        </div>

        {onCallBack ? (
          <button
            type="button"
            className="call-bubble-back"
            aria-label={t('calls.callBack')}
            aria-describedby={titleId}
            title={t('calls.callBack')}
            onClick={() => onCallBack(call.media)}
          >
            <Glyph size={18} />
          </button>
        ) : (
          <span className="call-bubble-back" aria-hidden="true">
            <Glyph size={18} />
          </span>
        )}

        <div className="bubble-actions">
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

        {menuAt ? (
          <Popover anchor={menuAt} onClose={() => setMenuAt(null)} label={t('chat.messageActions')}>
            <MenuItem onClick={act(() => onSelect(message))}>{t('chat.select')}</MenuItem>
            <MenuItem onClick={act(() => onDelete(message))} danger>
              {t('chat.delete')}
            </MenuItem>
          </Popover>
        ) : null}
      </div>
    </EntryRow>
  )
})

export const isCallEntry = (message: Message): message is CallEntry => !!message.call
