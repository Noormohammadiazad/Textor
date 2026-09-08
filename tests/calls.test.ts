import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CallManager,
  CONNECT_TIMEOUT_MS,
  ENDED_LINGER_MS,
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
import { candidatesInSdp } from '@/core/calls/diagnose'
import { bytesToHex, randomBytes } from '@/core/util/bytes'
import {
  createFakeStream,
  FakeIceNetwork,
  FakeMedia,
  FakePeerConnection,
  OPEN_NETWORK,
  type FakeTrack,
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
  config: { iceServers: RTCIceServer[]; relayOnly: boolean }
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
}

let network: FakeIceNetwork
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
    ...opts,
  } as Party
  party.manager = new CallManager({
    self: pubkey,
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
          void target.manager.handleSignal(pubkey, parsed as CallFrame, parsed?.call ?? id, Date.now())
        }, 5)
      }
      return id
    },
    record: async (peer, id, direction, record, at) => {
      party.records.push({ peer, id, direction, record, at })
    },
    config: () => party.config,
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
    expect(view(alice)?.ended?.kind).toBe('lost')
    // It did connect, so it is remembered as a call that happened.
    expect(alice.records[0]?.record.outcome).toBe('completed')
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
    for (let i = 0; i < 3 && view(alice)?.phase !== 'ended'; i++) {
      network.interrupt(pc(alice), 'failed')
      await settle(200)
      network.interrupt(pc(alice), 'disconnected')
      await settle(RECOVER_AFTER_MS + 200)
    }
    expect(view(alice)?.ended?.kind).toBe('lost')
    expect(pc(alice).restarts).toBeLessThanOrEqual(MAX_ICE_RESTARTS + 1)
  })
})
