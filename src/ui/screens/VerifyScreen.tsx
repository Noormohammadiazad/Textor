import { useMemo } from 'react'
import { useApp } from '../../app/store'
import { useT } from '../../i18n'
import { goBack } from '../../app/router'
import { Banner, CopyButton, EmptyState } from '../components/primitives'
import { BackIcon, ShieldCheckIcon } from '../components/Icons'
import { QrCode } from '../components/QrCode'
import { safetyNumber } from '../../core/crypto/safetyNumber'
import { displayName } from './ChatList'

/**
 * The safety-number ceremony.
 *
 * This is the only step that turns "encrypted to some key" into "encrypted to
 * the person I mean". Everything else in the app protects the channel; this
 * protects against having been handed the wrong key in the first place, which
 * no amount of cryptography can detect on its own.
 */
export function VerifyScreen({ peer }: { peer: string }) {
  const t = useT()
  const identity = useApp((s) => s.identity)
  const contacts = useApp((s) => s.contacts)
  const updateContact = useApp((s) => s.updateContact)
  const toast = useApp((s) => s.toast)

  const contact = contacts.get(peer)
  const number = useMemo(() => (identity ? safetyNumber(identity.pubkey, peer) : null), [identity, peer])

  if (!identity || !number) {
    return <EmptyState title={t('common.loading')} />
  }

  const name = displayName(contact, peer)
  const verified = contact?.verification === 'verified'

  return (
    <div className="screen">
      <header className="app-header">
        <button className="btn btn-icon" aria-label={t('common.back')} onClick={() => goBack()}>
          <BackIcon />
        </button>
        <h1 className="grow">{t('verify.title')}</h1>
      </header>

      <div className="screen-scroll">
        <div className="container stack" style={{ maxWidth: '30rem' }}>
          <p className="muted">{t('verify.body', { name })}</p>

          <div className="card stack">
            <div className="safety-emoji" aria-hidden="true">
              {number.emoji.map((glyph, index) => (
                <span key={index}>{glyph}</span>
              ))}
            </div>
            <div className="safety-number" aria-label={number.groups.join(' ')}>
              {number.groups.map((group, index) => (
                <span key={index}>{group}</span>
              ))}
            </div>
            <CopyButton value={number.groups.join(' ')} className="btn btn-outline btn-block" />
          </div>

          <QrCode value={`textor-sn:${number.compact}`} label={t('verify.title')} />

          {verified ? (
            <>
              <Banner tone="accent">
                <ShieldCheckIcon size={16} />
                <span>{t('verify.verifiedAt')}</span>
              </Banner>
              <button
                className="btn btn-outline btn-block"
                onClick={() => void updateContact(peer, { verification: 'unverified' })}
              >
                {t('verify.markUnverified')}
              </button>
            </>
          ) : (
            <button
              className="btn btn-primary btn-block"
              onClick={() => {
                void updateContact(peer, { verification: 'verified' })
                toast(t('contacts.verified'))
              }}
            >
              <ShieldCheckIcon size={16} />
              {t('verify.markVerified')}
            </button>
          )}

          <div className="card stack-sm">
            <h3 style={{ fontSize: 'var(--step-0)' }}>{t('verify.mismatchTitle')}</h3>
            <p className="muted small">{t('verify.mismatchBody')}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
