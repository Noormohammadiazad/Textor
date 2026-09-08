import { useEffect, useMemo, useState } from 'react'
import { getMessenger, useApp } from '../../app/store'
import { useT } from '../../i18n'
import { useNavigate } from '../../app/router'
import { Avatar, Banner, PublicKey } from '../components/primitives'
import { lookUpTextorId, parseTextorId, type IdLookup, type IdOwner } from '../../core/identity/textorId'
import { formatId, toNpub } from '../../core/identity/keys'
import { DEFAULT_DM_RELAYS } from '../../core/transport/defaultRelays'
import { useTextorIdText } from './textorIdText'

/** As long as reading a record may take on a slow connection (ADR-078). */
const LOOK_HURRY_MS = 3000
const LOOK_PATIENCE_MS = 12_000

/**
 * Landing screen for `#/id/<id>`, and where typing an ID leads.
 *
 * A record found here has been checked against the ID before it is shown, so what
 * this offers is the key the ID was worked out from. It is still only as good as
 * whoever gave out the ID, which is why it says to verify, as an invite does
 * (THREAT-MODEL §3.8).
 */
export function TextorIdScreen({ id: raw }: { id: string }) {
  const t = useT()
  const text = useTextorIdText()
  const navigate = useNavigate()
  const identity = useApp((s) => s.identity)
  const contacts = useApp((s) => s.contacts)
  const addContact = useApp((s) => s.addContact)
  const toast = useApp((s) => s.toast)
  const id = useMemo(() => parseTextorId(raw), [raw])
  const [lookup, setLookup] = useState<IdLookup | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!id) return
    let live = true
    const pool = getMessenger()?.pool
    const look = pool
      ? lookUpTextorId(id, (filter) =>
          pool.query(filter, [...new Set([...pool.readRelays, ...pool.writeRelays, ...DEFAULT_DM_RELAYS])], {
            graceMs: LOOK_HURRY_MS,
            maxWait: LOOK_PATIENCE_MS,
          }),
        )
      : Promise.reject(new Error('not running'))
    look.then(
      (found) => {
        if (live) setLookup(found)
      },
      () => {
        if (live) setFailed(true)
      },
    )
    return () => {
      live = false
    }
  }, [id, attempt])

  const close = () => navigate({ name: 'chats' }, true)

  if (!id) {
    return (
      <div className="screen-scroll">
        <div className="container stack">
          <Banner tone="danger">{text('invalid')}</Banner>
          <button className="btn btn-outline btn-block" onClick={close}>
            {t('common.close')}
          </button>
        </div>
      </div>
    )
  }

  const add = async (owner: IdOwner) => {
    setBusy(true)
    try {
      await addContact({ pubkey: owner.pubkey, relays: owner.relays, source: 'id', textorId: id })
      toast(t('contacts.added'))
      navigate({ name: 'chat', peer: owner.pubkey }, true)
    } catch {
      toast(t('errors.generic'), 'danger')
    } finally {
      setBusy(false)
    }
  }

  const owners = lookup?.owners ?? []
  const shown = formatId(id)

  return (
    <div className="screen-scroll">
      <div className="container stack center" style={{ maxWidth: '28rem', paddingBlock: 'var(--space-6)' }}>
        <h1 className="mono" dir="ltr" style={{ fontSize: 'var(--step-2)' }}>
          {shown}
        </h1>

        {!lookup && !failed ? <p className="muted">{text('searching', { id: shown })}</p> : null}
        {failed ? (
          <>
            <Banner tone="warning">{text('unreachable')}</Banner>
            <button
              className="btn btn-outline btn-block"
              onClick={() => {
                setFailed(false)
                setAttempt((value) => value + 1)
              }}
            >
              {text('retry')}
            </button>
          </>
        ) : null}
        {lookup && owners.length === 0 && !lookup.crowded ? (
          <Banner tone="warning">{text('nobody')}</Banner>
        ) : null}
        {lookup?.crowded ? <Banner tone="danger">{text('crowded')}</Banner> : null}
        {owners.length > 1 ? <Banner tone="danger">{text('conflict', { n: owners.length })}</Banner> : null}

        {owners.map((owner) => {
          const own = owner.pubkey === identity?.pubkey
          const existing = contacts.get(owner.pubkey)?.accepted
          return (
            <div className="card stack-sm" key={owner.pubkey}>
              <div style={{ display: 'grid', placeItems: 'center' }}>
                <Avatar name={shown} seed={owner.pubkey} size="lg" />
              </div>
              {/* Open when there are several: it is what tells them apart. */}
              <PublicKey npub={toNpub(owner.pubkey)} open={owners.length > 1} />
              {own ? <Banner tone="accent">{text('own')}</Banner> : null}
              {!own && existing ? (
                <>
                  <Banner tone="accent">{t('contacts.alreadyAdded')}</Banner>
                  <button
                    className="btn btn-primary btn-block"
                    onClick={() => navigate({ name: 'chat', peer: owner.pubkey }, true)}
                  >
                    {t('nav.chats')}
                  </button>
                </>
              ) : null}
              {!own && !existing ? (
                <button className="btn btn-primary btn-block" disabled={busy} onClick={() => void add(owner)}>
                  {t('contacts.add')}
                </button>
              ) : null}
            </div>
          )
        })}

        <button className="btn btn-ghost btn-block" onClick={close}>
          {t('common.cancel')}
        </button>

        {owners.length > 0 ? (
          <Banner tone="accent">
            <span className="small">{t('chat.verifyPromptBody')}</span>
          </Banner>
        ) : null}
      </div>
    </div>
  )
}
