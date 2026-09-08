import { useApp } from '../../app/store'
import { useNavigate } from '../../app/router'
import { useI18n } from '../../i18n'
import { isGroupAddress } from '../../core/models/types'
import { conversationTitle, displayName } from '../screens/ChatList'
import { useLocationText } from './locationText'

/**
 * The bar Telegram shows while you share where you are (ADR-064): at the top
 * of the list, naming where it goes, and at the top of each conversation it
 * goes to — with the way to stop it one tap away, wherever you are. Sharing
 * something as personal as a position must never be easy to forget.
 */
export function LiveBanner({ address }: { address?: string }) {
  const text = useLocationText()
  const { locale } = useI18n()
  const navigate = useNavigate()
  const shares = useApp((s) => s.liveShares)
  const stopSharing = useApp((s) => s.stopSharing)
  const contacts = useApp((s) => s.contacts)
  const conversations = useApp((s) => s.conversations)
  const here = address ? shares.filter((share) => share.address === address) : shares
  const first = here[0]
  if (!first) return null

  const nameOf = (to: string): string => {
    if (!isGroupAddress(to)) return displayName(contacts.get(to), to)
    const conversation = conversations.find((candidate) => candidate.id === to)
    return conversation ? conversationTitle(conversation, contacts, locale) : ''
  }
  const label = address
    ? text('sharingHere')
    : here.length === 1
      ? text('sharingWith', { name: nameOf(first.address) })
      : text('sharingIn', { n: here.length })

  return (
    <div className="live-banner" role="status">
      <span className="live-banner-dot" aria-hidden="true" />
      {address || here.length > 1 ? (
        <span className="grow live-banner-text">{label}</span>
      ) : (
        <button
          type="button"
          className="grow live-banner-text live-banner-link"
          onClick={() =>
            navigate(
              isGroupAddress(first.address)
                ? { name: 'group', id: first.address }
                : { name: 'chat', peer: first.address },
            )
          }
        >
          {label}
        </button>
      )}
      <button
        type="button"
        className="btn btn-ghost small danger-text"
        onClick={() => {
          for (const share of here) void stopSharing(share.id)
        }}
      >
        {text('stop')}
      </button>
    </div>
  )
}
