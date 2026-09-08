import { useEffect, useRef, useState } from 'react'
import { isCallLive, useApp } from '../../app/store'
import { navigate } from '../../app/router'
import { Avatar } from '../components/primitives'
import { LockIcon, PhoneIcon, RadioIcon, VideoIcon } from '../components/Icons'
import { displayName } from '../screens/ChatList'
import { formatCallDuration } from '../format'
import { isStickyEnd, type CallControl, type CallView } from '../../core/calls/callManager'
import type { IceDiagnosisKind } from '../../core/calls/diagnose'
import type { CallMedia } from '../../core/models/call'
import type { VoiceView } from '../../core/calls/relayVoice'
import { useCallText, type CallTextFn, type CallTextKey } from './strings'
import {
  FlipCameraIcon,
  HangUpIcon,
  MicIcon,
  MicOffIcon,
  MinimizeIcon,
  ScreenShareIcon,
  VideoOffIcon,
} from './icons'
import { playRingback, playRingtone } from './tones'
import './calls.css'

/**
 * Everything a call puts on screen: the incoming-call prompt, the call
 * itself, the bar it shrinks to while you read a conversation, and the way it
 * ended. Mounted at the top of the app only while there is a call, from the
 * call chunk (ADR-046).
 */
export function CallOverlay() {
  const call = useApp((s) => s.call)
  if (!call) return null
  // A new call starts expanded, whatever the last one was left as.
  return <CallLayer key={`${call.peer}:${call.startedAt}`} call={call} />
}

function CallLayer({ call }: { call: CallView }) {
  const control = useApp((s) => s.callControl)
  const contact = useApp((s) => s.contacts.get(call.peer))
  const ct = useCallText()
  const name = displayName(contact, call.peer)
  const [minimized, setMinimized] = useState(false)

  useCallSounds(call.phase)
  useIncomingNotification(call, name, ct)
  useWakeLock(call)

  const live = isCallLive(call)
  const expanded =
    !minimized ||
    call.phase === 'incoming' ||
    (call.phase === 'ended' && !!call.ended && isStickyEnd(call.ended.kind))
  const root = useRef<HTMLDivElement>(null)
  useInertBehind(root, expanded)

  useEffect(() => {
    if (!expanded || !live) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMinimized(true)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [expanded, live])

  return (
    <div ref={root} className="call-root">
      {/* Always mounted, so minimising the call never interrupts what you hear. */}
      <MediaElement kind="audio" stream={call.remote.stream} />
      {call.phase === 'incoming' ? (
        <IncomingCall call={call} name={name} avatar={contact?.avatar} ct={ct} control={control} />
      ) : expanded ? (
        <CallScreen
          call={call}
          name={name}
          avatar={contact?.avatar}
          ct={ct}
          control={control}
          onMinimize={live ? () => setMinimized(true) : undefined}
        />
      ) : (
        <button className="call-bar" onClick={() => setMinimized(false)}>
          <span className="call-bar-dot" aria-hidden="true" />
          <bdi className="call-bar-name">{name}</bdi>
          <span className="call-bar-status">
            <CallStatus call={call} name={name} ct={ct} />
          </span>
          <span className="call-bar-hint">{ct('expand')}</span>
        </button>
      )}
    </div>
  )
}

/**
 * While the call covers the app, the app behind it is out of reach: not
 * focusable, not clickable, not read out. Without this, Tab walks out of the
 * call into a conversation nobody can see.
 */
function useInertBehind(root: React.RefObject<HTMLDivElement | null>, covering: boolean): void {
  useEffect(() => {
    const own = root.current
    const parent = own?.parentElement
    if (!covering || !parent) return
    const behind = [...parent.children].filter(
      (element): element is HTMLElement =>
        element !== own && element instanceof HTMLElement && !element.inert,
    )
    for (const element of behind) element.inert = true
    return () => {
      for (const element of behind) element.inert = false
    }
  }, [root, covering])
}

// --- incoming ---------------------------------------------------------------------

function IncomingCall({
  call,
  name,
  avatar,
  ct,
  control,
}: {
  call: CallView
  name: string
  avatar?: string
  ct: CallTextFn
  control: (action: CallControl) => void
}) {
  const accept = useRef<HTMLButtonElement>(null)
  useEffect(() => accept.current?.focus(), [])
  const video = call.media === 'video'
  const Glyph = MEDIA_ICON[call.media]
  return (
    <div className="call-incoming-backdrop">
      <div
        className="call-incoming"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="call-incoming-name"
        aria-describedby="call-incoming-kind"
      >
        <Avatar name={name} seed={call.peer} src={avatar} size="lg" />
        <bdi id="call-incoming-name" className="call-incoming-name">
          {name}
        </bdi>
        <span id="call-incoming-kind" className="call-incoming-kind">
          <Glyph size={15} />
          {ct(INCOMING[call.media])}
        </span>
        <div className="call-incoming-actions">
          <CallButton
            label={ct('decline')}
            tone="danger"
            showLabel
            onClick={() => control({ type: 'decline' })}
            icon={<HangUpIcon size={24} />}
          />
          <CallButton
            ref={accept}
            label={ct('accept')}
            tone="accept"
            showLabel
            onClick={() => control({ type: 'accept' })}
            icon={<Glyph size={24} />}
          />
        </div>
        {video ? (
          <button className="btn btn-ghost small" onClick={() => control({ type: 'accept', media: 'audio' })}>
            {ct('acceptVoice')}
          </button>
        ) : null}
      </div>
    </div>
  )
}

// --- the call ---------------------------------------------------------------------

function CallScreen({
  call,
  name,
  avatar,
  ct,
  control,
  onMinimize,
}: {
  call: CallView
  name: string
  avatar?: string
  ct: CallTextFn
  control: (action: CallControl) => void
  onMinimize?: () => void
}) {
  const primary = useRef<HTMLButtonElement>(null)
  useEffect(() => primary.current?.focus(), [])
  const { local, remote } = call
  const ended = call.phase === 'ended'
  const answered = call.phase === 'connected' || call.phase === 'reconnecting'
  const showRemote = answered && remote.video && !!remote.stream
  const showLocal = !ended && !!local.stream
  // Only the front camera is mirrored: that is how people expect to see
  // themselves. A screen or a back camera shows the world as it is.
  const mirrored = local.camera && !local.screen && local.facing === 'user'

  return (
    <div className="call-screen" role="dialog" aria-modal="true" aria-label={ct('callWith', { name })}>
      <div className="call-stage">
        {showRemote ? (
          <MediaElement
            kind="video"
            stream={remote.stream}
            className="call-remote-video"
            fit={remote.screen ? 'contain' : 'cover'}
          />
        ) : null}
        {showLocal ? (
          <MediaElement
            kind="video"
            stream={local.stream}
            className={answered ? 'call-self-view' : 'call-self-full'}
            mirrored={mirrored}
          />
        ) : null}
        {!showRemote ? (
          <div className="call-identity">
            <Avatar name={name} seed={call.peer} src={avatar} size="lg" />
            {answered && call.media === 'video' && !remote.video ? (
              <span className="call-chip">
                <VideoOffIcon size={14} />
                {ct('cameraIsOff')}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="call-top">
        {onMinimize ? (
          <button
            className="call-icon-button"
            aria-label={ct('minimize')}
            title={ct('minimize')}
            onClick={onMinimize}
          >
            <MinimizeIcon size={18} />
          </button>
        ) : null}
        <div className="call-heading">
          <bdi className="call-name">{name}</bdi>
          <span className="call-status" aria-live="polite">
            <CallStatus call={call} name={name} ct={ct} />
          </span>
        </div>
        {answered ? (
          <span
            className="call-chip call-path"
            title={ct(call.path === 'relay' ? 'relayedHint' : 'directHint')}
          >
            <LockIcon size={13} />
            <span className="visually-hidden">{ct('encrypted')} · </span>
            {call.path ? ct(call.path === 'relay' ? 'relayed' : 'direct') : ct('encrypted')}
          </span>
        ) : null}
      </div>

      <div className="call-notices" aria-live="polite">
        {call.notReached && call.phase === 'outgoing' ? (
          <p className="call-note">{ct('notReached', { name })}</p>
        ) : null}
        {answered && !remote.audio ? (
          <span className="call-chip">
            <MicOffIcon size={14} />
            {ct('theyMuted', { name })}
          </span>
        ) : null}
        {answered && remote.screen ? <span className="call-chip">{ct('theyShare', { name })}</span> : null}
        {local.screen && !ended ? (
          <span className="call-chip">
            <ScreenShareIcon size={14} />
            {ct('sharing')}
          </span>
        ) : null}
        {call.notice ? (
          <span className="call-chip call-chip-warning">
            {ct(call.notice === 'camera-unavailable' ? 'cameraUnavailable' : 'screenFailed')}
          </span>
        ) : null}
      </div>

      {ended ? (
        <CallEnding call={call} name={name} ct={ct} control={control} primary={primary} />
      ) : call.media === 'radio' ? (
        // A walkie-talkie: talk once it is on, and hang up at any point.
        <div className="call-ending call-radio">
          {call.voice && call.phase === 'connected' ? (
            <RelayVoicePanel voice={call.voice} name={name} ct={ct} control={control} />
          ) : (
            <CallButton
              ref={primary}
              label={ct('hangUp')}
              tone="danger"
              onClick={() => control({ type: 'hangup' })}
              icon={<HangUpIcon size={24} />}
            />
          )}
        </div>
      ) : (
        <div className="call-controls">
          <CallButton
            label={ct(local.muted ? 'unmute' : 'mute')}
            pressed={local.muted}
            onClick={() => control({ type: 'mute', muted: !local.muted })}
            icon={local.muted ? <MicOffIcon size={22} /> : <MicIcon size={22} />}
          />
          <CallButton
            label={ct(local.camera ? 'cameraOff' : 'cameraOn')}
            pressed={!local.camera}
            onClick={() => control({ type: 'camera', on: !local.camera })}
            icon={local.camera ? <VideoIcon size={22} /> : <VideoOffIcon size={22} />}
          />
          {local.camera && local.canFlip ? (
            <CallButton
              label={ct('flip')}
              onClick={() => control({ type: 'flip' })}
              icon={<FlipCameraIcon size={22} />}
            />
          ) : null}
          {local.canShare ? (
            <CallButton
              label={ct(local.screen ? 'stopShare' : 'share')}
              pressed={local.screen}
              onClick={() => control({ type: 'screen', on: !local.screen })}
              icon={<ScreenShareIcon size={22} />}
            />
          ) : null}
          <CallButton
            ref={primary}
            label={ct('hangUp')}
            tone="danger"
            onClick={() => control({ type: 'hangup' })}
            icon={<HangUpIcon size={24} />}
          />
        </div>
      )}
    </div>
  )
}

const DIAGNOSIS: Record<IceDiagnosisKind, CallTextKey> = {
  'symmetric-nat': 'diagSymmetric',
  blocked: 'diagBlocked',
  'peer-blocked': 'diagPeerBlocked',
  'turn-failed': 'diagTurnFailed',
  unknown: 'diagUnknown',
}

const MEDIA: Record<string, CallTextKey> = {
  denied: 'mediaDenied',
  missing: 'mediaMissing',
  busy: 'mediaBusy',
  failed: 'mediaFailed',
}

/** How the call ended, and — when there is something to do about it — what. */
function CallEnding({
  call,
  name,
  ct,
  control,
  primary,
}: {
  call: CallView
  name: string
  ct: CallTextFn
  control: (action: CallControl) => void
  primary: React.RefObject<HTMLButtonElement | null>
}) {
  const end = call.ended
  if (!end || !isStickyEnd(end.kind)) return <div className="call-controls" />

  let title: string
  let body: string
  // Only for a TURN server someone already has: a call needs none (ADR-072).
  const checkTurn =
    end.kind === 'relay-needs-turn' || (end.kind === 'failed' && end.diagnosis?.kind === 'turn-failed')
  if (end.kind === 'failed') {
    title = ct('failedTitle')
    body = end.diagnosis ? ct(DIAGNOSIS[end.diagnosis.kind], { name }) : ct('failedPeer', { name })
  } else if (end.kind === 'media') {
    title = ct('mediaTitle')
    body = ct(MEDIA[end.media ?? 'failed'] ?? 'mediaFailed')
  } else if (end.kind === 'radio-unsupported') {
    title = ct('mediaTitle')
    body = ct('radioUnsupported')
  } else if (end.kind === 'relay-needs-turn') {
    title = ct('mediaTitle')
    body = ct('relayNeedsTurn')
  } else {
    title = ct('mediaTitle')
    body = ct('endedError')
  }

  return (
    <div className="call-ending">
      <div role="alert">
        <strong className="call-ending-title">{title}</strong>
        <p className="call-ending-body">{body}</p>
      </div>
      <div className="call-ending-actions">
        {checkTurn ? (
          <button
            className="btn btn-primary"
            onClick={() => {
              control({ type: 'dismiss' })
              navigate({ name: 'settings-calls' })
            }}
          >
            {ct('checkTurn')}
          </button>
        ) : null}
        <button
          ref={primary}
          className="btn btn-outline call-ending-close"
          onClick={() => control({ type: 'dismiss' })}
        >
          {ct('close')}
        </button>
      </div>
    </div>
  )
}

/** A walkie-talkie, once it is on (ADR-070): held to talk, released to listen. */
function RelayVoicePanel({
  voice,
  name,
  ct,
  control,
}: {
  voice: VoiceView
  name: string
  ct: CallTextFn
  control: (action: CallControl) => void
}) {
  const hold = (on: boolean) => control({ type: 'talk', on })
  const hangUp = (
    <button className="btn btn-danger" onClick={() => control({ type: 'hangup' })}>
      {ct('hangUp')}
    </button>
  )
  // On, and not live: every relay that could reach them has refused.
  if (voice.state !== 'live') {
    return (
      <div className="call-voice">
        <p className="call-voice-note">{ct('voiceRefused', { name })}</p>
        {hangUp}
      </div>
    )
  }

  const status: CallTextKey = voice.talking
    ? voice.throttled
      ? 'voiceThrottled'
      : 'voiceYouTalk'
    : voice.peerTalking
      ? 'voiceTheyTalk'
      : voice.peerHere
        ? 'voiceTheyListen'
        : 'voiceTheyAway'
  const talkKey = (event: React.KeyboardEvent, on: boolean) => {
    if (event.key !== ' ' && event.key !== 'Enter') return
    event.preventDefault()
    if (!event.repeat) hold(on)
  }
  return (
    <div className="call-voice">
      <p className="call-voice-status" aria-live="polite">
        {ct(status, { name })}
      </p>
      <button
        className="call-voice-talk"
        aria-pressed={voice.talking}
        onPointerDown={(event) => {
          // Keeps the release with this button wherever the finger ends up.
          event.currentTarget.setPointerCapture?.(event.pointerId)
          hold(true)
        }}
        onPointerUp={() => hold(false)}
        onPointerCancel={() => hold(false)}
        onKeyDown={(event) => talkKey(event, true)}
        onKeyUp={(event) => talkKey(event, false)}
        onBlur={() => hold(false)}
        onContextMenu={(event) => event.preventDefault()}
      >
        <MicIcon size={28} />
        <span>{ct(voice.talking ? 'voiceRelease' : 'voiceHold')}</span>
      </button>
      <p className="call-voice-note">
        {voice.heard === null ? ct('voiceLimit') : ct(voice.heard ? 'voiceHeard' : 'voiceUnheard', { name })}
      </p>
      <p className="call-voice-note">{ct('voiceRelays', { count: voice.relays })}</p>
      {hangUp}
    </div>
  )
}

const MEDIA_ICON: Record<CallMedia, typeof PhoneIcon> = {
  audio: PhoneIcon,
  video: VideoIcon,
  radio: RadioIcon,
}
const INCOMING: Record<CallMedia, CallTextKey> = {
  audio: 'incomingVoice',
  video: 'incomingVideo',
  radio: 'incomingRadio',
}

const ENDED: Record<string, CallTextKey> = {
  hangup: 'endedHangup',
  cancelled: 'endedCancelled',
  declined: 'endedDeclined',
  busy: 'endedBusy',
  unanswered: 'endedUnanswered',
  missed: 'endedMissed',
  lost: 'endedLost',
  // The card below says what went wrong; the status line just says it is over.
  failed: 'endedHangup',
  media: 'endedHangup',
  'relay-needs-turn': 'endedHangup',
  'radio-unsupported': 'endedHangup',
  error: 'endedHangup',
}

/** One line: calling, ringing, the running clock, or how it ended. */
function CallStatus({ call, name, ct }: { call: CallView; name: string; ct: CallTextFn }) {
  const now = useNow(call.phase === 'connected' || call.phase === 'reconnecting')
  switch (call.phase) {
    case 'outgoing':
      return <>{ct('calling')}</>
    case 'ringing':
      return <>{ct('ringing')}</>
    case 'incoming':
      return <>{ct(INCOMING[call.media])}</>
    case 'connecting':
      return <>{ct(call.relaying ? 'relaying' : 'connecting')}</>
    case 'reconnecting':
      return <>{ct('reconnecting')}</>
    case 'connected':
      return (
        <bdi className="call-clock">{formatCallDuration(Math.max(0, now - (call.connectedAt ?? now)))}</bdi>
      )
    case 'ended':
      return <>{ct(ENDED[call.ended?.kind ?? 'hangup'] ?? 'endedHangup', { name })}</>
  }
}

// --- pieces -----------------------------------------------------------------------

function CallButton({
  label,
  icon,
  onClick,
  pressed,
  tone,
  showLabel,
  ref,
}: {
  label: string
  icon: React.ReactNode
  onClick: () => void
  pressed?: boolean
  tone?: 'danger' | 'accept'
  showLabel?: boolean
  ref?: React.Ref<HTMLButtonElement>
}) {
  const className = `call-button${tone ? ` call-button-${tone}` : ''}`
  const button = (
    <button
      ref={ref}
      className={className}
      aria-label={label}
      title={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      onClick={onClick}
    >
      {icon}
    </button>
  )
  if (!showLabel) return button
  return (
    <span className="call-control">
      {button}
      <span className="call-control-label" aria-hidden="true">
        {label}
      </span>
    </span>
  )
}

/**
 * A `<video>` or `<audio>` bound to a stream. The stream object is replaced
 * only when its tracks change, so re-renders do not restart playback.
 */
function MediaElement({
  kind,
  stream,
  className,
  mirrored,
  fit,
}: {
  kind: 'audio' | 'video'
  stream: MediaStream | null
  className?: string
  mirrored?: boolean
  fit?: 'cover' | 'contain'
}) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    if (element.srcObject !== stream) element.srcObject = stream
    if (stream) void element.play().catch(() => undefined)
  }, [stream])
  if (kind === 'audio') return <audio ref={ref} autoPlay className="visually-hidden" />
  return (
    <video
      ref={ref}
      className={className}
      data-mirrored={mirrored || undefined}
      data-fit={fit}
      autoPlay
      playsInline
      // Picture only: sound comes from the one audio element, so it keeps
      // playing when the call is minimised and is never heard twice.
      muted
    />
  )
}

/** The time, refreshed every second while `ticking`. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [ticking])
  return now
}

/** Ring while a call is coming in; purr while ours rings at the other end. */
function useCallSounds(phase: CallView['phase']): void {
  useEffect(() => {
    if (phase !== 'incoming' && phase !== 'ringing') return
    const tone = phase === 'incoming' ? playRingtone() : playRingback()
    return () => tone.stop()
  }, [phase])
}

/**
 * A call ringing in a background tab says so, if notifications are on. The
 * one notification that names what it is about: a call cannot wait to be read.
 */
function useIncomingNotification(call: CallView, name: string, ct: CallTextFn): void {
  const enabled = useApp((s) => s.settings.notificationsEnabled)
  const ringing = call.phase === 'incoming'
  const body = ct(INCOMING[call.media])
  useEffect(() => {
    if (!ringing || !enabled || typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted' || document.visibilityState === 'visible') return
    let shown: Notification | null = null
    try {
      shown = new Notification(name, { body, tag: 'textor-call', requireInteraction: true })
      shown.onclick = () => {
        focus()
        shown?.close()
      }
    } catch {
      /* some browsers insist on a service-worker registration */
    }
    return () => shown?.close()
  }, [ringing, enabled, name, body])
}

/** Keep the screen on while a video call is up; a dimming screen is a frozen picture. */
function useWakeLock(call: CallView): void {
  const wanted = call.phase === 'connected' && (call.local.camera || call.local.screen || call.remote.video)
  useEffect(() => {
    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLock }).wakeLock
    if (!wanted || !wakeLock) return
    let sentinel: WakeLockSentinel | null = null
    let released = false
    const acquire = () => {
      if (document.visibilityState !== 'visible') return
      wakeLock
        .request('screen')
        .then((lock) => {
          if (released) void lock.release()
          else sentinel = lock
        })
        .catch(() => undefined)
    }
    acquire()
    // The browser drops the lock whenever the page is hidden.
    document.addEventListener('visibilitychange', acquire)
    return () => {
      released = true
      document.removeEventListener('visibilitychange', acquire)
      void sentinel?.release().catch(() => undefined)
    }
  }, [wanted])
}
