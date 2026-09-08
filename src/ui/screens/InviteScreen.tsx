import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../../app/store'
import { useT } from '../../i18n'
import { useNavigate } from '../../app/router'
import { Avatar, Banner } from '../components/primitives'
import { decodeInvite, isInviteStale, type Invite } from '../../core/identity/invite'
import { shortNpub, toNpub } from '../../core/identity/keys'
import { relayLabel } from '../../core/transport/relayUrl'

/**
 * Landing screen for `#/i/<payload>` links.
 *
 * The payload lives in the URL fragment, which the browser never sends to the
 * web server — so following an invite link reveals nothing to whoever hosts
 * the app, only to whoever you got the link from.
 */
export function InviteScreen({ payload }: { payload: string }) {
  const t = useT()
  const navigate = useNavigate()
  const identity = useApp((s) => s.identity)
  const contacts = useApp((s) => s.contacts)
  const addContact = useApp((s) => s.addContact)
  const toast = useApp((s) => s.toast)
  const [busy, setBusy] = useState(false)

  const decoded = useMemo<{ invite: Invite } | { error: string }>(() => {
    try {
      return { invite: decodeInvite(payload) }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }, [payload])

  // Strip the invite out of the address bar once handled, so it does not sit in
  // history or get re-shared by accident.
  useEffect(() => {
    if ('error' in decoded) return
    if (decoded.invite.pubkey === identity?.pubkey) navigate({ name: 'chats' }, true)
  }, [decoded, identity?.pubkey, navigate])

  if ('error' in decoded) {
    return (
      <div className="screen-scroll">
        <div className="container stack">
          <Banner tone="danger">{t('contacts.invalidInvite')}</Banner>
          <button className="btn btn-outline btn-block" onClick={() => navigate({ name: 'chats' }, true)}>
            {t('common.close')}
          </button>
        </div>
      </div>
    )
  }

  const { invite } = decoded
  const existing = contacts.get(invite.pubkey)
  const name = invite.name || shortNpub(toNpub(invite.pubkey))

  const accept = async () => {
    setBusy(true)
    try {
      await addContact({
        pubkey: invite.pubkey,
        name: invite.name,
        relays: invite.relays,
        source: 'invite',
      })
      toast(t('contacts.added'))
      navigate({ name: 'chat', peer: invite.pubkey }, true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="screen-scroll">
      <div className="container stack center" style={{ maxWidth: '28rem', paddingBlock: 'var(--space-6)' }}>
        <div style={{ display: 'grid', placeItems: 'center' }}>
          <Avatar name={name} seed={invite.pubkey} size="lg" />
        </div>
        <h1 style={{ fontSize: 'var(--step-2)' }}>{name}</h1>
        <code className="mono faint" style={{ wordBreak: 'break-all' }}>
          {toNpub(invite.pubkey)}
        </code>

        {invite.relays.length > 0 ? (
          <p className="faint">{invite.relays.map(relayLabel).join(' · ')}</p>
        ) : null}

        {isInviteStale(invite) ? <Banner tone="warning">{t('contacts.staleInvite')}</Banner> : null}

        {existing?.accepted ? (
          <>
            <Banner tone="accent">{t('contacts.alreadyAdded')}</Banner>
            <button
              className="btn btn-primary btn-block"
              onClick={() => navigate({ name: 'chat', peer: invite.pubkey }, true)}
            >
              {t('nav.chats')}
            </button>
          </>
        ) : (
          <button className="btn btn-primary btn-block" disabled={busy} onClick={() => void accept()}>
            {t('contacts.add')}
          </button>
        )}

        <button className="btn btn-ghost btn-block" onClick={() => navigate({ name: 'chats' }, true)}>
          {t('common.cancel')}
        </button>

        <Banner tone="accent">
          <span className="small">{t('chat.verifyPromptBody')}</span>
        </Banner>
      </div>
    </div>
  )
}
