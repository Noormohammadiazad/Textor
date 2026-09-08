import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from '../../app/store'
import { useI18n } from '../../i18n'
import { formatDuration } from '../../media/waveform'
import type { Attachment } from '../../core/models/attachment'
import { DownloadIcon, AlertIcon } from './Icons'

/**
 * Renders the payload attached to a message.
 *
 * Every variant has to work in three states, because on the relay path a
 * payload routinely arrives seconds or minutes after the message that
 * describes it:
 *
 *   arriving   the descriptor is known, the bytes are not — render name, size,
 *              duration, waveform, blurred preview, and a progress bar
 *   ready      decrypt from storage and play or show it
 *   failed     say so, and leave the message readable
 *
 * The "arriving" state is the point of the descriptor. A messenger that shows a
 * grey box until a file finishes has made the wait feel broken rather than slow.
 */

function useAttachmentUrl(attachment: Attachment): { url: string | null; failed: boolean } {
  const openAttachment = useApp((s) => s.openAttachment)
  const progress = useApp((s) => s.blobProgress.get(attachment.id))
  const [state, setState] = useState<{ url: string | null; failed: boolean }>({
    url: null,
    failed: false,
  })

  // `pending` is a dependency so the payload is re-read the moment a transfer
  // finishes, without polling.
  const pending = progress !== undefined
  useEffect(() => {
    if (pending) return
    let live = true
    void openAttachment(attachment)
      // A null result is "not all here yet", not "broken": the transfer may
      // still be in flight, and the resend path is actively chasing it.
      .then((url) => {
        if (live) setState({ url, failed: false })
      })
      // A rejection is the other case — the bytes are here and will not open.
      .catch(() => {
        if (live) setState({ url: null, failed: true })
      })
    return () => {
      live = false
    }
  }, [attachment, openAttachment, pending])

  // Failure is derived rather than stored, so it can never latch: while chunks
  // are still arriving the payload is legitimately unreadable, and a bubble
  // stuck on an error after the bytes land is worse than one that waits.
  return { url: state.url, failed: !pending && state.failed }
}

const formatBytes = (bytes: number, locale: string): string => {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const rounded = unit === 0 ? value : Number(value.toFixed(value < 10 ? 1 : 0))
  return `${rounded.toLocaleString(locale)} ${units[unit]}`
}

function TransferBar({ attachment }: { attachment: Attachment }) {
  const { t } = useI18n()
  const progress = useApp((s) => s.blobProgress.get(attachment.id))
  if (!progress) return null
  const fraction = progress.total === 0 ? 0 : progress.received / progress.total
  return (
    <div className="attachment-progress" role="progressbar" aria-label={t('attachment.transferring')}>
      <div className="progress">
        <div style={{ width: `${Math.round(fraction * 100)}%` }} />
      </div>
    </div>
  )
}

/**
 * Voice note.
 *
 * The waveform is the control: it is drawn from the bars carried in the
 * descriptor, fills as the audio plays, and is clickable to seek. That is worth
 * more than a scrubber, because the shape tells you where the speech is.
 */
function VoiceNote({ attachment }: { attachment: Attachment }) {
  const { t, locale } = useI18n()
  const { url, failed } = useAttachmentUrl(attachment)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  // A payload can arrive intact and still be undecodable here: MediaRecorder
  // output is browser-specific, and Safari will not play WebM/Opus however
  // well it transferred. Saying so beats a play button that does nothing.
  const [undecodable, setUndecodable] = useState(false)

  // The descriptor's duration is what lets the bubble show a length before the
  // audio has transferred, but it is the sender's stopwatch, not the file's.
  // Once the element knows better, believe it — and an attached audio file may
  // carry no duration at all, in which case this is the only source.
  const [measured, setMeasured] = useState(0)
  const total = measured > 0 ? measured : (attachment.durationMs ?? 0)
  const bars = attachment.waveform ?? []
  const fraction = total > 0 ? Math.min(1, elapsed / total) : 0

  const toggle = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) void audio.play().catch(() => setPlaying(false))
    else audio.pause()
  }, [])

  const seekTo = useCallback((ratio: number) => {
    const audio = audioRef.current
    if (!audio || !Number.isFinite(audio.duration)) return
    audio.currentTime = audio.duration * Math.min(1, Math.max(0, ratio))
  }, [])

  if (failed) return <AttachmentError />
  if (undecodable) return <AttachmentError message={t('attachment.unplayable')} />

  return (
    <div className="voice-note">
      <button
        type="button"
        className="voice-play"
        onClick={toggle}
        disabled={!url}
        aria-label={playing ? t('attachment.pause') : t('attachment.play')}
      >
        {playing ? <PauseGlyph /> : <PlayGlyph />}
      </button>

      {/*
        A slider rather than a div: seeking a voice note with the keyboard is
        the only way to do it without a pointer, and arrow keys come free.
      */}
      <div
        className="voice-wave"
        role="slider"
        tabIndex={url ? 0 : -1}
        aria-label={t('attachment.seek')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
        aria-valuetext={formatDuration(elapsed)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowUp') seekTo(fraction + 0.05)
          else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') seekTo(fraction - 0.05)
          else if (event.key === 'Home') seekTo(0)
          else if (event.key === 'End') seekTo(1)
          else return
          event.preventDefault()
        }}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          // Mirror the hit test in a right-to-left layout, where the start of
          // the track is on the right.
          const rtl = getComputedStyle(event.currentTarget).direction === 'rtl'
          const offset = event.clientX - box.left
          seekTo(rtl ? 1 - offset / box.width : offset / box.width)
        }}
      >
        {bars.length > 0 ? (
          bars.map((bar, index) => (
            <span
              key={index}
              className="voice-bar"
              data-played={index / bars.length <= fraction ? 'true' : 'false'}
              style={{ height: `${Math.max(8, bar)}%` }}
            />
          ))
        ) : (
          <span className="voice-bar-fallback" />
        )}
      </div>

      <span className="voice-time tabular">{formatDuration(playing || elapsed > 0 ? elapsed : total)}</span>

      {url ? (
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false)
            setElapsed(0)
          }}
          onTimeUpdate={(event) => setElapsed(event.currentTarget.currentTime * 1000)}
          onLoadedMetadata={(event) => {
            const seconds = event.currentTarget.duration
            // MediaRecorder output often reports Infinity until it has been
            // played through, so only take a real number.
            if (Number.isFinite(seconds) && seconds > 0) setMeasured(seconds * 1000)
          }}
          onError={() => setUndecodable(true)}
        />
      ) : null}

      <span className="visually-hidden">{formatBytes(attachment.size, locale)}</span>
      <TransferBar attachment={attachment} />
    </div>
  )
}

const PlayGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M8 5.5v13l11-6.5z" />
  </svg>
)

const PauseGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
  </svg>
)

function AttachmentError({ message }: { message?: string }) {
  const { t } = useI18n()
  return (
    <div className="attachment-error">
      <AlertIcon size={15} />
      <span>{message ?? t('attachment.unavailable')}</span>
    </div>
  )
}

/**
 * Picture.
 *
 * The blurred inline preview is shown first at the real aspect ratio, so the
 * bubble is already the right size and the conversation does not jump when the
 * full image lands.
 */
function ImageAttachment({ attachment }: { attachment: Attachment }) {
  const { t } = useI18n()
  const { url, failed } = useAttachmentUrl(attachment)
  const [expanded, setExpanded] = useState(false)

  if (failed) return <AttachmentError />

  const ratio = attachment.width && attachment.height ? `${attachment.width} / ${attachment.height}` : '4 / 3'

  return (
    <>
      <button
        type="button"
        className="attachment-image"
        style={{ aspectRatio: ratio }}
        onClick={() => url && setExpanded(true)}
        disabled={!url}
        aria-label={t('attachment.openImage')}
      >
        {attachment.preview ? (
          <img className="attachment-preview" src={attachment.preview} alt="" aria-hidden="true" />
        ) : null}
        {url ? <img className="attachment-full" src={url} alt={attachment.name ?? ''} /> : null}
        <TransferBar attachment={attachment} />
      </button>

      {expanded && url ? (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={t('attachment.openImage')}
          onClick={() => setExpanded(false)}
          onKeyDown={(event) => event.key === 'Escape' && setExpanded(false)}
          tabIndex={-1}
          ref={(node) => node?.focus()}
        >
          <img src={url} alt={attachment.name ?? ''} />
        </div>
      ) : null}
    </>
  )
}

function VideoAttachment({ attachment }: { attachment: Attachment }) {
  const { url, failed } = useAttachmentUrl(attachment)
  if (failed) return <AttachmentError />
  const ratio =
    attachment.width && attachment.height ? `${attachment.width} / ${attachment.height}` : '16 / 9'
  return (
    <div className="attachment-image" style={{ aspectRatio: ratio }}>
      {attachment.preview && !url ? (
        <img className="attachment-preview" src={attachment.preview} alt="" aria-hidden="true" />
      ) : null}
      {url ? <video className="attachment-full" src={url} controls playsInline preload="metadata" /> : null}
      <TransferBar attachment={attachment} />
    </div>
  )
}

/**
 * Anything else.
 *
 * The download is an object URL of bytes already decrypted in this tab, so it
 * never touches the network — which is also why it works offline.
 */
function FileAttachment({ attachment }: { attachment: Attachment }) {
  const { t, locale } = useI18n()
  const { url, failed } = useAttachmentUrl(attachment)
  if (failed) return <AttachmentError />

  const name = attachment.name ?? t('attachment.file')
  return (
    <div className="attachment-file">
      <span className="attachment-file-icon" aria-hidden="true">
        <DownloadIcon size={16} />
      </span>
      <span className="attachment-file-meta">
        {/* The name is peer-supplied: isolate it so its own directionality
            cannot reorder the size that follows. */}
        <bdi className="attachment-file-name truncate">{name}</bdi>
        <span className="faint">{formatBytes(attachment.size, locale)}</span>
      </span>
      {url ? (
        <a className="btn btn-outline small" href={url} download={name}>
          {t('attachment.save')}
        </a>
      ) : (
        <span className="faint small">{t('attachment.transferring')}</span>
      )}
      <TransferBar attachment={attachment} />
    </div>
  )
}

export const AttachmentView = memo(function AttachmentView({ attachment }: { attachment: Attachment }) {
  switch (attachment.kind) {
    case 'voice':
      return <VoiceNote attachment={attachment} />
    case 'image':
      return <ImageAttachment attachment={attachment} />
    case 'video':
      return <VideoAttachment attachment={attachment} />
    case 'file':
      return <FileAttachment attachment={attachment} />
  }
})
