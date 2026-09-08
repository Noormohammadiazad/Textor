import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CallSession, MAX_RENEGOTIATIONS_PER_MINUTE, type SessionSignal } from '@/core/calls/callSession'
import { createCallManager } from '@/core/calls/browserCalls'
import type { Messenger } from '@/core/engine/messenger'
import { DEFAULT_ICE_SERVERS } from '@/core/transport/defaultRelays'
import {
  FakeIceNetwork,
  FakeMedia,
  FakePeerConnection,
  FakeStream,
  FakeTrack,
  type NetworkProfile,
} from './fakeRtc'

/**
 * One call's peer connection on its own: the negotiation rules the call
 * manager relies on, exercised directly between two sessions.
 */

let network: FakeIceNetwork

interface Side {
  pc: FakePeerConnection
  session: CallSession
  signals: SessionSignal[]
}

function side(
  polite: boolean,
  opts: { profile?: NetworkProfile; iceServers?: RTCIceServer[]; fallback?: RTCIceServer[] } = {},
): Side {
  const pc = new FakePeerConnection({ iceServers: opts.iceServers ?? [] }, network, opts.profile)
  const session = new CallSession(pc as unknown as RTCPeerConnection, {
    polite,
    gatherGraceMs: 100,
    fallback: opts.fallback,
  })
  const signals: SessionSignal[] = []
  session.events.on('signal', (signal) => signals.push(signal))
  return { pc, session, signals }
}

const settle = (ms = 300) => vi.advanceTimersByTimeAsync(ms)
const track = (kind: 'audio' | 'video') => new FakeTrack(kind) as unknown as MediaStreamTrack

/** Open a call between two sessions, the way the manager does. */
async function connect(caller: Side, callee: Side): Promise<void> {
  await caller.session.setTrack('audio', track('audio'))
  const offer = await caller.session.offer()
  await callee.session.setTrack('audio', track('audio'))
  const answer = await callee.session.receive('offer', offer.sdp, offer.fingerprint)
  await caller.session.receive('answer', answer?.sdp ?? '', answer?.fingerprint)
  await settle()
}

/** Carry every description one side has made to the other, and the replies back. */
async function relay(from: Side, to: Side): Promise<void> {
  for (const signal of from.signals.splice(0)) {
    if (signal.kind === 'candidate') await to.session.addCandidate(signal.candidate)
    else {
      const reply = await to.session.receive(signal.kind, signal.sdp, signal.fingerprint)
      if (reply) to.signals.push({ kind: 'answer', ...reply })
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  network = new FakeIceNetwork()
})

afterEach(() => vi.useRealTimers())

describe('a call session', () => {
  it('connects, and opens its media-state channel', async () => {
    const a = side(true)
    const b = side(false)
    const phases: string[] = []
    a.session.events.on('connection', (phase) => phases.push(phase))
    a.session.sendState({ audio: true, video: false, screen: false })
    const seen: unknown[] = []
    b.session.events.on('remoteState', (state) => seen.push(state))
    await connect(a, b)
    expect(a.session.phase).toBe('connected')
    expect(phases).toContain('connected')
    // Sent before the channel was open, delivered once it was.
    expect(seen).toEqual([{ audio: true, video: false, screen: false }])
  })

  it('does not renegotiate before the call has connected, and does once it has', async () => {
    const a = side(true)
    const b = side(false)
    await a.session.setTrack('audio', track('audio'))
    const offer = await a.session.offer()
    // Video asked for while the call is still ringing.
    await a.session.setTrack('video', track('video'))
    await settle()
    expect(a.signals).toEqual([])
    await b.session.setTrack('audio', track('audio'))
    const answer = await b.session.receive('offer', offer.sdp, offer.fingerprint)
    await a.session.receive('answer', answer?.sdp ?? '', answer?.fingerprint)
    await settle()
    expect(a.signals.map((s) => s.kind)).toContain('offer')
  })

  it('stops renegotiating when two sides cannot stop disagreeing', async () => {
    const a = side(true)
    const b = side(false)
    await connect(a, b)
    for (let i = 0; i < MAX_RENEGOTIATIONS_PER_MINUTE + 3; i++) {
      a.pc.restartIce()
      await settle(50)
      await relay(a, b)
      await relay(b, a)
      await settle(50)
    }
    expect(a.pc.restarts).toBe(MAX_RENEGOTIATIONS_PER_MINUTE + 3)
    const offers = a.pc.localDescription
    expect(offers).not.toBeNull()
    // Only so many offers went out in the minute.
    const sent = vi.fn()
    a.session.events.on('signal', sent)
    a.pc.restartIce()
    await settle(50)
    expect(sent).not.toHaveBeenCalled()
    await settle(61_000)
    a.pc.restartIce()
    await settle(50)
    expect(sent).toHaveBeenCalled()
  })

  it('yields to the other side’s offer only when it is the polite one', async () => {
    const polite = side(true)
    const rude = side(false)
    await connect(polite, rude)
    // Both turn a camera on at once.
    await polite.session.setTrack('video', track('video'))
    await rude.session.setTrack('video', track('video'))
    await settle(50)
    const politeOffer = polite.signals.find((s) => s.kind === 'offer')
    const rudeOffer = rude.signals.find((s) => s.kind === 'offer')
    expect(politeOffer && rudeOffer).toBeTruthy()
    // The impolite side ignores the colliding offer…
    expect(await rude.session.receive('offer', (politeOffer as { sdp: string }).sdp)).toBeNull()
    // …and the polite side rolls its own back and answers.
    const answer = await polite.session.receive('offer', (rudeOffer as { sdp: string }).sdp)
    expect(answer?.sdp).toContain('a=')
    await rude.session.receive('answer', answer?.sdp ?? '')
    expect(rude.pc.signalingState).toBe('stable')
    expect(polite.pc.signalingState).toBe('stable')
  })

  it('drops an answer to an offer it no longer has', async () => {
    const a = side(true)
    const b = side(false)
    await connect(a, b)
    expect(await a.session.receive('answer', b.pc.localDescription?.sdp ?? '')).toBeNull()
  })

  it('holds a candidate that overtook its description, and uses it once that arrives', async () => {
    const a = side(true)
    const b = side(false)
    const early = {
      candidate: 'candidate:9 1 udp 1 1.2.3.4 9 typ host ufrag nobody',
      sdpMid: '0',
      sdpMLineIndex: 0,
    }
    await b.session.addCandidate(early)
    expect(b.pc.addedCandidates).toEqual([])
    await connect(a, b)
    // Wrong ICE generation for the description that came: still held, not lost.
    expect(b.pc.addedCandidates).toEqual([])
    const ufrag = /a=ice-ufrag:(\S+)/.exec(a.pc.localDescription?.sdp ?? '')?.[1]
    await b.session.addCandidate({
      ...early,
      candidate: `candidate:9 1 udp 1 1.2.3.4 9 typ host ufrag ${ufrag}`,
    })
    expect(b.pc.addedCandidates).toHaveLength(1)
  })

  it('refuses a description whose fingerprint does not match', async () => {
    const a = side(true)
    const b = side(false)
    const mismatch = vi.fn()
    b.session.events.on('mismatch', mismatch)
    await a.session.setTrack('audio', track('audio'))
    const offer = await a.session.offer()
    expect(await b.session.receive('offer', offer.sdp, 'sha-256 00:00')).toBeNull()
    expect(mismatch).toHaveBeenCalled()
  })

  it('restarts ICE by hand where the browser has no restartIce', async () => {
    const a = side(true)
    const b = side(false)
    await connect(a, b)
    ;(a.pc as { restartIce?: unknown }).restartIce = undefined
    a.session.restartIce()
    await settle(50)
    const offer = a.signals.find((s) => s.kind === 'offer') as { sdp: string } | undefined
    expect(offer?.sdp).toMatch(/ice-ufrag:\S+g1/)
  })

  it('says whether media is direct or relayed, and nothing when it cannot tell', async () => {
    const a = side(true)
    const b = side(false)
    await connect(a, b)
    expect(await a.session.selectedPath()).toBe('direct')
    a.pc.getStats = async () => {
      throw new Error('gone')
    }
    expect(await a.session.selectedPath()).toBeNull()
    a.pc.getStats = async () => new Map()
    expect(await a.session.selectedPath()).toBeNull()
  })

  it('does nothing once closed', async () => {
    const a = side(true)
    a.session.close()
    a.session.close()
    expect(a.pc.closed).toBe(true)
    expect(a.session.phase).toBe('closed')
    await a.session.setTrack('audio', track('audio'))
    await a.session.addCandidate({
      candidate: 'candidate:1 1 udp 1 1.2.3.4 9 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    })
    expect(await a.session.receive('offer', 'v=0')).toBeNull()
    a.session.restartIce()
    expect(a.pc.getTransceivers()).toEqual([])
  })
})

describe('a call session’s rarer turns', () => {
  it('abandons its own offer when the other side’s arrives while it is being made', async () => {
    const a = side(true)
    const b = side(false)
    await connect(a, b)
    await b.session.setTrack('video', track('video'))
    await settle(50)
    const theirs = b.signals.find((signal) => signal.kind === 'offer') as { sdp: string }
    const createOffer = a.pc.createOffer.bind(a.pc)
    a.pc.createOffer = async (options) => {
      const ours = await createOffer(options)
      await a.pc.setRemoteDescription({ type: 'offer', sdp: theirs.sdp })
      return ours
    }
    await a.session.setTrack('video', track('video'))
    await settle(50)
    expect(a.signals.filter((signal) => signal.kind === 'offer')).toEqual([])
    expect(a.pc.signalingState).toBe('have-remote-offer')
  })

  it('carries on when a renegotiation cannot be made', async () => {
    const a = side(true)
    const b = side(false)
    await connect(a, b)
    a.pc.failOffers = true
    await a.session.setTrack('video', track('video'))
    await settle(50)
    expect(a.signals.filter((signal) => signal.kind === 'offer')).toEqual([])
    expect(a.session.phase).toBe('connected')
  })

  it('finds the path from the nominated pair where the browser names no selected one', async () => {
    const a = side(true)
    const pair = { id: 'P', type: 'candidate-pair', nominated: true, state: 'succeeded' }
    a.pc.getStats = async () =>
      new Map([
        ['P', { ...pair, localCandidateId: 'L', remoteCandidateId: 'R' }],
        ['L', { id: 'L', type: 'local-candidate', candidateType: 'host' }],
        ['R', { id: 'R', type: 'remote-candidate', candidateType: 'relay' }],
      ])
    expect(await a.session.selectedPath()).toBe('relay')
    a.pc.getStats = async () => new Map([['P', pair]])
    expect(await a.session.selectedPath()).toBe('direct')
    expect(await a.session.relayUse()).toBeNull()
    a.pc.getStats = async () => new Map([['P', { ...pair, state: 'in-progress' }]])
    expect(await a.session.selectedPath()).toBeNull()
    expect(await a.session.relayUse()).toBeNull()
  })

  it('sends a description without a fingerprint as it is', async () => {
    const a = side(true)
    const createOffer = a.pc.createOffer.bind(a.pc)
    a.pc.createOffer = async (options) => {
      const offer = await createOffer(options)
      return { ...offer, sdp: offer.sdp.replace(/^a=fingerprint:.*\r\n/m, '') }
    }
    await a.session.setTrack('audio', track('audio'))
    expect(await a.session.offer()).not.toHaveProperty('fingerprint')
  })

  it('holds at most 64 candidates that came before their description', async () => {
    const a = side(true)
    const b = side(false)
    await a.session.setTrack('audio', track('audio'))
    const offer = await a.session.offer()
    const ufrag = /a=ice-ufrag:(\S+)/.exec(offer.sdp)?.[1]
    for (let i = 0; i < 70; i++) {
      await b.session.addCandidate({
        candidate: `candidate:${i} 1 udp 1 10.0.0.${i} 9 typ host ufrag ${ufrag}`,
        sdpMid: '0',
        sdpMLineIndex: 0,
      })
    }
    await b.session.receive('offer', offer.sdp, offer.fingerprint)
    expect(b.pc.addedCandidates.filter((added) => added.candidate?.includes(' 10.0.0.'))).toHaveLength(64)
  })

  it('waits for no candidates once gathering is complete, or the session is closed', async () => {
    for (const end of ['complete', 'closed'] as const) {
      const a = side(true)
      a.pc.gatherSpacingMs = 600_000
      const setLocal = a.pc.setLocalDescription.bind(a.pc)
      a.pc.setLocalDescription = async (description) => {
        await setLocal(description)
        if (end === 'complete') a.pc.iceGatheringState = 'complete'
        else a.session.close()
      }
      await a.session.setTrack('audio', track('audio'))
      const late = new Promise((resolve) => setTimeout(() => resolve('late'), 50))
      expect(await Promise.race([a.session.offer().then(() => 'prompt'), late])).toBe('prompt')
    }
  })

  it('shrugs off a media state it cannot send, or cannot read', async () => {
    const a = side(true)
    const b = side(false)
    const seen = vi.fn()
    b.session.events.on('remoteState', seen)
    await connect(a, b)
    const before = seen.mock.calls.length
    ;(a.pc.channel as { send: (data: string) => void }).send = () => {
      throw new Error('closing')
    }
    a.session.sendState({ audio: true, video: false, screen: false })
    b.pc.channel?.onmessage?.({ data: 'not a state' })
    await settle(10)
    expect(seen.mock.calls.length).toBe(before)
  })
})

describe('falling back to TURN (ADR-068)', () => {
  const TURN_A: RTCIceServer = { urls: 'turn:a.example', username: 'u', credential: 'p' }
  const TURN_B: RTCIceServer = { urls: 'turns:b.example:443?transport=tcp', username: 'u', credential: 'bad' }
  const TURN_C: RTCIceServer = { urls: 'turn:c.example', username: 'u', credential: 'p' }
  const SYMMETRIC: NetworkProfile = { stun: true, symmetric: true, turn: true }
  const hasTurn = (config: RTCConfiguration | undefined) =>
    (config?.iceServers ?? []).some((server) => String(server.urls).startsWith('turn'))

  it('holds TURN back, and brings it in when the caller restarts before the call has connected', async () => {
    const caller = side(true, { profile: SYMMETRIC, fallback: [TURN_A] })
    const callee = side(false, { profile: { ...SYMMETRIC, turn: false } })
    const restarted = vi.fn()
    caller.session.events.on('restarted', restarted)
    await connect(caller, callee)
    // Direct paths only, and they cannot meet.
    expect(hasTurn(caller.pc.config)).toBe(false)
    expect(caller.pc.connectionState).toBe('failed')
    expect(caller.session.restarted).toBe(false)

    const before = caller.session.askedAt
    await settle(10)
    caller.session.restartIce()
    expect(caller.session.restarted).toBe(true)
    expect(restarted).toHaveBeenCalledTimes(1)
    expect(caller.session.askedAt).toBeGreaterThan(before)
    expect(hasTurn(caller.pc.reconfigured[0])).toBe(true)
    await settle(50)
    // The offer goes out although the call never connected: the callee
    // already holds both descriptions, so nothing can overtake it.
    expect(caller.signals.map((signal) => signal.kind)).toContain('offer')
    await relay(caller, callee)
    await relay(callee, caller)
    await settle()
    expect(caller.pc.connectionState).toBe('connected')
    expect(await caller.session.selectedPath()).toBe('relay')
    expect(caller.session.turnOutcomes()).toEqual([
      { url: 'turn:a.example?transport=udp', ms: expect.any(Number) },
    ])
  })

  it('brings its own TURN in when the other side restarts, and not for a mere renegotiation', async () => {
    const caller = side(true, { profile: { ...SYMMETRIC, turn: false } })
    const callee = side(false, { profile: SYMMETRIC, fallback: [TURN_A] })
    await connect(caller, callee)
    expect(callee.pc.connectionState).toBe('failed')
    caller.session.restartIce()
    await settle(50)
    await relay(caller, callee)
    expect(callee.session.restarted).toBe(true)
    expect(hasTurn(callee.pc.reconfigured[0])).toBe(true)
    await relay(callee, caller)
    await settle()
    expect(callee.pc.connectionState).toBe('connected')

    // A camera turned on renegotiates without restarting ICE: nothing changes.
    const quiet = side(true, { profile: SYMMETRIC })
    const other = side(false, { profile: { stun: true, symmetric: false, turn: false }, fallback: [TURN_A] })
    await connect(quiet, other)
    await quiet.session.setTrack('video', track('video'))
    await settle(50)
    await relay(quiet, other)
    expect(other.session.restarted).toBe(false)
    expect(other.pc.reconfigured).toEqual([])
  })

  it('still restarts where the browser cannot change servers mid-call, or has none to add', async () => {
    const stuck = side(true, { profile: SYMMETRIC, fallback: [TURN_A] })
    const peer = side(false, { profile: SYMMETRIC })
    await connect(stuck, peer)
    stuck.pc.failSetConfiguration = true
    stuck.session.restartIce()
    await settle(50)
    expect(stuck.session.restarted).toBe(true)
    expect(stuck.pc.reconfigured).toEqual([])
    expect(stuck.signals.map((signal) => signal.kind)).toContain('offer')

    const bare = side(true, { profile: SYMMETRIC })
    const far = side(false, { profile: SYMMETRIC })
    await connect(bare, far)
    bare.session.restartIce()
    expect(bare.session.restarted).toBe(true)
    expect(bare.pc.reconfigured).toEqual([])
  })

  it('learns which server gave a relay, and why the others did not', async () => {
    const profile: NetworkProfile = { ...SYMMETRIC, turnErrors: { [String(TURN_B.urls)]: 401 } }
    const a = side(true, { profile, iceServers: [TURN_A, TURN_B, { ...TURN_C }] })
    network.profiles.set(a.pc, { ...profile, turnErrors: { ...profile.turnErrors, 'turn:c.example': 701 } })
    await a.session.setTrack('audio', track('audio'))
    await a.session.offer()
    await settle()
    expect(a.session.turnOutcomes()).toEqual([
      { url: 'turn:a.example?transport=udp', ms: expect.any(Number) },
      { url: 'turns:b.example:443?transport=tcp', error: 401 },
      { url: 'turn:c.example?transport=udp', error: 0 },
    ])
    // STUN servers report errors here too, and are no TURN server's business;
    // a failure reported after a relay arrived changes nothing.
    a.pc.onicecandidateerror?.({ url: 'stun:s.example', errorCode: 701, errorText: '' })
    a.pc.onicecandidateerror?.({ url: 'turn:a.example?transport=udp', errorCode: 701, errorText: '' })
    expect(a.session.turnOutcomes()).toHaveLength(3)
    expect(a.session.turnOutcomes()[0]).toHaveProperty('ms')
  })

  it('finds the server on the event where the candidate does not say, and learns nothing where neither does', async () => {
    for (const reportUrl of ['event', 'none'] as const) {
      const a = side(true, { profile: SYMMETRIC, iceServers: [TURN_A] })
      a.pc.reportUrl = reportUrl
      await a.session.setTrack('audio', track('audio'))
      await a.session.offer()
      await settle()
      expect(a.session.turnOutcomes()).toEqual(
        reportUrl === 'event' ? [{ url: 'turn:a.example?transport=udp', ms: expect.any(Number) }] : [],
      )
    }
  })

  it('reports the relay a call runs through, with its round trip and bandwidth', async () => {
    const a = side(true, { profile: SYMMETRIC, iceServers: [TURN_A] })
    const b = side(false, { profile: SYMMETRIC })
    await connect(a, b)
    expect(await a.session.relayUse()).toEqual({ url: 'turn:a.example?transport=udp', rttMs: 0, kbps: 0 })
    a.pc.pairStats = { currentRoundTripTime: 0.123, availableOutgoingBitrate: 850_000 }
    expect(await a.session.relayUse()).toEqual({ url: 'turn:a.example?transport=udp', rttMs: 123, kbps: 850 })
    // The far side is relayed by a's server, not one of its own: no URL to name.
    expect(await b.session.relayUse()).toBeNull()

    const c = side(true)
    const d = side(false)
    await connect(c, d)
    expect(await c.session.relayUse()).toBeNull()
  })

  it('lets go of the error handler when closed', () => {
    const a = side(true)
    a.session.close()
    expect(a.pc.onicecandidateerror).toBeNull()
  })
})

describe('the browser wiring', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('builds a call manager on the running engine and the browser’s own WebRTC', async () => {
    const sent: unknown[] = []
    const recorded: unknown[] = []
    const handled: unknown[] = []
    const settings = { iceServers: [] as RTCIceServer[], callRelayOnly: true }
    const messenger = {
      pubkey: 'a'.repeat(64),
      noteCallHandled: (...args: unknown[]) => void handled.push(args),
      sendCallSignal: async (peer: string, frame: unknown) => (sent.push([peer, frame]), 'f'.repeat(64)),
      recordCall: async (...args: unknown[]) => void recorded.push(args),
      settings,
    } as unknown as Messenger

    // No devices in Node: with "always relay" and no TURN server, the call
    // ends before anything is opened or sent.
    const store = {
      getState: async () => null,
      putState: async () => undefined,
    } as unknown as Parameters<typeof createCallManager>[1]
    const bare = createCallManager(messenger, store)
    await bare.place('b'.repeat(64), 'audio')
    expect(bare.view?.ended?.kind).toBe('relay-needs-turn')
    bare.dispose()

    // With a browser's WebRTC and devices in place, it places a real call:
    // direct first, on the public STUN defaults and the user's own STUN,
    // with TURN selection loaded and the TURN server held back.
    settings.callRelayOnly = false
    settings.iceServers = [
      { urls: 'stun:s.example.org' },
      { urls: 'turn:t.example.org', username: 'u', credential: 'p' },
    ]
    const devices = new FakeMedia()
    vi.stubGlobal('navigator', { mediaDevices: devices })
    vi.stubGlobal(
      'RTCPeerConnection',
      class extends FakePeerConnection {
        constructor(config: RTCConfiguration) {
          super(config, network)
        }
      },
    )
    vi.stubGlobal('MediaStream', FakeStream)
    const manager = createCallManager(messenger, store)
    await manager.place('b'.repeat(64), 'video')
    expect(sent).toEqual([['b'.repeat(64), expect.objectContaining({ kind: 'offer', media: 'video' })]])
    expect(manager.view?.local.stream).toBeInstanceOf(FakeStream)
    expect(network.created.at(-1)?.config.iceServers).toEqual([
      ...DEFAULT_ICE_SERVERS,
      { urls: 'stun:s.example.org' },
    ])
    manager.hangup()
    await settle()
    expect(recorded).toEqual([
      ['b'.repeat(64), 'f'.repeat(64), 'out', { media: 'video', outcome: 'cancelled' }, expect.any(Number)],
    ])
    expect(devices.live).toEqual([])

    // A call picked up or turned down here goes to this identity's other devices.
    await manager.handleSignal(
      'b'.repeat(64),
      { v: 1, t: 'rtc', kind: 'offer', media: 'audio', sdp: 'v=0' },
      'c'.repeat(64),
      Date.now(),
    )
    manager.decline()
    expect(handled).toEqual([['c'.repeat(64), 'b'.repeat(64)]])
    manager.dispose()
  })
})
