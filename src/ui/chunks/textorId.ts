/**
 * Finding someone by their ID, as one lazy chunk (ADR-081), with all that reads or
 * works out what one is. Never on the path from a cold start to a message. See
 * `src/ui/lazyViews.tsx`.
 */
export { TextorIdScreen } from '../screens/TextorIdScreen'
export { readTextorId } from '../../core/identity/textorId'
