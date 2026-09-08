import { useMemo, useState } from 'react'
import { useApp } from '../../app/store'
import { useI18n } from '../../i18n'
import { goBack, useNavigate } from '../../app/router'
import { Avatar, Banner, EmptyState, Field } from '../components/primitives'
import { SegmentedControl } from '../components/SegmentedControl'
import { BackIcon, ContactsIcon, LockIcon, ShieldCheckIcon } from '../components/Icons'
import { displayName } from '../screens/ChatList'
import { MAX_GROUP_MEMBERS, MAX_MLS_MEMBERS, MAX_SUBJECT_CHARS } from '../../core/models/protocol'
import { explainFailure, useSecureText } from './secureText'

type Kind = 'small' | 'secure'

/**
 * Start a group from the address book — a small group, or a forward-secret
 * one.
 *
 * The difference is stated before anyone is chosen, because it decides what
 * the group can do: a small group is a fixed set of up to eight people, each
 * message sent to each of them (ADR-044); a forward-secret group is an MLS
 * group whose keys move on as people join and leave, up to a hundred of them,
 * carrying text only (ADR-049). "Why can't I add more?" and "why can't I send
 * a photo here?" both deserve an answer before they are asked.
 */
export function NewGroup() {
  const { t } = useI18n()
  const text = useSecureText()
  const navigate = useNavigate()
  const contacts = useApp((s) => s.contacts)
  const createGroup = useApp((s) => s.createGroup)
  const createSecureGroup = useApp((s) => s.createSecureGroup)
  const toast = useApp((s) => s.toast)
  const [kind, setKind] = useState<Kind>('small')
  const [subject, setSubject] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  // Only people the user has taken: a group made from message requests would
  // hand strangers each other's keys.
  const candidates = useMemo(
    () =>
      [...contacts.values()]
        .filter((contact) => contact.accepted && !contact.blocked)
        .sort((a, b) => displayName(a, a.pubkey).localeCompare(displayName(b, b.pubkey))),
    [contacts],
  )
  const secure = kind === 'secure'
  const room = (secure ? MAX_MLS_MEMBERS : MAX_GROUP_MEMBERS) - 1
  const full = chosen.length >= room
  const enough = chosen.length >= (secure ? 1 : 2)

  const toggle = (pubkey: string) =>
    setChosen((current) =>
      current.includes(pubkey)
        ? current.filter((entry) => entry !== pubkey)
        : current.length >= room
          ? current
          : [...current, pubkey],
    )

  const switchKind = (next: Kind) => {
    setKind(next)
    setProblem(null)
    // A small group cannot hold what a secure one was given.
    if (next === 'small') setChosen((current) => current.slice(0, MAX_GROUP_MEMBERS - 1))
  }

  const create = async () => {
    setBusy(true)
    setProblem(null)
    if (!secure) {
      const id = await createGroup(chosen, subject)
      setBusy(false)
      // Replaces this screen in history, so "back" from the new group goes to
      // the chat list rather than to a half-filled form.
      if (id) navigate({ name: 'group', id }, true)
      return
    }
    try {
      const { id, missing } = await createSecureGroup(chosen, subject)
      if (missing.length > 0) {
        const names = missing.map((pubkey) => displayName(contacts.get(pubkey), pubkey)).join(', ')
        toast(text('someMissing', { names }))
      }
      navigate({ name: 'group', id }, true)
    } catch (err) {
      setProblem(
        err instanceof Error && /can be added/.test(err.message)
          ? text('noneReady')
          : explainFailure(text, err),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="screen">
      <header className="app-header">
        <button className="btn btn-icon" aria-label={t('common.back')} onClick={() => goBack()}>
          <BackIcon />
        </button>
        <h1 className="grow">{t('groups.newGroup')}</h1>
      </header>

      <div className="screen-scroll">
        {candidates.length < (secure ? 1 : 2) ? (
          <EmptyState
            title={t('groups.noContacts')}
            action={
              <button className="btn btn-primary" onClick={() => navigate({ name: 'add-contact' })}>
                {t('chats.addContact')}
              </button>
            }
          />
        ) : (
          <div className="container stack" style={{ maxWidth: '34rem' }}>
            <SegmentedControl
              label={text('kindLabel')}
              value={kind}
              onChange={switchKind}
              options={[
                { value: 'small', label: text('kindSmall') },
                { value: 'secure', label: text('kindSecure') },
              ]}
            />

            {secure ? (
              <Banner tone="accent">
                <LockIcon size={18} />
                <span className="stack-sm">
                  <strong>{text('secureTitle')}</strong>
                  <span className="small">{text('secureBody', { max: MAX_MLS_MEMBERS })}</span>
                </span>
              </Banner>
            ) : (
              <Banner tone="accent">
                <ContactsIcon size={18} />
                <span className="stack-sm">
                  <strong>{t('groups.limitTitle', { max: MAX_GROUP_MEMBERS })}</strong>
                  <span className="small">{t('groups.limitBody')}</span>
                </span>
              </Banner>
            )}

            <Field label={t('groups.name')}>
              <input
                className="input"
                dir="auto"
                value={subject}
                maxLength={MAX_SUBJECT_CHARS}
                placeholder={t('groups.namePlaceholder')}
                onChange={(event) => setSubject(event.target.value)}
              />
            </Field>

            <div className="row-between">
              <span className="section-title" id="group-members-label">
                {t('groups.pickMembers')}
              </span>
              <span className="hint tabular" aria-live="polite">
                {full ? t('groups.full') : t('groups.chosen', { n: chosen.length, max: room })}
              </span>
            </div>

            <div className="card-section" role="group" aria-labelledby="group-members-label">
              {candidates.map((contact) => {
                const on = chosen.includes(contact.pubkey)
                const name = displayName(contact, contact.pubkey)
                return (
                  <label key={contact.pubkey} className={`list-row${!on && full ? ' is-disabled' : ''}`}>
                    <input
                      type="checkbox"
                      className="checkbox"
                      checked={on}
                      aria-label={name}
                      disabled={!on && full}
                      onChange={() => toggle(contact.pubkey)}
                    />
                    <Avatar name={name} seed={contact.pubkey} src={contact.avatar} size="sm" />
                    {/* Isolated rather than dir="auto": a Persian name in an
                        English list keeps its own direction but lines up with
                        the other names instead of flushing to the far edge. */}
                    <span className="grow truncate">
                      <bdi>{name}</bdi>
                    </span>
                    {contact.verification === 'verified' ? (
                      <ShieldCheckIcon size={15} style={{ color: 'var(--success)' }} />
                    ) : null}
                  </label>
                )
              })}
            </div>

            {secure ? null : <p className="hint">{t('groups.fixedMembers')}</p>}

            {problem ? (
              <Banner tone="danger">
                <span className="grow">{problem}</span>
              </Banner>
            ) : null}

            <button
              type="button"
              className="btn btn-primary btn-block"
              disabled={!enough || busy}
              aria-busy={busy}
              onClick={() => void create()}
            >
              {busy && secure ? text('finding') : t('groups.create')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
