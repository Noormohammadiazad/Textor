import { createRumor, type Rumor } from '../crypto/giftwrap'
import {
  groupChatTags,
  KIND_DELETION,
  KIND_GROUP_CHAT,
  KIND_REACTION,
  MAX_MESSAGE_CHARS,
  preciseTimestamp,
  threadFromTags,
} from '../models/protocol'
import type { Conversation, Message, OutboxItem } from '../models/types'
import type { PublishOutcome } from '../transport/relayPool'
import type { InnerEvent, MlsHost } from './host'

/** Outbox ids for reactions and deletions: queue traffic, not messages people count. */
const CONTROL_PREFIX = 'ctl-'
const HEX64 = /^[0-9a-f]{64}$/

/**
 * Messages in forward-secret groups: what a person sends, and what arrives.
 *
 * Text, replies, reactions and deleting your own — the part of a
 * conversation that is only ever a few hundred bytes. Everything leaves
 * through the engine's outbox and is encrypted to the group at the moment it
 * is sent, never before, so a message queued while offline goes out under
 * whatever epoch the group has reached by then.
 */
export class GroupChat {
  constructor(
    private readonly host: MlsHost,
    private readonly publish: (convoId: string, event: InnerEvent) => Promise<PublishOutcome[]>,
  ) {}

  async send(conversation: Conversation, content: string, replyTo?: string): Promise<Message> {
    this.#assertMember(conversation)
    const sentAt = Date.now()
    const rootId = replyTo ? await this.host.threadRoot(replyTo) : null
    const message: Message = {
      id: '',
      convoId: conversation.id,
      direction: 'out',
      status: 'queued',
      ts: sentAt,
      tsCoarse: 0,
      body: content,
      authorPubkey: this.host.pubkey,
      ...(replyTo ? { replyTo } : {}),
      ...(replyTo && rootId ? { rootId } : {}),
      via: 'relay',
    }
    const rumor = this.#chatRumor(message)
    message.id = rumor.id
    await this.host.repo.putMessage(message)
    await this.host.repo.bumpConversation(conversation.id, sentAt, false)
    this.host.emit('message', { message, conversation })
    this.host.emit('conversationsChanged', undefined)
    await this.#queue(conversation.id, rumor.id, rumor)
    return message
  }

  /** React, or take a reaction back: the same emoji again removes it. */
  async react(conversation: Conversation, message: Message, emoji: string): Promise<void> {
    if (message.convoId !== conversation.id) throw new Error('that message is not in this conversation')
    const existing = await this.host.repo.findReaction(message.id, this.host.pubkey)
    if (existing) {
      await this.host.repo.deleteReaction(existing.id)
      this.host.emit('reactionsChanged', { messageId: message.id })
      await this.#small(conversation, KIND_DELETION, '', [
        ['e', existing.id],
        ['k', String(KIND_REACTION)],
      ])
      if (existing.emoji === emoji) return
    }
    const rumor = await this.#small(conversation, KIND_REACTION, emoji, [
      ['e', message.id],
      ['k', String(KIND_GROUP_CHAT)],
    ])
    await this.host.repo.putReaction({
      id: rumor.id,
      messageId: message.id,
      convoId: conversation.id,
      authorPubkey: this.host.pubkey,
      emoji,
      ts: rumor.created_at * 1000,
    })
    this.host.emit('reactionsChanged', { messageId: message.id })
  }

  /** Delete one of our messages here, and ask the group to delete it too (NIP-09). */
  async withdraw(conversation: Conversation, message: Message): Promise<void> {
    if (message.convoId !== conversation.id || message.call) {
      throw new Error('that message is not in this conversation')
    }
    await this.host.forget(message)
    this.host.emit('conversationsChanged', undefined)
    await this.#small(conversation, KIND_DELETION, '', [
      ['e', message.id],
      ['k', String(KIND_GROUP_CHAT)],
    ])
  }

  /** Send a message of ours again, rebuilt exactly — same id — from what was stored. */
  async retry(conversation: Conversation, message: Message): Promise<void> {
    if (conversation.mls?.left || message.direction !== 'out') return
    const rumor = this.#chatRumor(message)
    if (rumor.id !== message.id) return
    const updated = await this.host.repo.updateMessage(message.id, { status: 'queued', error: undefined })
    if (updated) this.host.emit('messageUpdated', updated)
    await this.#queue(conversation.id, rumor.id, rumor)
  }

  /** Our messages from a branch that lost a commit race: nobody else can read them. */
  async resend(convoId: string, ids: readonly string[]): Promise<void> {
    const conversation = await this.host.repo.getConversation(convoId)
    if (!conversation?.mls) return
    for (const id of ids) {
      const message = await this.host.repo.getMessage(id)
      if (message?.convoId === convoId) await this.retry(conversation, message)
    }
  }

  /** Publish one queued event: encrypted under the group's epoch as of now. */
  async deliver(item: OutboxItem): Promise<void> {
    const event = JSON.parse(item.rumorJson) as InnerEvent
    const isChat = event.kind === KIND_GROUP_CHAT
    if (isChat) await this.host.repo.advanceMessageStatus(item.id, 'sending')
    let outcomes: PublishOutcome[]
    try {
      outcomes = await this.publish(item.convoId, event)
    } catch (err) {
      await this.host.failItem(item, (err as Error).message)
      return
    }
    const acked = outcomes.filter((outcome) => outcome.ok).length
    if (acked === 0) {
      const failure = outcomes.find((outcome) => !outcome.ok)
      await this.host.failItem(item, failure && !failure.ok ? failure.error : 'no relay accepted the message')
      return
    }
    await this.host.repo.dequeue(item.id)
    if (!isChat) return
    await this.host.repo.advanceMessageStatus(item.id, 'sent')
    const updated = await this.host.repo.updateMessage(item.id, { relayAcks: acked, error: undefined })
    if (updated) this.host.emit('messageUpdated', updated)
  }

  /**
   * An app event from the group. Already authenticated: MLS proved which
   * member sent it, and the runtime checked the author inside is that member.
   */
  async ingest(conversation: Conversation, event: InnerEvent): Promise<void> {
    const author = event.pubkey
    if ((await this.host.repo.getContact(author))?.blocked) return
    if (event.kind === KIND_GROUP_CHAT) return this.#ingestChat(conversation, event)
    if (event.kind === KIND_REACTION) return this.host.ingestReaction(conversation, event)
    if (event.kind === KIND_DELETION) return this.#ingestDeletion(conversation, event)
  }

  async #ingestChat(conversation: Conversation, event: InnerEvent): Promise<void> {
    if (event.content.length === 0 || event.content.length > MAX_MESSAGE_CHARS) return
    const { repo } = this.host
    if (await repo.hasMessage(event.id)) return
    if (await repo.isWithdrawn(event.id, event.pubkey)) return
    const thread = threadFromTags(event.tags)
    const incoming = event.pubkey !== this.host.pubkey
    const message: Message = {
      id: event.id,
      convoId: conversation.id,
      direction: incoming ? 'in' : 'out',
      status: incoming ? 'delivered' : 'sent',
      ts: preciseTimestamp(event.tags, event.created_at),
      tsCoarse: 0,
      body: event.content,
      authorPubkey: event.pubkey,
      ...(thread.replyTo ? { replyTo: thread.replyTo } : {}),
      ...(thread.root ? { rootId: thread.root } : {}),
      via: 'relay',
    }
    // Read on arrival if it is on screen, as in any conversation (ADR-039).
    const unread = incoming && !this.host.isViewing(conversation.id)
    await repo.putMessage(message)
    await repo.bumpConversation(conversation.id, message.ts, unread)
    this.host.emit('message', {
      message,
      conversation: {
        ...conversation,
        lastActivity: Math.max(conversation.lastActivity, message.ts),
        unread: conversation.unread + (unread ? 1 : 0),
      },
    })
    this.host.emit('conversationsChanged', undefined)
  }

  /** Honoured only for what the member wrote, in this group. */
  async #ingestDeletion(conversation: Conversation, event: InnerEvent): Promise<void> {
    const { repo } = this.host
    const author = event.pubkey
    const ids: string[] = []
    for (const tag of event.tags) {
      const id = tag[1]
      if (tag[0] !== 'e' || !id || !HEX64.test(id)) continue
      const reaction = await repo.getReaction(id)
      if (reaction) {
        if (reaction.authorPubkey !== author || reaction.convoId !== conversation.id) continue
        await repo.withdraw(id, author)
        await repo.deleteReaction(id)
        this.host.emit('reactionsChanged', { messageId: reaction.messageId })
        continue
      }
      const message = await repo.getMessage(id)
      if (!message) {
        // It overtook what it deletes: the tombstone keeps it out when it arrives.
        await repo.withdraw(id, author)
        continue
      }
      if (message.authorPubkey !== author || message.convoId !== conversation.id || message.call) continue
      await this.host.forget(message)
      await this.host.uncount(message)
      ids.push(id)
    }
    if (ids.length > 0) {
      this.host.emit('messagesRedacted', { peerPubkey: author, ids })
      this.host.emit('conversationsChanged', undefined)
    }
  }

  /** A chat message as it travels inside MLS, rebuilt identically from what was stored. */
  #chatRumor(message: Message): Rumor {
    return createRumor(
      {
        kind: KIND_GROUP_CHAT,
        content: message.body,
        tags: groupChatTags({
          ts: message.ts,
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          ...(message.rootId ? { rootId: message.rootId } : {}),
        }),
        created_at: Math.floor(message.ts / 1000),
      },
      this.#secretKey(),
    )
  }

  /** A reaction or a deletion: a few bytes, queued like a message. */
  async #small(conversation: Conversation, kind: number, content: string, tags: string[][]): Promise<Rumor> {
    this.#assertMember(conversation)
    const rumor = createRumor(
      { kind, content, tags, created_at: Math.floor(Date.now() / 1000) },
      this.#secretKey(),
    )
    await this.#queue(conversation.id, `${CONTROL_PREFIX}${rumor.id}`, rumor)
    return rumor
  }

  async #queue(convoId: string, id: string, rumor: Rumor): Promise<void> {
    await this.host.enqueue({
      id,
      convoId,
      peerPubkey: '',
      recipients: [],
      rumorJson: JSON.stringify(rumor),
      relays: [],
      attempts: 0,
      nextAttemptAt: Date.now(),
      createdAt: Date.now(),
      ephemeral: false,
      mls: true,
    })
  }

  #assertMember(conversation: Conversation): void {
    if (conversation.mls?.left) throw new Error('you are no longer in this group')
  }

  #secretKey(): Uint8Array {
    const key = this.host.secretKey()
    if (!key) throw new Error('messenger is not running')
    return key
  }
}
