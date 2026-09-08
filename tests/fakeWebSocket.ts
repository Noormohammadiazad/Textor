import type { Event as NostrEvent } from 'nostr-tools/core'
import type { Filter } from 'nostr-tools/filter'
import type { WebSocketFactory, WebSocketLike } from '@/core/transport/relaySocket'
import { verifyEventSignature } from '@/core/crypto/giftwrap'
import { matches } from './fakeRelay'

/**
 * A relay network at the WebSocket level, for testing the real socket and pool
 * code rather than a stand-in for them.
 *
 * Each behaviour models a failure measured against live public relays or
 * inherent to mobile networks. Every delay is a `setTimeout`, so tests drive
 * the clock with fake timers and assertions about latency are deterministic.
 */
export interface RelayBehaviour {
  /** Handshake duration. Measured one to ten seconds on a slow link. */
  connectDelayMs: number
  /** The handshake fails outright, as a relay that is down or blocked does. */
  refuse: boolean
  /** The handshake never completes and never errors: a black-holed address. */
  blackhole: boolean
  /** Delay before the relay answers a publish. */
  okDelayMs: number
  /** Delay before stored events and EOSE are sent for a subscription. */
  eoseDelayMs: number
  /** Reject every publish with this reason — the full-disk relay. */
  rejectWrites: string | null
  /** Refuse every subscription with this CLOSED reason — the NIP-42 relay. */
  refuseReads: string | null
  /**
   * The connection goes silent without closing: nothing is delivered in
   * either direction. What a dead network path looks like from the browser.
   */
  silent: boolean
  /**
   * A NAT that forgets a mapping after this much client silence. After that
   * the connection is dead but still looks open. 0 disables.
   */
  natIdleMs: number
}

const DEFAULT_BEHAVIOUR: RelayBehaviour = {
  connectDelayMs: 0,
  refuse: false,
  blackhole: false,
  okDelayMs: 0,
  eoseDelayMs: 0,
  rejectWrites: null,
  refuseReads: null,
  silent: false,
  natIdleMs: 0,
}

interface Connection {
  socket: FakeWebSocket
  subs: Map<string, Filter[]>
  /** The path is dead: a NAT dropped it, or the server went silent. */
  dead: boolean
  natTimer: ReturnType<typeof setTimeout> | null
}

export class FakeRelayServer {
  readonly url: string
  behaviour: RelayBehaviour
  readonly stored: NostrEvent[] = []
  readonly connections = new Set<Connection>()
  connectAttempts = 0
  /** Every EVENT frame received, including duplicates. */
  eventFrames = 0
  /** Every REQ received, for asserting what a resumed subscription asked for. */
  readonly reqs: { id: string; filters: Filter[] }[] = []

  constructor(url: string, behaviour: Partial<RelayBehaviour> = {}) {
    this.url = url
    this.behaviour = { ...DEFAULT_BEHAVIOUR, ...behaviour }
  }

  set(patch: Partial<RelayBehaviour>): void {
    this.behaviour = { ...this.behaviour, ...patch }
  }

  get openConnections(): number {
    return [...this.connections].filter((c) => c.socket.readyState === 1).length
  }

  /** The server closes every connection, as a relay restart does. */
  dropAll(): void {
    for (const connection of [...this.connections]) connection.socket.serverClose()
  }

  /** Store an event as if another client had published it, and deliver it live. */
  inject(event: NostrEvent): void {
    this.#store(event)
  }

  accept(socket: FakeWebSocket): void {
    this.connectAttempts += 1
    const { refuse, blackhole, connectDelayMs } = this.behaviour
    if (blackhole) return
    setTimeout(() => {
      if (socket.readyState !== 0) return
      if (refuse) {
        socket.fail()
        return
      }
      const connection: Connection = { socket, subs: new Map(), dead: false, natTimer: null }
      this.connections.add(connection)
      socket.connection = connection
      socket.server = this
      socket.opened()
      this.#armNat(connection)
    }, connectDelayMs)
  }

  forget(connection: Connection): void {
    if (connection.natTimer) clearTimeout(connection.natTimer)
    this.connections.delete(connection)
  }

  receive(connection: Connection, data: string): void {
    if (connection.dead || this.behaviour.silent) return
    this.#armNat(connection)

    const frame = JSON.parse(data) as unknown[]
    switch (frame[0]) {
      case 'REQ': {
        const id = frame[1] as string
        const filters = frame.slice(2) as Filter[]
        this.reqs.push({ id, filters })
        if (this.behaviour.refuseReads) {
          this.#send(connection, ['CLOSED', id, this.behaviour.refuseReads])
          return
        }
        connection.subs.set(id, filters)
        setTimeout(() => {
          if (!connection.subs.has(id)) return
          for (const event of this.stored) {
            if (filters.some((filter) => matchesWithIds(filter, event)))
              this.#send(connection, ['EVENT', id, event])
          }
          this.#send(connection, ['EOSE', id])
        }, this.behaviour.eoseDelayMs)
        return
      }
      case 'CLOSE':
        connection.subs.delete(frame[1] as string)
        return
      case 'EVENT': {
        this.eventFrames += 1
        const event = frame[1] as NostrEvent
        setTimeout(() => {
          if (!verifyEventSignature(event)) {
            this.#send(connection, ['OK', event.id, false, 'invalid: bad signature'])
            return
          }
          if (this.behaviour.rejectWrites) {
            this.#send(connection, ['OK', event.id, false, this.behaviour.rejectWrites])
            return
          }
          const duplicate = this.stored.some((existing) => existing.id === event.id)
          if (!duplicate) this.#store(event)
          this.#send(connection, ['OK', event.id, true, duplicate ? 'duplicate: already have it' : ''])
        }, this.behaviour.okDelayMs)
        return
      }
    }
  }

  #store(event: NostrEvent): void {
    if (this.stored.some((existing) => existing.id === event.id)) return
    this.stored.push(event)
    for (const connection of this.connections) {
      for (const [id, filters] of connection.subs) {
        if (filters.some((filter) => matchesWithIds(filter, event)))
          this.#send(connection, ['EVENT', id, event])
      }
    }
  }

  #send(connection: Connection, frame: unknown[]): void {
    if (connection.dead || this.behaviour.silent) return
    connection.socket.deliver(JSON.stringify(frame))
  }

  #armNat(connection: Connection): void {
    if (connection.natTimer) clearTimeout(connection.natTimer)
    connection.natTimer = null
    const { natIdleMs } = this.behaviour
    if (natIdleMs <= 0) return
    connection.natTimer = setTimeout(() => {
      // The mapping is gone. Nothing closes; traffic simply stops.
      connection.dead = true
    }, natIdleMs)
  }
}

/** `matches` from the fake relay, plus `ids` and `limit: 0`, which probes use. */
function matchesWithIds(filter: Filter, event: NostrEvent): boolean {
  if (filter.limit === 0) return false
  if (filter.ids && !filter.ids.includes(event.id)) return false
  return matches(filter, event)
}

export class FakeWebSocket implements WebSocketLike {
  readyState = 0
  onopen: ((event: unknown) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  server: FakeRelayServer | null = null
  connection: Connection | null = null
  readonly sent: string[] = []

  constructor(readonly url: string) {}

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('InvalidStateError: socket is not open')
    this.sent.push(data)
    if (this.server && this.connection) this.server.receive(this.connection, data)
  }

  close(): void {
    if (this.readyState >= 2) return
    const wasConnecting = this.readyState === 0
    this.readyState = 3
    if (this.server && this.connection) this.server.forget(this.connection)
    // A real browser reports the close later, and only if a handler remains.
    setTimeout(() => {
      if (!wasConnecting) this.onclose?.({})
    }, 0)
  }

  opened(): void {
    this.readyState = 1
    this.onopen?.({})
  }

  fail(): void {
    this.readyState = 3
    this.onerror?.({})
    this.onclose?.({})
  }

  serverClose(): void {
    if (this.readyState !== 1) return
    this.readyState = 3
    if (this.server && this.connection) this.server.forget(this.connection)
    this.onclose?.({})
  }

  deliver(data: string): void {
    setTimeout(() => {
      if (this.readyState === 1) this.onmessage?.({ data })
    }, 0)
  }
}

export class FakeSocketNetwork {
  readonly servers = new Map<string, FakeRelayServer>()
  readonly sockets: FakeWebSocket[] = []

  relay(url: string, behaviour: Partial<RelayBehaviour> = {}): FakeRelayServer {
    const server = new FakeRelayServer(url, behaviour)
    this.servers.set(url, server)
    return server
  }

  readonly factory: WebSocketFactory = (url) => {
    const socket = new FakeWebSocket(url)
    this.sockets.push(socket)
    const server = this.servers.get(url)
    if (server) server.accept(socket)
    else setTimeout(() => socket.fail(), 0)
    return socket
  }
}
