import type { Event as NostrEvent } from 'nostr-tools/core'
import {
  createApplicationMessage,
  createCommit,
  createGroup,
  createProposal,
  decodeGroupState,
  decodeMlsMessage,
  defaultKeyPackageEqualityConfig,
  defaultLifetimeConfig,
  defaultPaddingConfig,
  emptyPskIndex,
  encodeGroupState,
  encodeMlsMessage,
  joinGroup,
  processMessage,
  zeroOutUint8Array,
  type ClientConfig,
  type ClientState,
  type IncomingMessageCallback,
  type KeyPackage,
  type MLSMessage,
  type NodeLeaf,
  type PrivateKeyPackage,
  type PrivateMessage,
  type Proposal,
  type ProposalWithSender,
  type SenderMember,
  type Welcome,
} from 'ts-mls'
import { unprotectPrivateMessage } from 'ts-mls/messageProtection.js'
import { b64ToBytes, bytesToB64, bytesToHex, hexToBytes } from '../util/bytes'
import {
  decodeAppEvent,
  encodeAppEvent,
  groupContextExtensions,
  groupEventKey,
  leafIdentity,
  MarmotError,
  memberIdentities,
  messageId,
  openGroupEvent,
  readGroupState,
  sealGroupEvent,
  type AppEvent,
  type GroupState,
  type KeyPackageCandidate,
  type Profile,
  type Routing,
} from './marmot'
import { SUITE } from './suite'

/**
 * One Marmot group, as this device holds it.
 *
 * ts-mls is the MLS; this is the part that makes it behave as a group on
 * Nostr relays, where messages arrive late, twice, out of order, and from two
 * members who committed at the same moment:
 *
 *  - Group state is Marmot's: routing, profile and admin policy in the
 *    GroupContext, an identity proof on every leaf. A commit whose result
 *    breaks any of it is refused, whoever signed it.
 *  - Only an admin may add or remove someone else, or change group state.
 *    Anyone may refresh their own keys, and anyone may commit a member's
 *    request to leave. The same rule runs on every device, so a commit one
 *    member would refuse is refused by all of them.
 *  - Our own commits are published before they are applied. When two commits
 *    race for the same epoch, every member keeps the same one — the lower of
 *    Marmot's ordering suffix (admin work before ordinary, then committer,
 *    then digest) — by keeping the state one commit back and rolling to the
 *    winner if it arrives second. Marmot's full convergence looks further
 *    back; one commit is where races actually happen (ADR-049).
 *  - Forward secrecy is the MLS key schedule's: each epoch's keys come from
 *    the last, message keys are deleted as they are used, and past-epoch
 *    material is kept only for `RETAINED_EPOCHS`, for messages that arrive
 *    late. Post-compromise security comes from commits with an update path —
 *    every member refreshes its own leaf, at least weekly (`MlsRuntime`).
 */

/** Past epochs whose keys are kept, for messages that arrive after a commit. */
export const RETAINED_EPOCHS = 2
/** How long the state one commit back is kept, to settle a late-arriving race. */
export const ROLLBACK_WINDOW_MS = 24 * 60 * 60 * 1000
/** Events held for an epoch not reached yet. */
const MAX_DEFERRED = 64
/** Our own recent messages, by epoch, so a lost race can resend them. */
const MAX_SENT = 64

export interface Identity {
  pubkey: string
  secretKey: Uint8Array
}

export interface KeyPackageBundle {
  publicPackage: KeyPackage
  privatePackage: PrivateKeyPackage
}

/** Marmot's same-epoch ordering suffix. Lower wins. */
export interface CommitKey {
  /** 0 for a commit only an admin may make, 1 for one anyone may. */
  priority: 0 | 1
  committer: string
  digest: string
}

export const compareCommitKeys = (a: CommitKey, b: CommitKey): number =>
  a.priority - b.priority || cmp(a.committer, b.committer) || cmp(a.digest, b.digest)
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** What a device keeps between sessions, sealed in the vault. */
export interface GroupRecord {
  v: 1
  state: string
  previous: { state: string; tip: CommitKey; at: number } | null
  outerKeys: [epoch: string, key: string][]
  joinedAt: number
  selfUpdatedAt: number
  deferred: string[]
  sent: [epoch: string, id: string][]
}

export interface GroupView {
  nostrGroupId: string
  epoch: number
  /** Everyone in the group, this account included, in tree order. */
  members: string[]
  admins: string[]
  profile: Profile | null
  relays: string[]
  active: boolean
  selfUpdatedAt: number
  joinedAt: number
}

export interface MembershipChange {
  added: string[]
  removed: string[]
  /** This account is no longer in the group. */
  removedSelf: boolean
  committer: string
}

export type OpenOutcome =
  | { kind: 'application'; event: AppEvent; epoch: number }
  | ({ kind: 'commit'; epoch: number; rolledBack: string[] } & MembershipChange)
  | { kind: 'proposal'; leaving: string }
  | { kind: 'deferred' }
  | { kind: 'ignored'; reason: string }

/** A commit made here, not yet applied: see `confirm`. */
export interface PendingCommit {
  event: NostrEvent
  welcome: Welcome | undefined
  /** KeyPackage event id per invitee, for their Welcomes. */
  invited: { pubkey: string; keyPackageEventId: string }[]
  key: CommitKey
  sourceEpoch: bigint
  next: ClientState
  /** Carries an update path, so applying it refreshes our own leaf's keys. */
  refreshes: boolean
}

export function clientConfig(): ClientConfig {
  return {
    keyRetentionConfig: {
      retainKeysForGenerations: 10,
      retainKeysForEpochs: RETAINED_EPOCHS,
      maximumForwardRatchetSteps: 200,
    },
    lifetimeConfig: defaultLifetimeConfig,
    keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
    paddingConfig: defaultPaddingConfig,
    authService: {
      async validateCredential(credential) {
        try {
          leafIdentity({ credential })
          return true
        } catch {
          return false
        }
      },
    },
  }
}

const encodeState = (state: ClientState): string => bytesToB64(encodeGroupState(state))

function decodeState(encoded: string): ClientState {
  const decoded = decodeGroupState(b64ToBytes(encoded), 0)
  if (!decoded) throw new MarmotError('stored group state does not decode')
  return { ...decoded[0], clientConfig: clientConfig() }
}

const nowSec = (): number => Math.floor(Date.now() / 1000)

/** Leaf index -> account, for every occupied leaf. */
function leaves(state: ClientState): Map<number, string> {
  const out = new Map<number, string>()
  state.ratchetTree.forEach((node, nodeIndex) => {
    if (node?.nodeType === 'leaf') out.set(nodeIndex / 2, leafIdentity(node.leaf))
  })
  return out
}

export class MarmotGroup {
  #state: ClientState
  #previous: { state: ClientState; tip: CommitKey; at: number } | null
  #outerKeys: Map<bigint, Uint8Array>
  #deferred: string[]
  #sent: [bigint, string][]
  #pending = new Map<string, PendingCommit>()
  joinedAt: number
  selfUpdatedAt: number

  private constructor(state: ClientState, record: Partial<GroupRecord> & { joinedAt: number }) {
    this.#state = state
    this.#previous = record.previous
      ? { state: decodeState(record.previous.state), tip: record.previous.tip, at: record.previous.at }
      : null
    this.#outerKeys = new Map(
      (record.outerKeys ?? []).map(([epoch, key]) => [BigInt(epoch), hexToBytes(key)]),
    )
    this.#deferred = [...(record.deferred ?? [])]
    this.#sent = (record.sent ?? []).map(([epoch, id]) => [BigInt(epoch), id])
    this.joinedAt = record.joinedAt
    this.selfUpdatedAt = record.selfUpdatedAt ?? record.joinedAt
  }

  /** A new group with just us in it, at epoch 0. Members are added by a commit. */
  static async create(
    bundle: KeyPackageBundle,
    opts: { routing: Routing; profile: Profile | null; admins: readonly string[] },
  ): Promise<MarmotGroup> {
    const state = await createGroup(
      crypto.getRandomValues(new Uint8Array(32)),
      bundle.publicPackage,
      bundle.privatePackage,
      groupContextExtensions(opts),
      SUITE,
      clientConfig(),
    )
    const group = new MarmotGroup(state, { joinedAt: nowSec() })
    group.#validate(state)
    return group
  }

  /**
   * Join from a Welcome, sent to us by `inviter`.
   *
   * The Welcome is authenticated as coming from `inviter` by the NIP-59 seal
   * it arrived in; the group it describes must agree that `inviter` is an
   * admin of it, since in a Marmot group only an admin may add anyone. A
   * Welcome from anyone else would put us in a group nobody else accepts.
   */
  static async join(
    welcome: Welcome,
    bundle: KeyPackageBundle,
    opts: { inviter: string; self: string; at: number },
  ): Promise<MarmotGroup> {
    const state = await joinGroup(
      welcome,
      bundle.publicPackage,
      bundle.privatePackage,
      emptyPskIndex,
      SUITE,
      undefined,
      undefined,
      clientConfig(),
    )
    const group = new MarmotGroup(state, { joinedAt: opts.at })
    const { admins, members } = group.#validate(state)
    if (!members.includes(opts.self)) throw new MarmotError('the Welcome does not add this account')
    if (!admins.includes(opts.inviter) || !members.includes(opts.inviter)) {
      throw new MarmotError('invited by someone who is not an admin of the group')
    }
    return group
  }

  static load(record: GroupRecord): MarmotGroup {
    return new MarmotGroup(decodeState(record.state), record)
  }

  toRecord(): GroupRecord {
    return {
      v: 1,
      state: encodeState(this.#state),
      previous: this.#previous
        ? { state: encodeState(this.#previous.state), tip: this.#previous.tip, at: this.#previous.at }
        : null,
      outerKeys: [...this.#outerKeys].map(([epoch, key]) => [epoch.toString(), bytesToHex(key)]),
      joinedAt: this.joinedAt,
      selfUpdatedAt: this.selfUpdatedAt,
      deferred: [...this.#deferred],
      sent: this.#sent.map(([epoch, id]) => [epoch.toString(), id]),
    }
  }

  get epoch(): bigint {
    return this.#state.groupContext.epoch
  }

  get active(): boolean {
    return this.#state.groupActiveState.kind === 'active'
  }

  /**
   * RFC 9420's epoch authenticator, hex: equal on every member that holds the
   * same epoch of the same group, and on nobody else. Two members comparing it
   * out of band learn that nobody has been slipped into their view.
   */
  get epochAuthenticator(): string {
    return bytesToHex(this.#state.keySchedule.epochAuthenticator)
  }

  view(): GroupView {
    const state = readGroupState(this.#state.groupContext.extensions)
    return {
      nostrGroupId: state.routing.nostrGroupId,
      epoch: Number(this.epoch),
      members: [...leaves(this.#state).values()],
      admins: state.admins,
      profile: state.profile,
      relays: state.routing.relays,
      active: this.active,
      selfUpdatedAt: this.selfUpdatedAt,
      joinedAt: this.joinedAt,
    }
  }

  /** The events held for an epoch not reached yet; the caller replays them after each change. */
  takeDeferred(): NostrEvent[] {
    const events = this.#deferred.map((json) => JSON.parse(json) as NostrEvent)
    this.#deferred = []
    return events
  }

  // --- sending ---------------------------------------------------------------

  /** Encrypt an app event for the group, as a kind 445 event ready to publish. */
  async encrypt(event: AppEvent): Promise<NostrEvent> {
    const result = await createApplicationMessage(this.#state, encodeAppEvent(event), SUITE)
    this.#state = result.newState
    result.consumed.forEach(zeroOutUint8Array)
    this.#sent.push([this.epoch, event.id])
    if (this.#sent.length > MAX_SENT) this.#sent.splice(0, this.#sent.length - MAX_SENT)
    const bytes = encodeMlsMessage({
      privateMessage: result.privateMessage,
      wireformat: 'mls_private_message',
      version: 'mls10',
    })
    return sealGroupEvent(await groupEventKey(this.#state), this.view().nostrGroupId, bytes)
  }

  /**
   * Prepare a commit. Nothing changes here until `confirm`: Marmot publishes
   * before it applies, so a commit that never reaches a relay never happened.
   */
  async commit(
    identity: Identity,
    change: {
      add?: readonly KeyPackageCandidate[]
      remove?: readonly string[]
      admins?: readonly string[]
      profile?: Profile
    } = {},
  ): Promise<PendingCommit> {
    const current = readGroupState(this.#state.groupContext.extensions)
    const settings = change.admins !== undefined || change.profile !== undefined
    // ts-mls 1.6.4 encrypts a commit's update path under the GroupContext as
    // it was before a GroupContextExtensions proposal, and decrypts it under
    // the one after, so a commit carrying both never opens for anyone else.
    // Settings therefore change in a commit of their own, which needs no
    // path — and taking someone off the admin list comes before removing
    // them, since an admin who is not a member is invalid state.
    if (settings && (change.add?.length || change.remove?.length || this.hasPendingProposals)) {
      throw new MarmotError('group settings change in a commit of their own')
    }
    if (change.remove?.some((account) => current.admins.includes(account))) {
      throw new MarmotError('take them off the admin list before removing them')
    }
    const proposals: Proposal[] = []
    for (const candidate of change.add ?? []) {
      proposals.push({ proposalType: 'add', add: { keyPackage: candidate.keyPackage } })
    }
    const byAccount = leaves(this.#state)
    for (const account of change.remove ?? []) {
      if (account === identity.pubkey) throw new MarmotError('a member cannot remove itself by commit')
      for (const [leaf, owner] of byAccount) {
        if (owner === account) proposals.push({ proposalType: 'remove', remove: { removed: leaf } })
      }
    }
    if (settings) {
      proposals.push({
        proposalType: 'group_context_extensions',
        groupContextExtensions: {
          extensions: groupContextExtensions({
            routing: current.routing,
            admins: change.admins ?? current.admins,
            profile: change.profile ?? current.profile,
          }),
        },
      })
    }
    const privileged = proposals.length > 0
    if (privileged && !current.admins.includes(identity.pubkey)) {
      throw new MarmotError('only an admin can change who is in the group')
    }

    const result = await createCommit(
      { state: this.#state, cipherSuite: SUITE },
      { extraProposals: proposals, wireAsPublicMessage: true, ratchetTreeExtension: true },
    )
    // Not wiped, unlike a message key: what a commit "consumes" is the current
    // epoch's secrets, which this state still needs until the commit is
    // published — and the rollback anchor needs after. They go when the state
    // holding them is replaced.
    this.#validate(result.newState)
    const bytes = encodeMlsMessage(result.commit)
    const ownLeaf = (state: ClientState) => state.ratchetTree[state.privatePath.leafIndex * 2]
    const before = ownLeaf(this.#state)
    const after = ownLeaf(result.newState)
    const refreshes =
      before?.nodeType === 'leaf' &&
      after?.nodeType === 'leaf' &&
      bytesToHex(before.leaf.hpkePublicKey) !== bytesToHex(after.leaf.hpkePublicKey)
    const pending: PendingCommit = {
      event: sealGroupEvent(await groupEventKey(this.#state), current.routing.nostrGroupId, bytes),
      welcome: result.welcome,
      invited: (change.add ?? []).map((c) => ({ pubkey: c.owner, keyPackageEventId: c.eventId })),
      key: { priority: privileged ? 0 : 1, committer: identity.pubkey, digest: messageId(bytes) },
      sourceEpoch: this.epoch,
      next: result.newState,
      refreshes,
    }
    this.#pending.set(pending.key.digest, pending)
    return pending
  }

  /**
   * Apply a commit of ours once it has reached the relays.
   *
   * Returns false if it lost: another commit for the same epoch was applied
   * meanwhile and sorts first. The caller decides whether to try again.
   */
  async confirm(pending: PendingCommit): Promise<boolean> {
    this.#pending.delete(pending.key.digest)
    if (pending.sourceEpoch === this.epoch) {
      await this.#advance(pending.next, pending.key)
      this.#noteSelfUpdate(pending)
      return true
    }
    const previous = this.#previous
    if (
      previous &&
      previous.state.groupContext.epoch === pending.sourceEpoch &&
      compareCommitKeys(pending.key, previous.tip) < 0
    ) {
      await this.#rollTo(pending.next, pending.key)
      this.#noteSelfUpdate(pending)
      return true
    }
    return false
  }

  /** Forget a commit that was never published. */
  abandon(pending: PendingCommit): void {
    this.#pending.delete(pending.key.digest)
  }

  /**
   * Ask to leave: a Remove proposal for our own leaf, which another member
   * commits. Not for an admin, whose request every member would refuse: the
   * role is handed on first (see `MlsRuntime.leave`).
   */
  async proposeLeave(self: string): Promise<NostrEvent> {
    if (readGroupState(this.#state.groupContext.extensions).admins.includes(self)) {
      throw new MarmotError('hand the admin role on before leaving')
    }
    const leaf = this.#state.privatePath.leafIndex
    const result = await createProposal(
      this.#state,
      true,
      { proposalType: 'remove', remove: { removed: leaf } },
      SUITE,
    )
    // Kept, so the commit that includes it by reference can be processed here too.
    this.#state = result.newState
    return sealGroupEvent(
      await groupEventKey(this.#state),
      this.view().nostrGroupId,
      encodeMlsMessage(result.message),
    )
  }

  /** Whether this account holds a request to leave that it may commit. */
  get hasPendingProposals(): boolean {
    return Object.keys(this.#state.unappliedProposals).length > 0
  }

  // --- receiving ---------------------------------------------------------------

  /** Open one kind 445 event addressed to this group. */
  async open(event: NostrEvent): Promise<OpenOutcome> {
    const keys = [await groupEventKey(this.#state), ...this.#outerKeys.values()]
    let bytes: Uint8Array | null
    try {
      bytes = openGroupEvent(event.content, keys)
    } catch (err) {
      return { kind: 'ignored', reason: (err as Error).message }
    }
    // No key this device holds opens it: most likely an epoch it has not reached yet.
    if (!bytes) return this.#defer(event)

    const message = decodeMlsMessage(bytes, 0)?.[0]
    if (message?.wireformat === 'mls_private_message') return this.#openApplication(message.privateMessage)
    if (message?.wireformat !== 'mls_public_message')
      return { kind: 'ignored', reason: 'unexpected wire format' }

    const content = message.publicMessage.content
    if (content.contentType === 'proposal') return this.#openProposal(message)
    if (content.contentType !== 'commit') return { kind: 'ignored', reason: 'application data in the clear' }
    // The outer key already placed it in an epoch this device holds.
    const epoch = content.epoch
    const digest = messageId(bytes)
    if (this.#pending.has(digest) || this.#previous?.tip.digest === digest) {
      return { kind: 'ignored', reason: 'own or already applied' }
    }
    if (epoch === this.epoch) return this.#openCommit(message, digest, false)
    if (this.#previous && epoch === this.#previous.state.groupContext.epoch) {
      return this.#openCommit(message, digest, true)
    }
    return { kind: 'ignored', reason: 'stale commit' }
  }

  #defer(event: NostrEvent): OpenOutcome {
    const json = JSON.stringify(event)
    if (!this.#deferred.includes(json)) {
      this.#deferred.push(json)
      if (this.#deferred.length > MAX_DEFERRED) this.#deferred.shift()
    }
    return { kind: 'deferred' }
  }

  async #openApplication(pm: PrivateMessage): Promise<OpenOutcome> {
    const historical = pm.epoch === this.epoch ? undefined : this.#state.historicalReceiverData.get(pm.epoch)
    if (pm.epoch !== this.epoch && !historical) return { kind: 'ignored', reason: 'epoch no longer held' }
    const source = historical ?? this.#state
    let result
    try {
      result = await unprotectPrivateMessage(
        historical?.senderDataSecret ?? this.#state.keySchedule.senderDataSecret,
        pm,
        source.secretTree,
        source.ratchetTree,
        source.groupContext,
        this.#state.clientConfig.keyRetentionConfig,
        SUITE,
      )
    } catch {
      // Our own message coming back, a replay, or noise.
      return { kind: 'ignored', reason: 'does not decrypt' }
    }
    result.consumed.forEach(zeroOutUint8Array)
    if (historical) {
      const data = new Map(this.#state.historicalReceiverData)
      data.set(pm.epoch, { ...historical, secretTree: result.tree })
      this.#state = { ...this.#state, historicalReceiverData: data }
    } else {
      this.#state = { ...this.#state, secretTree: result.tree }
    }
    const { content } = result.content
    // A handshake belongs in a PublicMessage in Marmot; one sent privately is refused.
    if (content.contentType !== 'application')
      return { kind: 'ignored', reason: 'not an application message' }
    // Unprotecting checked the sender against this tree: the leaf is there.
    const sender = (source.ratchetTree[(content.sender as SenderMember).leafIndex * 2] as NodeLeaf).leaf
    let app: AppEvent
    try {
      app = decodeAppEvent(content.applicationData)
    } catch (err) {
      return { kind: 'ignored', reason: (err as Error).message }
    }
    // Receiver authentication: the author named inside must be the member MLS says sent it.
    if (app.pubkey !== leafIdentity(sender)) return { kind: 'ignored', reason: 'author mismatch' }
    return { kind: 'application', event: app, epoch: Number(pm.epoch) }
  }

  async #openProposal(
    message: Extract<MLSMessage, { wireformat: 'mls_public_message' }>,
  ): Promise<OpenOutcome> {
    if (message.publicMessage.content.epoch !== this.epoch)
      return { kind: 'ignored', reason: 'proposal for another epoch' }
    const before = readGroupState(this.#state.groupContext.extensions)
    const byLeaf = leaves(this.#state)
    let leaving: string | null = null
    const policy: IncomingMessageCallback = (incoming) => {
      // Called for exactly this proposal.
      const { proposal, senderLeafIndex } = (incoming as Extract<typeof incoming, { kind: 'proposal' }>)
        .proposal
      // A member asking to leave — the only standalone proposal this client
      // accepts. An admin hands the role on before leaving (see `leave`).
      if (proposal.proposalType !== 'remove' || proposal.remove.removed !== senderLeafIndex) return 'reject'
      const sender = byLeaf.get(senderLeafIndex)
      if (!sender || before.admins.includes(sender)) return 'reject'
      leaving = sender
      return 'accept'
    }
    try {
      const result = await processMessage(message, this.#state, emptyPskIndex, policy, SUITE)
      if (result.kind !== 'newState' || result.actionTaken !== 'accept' || !leaving) {
        return { kind: 'ignored', reason: 'proposal not allowed' }
      }
      this.#state = result.newState
      return { kind: 'proposal', leaving }
    } catch (err) {
      return { kind: 'ignored', reason: (err as Error).message }
    }
  }

  async #openCommit(
    message: Extract<MLSMessage, { wireformat: 'mls_public_message' }>,
    digest: string,
    competing: boolean,
  ): Promise<OpenOutcome> {
    const parent = competing ? (this.#previous as { state: ClientState }).state : this.#state
    const before = readGroupState(parent.groupContext.extensions)
    const byLeaf = leaves(parent)
    let key: CommitKey | null = null
    const policy: IncomingMessageCallback = (incoming) => {
      const commit = incoming as Extract<typeof incoming, { kind: 'commit' }>
      // An external commit — someone joining on their own — is not how anyone joins a Marmot group.
      if (commit.senderLeafIndex === undefined) return 'reject'
      const committer = byLeaf.get(commit.senderLeafIndex) as string
      const privileged = commit.proposals.some((p) => isPrivileged(p))
      if (privileged && !before.admins.includes(committer)) return 'reject'
      if (commit.proposals.some((p) => !isPermitted(p))) return 'reject'
      key = { priority: privileged ? 0 : 1, committer, digest }
      return 'accept'
    }
    let next: ClientState
    try {
      const result = await processMessage(message, parent, emptyPskIndex, policy, SUITE)
      if (result.kind !== 'newState' || result.actionTaken !== 'accept' || !key) {
        return { kind: 'ignored', reason: 'commit not allowed' }
      }
      // The parent's secrets stay intact: it is the rollback anchor now.
      next = result.newState
    } catch (err) {
      return { kind: 'ignored', reason: (err as Error).message }
    }
    const accepted = key as CommitKey
    if (next.groupActiveState.kind !== 'removedFromGroup') {
      try {
        this.#validate(next)
      } catch (err) {
        return { kind: 'ignored', reason: `invalid result: ${(err as Error).message}` }
      }
    }

    const oldMembers = [...leaves(this.#state).values()]
    if (competing) {
      if (compareCommitKeys(accepted, (this.#previous as { tip: CommitKey }).tip) >= 0) {
        return { kind: 'ignored', reason: 'lost the race for this epoch' }
      }
      const lostEpoch = this.epoch
      await this.#rollTo(next, accepted)
      const rolledBack = this.#sent.filter(([epoch]) => epoch >= lostEpoch).map(([, id]) => id)
      return {
        kind: 'commit',
        epoch: Number(this.epoch),
        rolledBack,
        ...this.#diff(oldMembers, accepted.committer),
      }
    }
    await this.#advance(next, accepted)
    return {
      kind: 'commit',
      epoch: Number(this.epoch),
      rolledBack: [],
      ...this.#diff(oldMembers, accepted.committer),
    }
  }

  #diff(oldMembers: string[], committer: string): MembershipChange {
    const now = this.active ? [...leaves(this.#state).values()] : []
    return {
      added: now.filter((m) => !oldMembers.includes(m)),
      removed: oldMembers.filter((m) => !now.includes(m)),
      removedSelf: !this.active,
      committer,
    }
  }

  // --- state transitions ---------------------------------------------------------

  async #advance(next: ClientState, key: CommitKey): Promise<void> {
    await this.#retainOuterKey(this.#state)
    this.#previous = { state: this.#state, tip: key, at: Date.now() }
    this.#state = next
    this.#prune()
  }

  /** Replace the tip with a competing commit on the same parent. */
  async #rollTo(next: ClientState, key: CommitKey): Promise<void> {
    const previous = this.#previous as { state: ClientState; tip: CommitKey; at: number }
    this.#outerKeys.delete(this.epoch)
    this.#previous = { ...previous, tip: key }
    this.#state = next
    this.#prune()
  }

  /** The state being replaced was always a live one: this device was in it. */
  async #retainOuterKey(state: ClientState): Promise<void> {
    this.#outerKeys.set(state.groupContext.epoch, await groupEventKey(state))
  }

  /** Forget what forward secrecy says should be gone. */
  #prune(): void {
    for (const epoch of [...this.#outerKeys.keys()]) {
      if (this.epoch - epoch > BigInt(RETAINED_EPOCHS)) {
        this.#outerKeys.get(epoch)?.fill(0)
        this.#outerKeys.delete(epoch)
      }
    }
    if (this.#previous && Date.now() - this.#previous.at > ROLLBACK_WINDOW_MS) this.#previous = null
    this.#sent = this.#sent.filter(([epoch]) => this.epoch - epoch <= BigInt(RETAINED_EPOCHS))
  }

  /** Called by the caller's clock, so the rollback anchor does not outlive its window. */
  expire(): void {
    this.#prune()
  }

  #noteSelfUpdate(pending: PendingCommit): void {
    if (pending.refreshes) this.selfUpdatedAt = nowSec()
  }

  /** The Marmot invariants of a group state: throws if any is broken. */
  #validate(state: ClientState): GroupState & { members: string[] } {
    const group = readGroupState(state.groupContext.extensions)
    const members = memberIdentities(state, group.required)
    for (const admin of group.admins) {
      if (!members.includes(admin)) throw new MarmotError('an admin is not a member')
    }
    return { ...group, members }
  }
}

/** Needs an admin to commit: anything but a member refreshing or removing itself. */
function isPrivileged({ proposal, senderLeafIndex }: ProposalWithSender): boolean {
  if (proposal.proposalType === 'remove') return proposal.remove.removed !== senderLeafIndex
  return proposal.proposalType !== 'update'
}

/** Kinds of proposal a Marmot group on this client ever carries. */
function isPermitted({ proposal }: ProposalWithSender): boolean {
  const type = proposal.proposalType
  return type === 'add' || type === 'remove' || type === 'update' || type === 'group_context_extensions'
}
