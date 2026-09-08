import { useMemo, useState } from 'react'
import { useApp } from '../../app/store'
import { useI18n } from '../../i18n'
import { goBack, useNavigate } from '../../app/router'
import { Avatar, Banner, CopyButton, EmptyState, Field } from '../components/primitives'
import { BackIcon, PlusIcon, ShieldCheckIcon, TrashIcon } from '../components/Icons'
import { shortNpub, toNpub } from '../../core/identity/keys'
import { relayLabel } from '../../core/transport/relayUrl'
import { formatDateTime } from '../format'
import { displayName } from './ChatList'

export function ContactsList() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const contacts = useApp((s) => s.contacts)
  const [query, setQuery] = useState('')

  const list = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return [...contacts.values()]
      .filter((contact) => !needle || displayName(contact, contact.pubkey).toLowerCase().includes(needle))
      .sort(
        (a, b) =>
          Number(a.blocked) - Number(b.blocked) ||
          displayName(a, a.pubkey).localeCompare(displayName(b, b.pubkey)),
      )
  }, [contacts, query])

  return (
    <div className="screen">
      <header className="app-header">
        <h1 className="grow">{t('contacts.title')}</h1>
        <button
          className="btn btn-icon"
          aria-label={t('contacts.add')}
          onClick={() => navigate({ name: 'add-contact' })}
        >
          <PlusIcon />
        </button>
      </header>

      {contacts.size > 5 ? (
        <div style={{ padding: 'var(--space-2) var(--space-3)' }}>
          <input
            className="input"
            type="search"
            placeholder={t('common.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      ) : null}

      <div className="screen-scroll">
        {list.length === 0 ? (
          <EmptyState
            title={t('contacts.empty')}
            action={
              <button className="btn btn-primary" onClick={() => navigate({ name: 'add-contact' })}>
                {t('contacts.add')}
              </button>
            }
          />
        ) : (
          list.map((contact) => (
            <button
              key={contact.pubkey}
              className="list-row"
              onClick={() => navigate({ name: 'contact', peer: contact.pubkey })}
            >
              <Avatar
                name={displayName(contact, contact.pubkey)}
                seed={contact.pubkey}
                src={contact.avatar}
                size="sm"
              />
              <span className="grow truncate">{displayName(contact, contact.pubkey)}</span>
              {contact.verification === 'verified' ? (
                <ShieldCheckIcon size={15} style={{ color: 'var(--success)' }} />
              ) : null}
              {contact.blocked ? <span className="badge badge-danger">{t('chat.block')}</span> : null}
            </button>
          ))
        )}
      </div>
    </div>
  )
}

export function ContactDetail({ peer }: { peer: string }) {
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  const contacts = useApp((s) => s.contacts)
  const updateContact = useApp((s) => s.updateContact)
  const removeContact = useApp((s) => s.removeContact)

  const contact = contacts.get(peer)
  const [name, setName] = useState(contact?.name ?? '')
  const [note, setNote] = useState(contact?.note ?? '')

  if (!contact) {
    return (
      <div className="screen-scroll">
        <div className="container">
          <EmptyState title={t('common.unknown')} />
        </div>
      </div>
    )
  }

  const label = displayName(contact, peer)

  return (
    <div className="screen">
      <header className="app-header">
        <button className="btn btn-icon" aria-label={t('common.back')} onClick={() => goBack()}>
          <BackIcon />
        </button>
        <h1 className="grow truncate">{label}</h1>
      </header>

      <div className="screen-scroll">
        <div className="container stack" style={{ maxWidth: '32rem' }}>
          <div className="stack-sm center">
            <div style={{ display: 'grid', placeItems: 'center' }}>
              <Avatar name={label} seed={peer} src={contact.avatar} size="lg" />
            </div>
            <h2 style={{ fontSize: 'var(--step-1)' }}>{label}</h2>
            {contact.about ? <p className="muted small">{contact.about}</p> : null}
            <span className={`badge ${contact.verification === 'verified' ? 'badge-success' : ''}`}>
              {contact.verification === 'verified' ? t('contacts.verified') : t('contacts.unverified')}
            </span>
          </div>

          <div className="row">
            <button
              className="btn btn-primary grow"
              onClick={() => navigate({ name: 'chat', peer })}
              disabled={contact.blocked}
            >
              {t('nav.chats')}
            </button>
            <button className="btn btn-outline grow" onClick={() => navigate({ name: 'verify', peer })}>
              {t('contacts.verify')}
            </button>
          </div>

          <div className="card stack">
            <Field label={t('contacts.nameLabel')}>
              <input
                className="input"
                value={name}
                maxLength={64}
                onChange={(event) => setName(event.target.value)}
                onBlur={() => {
                  if (name !== contact.name) void updateContact(peer, { name })
                }}
              />
            </Field>
            <Field label={t('contacts.noteLabel')} hint={t('contacts.noteHint')}>
              <textarea
                className="textarea"
                style={{ minHeight: '3.5rem' }}
                value={note}
                maxLength={500}
                onChange={(event) => setNote(event.target.value)}
                onBlur={() => {
                  if (note !== (contact.note ?? '')) void updateContact(peer, { note })
                }}
              />
            </Field>
          </div>

          <div className="card stack-sm">
            <span className="section-title">{t('contacts.copyKey')}</span>
            <code className="mono small" style={{ wordBreak: 'break-all' }}>
              {toNpub(peer)}
            </code>
            <CopyButton value={toNpub(peer)} />
            {contact.relays.length > 0 ? (
              <p className="faint">{contact.relays.map(relayLabel).join(' · ')}</p>
            ) : null}
            <p className="faint">
              {t('common.add')}: {formatDateTime(contact.addedAt, locale)}
            </p>
          </div>

          {contact.blocked ? (
            <Banner tone="danger">
              <span className="grow">{t('chat.blocked')}</span>
              <button
                className="btn btn-ghost small"
                onClick={() => void updateContact(peer, { blocked: false })}
              >
                {t('chat.unblock')}
              </button>
            </Banner>
          ) : (
            <button
              className="btn btn-outline btn-block"
              onClick={() => {
                if (confirm(t('contacts.blockConfirm'))) void updateContact(peer, { blocked: true })
              }}
            >
              {t('chat.block')}
            </button>
          )}

          <button
            className="btn btn-danger btn-block"
            onClick={() => {
              if (!confirm(t('contacts.removeConfirm'))) return
              void removeContact(peer)
              navigate({ name: 'contacts' }, true)
            }}
          >
            <TrashIcon size={16} />
            {t('common.remove')}
          </button>

          <p className="hint">{shortNpub(toNpub(peer))}</p>
        </div>
      </div>
    </div>
  )
}
