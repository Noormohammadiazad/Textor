/**
 * Calling, as one lazy chunk: the engine side and the screen together, since
 * one is never needed without the other. Loaded through
 * `src/app/callsChunk.ts` only — see there for why it is not warmed.
 */
export { createCallManager } from '../../core/calls/browserCalls'
export { CallOverlay } from '../calls/CallOverlay'
