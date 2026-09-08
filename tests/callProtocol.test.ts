import { describe, expect, it } from 'vitest'
import {
  encodeControlFrame,
  isCallFrame,
  isOpeningOffer,
  parseControlFrame,
  PROTOCOL_VERSION,
  type CallFrame,
  type RtcFrame,
} from '@/core/models/protocol'
import {
  candidateType,
  hasTurnServer,
  isCallRecord,
  looksSymmetric,
  summarizeCandidates,
} from '@/core/models/call'
import { candidatesInSdp, diagnoseIce } from '@/core/calls/diagnose'
import { browserMedia, camera, classifyMediaError, MediaError, stopTracks } from '@/core/calls/media'
import { alreadyListed, parseIceServer, serverUrls } from '@/core/calls/iceServers'
import { judge, probeIce } from '@/core/calls/iceProbe'
import { connectionPhase, parseMediaState } from '@/core/calls/callSession'
import { formatCallDuration } from '@/ui/format'
import { callOutcome, callSummary, callTitle } from '@/ui/components/CallBubble'
import { CALL_TEXT } from '@/ui/calls/strings'
import { CALL_SETTINGS_TEXT } from '@/ui/screens/callSettingsText'
import { interpolate, translate } from '@/i18n'
import { FakeIceNetwork, FakePeerConnection, FakeTrack, type NetworkProfile } from './fakeRtc'

const hex = (c: string) => c.repeat(64)
const parse = (value: unknown) => parseControlFrame(JSON.stringify(value))

const host = 'candidate:1 1 udp 2122260223 abc.local 50000 typ host generation 0'
const srflx = (port: number, address = '203.0.113.5') =>
  `candidate:2 1 udp 1686052607 ${address} ${port} typ srflx raddr 0.0.0.0 rport 0 generation 0`
const relay = 'candidate:4 1 udp 41885439 198.51.100.7 3478 typ relay raddr 203.0.113.5 rport 61000'

describe('call signalling on the wire (NIP-AC shape, sealed)', () => {
  const opening = { v: 1, t: 'rtc', kind: 'offer', media: 'video', sdp: 'v=0', fingerprint: 'sha-256 AA' }

  it('round-trips every call signal', () => {
    const frames: CallFrame[] = [
      opening as CallFrame,
      { v: PROTOCOL_VERSION, t: 'rtc', kind: 'ringing', call: hex('a') },
      {
        v: PROTOCOL_VERSION,
        t: 'rtc',
        kind: 'answer',
        call: hex('a'),
        sdp: 'v=0',
        fingerprint: 'sha-256 BB',
      },
      {
        v: PROTOCOL_VERSION,
        t: 'rtc',
        kind: 'candidate',
        call: hex('a'),
        candidate: { candidate: host, sdpMid: '0', sdpMLineIndex: 0 },
      },
      { v: PROTOCOL_VERSION, t: 'rtc', kind: 'offer', call: hex('a'), sdp: 'v=0' },
      { v: PROTOCOL_VERSION, t: 'rtc', kind: 'bye', call: hex('a'), reason: 'busy' },
      { v: PROTOCOL_VERSION, t: 'rtc', kind: 'bye', call: hex('a') },
    ]
    for (const frame of frames) expect(parseControlFrame(encodeControlFrame(frame))).toEqual(frame)
  })

  it('names the call by the opening offer, which alone names none', () => {
    const frame = parse(opening) as CallFrame
    expect(isCallFrame(frame)).toBe(true)
    expect(isOpeningOffer(frame)).toBe(true)
    expect(
      isOpeningOffer(parse({ v: 1, t: 'rtc', kind: 'offer', call: hex('a'), sdp: 'v=0' }) as CallFrame),
    ).toBe(false)
  })

  it('keeps the direct channel frame exactly as deployed clients send it', () => {
    const direct = parse({ v: 1, t: 'rtc', sid: 'abc', kind: 'offer', sdp: 'v=0' }) as RtcFrame
    expect(direct).toEqual({ v: 1, t: 'rtc', sid: 'abc', kind: 'offer', sdp: 'v=0' })
    expect(isCallFrame(direct)).toBe(false)
  })

  it('is dropped by a client that predates calls, rather than answered as a data channel', () => {
    // Deployed parsers require `sid` on every rtc frame, and no call frame has one.
    for (const frame of [opening, { v: 1, t: 'rtc', kind: 'bye', call: hex('a') }]) {
      expect('sid' in frame).toBe(false)
    }
  })

  it('refuses a frame that is both, so it cannot be routed two ways', () => {
    expect(parse({ v: 1, t: 'rtc', sid: 'abc', kind: 'offer', sdp: 'v=0', call: hex('a') })).toBeNull()
    expect(parse({ v: 1, t: 'rtc', sid: 'abc', kind: 'offer', sdp: 'v=0', media: 'audio' })).toBeNull()
    expect(parse({ v: 1, t: 'rtc', sid: 'abc', kind: 'bye', reason: 'busy' })).toBeNull()
    // …and `ringing` belongs to calls alone.
    expect(parse({ v: 1, t: 'rtc', sid: 'abc', kind: 'ringing' })).toBeNull()
  })

  it('requires an opening offer to say what it is for', () => {
    expect(parse({ ...opening, media: undefined })).toBeNull()
    expect(parse({ ...opening, media: 'hologram' })).toBeNull()
    // Only offers open calls.
    expect(parse({ v: 1, t: 'rtc', kind: 'answer', media: 'audio', sdp: 'v=0' })).toBeNull()
    expect(parse({ v: 1, t: 'rtc', kind: 'bye' })).toBeNull()
  })

  it('names the call with a rumor id, and only the opening offer carries media', () => {
    expect(parse({ v: 1, t: 'rtc', kind: 'bye', call: 'nothex' })).toBeNull()
    expect(parse({ v: 1, t: 'rtc', kind: 'offer', call: hex('a'), media: 'audio', sdp: 'v=0' })).toBeNull()
  })

  it('accepts a reason only on a bye, and only one it knows', () => {
    expect(parse({ v: 1, t: 'rtc', kind: 'bye', call: hex('a'), reason: 'exploded' })).toBeNull()
    expect(parse({ v: 1, t: 'rtc', kind: 'ringing', call: hex('a'), reason: 'busy' })).toBeNull()
    for (const reason of ['hangup', 'declined', 'busy', 'unanswered', 'failed']) {
      expect(parse({ v: 1, t: 'rtc', kind: 'bye', call: hex('a'), reason })).toMatchObject({ reason })
    }
  })

  it('carries exactly the payload its kind calls for', () => {
    const call = hex('a')
    const candidate = { candidate: host, sdpMid: '0', sdpMLineIndex: 0 }
    expect(parse({ v: 1, t: 'rtc', kind: 'answer', call })).toBeNull()
    expect(parse({ v: 1, t: 'rtc', kind: 'candidate', call })).toBeNull()
    expect(parse({ v: 1, t: 'rtc', kind: 'candidate', call, candidate, sdp: 'v=0' })).toBeNull()
    expect(parse({ v: 1, t: 'rtc', kind: 'answer', call, sdp: 'v=0', candidate })).toBeNull()
    expect(parse({ v: 1, t: 'rtc', kind: 'bye', call, fingerprint: 'sha-256 AA' })).toBeNull()
    expect(parse({ v: 1, t: 'rtc', kind: 'ringing', call, sdp: 'v=0' })).toBeNull()
    expect(parse({ v: 1, t: 'rtc', kind: 'jingle', call })).toBeNull()
  })

  it('bounds the SDP of a call as tightly as the direct channel', () => {
    expect(parse({ ...opening, sdp: 'a'.repeat(70_000) })).toBeNull()
    expect(parse({ ...opening, fingerprint: 'f'.repeat(600) })).toBeNull()
  })
})

describe('call records', () => {
  it('accepts what a call leaves behind, and nothing else', () => {
    expect(isCallRecord({ media: 'audio', outcome: 'completed', durationMs: 60_000 })).toBe(true)
    expect(isCallRecord({ media: 'video', outcome: 'missed' })).toBe(true)
    expect(isCallRecord({ media: 'video', outcome: 'missed', durationMs: -1 })).toBe(false)
    expect(isCallRecord({ media: 'video', outcome: 'missed', durationMs: Number.NaN })).toBe(false)
    expect(isCallRecord({ media: 'fax', outcome: 'missed' })).toBe(false)
    expect(isCallRecord({ media: 'audio', outcome: 'exploded' })).toBe(false)
    expect(isCallRecord(null)).toBe(false)
    expect(isCallRecord('call')).toBe(false)
  })

  it('reads the way people say it', () => {
    const t = (key: Parameters<typeof translate>[1]) => translate('en', key)
    const record = (direction: 'in' | 'out', call: Parameters<typeof callSummary>[0]['call']) =>
      callSummary({ direction, call }, t)
    expect(record('in', { media: 'video', outcome: 'missed' })).toBe('Missed video call')
    expect(record('in', { media: 'audio', outcome: 'missed' })).toBe('Missed voice call')
    expect(record('out', { media: 'audio', outcome: 'completed', durationMs: 252_000 })).toBe(
      'Outgoing voice call · ⁨4:12⁩',
    )
    expect(record('in', { media: 'video', outcome: 'completed', durationMs: 400 })).toBe(
      'Incoming video call',
    )
    expect(record('in', { media: 'video', outcome: 'completed' })).toBe('Incoming video call')
    expect(record('out', { media: 'video', outcome: 'unanswered' })).toBe('Outgoing video call · No answer')
    expect(record('in', { media: 'audio', outcome: 'declined' })).toBe('Incoming voice call · Declined')
  })

  it('splits into a title and how it went, for the bubble', () => {
    const t = (key: Parameters<typeof translate>[1]) => translate('en', key)
    const call = (direction: 'in' | 'out', record: Parameters<typeof callTitle>[0]['call']) => ({
      direction,
      call: record,
    })
    const missed = call('in', { media: 'video', outcome: 'missed' })
    expect([callTitle(missed, t), callOutcome(missed, t)]).toEqual(['Missed video call', null])
    const talked = call('out', { media: 'audio', outcome: 'completed', durationMs: 61_000 })
    expect([callTitle(talked, t), callOutcome(talked, t)]).toEqual([
      'Outgoing voice call',
      '\u20681:01\u2069',
    ])
    const brief = call('in', { media: 'audio', outcome: 'completed', durationMs: 999 })
    expect(callOutcome(brief, t)).toBeNull()
    const refused = call('out', { media: 'video', outcome: 'busy' })
    expect([callTitle(refused, t), callOutcome(refused, t)]).toEqual(['Outgoing video call', 'Busy'])
  })

  it('reads in Persian too, with the clock kept in order', () => {
    const t = (key: Parameters<typeof translate>[1]) => translate('fa', key)
    const line = callSummary(
      { direction: 'out', call: { media: 'audio', outcome: 'completed', durationMs: 3_725_000 } },
      t,
    )
    expect(line).toBe('تماس صوتی خروجی · ⁨1:02:05⁩')
  })

  it('formats a call length as a clock', () => {
    expect(formatCallDuration(0)).toBe('0:00')
    expect(formatCallDuration(7_900)).toBe('0:07')
    expect(formatCallDuration(252_000)).toBe('4:12')
    expect(formatCallDuration(3_729_000)).toBe('1:02:09')
    expect(formatCallDuration(-5)).toBe('0:00')
  })
})

describe('reading candidates', () => {
  it('knows each kind of address', () => {
    expect(candidateType(host)).toBe('host')
    expect(candidateType(srflx(61000))).toBe('srflx')
    expect(candidateType(relay)).toBe('relay')
    expect(candidateType('candidate:9 1 udp 1 1.2.3.4 9 typ prflx')).toBe('prflx')
    expect(candidateType('candidate:9 1 udp 1 1.2.3.4 9 typ hostile')).toBeNull()
    expect(summarizeCandidates([host, relay])).toEqual({ host: true, srflx: false, relay: true })
    // A peer-reflexive address is public too.
    expect(summarizeCandidates(['candidate:9 1 udp 1 1.2.3.4 9 typ prflx']).srflx).toBe(true)
  })

  it('spots symmetric NAT by the ports two STUN servers were given', () => {
    expect(looksSymmetric([srflx(61000), srflx(61000)])).toBe(false)
    expect(looksSymmetric([srflx(61000), srflx(61001)])).toBe(true)
    // Different public addresses are different interfaces, not symmetric NAT.
    expect(looksSymmetric([srflx(61000), srflx(61001, '198.51.100.9')])).toBe(false)
    expect(looksSymmetric([host, relay, 'candidate:bad typ srflx'])).toBe(false)
  })

  it('finds candidates inside a session description', () => {
    expect(candidatesInSdp(`v=0\r\na=${host}\r\nm=audio 9\r\na=${relay}\r\n`)).toEqual([host, relay])
  })

  it('knows whether a server list can relay at all', () => {
    expect(hasTurnServer([{ urls: 'stun:stun.example.org' }])).toBe(false)
    expect(hasTurnServer([{ urls: ['stun:a', 'turns:b:443'] }])).toBe(true)
    expect(hasTurnServer([{ urls: 'TURN:upper.example.org' }])).toBe(true)
  })
})

describe('diagnosing a call that could not connect', () => {
  const both = (local: string[], remote: string[], turnConfigured = false) =>
    diagnoseIce({ local, remote, turnConfigured }).kind

  it('blames a TURN server that allocated nothing', () => {
    expect(both([host, srflx(1)], [srflx(2)], true)).toBe('turn-failed')
  })

  it('says when this network blocks STUN outright', () => {
    expect(both([host], [host, srflx(2)])).toBe('blocked')
  })

  it('says when the other side does', () => {
    expect(both([host, srflx(1)], [host])).toBe('peer-blocked')
  })

  it('recognises two public addresses that still could not meet', () => {
    expect(both([srflx(1)], [srflx(2)])).toBe('symmetric-nat')
    expect(both([srflx(1), srflx(2), relay], [srflx(3), relay])).toBe('symmetric-nat')
  })

  it('admits when it cannot tell', () => {
    expect(both([srflx(1), relay], [relay])).toBe('unknown')
  })
})

describe('camera and microphone plumbing', () => {
  it('turns browser errors into something the person can act on', () => {
    const err = (name: string) => Object.assign(new Error(name), { name })
    expect(classifyMediaError(err('NotAllowedError'))).toBe('denied')
    expect(classifyMediaError(err('SecurityError'))).toBe('denied')
    expect(classifyMediaError(err('NotFoundError'))).toBe('missing')
    expect(classifyMediaError(err('OverconstrainedError'))).toBe('missing')
    expect(classifyMediaError(err('NotReadableError'))).toBe('busy')
    expect(classifyMediaError(err('AbortError'))).toBe('busy')
    expect(classifyMediaError(err('TypeError'))).toBe('failed')
    expect(classifyMediaError(null)).toBe('failed')
    expect(new MediaError('busy')).toMatchObject({ failure: 'busy', name: 'MediaError' })
  })

  it('asks for a sensible camera, and for exactly one when flipping', () => {
    expect(camera('user').facingMode).toBe('user')
    expect(camera('environment', true).facingMode).toEqual({ exact: 'environment' })
    expect(camera('user').frameRate).toEqual({ ideal: 30, max: 30 })
  })

  it('has no devices to offer outside a browser', () => {
    expect(browserMedia()).toBeNull()
  })

  it('reaches the browser’s devices where there are some', () => {
    const calls: string[] = []
    const devices = {
      getUserMedia: async () => (calls.push('user'), {}) as MediaStream,
      getDisplayMedia: async () => (calls.push('display'), {}) as MediaStream,
      enumerateDevices: async () => (calls.push('enumerate'), []),
    }
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: devices }, configurable: true })
    try {
      const media = browserMedia()
      void media?.getUserMedia({ audio: true })
      void media?.getDisplayMedia?.({ video: true })
      void media?.enumerateDevices()
      expect(calls).toEqual(['user', 'display', 'enumerate'])
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original)
    }
  })

  it('stops tracks, including ones that are already gone', () => {
    const live = new FakeTrack('audio')
    const broken = {
      stop: () => {
        throw new Error('gone')
      },
    } as unknown as MediaStreamTrack
    stopTracks([live as unknown as MediaStreamTrack, null, undefined, broken])
    expect(live.readyState).toBe('ended')
  })
})

describe('the call data channel', () => {
  it('reads the other side’s media state from untrusted bytes', () => {
    expect(parseMediaState('{"audio":true,"video":false,"screen":false}')).toEqual({
      audio: true,
      video: false,
      screen: false,
    })
    expect(parseMediaState('{"audio":"yes","video":false,"screen":false}')).toBeNull()
    expect(parseMediaState('not json')).toBeNull()
    expect(parseMediaState('null')).toBeNull()
    expect(parseMediaState(new ArrayBuffer(4))).toBeNull()
    expect(parseMediaState(`{"audio":true,"pad":"${'x'.repeat(300)}"}`)).toBeNull()
  })

  it('falls back to the ICE state where a browser has no connection state', () => {
    expect(connectionPhase('connected', 'checking')).toBe('connected')
    expect(connectionPhase(undefined, 'checking')).toBe('connecting')
    expect(connectionPhase(undefined, 'completed')).toBe('connected')
    expect(connectionPhase(undefined, 'connected')).toBe('connected')
    expect(connectionPhase(undefined, 'disconnected')).toBe('disconnected')
    expect(connectionPhase(undefined, 'failed')).toBe('failed')
    expect(connectionPhase(undefined, 'new')).toBe('new')
    expect(connectionPhase(undefined, 'closed')).toBe('closed')
  })
})

describe('STUN and TURN servers typed into Settings', () => {
  it('accepts the three schemes, and normalises their case', () => {
    expect(parseIceServer({ url: ' stun:stun.example.org:3478 ' })).toEqual({
      server: { urls: 'stun:stun.example.org:3478' },
    })
    expect(
      parseIceServer({ url: 'TURNS:turn.example.org:443?transport=tcp', username: 'me', credential: 'pw' }),
    ).toEqual({
      server: { urls: 'turns:turn.example.org:443?transport=tcp', username: 'me', credential: 'pw' },
    })
    // A STUN server needs no credentials, and does not keep any it was given.
    expect(parseIceServer({ url: 'stun:s.example.org', username: 'me', credential: 'pw' })).toEqual({
      server: { urls: 'stun:s.example.org' },
    })
  })

  it('refuses anything that is not a STUN or TURN address', () => {
    for (const url of [
      '',
      'https://turn.example.org',
      'turn:',
      'turn:a b',
      'turn:host/path',
      `turn:${'a'.repeat(600)}`,
    ]) {
      expect(parseIceServer({ url, username: 'u', credential: 'p' })).toEqual({ error: 'invalid' })
    }
  })

  it('insists a TURN server has credentials', () => {
    expect(parseIceServer({ url: 'turn:t.example.org' })).toEqual({ error: 'credentials' })
    expect(parseIceServer({ url: 'turn:t.example.org', username: 'me' })).toEqual({ error: 'credentials' })
    expect(parseIceServer({ url: 'turn:t.example.org', username: ' ', credential: 'pw' })).toEqual({
      error: 'credentials',
    })
    expect(
      parseIceServer({ url: 'turn:t.example.org', username: 'u'.repeat(300), credential: 'pw' }),
    ).toEqual({
      error: 'invalid',
    })
  })

  it('notices a server that is already listed', () => {
    const listed = [{ urls: ['stun:a.example.org', 'turn:b.example.org'] }]
    expect(serverUrls(listed[0] as RTCIceServer)).toHaveLength(2)
    expect(alreadyListed(listed, { urls: 'TURN:b.example.org' })).toBe(true)
    expect(alreadyListed(listed, { urls: 'turn:c.example.org' })).toBe(false)
  })
})

describe('testing a network from Settings', () => {
  const profile = (stun: boolean, symmetric: boolean, turn: boolean): NetworkProfile => ({
    stun,
    symmetric,
    turn,
  })
  const TURN = { urls: 'turn:t.example.org', username: 'u', credential: 'p' }

  async function run(servers: RTCIceServer[], network: NetworkProfile) {
    const ice = new FakeIceNetwork()
    let made: FakePeerConnection | null = null
    const result = await probeIce(servers, {
      createPeerConnection: (config) => {
        made = new FakePeerConnection(config, ice, network)
        return made as unknown as RTCPeerConnection
      },
    })
    return { result, pc: made as FakePeerConnection | null }
  }

  it('reports each server, and closes what it opened', async () => {
    const { result, pc } = await run([{ urls: 'stun:s' }, TURN], profile(true, false, true))
    expect(result).toEqual({ verdict: 'good', stun: true, turn: true, symmetric: false })
    expect(pc?.closed).toBe(true)
    expect(pc?.channel).not.toBeNull()
  })

  it('tells symmetric NAT apart from a network that simply works', async () => {
    expect((await run([{ urls: 'stun:s' }], profile(true, false, false))).result.verdict).toBe('stun')
    expect((await run([{ urls: 'stun:s' }], profile(true, true, false))).result.verdict).toBe('symmetric')
    expect((await run([{ urls: 'stun:s' }], profile(false, false, false))).result.verdict).toBe('none')
    expect((await run([TURN], profile(true, false, false))).result).toMatchObject({
      verdict: 'turn-failed',
      turn: false,
    })
  })

  it('gives up waiting after a while', async () => {
    const stuck = {
      onicecandidate: null,
      createDataChannel: () => ({}),
      createOffer: async () => ({ type: 'offer', sdp: 'v=0' }),
      setLocalDescription: async () => undefined,
      close: () => undefined,
    }
    const result = await probeIce([], {
      createPeerConnection: () => stuck as unknown as RTCPeerConnection,
      timeoutMs: 10,
    })
    expect(result).toEqual({ verdict: 'none', stun: false, turn: null, symmetric: false })
  })

  it('judges from candidates alone', () => {
    expect(judge([relay], true).verdict).toBe('good')
    expect(judge([srflx(1)], false)).toEqual({ verdict: 'stun', stun: true, turn: null, symmetric: false })
  })
})

describe('the words calls use', () => {
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

  it('says everything in both languages, with the same blanks to fill', () => {
    for (const table of [CALL_TEXT, CALL_SETTINGS_TEXT] as Record<string, Record<string, string>>[]) {
      const en = table.en as Record<string, string>
      const fa = table.fa as Record<string, string>
      expect(Object.keys(fa).sort()).toEqual(Object.keys(en).sort())
      for (const key of Object.keys(en)) {
        expect(fa[key]?.trim(), key).toBeTruthy()
        expect(placeholders(fa[key] as string), key).toEqual(placeholders(en[key] as string))
      }
    }
  })

  it('fills its blanks the way the dictionaries do', () => {
    expect(interpolate('{name} is muted', { name: 'Sara' })).toBe('Sara is muted')
    expect(interpolate('{name} and {other}', { name: 'Sara' })).toBe('Sara and {other}')
    expect(interpolate('no blanks')).toBe('no blanks')
  })
})
