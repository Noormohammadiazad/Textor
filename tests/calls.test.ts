import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CallManager,
  CONNECT_TIMEOUT_MS,
  ENDED_LINGER_MS,
  ESCALATE_AFTER_MS,
  ESCALATE_SOON_MS,
  escalateAfter,
  SAMPLE_AFTER_MS,
  INCOMING_TIMEOUT_MS,
  LOST_AFTER_MS,
  NOT_REACHED_MS,
  RECOVER_AFTER_MS,
  RING_TIMEOUT_MS,
  MAX_ICE_RESTARTS,
  isStickyEnd,
  type CallView,
} from '@/core/calls/callManager'
import { encodeControlFrame, parseControlFrame, type CallFrame } from '@/core/models/protocol'
import type { CallRecord } from '@/core/models/call'
import type { IceServerSetting } from '@/core/models/types'
import * as turnModule from '@/core/calls/turn'
import { readRadio, VOICE_RELAYS } from '@/core/calls/relayVoice'
import { FakeVoicePlatform, FakeVoiceRelays } from './fakeVoice'
import { NO_ANSWER_MS, TURN_HEALTH, type TurnHealthMap } from '@/core/calls/turn'
import { candidatesInSdp } from '@/core/calls/diagnose'
import { CallSession } from '@/core/calls/callSession'
import { bytesToHex, randomBytes } from '@/core/util/bytes'
import {
  createFakeStream,
  FakeIceNetwork,
  FakeMedia,
  FakePeerConnection,
  FakeTrack,
  OPEN_NETWORK,
  type NetworkProfile,
} from './fakeRtc'

/**
 * Calls, end to end between two call managers. Signals cross the same parser
 * every receiver runs, peer connections are fakes that follow the WebRTC state
 * machine, and a fake network decides who can reach whom — so everything from
 * ringing to ICE failure is played out rather than asserted into existence.
 */

const TURN: RTCIceServer = { urls: 'turn:turn.example.org:3478', username: 'u', credential: 'p' }

interface Party {
  name: string
  pubkey: string
  manager: CallManager
  media: FakeMedia
  records: { peer: string; id: string; direction: 'in' | 'out'; record: CallRecord; at: number }[]
  sent: { to: string; frame: CallFrame; id: string }[]
  views: (CallView | null)[]
  config: { iceServers: IceServerSetting[]; relayOnly: boolean }
  profile: NetworkProfile
  /** The peer connections this party made. */
  pcs: FakePeerConnection[]
  /** Hold signals back, to play a slow outbox. */
  signalDelayMs: number
  online: boolean
  gatherGraceMs: number
  /** Make sending this signal fail, as a stopped engine would. */
  failSignal: (frame: CallFrame) => boolean
  /** Make every offer this party's browser makes fail. */
  failOffers: boolean
  /** How long this party's ICE takes to find each candidate. */
  gatherSpacingMs: number
  /** This party's vault state: where what calls learn about TURN servers is kept. */
  state: Map<string, unknown>
  /** Make keeping it fail, as a vault locking underneath would. */
  failStore: boolean
  /** Make writing a call into its conversation fail. */
  failRecord: boolean
  /** Make TURN selection fail to load, as on a page left running across a deployment. */
  failTurn: boolean
  /** This party's microphone and speaker for a walkie-talkie. */
  voice: FakeVoicePlatform
  /** The relays this party reads. */
  inbox: string[]
  /** Calls this party picked up or turned down, as told to its other devices. */
  handled: [string, string][]
}

let network: FakeIceNetwork
let voiceRelays: FakeVoiceRelays
let parties: Map<string, Party>

function makeParty(name: string, pubkey: string, opts: Partial<Party> = {}): Party {
  const party: Party = {
    name,
    pubkey,
    media: new FakeMedia(),
    records: [],
    sent: [],
    views: [],
    config: { iceServers: [{ urls: 'stun:stun.example.org' }], relayOnly: false },
    profile: OPEN_NETWORK,
    pcs: [],
    signalDelayMs: 0,
    online: true,
    gatherGraceMs: 200,
    failSignal: () => false,
    failOffers: false,
    gatherSpacingMs: 5,
    state: new Map(),
    failStore: false,
    failRecord: false,
    failTurn: false,
    voice: new FakeVoicePlatform(),
    inbox: [`wss://${name.toLowerCase().replace(/\W/g, '')}.example`],
    handled: [],
    ...opts,
  } as Party
  party.manager = new CallManager({
    self: pubkey,
    handled: (peer, id) => party.handled.push([peer, id]),
    signal: async (peer, frame) => {
      // Every signal crosses the parser the other side runs.
      const parsed = parseControlFrame(encodeControlFrame(frame)) as CallFrame | null
      expect(parsed, `${name} sent a frame the other side would drop`).not.toBeNull()
      if (party.failSignal(frame)) throw new Error('messenger is not running')
      if (party.signalDelayMs) await new Promise((resolve) => setTimeout(resolve, party.signalDelayMs))
      const id = bytesToHex(randomBytes(32))
      party.sent.push({ to: peer, frame, id })
      const target = parties.get(peer)
      if (target?.online && party.online) {
        setTimeout(() => {
          // A call can end while a frame is being acted on, and under load it sometimes does.
          void target.manager
            .handleSignal(pubkey, parsed as CallFrame, parsed?.call ?? id, Date.now())
            .catch((err: unknown) => {
              if ((err as Error).message !== 'closed') throw err
            })
        }, 5)
      }
      return id
    },
    record: async (peer, id, direction, record, at) => {
      if (party.failRecord) throw new Error('the vault is locked')
      party.records.push({ peer, id, direction, record, at })
    },
    config: () => party.config,
    store: {
      getState: async <T>(name: string) => (party.state.get(name) as T | undefined) ?? null,
      putState: async (name, value) => {
        if (party.failStore) throw new Error('the vault is locked')
        party.state.set(name, structuredClone(value))
      },
    },
    turn: async () => {
      if (party.failTurn) throw new Error('the chunk is gone')
      return turnModule
    },
    voice: {
      get pool() {
        return voiceRelays.pool(party.inbox)
      },
      get platform() {
        return party.voice
      },
    },
    createPeerConnection: (config) => {
      const pc = new FakePeerConnection(config, network, party.profile)
      pc.failOffers = party.failOffers
      pc.gatherSpacingMs = party.gatherSpacingMs
      party.pcs.push(pc)
      return pc as unknown as RTCPeerConnection
    },
    createStream: createFakeStream,
    media: party.media,
    gatherGraceMs: party.gatherGraceMs,
  })
  party.manager.events.on('changed', (view) => party.views.push(view))
  parties.set(pubkey, party)
  return party
}

const settle = (ms = 400) => vi.advanceTimersByTimeAsync(ms)
const view = (party: Party) => party.manager.view
/** The last thing the screen showed, even once an ordinary ending has closed it. */
const lastShown = (party: Party) => party.views.filter((shown) => shown !== null).at(-1)
const kinds = (party: Party) => party.sent.map(({ frame }) => frame.kind)
const pc = (party: Party) => party.pcs[party.pcs.length - 1] as FakePeerConnection

// Alice's key sorts first, so she is the polite peer.
const ALICE = 'a'.repeat(64)
const BOB = 'b'.repeat(64)
const CAROL = 'c'.repeat(64)

let alice: Party
let bob: Party

beforeEach(() => {
  // Advancing on its own, because the fakes wait on timers internally the way
  // a browser waits on the network; tests jump ahead explicitly for timeouts.
  vi.useFakeTimers({ shouldAdvanceTime: true })
  network = new FakeIceNetwork()
  voiceRelays = new FakeVoiceRelays()
  parties = new Map()
  alice = makeParty('Alice', ALICE)
  bob = makeParty('Bob', BOB)
})

afterEach(() => {
  for (const party of parties.values()) party.manager.dispose()
  vi.useRealTimers()
})

async function connectedCall(media: 'audio' | 'video' = 'audio', answerWith?: 'audio' | 'video') {
  await alice.manager.place(BOB, media)
  await settle()
  await bob.manager.accept(answerWith)
  await settle()
  expect(view(alice)?.phase).toBe('connected')
  expect(view(bob)?.phase).toBe('connected')
}

describe('ringing', () => {
  it('rings the other side, which learns nothing about this device until it answers', async () => {
    await alice.manager.place(BOB, 'audio')
    await settle()

    expect(view(bob)).toMatchObject({ phase: 'incoming', direction: 'in', media: 'audio', peer: ALICE })
    // No peer connection, no STUN request, no camera or microphone: an
    // unanswered call leaves nothing behind that could reveal an address.
    expect(bob.pcs).toHaveLength(0)
    expect(bob.media.requests).toHaveLength(0)
    expect(kinds(bob)).toEqual(['ringing'])
    // …and the caller is told the call reached them.
    expect(view(alice)).toMatchObject({ phase: 'ringing', reached: true, notReached: false })
  })

  it('opens a call with an offer that names no call, and names every later frame by its id', async () => {
    await connectedCall()
    const [opening, ...rest] = alice.sent
    expect(opening?.frame).toMatchObject({ kind: 'offer', media: 'audio' })
    expect(opening?.frame.call).toBeUndefined()
    const id = opening?.id
    expect(view(alice)?.id).toBe(id)
    expect(view(bob)?.id).toBe(id)
    for (const { frame } of [...rest, ...bob.sent]) expect(frame.call).toBe(id)
    // An ordinary call is one offer and one answer: nothing is renegotiated
    // once it connects.
    await settle(1000)
    expect(kinds(alice).filter((kind) => kind === 'offer')).toHaveLength(1)
    expect(kinds(bob)).not.toContain('offer')
  })

  it('folds the first candidates into the offer instead of sending each one', async () => {
    await alice.manager.place(BOB, 'audio')
    await settle()
    const offer = alice.sent[0]?.frame
    expect(candidatesInSdp(offer?.sdp ?? '').length).toBeGreaterThan(0)
    // Gathering finished inside the grace period, so nothing trickled.
    expect(kinds(alice)).toEqual(['offer'])
  })

  it('says so when the other device has not confirmed it is ringing', async () => {
    bob.online = false
    await alice.manager.place(BOB, 'audio')
    await settle()
    expect(view(alice)).toMatchObject({ phase: 'outgoing', notReached: false })
    await settle(NOT_REACHED_MS)
    expect(view(alice)).toMatchObject({ phase: 'outgoing', notReached: true })
  })

  it('refuses to place a second call over the first', async () => {
    await alice.manager.place(BOB, 'audio')
    await expect(alice.manager.place(CAROL, 'audio')).rejects.toThrow('already in a call')
  })
})

describe('answering', () => {
  it('connects once answered, with audio both ways', async () => {
    await connectedCall()
    expect(view(alice)?.connectedAt).not.toBeNull()
    expect(view(alice)?.path).toBe('direct')
    const aliceMic = alice.media.opened.find((track) => track.kind === 'audio')
    const bobMic = bob.media.opened.find((track) => track.kind === 'audio')
    expect(pc(alice).sending('audio')).toBe(aliceMic)
    expect(pc(bob).sending('audio')).toBe(bobMic)
    expect(view(alice)?.remote.stream).not.toBeNull()
    expect(view(bob)?.remote.audio).toBe(true)
  })

  it('sends the camera on a video call, and says the picture is on', async () => {
    await connectedCall('video')
    const camera = alice.media.opened.find((track) => track.kind === 'video')
    expect(pc(alice).sending('video')).toBe(camera)
    expect(view(bob)?.remote).toMatchObject({ video: true, screen: false })
    expect(view(alice)?.local).toMatchObject({ camera: true, canFlip: true })
    expect(view(alice)?.local.stream).not.toBeNull()
  })

  it('can answer a video call with voice only, and still see the caller', async () => {
    await connectedCall('video', 'audio')
    expect(bob.media.opened.some((track) => track.kind === 'video')).toBe(false)
    expect(view(bob)?.local.camera).toBe(false)
    expect(view(bob)?.remote.video).toBe(true)
    expect(view(alice)?.remote.video).toBe(false)
    expect(pc(bob).sending('video')).toBeNull()
  })

  it('uses candidates that arrived while it was still ringing', async () => {
    // Slow the caller's gathering past the grace period, so candidates trickle.
    await alice.manager.place(BOB, 'audio')
    await settle()
    pc(alice).restartIce() // not established yet: ignored, nothing is renegotiated
    await settle()
    expect(kinds(alice)).toEqual(['offer'])
    await bob.manager.accept()
    await settle()
    expect(view(bob)?.phase).toBe('connected')
  })
})

describe('ending', () => {
  it('writes the same call into both conversations when it is hung up', async () => {
    await connectedCall()
    await vi.advanceTimersByTimeAsync(65_000)
    alice.manager.hangup()
    await settle()

    const id = alice.sent[0]?.id
    expect(view(alice)?.ended?.kind).toBe('hangup')
    expect(view(bob)?.ended?.kind).toBe('hangup')
    expect(alice.records).toEqual([expect.objectContaining({ id, peer: BOB, direction: 'out' })])
    expect(bob.records).toEqual([expect.objectContaining({ id, peer: ALICE, direction: 'in' })])
    expect(alice.records[0]?.record).toMatchObject({ media: 'audio', outcome: 'completed' })
    expect(alice.records[0]?.record.durationMs).toBeGreaterThanOrEqual(65_000)
    expect(bob.records[0]?.record.outcome).toBe('completed')
  })

  it('stops every camera and microphone track, so no light stays on', async () => {
    await connectedCall('video')
    bob.manager.hangup()
    await settle()
    expect(alice.media.live).toEqual([])
    expect(bob.media.live).toEqual([])
    expect(pc(alice).closed).toBe(true)
    expect(pc(bob).closed).toBe(true)
  })

  it('closes the ended call a moment later', async () => {
    await connectedCall()
    alice.manager.hangup()
    await settle()
    expect(view(alice)?.phase).toBe('ended')
    await settle(ENDED_LINGER_MS)
    expect(view(alice)).toBeNull()
    expect(alice.views.at(-1)).toBeNull()
  })

  it('records a declined call as declined on both sides', async () => {
    await alice.manager.place(BOB, 'video')
    await settle()
    bob.manager.decline()
    await settle()
    expect(view(alice)?.ended?.kind).toBe('declined')
    expect(alice.records[0]?.record).toEqual({ media: 'video', outcome: 'declined' })
    expect(bob.records[0]?.record).toEqual({ media: 'video', outcome: 'declined' })
    expect(alice.media.live).toEqual([])
  })

  it('gives up on an unanswered call and tells the other side to stop ringing', async () => {
    await alice.manager.place(BOB, 'audio')
    await settle()
    await settle(RING_TIMEOUT_MS)
    expect(view(alice)?.ended?.kind).toBe('unanswered')
    expect(alice.sent.at(-1)?.frame).toMatchObject({ kind: 'bye', reason: 'unanswered' })
    expect(view(bob)?.ended?.kind).toBe('missed')
    expect(alice.records[0]?.record.outcome).toBe('unanswered')
    expect(bob.records[0]?.record.outcome).toBe('missed')
  })

  it('stops ringing on its own if the caller vanishes', async () => {
    await alice.manager.place(BOB, 'audio')
    await settle()
    alice.online = false
    await settle(INCOMING_TIMEOUT_MS)
    expect(view(bob)?.ended?.kind).toBe('missed')
    expect(bob.records[0]?.record.outcome).toBe('missed')
  })

  it('records a call the caller gave up on as missed, and theirs as cancelled', async () => {
    await alice.manager.place(BOB, 'audio')
    await settle()
    alice.manager.hangup()
    await settle()
    expect(view(alice)?.ended?.kind).toBe('cancelled')
    expect(view(bob)?.ended?.kind).toBe('missed')
    expect(alice.records[0]?.record.outcome).toBe('cancelled')
    expect(bob.records[0]?.record.outcome).toBe('missed')
  })

  it('still says goodbye when hung up before the offer had even been queued', async () => {
    alice.signalDelayMs = 500
    const placing = alice.manager.place(BOB, 'audio')
    await settle(300)
    alice.manager.hangup()
    await settle(1000)
    await placing
    const id = alice.sent[0]?.id
    expect(alice.sent.map(({ frame }) => frame.kind)).toEqual(['offer', 'bye'])
    expect(alice.sent[1]?.frame.call).toBe(id)
    expect(alice.records[0]).toMatchObject({ id, record: { outcome: 'cancelled' } })
  })

  it('hangs up when disposed, as when the vault locks', async () => {
    await connectedCall()
    alice.manager.dispose()
    await settle()
    expect(alice.sent.at(-1)?.frame).toMatchObject({ kind: 'bye', reason: 'hangup' })
    expect(view(bob)?.ended?.kind).toBe('hangup')
    expect(alice.media.live).toEqual([])
    expect(alice.manager.view).toBeNull()
  })
})

describe('with another device of this identity (ADR-073)', () => {
  const offerId = () => alice.sent.find((sent) => sent.frame.kind === 'offer')!.id

  it('tells the others it picked up', async () => {
    await connectedCall()
    expect(bob.handled).toEqual([[ALICE, offerId()]])
  })

  it('tells the others it turned the call down', async () => {
    await alice.manager.place(BOB, 'audio')
    await settle()
    bob.manager.decline()
    expect(bob.handled).toEqual([[ALICE, offerId()]])
  })

  it('stops ringing when another device takes the call, says nothing and writes nothing', async () => {
    await alice.manager.place(BOB, 'audio')
    await settle()
    expect(view(bob)?.phase).toBe('incoming')
    const sentBefore = bob.sent.length
    bob.manager.elsewhere(offerId())
    expect(view(bob)).toBeNull()
    await settle()
    expect(bob.sent.length).toBe(sentBefore)
    expect(bob.records).toHaveLength(0)
    // The ring it had armed does not come back to end it as missed.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(bob.records).toHaveLength(0)
    expect(view(bob)).toBeNull()
  })

  it('takes no notice about any other call, or one already answered here', async () => {
    alice.manager.elsewhere('nothing')
    await alice.manager.place(BOB, 'audio')
    await settle()
    bob.manager.elsewhere('some other call')
    expect(view(bob)?.phase).toBe('incoming')
    await bob.manager.accept()
    await settle()
    bob.manager.elsewhere(offerId())
    expect(view(bob)).not.toBeNull()
    // Nor on the side that placed it.
    alice.manager.elsewhere(offerId())
    expect(view(alice)).not.toBeNull()
  })
})

describe('one call at a time', () => {
  it('tells a second caller the line is busy, and keeps their call as missed', async () => {
    const carol = makeParty('Carol', CAROL)
    await connectedCall()
    await carol.manager.place(BOB, 'audio')
    await settle()
    expect(view(carol)?.ended?.kind).toBe('busy')
    expect(bob.sent.at(-1)?.frame).toMatchObject({ kind: 'bye', reason: 'busy' })
    expect(bob.records).toEqual([
      expect.objectContaining({
        peer: CAROL,
        direction: 'in',
        record: { media: 'audio', outcome: 'missed' },
      }),
    ])
    expect(carol.records[0]?.record.outcome).toBe('busy')
    // The call already under way is untouched.
    expect(view(bob)).toMatchObject({ phase: 'connected', peer: ALICE })
  })

  it('treats the same offer arriving twice as one call', async () => {
    await alice.manager.place(BOB, 'audio')
    await settle()
    const { frame, id } = alice.sent[0] as Party['sent'][number]
    await bob.manager.handleSignal(ALICE, frame, id, Date.now())
    await settle()
    expect(kinds(bob)).toEqual(['ringing'])
    expect(view(bob)?.phase).toBe('incoming')
  })

  it('lets a caller who starts over replace the call they left', async () => {
    await connectedCall()
    const first = alice.sent[0]?.id
    // Alice reloads mid-call: her side forgets the call and calls again.
    const again = makeParty('Alice again', ALICE)
    await again.manager.place(BOB, 'audio')
    await settle()
    expect(view(bob)).toMatchObject({ phase: 'incoming', id: again.sent[0]?.id })
    expect(bob.records).toEqual([
      expect.objectContaining({ id: first, record: expect.objectContaining({ outcome: 'completed' }) }),
    ])
  })

  it('connects once when both call each other at the same moment', async () => {
    const placing = [alice.manager.place(BOB, 'video'), bob.manager.place(ALICE, 'audio')]
    await Promise.all(placing)
    await settle(1000)

    // Alice, the polite side, gave up her call and answered Bob's.
    expect(view(alice)).toMatchObject({ phase: 'connected', direction: 'in', peer: BOB })
    expect(view(bob)).toMatchObject({ phase: 'connected', direction: 'out', peer: ALICE })
    expect(view(alice)?.id).toBe(view(bob)?.id)
    // Nobody heard a busy signal, and her camera moved across without reopening.
    expect([...alice.sent, ...bob.sent].some(({ frame }) => frame.reason === 'busy')).toBe(false)
    expect(alice.media.opened.filter((track) => track.kind === 'video')).toHaveLength(1)
    expect(pc(alice).sending('video')).not.toBeNull()

    alice.manager.hangup()
    await settle()
    // One call, recorded once on each side; the abandoned one left no trace.
    expect(alice.records).toHaveLength(1)
    expect(bob.records).toHaveLength(1)
    expect(alice.records[0]?.id).toBe(bob.records[0]?.id)
  })
})

describe('in the call', () => {
  it('mutes by disabling the microphone, and tells the other side', async () => {
    await connectedCall()
    alice.manager.setMuted(true)
    await settle()
    expect(alice.media.opened.find((track) => track.kind === 'audio')?.enabled).toBe(false)
    expect(view(alice)?.local.muted).toBe(true)
    expect(view(bob)?.remote.audio).toBe(false)
    alice.manager.setMuted(false)
    await settle()
    expect(view(bob)?.remote.audio).toBe(true)
  })

  it('adds video to a voice call by renegotiating over the same call', async () => {
    await connectedCall('audio')
    const before = alice.sent.length
    await alice.manager.setCamera(true)
    await settle()
    const renegotiation = alice.sent.slice(before).map(({ frame }) => frame)
    expect(renegotiation[0]).toMatchObject({ kind: 'offer', call: view(alice)?.id })
    expect(renegotiation[0]?.media).toBeUndefined()
    expect(bob.sent.at(-1)?.frame.kind).toBe('answer')
    expect(pc(alice).sending('video')).not.toBeNull()
    expect(view(bob)?.remote.video).toBe(true)
    expect(view(alice)?.phase).toBe('connected')
  })

  it('turns the camera off without renegotiating, and stops the track', async () => {
    await connectedCall('video')
    const before = alice.sent.length
    const camera = alice.media.opened.find((track) => track.kind === 'video') as FakeTrack
    await alice.manager.setCamera(false)
    await settle()
    expect(camera.readyState).toBe('ended')
    expect(alice.sent.length).toBe(before)
    expect(view(bob)?.remote.video).toBe(false)
    // And back on: a new track on the same sender, still without an offer.
    await alice.manager.setCamera(true)
    await settle()
    expect(alice.sent.length).toBe(before)
    expect(pc(alice).sending('video')?.readyState).toBe('live')
    expect(view(bob)?.remote.video).toBe(true)
  })

  it('lets someone who answered with voice turn their camera on later', async () => {
    await connectedCall('video', 'audio')
    await bob.manager.setCamera(true)
    await settle()
    expect(pc(bob).sending('video')).not.toBeNull()
    expect(view(alice)?.remote.video).toBe(true)
  })

  it('flips between front and back cameras, closing the old one first', async () => {
    await connectedCall('video')
    const front = alice.media.opened.find((track) => track.kind === 'video') as FakeTrack
    await alice.manager.flipCamera()
    await settle()
    expect(front.readyState).toBe('ended')
    expect(view(alice)?.local.facing).toBe('environment')
    expect(pc(alice).sending('video')?.settings.facingMode).toBe('environment')
  })

  it('cycles through cameras that do not say which way they face', async () => {
    alice.media.cameras = [{ deviceId: 'desk' }, { deviceId: 'document' }]
    await connectedCall('video')
    await alice.manager.flipCamera()
    await settle()
    expect(pc(alice).sending('video')?.settings.deviceId).toBe('document')
    await alice.manager.flipCamera()
    await settle()
    expect(pc(alice).sending('video')?.settings.deviceId).toBe('desk')
  })

  it('shares a screen in place of the camera, and goes back when the browser stops it', async () => {
    await connectedCall('video')
    const camera = pc(alice).sending('video')
    await alice.manager.setScreenShare(true)
    await settle()
    const screen = pc(alice).sending('video') as FakeTrack
    expect(screen.settings.displaySurface).toBe('monitor')
    expect(screen.contentHint).toBe('detail')
    expect(view(bob)?.remote).toMatchObject({ video: true, screen: true })
    expect(view(alice)?.local.screen).toBe(true)

    screen.end()
    await settle()
    expect(pc(alice).sending('video')).toBe(camera)
    expect(view(bob)?.remote.screen).toBe(false)
  })

  it('shares a screen in a voice call too', async () => {
    await connectedCall('audio')
    await alice.manager.setScreenShare(true)
    await settle()
    expect(view(bob)?.remote).toMatchObject({ video: true, screen: true })
    await alice.manager.setScreenShare(false)
    await settle()
    expect(view(bob)?.remote).toMatchObject({ video: false, screen: false })
  })

  it('says nothing when the screen picker is closed, and something when sharing breaks', async () => {
    await connectedCall()
    alice.media.displayError = 'NotAllowedError'
    await alice.manager.setScreenShare(true)
    expect(view(alice)?.notice).toBeNull()
    alice.media.displayError = 'NotReadableError'
    await alice.manager.setScreenShare(true)
    expect(view(alice)?.notice).toBe('screen-failed')
    await settle(5000)
    expect(view(alice)?.notice).toBeNull()
  })

  it('offers screen sharing only where the browser can do it', async () => {
    const phone = makeParty('Phone', 'd'.repeat(64), { media: new FakeMedia({ canShare: false }) })
    await phone.manager.place(BOB, 'audio')
    expect(view(phone)?.local.canShare).toBe(false)
    expect(view(alice)).toBeNull()
  })
})

describe('when the network is in the way', () => {
  const SYMMETRIC: NetworkProfile = { stun: true, symmetric: true, turn: false }

  it('explains a failure behind symmetric NAT on both sides', async () => {
    alice.profile = SYMMETRIC
    bob.profile = SYMMETRIC
    await alice.manager.place(BOB, 'audio')
    await settle()
    await bob.manager.accept()
    await settle()
    for (const party of [alice, bob]) {
      expect(view(party)?.ended?.kind).toBe('failed')
      expect(view(party)?.ended?.diagnosis?.kind).toBe('symmetric-nat')
    }
    expect(view(alice)?.ended?.diagnosis?.local.symmetric).toBe(true)
    expect(alice.records[0]?.record.outcome).toBe('failed')
    // A failure stays on screen until it has been read.
    await settle(ENDED_LINGER_MS * 2)
    expect(view(alice)?.phase).toBe('ended')
    alice.manager.dismiss()
    expect(view(alice)).toBeNull()
  })

  it('connects through a TURN server where direct traffic cannot', async () => {
    alice.profile = { stun: true, symmetric: true, turn: true }
    bob.profile = SYMMETRIC
    alice.config = { iceServers: [TURN], relayOnly: false }
    await connectedCall()
    expect(view(alice)?.path).toBe('relay')
  })

  it('blames the TURN server when it does not answer', async () => {
    alice.profile = { stun: true, symmetric: true, turn: false }
    bob.profile = SYMMETRIC
    alice.config = { iceServers: [TURN], relayOnly: false }
    await alice.manager.place(BOB, 'audio')
    await settle()
    await bob.manager.accept()
    await settle()
    expect(view(alice)?.ended?.diagnosis?.kind).toBe('turn-failed')
  })

  it('says when this network blocks everything, and when the other side does', async () => {
    alice.profile = { stun: false, symmetric: false, turn: false }
    await alice.manager.place(BOB, 'audio')
    await settle()
    await bob.manager.accept()
    await settle()
    expect(view(alice)?.ended?.diagnosis?.kind).toBe('blocked')
    expect(view(bob)?.ended?.diagnosis?.kind).toBe('peer-blocked')
  })

  it('gives up on a connection that never comes up', async () => {
    await alice.manager.place(BOB, 'audio')
    await settle()
    // Bob answers, but his answer is lost on the way.
    alice.online = false
    bob.online = false
    await bob.manager.accept()
    await settle(CONNECT_TIMEOUT_MS)
    expect(view(bob)?.ended?.kind).toBe('failed')
  })

  it('rides out a brief drop without ending the call', async () => {
    await connectedCall()
    network.interrupt(pc(alice))
    await settle(100)
    expect(view(alice)?.phase).toBe('reconnecting')
    network.restore(pc(alice))
    await settle(100)
    expect(view(alice)?.phase).toBe('connected')
    expect(pc(alice).restarts).toBe(0)
  })

  it('restarts ICE when a drop lasts, and gives the call up if it never recovers', async () => {
    await connectedCall()
    network.interrupt(pc(alice))
    await settle(RECOVER_AFTER_MS + 100)
    expect(pc(alice).restarts + pc(bob).restarts).toBeGreaterThan(0)
    // The restart renegotiated over the call, and the connection came back.
    expect(kinds(alice).includes('offer') || kinds(bob).includes('offer')).toBe(true)
    expect(view(alice)?.phase).toBe('connected')
    // Now the network goes for good: nothing either side gathers can reach the other.
    const cut: NetworkProfile = { stun: false, symmetric: false, turn: false }
    network.profiles.set(pc(alice), cut)
    network.profiles.set(pc(bob), cut)
    network.interrupt(pc(alice), 'failed')
    await settle(LOST_AFTER_MS)
    expect(lastShown(alice)?.ended?.kind).toBe('lost')
    // It did connect, so it is remembered as a call that happened.
    expect(alice.records[0]?.record.outcome).toBe('completed')
  })
})

describe('TURN, only once direct paths fail (ADR-068)', () => {
  const SYMMETRIC: NetworkProfile = { stun: true, symmetric: true, turn: true }
  const NO_TURN: NetworkProfile = { stun: true, symmetric: true, turn: false }
  const KEY = 'turn:turn.example.org:3478?transport=udp'
  const health = (party: Party) => (party.state.get(TURN_HEALTH) ?? {}) as TurnHealthMap
  const turnIn = (config: RTCConfiguration | undefined) =>
    (config?.iceServers ?? []).filter((server) => String(server.urls).startsWith('turn'))

  it('never tells a TURN server about a call that connects directly', async () => {
    alice.config = { iceServers: [{ urls: 'stun:stun.example.org' }, TURN], relayOnly: false }
    bob.config = { ...alice.config }
    await connectedCall()
    await settle(ESCALATE_AFTER_MS + 1000)
    for (const party of [alice, bob]) {
      expect(turnIn(pc(party).config)).toEqual([])
      expect(pc(party).reconfigured).toEqual([])
    }
    expect(view(alice)?.path).toBe('direct')
    expect(kinds(alice).filter((kind) => kind === 'offer')).toHaveLength(1)
    alice.manager.hangup()
    await settle()
    expect(alice.state.has(TURN_HEALTH)).toBe(false)
  })

  it('brings the caller’s TURN server in when direct paths fail, and learns that it works', async () => {
    alice.profile = SYMMETRIC
    bob.profile = NO_TURN
    alice.config = { iceServers: [TURN], relayOnly: false }
    await connectedCall()
    expect(view(alice)?.path).toBe('relay')
    expect(alice.views.some((shown) => shown?.relaying)).toBe(true)
    expect(view(alice)?.relaying).toBe(false)
    expect(turnIn(pc(alice).reconfigured[0])).toEqual([TURN])
    alice.manager.hangup()
    await settle()
    expect(health(alice)[KEY]).toMatchObject({ ok: 1, fail: 0, streak: 0 })
  })

  it('lets the callee’s TURN server rescue a call the caller has none for', async () => {
    alice.profile = NO_TURN
    bob.profile = SYMMETRIC
    bob.config = { iceServers: [TURN], relayOnly: false }
    await connectedCall()
    expect(view(bob)?.path).toBe('relay')
    expect(bob.views.some((shown) => shown?.relaying)).toBe(true)
    expect(turnIn(pc(bob).reconfigured[0])).toEqual([TURN])
    // The caller restarted with nothing of its own to add, and says so.
    expect(alice.views.some((shown) => shown?.relaying)).toBe(false)
  })

  it('gives hanging direct paths a few seconds, and fewer when the candidates rule them out', async () => {
    // Checks that hang rather than fail: only the timer moves things on.
    alice.profile = { stun: true, symmetric: false, turn: true, stall: true }
    bob.profile = { ...NO_TURN, stall: true }
    alice.config = { iceServers: [TURN], relayOnly: false }
    await alice.manager.place(BOB, 'audio')
    await settle()
    await bob.manager.accept()
    await settle(ESCALATE_AFTER_MS - 1000)
    expect(view(alice)?.phase).toBe('connecting')
    expect(pc(alice).reconfigured).toEqual([])
    await settle(1500)
    expect(turnIn(pc(alice).reconfigured[0])).toEqual([TURN])
    expect(view(alice)?.phase).toBe('connected')
    expect(view(alice)?.path).toBe('relay')
  })

  it('times direct paths by what the candidates say', () => {
    const host = 'candidate:1 1 udp 2122260223 a.local 50000 typ host'
    const srflx = (port: number) =>
      `candidate:2 1 udp 1686052607 203.0.113.1 ${port} typ srflx raddr 0.0.0.0 rport 0`
    const open = [host, srflx(61000), srflx(61000)]
    expect(escalateAfter(open, open)).toBe(ESCALATE_AFTER_MS)
    // This network learned no public address: only a LAN path could work.
    expect(escalateAfter([host], open)).toBe(ESCALATE_SOON_MS)
    // …or the other's did not.
    expect(escalateAfter(open, [host])).toBe(ESCALATE_SOON_MS)
    // Symmetric NAT here: each server saw a different port.
    expect(escalateAfter([host, srflx(61000), srflx(61001)], open)).toBe(ESCALATE_SOON_MS)
    // Both on the IPv6 internet: no NAT between them, whatever IPv4 looks like.
    const v6 = 'candidate:5 1 udp 2122197247 2a01:4f8:c0c::1 50002 typ host'
    expect(escalateAfter([host, srflx(61000), srflx(61001), v6], [host, v6])).toBe(ESCALATE_AFTER_MS)
    // An IPv6 address is a public one, even with no STUN answer to go with it.
    expect(escalateAfter([host, v6], open)).toBe(ESCALATE_AFTER_MS)
  })

  it('does not blame a TURN server that was never asked', async () => {
    alice.profile = NO_TURN
    bob.profile = SYMMETRIC
    bob.config = { iceServers: [TURN], relayOnly: false }
    // The caller's restart never reaches the callee.
    alice.failSignal = (frame) => frame.kind === 'offer' && frame.call !== undefined
    await alice.manager.place(BOB, 'audio')
    await settle()
    await bob.manager.accept()
    await settle(CONNECT_TIMEOUT_MS)
    expect(pc(bob).reconfigured).toEqual([])
    expect(lastShown(bob)?.ended?.diagnosis?.kind).toBe('symmetric-nat')
  })

  it('rests a TURN server that keeps failing, and offers the others first', async () => {
    const DEAD: RTCIceServer = { urls: 'turn:dead.example', username: 'u', credential: 'p' }
    alice.profile = { ...SYMMETRIC, turnErrors: { 'turn:dead.example': 701 } }
    bob.profile = NO_TURN
    alice.config = { iceServers: [DEAD, TURN], relayOnly: false }
    const offered: RTCIceServer[][] = []
    for (let i = 0; i < 3; i++) {
      await connectedCall()
      offered.push(turnIn(pc(alice).reconfigured[0]))
      alice.manager.hangup()
      await settle(ENDED_LINGER_MS + 100)
    }
    expect(offered).toEqual([[DEAD, TURN], [TURN, DEAD], [TURN]])
    expect(health(alice)['turn:dead.example:3478?transport=udp']).toMatchObject({
      fail: 2,
      streak: 2,
      error: 0,
    })
    expect(health(alice)[KEY]).toMatchObject({ ok: 3 })
  })

  it('reads how the relay is holding up ten seconds in', async () => {
    alice.profile = SYMMETRIC
    bob.profile = NO_TURN
    alice.config = { iceServers: [TURN], relayOnly: false }
    await connectedCall()
    pc(alice).pairStats = { currentRoundTripTime: 0.08, availableOutgoingBitrate: 200_000 }
    await settle(SAMPLE_AFTER_MS)
    expect(health(alice)[KEY]).toMatchObject({ rttMs: 80, kbps: 200 })
    // Bob's media rides Alice's relay: his browser names no server of his to learn about.
    expect(bob.state.has(TURN_HEALTH)).toBe(false)
  })

  it('judges a server by its silence, once it has had time to answer', async () => {
    // Checks hang, and gathering is so slow that no relay ever arrives.
    const slow = (party: Party) => {
      party.profile = { ...SYMMETRIC, stall: true }
      party.gatherSpacingMs = 600_000
      party.config = { iceServers: [TURN], relayOnly: false }
    }
    const ring = async (caller: Party) => {
      await caller.manager.place(BOB, 'audio')
      await settle()
      await bob.manager.accept()
      // Nothing gathered here, so direct paths get only a moment.
      await settle(ESCALATE_SOON_MS + 100)
      expect(turnIn(pc(caller).reconfigured[0])).toEqual([TURN])
    }
    bob.profile = { ...NO_TURN, stall: true }

    // Hung up a moment after asking: too soon to say anything about the server.
    slow(alice)
    await ring(alice)
    alice.manager.hangup()
    await settle()
    expect(alice.state.has(TURN_HEALTH)).toBe(false)
    await settle(ENDED_LINGER_MS)

    // Still nothing after long enough to have answered: that is a failure.
    await ring(alice)
    await settle(NO_ANSWER_MS)
    alice.manager.hangup()
    await settle()
    expect(health(alice)[KEY]).toMatchObject({ ok: 0, fail: 1, error: 0 })
  })

  it('goes ahead without TURN when TURN selection cannot be loaded, and learns nothing', async () => {
    alice.profile = SYMMETRIC
    bob.profile = NO_TURN
    alice.config = { iceServers: [TURN], relayOnly: false }
    alice.failTurn = true
    await alice.manager.place(BOB, 'audio')
    await settle()
    await bob.manager.accept()
    await settle()
    // Direct paths failed and were retried, with nothing to add.
    expect(pc(alice).reconfigured).toEqual([])
    expect(lastShown(alice)?.ended?.diagnosis?.kind).toBe('symmetric-nat')
    expect(alice.state.has(TURN_HEALTH)).toBe(false)
    // With every call relayed, there is then nothing to relay through.
    alice.config = { iceServers: [TURN], relayOnly: true }
    alice.manager.dismiss()
    await alice.manager.place(BOB, 'audio')
    expect(view(alice)?.ended?.kind).toBe('relay-needs-turn')
  })

  it('keeps calling when what it learnt cannot be kept', async () => {
    alice.profile = SYMMETRIC
    bob.profile = NO_TURN
    alice.config = { iceServers: [TURN], relayOnly: false }
    alice.failStore = true
    await connectedCall()
    alice.manager.hangup()
    await settle()
    expect(lastShown(alice)?.ended?.kind).toBe('hangup')
    expect(alice.state.has(TURN_HEALTH)).toBe(false)
  })
})

describe('always relay', () => {
  it('refuses to call without a TURN server rather than going direct', async () => {
    alice.config = { iceServers: [{ urls: 'stun:stun.example.org' }], relayOnly: true }
    await alice.manager.place(BOB, 'audio')
    expect(view(alice)?.ended?.kind).toBe('relay-needs-turn')
    expect(alice.sent).toEqual([])
    expect(alice.media.requests).toEqual([])
  })

  it('offers only relay candidates, so the other side never sees this address', async () => {
    alice.config = { iceServers: [TURN], relayOnly: true }
    await connectedCall()
    expect(pc(alice).config.iceTransportPolicy).toBe('relay')
    const offered = candidatesInSdp(alice.sent[0]?.frame.sdp ?? '')
    expect(offered.length).toBeGreaterThan(0)
    for (const candidate of offered) expect(candidate).toContain('typ relay')
    expect(view(alice)?.relayOnly).toBe(true)
  })

  it('declines to answer without a TURN server either', async () => {
    bob.config = { iceServers: [], relayOnly: true }
    await alice.manager.place(BOB, 'audio')
    await settle()
    await bob.manager.accept()
    await settle()
    expect(view(bob)?.ended?.kind).toBe('relay-needs-turn')
    expect(bob.pcs).toHaveLength(0)
    // The caller is told it failed, without a network diagnosis it has no basis for.
    expect(view(alice)?.ended).toEqual({ kind: 'failed' })
  })
})

describe('camera and microphone', () => {
  it('ends before sending anything when the microphone is refused', async () => {
    alice.media.micError = 'NotAllowedError'
    await alice.manager.place(BOB, 'audio')
    expect(view(alice)?.ended).toEqual({ kind: 'media', media: 'denied' })
    expect(alice.sent).toEqual([])
  })

  it('tells the caller when the answering side cannot open its microphone', async () => {
    bob.media.micError = 'NotReadableError'
    await alice.manager.place(BOB, 'audio')
    await settle()
    await bob.manager.accept()
    await settle()
    expect(view(bob)?.ended).toEqual({ kind: 'media', media: 'busy' })
    expect(bob.sent.at(-1)?.frame).toMatchObject({ kind: 'bye', reason: 'failed' })
    expect(view(alice)?.ended?.kind).toBe('failed')
  })

  it('goes ahead as a voice call when the camera is unavailable', async () => {
    alice.media.cameraError = 'NotReadableError'
    await alice.manager.place(BOB, 'video')
    expect(view(alice)?.notice).toBe('camera-unavailable')
    expect(view(alice)?.local.camera).toBe(false)
    await settle()
    expect(view(bob)?.media).toBe('video')
  })

  it('cannot call at all without media devices', async () => {
    const bare = makeParty('Bare', 'e'.repeat(64), { media: null as unknown as FakeMedia })
    await bare.manager.place(BOB, 'audio')
    expect(view(bare)?.ended).toEqual({ kind: 'media', media: 'missing' })
  })

  it('stops what it opened if the call was hung up while the prompt was showing', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const original = alice.media.getUserMedia.bind(alice.media)
    alice.media.getUserMedia = async (constraints) => {
      await gate
      return original(constraints)
    }
    const placing = alice.manager.place(BOB, 'video')
    alice.manager.hangup()
    release()
    await placing
    expect(alice.media.opened.length).toBeGreaterThan(0)
    expect(alice.media.live).toEqual([])
    expect(alice.sent).toEqual([])
  })
})

describe('signalling integrity', () => {
  it('abandons a call whose fingerprint does not match its SDP', async () => {
    await alice.manager.place(BOB, 'audio')
    await settle()
    const { frame, id } = alice.sent[0] as Party['sent'][number]
    const bobAgain = makeParty('Bob on another device', BOB)
    await bobAgain.manager.handleSignal(
      ALICE,
      { ...frame, fingerprint: 'sha-256 00:11' },
      `${id.slice(0, 63)}0`,
      Date.now(),
    )
    await bobAgain.manager.accept()
    await settle()
    expect(view(bobAgain)?.ended?.kind).toBe('failed')
  })

  it('ignores signals for a call it is not in, or from someone else', async () => {
    await connectedCall()
    const id = view(bob)?.id as string
    await bob.manager.handleSignal(
      CAROL,
      { v: 1, t: 'rtc', kind: 'bye', call: id, reason: 'hangup' },
      id,
      Date.now(),
    )
    await bob.manager.handleSignal(
      ALICE,
      { v: 1, t: 'rtc', kind: 'bye', call: 'f'.repeat(64) },
      'f'.repeat(64),
      Date.now(),
    )
    expect(view(bob)?.phase).toBe('connected')
  })

  it('never trickles a candidate from the side being called before it answers', async () => {
    await alice.manager.place(BOB, 'audio')
    await settle(2000)
    expect(kinds(bob)).toEqual(['ringing'])
    await bob.manager.accept()
    await settle()
    expect(kinds(bob)[1]).toBe('answer')
  })

  it('offers controls as a single entry point', async () => {
    await alice.manager.place(BOB, 'video')
    await settle()
    await bob.manager.control({ type: 'accept', media: 'audio' })
    await settle()
    await alice.manager.control({ type: 'mute', muted: true })
    await alice.manager.control({ type: 'camera', on: false })
    await alice.manager.control({ type: 'flip' })
    await alice.manager.control({ type: 'screen', on: true })
    await settle()
    expect(view(alice)?.local).toMatchObject({ muted: true, camera: false, screen: true })
    await alice.manager.control({ type: 'hangup' })
    await settle()
    expect(view(alice)?.phase).toBe('ended')
    await alice.manager.control({ type: 'dismiss' })
    expect(view(alice)).toBeNull()
    await bob.manager.control({ type: 'decline' })
  })
})

describe('edges', () => {
  it('queues candidates found before the call had an id, and sends them after the offer', async () => {
    // ICE is slow, and so is the outbox: candidates turn up while the
    // offer's id is still unknown.
    const slow = makeParty('Slow', 'd'.repeat(64), {
      gatherGraceMs: 1,
      gatherSpacingMs: 100,
      signalDelayMs: 500,
    })
    await slow.manager.place(BOB, 'audio')
    await settle(3000)
    const [offer, ...rest] = slow.sent
    expect(offer?.frame.kind).toBe('offer')
    expect(rest.length).toBeGreaterThan(0)
    for (const { frame } of rest) expect(frame).toMatchObject({ kind: 'candidate', call: offer?.id })
    // Bob held them while it rang, and uses them when he answers.
    await bob.manager.accept()
    await settle()
    expect(view(bob)?.phase).toBe('connected')
    expect(pc(bob).addedCandidates.length).toBeGreaterThan(0)
  })

  it('sends nothing when hung up while candidates were still gathering', async () => {
    const placing = alice.manager.place(BOB, 'audio')
    await settle(8)
    alice.manager.hangup()
    await placing
    await settle()
    expect(alice.sent).toEqual([])
    expect(alice.records).toEqual([])
    expect(view(alice)?.ended?.kind).toBe('cancelled')
  })

  it('ends with an error when the offer cannot be made or sent', async () => {
    alice.failOffers = true
    await alice.manager.place(BOB, 'audio')
    expect(view(alice)?.ended?.kind).toBe('error')
    expect(isStickyEnd('error')).toBe(true)
    expect(isStickyEnd('hangup')).toBe(false)

    const offline = makeParty('Offline', 'd'.repeat(64), { failSignal: () => true })
    await offline.manager.place(BOB, 'audio')
    expect(view(offline)?.ended?.kind).toBe('error')
    expect(offline.media.live).toEqual([])
  })

  it('carries on when a later signal cannot be sent', async () => {
    bob.failSignal = (frame) => frame.kind === 'ringing'
    await alice.manager.place(BOB, 'audio')
    await settle()
    expect(view(bob)?.phase).toBe('incoming')
    expect(view(alice)?.phase).toBe('outgoing')
  })

  it('takes the other side’s failure as its own once both were connecting', async () => {
    await alice.manager.place(BOB, 'audio')
    await settle()
    alice.online = false // Bob's answer never reaches Alice
    await bob.manager.accept()
    const id = view(bob)?.id as string
    await bob.manager.handleSignal(
      ALICE,
      { v: 1, t: 'rtc', kind: 'bye', call: id, reason: 'failed' },
      id,
      Date.now(),
    )
    expect(view(bob)?.ended?.kind).toBe('failed')
    expect(view(bob)?.ended?.diagnosis).toBeDefined()
    // It was told, so it does not say so back.
    expect(kinds(bob)).not.toContain('bye')
  })

  it('ignores a second ringing, and an answer from a call it is not placing', async () => {
    await alice.manager.place(BOB, 'audio')
    await settle()
    const id = view(alice)?.id as string
    await alice.manager.handleSignal(BOB, { v: 1, t: 'rtc', kind: 'ringing', call: id }, id, Date.now())
    expect(view(alice)?.phase).toBe('ringing')
    await bob.manager.handleSignal(
      ALICE,
      { v: 1, t: 'rtc', kind: 'answer', call: id, sdp: 'v=0' },
      id,
      Date.now(),
    )
    await bob.manager.handleSignal(
      ALICE,
      { v: 1, t: 'rtc', kind: 'offer', call: id, sdp: 'v=0' },
      id,
      Date.now(),
    )
    await bob.manager.handleSignal(ALICE, { v: 1, t: 'rtc', kind: 'candidate', call: id }, id, Date.now())
    expect(view(bob)?.phase).toBe('incoming')
  })

  it('says so when the camera will not turn on', async () => {
    await connectedCall('audio')
    alice.media.cameraError = 'NotReadableError'
    await alice.manager.setCamera(true)
    expect(view(alice)?.notice).toBe('camera-unavailable')
    expect(view(alice)?.local.camera).toBe(false)
  })

  it('goes without a camera when flipping fails both ways', async () => {
    await connectedCall('video')
    alice.media.cameraError = 'NotReadableError'
    await alice.manager.flipCamera()
    await settle()
    expect(view(alice)?.local.camera).toBe(false)
    expect(view(alice)?.notice).toBe('camera-unavailable')
    expect(pc(alice).sending('video')).toBeNull()
    expect(view(bob)?.remote.video).toBe(false)
  })

  it('reopens the same camera when there is no other to flip to', async () => {
    alice.media.cameras = [{ deviceId: 'desk' }]
    await connectedCall('video')
    await alice.manager.flipCamera()
    expect(pc(alice).sending('video')?.settings.deviceId).toBe('desk')
    expect(view(alice)?.local.canFlip).toBe(false)
  })

  it('refuses a video call outright when the microphone is refused too', async () => {
    alice.media.micError = 'NotAllowedError'
    await alice.manager.place(BOB, 'video')
    expect(view(alice)?.ended).toEqual({ kind: 'media', media: 'denied' })
  })

  it('refuses a device that hands back no microphone', async () => {
    const odd = makeParty('Odd', 'd'.repeat(64))
    odd.media.getUserMedia = async () => createFakeStream([])
    odd.media.enumerateDevices = async () => {
      throw new Error('no')
    }
    await odd.manager.place(BOB, 'audio')
    expect(view(odd)?.ended).toEqual({ kind: 'media', media: 'missing' })
  })

  it('does nothing with screen sharing where the browser cannot share', async () => {
    const phone = makeParty('Phone', 'd'.repeat(64), { media: new FakeMedia({ canShare: false }) })
    const other = makeParty('Other', 'e'.repeat(64))
    await phone.manager.place(other.pubkey, 'audio')
    await settle()
    await other.manager.accept()
    await settle()
    await phone.manager.setScreenShare(true)
    expect(view(phone)?.local.screen).toBe(false)
    // …and a picker that returns nothing shares nothing.
    alice.media.getDisplayMedia = async () => createFakeStream([])
    await connectedCall()
    await alice.manager.setScreenShare(true)
    expect(view(alice)?.local.screen).toBe(false)
  })

  it('gives the call up once ICE restarts have run out', async () => {
    await connectedCall()
    network.interrupt(pc(alice))
    await settle(RECOVER_AFTER_MS + 200)
    const cut: NetworkProfile = { stun: false, symmetric: false, turn: false }
    network.profiles.set(pc(alice), cut)
    network.profiles.set(pc(bob), cut)
    for (let i = 0; i < 3 && lastShown(alice)?.phase !== 'ended'; i++) {
      network.interrupt(pc(alice), 'failed')
      await settle(200)
      network.interrupt(pc(alice), 'disconnected')
      await settle(RECOVER_AFTER_MS + 200)
    }
    expect(lastShown(alice)?.ended?.kind).toBe('lost')
    expect(pc(alice).restarts).toBeLessThanOrEqual(MAX_ICE_RESTARTS + 1)
  })
})

describe('every way through the call manager', () => {
  const HARD: NetworkProfile = { stun: true, symmetric: true, turn: false, stall: true }
  const frame = (call: string, rest: Partial<CallFrame>): CallFrame =>
    ({ v: 1, t: 'rtc', call, ...rest }) as CallFrame
  const named = (name: string) => Object.assign(new Error(name), { name })
  const asksFor = (constraints: MediaStreamConstraints) =>
    typeof constraints.video === 'object' && 'deviceId' in constraints.video

  it('does nothing once disposed', async () => {
    alice.manager.dispose()
    await alice.manager.place(BOB, 'audio')
    await alice.manager.handleSignal(BOB, frame('x', { kind: 'ringing' }), 'x', Date.now())
    expect(view(alice)).toBeNull()
    expect(alice.sent).toEqual([])
  })

  it('does nothing when asked to answer, hang up, close or change anything with no call', async () => {
    await bob.manager.accept()
    bob.manager.hangup()
    bob.manager.dismiss()
    bob.manager.setMuted(true)
    await bob.manager.setCamera(true)
    await bob.manager.setScreenShare(true)
    expect(bob.views).toEqual([])
    // A call ringing here: closing it does nothing, hanging up declines it.
    await alice.manager.place(BOB, 'audio')
    await settle()
    bob.manager.dismiss()
    expect(view(bob)?.phase).toBe('incoming')
    bob.manager.hangup()
    expect(view(bob)?.ended?.kind).toBe('declined')
  })

  it('keeps a call that connected while its answer was still being applied', async () => {
    const receive = CallSession.prototype.receive
    const spy = vi.spyOn(CallSession.prototype, 'receive').mockImplementation(async function (
      this: CallSession,
      ...args: Parameters<CallSession['receive']>
    ) {
      const result = await receive.apply(this, args)
      // The browser's checks finish first, as they can.
      if (args[0] === 'answer') await new Promise((resolve) => setTimeout(resolve, 100))
      return result
    })
    // The ringing is held up on the way, and arrives once the call is up.
    bob.failSignal = (sent) => sent.kind === 'ringing'
    await alice.manager.place(BOB, 'audio')
    await settle()
    const id = view(alice)?.id as string
    await bob.manager.accept()
    await settle(60)
    expect(view(alice)?.phase).toBe('connected')
    await alice.manager.handleSignal(BOB, frame(id, { kind: 'ringing' }), id, Date.now())
    await settle(200)
    spy.mockRestore()
    expect(view(alice)?.phase).toBe('connected')
    // Neither timed out nor restarted as a call that never connected.
    await settle(CONNECT_TIMEOUT_MS + ESCALATE_AFTER_MS)
    expect(view(alice)?.phase).toBe('connected')
    expect(kinds(alice).filter((kind) => kind === 'offer')).toHaveLength(1)
  })

  it('takes the callee’s word that the call went unanswered', async () => {
    await alice.manager.place(BOB, 'audio')
    await settle()
    const id = view(alice)?.id as string
    await alice.manager.handleSignal(BOB, frame(id, { kind: 'bye', reason: 'unanswered' }), id, Date.now())
    expect(view(alice)?.ended?.kind).toBe('unanswered')
  })

  it('ignores a renegotiation answer with no description, and takes a bare goodbye as hanging up', async () => {
    await connectedCall()
    const id = view(alice)?.id as string
    await alice.manager.handleSignal(BOB, frame(id, { kind: 'answer' }), id, Date.now())
    expect(view(alice)?.phase).toBe('connected')
    await alice.manager.handleSignal(BOB, frame(id, { kind: 'bye' }), id, Date.now())
    expect(view(alice)?.ended?.kind).toBe('hangup')
  })

  it('holds at most 64 candidates for a call still ringing', async () => {
    await alice.manager.place(BOB, 'audio')
    await settle()
    const id = view(bob)?.id as string
    const ufrag = /a=ice-ufrag:(\S+)/.exec(alice.sent[0]?.frame.sdp ?? '')?.[1]
    for (let i = 0; i < 70; i++) {
      const candidate = `candidate:${i} 1 udp 1 10.0.0.${i} 9 typ host ufrag ${ufrag}`
      await bob.manager.handleSignal(
        ALICE,
        frame(id, { kind: 'candidate', candidate: { candidate, sdpMid: '0', sdpMLineIndex: 0 } }),
        id,
        Date.now(),
      )
    }
    await bob.manager.accept()
    await settle()
    expect(pc(bob).addedCandidates.filter((added) => added.candidate?.includes(' 10.0.0.'))).toHaveLength(64)
  })

  it('stays on its call when saying busy, or noting the missed call, fails', async () => {
    const carol = makeParty('Carol', CAROL)
    await connectedCall()
    bob.failSignal = (sent) => sent.kind === 'bye'
    bob.failRecord = true
    await carol.manager.place(BOB, 'audio')
    await settle()
    expect(view(bob)).toMatchObject({ phase: 'connected', peer: ALICE })
    expect(bob.records).toEqual([])
  })

  it('counts a call still ringing as missed when its caller starts over', async () => {
    await alice.manager.place(BOB, 'audio')
    await settle()
    const first = view(bob)?.id
    const again = makeParty('Alice again', ALICE)
    await again.manager.place(BOB, 'audio')
    await settle()
    expect(view(bob)).toMatchObject({ phase: 'incoming', id: again.sent[0]?.id })
    expect(bob.records).toEqual([
      expect.objectContaining({ id: first, record: { media: 'audio', outcome: 'missed' } }),
    ])
  })

  it('answers an offer that states no fingerprint beside its description', async () => {
    await alice.manager.place(BOB, 'audio')
    await settle()
    const { frame: offer, id } = alice.sent[0] as Party['sent'][number]
    const dave = makeParty('Dave', 'd'.repeat(64))
    await dave.manager.handleSignal(ALICE, { ...offer, fingerprint: undefined }, id, Date.now())
    await dave.manager.accept()
    await settle()
    expect(kinds(dave)).toContain('answer')
  })

  it('fails a call it cannot answer, or that the browser gives no answer for', async () => {
    for (const broken of [
      () => Promise.reject(new Error('createAnswer failed')),
      () => Promise.resolve(null),
      // Hung up while the answer was being made, then the browser failed too: one ending.
      async () => {
        bob.manager.hangup()
        throw new Error('closed')
      },
    ]) {
      const spy = vi.spyOn(CallSession.prototype, 'receive').mockImplementationOnce(broken)
      await alice.manager.place(BOB, 'audio')
      await settle()
      await bob.manager.accept()
      spy.mockRestore()
      expect(['failed', 'hangup']).toContain(lastShown(bob)?.ended?.kind)
      bob.manager.dismiss()
      alice.manager.hangup()
      await settle(ENDED_LINGER_MS + 100)
    }
    // Hanging up an answered call is a call that happened, however short.
    expect(bob.records.map(({ record }) => record.outcome)).toEqual(['failed', 'failed', 'completed'])
  })

  it('ignores an answer with no description, and ends on one whose fingerprint does not match', async () => {
    await alice.manager.place(BOB, 'audio')
    await settle()
    const id = view(alice)?.id as string
    await alice.manager.handleSignal(BOB, frame(id, { kind: 'answer' }), id, Date.now())
    expect(view(alice)?.phase).toBe('ringing')
    alice.online = false
    await bob.manager.accept()
    await settle()
    const answer = bob.sent.find(({ frame: sent }) => sent.kind === 'answer')?.frame as CallFrame
    await alice.manager.handleSignal(BOB, { ...answer, fingerprint: 'sha-256 00:00' }, id, Date.now())
    expect(view(alice)?.ended?.kind).toBe('failed')
  })

  it('gives up when the connection never comes up, whatever was tried', async () => {
    alice.profile = HARD
    bob.profile = HARD
    // The callee gives up first; its goodbye is lost, so the caller's own clock decides.
    bob.failSignal = (sent) => sent.kind === 'bye'
    await alice.manager.place(BOB, 'audio')
    await settle()
    await bob.manager.accept()
    // The caller's clock starts when the answer reaches it.
    await settle(CONNECT_TIMEOUT_MS + 500)
    expect(lastShown(alice)?.ended?.kind).toBe('failed')
  })

  it('opens the microphone muted when muted while it rang', async () => {
    await alice.manager.place(BOB, 'audio')
    await settle()
    bob.manager.setMuted(true)
    expect(view(bob)?.local.muted).toBe(true)
    await bob.manager.accept()
    await settle()
    expect(bob.media.opened.find((track) => track.kind === 'audio')?.enabled).toBe(false)
  })

  it('leaves a shared screen on the call while the camera turns off, on, or over', async () => {
    await connectedCall('video')
    await alice.manager.setScreenShare(true)
    const screen = pc(alice).sending('video')
    await alice.manager.setCamera(false)
    await alice.manager.setCamera(true)
    await alice.manager.flipCamera()
    expect(pc(alice).sending('video')).toBe(screen)
    expect(view(alice)?.local).toMatchObject({ camera: true, screen: true, facing: 'environment' })
    // Already so: nothing to do.
    await alice.manager.setCamera(true)
    await alice.manager.setScreenShare(true)
    expect(pc(alice).sending('video')).toBe(screen)
    // And back to the front camera.
    await alice.manager.flipCamera()
    expect(view(alice)?.local.facing).toBe('user')
  })

  it('lets go of a camera that opens after the vault locked', async () => {
    await connectedCall('audio')
    const opening = alice.manager.setCamera(true)
    alice.manager.dispose()
    await opening
    expect(alice.media.live).toEqual([])
  })

  it('lets go of a flipped camera that opens after the vault locked', async () => {
    await connectedCall('video')
    const flipping = alice.manager.flipCamera()
    alice.manager.dispose()
    await flipping
    expect(alice.media.live).toEqual([])
  })

  it('lets go of a screen that arrives after the vault locked', async () => {
    await connectedCall('audio')
    const sharing = alice.manager.setScreenShare(true)
    alice.manager.dispose()
    await sharing
    expect(alice.media.live).toEqual([])
  })

  it('says the camera is unavailable when the device hands back no picture', async () => {
    await connectedCall('audio')
    const open = alice.media.getUserMedia.bind(alice.media)
    alice.media.getUserMedia = async (constraints) =>
      constraints.video ? createFakeStream([]) : open(constraints)
    await alice.manager.setCamera(true)
    expect(view(alice)?.notice).toBe('camera-unavailable')
  })

  it('shares a screen whose track takes no content hint, and ignores its end once sharing stopped', async () => {
    await connectedCall()
    const track = new FakeTrack('video', { displaySurface: 'window' })
    delete (track as { contentHint?: string }).contentHint
    alice.media.getDisplayMedia = async () => createFakeStream([track as unknown as MediaStreamTrack])
    await alice.manager.setScreenShare(true)
    expect(view(alice)?.local.screen).toBe(true)
    await alice.manager.setScreenShare(false)
    track.end()
    await settle(10)
    expect(view(alice)?.local.screen).toBe(false)
  })

  it('fails cleanly on a media backend that breaks in a way nobody planned for', async () => {
    alice.media.getUserMedia = async () => ({}) as MediaStream
    await alice.manager.place(BOB, 'audio')
    expect(view(alice)?.ended).toEqual({ kind: 'media', media: 'failed' })
  })

  it('offers no camera flip when the device list cannot be read', async () => {
    alice.media.enumerateDevices = () => Promise.reject(named('SecurityError'))
    await connectedCall('video')
    expect(view(alice)?.local.canFlip).toBe(false)
  })

  it('keeps the same camera when the next one will not open, or shows nothing', async () => {
    alice.media.cameras = [{ deviceId: 'one' }, { deviceId: 'two' }]
    await connectedCall('video')
    const open = alice.media.getUserMedia.bind(alice.media)
    alice.media.getUserMedia = async (constraints) => {
      if (asksFor(constraints)) throw named('NotReadableError')
      return open(constraints)
    }
    await alice.manager.flipCamera()
    expect(view(alice)?.local.camera).toBe(true)
    alice.media.getUserMedia = async (constraints) =>
      asksFor(constraints) ? createFakeStream([]) : open(constraints)
    await alice.manager.flipCamera()
    expect(view(alice)?.local.camera).toBe(true)
  })

  it('pays no attention to how a call was connected once it is over', async () => {
    await alice.manager.place(BOB, 'audio')
    await settle()
    pc(alice).getStats = () => new Promise((resolve) => setTimeout(() => resolve(new Map()), 200))
    await bob.manager.accept()
    await settle(100)
    expect(view(alice)?.phase).toBe('connected')
    alice.manager.hangup()
    await settle(300)
    expect(lastShown(alice)?.path).toBeNull()
  })

  it('leaves a drop before the call ever connected to the connect timeout', async () => {
    alice.profile = HARD
    bob.profile = HARD
    await alice.manager.place(BOB, 'audio')
    await settle()
    await bob.manager.accept()
    await settle(100)
    network.interrupt(pc(alice), 'disconnected')
    await settle(RECOVER_AFTER_MS + 100)
    expect(view(alice)?.phase).toBe('connecting')
    expect(pc(alice).restarts).toBe(0)
  })

  it('gives up a dropped call that neither recovers nor fails outright', async () => {
    await connectedCall()
    const hung: NetworkProfile = { stun: false, symmetric: false, turn: false, stall: true }
    network.profiles.set(pc(alice), hung)
    network.profiles.set(pc(bob), hung)
    network.interrupt(pc(alice), 'disconnected')
    await settle(100)
    // Reported failed too: the clock already running is the one that counts.
    network.interrupt(pc(alice), 'failed')
    await settle(LOST_AFTER_MS)
    expect(lastShown(alice)?.ended?.kind).toBe('lost')
  })

  it('fails a call the other side gave up on while this side was still opening its microphone', async () => {
    await alice.manager.place(BOB, 'audio')
    await settle()
    const id = view(bob)?.id as string
    const answering = bob.manager.accept()
    await bob.manager.handleSignal(ALICE, frame(id, { kind: 'bye', reason: 'failed' }), id, Date.now())
    await answering
    expect(lastShown(bob)?.ended?.kind).toBe('failed')
    expect(bob.pcs).toHaveLength(0)
    expect(bob.media.live).toEqual([])
  })

  it('ends a call once when its microphone fails after it was already hung up', async () => {
    alice.media.micError = 'NotAllowedError'
    const placing = alice.manager.place(BOB, 'audio')
    alice.manager.hangup()
    await placing
    expect(view(alice)?.ended?.kind).toBe('cancelled')
  })

  it('carries on when the call cannot be written into the conversation', async () => {
    alice.failRecord = true
    await connectedCall()
    alice.manager.hangup()
    await settle()
    expect(lastShown(alice)?.ended?.kind).toBe('hangup')
    expect(alice.records).toEqual([])
  })

  it('sends no answer to a renegotiation once the call has ended', async () => {
    await connectedCall()
    const receive = CallSession.prototype.receive
    const spy = vi.spyOn(CallSession.prototype, 'receive').mockImplementationOnce(async function (
      this: CallSession,
      ...args: Parameters<CallSession['receive']>
    ) {
      const answer = await receive.apply(this, args)
      bob.manager.hangup()
      return answer
    })
    await alice.manager.setCamera(true)
    await settle()
    spy.mockRestore()
    expect(kinds(bob).filter((kind) => kind === 'answer')).toHaveLength(1)
    expect(kinds(bob).at(-1)).toBe('bye')
  })
})

describe('IPv6 (ADR-069)', () => {
  const HARD: NetworkProfile = { stun: true, symmetric: true, turn: false }

  it('connects directly over IPv6 when both sides have it, whatever their IPv4 NATs do', async () => {
    alice.profile = { ...HARD, ipv6: true }
    bob.profile = { ...HARD, ipv6: true }
    alice.config = { iceServers: [TURN], relayOnly: false }
    await connectedCall()
    expect(view(alice)?.path).toBe('direct')
    // Nothing needed TURN, so nothing restarted to bring it in.
    expect(pc(alice).reconfigured).toEqual([])
    expect(kinds(alice).filter((kind) => kind === 'offer')).toHaveLength(1)
  })
})

describe('a failed call is only a failed call (ADR-071)', () => {
  const HARD: NetworkProfile = { stun: true, symmetric: true, turn: false }
  /** Nothing of a walkie-talkie anywhere: no session, no subscription, nothing sent, no microphone for it. */
  const noRadio = (party: Party) => {
    expect(view(party)?.voice ?? null).toBeNull()
    expect(voiceRelays.subscriptions.size).toBe(0)
    expect(voiceRelays.published).toHaveLength(0)
    expect(party.voice.capturing).toBe(false)
  }

  it('ends a call no path could carry on its failure, with no walkie-talkie', async () => {
    alice.profile = HARD
    bob.profile = HARD
    await alice.manager.place(BOB, 'audio')
    await settle()
    await bob.manager.accept()
    await settle(CONNECT_TIMEOUT_MS + 500)
    for (const party of [alice, bob]) {
      expect(view(party)?.ended?.kind).toBe('failed')
      expect(view(party)?.ended?.diagnosis?.kind).toBe('symmetric-nat')
      noRadio(party)
    }
    // It waits to be read, and closes like any other ending.
    alice.manager.dismiss()
    expect(view(alice)).toBeNull()
  })

  it('ends a call that was lost the ordinary way, and closes by itself', async () => {
    await connectedCall()
    const cut: NetworkProfile = { stun: false, symmetric: false, turn: false }
    network.profiles.set(pc(alice), cut)
    network.profiles.set(pc(bob), cut)
    network.interrupt(pc(alice), 'failed')
    await settle(LOST_AFTER_MS + ENDED_LINGER_MS)
    expect(lastShown(alice)?.ended?.kind).toBe('lost')
    expect(lastShown(alice)?.voice).toBeNull()
    expect(view(alice)).toBeNull()
    noRadio(alice)
  })

  it('stays out of a video call too, and of one that failed before trying any path', async () => {
    bob.media.micError = 'NotReadableError'
    await alice.manager.place(BOB, 'video')
    await settle()
    await bob.manager.accept()
    await settle()
    expect(view(alice)?.ended?.kind).toBe('failed')
    noRadio(alice)
    noRadio(bob)
  })

  it('fails a call whose fingerprint does not match its description, with no walkie-talkie', async () => {
    await alice.manager.place(BOB, 'audio')
    await settle()
    const { frame, id } = alice.sent.at(-1) as Party['sent'][number]
    const other = makeParty('Bob elsewhere', 'e'.repeat(64))
    await other.manager.handleSignal(ALICE, { ...frame, fingerprint: 'sha-256 00:11' }, id, Date.now())
    await other.manager.accept()
    await settle()
    expect(view(other)?.ended?.kind).toBe('failed')
    noRadio(other)
  })

  it('has nothing to hold down outside a walkie-talkie', async () => {
    await connectedCall()
    await alice.manager.control({ type: 'talk', on: true })
    expect(view(alice)?.voice).toBeNull()
    expect(alice.voice.capturing).toBe(false)
    expect(voiceRelays.published).toHaveLength(0)
  })
})

describe('walkie-talkies (ADR-070)', () => {
  const HARD: NetworkProfile = { stun: true, symmetric: true, turn: false }
  const voice = (party: Party) => view(party)?.voice ?? null
  const radio = async () => {
    await alice.manager.place(BOB, 'radio')
    await settle()
    await bob.manager.accept()
    await settle()
  }

  it('rings as a walkie-talkie, and talks both ways the moment it is answered — with no peer connection', async () => {
    // Networks no call gets through: a walkie-talkie needs only the relays.
    alice.profile = HARD
    bob.profile = HARD
    await alice.manager.place(BOB, 'radio')
    await settle()
    expect(view(bob)).toMatchObject({ phase: 'incoming', media: 'radio' })
    expect(view(alice)?.phase).toBe('ringing')
    const offer = alice.sent[0]?.frame
    expect(offer).toMatchObject({ kind: 'offer', media: 'radio' })
    expect(readRadio(offer?.sdp ?? '')?.listen).toEqual(expect.arrayContaining([...VOICE_RELAYS]))

    await bob.manager.accept()
    await settle()
    for (const party of [alice, bob]) {
      expect(view(party)).toMatchObject({ phase: 'connected', voice: { state: 'live', peerHere: true } })
      expect(party.pcs).toEqual([])
    }
    alice.manager.talk(true)
    alice.voice.speak(10, 4)
    alice.manager.talk(false)
    await settle()
    expect(bob.voice.played.map((frame) => frame[0])).toEqual(Array<number>(10).fill(4))
    bob.manager.talk(true)
    bob.voice.speak(3, 5)
    bob.manager.talk(false)
    await settle()
    expect(alice.voice.played).toHaveLength(3)

    // Hung up from either side, it is in both conversations, with its length.
    await settle(1500)
    bob.manager.hangup()
    await settle()
    for (const party of [alice, bob]) {
      expect(party.records.at(-1)?.record).toMatchObject({ media: 'radio', outcome: 'completed' })
      expect(party.records.at(-1)?.record.durationMs).toBeGreaterThanOrEqual(1000)
      expect(party.voice.capturing).toBe(false)
    }
  })

  it('says so when this browser cannot do it, on either side', async () => {
    alice.voice.isSupported = false
    await alice.manager.place(BOB, 'radio')
    expect(view(alice)?.ended?.kind).toBe('radio-unsupported')
    expect(alice.sent).toEqual([])
    alice.manager.dismiss()

    alice.voice.isSupported = true
    bob.voice.isSupported = false
    await radio()
    expect(view(bob)?.ended?.kind).toBe('radio-unsupported')
    expect(view(alice)?.ended?.kind).toBe('failed')
  })

  it('ends when the microphone or speaker will not start', async () => {
    bob.voice.captureError = new Error('NotAllowedError')
    await radio()
    expect(view(bob)?.ended).toEqual({ kind: 'media', media: 'failed' })
    expect(view(alice)?.ended?.kind).toBe('failed')
  })

  it('fails an offer or answer whose description it cannot read', async () => {
    await alice.manager.place(BOB, 'radio')
    await settle()
    const { frame, id } = alice.sent[0] as Party['sent'][number]
    const other = makeParty('Bob elsewhere', 'e'.repeat(64))
    await other.manager.handleSignal(ALICE, { ...frame, sdp: 'v=0' }, `${id.slice(0, 63)}0`, Date.now())
    await other.manager.accept()
    expect(view(other)?.ended?.kind).toBe('failed')

    alice.online = false
    await bob.manager.accept()
    await settle()
    const answer = bob.sent.find(({ frame: sent }) => sent.kind === 'answer')?.frame as CallFrame
    await alice.manager.handleSignal(BOB, { ...answer, sdp: '{}' }, id, Date.now())
    expect(view(alice)?.ended?.kind).toBe('failed')
  })

  it('stops wherever it is when hung up: before the offer, before answering, while joining', async () => {
    const placing = alice.manager.place(BOB, 'radio')
    alice.manager.hangup()
    await placing
    expect(alice.sent).toEqual([])
    alice.manager.dismiss()

    await alice.manager.place(BOB, 'radio')
    await settle()
    const answering = bob.manager.accept()
    bob.manager.hangup()
    await answering
    expect(bob.voice.capturing).toBe(false)
    expect(kinds(bob)).not.toContain('answer')
    await settle(ENDED_LINGER_MS)

    await alice.manager.place(BOB, 'radio')
    await settle()
    bob.voice.captureError = null
    const joining = bob.manager.accept()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    bob.manager.hangup()
    await joining
    expect(view(bob)?.phase ?? 'ended').toBe('ended')
    expect(bob.voice.capturing).toBe(false)
  })

  it('ends with an error when the offer cannot be sent', async () => {
    alice.failSignal = () => true
    await alice.manager.place(BOB, 'radio')
    expect(view(alice)?.ended?.kind).toBe('error')
  })

  it('connects once when both press at the same moment', async () => {
    const both = Promise.all([alice.manager.place(BOB, 'radio'), bob.manager.place(ALICE, 'radio')])
    await both
    await settle(300)
    for (const party of [alice, bob]) expect(voice(party)?.state).toBe('live')
  })
})
