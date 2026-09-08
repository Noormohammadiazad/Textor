import { useCallback, useEffect, useRef, useState } from 'react'
import { useApp, type SendAttachmentInput } from '../../app/store'
import { useI18n } from '../../i18n'
import { canRecordVoice, VoiceRecorder } from '../../media/recorder'
import { formatDuration } from '../../media/waveform'
import { audioDuration, kindForFile, prepareImage, prepareVideoPoster } from '../../media/image'
import { MAX_RELAY_BYTES, sanitizeName, transportsFor } from '../../core/models/attachment'
import { PlusIcon, TrashIcon } from './Icons'

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

export function AttachButton({ disabled }: { disabled?: boolean }) {
  const { t } = useI18n()
  const sendAttachment = useApp((s) => s.sendAttachment)
  const toast = useApp((s) => s.toast)
  const input = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)

  const handle = useCallback(
    async (file: File) => {
      setBusy(true)
      try {
        const kind = kindForFile(file)
        const name = sanitizeName(file.name || t('attachment.file'))
        // Every attachment carries a caption, even one the user did not type.
        // A kind 14 whose content is empty renders as nothing in a client that
        // does not know our attachment tag, and NIP-17's contract is that
        // unknown tags are ignored while content is not.
        const caption = (k: 'image' | 'video' | 'voice' | 'file'): string =>
          k === 'image'
            ? t('attachment.captionImage')
            : k === 'video'
              ? t('attachment.captionVideo')
              : k === 'voice'
                ? t('attachment.captionVoice')
                : `${t('attachment.captionFile')} · ${name}`
        let payload: SendAttachmentInput

        if (kind === 'image') {
          // Re-encoding is what makes a phone photo sendable over relays at
          // all, and it drops EXIF — location and camera serial — on the way.
          const prepared = await prepareImage(file)
          payload = prepared
            ? {
                bytes: prepared.bytes,
                kind: 'image',
                mime: prepared.mime,
                caption: caption('image'),
                name,
                width: prepared.width,
                height: prepared.height,
                ...(prepared.preview ? { preview: prepared.preview } : {}),
              }
            : // An image the browser cannot decode is still a file worth sending.
              {
                bytes: new Uint8Array(await file.arrayBuffer()),
                kind: 'file',
                mime: file.type || 'application/octet-stream',
                caption: caption('file'),
                name,
              }
        } else if (kind === 'voice') {
          const durationMs = await audioDuration(file)
          payload = {
            bytes: new Uint8Array(await file.arrayBuffer()),
            kind: 'voice',
            mime: file.type || 'audio/webm',
            caption: caption('voice'),
            name,
            ...(durationMs > 0 ? { durationMs } : {}),
          }
        } else if (kind === 'video') {
          const poster = await prepareVideoPoster(file)
          payload = {
            bytes: new Uint8Array(await file.arrayBuffer()),
            kind: 'video',
            mime: file.type || 'video/mp4',
            caption: caption('video'),
            name,
            ...(poster
              ? {
                  width: poster.width,
                  height: poster.height,
                  durationMs: poster.durationMs,
                  ...(poster.preview ? { preview: poster.preview } : {}),
                }
              : {}),
          }
        } else {
          payload = {
            bytes: new Uint8Array(await file.arrayBuffer()),
            kind: 'file',
            mime: file.type || 'application/octet-stream',
            caption: caption('file'),
            name,
          }
        }

        // Check after preparation, not before: re-encoding often brings a photo
        // from unsendable to comfortably within the relay budget.
        const reach = transportsFor(payload.bytes.length)
        if (!reach.direct) {
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
    [sendAttachment, t, toast],
  )

  return (
    <>
      <button
        type="button"
        className="composer-action"
        aria-label={t('attachment.attach')}
        disabled={disabled || busy}
        onClick={() => input.current?.click()}
      >
        <PlusIcon size={18} />
      </button>
      <input
        ref={input}
        type="file"
        className="visually-hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          // Reset first, so picking the same file twice in a row still fires.
          event.target.value = ''
          if (file) void handle(file)
        }}
      />
    </>
  )
}

export function VoiceButton({ disabled }: { disabled?: boolean }) {
  const { t } = useI18n()
  const sendAttachment = useApp((s) => s.sendAttachment)
  const toast = useApp((s) => s.toast)
  const recorder = useRef<VoiceRecorder | null>(null)
  const [recording, setRecording] = useState(false)
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
    const timer = setInterval(() => setElapsed(recorder.current?.elapsedMs ?? 0), 200)
    return () => clearInterval(timer)
  }, [recording])

  const stop = useCallback(
    async (send: boolean) => {
      const active = recorder.current
      recorder.current = null
      setRecording(false)
      setElapsed(0)
      setLevel(0)
      if (!active) return
      if (!send) {
        active.cancel()
        return
      }
      const result = await active.stop()
      if (!result || result.bytes.length === 0) return
      if (result.bytes.length > MAX_RELAY_BYTES * 4) {
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
    const active = new VoiceRecorder()
    active.onLevel = setLevel
    active.onAutoStop = () => void stop(true)
    try {
      await active.start()
      recorder.current = active
      setRecording(true)
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
