import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CallSession, MAX_RENEGOTIATIONS_PER_MINUTE, type SessionSignal } from '@/core/calls/callSession'
import { createCallManager } from '@/core/calls/browserCalls'
import type { Messenger } from '@/core/engine/messenger'
import { FakeIceNetwork, FakeMedia, FakePeerConnection, FakeStream, FakeTrack } from './fakeRtc'

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

function side(polite: boolean): Side {
  const pc = new FakePeerConnection({ iceServers: [] }, network)
  const session = new CallSession(pc as unknown as RTCPeerConnection, { polite, gatherGraceMs: 100 })
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

describe('the browser wiring', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('builds a call manager on the running engine and the browser’s own WebRTC', async () => {
    const sent: unknown[] = []
    const recorded: unknown[] = []
    let relayOnly = true
    const messenger = {
      pubkey: 'a'.repeat(64),
      sendCallSignal: async (peer: string, frame: unknown) => (sent.push([peer, frame]), 'f'.repeat(64)),
      recordCall: async (...args: unknown[]) => void recorded.push(args),
      callConfig: () => ({ iceServers: [], relayOnly }),
    } as unknown as Messenger

    // No devices in Node: with "always relay" and no TURN server, the call
    // ends before anything is opened or sent.
    const bare = createCallManager(messenger)
    await bare.place('b'.repeat(64), 'audio')
    expect(bare.view?.ended?.kind).toBe('relay-needs-turn')
    bare.dispose()

    // With a browser's WebRTC and devices in place, it places a real call.
    relayOnly = false
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
    const manager = createCallManager(messenger)
    await manager.place('b'.repeat(64), 'video')
    expect(sent).toEqual([['b'.repeat(64), expect.objectContaining({ kind: 'offer', media: 'video' })]])
    expect(manager.view?.local.stream).toBeInstanceOf(FakeStream)
    manager.hangup()
    await settle()
    expect(recorded).toEqual([
      ['b'.repeat(64), 'f'.repeat(64), 'out', { media: 'video', outcome: 'cancelled' }, expect.any(Number)],
    ])
    expect(devices.live).toEqual([])
    manager.dispose()
  })
})
