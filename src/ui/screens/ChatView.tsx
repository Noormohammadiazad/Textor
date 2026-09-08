import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../../app/store'
import { useI18n } from '../../i18n'
import { goBack, useNavigate } from '../../app/router'
import { Avatar, Banner, EmptyState, GroupAvatar } from '../components/primitives'
import {
  ArrowDownIcon,
  BackIcon,
  BoltIcon,
  CloseIcon,
  ForwardIcon,
  LockIcon,
  PhoneIcon,
  SendIcon,
  ShieldCheckIcon,
  ShieldIcon,
  TrashIcon,
  VideoIcon,
} from '../components/Icons'
import { AttachButton, EmojiButton, VoiceButton } from '../components/Composer'
import { MessageBubble } from '../components/MessageBubble'
import { CallBubble, isCallEntry } from '../components/CallBubble'
import { ask, confirmDanger, type Choice } from '../components/dialog'
import { ForwardSheet, LiveBanner, MessageInfo } from '../lazyViews'
import { supportsWebRtc } from '../../core/transport/webrtc/directManager'
import { formatDayLabel, isSameDay } from '../format'
import { conversationTitle, displayName } from './ChatList'
import { isGroupAddress, type ChatAddress, type Conversation, type Message } from '../../core/models/types'

/** The stored conversation at an address: a group by its id, a person by their key. */
function findConversation(
  conversations: readonly Conversation[],
  address: ChatAddress,
): Conversation | undefined {
  return isGroupAddress(address)
    ? conversations.find((c) => c.id === address)
    : conversations.find((c) => c.kind === 'direct' && c.peerPubkey === address)
}

/** Read a saved draft synchronously, so the composer is populated on first paint. */
function readStoredDraft(address: ChatAddress): string {
  return findConversation(useApp.getState().conversations, address)?.draft ?? ''
}

/** Messages closer together than this from the same sender render as one run. */
const GROUP_WINDOW_MS = 4 * 60 * 1000

/**
 * Whether `message` starts a new run: after a call, a change of side or of
 * author, a pause, or midnight. The last of a run is the one with the tail.
 * The times compared are what each author's clock said, which need not rise
 * down the conversation when clocks disagree (ADR-063), so a pause is the gap
 * either way.
 */
function startsRun(previous: Message | undefined, message: Message): boolean {
  return (
    !previous ||
    // A call between two messages splits them into two runs: whoever speaks
    // after it is announced again.
    !!previous.call ||
    !!message.call ||
    previous.direction !== message.direction ||
    // In a group, two people in a row are two runs, each with its name.
    previous.authorPubkey !== message.authorPubkey ||
    Math.abs(message.ts - previous.ts) > GROUP_WINDOW_MS ||
    !isSameDay(previous.ts, message.ts)
  )
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * One conversation, direct or group — the same screen, because it is the same
 * thing: messages to a set of people. What differs is small and all here: a
 * group names who wrote each run, has no direct channel or typing indicator,
 * and opens its member list from the header instead of a contact page.
 */
export function ChatView({ address }: { address: ChatAddress }) {
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  const isGroup = isGroupAddress(address)
  const peer = isGroup ? '' : address

  const messages = useApp((s) => s.messages)
  const contacts = useApp((s) => s.contacts)
  const typingPeers = useApp((s) => s.typingPeers)
  const directStates = useApp((s) => s.directStates)
  const openConversation = useApp((s) => s.openConversation)
  const closeConversation = useApp((s) => s.closeConversation)
  const sendMessage = useApp((s) => s.sendMessage)
  const retryMessage = useApp((s) => s.retryMessage)
  const deleteMessages = useApp((s) => s.deleteMessages)
  const forwardMessages = useApp((s) => s.forwardMessages)
  const reactions = useApp((s) => s.reactions)
  const react = useApp((s) => s.react)
  const updates = useApp((s) => s.updates)
  const vote = useApp((s) => s.vote)
  const checkItem = useApp((s) => s.checkItem)
  const addChecklistItem = useApp((s) => s.addChecklistItem)
  const conversations = useApp((s) => s.conversations)
  const acceptGroup = useApp((s) => s.acceptGroup)
  const deleteConversation = useApp((s) => s.deleteConversation)
  const selfPubkey = useApp((s) => s.identity?.pubkey ?? '')
  const hasEarlierMessages = useApp((s) => s.hasEarlierMessages)
  const loadEarlierMessages = useApp((s) => s.loadEarlierMessages)
  const setTyping = useApp((s) => s.setTyping)
  const updateContact = useApp((s) => s.updateContact)
  const saveDraft = useApp((s) => s.saveDraft)
  const settings = useApp((s) => s.settings)
  const startCall = useApp((s) => s.startCall)
  const sharingHere = useApp((s) => s.liveShares.some((share) => share.address === address))

  // Seeded once at mount. The route gives this component a `key` of the peer's
  // key, so switching conversations remounts and re-seeds — no effect needed,
  // and no render cascade from mirroring store state into component state.
  const [draft, setDraft] = useState(() => readStoredDraft(address))
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  // What is picked while selecting, as Telegram selects: held, or chosen from
  // a message's menu. Null when not selecting.
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null)
  const [forwarding, setForwarding] = useState<readonly string[] | null>(null)
  const [infoFor, setInfoFor] = useState<string | null>(null)
  // Scrolled a screen or more above the newest message: offer the way back.
  const [away, setAway] = useState(false)
  const earlierBusy = useRef(false)
  const earlierRef = useRef<HTMLButtonElement>(null)
  // The latest draft, readable from the unmount cleanup without making the
  // effect depend on every keystroke.
  const draftRef = useRef(draft)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const stickToBottom = useRef(true)

  const conversationsLoaded = useApp((s) => s.conversationsLoaded)
  const conversation = findConversation(conversations, address)
  // A forward-secret group carries text only, and nothing once you have left it.
  const secure = conversation?.mls
  const contact = isGroup ? undefined : contacts.get(peer)
  const name = isGroup
    ? conversation
      ? conversationTitle(conversation, contacts, locale)
      : ''
    : displayName(contact, peer)
  const direct = !isGroup && directStates.get(peer) === 'connected'
  // Calls are one to one, and only with someone taken into the address book:
  // a call from a stranger never rings (see `Messenger.#routeCall`), so
  // calling one would be asking for what this side refuses to give.
  const callable = !isGroup && contact?.accepted === true && !contact.blocked && supportsWebRtc()
  const typing = !isGroup && typingPeers.has(peer)
  // Who wrote what, for the memoised row builder below. Rebuilt only when the
  // address book changes, not on every render.
  const nameOf = useCallback(
    (pubkey: string) => (pubkey === selfPubkey ? t('groups.you') : displayName(contacts.get(pubkey), pubkey)),
    [contacts, selfPubkey, t],
  )

  useEffect(() => {
    void openConversation(address)
    return () => {
      // Persist whatever was typed but not sent, so switching conversations
      // (or locking) does not throw it away.
      void saveDraft(address, draftRef.current)
      closeConversation()
    }
  }, [address, openConversation, closeConversation, saveDraft])

  // Keep the newest message in view, but do not yank the scroll position out
  // from under someone who has deliberately scrolled back through history.
  useLayoutEffect(() => {
    const node = listRef.current
    if (node && stickToBottom.current) node.scrollTop = node.scrollHeight
  }, [messages, typing])

  // The list also shrinks under a reply preview, a composer growing a line, or
  // an on-screen keyboard. Whoever was reading the newest message still is.
  const missing = isGroup && conversationsLoaded && !conversation
  useEffect(() => {
    const node = listRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) node.scrollTop = node.scrollHeight
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [missing])

  const onScroll = useCallback(() => {
    const node = listRef.current
    if (!node) return
    const fromBottom = node.scrollHeight - node.scrollTop - node.clientHeight
    stickToBottom.current = fromBottom < 80
    setAway(fromBottom > node.clientHeight)
  }, [])

  // Earlier history loads as the reader nears the top, as it does in every
  // messenger, rather than behind a button — which stays, for a keyboard and
  // for a browser without IntersectionObserver.
  const loadEarlier = useCallback(async () => {
    const node = listRef.current
    if (!node || earlierBusy.current) return
    earlierBusy.current = true
    setLoadingEarlier(true)
    // Hold the reader's place: history growing above them must not move what
    // they are reading.
    const fromBottom = node.scrollHeight - node.scrollTop
    stickToBottom.current = false
    await loadEarlierMessages()
    setLoadingEarlier(false)
    requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight - fromBottom
      earlierBusy.current = false
    })
  }, [loadEarlierMessages])

  useEffect(() => {
    const target = earlierRef.current
    const root = listRef.current
    if (!target || !root || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadEarlier()
      },
      { root, rootMargin: '400px 0px 0px 0px' },
    )
    observer.observe(target)
    return () => observer.disconnect()
    // Watched afresh as the page grows, so a page too short to scroll keeps
    // loading until it can.
  }, [hasEarlierMessages, loadEarlier, messages.length])

  const toggle = useCallback((message: Message) => {
    setSelected((current) => {
      const next = new Set(current)
      if (!next.delete(message.id)) next.add(message.id)
      return next.size > 0 ? next : null
    })
  }, [])
  const picked = useMemo(
    () => (selected ? messages.filter((message) => selected.has(message.id)) : []),
    [messages, selected],
  )
  const selecting = picked.length > 0

  useEffect(() => {
    if (!selecting) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(null)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [selecting])

  /**
   * Delete, asking how, as Telegram asks: between two people, for both of
   * them or for me alone — either may take anything out of their conversation
   * (ADR-061). In a group, for everyone only what we wrote.
   */
  const remove = useCallback(
    async (list: readonly Message[]) => {
      const everyone: Choice<'everyone'> | null = !isGroup
        ? { value: 'everyone', label: t('chat.deleteForBoth', { name }), danger: true }
        : !secure?.left && list.every((m) => m.authorPubkey === selfPubkey && !m.call)
          ? { value: 'everyone', label: t('chat.deleteForAll'), danger: true }
          : null
      const choice = await ask<'everyone' | 'me'>(
        list.length === 1 ? t('chat.deleteOne') : t('chat.deleteMany', { n: list.length }),
        [...(everyone ? [everyone] : []), { value: 'me', label: t('chat.deleteForMe'), danger: true }],
        everyone ? t('chat.deleteBody') : undefined,
      )
      if (!choice) return
      setSelected(null)
      await deleteMessages(
        list.map((m) => m.id),
        choice,
      )
    },
    [deleteMessages, isGroup, name, secure?.left, selfPubkey, t],
  )
  const onDelete = useCallback((message: Message) => void remove([message]), [remove])
  const onForward = useCallback((message: Message) => setForwarding([message.id]), [])
  const onInfo = useCallback((message: Message) => setInfoFor(message.id), [])

  const forwardTo = async (to: ChatAddress) => {
    const ids = forwarding ?? []
    setForwarding(null)
    setSelected(null)
    await forwardMessages(ids, to)
    navigate(isGroupAddress(to) ? { name: 'group', id: to } : { name: 'chat', peer: to })
  }

  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    draftRef.current = ''
    setReplyTo(null)
    stickToBottom.current = true
    setTyping(false)
    await sendMessage(text, replyTo?.id)
    inputRef.current?.focus()
  }, [draft, replyTo, sendMessage, setTyping])

  // The conversation's entries in the order they happened, each one child of
  // the single column they are drawn in: dates, messages and calls alike.
  const rows = useMemo(() => {
    const output: React.ReactNode[] = []
    let previous: Message | null = null
    // The day last announced. Entries are in causal order and each shows its
    // author's clock, so a reply from a clock behind can show an earlier day
    // than what it answers; a date is announced only when the day moves on.
    let announced: number | null = null

    for (const [index, message] of messages.entries()) {
      if (announced === null || (message.ts > announced && !isSameDay(announced, message.ts))) {
        announced = message.ts
        output.push(
          <div key={`day-${message.id}`} className="day-separator">
            {formatDayLabel(message.ts, locale, { today: t('chat.today'), yesterday: t('chat.yesterday') })}
          </div>,
        )
      }

      const next = messages[index + 1]
      const run = {
        groupStart: startsRun(previous ?? undefined, message),
        groupEnd: !next || startsRun(message, next),
        selecting,
        selected: selected?.has(message.id) ?? false,
        onSelect: toggle,
        onDelete,
      }
      const author = nameOf(message.authorPubkey)

      // A call sits on the side of whoever placed it, and is deleted like
      // anything else — for both people by either of them, since it is theirs
      // alike (ADR-047).
      if (isCallEntry(message)) {
        output.push(
          <CallBubble
            key={message.id}
            message={message}
            {...run}
            onCallBack={callable ? (media) => void startCall(peer, media) : undefined}
          />,
        )
        previous = message
        continue
      }

      output.push(
        <MessageBubble
          key={message.id}
          message={message}
          {...run}
          senderLabel={message.direction === 'out' ? t('chat.fromYou') : t('chat.fromThem', { name: author })}
          authorLabel={isGroup && message.direction === 'in' ? author : undefined}
          quoted={message.replyTo ? (byId.get(message.replyTo) ?? null) : null}
          reactions={reactions.get(message.id)}
          updates={updates.get(message.id)}
          nameOf={nameOf}
          onVote={(m, choices) => void vote(m.id, choices)}
          onCheck={(m, itemId, done) => void checkItem(m.id, itemId, done)}
          onAddItem={(m, label) => void addChecklistItem(m.id, label)}
          selfPubkey={selfPubkey}
          onReact={(m, emoji) => void react(m.id, emoji)}
          onReply={setReplyTo}
          onRetry={(m) => void retryMessage(m.id)}
          onForward={onForward}
          onInfo={message.direction === 'out' ? onInfo : undefined}
        />,
      )
      previous = message
    }
    return output
  }, [
    messages,
    byId,
    locale,
    t,
    isGroup,
    nameOf,
    reactions,
    updates,
    vote,
    checkItem,
    addChecklistItem,
    react,
    selfPubkey,
    retryMessage,
    selecting,
    selected,
    toggle,
    onDelete,
    onForward,
    onInfo,
    callable,
    startCall,
    peer,
  ])

  // A group address that names nothing here — deleted on this device, or a
  // link from another one, whose ids are blinded with a different key. A
  // direct address always has somewhere to go: the conversation is created by
  // the first message.
  if (missing) {
    return (
      <div className="screen">
        <header className="app-header">
          <button className="btn btn-icon btn-back" aria-label={t('common.back')} onClick={() => goBack()}>
            <BackIcon />
          </button>
        </header>
        <EmptyState
          title={t('groups.notFound')}
          body={t('groups.notFoundBody')}
          action={
            <button className="btn btn-primary" onClick={() => navigate({ name: 'chats' }, true)}>
              {t('nav.chats')}
            </button>
          }
        />
      </div>
    )
  }

  const infoMessage = infoFor ? byId.get(infoFor) : undefined

  return (
    <div className="chat-screen">
      {/* While selecting, the header becomes what can be done to the
          selection, as it does in Telegram: how many, forward, delete. */}
      {selecting ? (
        <header className="chat-header selection-bar">
          <button
            className="btn btn-icon"
            aria-label={t('chat.cancelSelection')}
            title={t('chat.cancelSelection')}
            onClick={() => setSelected(null)}
          >
            <CloseIcon />
          </button>
          <span className="grow selection-count" role="status">
            {t('chat.selected', { n: picked.length })}
          </span>
          <button
            className="btn btn-icon"
            aria-label={t('chat.forward')}
            title={t('chat.forward')}
            disabled={picked.some((message) => message.call)}
            onClick={() => setForwarding(picked.map((message) => message.id))}
          >
            <ForwardIcon />
          </button>
          <button
            className="btn btn-icon danger-text"
            aria-label={t('chat.delete')}
            title={t('chat.delete')}
            onClick={() => void remove(picked)}
          >
            <TrashIcon />
          </button>
        </header>
      ) : (
        <header className="chat-header">
          <button className="btn btn-icon btn-back" aria-label={t('common.back')} onClick={() => goBack()}>
            <BackIcon />
          </button>
          {isGroup ? (
            <GroupAvatar seed={address} size="sm" />
          ) : (
            <Avatar name={name} seed={peer} src={contact?.avatar} size="sm" />
          )}
          <button
            className="chat-header-info"
            aria-label={isGroup ? t('groups.info') : t('chat.openContact', { name })}
            onClick={() =>
              navigate(isGroup ? { name: 'group-info', id: address } : { name: 'contact', peer })
            }
          >
            <span className="chat-header-name">
              <span className="truncate" dir="auto">
                {name}
              </span>
              {contact?.verification === 'verified' ? (
                <ShieldCheckIcon size={14} style={{ color: 'var(--success)' }} />
              ) : null}
            </span>
            <span className="chat-header-status">
              {isGroup ? (
                <>
                  {secure ? (
                    <>
                      <LockIcon size={11} /> {t('groups.secure')} ·{' '}
                    </>
                  ) : null}
                  {/* Everyone, counting you: the number the limit is stated in. */}
                  {t('groups.members', { n: (conversation?.members.length ?? 0) + 1 })}
                </>
              ) : typing ? (
                t('chat.typing')
              ) : direct ? (
                <>
                  <BoltIcon size={11} /> {t('status.direct')}
                </>
              ) : (
                t('status.relayed')
              )}
            </span>
          </button>
          {callable ? (
            <>
              <button
                className="btn btn-icon"
                aria-label={t('calls.voiceCall')}
                title={t('calls.voiceCall')}
                onClick={() => void startCall(peer, 'audio')}
              >
                <PhoneIcon />
              </button>
              <button
                className="btn btn-icon"
                aria-label={t('calls.videoCall')}
                title={t('calls.videoCall')}
                onClick={() => void startCall(peer, 'video')}
              >
                <VideoIcon />
              </button>
            </>
          ) : null}
        </header>
      )}

      {isGroup && conversation && !conversation.accepted ? (
        <div className="chat-notice">
          <Banner tone="warning">
            <span className="grow">{t('groups.requestBanner')}</span>
            <button className="btn btn-ghost small" onClick={() => void acceptGroup(address)}>
              {t('groups.accept')}
            </button>
            <button
              className="btn btn-ghost small danger-text"
              onClick={async () => {
                if (!(await confirmDanger(t('groups.delete'), t('groups.delete'), t('groups.deleteConfirm'))))
                  return
                void deleteConversation(address).then(() => navigate({ name: 'chats' }, true))
              }}
            >
              {t('groups.delete')}
            </button>
          </Banner>
        </div>
      ) : null}

      {contact && !contact.accepted ? (
        <div className="chat-notice">
          <Banner tone="warning">
            <span className="grow">{t('chat.requestBanner')}</span>
            <button
              className="btn btn-ghost small"
              onClick={() => void updateContact(peer, { accepted: true, source: 'manual' })}
            >
              {t('chat.accept')}
            </button>
            <button
              className="btn btn-ghost small danger-text"
              onClick={() => void updateContact(peer, { blocked: true })}
            >
              {t('chat.block')}
            </button>
          </Banner>
        </div>
      ) : null}

      {contact?.blocked ? (
        <div className="chat-notice">
          <Banner tone="danger">
            <span className="grow">{t('chat.blocked')}</span>
            <button
              className="btn btn-ghost small"
              onClick={() => void updateContact(peer, { blocked: false })}
            >
              {t('chat.unblock')}
            </button>
          </Banner>
        </div>
      ) : null}

      {sharingHere ? (
        <Suspense fallback={null}>
          <LiveBanner address={address} />
        </Suspense>
      ) : null}

      {contact && contact.verification !== 'verified' && messages.length > 0 ? (
        <div className="chat-notice">
          <Banner tone="accent">
            <ShieldIcon size={16} />
            <span className="grow">{t('chat.verifyPromptBody')}</span>
            <button className="btn btn-ghost small" onClick={() => navigate({ name: 'verify', peer })}>
              {t('contacts.verify')}
            </button>
          </Banner>
        </div>
      ) : null}

      <div className="message-list" ref={listRef} onScroll={onScroll} role="log" aria-live="polite">
        <div className={selecting ? 'message-stream selecting' : 'message-stream'}>
          {messages.length === 0 ? (
            <EmptyState title={t('chats.noMessages')} body={t('chat.encryptedNote')} />
          ) : hasEarlierMessages ? (
            <button
              ref={earlierRef}
              className="btn btn-ghost small"
              disabled={loadingEarlier}
              onClick={() => void loadEarlier()}
            >
              {loadingEarlier ? t('common.loading') : t('chat.loadEarlier')}
            </button>
          ) : (
            <p className="faint">{t('chat.startOfConversation')}</p>
          )}
          {rows}
          {typing ? (
            <div className="typing-indicator" aria-label={t('chat.typing')}>
              <span />
              <span />
              <span />
            </div>
          ) : null}
        </div>
      </div>

      {away ? (
        <div className="jump-dock">
          <button
            type="button"
            className="jump-latest"
            aria-label={t('chat.jumpToLatest')}
            title={t('chat.jumpToLatest')}
            onClick={() => {
              const node = listRef.current
              node?.scrollTo({ top: node.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' })
            }}
          >
            <ArrowDownIcon />
          </button>
        </div>
      ) : null}

      {replyTo ? (
        <div className="reply-preview">
          <span className="reply-preview-body truncate" dir="auto">
            <span className="faint" style={{ display: 'block' }}>
              {t('chat.replyingTo')}
            </span>
            {replyTo.body}
          </span>
          <button className="btn btn-icon" aria-label={t('common.close')} onClick={() => setReplyTo(null)}>
            <CloseIcon size={16} />
          </button>
        </div>
      ) : null}

      {secure?.left ? (
        <div className="composer">
          <Banner tone="warning">
            <span className="grow">{t('groups.secureLeft')}</span>
          </Banner>
        </div>
      ) : (
        <div className="composer">
          {secure ? null : <AttachButton disabled={contact?.blocked} />}
          <textarea
            ref={inputRef}
            className="composer-input"
            dir="auto"
            rows={1}
            placeholder={t('chat.placeholder')}
            aria-label={t('chat.placeholder')}
            value={draft}
            disabled={contact?.blocked}
            onChange={(event) => {
              setDraft(event.target.value)
              draftRef.current = event.target.value
              setTyping(event.target.value.length > 0)
              // Grow with content up to the CSS max-height, then scroll.
              const node = event.target
              node.style.height = 'auto'
              node.style.height = `${Math.min(node.scrollHeight, 144)}px`
            }}
            onBlur={() => setTyping(false)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              const shouldSend = settings.enterToSend ? !event.shiftKey : event.ctrlKey || event.metaKey
              if (!shouldSend) return
              event.preventDefault()
              void send()
            }}
          />
          {/* Trailing the input: this one edits what is being typed, so it sits
            at the end of the field beside send rather than with the
            attachment control that opens a file picker. */}
          <EmojiButton
            disabled={contact?.blocked}
            onInsertEmoji={(emoji) => {
              setDraft((current) => current + emoji)
              draftRef.current += emoji
            }}
          />
          {/* The microphone takes the place of send while there is nothing to
            send, the way every messenger does it — one control, two jobs. */}
          {draft.trim() || secure ? (
            <button
              className="composer-send"
              aria-label={t('chat.send')}
              disabled={contact?.blocked || !draft.trim()}
              onClick={() => void send()}
            >
              <SendIcon size={18} />
            </button>
          ) : (
            <VoiceButton disabled={contact?.blocked} />
          )}
        </div>
      )}

      {forwarding ? (
        <Suspense fallback={null}>
          <ForwardSheet onPick={(to) => void forwardTo(to)} onClose={() => setForwarding(null)} />
        </Suspense>
      ) : null}
      {infoMessage ? (
        <Suspense fallback={null}>
          <MessageInfo message={infoMessage} onClose={() => setInfoFor(null)} />
        </Suspense>
      ) : null}
    </div>
  )
}
