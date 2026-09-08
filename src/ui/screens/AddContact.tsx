import { hexToBytes, wipe } from '../../core/util/bytes'
import { Suspense, useCallback, useMemo, useState } from 'react'
import { useApp } from '../../app/store'
import { useT } from '../../i18n'
import { goBack, useNavigate } from '../../app/router'
import { Banner, CopyButton, Field, IdButton } from '../components/primitives'
import { BackIcon, CameraIcon, QrIcon } from '../components/Icons'
import { LAZY_CHUNKS, QrCode, QrScanner } from '../lazyViews'
import { QrPlaceholder } from '../components/QrPlaceholder'
import {
  createInvite,
  decodeInvite,
  extractInvitePayload,
  inviteLink,
  isInviteStale,
  type Invite,
} from '../../core/identity/invite'
import { parseProfilePointer, shownId } from '../../core/identity/keys'
import { usePeopleText } from './peopleText'

type Mode = 'share' | 'scan' | 'paste'

/**
 * Contact exchange without a directory server.
 *
 * Three routes to the same place: show a QR in person, send a link over a
 * channel you already trust, or paste a key. The QR encodes the full invite
 * link so a generic camera app opens Textor directly.
 */
export function AddContact() {
  const t = useT()
  const pt = usePeopleText()
  const navigate = useNavigate()
  const identity = useApp((s) => s.identity)
  const fallbackRelays = useApp((s) => s.fallbackInviteRelays)
  const contacts = useApp((s) => s.contacts)
  const addContact = useApp((s) => s.addContact)
  const toast = useApp((s) => s.toast)
  const ownId = shownId(identity?.textorId)

  const [mode, setMode] = useState<Mode>('share')
  const [pasted, setPasted] = useState('')
  const [error, setError] = useState<string | null>(null)

  /*
   * Signed once per choice of relays, not once per render. It used to be
   * signed afresh on every render — every keystroke in the paste field — which
   * was wasted work and a QR code that never held still. And the relay choice
   * does change shortly after unlock: which relays are reachable is not known
   * for the first second or two.
   */
  const inviteRelays = useApp((s) => s.inviteRelays)
  const invite = useMemo(() => {
    if (!identity) return null
    const secretKey = hexToBytes(identity.secretKeyHex)
    try {
      return createInvite(secretKey, {
        name: identity.name,
        relays: inviteRelays ? inviteRelays.split(' ') : fallbackRelays(),
      })
    } finally {
      wipe(secretKey)
    }
  }, [fallbackRelays, identity, inviteRelays])
  const link = invite ? inviteLink(invite) : ''

  const accept = useCallback(
    async (raw: string) => {
      setError(null)
      const payload = extractInvitePayload(raw)

      // Either a signed invite (carries a name and relay hints) or a bare
      // npub/nprofile, which carries less but is still perfectly usable.
      let parsed: { pubkey: string; name: string; relays: string[] } | null = null

      if (payload) {
        let decoded: Invite
        try {
          decoded = decodeInvite(payload)
        } catch {
          setError(pt('invalidInvite'))
          return
        }
        if (isInviteStale(decoded)) toast(pt('staleInvite'))
        parsed = { pubkey: decoded.pubkey, name: decoded.name, relays: decoded.relays }
      } else {
        const pointer = parseProfilePointer(raw)
        if (pointer) parsed = { pubkey: pointer.pubkey, name: '', relays: pointer.relays }
      }

      if (!parsed) {
        // Perhaps an ID, which only its own chunk knows how to read: a typo in one is
        // caught by its check, and said so here, before anything is looked up.
        const reading = await LAZY_CHUNKS.textorId()
          .then((chunk) => chunk.readTextorId(raw))
          .catch(() => null)
        if (reading && 'id' in reading) navigate({ name: 'textor-id', id: reading.id })
        else if (reading?.problem === 'typo') setError(pt('idTypo'))
        else setError(pt('invalidInvite'))
        return
      }
      const { pubkey, name, relays } = parsed

      if (pubkey === identity?.pubkey) {
        setError(pt('cannotAddSelf'))
        return
      }
      if (contacts.get(pubkey)?.accepted) {
        setError(t('contacts.alreadyAdded'))
        navigate({ name: 'chat', peer: pubkey })
        return
      }

      await addContact({ pubkey, name, relays, source: 'invite' })
      toast(t('contacts.added'))
      navigate({ name: 'chat', peer: pubkey })
    },
    [addContact, contacts, identity?.pubkey, navigate, pt, t, toast],
  )

  return (
    <div className="screen">
      <header className="app-header">
        <button className="btn btn-icon" aria-label={t('common.back')} onClick={() => goBack()}>
          <BackIcon />
        </button>
        <h1 className="grow">{pt('addTitle')}</h1>
      </header>

      <div className="screen-scroll">
        <div className="container stack" style={{ maxWidth: '32rem' }}>
          <p className="muted">{pt('addBody')}</p>

          <div className="row" role="tablist" style={{ gap: 'var(--space-2)' }}>
            <button
              role="tab"
              aria-selected={mode === 'share'}
              className={`btn grow ${mode === 'share' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setMode('share')}
            >
              <QrIcon size={16} />
              {pt('myInvite')}
            </button>
            <button
              role="tab"
              aria-selected={mode === 'scan'}
              className={`btn grow ${mode === 'scan' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setMode('scan')}
            >
              <CameraIcon size={16} />
              {t('contacts.scan')}
            </button>
          </div>

          {mode === 'share' && ownId ? (
            <div className="card stack-sm">
              <span className="section-title">{pt('myId')}</span>
              <IdButton id={ownId} />
            </div>
          ) : null}

          {mode === 'share' && invite ? (
            <div className="stack">
              <p className="muted small">{pt('myInviteBody')}</p>
              <Suspense fallback={<QrPlaceholder />}>
                <QrCode value={link} label={pt('myInvite')} />
              </Suspense>
              <div className="card stack-sm">
                <code className="mono small" style={{ wordBreak: 'break-all' }}>
                  {link}
                </code>
                <div className="row">
                  <CopyButton value={link} className="btn btn-outline grow" />
                  {typeof navigator !== 'undefined' && 'share' in navigator ? (
                    <button
                      className="btn btn-outline grow"
                      onClick={() => {
                        void navigator.share({ title: 'Textor', text: link }).catch(() => undefined)
                      }}
                    >
                      {t('common.add')}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          {mode === 'scan' ? (
            <div className="stack">
              <p className="muted small">{pt('scanBody')}</p>
              <Suspense fallback={<QrPlaceholder scanner />}>
                <QrScanner onResult={(text) => void accept(text)} onCancel={() => setMode('share')} />
              </Suspense>
            </div>
          ) : null}

          <div className="stack-sm">
            <span className="section-title">{pt('pasteInvite')}</span>
            <Field error={error ?? undefined}>
              <textarea
                className="textarea"
                dir="ltr"
                style={{ minHeight: '4.5rem' }}
                placeholder={pt('pastePlaceholder')}
                value={pasted}
                onChange={(event) => {
                  setPasted(event.target.value)
                  setError(null)
                }}
              />
            </Field>
            <button
              className="btn btn-primary btn-block"
              disabled={!pasted.trim()}
              onClick={() => void accept(pasted)}
            >
              {t('common.add')}
            </button>
          </div>

          <Banner tone="accent">
            <span className="small">{t('chat.verifyPromptBody')}</span>
          </Banner>
        </div>
      </div>
    </div>
  )
}
