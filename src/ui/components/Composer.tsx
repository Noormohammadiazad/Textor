import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useApp } from '../../app/store'
import { useI18n, type TranslationKey } from '../../i18n'
import type { VoiceRecorder } from '../../media/recorder'
import type { AttachAs } from '../../media/attach'
import { canRecordVoice } from '../../media/voiceSupport'
import { formatDuration } from '../format'
import { MAX_VOICE_BYTES, transportsFor } from '../../core/models/attachment'
import {
  ChecklistIcon,
  FileIcon,
  ImageIcon,
  PinIcon,
  PlusIcon,
  PollIcon,
  TrashIcon,
  type IconProps,
} from './Icons'
import { Popover } from './Popover'
import { LazyPicker } from './LazyPicker'
import { Spinner } from './primitives'
import { ChecklistComposer, LAZY_CHUNKS, LocationPicker, PollComposer } from '../lazyViews'

/**
 * Attachment controls for the composer.
 *
 * Two entry points, deliberately different shapes. Files go through a normal
 * picker, because that is what every platform's own share sheet expects.
 * Voice is a press-to-arm, press-to-send control rather than hold-to-talk:
 * hold-to-talk is unusable with a keyboard, fails on a flaky touch digitiser,
 * and loses the whole recording when a finger slips.
 */

/** Microphone glyph. Local, so the icon set stays one file of one weight. */
const MicIcon = ({ size = 18 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="9" y="2.5" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3.5" />
  </svg>
)

type Choice = AttachAs | 'poll' | 'checklist' | 'location'

/** What each picker offers: "File" takes anything, and sends it as it is. */
const ACCEPT: Record<AttachAs, string | undefined> = { media: 'image/*,video/*', file: undefined }

/**
 * The "+" beside the input: bring something into the conversation that is not
 * typed — a photo or a video, a file, a poll, a checklist, or a location, in
 * Telegram's words and order (ADR-083). A menu rather than five buttons,
 * because a phone-width composer has room for one, and it is the arrangement
 * every messenger has taught people to look for.
 *
 * `own` is Saved Messages, where there is nobody to vote or follow a live
 * location, and no direct channel: a file goes only as far as the relays take it.
 */
export function AttachButton({ disabled, own }: { disabled?: boolean; own?: boolean }) {
  const { t } = useI18n()
  const sendAttachment = useApp((s) => s.sendAttachment)
  const toast = useApp((s) => s.toast)
  const pickers = useRef<Partial<Record<AttachAs, HTMLInputElement | null>>>({})
  const [busy, setBusy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [form, setForm] = useState<'poll' | 'checklist' | 'location' | null>(null)

  const handle = useCallback(
    async (file: File, as: AttachAs) => {
      setBusy(true)
      try {
        const { prepareAttachment } = await LAZY_CHUNKS.media()
        const payload = await prepareAttachment(file, as, t)
        // Checked after preparation, not before: re-encoding often brings a
        // photo from unsendable to comfortably within the relay budget.
        const reach = transportsFor(payload.bytes.length)
        if (!(own ? reach.relay : reach.direct)) {
          toast(t('attachment.tooLarge'), 'danger')
          return
        }
        await sendAttachment(payload)
      } catch {
        toast(t('errors.generic'), 'danger')
      } finally {
        setBusy(false)
      }
    },
    [own, sendAttachment, t, toast],
  )

  const choice = (next: Choice, label: TranslationKey, Glyph: (props: IconProps) => ReactNode) => (
    <button
      type="button"
      role="menuitem"
      className="menuitem-icon"
      onClick={() => {
        setMenuOpen(false)
        // Clicked straight from the menu item, inside the same user gesture,
        // which is what browsers require before they will open a file picker.
        if (next === 'media' || next === 'file') pickers.current[next]?.click()
        else setForm(next)
      }}
    >
      <Glyph size={18} />
      {t(label)}
    </button>
  )

  return (
    <>
      <button
        type="button"
        className="composer-action"
        ref={setAnchor}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={t('interactive.menu')}
        title={t('interactive.menu')}
        disabled={disabled || busy}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <PlusIcon size={18} />
      </button>
      {menuOpen ? (
        <Popover anchor={anchor} onClose={() => setMenuOpen(false)} label={t('interactive.menu')}>
          {choice('media', 'interactive.media', ImageIcon)}
          {choice('file', 'interactive.file', FileIcon)}
          {own ? null : choice('poll', 'interactive.poll', PollIcon)}
          {choice('checklist', 'interactive.checklist', ChecklistIcon)}
          {choice('location', 'interactive.location', PinIcon)}
        </Popover>
      ) : null}
      {form ? (
        <Suspense
          fallback={
            <div className="modal-backdrop" role="status">
              <Spinner label={t('interactive.loading')} />
            </div>
          }
        >
          {form === 'poll' ? (
            <PollComposer onClose={() => setForm(null)} />
          ) : form === 'checklist' ? (
            <ChecklistComposer onClose={() => setForm(null)} />
          ) : (
            <LocationPicker onClose={() => setForm(null)} still={own} />
          )}
        </Suspense>
      ) : null}
      {(['media', 'file'] as const).map((as) => (
        <input
          key={as}
          ref={(node) => {
            pickers.current[as] = node
          }}
          type="file"
          accept={ACCEPT[as]}
          className="visually-hidden"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const file = event.target.files?.[0]
            // Reset first, so picking the same file twice in a row still fires.
            event.target.value = ''
            if (file) void handle(file, as)
          }}
        />
      ))}
    </>
  )
}

/**
 * The emoji and sticker picker's toggle.
 *
 * Trailing the input rather than leading it: the attachment control opens a
 * system file picker and belongs with the other "bring something in" actions,
 * while this one edits the message being typed, so it sits at the end of the
 * field next to send — where every mainstream messenger puts it, and where a
 * thumb already is. Mirrored automatically in Persian, because the composer is
 * a flex row and "trailing" follows the writing direction.
 */
export function EmojiButton({
  disabled,
  onInsertEmoji,
}: {
  disabled?: boolean
  /** Puts the chosen emoji into the message being typed. */
  onInsertEmoji: (emoji: string) => void
}) {
  const { t } = useI18n()
  const sendSticker = useApp((s) => s.sendSticker)
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)

  return (
    <>
      <button
        type="button"
        className="composer-action"
        ref={setAnchor}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('emoji.title')}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true" className="composer-emoji">
          ☺
        </span>
      </button>
      {open ? (
        <Popover
          anchor={anchor}
          onClose={() => setOpen(false)}
          label={t('emoji.title')}
          className="popover-picker"
        >
          <LazyPicker
            mode="compose"
            onPickEmoji={(emoji) => {
              setOpen(false)
              onInsertEmoji(emoji)
            }}
            onPickSticker={(sticker) => {
              setOpen(false)
              void sendSticker(sticker)
            }}
          />
        </Popover>
      ) : null}
    </>
  )
}

export function VoiceButton({ disabled }: { disabled?: boolean }) {
  const { t } = useI18n()
  const sendAttachment = useApp((s) => s.sendAttachment)
  const toast = useApp((s) => s.toast)
  const recorder = useRef<VoiceRecorder | null>(null)
  // The recorder while one runs, for the screen; the ref is for the callbacks.
  const [recording, setRecording] = useState<VoiceRecorder | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)

  // A live recording must not survive the component: leaving the microphone
  // open after a navigation is the worst bug this control can have.
  useEffect(
    () => () => {
      recorder.current?.cancel()
      recorder.current = null
    },
    [],
  )

  useEffect(() => {
    if (!recording) return
    const timer = setInterval(() => setElapsed(recording.elapsedMs), 200)
    return () => clearInterval(timer)
  }, [recording])

  const stop = useCallback(
    async (send: boolean) => {
      const active = recorder.current
      recorder.current = null
      setRecording(null)
      setElapsed(0)
      setLevel(0)
      if (!active) return
      if (!send) {
        active.cancel()
        return
      }
      const result = await active.stop()
      if (!result || result.bytes.length === 0) return
      if (result.bytes.length > MAX_VOICE_BYTES) {
        toast(t('attachment.tooLarge'), 'danger')
        return
      }
      await sendAttachment({
        bytes: result.bytes,
        kind: 'voice',
        mime: result.mime,
        // A caption so other Nostr clients show something rather than an empty
        // bubble; NIP-17 says unknown tags are ignored but content is not.
        caption: `${t('attachment.captionVoice')} · ${formatDuration(result.durationMs)}`,
        durationMs: result.durationMs,
        waveform: result.waveform,
      })
    },
    [sendAttachment, t, toast],
  )

  const start = useCallback(async () => {
    let media: Awaited<ReturnType<typeof LAZY_CHUNKS.media>>
    try {
      media = await LAZY_CHUNKS.media()
    } catch {
      toast(t('errors.generic'), 'danger')
      return
    }
    const active = new media.VoiceRecorder()
    active.onLevel = setLevel
    active.onAutoStop = () => void stop(true)
    try {
      await active.start()
      recorder.current = active
      setRecording(active)
    } catch {
      active.cancel()
      toast(t('attachment.micDenied'), 'danger')
    }
  }, [stop, t, toast])

  if (!canRecordVoice()) return null

  if (recording) {
    return (
      <div className="recording-bar" role="group" aria-label={t('attachment.recording')}>
        <button
          type="button"
          className="composer-action"
          aria-label={t('attachment.recordCancel')}
          onClick={() => void stop(false)}
        >
          <TrashIcon size={17} />
        </button>
        <span className="recording-dot" aria-hidden="true" />
        <span className="recording-time tabular">{formatDuration(elapsed)}</span>
        {/* A live level meter, so it is obvious the microphone is actually
            picking something up before a minute is wasted. */}
        <span className="recording-meter" aria-hidden="true">
          <span style={{ transform: `scaleX(${Math.max(0.03, level)})` }} />
        </span>
        <button
          type="button"
          className="composer-send"
          aria-label={t('attachment.recordStop')}
          onClick={() => void stop(true)}
        >
          <MicIcon size={18} />
        </button>
      </div>
    )
  }

  return (
    <button
      type="button"
      className="composer-action"
      aria-label={t('attachment.recordStart')}
      disabled={disabled}
      onClick={() => void start()}
    >
      <MicIcon size={18} />
    </button>
  )
}
