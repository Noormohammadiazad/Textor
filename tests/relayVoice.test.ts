import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import type { Event as NostrEvent } from 'nostr-tools/core'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACK_EVERY_MS,
  AUDIO_PACKET_BYTES,
  describeRadio,
  FRAMES_PER_PACKET,
  GONE_AFTER_MS,
  HELLO_EVERY_MS,
  KIND_RELAY_VOICE,
  KIND_VOICE_WRAP,
  MAX_SESSION_MS,
  openPacket,
  readRadio,
  RELAY_BURST,
  RELAY_REFILL_MS,
  relayList,
  RelayVoice,
  REORDER_MS,
  SLOW_RELAY_MS,
  sealPacket,
  TALK_LIMIT_MS,
  UNHEARD_AFTER_MS,
  VOICE_RELAYS,
  voiceKeys,
  WRAP_TTL_SEC,
  type VoiceView,
} from '@/core/calls/relayVoice'
import { FakeVoicePlatform, FakeVoiceRelays } from './fakeVoice'

/**
 * Push-to-talk over relays (ADR-069, ADR-070): the keys both sides make on
 * their own, the sealed packets, and sessions between two devices that read
 * on different relays, over relays that carry, block ephemeral events,
 * throttle, or cannot be reached from one side.
 */

const CALL = 'c'.repeat(64)
const CALLER_FP = 'sha-256 AA:BB'
const CALLEE_FP = 'sha-256 CC:DD'
const keysFor = (role: 'caller' | 'callee') =>
  voiceKeys({ callId: CALL, caller: CALLER_FP, callee: CALLEE_FP, role })
const settle = (ms = 50) => vi.advanceTimersByTimeAsync(ms)
const frame = (byte: number, size = 30) => new Uint8Array(size).fill(byte)
const hello = (ack = -1) => ({ listen: ['wss://a.example'], heard: [], ack })

describe('the keys', () => {
  it('are the same on both devices, each publishing under its own and listening for the other’s', () => {
    const caller = keysFor('caller')
    const callee = keysFor('callee')
    expect(caller.key).toEqual(callee.key)
    expect(caller.peer).toBe(getPublicKey(callee.secret))
    expect(callee.peer).toBe(getPublicKey(caller.secret))
    // Fingerprints and nonces read the same in either case.
    expect(
      voiceKeys({ callId: CALL, caller: CALLER_FP.toLowerCase(), callee: CALLEE_FP, role: 'caller' }),
    ).toEqual(caller)
  })

  it('differ for another call, or another opening exchange', () => {
    const { key } = keysFor('caller')
    expect(
      voiceKeys({ callId: 'd'.repeat(64), caller: CALLER_FP, callee: CALLEE_FP, role: 'caller' }).key,
    ).not.toEqual(key)
    expect(
      voiceKeys({ callId: CALL, caller: CALLER_FP, callee: 'sha-256 EE:FF', role: 'caller' }).key,
    ).not.toEqual(key)
  })
})

describe('the packets', () => {
  const { key } = keysFor('caller')

  it('carry a hello with where its sender listens, where it heard, and what it heard last', () => {
    const said = { listen: ['wss://x.example', 'wss://y.example'], heard: ['wss://x.example'], ack: 41 }
    expect(openPacket(key, sealPacket(key, { type: 'hello', seq: 7, hello: said }))).toEqual({
      type: 'hello',
      seq: 7,
      hello: said,
    })
    expect(openPacket(key, sealPacket(key, { type: 'bye', seq: 2 ** 32 - 1 }))).toEqual({
      type: 'bye',
      seq: 2 ** 32 - 1,
    })
    const frames = [frame(1), frame(2, 31)]
    expect(openPacket(key, sealPacket(key, { type: 'audio', seq: 9, frames }))).toEqual({
      type: 'audio',
      seq: 9,
      frames,
    })
    expect(openPacket(key, sealPacket(key, { type: 'audio', seq: 9, frames, start: true }))).toEqual({
      type: 'audio',
      seq: 9,
      frames,
      start: true,
    })
  })

  it('are all the same size when they carry audio, so the end of a phrase looks like the rest', () => {
    const sizes = [1, 7, FRAMES_PER_PACKET].map(
      (count) =>
        sealPacket(key, { type: 'audio', seq: 1, frames: Array.from({ length: count }, () => frame(1)) })
          .length,
    )
    expect(new Set(sizes).size).toBe(1)
    expect(sizes[0]).toBe(Math.ceil((24 + AUDIO_PACKET_BYTES + 16) / 3) * 4)
  })

  it('open only under their own key, and only in their own shape', () => {
    const other = keysFor('callee').key.map((byte) => byte ^ 1)
    expect(openPacket(other, sealPacket(key, { type: 'bye', seq: 1 }))).toBeNull()
    expect(openPacket(key, 'not base64 at all!')).toBeNull()
    const seal = (plain: number[]) => {
      const nonce = new Uint8Array(24)
      const sealed = xchacha20poly1305(key, nonce).encrypt(Uint8Array.from(plain))
      return btoa(String.fromCharCode(...nonce, ...sealed))
    }
    const json = (value: unknown) => [...new TextEncoder().encode(JSON.stringify(value))]
    expect(openPacket(key, seal([]))).toBeNull()
    expect(openPacket(key, seal([1, 3, 0, 0, 0, 1, 0]))).toBeNull() // an older version
    expect(openPacket(key, seal([2, 9, 0, 0, 0, 1, 0]))).toBeNull() // no such type
    expect(openPacket(key, seal([2, 3, 0, 0, 0]))).toBeNull() // too short
    expect(openPacket(key, seal([2, 2, 0, 0, 0, 1, 2, 1, 5]))).toBeNull() // a second frame that is not there
    expect(openPacket(key, seal([2, 2, 0, 0, 0, 1, 1, 9, 5]))).toBeNull() // a frame longer than the packet
    expect(openPacket(key, seal([2, 1, 0, 0, 0, 1, 0, ...new TextEncoder().encode('{')]))).toBeNull() // not JSON
    expect(openPacket(key, seal([2, 1, 0, 0, 0, 1, 0, ...json('{')]))).toBeNull() // JSON, but not a hello
    expect(openPacket(key, seal([2, 1, 0, 0, 0, 1, 0, ...json({ l: [], h: 'x', a: 1 })]))).toBeNull()
    expect(openPacket(key, seal([2, 1, 0, 0, 0, 1, 0, ...json({ l: [], h: [], a: '1' })]))).toBeNull()
  })

  it('name only a few well-formed wss: relays, however many were named', () => {
    const named = [
      'wss://one.example',
      'WSS://One.Example/',
      'ws://plain.example',
      'https://web.example',
      42,
      ...Array.from({ length: 12 }, (_, i) => `wss://r${i}.example`),
    ]
    const listed = relayList(named)
    expect(listed[0]).toBe('wss://one.example')
    expect(listed).toHaveLength(8)
    expect(listed.every((url) => url.startsWith('wss://'))).toBe(true)
  })

  it('describe a walkie-talkie’s side of the opening exchange, and refuse anything else', () => {
    const nonce = 'f'.repeat(64)
    const description = describeRadio({ nonce, listen: ['wss://a.example', 'http://no.example'] })
    expect(readRadio(description)).toEqual({ nonce, listen: ['wss://a.example'] })
    for (const sdp of [
      'v=0',
      JSON.stringify({ radio: 2, nonce, listen: [] }),
      JSON.stringify({ radio: 1, nonce: 'short', listen: [] }),
      JSON.stringify({ radio: 1, nonce: 5, listen: [] }),
      JSON.stringify({ radio: 1, nonce, listen: 'wss://a.example' }),
    ]) {
      expect(readRadio(sdp)).toBeNull()
    }
  })
})

describe('a session', () => {
  const A_READ = ['wss://a.example']
  const B_READ = ['wss://b.example']
  let relays: FakeVoiceRelays
  let aMic: FakeVoicePlatform
  let bMic: FakeVoicePlatform
  let caller: RelayVoice
  let callee: RelayVoice
  const keyOf = keysFor('caller').key
  const open = (event: NostrEvent) => openPacket(keyOf, event.content)
  const audioTo = (relay: string) => relays.sentTo(relay).filter((event) => open(event)?.type === 'audio')
  const allAudio = () => relays.published.filter(({ event }) => open(event)?.type === 'audio')
  /** Hand the callee a packet from the caller directly, as one relay of several would. */
  const deliver = (packet: Parameters<typeof sealPacket>[1], url?: string) => {
    const event = finalizeEvent(
      { kind: KIND_RELAY_VOICE, created_at: 1, tags: [], content: sealPacket(keyOf, packet) },
      keysFor('caller').secret,
    )
    for (const subscription of relays.subscriptions) {
      if (subscription.filter.authors?.includes(event.pubkey)) subscription.onEvent(event, url)
    }
  }

  /** Hand the caller a hello from the callee, as one relay of several would. */
  const helloToCaller = (body: Parameters<typeof sealPacket>[1]) => {
    const event = finalizeEvent(
      { kind: KIND_RELAY_VOICE, created_at: 1, tags: [], content: sealPacket(keyOf, body) },
      keysFor('callee').secret,
    )
    for (const subscription of relays.subscriptions) {
      if (subscription.filter.authors?.includes(event.pubkey)) subscription.onEvent(event, VOICE_RELAYS[0])
    }
  }

  const make = (opts: { aUnreachable?: string[]; bUnreachable?: string[] } = {}) => {
    caller = new RelayVoice(
      keysFor('caller'),
      { pool: relays.pool(A_READ, opts.aUnreachable), relays: B_READ, mine: () => A_READ },
      aMic,
    )
    callee = new RelayVoice(
      keysFor('callee'),
      { pool: relays.pool(B_READ, opts.bUnreachable), relays: A_READ, mine: () => B_READ },
      bMic,
    )
    caller.listen()
    callee.listen()
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    relays = new FakeVoiceRelays()
    aMic = new FakeVoicePlatform()
    bMic = new FakeVoicePlatform()
    make()
  })

  afterEach(() => {
    caller.close()
    callee.close()
    vi.useRealTimers()
  })

  it('meets on the voice relays, wherever each side reads, and says when the other joins', async () => {
    const seen: VoiceView[] = []
    callee.events.on('changed', (view) => seen.push(view))
    expect(callee.view).toMatchObject({ state: 'listening', peerHere: false, heard: null })
    await caller.join()
    await settle()
    expect(callee.view.peerHere).toBe(true)
    expect(seen.at(-1)?.peerHere).toBe(true)
    // Its first hello went where both sides always listen.
    const [first] = relays.published
    expect(VOICE_RELAYS).toContain(first?.relay)
    expect(first?.event).toMatchObject({ kind: KIND_RELAY_VOICE, tags: [], pubkey: keysFor('callee').peer })
    expect(aMic.capturing).toBe(true)
  })

  it('carries voice both ways, and each side learns that it is heard', async () => {
    await caller.join()
    await callee.join()
    await settle()
    caller.talk(true)
    expect(aMic.muted).toBe(true)
    aMic.speak(FRAMES_PER_PACKET, 1)
    aMic.speak(5, 2)
    await settle()
    caller.talk(false)
    expect(aMic.muted).toBe(false)
    await settle()
    expect(bMic.played.map((f) => f[0])).toEqual([...Array<number>(FRAMES_PER_PACKET).fill(1), 2, 2, 2, 2, 2])
    // Not known yet: the callee has not said.
    expect(caller.view.heard).toBeNull()
    // Hearing, the callee says so soon: within a hello's spacing and a tick.
    await settle(ACK_EVERY_MS + 600)
    expect(caller.view.heard).toBe(true)

    callee.talk(true)
    bMic.speak(3, 9)
    callee.talk(false)
    await settle()
    expect(aMic.played.map((f) => f[0])).toEqual([9, 9, 9])
  })

  it('sends each packet once, sharing them around until the other side says where it hears', async () => {
    await caller.join()
    await callee.join()
    await settle(100)
    // What it has said so far is nothing yet.
    helloToCaller({ type: 'hello', seq: 1, hello: { listen: [...VOICE_RELAYS], heard: [], ack: -1 } })
    caller.talk(true)
    for (let i = 0; i < 4; i++) aMic.speak(FRAMES_PER_PACKET, i + 1)
    caller.talk(false)
    await settle()
    const audio = allAudio()
    expect(audio).toHaveLength(4)
    expect(new Set(audio.map(({ relay }) => relay)).size).toBeGreaterThan(1)
    expect(bMic.played).toHaveLength(4 * FRAMES_PER_PACKET)
  })

  it('gets through a relay that blocks ephemeral events as an expiring gift-wrap kind', async () => {
    for (const url of VOICE_RELAYS) relays.blockingEphemeral.add(url)
    await caller.join()
    await settle()
    expect(callee.view.peerHere).toBe(true)
    const wrapped = relays.published.find(({ event }) => event.kind === KIND_VOICE_WRAP)!.event
    expect(wrapped.tags[0]).toEqual([
      'p',
      keysFor('callee').peer.length ? getPublicKey(keysFor('callee').secret) : '',
    ])
    expect(Number(wrapped.tags[1]?.[1]) - wrapped.created_at).toBe(WRAP_TTL_SEC)
    // From then on, that relay gets the gift-wrap kind straight away.
    await settle(HELLO_EVERY_MS)
    const later = relays.published.filter(({ event }) => event.kind === KIND_RELAY_VOICE)
    expect(later.every(({ relay }) => !VOICE_RELAYS.includes(relay))).toBe(true)
  })

  it('drops a relay that refuses outright, and sends what it lost another way', async () => {
    await caller.join()
    await callee.join()
    await settle()
    const left = VOICE_RELAYS[1]!
    for (const url of [...VOICE_RELAYS, ...B_READ]) if (url !== left) relays.refusing.set(url, 'rate limited')
    const before = caller.view.relays
    caller.talk(true)
    for (let i = 0; i < 3; i++) aMic.speak(FRAMES_PER_PACKET, i + 1)
    caller.talk(false)
    await settle()
    expect(bMic.played).toHaveLength(3 * FRAMES_PER_PACKET)
    expect(caller.view.relays).toBeLessThan(before)
    expect(audioTo(left).length).toBeGreaterThan(0)
  })

  it('reaches the other side where it reads when the voice relays cannot be reached from here', async () => {
    caller.close()
    callee.close()
    make({ aUnreachable: [...VOICE_RELAYS] })
    await callee.join()
    await caller.join()
    await settle()
    // The caller's hellos fail at the voice relays, then go to the callee's inbox.
    await settle(HELLO_EVERY_MS)
    expect(callee.view.peerHere).toBe(true)
    caller.talk(true)
    aMic.speak(FRAMES_PER_PACKET, 4)
    caller.talk(false)
    await settle()
    expect(bMic.played).toHaveLength(FRAMES_PER_PACKET)
  })

  it('says so when every relay that could reach them refuses', async () => {
    for (const url of [...VOICE_RELAYS, ...B_READ]) relays.refusing.set(url, 'blocked: spam not permitted')
    await caller.join()
    await settle()
    expect(caller.view.state).toBe('live')
    await settle(HELLO_EVERY_MS)
    expect(caller.view).toMatchObject({ state: 'refused', relays: 0 })
    // Joining again finds them refused still.
    caller.leave()
    await caller.join()
    expect(caller.view.state).toBe('refused')
  })

  it('gives no relay more than its share, and says when every share is spent', async () => {
    for (const url of [...VOICE_RELAYS.slice(1), ...B_READ]) relays.refusing.set(url, 'rate limited')
    await caller.join()
    await settle()
    caller.talk(true)
    // The others' refusals come back from the first packets, leaving one relay.
    for (let i = 0; i < 4; i++) {
      aMic.speak(FRAMES_PER_PACKET, i)
      await settle(50)
    }
    for (let i = 0; i < 20; i++) aMic.speak(FRAMES_PER_PACKET, i)
    expect(caller.view.throttled).toBe(true)
    await settle()
    expect(relays.sentTo(VOICE_RELAYS[0]!).length).toBeLessThanOrEqual(RELAY_BURST + 1)
    // A share comes back with time.
    const before = audioTo(VOICE_RELAYS[0]!).length
    await settle(RELAY_REFILL_MS * 2)
    aMic.speak(FRAMES_PER_PACKET, 99)
    await settle()
    expect(audioTo(VOICE_RELAYS[0]!).length).toBe(before + 1)
  })

  it('lets go of the button after thirty seconds, as a radio does', async () => {
    await caller.join()
    caller.talk(true)
    await settle(TALK_LIMIT_MS)
    expect(caller.view.talking).toBe(false)
  })

  it('charges a relay only for what it carries', async () => {
    await caller.join()
    await callee.join()
    await settle(100)
    caller.talk(true)
    // Four relays: twenty at once is five each, well within any one's share.
    for (let i = 0; i < 20; i++) aMic.speak(FRAMES_PER_PACKET, i)
    expect(caller.view.throttled).toBe(false)
    expect(allAudio()).toHaveLength(20)
  })

  it('carries a whole press at speaking pace: once each, all of it, and knows it is heard', async () => {
    await caller.join()
    await callee.join()
    await settle(100)
    caller.talk(true)
    const heard: (boolean | null)[] = []
    const packets = Math.floor(TALK_LIMIT_MS / (FRAMES_PER_PACKET * 20)) - 1
    for (let i = 0; i < packets; i++) {
      aMic.speak(FRAMES_PER_PACKET, i)
      await settle(FRAMES_PER_PACKET * 20)
      expect(caller.view.throttled).toBe(false)
      heard.push(caller.view.heard)
    }
    caller.talk(false)
    await settle(ACK_EVERY_MS + 600)
    // Each went one way: the newest being unacknowledged is not being unheard.
    expect(allAudio()).toHaveLength(packets)
    expect(bMic.played).toHaveLength(packets * FRAMES_PER_PACKET)
    // Unknown at first, then known, for the rest of the press and after it.
    expect(heard[0]).toBeNull()
    expect(heard.at(-1)).toBe(true)
    expect(heard).not.toContain(false)
    expect(caller.view.heard).toBe(true)

    // A new press starts unknown again.
    caller.talk(true)
    aMic.speak(FRAMES_PER_PACKET, 1)
    expect(caller.view.heard).toBeNull()
    caller.talk(false)
  })

  it('takes a hello behind the newest packet as heard, and sends once while they keep up', async () => {
    await caller.join()
    callee.close()
    caller.talk(true)
    aMic.speak(FRAMES_PER_PACKET, 1)
    aMic.speak(FRAMES_PER_PACKET, 2)
    await settle(UNHEARD_AFTER_MS - 500)
    // They have heard the first; the second is on its way, as the newest always is.
    const behind = finalizeEvent(
      {
        kind: KIND_RELAY_VOICE,
        created_at: 1,
        tags: [],
        content: sealPacket(keyOf, { type: 'hello', seq: 9, hello: hello(0) }),
      },
      keysFor('callee').secret,
    )
    for (const subscription of relays.subscriptions) {
      if (subscription.filter.authors?.includes(behind.pubkey)) subscription.onEvent(behind, VOICE_RELAYS[0])
    }
    expect(caller.view.heard).toBe(true)
    // Past when it would have counted as unheard had nothing come: still once.
    await settle(1000)
    const before = allAudio().length
    aMic.speak(FRAMES_PER_PACKET, 3)
    await settle()
    expect(allAudio()).toHaveLength(before + 1)
    // And if nothing more comes, it is not heard after all.
    await settle(UNHEARD_AFTER_MS)
    expect(caller.view.heard).toBe(false)
  })

  it('says it is not heard when acknowledgements stop halfway through a press', async () => {
    await caller.join()
    await callee.join()
    await settle(100)
    caller.talk(true)
    aMic.speak(FRAMES_PER_PACKET, 1)
    aMic.speak(FRAMES_PER_PACKET, 2)
    await settle(ACK_EVERY_MS + 600)
    aMic.speak(FRAMES_PER_PACKET, 3)
    await settle()
    expect(caller.view.heard).toBe(true)
    callee.close()
    await settle(UNHEARD_AFTER_MS + 600)
    expect(caller.view.heard).toBe(false)
  })

  it('uses a slow relay last, until the other side is not hearing, and forgives it once quick', async () => {
    const slow = VOICE_RELAYS[0]!
    relays.acceptMs.set(slow, SLOW_RELAY_MS + 1)
    await caller.join()
    callee.close()
    await settle(100)
    caller.talk(true)
    // Its first answer opened the connection and says nothing. Its second gives it away.
    for (let i = 0; i < 12; i++) {
      aMic.speak(FRAMES_PER_PACKET, i)
      await settle(50)
      helloToCaller({ type: 'hello', seq: 100 + i, hello: hello(i) })
    }
    const sent = audioTo(slow).length
    for (let i = 0; i < 8; i++) {
      aMic.speak(FRAMES_PER_PACKET, i)
      await settle(50)
      helloToCaller({ type: 'hello', seq: 200 + i, hello: hello(12 + i) })
    }
    expect(audioTo(slow)).toHaveLength(sent)
    // Nobody is answering any more: any relay may be the way through.
    aMic.speak(FRAMES_PER_PACKET, 1)
    await settle(UNHEARD_AFTER_MS + 100)
    relays.acceptMs.delete(slow)
    for (let i = 0; i < 4; i++) {
      aMic.speak(FRAMES_PER_PACKET, i)
      await settle(50)
    }
    const after = audioTo(slow).length
    expect(after).toBeGreaterThan(sent)
    // It answered quickly this time, so it is back in the ring when they hear again.
    helloToCaller({ type: 'hello', seq: 300, hello: hello(10_000) })
    await settle(RELAY_REFILL_MS)
    for (let i = 0; i < 4; i++) {
      aMic.speak(FRAMES_PER_PACKET, i)
      await settle(50)
    }
    expect(audioTo(slow).length).toBeGreaterThan(after)
  })

  it('leaves a relay that needs the gift-wrap kind until last, while others carry it', async () => {
    const wrapped = VOICE_RELAYS[0]!
    relays.blockingEphemeral.add(wrapped)
    await caller.join()
    await callee.join()
    await settle(100)
    caller.talk(true)
    for (let i = 0; i < 4; i++) {
      aMic.speak(FRAMES_PER_PACKET, i)
      await settle(50)
    }
    // A hello found out; it has carried no audio since.
    expect(relays.sentTo(wrapped).some(({ kind }) => kind === KIND_VOICE_WRAP)).toBe(true)
    expect(audioTo(wrapped)).toHaveLength(0)
    expect(allAudio()).toHaveLength(4)
  })

  it('sends where the other side says it hears, once it has said', async () => {
    await caller.join()
    callee.close()
    await settle(100)
    const heardOn = VOICE_RELAYS[2]!
    helloToCaller({ type: 'hello', seq: 1, hello: { listen: [], heard: [heardOn], ack: -1 } })
    caller.talk(true)
    for (let i = 0; i < 6; i++) {
      aMic.speak(FRAMES_PER_PACKET, i)
      await settle(50)
    }
    expect(audioTo(heardOn)).toHaveLength(6)
    expect(allAudio()).toHaveLength(6)
  })

  it('sends by a slow relay when that is all that has been shown to reach them', async () => {
    const only = VOICE_RELAYS[1]!
    relays.blockingEphemeral.add(only)
    await caller.join()
    callee.close()
    await settle(100)
    caller.talk(true)
    for (let i = 0; i < 4; i++) {
      aMic.speak(FRAMES_PER_PACKET, i)
      await settle(50)
    }
    // Their network lets them hear only the relay this side likes least.
    helloToCaller({ type: 'hello', seq: 1, hello: { listen: [], heard: [only], ack: 3 } })
    const before = audioTo(only).length
    for (let i = 0; i < 4; i++) {
      aMic.speak(FRAMES_PER_PACKET, i)
      await settle(50)
    }
    expect(audioTo(only)).toHaveLength(before + 4)
  })

  it('sends twice, two ways, while the other side has not said it hears', async () => {
    await caller.join()
    callee.close()
    // Heard while not held: nothing goes.
    aMic.speak(FRAMES_PER_PACKET, 1)
    caller.talk(true)
    // A frame too short or too long for its length byte is dropped.
    aMic.speak(1, 1, 0)
    aMic.speak(1, 1, 256)
    aMic.speak(FRAMES_PER_PACKET, 1)
    await settle()
    expect(allAudio()).toHaveLength(1)
    // A hello from before they heard anything is no acknowledgement.
    const stale = finalizeEvent(
      {
        kind: KIND_RELAY_VOICE,
        created_at: 1,
        tags: [],
        content: sealPacket(keyOf, { type: 'hello', seq: 9, hello: hello(-1) }),
      },
      keysFor('callee').secret,
    )
    for (const subscription of relays.subscriptions) {
      if (subscription.filter.authors?.includes(stale.pubkey)) subscription.onEvent(stale, VOICE_RELAYS[0])
    }
    await settle(UNHEARD_AFTER_MS)
    expect(caller.view.heard).toBe(false)
    aMic.speak(FRAMES_PER_PACKET, 2)
    await settle()
    expect(allAudio()).toHaveLength(3)
  })

  it('waits out a packet as late as a slow relay was measured making one, losing nothing', async () => {
    await callee.join()
    deliver({ type: 'audio', seq: 10, frames: [frame(1)], start: true })
    deliver({ type: 'audio', seq: 12, frames: [frame(3)] })
    await settle(4100)
    expect(bMic.played.map((f) => f[0])).toEqual([1])
    deliver({ type: 'audio', seq: 11, frames: [frame(2)] })
    expect(bMic.played.map((f) => f[0])).toEqual([1, 2, 3])
  })

  it('plays packets in order whichever way they came, and passes over one that never comes', async () => {
    await callee.join()
    deliver({ type: 'audio', seq: 101, frames: [frame(1)], start: true }, 'wss://x.example')
    deliver({ type: 'audio', seq: 103, frames: [frame(3)] })
    deliver({ type: 'audio', seq: 102, frames: [frame(2)] })
    deliver({ type: 'audio', seq: 102, frames: [frame(2)] })
    deliver({ type: 'audio', seq: 101, frames: [frame(1)] })
    expect(bMic.played.map((f) => f[0])).toEqual([1, 2, 3])
    // 104 is lost: 105 waits for it a moment, then plays.
    deliver({ type: 'audio', seq: 105, frames: [frame(5)] })
    expect(bMic.played).toHaveLength(3)
    await settle(REORDER_MS)
    expect(bMic.played.map((f) => f[0])).toEqual([1, 2, 3, 5])
    // Joined mid-press: what comes first waits a moment for what came before it.
    deliver({ type: 'audio', seq: 400, frames: [frame(7)] })
    expect(bMic.played).toHaveLength(4)
    await settle(REORDER_MS)
    expect(bMic.played).toHaveLength(5)
  })

  it('says hello sooner when there is something new to acknowledge', async () => {
    await callee.join()
    await settle()
    // Each hello goes to two relays: counted once.
    const hellos = () =>
      new Set(
        relays.published.filter(({ event }) => open(event)?.type === 'hello').map(({ event }) => event.id),
      ).size
    const before = hellos()
    for (let i = 0; i < 8; i++) {
      deliver({ type: 'audio', seq: 200 + i, frames: [frame(1)] })
      await settle(800)
    }
    expect(hellos() - before).toBeGreaterThanOrEqual(2)
    // With nothing new to acknowledge, a hello every six seconds: wait for
    // one, then there is none for most of six seconds, and then one more.
    await settle(HELLO_EVERY_MS)
    const quiet = hellos()
    while (hellos() === quiet) await settle(100)
    const after = hellos()
    await settle(HELLO_EVERY_MS - 700)
    expect(hellos()).toBe(after)
    await settle(1200)
    expect(hellos()).toBe(after + 1)
  })

  it('takes a goodbye as gone, and ignores what is not from the other side or not theirs to read', async () => {
    await caller.join()
    await settle()
    expect(callee.view.peerHere).toBe(true)
    const [first] = relays.published
    for (const subscription of relays.subscriptions) {
      subscription.onEvent({ ...first!.event, pubkey: 'f'.repeat(64) })
      subscription.onEvent({ ...first!.event, content: 'nonsense' })
    }
    deliver({ type: 'hello', seq: 1, hello: hello() })
    caller.leave()
    await settle()
    expect(callee.view.peerHere).toBe(false)
    expect(caller.view.state).toBe('listening')
    expect(aMic.capturing).toBe(false)
    await settle(GONE_AFTER_MS)
  })

  it('says when this browser cannot do it, and when the microphone or speaker will not start', async () => {
    aMic.isSupported = false
    await caller.join()
    expect(caller.view.state).toBe('unsupported')
    caller.leave()
    aMic.isSupported = true
    aMic.captureError = new Error('NotAllowedError')
    await caller.join()
    expect(caller.view.state).toBe('failed')
    aMic.captureError = null
    aMic.playerError = new Error('no audio')
    await caller.join()
    expect(caller.view.state).toBe('failed')
    aMic.playerError = null
    await caller.join()
    expect(caller.view.state).toBe('live')
  })

  it('lets go of the microphone when left while it was still opening, or after half an hour', async () => {
    const joining = caller.join()
    caller.leave()
    await joining
    expect(caller.view.state).toBe('listening')
    expect(aMic.capturing).toBe(false)
    await caller.join()
    caller.talk(true)
    await settle(MAX_SESSION_MS)
    expect(caller.view.state).toBe('listening')
  })

  it('gives up quietly on audio refused after it left, with nowhere left to send it', async () => {
    const [first, second, third] = VOICE_RELAYS as [string, string, string]
    for (const url of [first, second, third]) relays.refusing.set(url, 'rate limited')
    caller.close()
    caller = new RelayVoice(
      keysFor('caller'),
      { pool: relays.pool(A_READ), relays: [], mine: () => A_READ },
      aMic,
    )
    caller.listen()
    await caller.join()
    await settle()
    caller.talk(true)
    aMic.speak(FRAMES_PER_PACKET, 1)
    caller.leave()
    await settle()
    expect(caller.view).toMatchObject({ state: 'listening', relays: 0 })
  })

  it('pays no heed to answers that come after it closed, and is over for good once closed', async () => {
    relays.refusing.set(VOICE_RELAYS[0]!, 'rate limited')
    await caller.join()
    caller.close()
    await settle()
    caller.close()
    expect(caller.view.state).toBe('closed')
    await caller.join()
    caller.talk(true)
    caller.leave()
    expect(caller.view.state).toBe('closed')
  })

  it('does not try the gift-wrap kind on a relay whose share is spent', async () => {
    // The hello goes to the first two voice relays, which refuse; the third
    // blocks ephemeral events, and is first tried with a share's worth at once.
    const [first, second, third] = VOICE_RELAYS as [string, string, string]
    relays.refusing.set(first, 'rate limited')
    relays.refusing.set(second, 'rate limited')
    relays.blockingEphemeral.add(third)
    caller.close()
    caller = new RelayVoice(
      keysFor('caller'),
      { pool: relays.pool(A_READ), relays: [], mine: () => A_READ },
      aMic,
    )
    caller.listen()
    await caller.join()
    await settle()
    caller.talk(true)
    for (let i = 0; i < RELAY_BURST; i++) aMic.speak(FRAMES_PER_PACKET, i)
    await settle()
    expect(relays.published.filter(({ event }) => event.kind === KIND_VOICE_WRAP)).toHaveLength(0)
  })

  it('plays the first packet of a press at once, and waits for it when it comes late', async () => {
    await callee.join()
    deliver({ type: 'audio', seq: 300, frames: [frame(1)], start: true })
    expect(bMic.played).toHaveLength(1)
    // The next press's first packet was rerouted, and comes after its second.
    deliver({ type: 'audio', seq: 302, frames: [frame(3)] })
    expect(bMic.played).toHaveLength(1)
    deliver({ type: 'audio', seq: 301, frames: [frame(2)], start: true })
    expect(bMic.played.map((f) => f[0])).toEqual([1, 2, 3])
  })
})
