import { schnorr } from '@noble/curves/secp256k1.js'
import { getEventHash } from 'nostr-tools/pure'
import { hexToBytes, isHex32 } from '../util/bytes'

/**
 * Verify an event signature from first principles.
 *
 * nostr-tools' `verifyEvent` memoises its answer on the event object under a
 * symbol key. That is a sensible optimisation for events the library itself
 * produced or checked, but symbol properties survive object spread and
 * structured clone, so an object carrying a stale `true` would skip
 * verification entirely. Anything reaching this module may have come from a
 * relay, a peer, or a decrypted blob, so it recomputes every time.
 */
export function verifyEventSignature(event: {
  id?: unknown
  sig?: unknown
  pubkey?: unknown
  kind?: unknown
  content?: unknown
  created_at?: unknown
  tags?: unknown
}): boolean {
  if (!isHex32(event.pubkey) || typeof event.sig !== 'string' || !/^[0-9a-f]{128}$/.test(event.sig)) {
    return false
  }
  if (typeof event.kind !== 'number' || typeof event.content !== 'string') return false
  if (typeof event.created_at !== 'number' || !Array.isArray(event.tags)) return false
  try {
    const hash = getEventHash({
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags as string[][],
      content: event.content,
    })
    if (typeof event.id === 'string' && event.id !== hash) return false
    return schnorr.verify(hexToBytes(event.sig), hexToBytes(hash), hexToBytes(event.pubkey))
  } catch {
    return false
  }
}
