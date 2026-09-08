import { useMemo, useState } from 'react'
import { useApp } from '../../app/store'
import { useI18n } from '../../i18n'
import { useNavigate } from '../../app/router'
import { Avatar, EmptyState } from '../components/primitives'
import { PlusIcon, ShieldCheckIcon } from '../components/Icons'
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
