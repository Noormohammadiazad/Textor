/**
 * Adding someone and looking at them: showing, scanning or pasting an invite,
 * the landing page an invite link opens, and a contact's own page — as one
 * lazy chunk (ADR-058). None is on the path from a cold start to answering a
 * message; the contact list itself stays in the shell. See
 * `src/ui/lazyViews.tsx`.
 */
export { AddContact } from '../screens/AddContact'
export { ContactDetail } from '../screens/ContactDetail'
export { InviteScreen } from '../screens/InviteScreen'
