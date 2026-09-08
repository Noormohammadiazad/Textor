import type { MediaBackend } from '@/core/calls/media'

/**
 * Just enough of WebRTC to run two call managers against each other.
 *
 * Descriptions are real SDP text with the fields the code under test reads —
 * fingerprint, mids, directions, candidates — and transceivers, negotiated
 * data channels, negotiation-needed and the signalling state machine follow
 * the spec closely enough that perfect negotiation, glare and renegotiation
 * are exercised for real. Connectivity is decided by a `FakeIceNetwork`, which
 * each side describes: whether STUN works, whether the NAT is symmetric,
 * whether its TURN server answers. That is what lets a test put two people
 * behind networks that cannot meet and check what the screen says about it.
 */

let counter = 0
const nextId = (prefix: string) => `${prefix}${++counter}`

type Listener = (event: unknown) => void

export class FakeTrack {
  readonly id = nextId('track-')
  enabled = true
  readyState: 'live' | 'ended' = 'live'
  contentHint = ''
  #listeners = new Map<string, Set<Listener>>()

  constructor(
    readonly kind: 'audio' | 'video',
    readonly settings: { facingMode?: string; deviceId?: string; displaySurface?: string } = {},
  ) {}

  getSettings() {
    return this.settings
  }

  stop(): void {
    this.readyState = 'ended'
  }

  addEventListener(type: string, fn: Listener): void {
    const set = this.#listeners.get(type) ?? new Set()
    set.add(fn)
    this.#listeners.set(type, set)
  }

  removeEventListener(type: string, fn: Listener): void {
    this.#listeners.get(type)?.delete(fn)
  }

  /** What the browser does when the person presses its own "stop sharing". */
  end(): void {
    this.readyState = 'ended'
    for (const fn of this.#listeners.get('ended') ?? []) fn({ type: 'ended' })
  }
}

export class FakeStream {
  readonly id = nextId('stream-')
  constructor(readonly tracks: FakeTrack[]) {}
  getTracks() {
    return [...this.tracks]
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio')
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === 'video')
  }
}

export const createFakeStream = (tracks: MediaStreamTrack[]): MediaStream =>
  new FakeStream(tracks as unknown as FakeTrack[]) as unknown as MediaStream

/** Cameras, a microphone and a screen, each of which a test can break. */
export class FakeMedia implements MediaBackend {
  cameras: { deviceId: string; facing?: 'user' | 'environment' }[] = [
    { deviceId: 'front', facing: 'user' },
    { deviceId: 'back', facing: 'environment' },
  ]
  micError: string | null = null
  cameraError: string | null = null
  displayError: string | null = null
  canShare = true
  /** Every track handed out, so a test can check each was stopped. */
  opened: FakeTrack[] = []
  requests: MediaStreamConstraints[] = []

  getDisplayMedia?: MediaBackend['getDisplayMedia'] = async () => {
    if (this.displayError) throw named(this.displayError)
    return this.#stream([new FakeTrack('video', { displaySurface: 'monitor' })])
  }

  constructor(opts: { canShare?: boolean } = {}) {
    if (opts.canShare === false) this.getDisplayMedia = undefined
  }

  async getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
    this.requests.push(constraints)
    const tracks: FakeTrack[] = []
    if (constraints.audio) {
      if (this.micError) throw named(this.micError)
      tracks.push(new FakeTrack('audio'))
    }
    if (constraints.video) {
      if (this.cameraError) throw named(this.cameraError)
      const video = constraints.video === true ? {} : constraints.video
      const wanted = video.facingMode
      const exact =
        typeof wanted === 'object' && wanted !== null && 'exact' in wanted ? wanted.exact : undefined
      const ideal = typeof wanted === 'string' ? wanted : undefined
      const byDevice =
        typeof video.deviceId === 'object' && video.deviceId !== null && 'exact' in video.deviceId
          ? video.deviceId.exact
          : undefined
      const found = byDevice
        ? this.cameras.find((cam) => cam.deviceId === byDevice)
        : exact
          ? this.cameras.find((cam) => cam.facing === exact)
          : (this.cameras.find((cam) => cam.facing === ideal) ?? this.cameras[0])
      if (!found) throw named('OverconstrainedError')
      tracks.push(new FakeTrack('video', { deviceId: found.deviceId, facingMode: found.facing }))
    }
    return this.#stream(tracks)
  }

  async enumerateDevices(): Promise<MediaDeviceInfo[]> {
    return [
      { kind: 'audioinput', deviceId: 'mic', label: 'Mic', groupId: 'g' },
      ...this.cameras.map((cam) => ({
        kind: 'videoinput',
        deviceId: cam.deviceId,
        label: cam.deviceId,
        groupId: 'g',
      })),
    ] as MediaDeviceInfo[]
  }

  #stream(tracks: FakeTrack[]): MediaStream {
    this.opened.push(...tracks)
    return createFakeStream(tracks as unknown as MediaStreamTrack[])
  }

  /** Tracks still live — which, after a call, should be none. */
  get live(): FakeTrack[] {
    return this.opened.filter((track) => track.readyState === 'live')
  }
}

function named(name: string): Error {
  const err = new Error(name)
  err.name = name
  return err
}

/** One side's network, as ICE would find it. */
export interface NetworkProfile {
  /** STUN answers, so the device learns a public address. */
  stun: boolean
  /** The NAT maps each destination to a different port. */
  symmetric: boolean
  /** A configured TURN server answers and allocates a relay. */
  turn: boolean
}

export const OPEN_NETWORK: NetworkProfile = { stun: true, symmetric: false, turn: true }

let addressCounter = 10

/** Decides which peer connections can reach each other. */
export class FakeIceNetwork {
  profiles = new Map<FakePeerConnection, NetworkProfile>()
  #byFingerprint = new Map<string, FakePeerConnection>()
  #links = new Map<FakePeerConnection, FakePeerConnection>()
  /** Created by a test's `createPeerConnection`, in order. */
  created: FakePeerConnection[] = []

  register(pc: FakePeerConnection, profile: NetworkProfile): void {
    this.profiles.set(pc, profile)
    this.#byFingerprint.set(pc.fingerprint, pc)
    this.created.push(pc)
  }

  peerOf(pc: FakePeerConnection): FakePeerConnection | undefined {
    return this.#links.get(pc)
  }

  /** Called whenever a description is applied: connect once both ends agree. */
  check(pc: FakePeerConnection): void {
    const remote = pc.remoteDescription ? fingerprintOf(pc.remoteDescription.sdp) : null
    const other = remote ? this.#byFingerprint.get(remote) : undefined
    if (!other || other.closed || pc.closed) return
    if (!other.remoteDescription || fingerprintOf(other.remoteDescription.sdp) !== pc.fingerprint) return
    if (pc.signalingState !== 'stable' || other.signalingState !== 'stable') return
    this.#links.set(pc, other)
    this.#links.set(other, pc)
    if (pc.connectionState === 'connected' && other.connectionState === 'connected') return
    const reachable = this.reachable(pc, other)
    setTimeout(() => {
      if (pc.closed || other.closed) return
      for (const side of [pc, other]) side.setConnection(reachable ? 'connected' : 'failed')
      if (reachable) {
        pc.channel?.link(other.channel)
        other.channel?.link(pc.channel)
      }
    }, 20)
  }

  reachable(a: FakePeerConnection, b: FakePeerConnection): boolean {
    return this.directlyReachable(a, b) || a.gatheredTypes().has('relay') || b.gatheredTypes().has('relay')
  }

  /** Two public addresses meet unless a symmetric NAT is in the way. */
  directlyReachable(a: FakePeerConnection, b: FakePeerConnection | undefined): boolean {
    if (!b) return false
    const pa = this.profiles.get(a)
    const pb = this.profiles.get(b)
    return (
      a.gatheredTypes().has('srflx') && b.gatheredTypes().has('srflx') && !pa?.symmetric && !pb?.symmetric
    )
  }

  /** The path between two connected peers drops, as when Wi-Fi hands over. */
  interrupt(pc: FakePeerConnection, state: 'disconnected' | 'failed' = 'disconnected'): void {
    const other = this.#links.get(pc)
    for (const side of [pc, other]) side?.setConnection(state)
  }

  restore(pc: FakePeerConnection): void {
    const other = this.#links.get(pc)
    for (const side of [pc, other]) side?.setConnection('connected')
  }

  candidatesFor(pc: FakePeerConnection, ufrag: string): string[] {
    const profile = this.profiles.get(pc) ?? OPEN_NETWORK
    const relayOnly = pc.config.iceTransportPolicy === 'relay'
    const hasTurn = (pc.config.iceServers ?? []).some((server) =>
      (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) => url.startsWith('turn')),
    )
    const address = `203.0.113.${addressCounter++}`
    const out: string[] = []
    if (!relayOnly) {
      out.push(
        `candidate:1 1 udp 2122260223 ${pc.fingerprint.slice(0, 8)}.local 50000 typ host generation 0 ufrag ${ufrag}`,
      )
      if (profile.stun) {
        out.push(
          `candidate:2 1 udp 1686052607 ${address} 61000 typ srflx raddr 0.0.0.0 rport 0 generation 0 ufrag ${ufrag}`,
        )
        // Behind a symmetric NAT each STUN server sees a different port.
        const port = profile.symmetric ? 61001 : 61000
        out.push(
          `candidate:3 1 udp 1686052607 ${address} ${port} typ srflx raddr 0.0.0.0 rport 0 generation 0 ufrag ${ufrag}`,
        )
      }
    }
    if (hasTurn && profile.turn) {
      out.push(
        `candidate:4 1 udp 41885439 198.51.100.7 3478 typ relay raddr ${address} rport 61000 generation 0 ufrag ${ufrag}`,
      )
    }
    return out
  }
}

const fingerprintOf = (sdp: string): string | null => /^a=fingerprint:sha-256 (\S+)/m.exec(sdp)?.[1] ?? null

class FakeSender {
  constructor(public track: FakeTrack | null) {}
  async replaceTrack(track: FakeTrack | null): Promise<void> {
    this.track = track
  }
}

type Direction = RTCRtpTransceiverDirection

class FakeTransceiver {
  mid: string | null = null
  currentDirection: Direction | null = null
  /** The direction last agreed, to decide whether negotiation is needed. */
  negotiated: Direction | null = null
  sender: FakeSender
  receiver: { track: FakeTrack }
  /** The other side sends on this one; `ontrack` has fired for it. */
  receiving = false
  #direction: Direction
  #owner: FakePeerConnection

  constructor(
    owner: FakePeerConnection,
    kind: 'audio' | 'video',
    direction: Direction,
    track: FakeTrack | null,
  ) {
    this.#owner = owner
    this.#direction = direction
    this.sender = new FakeSender(track)
    this.receiver = { track: new FakeTrack(kind) }
  }

  get kind(): 'audio' | 'video' {
    return this.receiver.track.kind
  }

  get direction(): Direction {
    return this.#direction
  }

  set direction(value: Direction) {
    if (value === this.#direction) return
    this.#direction = value
    this.#owner.markNegotiationNeeded()
  }
}

export class FakeChannel {
  readyState: RTCDataChannelState = 'connecting'
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  sent: string[] = []
  #peer: FakeChannel | null = null

  constructor(readonly label: string) {}

  link(peer: FakeChannel | null): void {
    if (!peer || this.readyState === 'open') return
    this.#peer = peer
    this.readyState = 'open'
    this.onopen?.()
  }

  send(data: string): void {
    if (this.readyState !== 'open') throw new Error('channel is not open')
    this.sent.push(data)
    const peer = this.#peer
    queueMicrotask(() => peer?.onmessage?.({ data }))
  }

  close(): void {
    this.readyState = 'closed'
  }
}

interface ParsedSection {
  kind: string
  mid: string
  direction: Direction
}

function parseSections(sdp: string): ParsedSection[] {
  const sections: ParsedSection[] = []
  let current: ParsedSection | null = null
  for (const line of sdp.split(/\r?\n/)) {
    const media = /^m=(\w+)/.exec(line)
    if (media) {
      current = { kind: media[1] as string, mid: '', direction: 'sendrecv' }
      sections.push(current)
      continue
    }
    if (!current) continue
    const mid = /^a=mid:(\S+)/.exec(line)
    if (mid) current.mid = mid[1] as string
    const direction = /^a=(sendrecv|sendonly|recvonly|inactive)$/.exec(line)
    if (direction) current.direction = direction[1] as Direction
  }
  return sections
}

const sends = (direction: Direction | null) => direction === 'sendrecv' || direction === 'sendonly'
const receives = (direction: Direction | null) => direction === 'sendrecv' || direction === 'recvonly'

function answerDirection(local: Direction, offered: Direction): Direction {
  const send = sends(local) && receives(offered)
  const receive = receives(local) && sends(offered)
  return send && receive ? 'sendrecv' : send ? 'sendonly' : receive ? 'recvonly' : 'inactive'
}

export class FakePeerConnection {
  readonly fingerprint = Array.from({ length: 8 }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase(),
  ).join(':')
  signalingState: RTCSignalingState = 'stable'
  iceGatheringState: RTCIceGatheringState = 'new'
  connectionState: RTCPeerConnectionState = 'new'
  iceConnectionState: RTCIceConnectionState = 'new'
  localDescription: { type: RTCSdpType; sdp: string } | null = null
  remoteDescription: { type: RTCSdpType; sdp: string } | null = null
  closed = false
  channel: FakeChannel | null = null
  addedCandidates: RTCIceCandidateInit[] = []
  restarts = 0
  /** Set true to make every offer this side makes fail, as a broken browser would. */
  failOffers = false
  /** How long ICE takes to find each candidate. */
  gatherSpacingMs = 5

  onicecandidate:
    ((event: { candidate: (RTCIceCandidateInit & { candidate: string }) | null }) => void) | null = null
  onicegatheringstatechange: (() => void) | null = null
  ontrack: ((event: { track: FakeTrack }) => void) | null = null
  onnegotiationneeded: (() => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  oniceconnectionstatechange: (() => void) | null = null

  #transceivers: FakeTransceiver[] = []
  #nextMid = 0
  #version = 0
  #ufragGeneration = 0
  #restartPending = false
  #needsNegotiation = false
  #negotiationQueued = false
  #gatheredFor = ''
  #gathered: string[] = []
  /** The local description as of the last stable state, which a rollback returns to. */
  #stableLocal: { type: RTCSdpType; sdp: string } | null = null

  constructor(
    readonly config: RTCConfiguration,
    readonly network: FakeIceNetwork,
    profile: NetworkProfile = OPEN_NETWORK,
  ) {
    network.register(this, profile)
  }

  // --- media -------------------------------------------------------------------

  createDataChannel(label: string): FakeChannel {
    this.channel = new FakeChannel(label)
    return this.channel
  }

  addTrack(track: FakeTrack): FakeSender {
    const reusable = this.#transceivers.find(
      (t) => t.kind === track.kind && !t.sender.track && t.mid !== null && !sends(t.direction),
    )
    if (reusable) {
      reusable.sender.track = track
      reusable.direction = reusable.direction === 'recvonly' ? 'sendrecv' : 'sendonly'
      return reusable.sender
    }
    const transceiver = new FakeTransceiver(this, track.kind, 'sendrecv', track)
    this.#transceivers.push(transceiver)
    this.markNegotiationNeeded()
    return transceiver.sender
  }

  getTransceivers(): FakeTransceiver[] {
    return [...this.#transceivers]
  }

  getSenders(): FakeSender[] {
    return this.#transceivers.map((t) => t.sender)
  }

  /** What this side is sending on each kind — the tests' view of the wire. */
  sending(kind: 'audio' | 'video'): FakeTrack | null {
    const transceiver = this.#transceivers.find((t) => t.kind === kind && sends(t.currentDirection))
    return transceiver?.sender.track ?? null
  }

  // --- negotiation ---------------------------------------------------------------

  markNegotiationNeeded(): void {
    this.#needsNegotiation = true
    this.#queueNegotiation()
  }

  #queueNegotiation(): void {
    if (this.#negotiationQueued || this.closed) return
    this.#negotiationQueued = true
    setTimeout(() => {
      this.#negotiationQueued = false
      if (this.closed || this.signalingState !== 'stable' || !this.#needsNegotiation) return
      this.onnegotiationneeded?.()
    }, 0)
  }

  restartIce(): void {
    this.restarts += 1
    this.#restartPending = true
    this.markNegotiationNeeded()
  }

  async createOffer(options?: RTCOfferOptions): Promise<{ type: 'offer'; sdp: string }> {
    await tick()
    if (this.failOffers) throw new Error('createOffer failed')
    if (options?.iceRestart) this.#restartPending = true
    for (const transceiver of this.#transceivers) {
      while (this.#transceivers.some((t) => t.mid === String(this.#nextMid))) this.#nextMid++
      transceiver.mid ??= String(this.#nextMid++)
    }
    const sections = this.#transceivers.map((t) => ({
      kind: t.kind,
      mid: t.mid as string,
      direction: t.direction,
    }))
    return {
      type: 'offer',
      sdp: this.#sdp(sections, this.#restartPending ? this.#ufragGeneration + 1 : this.#ufragGeneration),
    }
  }

  async createAnswer(): Promise<{ type: 'answer'; sdp: string }> {
    await tick()
    if (!this.remoteDescription || this.signalingState !== 'have-remote-offer')
      throw new Error('no offer to answer')
    const sections = parseSections(this.remoteDescription.sdp)
      .filter((section) => section.kind !== 'application')
      .map((section) => {
        const transceiver = this.#transceivers.find((t) => t.mid === section.mid)
        return {
          kind: section.kind,
          mid: section.mid,
          direction: answerDirection(transceiver?.direction ?? 'recvonly', section.direction),
        }
      })
    return { type: 'answer', sdp: this.#sdp(sections, this.#ufragGeneration) }
  }

  async setLocalDescription(description: { type: RTCSdpType; sdp?: string }): Promise<void> {
    await tick()
    if (this.closed) throw new Error('closed')
    if (description.type === 'rollback') {
      if (this.signalingState === 'stable') throw named('InvalidStateError')
      this.signalingState = 'stable'
      this.localDescription = this.#stableLocal
      return
    }
    const sdp = description.sdp ?? ''
    if (description.type === 'offer') {
      if (this.signalingState !== 'stable') throw named('InvalidStateError')
      this.#stableLocal = this.localDescription
      this.signalingState = 'have-local-offer'
      this.#needsNegotiation = false
    } else {
      if (this.signalingState !== 'have-remote-offer') throw named('InvalidStateError')
      this.signalingState = 'stable'
      this.#settleDirections(parseSections(sdp))
    }
    this.localDescription = { type: description.type, sdp }
    if (this.signalingState === 'stable') this.#stableLocal = this.localDescription
    this.#gather(sdp)
    this.#afterStable()
  }

  async setRemoteDescription(description: { type: RTCSdpType; sdp: string }): Promise<void> {
    await tick()
    if (this.closed) throw new Error('closed')
    const sections = parseSections(description.sdp).filter((s) => s.kind !== 'application')
    if (description.type === 'offer') {
      if (this.signalingState !== 'stable') throw named('InvalidStateError')
      for (const section of sections) {
        let transceiver = this.#transceivers.find((t) => t.mid === section.mid)
        // Transceivers made by addTrack before the offer arrived are adopted.
        transceiver ??= this.#transceivers.find((t) => t.mid === null && t.kind === section.kind)
        if (!transceiver) {
          transceiver = new FakeTransceiver(this, section.kind as 'audio' | 'video', 'recvonly', null)
          this.#transceivers.push(transceiver)
        }
        transceiver.mid = section.mid
        this.#receive(transceiver, section.direction)
      }
      this.signalingState = 'have-remote-offer'
    } else {
      if (this.signalingState !== 'have-local-offer') throw named('InvalidStateError')
      for (const section of sections) {
        const transceiver = this.#transceivers.find((t) => t.mid === section.mid)
        if (transceiver) this.#receive(transceiver, section.direction)
      }
      this.signalingState = 'stable'
      // The answer's directions are the mirror image of ours.
      this.#settleDirections(
        sections.map((s) => ({
          ...s,
          direction:
            s.direction === 'sendonly' ? 'recvonly' : s.direction === 'recvonly' ? 'sendonly' : s.direction,
        })),
      )
      if (this.#restartPending) {
        this.#restartPending = false
        this.#ufragGeneration += 1
      }
    }
    this.remoteDescription = { type: description.type, sdp: description.sdp }
    this.#afterStable()
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    await tick()
    if (!this.remoteDescription) throw named('InvalidStateError')
    const ufrag = / ufrag (\S+)/.exec(candidate.candidate ?? '')?.[1]
    const expected = /^a=ice-ufrag:(\S+)/m.exec(this.remoteDescription.sdp)?.[1]
    if (ufrag && expected && ufrag !== expected) throw named('OperationError')
    this.addedCandidates.push(candidate)
  }

  async getStats(): Promise<Map<string, Record<string, unknown>>> {
    const peer = this.network.peerOf(this)
    const relayed = this.connectionState === 'connected' && !this.network.directlyReachable(this, peer)
    return new Map<string, Record<string, unknown>>([
      [
        'T',
        {
          id: 'T',
          type: 'transport',
          selectedCandidatePairId: this.connectionState === 'connected' ? 'P' : undefined,
        },
      ],
      [
        'P',
        {
          id: 'P',
          type: 'candidate-pair',
          localCandidateId: 'L',
          remoteCandidateId: 'R',
          state: 'succeeded',
          nominated: true,
        },
      ],
      ['L', { id: 'L', type: 'local-candidate', candidateType: relayed ? 'relay' : 'srflx' }],
      ['R', { id: 'R', type: 'remote-candidate', candidateType: 'srflx' }],
    ])
  }

  close(): void {
    this.closed = true
    this.signalingState = 'closed'
    this.connectionState = 'closed'
  }

  // --- test controls ---------------------------------------------------------------

  setConnection(state: RTCPeerConnectionState): void {
    if (this.closed || this.connectionState === state) return
    this.connectionState = state
    this.iceConnectionState = state === 'connecting' ? 'checking' : (state as RTCIceConnectionState)
    this.oniceconnectionstatechange?.()
    this.onconnectionstatechange?.()
  }

  gatheredTypes(): Set<string> {
    return new Set(this.#gathered.map((c) => / typ (\w+)/.exec(c)?.[1] ?? ''))
  }

  // --- internals -------------------------------------------------------------------

  #receive(transceiver: FakeTransceiver, remoteDirection: Direction): void {
    const remoteSends = sends(remoteDirection)
    if (remoteSends && !transceiver.receiving) {
      transceiver.receiving = true
      const track = transceiver.receiver.track
      setTimeout(() => {
        if (!this.closed) this.ontrack?.({ track })
      }, 0)
    }
    if (!remoteSends) transceiver.receiving = false
  }

  #settleDirections(sections: ParsedSection[]): void {
    for (const section of sections) {
      const transceiver = this.#transceivers.find((t) => t.mid === section.mid)
      if (!transceiver) continue
      transceiver.currentDirection = section.direction
      transceiver.negotiated = transceiver.direction
    }
    this.#needsNegotiation =
      this.#restartPending || this.#transceivers.some((t) => t.mid === null || t.negotiated !== t.direction)
  }

  #afterStable(): void {
    if (this.signalingState !== 'stable') return
    this.network.check(this)
    if (this.#needsNegotiation) this.#queueNegotiation()
  }

  #sdp(sections: { kind: string; mid: string; direction: Direction }[], generation: number): string {
    const lines = [
      'v=0',
      `o=- 42 ${++this.#version} IN IP4 127.0.0.1`,
      's=-',
      't=0 0',
      `a=fingerprint:sha-256 ${this.fingerprint}`,
      `a=ice-ufrag:${this.fingerprint.slice(0, 5)}g${generation}`,
    ]
    for (const section of sections) {
      lines.push(`m=${section.kind} 9 UDP/TLS/RTP/SAVPF 96`, `a=mid:${section.mid}`, `a=${section.direction}`)
    }
    if (this.channel) lines.push('m=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=mid:data')
    return `${lines.join('\r\n')}\r\n`
  }

  /** Gather once per ICE generation, trickling each candidate and folding it into the SDP. */
  #gather(sdp: string): void {
    const ufrag = /^a=ice-ufrag:(\S+)/m.exec(sdp)?.[1] ?? ''
    if (ufrag === this.#gatheredFor) {
      if (this.localDescription) this.localDescription.sdp = this.#withCandidates(this.localDescription.sdp)
      return
    }
    this.#gatheredFor = ufrag
    this.#gathered = []
    const candidates = this.network.candidatesFor(this, ufrag)
    this.iceGatheringState = 'gathering'
    this.onicegatheringstatechange?.()
    candidates.forEach((candidate, index) => {
      setTimeout(
        () => {
          if (this.closed || this.#gatheredFor !== ufrag) return
          this.#gathered.push(candidate)
          if (this.localDescription)
            this.localDescription.sdp = this.#withCandidates(this.localDescription.sdp)
          this.onicecandidate?.({ candidate: { candidate, sdpMid: '0', sdpMLineIndex: 0 } })
        },
        this.gatherSpacingMs * (index + 1),
      )
    })
    setTimeout(
      () => {
        if (this.closed || this.#gatheredFor !== ufrag) return
        this.iceGatheringState = 'complete'
        this.onicecandidate?.({ candidate: null })
        this.onicegatheringstatechange?.()
      },
      this.gatherSpacingMs * (candidates.length + 1),
    )
  }

  #withCandidates(sdp: string): string {
    const base = sdp.split('\r\n').filter((line) => !line.startsWith('a=candidate:') && line !== '')
    return `${[...base, ...this.#gathered.map((c) => `a=${c}`)].join('\r\n')}\r\n`
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
