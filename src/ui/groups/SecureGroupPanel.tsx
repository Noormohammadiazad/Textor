import { useMemo, useState } from 'react'
import { useApp } from '../../app/store'
import { useI18n } from '../../i18n'
import { useNavigate } from '../../app/router'
import type { Conversation } from '../../core/models/types'
import { MAX_MLS_MEMBERS } from '../../core/models/protocol'
import { Avatar, Banner } from '../components/primitives'
import { LockIcon, PlusIcon, RefreshIcon, ShieldCheckIcon, TrashIcon } from '../components/Icons'
import { displayName } from '../screens/ChatList'
import { explainFailure, useSecureText } from './secureText'

/**
 * RFC 9420's epoch authenticator, as people can read it aloud: the first 80
 * bits in five groups of four. Enough that a mismatch is never a coincidence,
 * short enough to compare across a table.
 */
export function formatSecurityCode(code: string): string {
  return (code.slice(0, 20).match(/.{4}/g) ?? []).join(' ')
}

function relative(sec: number, locale: string): string {
  const seconds = sec - Date.now() / 1000
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const days = Math.round(seconds / 86_400)
  if (Math.abs(days) >= 1) return format.format(days, 'day')
  const hours = Math.round(seconds / 3600)
  if (Math.abs(hours) >= 1) return format.format(hours, 'hour')
  return format.format(Math.round(seconds / 60), 'minute')
}

/**
 * Everything particular to a forward-secret group on its info screen: the
 * code members compare, how fresh this device's keys are, who runs it, and
 * the changes an MLS group — unlike a small one — can make to itself.
 */
export function SecureGroupPanel({ group }: { group: Conversation }) {
  const { t, locale } = useI18n()
  const text = useSecureText()
  const navigate = useNavigate()
  const contacts = useApp((s) => s.contacts)
  const identity = useApp((s) => s.identity)
  const changeSecureGroup = useApp((s) => s.changeSecureGroup)
  const deleteConversation = useApp((s) => s.deleteConversation)
  const toast = useApp((s) => s.toast)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [chosen, setChosen] = useState<string[]>([])
  const mls = group.mls!
  const self = identity?.pubkey ?? ''
  const amAdmin = mls.admins.includes(self)

  const addable = useMemo(
    () =>
      [...contacts.values()]
        .filter((c) => c.accepted && !c.blocked && !group.members.includes(c.pubkey))
        .sort((a, b) => displayName(a, a.pubkey).localeCompare(displayName(b, b.pubkey), locale)),
    [contacts, group.members, locale],
  )
  const room = MAX_MLS_MEMBERS - (group.members.length + 1)

  const run = async (change: Parameters<typeof changeSecureGroup>[1], after?: () => void) => {
    setBusy(true)
    try {
      const { missing } = await changeSecureGroup(group.id, change)
      if (missing.length > 0) {
        const names = missing.map((pubkey) => displayName(contacts.get(pubkey), pubkey)).join(', ')
        toast(text('someMissing', { names }))
      }
      after?.()
    } catch (err) {
      toast(explainFailure(text, err), 'danger')
    } finally {
      setBusy(false)
    }
  }

  if (mls.left) {
    return (
      <div className="stack">
        <Banner tone="warning">
          <span className="grow">{text('left')}</span>
        </Banner>
        <button
          type="button"
          className="btn btn-danger-soft btn-block"
          onClick={() => {
            if (!confirm(text('deleteConfirm'))) return
            void deleteConversation(group.id).then(() => navigate({ name: 'chats' }, true))
          }}
        >
          <TrashIcon size={16} />
          {text('deleteHistory')}
        </button>
      </div>
    )
  }

  return (
    <div className="stack">
      <div className="card stack-sm">
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <LockIcon size={16} />
          <strong>{text('badge')}</strong>
        </div>
        <p className="hint">{text('explainer')}</p>
        <div className="stack-sm" aria-live="polite">
          <span className="section-title">{text('code')}</span>
          <code className="security-code" dir="ltr">
            {formatSecurityCode(mls.code)}
          </code>
          <span className="hint tabular">{text('generation', { n: mls.epoch })}</span>
          <p className="hint">{text('codeHint')}</p>
        </div>
        <p className="small">{text('refreshed', { when: relative(mls.refreshedAt, locale) })}</p>
        <button
          type="button"
          className="btn btn-ghost small"
          disabled={busy}
          onClick={() => void run({ rotate: true })}
        >
          <RefreshIcon size={14} />
          {busy ? text('working') : text('refreshNow')}
        </button>
      </div>

      <div className="card-section">
        {identity ? (
          <div className="list-row">
            <Avatar name={identity.name} seed={identity.pubkey} src={identity.avatar} size="sm" />
            <span className="grow truncate">
              <bdi>{identity.name}</bdi>
            </span>
            {amAdmin ? <span className="badge">{text('admin')}</span> : null}
            <span className="hint">{t('groups.you')}</span>
          </div>
        ) : null}
        {[...group.members]
          .sort((a, b) =>
            displayName(contacts.get(a), a).localeCompare(displayName(contacts.get(b), b), locale),
          )
          .map((pubkey) => {
            const contact = contacts.get(pubkey)
            const name = displayName(contact, pubkey)
            return (
              <div key={pubkey} className="list-row">
                <Avatar name={name} seed={pubkey} src={contact?.avatar} size="sm" />
                <span className="grow truncate">
                  <bdi>{name}</bdi>
                </span>
                {contact?.verification === 'verified' ? (
                  <ShieldCheckIcon size={15} style={{ color: 'var(--success)' }} />
                ) : null}
                {mls.admins.includes(pubkey) ? <span className="badge">{text('admin')}</span> : null}
                {amAdmin ? (
                  <button
                    type="button"
                    className="btn btn-ghost small danger-text"
                    disabled={busy}
                    aria-label={`${text('remove')} ${name}`}
                    onClick={() => {
                      if (confirm(text('removeConfirm', { name }))) void run({ remove: pubkey })
                    }}
                  >
                    {text('remove')}
                  </button>
                ) : null}
              </div>
            )
          })}
      </div>

      {amAdmin ? (
        adding ? (
          <div className="stack-sm">
            <p className="hint">{addable.length > 0 ? text('addHint') : text('nobodyToAdd')}</p>
            {addable.length > 0 ? (
              <div className="card-section" role="group" aria-label={text('add')}>
                {addable.map((contact) => {
                  const on = chosen.includes(contact.pubkey)
                  const name = displayName(contact, contact.pubkey)
                  const blocked = !on && chosen.length >= room
                  return (
                    <label key={contact.pubkey} className={`list-row${blocked ? ' is-disabled' : ''}`}>
                      <input
                        type="checkbox"
                        className="checkbox"
                        checked={on}
                        aria-label={name}
                        disabled={blocked}
                        onChange={() =>
                          setChosen((current) =>
                            on ? current.filter((p) => p !== contact.pubkey) : [...current, contact.pubkey],
                          )
                        }
                      />
                      <Avatar name={name} seed={contact.pubkey} src={contact.avatar} size="sm" />
                      <span className="grow truncate">
                        <bdi>{name}</bdi>
                      </span>
                    </label>
                  )
                })}
              </div>
            ) : null}
            <div className="row" style={{ gap: 'var(--space-2)' }}>
              <button
                type="button"
                className="btn btn-primary grow"
                disabled={busy || chosen.length === 0}
                onClick={() =>
                  void run({ add: chosen }, () => {
                    setAdding(false)
                    setChosen([])
                  })
                }
              >
                {busy ? text('finding') : text('addChosen', { n: chosen.length })}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setAdding(false)}>
                {t('common.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-ghost btn-block"
            disabled={room <= 0}
            onClick={() => setAdding(true)}
          >
            <PlusIcon size={16} />
            {text('add')}
          </button>
        )
      ) : null}

      <button
        type="button"
        className="btn btn-danger-soft btn-block"
        disabled={busy}
        onClick={() => {
          const note = amAdmin && group.members.length > 0 ? `\n\n${text('leaveAdmin')}` : ''
          if (!confirm(text('leaveConfirm') + note)) return
          void run({ leave: true }, () => navigate({ name: 'chats' }, true))
        }}
      >
        {text('leave')}
      </button>
    </div>
  )
}
