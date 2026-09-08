/**
 * What a conversation opens only when asked: the list to forward to, and a
 * message's details (ADR-061). Neither is needed to read or answer a message.
 * See `src/ui/lazyViews.tsx`.
 */
import '../conversation/conversation.css'
export { ForwardSheet } from '../conversation/ForwardSheet'
export { MessageInfo } from '../conversation/MessageInfo'
