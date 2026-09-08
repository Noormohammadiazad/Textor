import type { Event as NostrEvent } from 'nostr-tools/core'
import type { Filter } from 'nostr-tools/filter'
import { finalizeEvent } from 'nostr-tools/pure'
import { decodeKeyPackage, encodeKeyPackage } from 'ts-mls/keyPackage.js'
import type { Rumor } from '../crypto/giftwrap'
import { MAX_MLS_MEMBERS } from '../models/protocol'
import type { Conversation } from '../models/types'
import type { SubCloser } from '../transport/relayPool'
import { createLogger } from '../util/log'
import { b64ToBytes, bytesToB64, bytesToHex } from '../util/bytes'
import { MarmotGroup, type GroupRecord, type KeyPackageBundle, type OpenOutcome } from './group'
import type { InnerEvent, MlsHost, Readiness } from './host'
import { GroupChat } from './chat'
import {
  canonicalRelays,
  createKeyPackage,
  groupEventRoute,
  KIND_GROUP_EVENT,
  KIND_KEY_PACKAGE,
  keyPackageEvent,
  keyPackageRef,
  parseKeyPackageEvent,
  parseWelcomeRumor,
  SUPPORTED_COMPONENTS,
  welcomeRumor,
  type KeyPackageCandidate,
} from './marmot'

const log = createLogger('mls')

/** A change to a group, as `MarmotGroup.commit` takes it. */
type Change = NonNullable<Parameters<MarmotGroup['commit']>[1]>

/** Our own keys in a group are refreshed at least this often: post-compromise security. */
const ROTATE_EVERY_SEC = 7 * 86_400
/** A published KeyPackage is replaced once it has less than this left to live. */
const KEY_PACKAGE_REFRESH_SEC = 14 * 86_400
/**
 * A replaced KeyPackage's private keys are kept this long, for a Welcome
 * already on its way to it — then deleted, as Marmot asks.
 */
const REPLACED_KEY_GRACE_SEC = 7 * 86_400
/** A group's messages carry their sender's clock; this much skew is tolerated. */
const CLOCK_MARGIN_SEC = 3600
/** Group stream marks are written at most this often while they move. */
const SAVE_MARKS_EVERY_MS = 30_000

interface StoredGroup {
  record: GroupRecord
  /** Per relay: up to when this group's messages are known to be held, unix seconds. */
  hwm: Record<string, number>
}

interface StoredKey {
  ref: string
  eventId: string
  slot: string
  publicPackage: string
  privatePackage: { init: string; hpke: string; signature: string }
  createdAt: number
  notAfter: number
  publishedAt: number
  replacedAt?: number
}

interface Held {
  convoId: string
  group: MarmotGroup
  route: string
  relays: string[]
  hwm: Record<string, number>
  queue: Promise<unknown>
  marksDirty: boolean
}

export class MlsUnavailableError extends Error {
  constructor(readonly missing: string[]) {
    super('none of these people can be added to a forward-secret group yet')
  }
}

const nowSec = (): number => Math.floor(Date.now() / 1000)
const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)]

/**
 * Forward-secret groups for one account: the lazy half of ADR-049.
 *
 * Owns every group's MLS state and every KeyPackage's private keys, listens
 * to each group's relays, and turns what arrives into what the engine
 * stores. Everything is serialised per group, because every operation — even
 * reading a message — moves that group's key schedule forward, and two at
 * once would each start from the same state and one would be lost. State is
 * written back after every step and before anything goes on the wire, so a
 * message key is never used twice across a restart.
 */
export class MlsRuntime {
  /** Messages in these groups: sending, and what arrives. */
  readonly chat: GroupChat
  readonly #host: MlsHost
  #groups = new Map<string, Held>()
  #byRoute = new Map<string, Held>()
  #sub: SubCloser | null = null
  #timers = new Set<ReturnType<typeof setTimeout>>()
  #stopped = false
  #lastMarksSave = 0
  #keysCheckedAt = 0
  #rotating = new Set<string>()

  constructor(host: MlsHost) {
    this.#host = host
    this.chat = new GroupChat(host, (convoId, event) => this.publish(convoId, event))
  }

  async start(): Promise<void> {
    for (const { id, value } of await this.#host.repo.listMlsGroups<StoredGroup>()) {
      try {
        this.#hold(id, MarmotGroup.load(value.record), value.hwm)
      } catch (err) {
        log.warn('a stored group could not be loaded', err)
      }
    }
    this.#subscribe()
    for (const held of this.#groups.values()) void this.#serial(held, () => this.#drainDeferred(held))
    void this.ensureKeyPackage().catch((err: unknown) => log.warn('KeyPackage upkeep failed', err))
  }

  stop(): void {
    this.#stopped = true
    this.#sub?.close()
    this.#sub = null
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
    for (const held of this.#groups.values()) if (held.marksDirty) void this.#save(held)
  }

  /** Called on the engine's heartbeat. */
  tick(): void {
    if (this.#stopped) return
    this.#advanceMarks()
    const now = nowSec()
    for (const held of this.#groups.values()) {
      held.group.expire()
      if (held.group.active && now - held.group.selfUpdatedAt > ROTATE_EVERY_SEC) void this.#autoRotate(held)
    }
    if (Date.now() - this.#lastMarksSave > SAVE_MARKS_EVERY_MS) {
      this.#lastMarksSave = Date.now()
      for (const held of this.#groups.values()) if (held.marksDirty) void this.#save(held)
    }
    if (Date.now() - this.#keysCheckedAt > 6 * 3600_000) {
      void this.ensureKeyPackage().catch((err: unknown) => log.warn('KeyPackage upkeep failed', err))
    }
  }

  // --- KeyPackages ------------------------------------------------------------

  /**
   * Keep one KeyPackage published while invitations are allowed, and none
   * when they are not — and delete private keys that forward secrecy says
   * should be gone.
   */
  async ensureKeyPackage(force = false): Promise<void> {
    this.#keysCheckedAt = Date.now()
    const secretKey = this.#host.secretKey()
    if (!secretKey) return
    const now = nowSec()
    const stored = await this.#host.repo.listMlsKeys<StoredKey>()
    for (const key of stored) {
      const stale = key.replacedAt !== undefined && now - key.replacedAt > REPLACED_KEY_GRACE_SEC
      if (stale || key.notAfter < now) await this.#host.repo.deleteMlsKey(key.ref)
    }
    const current = stored.find((key) => key.replacedAt === undefined && key.notAfter >= now)

    if (!this.#host.settings().mlsInvites) {
      if (current) await this.withdrawKeyPackages()
      return
    }
    if (current && current.publishedAt > 0 && current.notAfter - now > KEY_PACKAGE_REFRESH_SEC && !force)
      return
    if (current && current.publishedAt === 0 && !force) {
      // Made but never acknowledged by a relay: publish that one, not another.
      await this.#publishKey(current, secretKey)
      return
    }

    const bundle = await createKeyPackage(secretKey, this.#host.pubkey, now)
    const slot = current?.slot ?? bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
    const event = await keyPackageEvent(secretKey, bundle.publicPackage, slot, now)
    const key: StoredKey = {
      ref: await keyPackageRef(bundle.publicPackage),
      eventId: event.id,
      slot,
      publicPackage: bytesToB64(encodeKeyPackage(bundle.publicPackage)),
      privatePackage: {
        init: bytesToB64(bundle.privatePackage.initPrivateKey),
        hpke: bytesToB64(bundle.privatePackage.hpkePrivateKey),
        signature: bytesToB64(bundle.privatePackage.signaturePrivateKey),
      },
      createdAt: now,
      notAfter: Number(bundle.publicPackage.leafNode.lifetime.notAfter),
      publishedAt: 0,
    }
    // Stored before it is published: a Welcome can only be opened with keys
    // this device kept.
    await this.#host.repo.putMlsKey(key.ref, key)
    if (current) await this.#host.repo.putMlsKey(current.ref, { ...current, replacedAt: now })
    await this.#publishKey(key, secretKey, event)
  }

  async #publishKey(key: StoredKey, secretKey: Uint8Array, event?: NostrEvent): Promise<void> {
    const bundle = this.#bundleOf(key)
    const signed = event ?? (await keyPackageEvent(secretKey, bundle.publicPackage, key.slot, key.createdAt))
    const outcomes = await this.#host.pool.publish(signed, this.#host.pool.rankedWriteRelays())
    if (outcomes.some((outcome) => outcome.ok)) {
      await this.#host.repo.putMlsKey(key.ref, { ...key, eventId: signed.id, publishedAt: nowSec() })
    }
  }

  /**
   * Stop being invitable: ask relays to delete our KeyPackage (NIP-09) and
   * delete its private keys here. A relay that keeps it anyway serves a
   * package whose keys no longer exist, so an invitation to it cannot be
   * opened by anyone.
   */
  async withdrawKeyPackages(): Promise<void> {
    const secretKey = this.#host.secretKey()
    if (!secretKey) return
    for (const key of await this.#host.repo.listMlsKeys<StoredKey>()) {
      const deletion = finalizeEvent(
        {
          kind: 5,
          created_at: nowSec(),
          content: '',
          tags: [
            ['e', key.eventId],
            ['a', `${KIND_KEY_PACKAGE}:${this.#host.pubkey}:${key.slot}`],
            ['k', String(KIND_KEY_PACKAGE)],
          ],
        },
        secretKey,
      )
      await this.#host.pool.publish(deletion, this.#host.pool.rankedWriteRelays())
      await this.#host.repo.deleteMlsKey(key.ref)
    }
  }

  #bundleOf(key: StoredKey): KeyPackageBundle {
    const decoded = decodeKeyPackage(b64ToBytes(key.publicPackage), 0)
    if (!decoded) throw new Error('stored KeyPackage does not decode')
    return {
      publicPackage: decoded[0],
      privatePackage: {
        initPrivateKey: b64ToBytes(key.privatePackage.init),
        hpkePrivateKey: b64ToBytes(key.privatePackage.hpke),
        signaturePrivateKey: b64ToBytes(key.privatePackage.signature),
      },
    }
  }

  /** The best KeyPackage someone has published, checked end to end, or null. */
  async #keyPackageFor(pubkey: string, required: readonly number[]): Promise<KeyPackageCandidate | null> {
    const relays = unique([...(await this.#host.relaysOf(pubkey)), ...this.#host.pool.readRelays])
    const events = await this.#host.pool.query({ kinds: [KIND_KEY_PACKAGE], authors: [pubkey] }, relays, {
      maxWait: 6000,
      graceMs: 1500,
    })
    const valid: KeyPackageCandidate[] = []
    for (const event of events) {
      try {
        valid.push(await parseKeyPackageEvent(event, { required }))
      } catch (err) {
        log.debug(`ignoring a KeyPackage from ${pubkey.slice(0, 8)}: ${(err as Error).message}`)
      }
    }
    // Freshest first; between equals, the lower KeyPackageRef (Marmot's tie-break).
    valid.sort((a, b) => b.createdAt - a.createdAt || Number(a.ref > b.ref) - Number(a.ref < b.ref))
    return valid[0] ?? null
  }

  /** Who of these people could be put in a forward-secret group right now. */
  async readiness(pubkeys: readonly string[]): Promise<Readiness> {
    const found = await Promise.all(pubkeys.map((p) => this.#keyPackageFor(p, SUPPORTED_COMPONENTS)))
    return {
      ready: pubkeys.filter((_, i) => found[i] !== null),
      missing: pubkeys.filter((_, i) => found[i] === null),
    }
  }

  // --- groups -------------------------------------------------------------------

  /** Start a group with the people who can join one; returns who could not. */
  async createGroup(opts: {
    members: readonly string[]
    name: string
  }): Promise<{ convoId: string; missing: string[] }> {
    const secretKey = this.#requireKey()
    const others = unique(opts.members).filter((p) => p !== this.#host.pubkey)
    if (others.length === 0) throw new Error('a group needs someone else in it')
    if (others.length + 1 > MAX_MLS_MEMBERS)
      throw new Error(`a group can have at most ${MAX_MLS_MEMBERS} people`)
    const found = await Promise.all(others.map((p) => this.#keyPackageFor(p, SUPPORTED_COMPONENTS)))
    const available = found.filter((c): c is KeyPackageCandidate => c !== null)
    const missing = others.filter((_, i) => found[i] === null)
    if (available.length === 0) throw new MlsUnavailableError(missing)

    const route = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
    const relays = canonicalRelays(this.#host.pool.rankedWriteRelays(4))
    const group = await MarmotGroup.create(await createKeyPackage(secretKey, this.#host.pubkey), {
      routing: { nostrGroupId: route, relays },
      profile: opts.name ? { name: opts.name, description: '' } : null,
      admins: [this.#host.pubkey],
    })
    const convoId = this.#host.repo.mlsConversationId(route)
    const held = this.#hold(convoId, group, {})
    try {
      await this.#serial(held, () => this.#commit(held, { add: available }))
    } catch (err) {
      this.#release(held)
      throw err
    }
    await this.#refreshConversation(held, { accepted: true })
    this.#subscribe()
    return { convoId, missing }
  }

  async addMembers(
    convoId: string,
    pubkeys: readonly string[],
  ): Promise<{ added: string[]; missing: string[] }> {
    const held = this.#active(convoId)
    const view = held.group.view()
    const wanted = unique(pubkeys).filter((p) => !view.members.includes(p))
    if (view.members.length + wanted.length > MAX_MLS_MEMBERS) {
      throw new Error(`a group can have at most ${MAX_MLS_MEMBERS} people`)
    }
    const required = SUPPORTED_COMPONENTS.filter((id) => id !== 0x8001 || view.profile)
    const found = await Promise.all(wanted.map((p) => this.#keyPackageFor(p, required)))
    const available = found.filter((c): c is KeyPackageCandidate => c !== null)
    const missing = wanted.filter((_, i) => found[i] === null)
    if (available.length > 0) await this.#change(held, { add: available })
    return { added: available.map((c) => c.owner), missing }
  }

  async removeMember(convoId: string, pubkey: string): Promise<void> {
    const held = this.#active(convoId)
    const { admins } = held.group.view()
    // Off the admin list first, in a commit of its own (see MarmotGroup.commit).
    if (admins.includes(pubkey)) await this.#change(held, { admins: admins.filter((a) => a !== pubkey) })
    await this.#change(held, { remove: [pubkey] })
  }

  /** Refresh our own keys in the group now: a commit with a fresh update path. */
  async rotate(convoId: string): Promise<void> {
    await this.#change(this.#active(convoId), {})
  }

  /**
   * Leave. An admin hands the role on first — to the other admins, or if there
   * are none, to everyone remaining — since a request to leave from an admin
   * is one every member refuses. Our state is deleted either way: nothing
   * sent to the group from here on is readable by this device.
   */
  async leave(convoId: string): Promise<void> {
    const held = this.#groups.get(convoId)
    if (!held) return
    await this.#serial(held, async () => {
      if (!held.group.active) return
      // Requests to leave that are waiting go first, so who remains — and so
      // who the admin role passes to — is read after them, not before.
      if (held.group.hasPendingProposals) await this.#commit(held, {})
      if (held.group.view().admins.includes(this.#host.pubkey)) {
        const { admins, members } = held.group.view()
        const others = members.filter((m) => m !== this.#host.pubkey)
        const rest = admins.filter((a) => a !== this.#host.pubkey)
        if (others.length > 0) await this.#commit(held, { admins: rest.length > 0 ? rest : others })
      }
      const view = held.group.view()
      if (view.members.length > 1 && !view.admins.includes(this.#host.pubkey)) {
        const request = await held.group.proposeLeave(this.#host.pubkey)
        await this.#host.repo.markSeen([{ id: request.id, createdAt: request.created_at }], { sync: false })
        await this.#host.pool.dispatch(request, held.relays).quorum
      }
    })
    await this.#retire(held)
  }

  /** Encrypt and publish one app event to a group. Returns the relays' answers. */
  async publish(convoId: string, event: InnerEvent) {
    const held = this.#active(convoId)
    return this.#serial(held, async () => {
      const wrapped = await held.group.encrypt(event)
      // Written before it is sent: a message key used twice would be a nonce reused.
      await this.#save(held)
      await this.#host.repo.markSeen([{ id: wrapped.id, createdAt: wrapped.created_at }], { sync: false })
      return this.#host.pool.dispatch(wrapped, held.relays).quorum
    })
  }

  // --- joining -------------------------------------------------------------------

  /**
   * A Welcome arrived in the inbox. Join if it opens with one of our
   * KeyPackages and the group agrees its sender is an admin. Returns the
   * conversation, or null if it was not one we could or would accept.
   */
  async receiveWelcome(rumor: Rumor): Promise<string | null> {
    const inviter = rumor.pubkey
    if ((await this.#host.standing(inviter)) === 'blocked') return null
    let parsed
    try {
      parsed = parseWelcomeRumor(rumor)
    } catch (err) {
      log.info(`malformed Welcome: ${(err as Error).message}`)
      return null
    }
    const key = (await this.#host.repo.listMlsKeys<StoredKey>()).find(
      (k) => k.eventId === parsed.keyPackageEventId,
    )
    if (!key) {
      log.info('a Welcome names a KeyPackage this device does not hold')
      return null
    }
    let group: MarmotGroup
    try {
      group = await MarmotGroup.join(parsed.welcome, this.#bundleOf(key), {
        inviter,
        self: this.#host.pubkey,
        at: rumor.created_at,
      })
    } catch (err) {
      // The KeyPackage stays: the inviter can try again (Marmot key-packages.md).
      log.info(`could not join from a Welcome: ${(err as Error).message}`)
      return null
    }
    const view = group.view()
    const convoId = this.#host.repo.mlsConversationId(view.nostrGroupId)
    if (this.#groups.has(convoId)) return convoId

    const held = this.#hold(convoId, group, {})
    await this.#save(held)
    // Consumed: its private keys go now, and a fresh package takes its slot.
    await this.#host.repo.deleteMlsKey(key.ref)
    void this.ensureKeyPackage(true).catch((err: unknown) => log.warn('KeyPackage replacement failed', err))
    await this.#refreshConversation(held, {
      accepted: (await this.#host.standing(inviter)) === 'accepted',
      at: rumor.created_at * 1000,
    })
    this.#subscribe()
    await this.#backfill(held)
    this.#later(held, 60_000 + Math.random() * 540_000, () => {
      // Our leaf's keys came from a KeyPackage that sat on relays for weeks:
      // replace them soon after joining, unless someone's commit already has.
      // (Still held, so still a member: a group that removed us is released.)
      if (held.group.selfUpdatedAt <= held.group.joinedAt) void this.#autoRotate(held)
    })
    return convoId
  }

  /** What was said in the group between the Welcome and now. */
  async #backfill(held: Held): Promise<void> {
    const events = await this.#host.pool.query(
      { kinds: [KIND_GROUP_EVENT], '#h': [held.route], since: held.group.joinedAt - CLOCK_MARGIN_SEC },
      held.relays,
      { maxWait: 10_000, graceMs: 1500 },
    )
    events.sort((a, b) => a.created_at - b.created_at)
    for (const event of events) await this.#onEvent(event)
  }

  // --- the group stream ------------------------------------------------------------

  #subscribe(): void {
    if (this.#stopped) return
    const active = [...this.#groups.values()].filter((h) => h.group.active)
    const relays = unique(active.flatMap((h) => h.relays))
    this.#sub?.close()
    this.#sub = null
    if (relays.length === 0) return
    this.#sub = this.#host.pool.subscribe(
      (url) => this.#filterFor(url),
      {
        onEvent: (event) => void this.#onEvent(event),
        onEose: (url) => this.#onEose(url ?? ''),
        label: 'groups',
      },
      relays,
    )
  }

  #filterFor(url: string): Filter {
    const here = [...this.#groups.values()].filter((h) => h.group.active && h.relays.includes(url))
    const since = Math.min(...here.map((h) => Math.max(h.group.joinedAt, h.hwm[url] ?? 0) - CLOCK_MARGIN_SEC))
    return { kinds: [KIND_GROUP_EVENT], '#h': here.map((h) => h.route), since: Math.max(0, since) }
  }

  #onEose(url: string): void {
    const reqAt = this.#sub?.progress?.(url)?.reqAt
    if (reqAt) this.#mark(url, Math.floor(reqAt / 1000))
  }

  /** Relays that have finished sending on this connection prove everything up to their last frame. */
  #advanceMarks(): void {
    const sub = this.#sub
    if (!sub) return
    for (const url of unique([...this.#groups.values()].flatMap((h) => h.relays))) {
      const progress = sub.progress?.(url)
      if (!progress || progress.reqAt === 0 || progress.eoseAt < progress.reqAt) continue
      this.#mark(url, Math.floor(Math.max(progress.reqAt, progress.lastRxAt) / 1000))
    }
  }

  #mark(url: string, sec: number): void {
    for (const held of this.#groups.values()) {
      if (!held.relays.includes(url) || (held.hwm[url] ?? 0) >= sec) continue
      held.hwm[url] = sec
      held.marksDirty = true
    }
  }

  async #onEvent(event: NostrEvent): Promise<void> {
    let route: string
    try {
      route = groupEventRoute(event)
    } catch {
      return
    }
    const held = this.#byRoute.get(route)
    if (!held || (await this.#host.repo.hasSeen(event.id))) return
    await this.#serial(held, async () => {
      if (!held.group.active) return
      await this.#settle(held, event, await held.group.open(event))
    })
  }

  async #settle(held: Held, event: NostrEvent, outcome: OpenOutcome): Promise<void> {
    if (outcome.kind !== 'deferred') {
      await this.#host.repo.markSeen([{ id: event.id, createdAt: event.created_at }], { sync: false })
    }
    if (outcome.kind === 'ignored') {
      log.debug(`group event ignored: ${outcome.reason}`)
      return
    }
    await this.#save(held)
    switch (outcome.kind) {
      case 'application':
        await this.chat.ingest(await this.#conversation(held), outcome.event)
        return
      case 'proposal':
        // Someone asked to leave. Admins commit it, after a moment, so two
        // of them do not both race to.
        if (held.group.view().admins.includes(this.#host.pubkey)) {
          this.#later(held, 1000 + Math.random() * 4000, () => {
            if (held.group.hasPendingProposals) void this.#change(held, {}).catch(() => undefined)
          })
        }
        return
      case 'commit':
        await this.#refreshConversation(held)
        if (outcome.rolledBack.length > 0) await this.chat.resend(held.convoId, outcome.rolledBack)
        if (outcome.removedSelf) await this.#retire(held)
        else await this.#drainDeferred(held)
        return
      case 'deferred':
        return
    }
  }

  async #drainDeferred(held: Held): Promise<void> {
    const events = held.group.takeDeferred().sort((a, b) => a.created_at - b.created_at)
    for (const event of events) {
      if (!held.group.active) return
      await this.#settle(held, event, await held.group.open(event))
    }
  }

  // --- commits -------------------------------------------------------------------

  /** Make a change, in the group's queue. */
  async #change(held: Held, change: Change): Promise<void> {
    await this.#serial(held, () => this.#commit(held, change))
  }

  /**
   * Publish a commit, then apply it — Marmot's publish-before-apply. Must run
   * inside `#serial`: everything that touches a group runs in its queue, so
   * nothing can move the epoch between making the commit and applying it, and
   * it always applies here. A competing commit from someone else is settled
   * when it arrives, by `MarmotGroup.open`.
   */
  async #commit(held: Held, change: Change): Promise<void> {
    const secretKey = this.#requireKey()
    // Settings go in a commit of their own (see MarmotGroup.commit): requests
    // to leave that are waiting are committed first, rather than refused.
    if ((change.admins || change.profile) && held.group.hasPendingProposals) await this.#commit(held, {})
    const pending = await held.group.commit({ pubkey: this.#host.pubkey, secretKey }, change)
    await this.#host.repo.markSeen([{ id: pending.event.id, createdAt: pending.event.created_at }], {
      sync: false,
    })
    const outcomes = await this.#host.pool.dispatch(pending.event, held.relays).quorum
    if (!outcomes.some((outcome) => outcome.ok)) {
      held.group.abandon(pending)
      throw new Error('the group’s relays could not be reached')
    }
    await held.group.confirm(pending)
    await this.#save(held)
    await this.#refreshConversation(held)
    if (pending.welcome) {
      for (const invitee of pending.invited) {
        await this.#host.sendRumor(
          invitee.pubkey,
          welcomeRumor(secretKey, pending.welcome, invitee.keyPackageEventId, held.relays),
        )
      }
    }
    await this.#drainDeferred(held)
  }

  async #autoRotate(held: Held): Promise<void> {
    if (this.#rotating.has(held.convoId)) return
    this.#rotating.add(held.convoId)
    try {
      await this.#change(held, {})
    } catch (err) {
      log.info(`could not refresh keys in a group: ${(err as Error).message}`)
    } finally {
      this.#rotating.delete(held.convoId)
    }
  }

  // --- bookkeeping ---------------------------------------------------------------

  #hold(convoId: string, group: MarmotGroup, hwm: Record<string, number>): Held {
    const view = group.view()
    const held: Held = {
      convoId,
      group,
      route: view.nostrGroupId,
      relays: view.relays,
      hwm: { ...hwm },
      queue: Promise.resolve(),
      marksDirty: false,
    }
    this.#groups.set(convoId, held)
    this.#byRoute.set(held.route, held)
    return held
  }

  #release(held: Held): void {
    this.#groups.delete(held.convoId)
    this.#byRoute.delete(held.route)
  }

  /** No longer a member: keep the history, delete the keys, stop listening. */
  async #retire(held: Held): Promise<void> {
    this.#release(held)
    await this.#host.repo.deleteMlsGroup(held.convoId)
    const conversation = await this.#host.repo.getConversation(held.convoId)
    if (conversation?.mls) {
      await this.#host.repo.updateConversation(held.convoId, { mls: { ...conversation.mls, left: true } })
    }
    this.#host.emit('conversationsChanged', undefined)
    this.#subscribe()
  }

  #active(convoId: string): Held {
    const held = this.#groups.get(convoId)
    if (!held || !held.group.active) throw new Error('this device is not in that group')
    return held
  }

  /** Run `task` after everything already queued for this group. */
  #serial<T>(held: Held, task: () => Promise<T>): Promise<T> {
    const run = held.queue.then(task, task)
    held.queue = run.catch(() => undefined)
    return run
  }

  #later(held: Held, ms: number, task: () => void): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer)
      if (!this.#stopped && this.#groups.get(held.convoId) === held) task()
    }, ms)
    this.#timers.add(timer)
  }

  /**
   * Write a group's state back. Never after `#retire`: retiring is the last
   * step in a group's queue, and nothing that saves runs after it.
   */
  async #save(held: Held): Promise<void> {
    held.marksDirty = false
    const stored: StoredGroup = { record: held.group.toRecord(), hwm: { ...held.hwm } }
    await this.#host.repo.putMlsGroup(held.convoId, stored)
  }

  async #conversation(held: Held): Promise<Conversation> {
    return (await this.#host.repo.getConversation(held.convoId)) ?? this.#refreshConversation(held)
  }

  async #refreshConversation(
    held: Held,
    opts: { accepted?: boolean; at?: number } = {},
  ): Promise<Conversation> {
    const view = held.group.view()
    const conversation = await this.#host.repo.upsertMlsConversation(held.convoId, {
      members: view.members.filter((m) => m !== this.#host.pubkey),
      subject: view.profile?.name ?? '',
      mls: {
        group: view.nostrGroupId,
        admins: view.admins,
        epoch: view.epoch,
        code: held.group.epochAuthenticator,
        refreshedAt: view.selfUpdatedAt,
        ...(view.active ? {} : { left: true }),
      },
      ...opts,
    })
    this.#host.emit('conversationsChanged', undefined)
    return conversation
  }

  #requireKey(): Uint8Array {
    const secretKey = this.#host.secretKey()
    if (!secretKey) throw new Error('not running')
    return secretKey
  }
}
