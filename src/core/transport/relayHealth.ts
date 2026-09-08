import type { RelayStatus } from './relayPool'

export type RelayVerdict = 'healthy' | 'degraded' | 'offline' | 'unused'

/**
 * Reduce rolling relay counters to one of four words.
 *
 * Blunt on purpose. Someone looking at the relay panel is answering a single
 * question — "are my messages actually going anywhere?" — and a nuanced score
 * does not help them decide whether to remove a relay.
 *
 * The case that matters most is `degraded`: relays that connect and serve reads
 * happily but reject publishes from unknown keys (web-of-trust or NIP-05 gates)
 * look perfectly fine until you notice the publish failures.
 */
export function verdictFor(status: RelayStatus | undefined): RelayVerdict {
  if (!status) return 'unused'
  const { health, state } = status
  const attempts = health.publishOk + health.publishFail
  if (attempts === 0 && health.connectOk === 0 && health.connectFail === 0 && health.readFail === 0) {
    return 'unused'
  }
  // A refused subscription is decisive: this relay will never bring us mail,
  // however well it accepts what we publish. Checked before the publish stats
  // precisely because those would otherwise report it as healthy.
  if (health.readFail > 0) return 'degraded'
  if (state === 'offline' && health.publishOk === 0) return 'offline'
  if (attempts > 0 && health.publishOk / attempts < 0.5) return 'degraded'
  if (state === 'online' || health.publishOk > 0) return 'healthy'
  return 'degraded'
}
