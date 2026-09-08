import { candidateType, looksSymmetric, summarizeCandidates, type CandidateSummary } from '../models/call'

/**
 * Why a call could not connect, worked out from the ICE candidates each side
 * gathered — so the screen can say something more useful than "failed".
 *
 * Textor runs no TURN server (ADR-008), so a call connects only when the two
 * devices can reach each other directly or through a TURN server the user has
 * added. When neither works, the candidates say which side's network was in
 * the way, and whether a relay would have got through:
 *
 *  - `turn-failed`   a TURN server is configured but produced no relay
 *                    candidate: its address or credentials are wrong, or it
 *                    is down.
 *  - `blocked`       this device learned no public address at all — no STUN
 *                    answer, and no IPv6 address of its own: the network
 *                    blocks STUN, which usually means it blocks UDP. Only a
 *                    TURN server reached over TCP or TLS gets out.
 *  - `peer-blocked`  the same, on the other person's side.
 *  - `symmetric-nat` both sides learned public addresses and still could not
 *                    meet — the signature of symmetric NAT or a strict
 *                    firewall, which only a relay gets around.
 *  - `unknown`       none of the above could be established.
 */
export type IceDiagnosisKind = 'turn-failed' | 'blocked' | 'peer-blocked' | 'symmetric-nat' | 'unknown'

export interface IceDiagnosis {
  kind: IceDiagnosisKind
  local: CandidateSummary & { symmetric: boolean; ipv6: boolean }
  remote: CandidateSummary & { ipv6: boolean }
}

/**
 * An IPv6 address in global unicast space (2000::/3), less the range kept for
 * documentation. No NAT translates one, so two devices that both have one can
 * usually meet directly — the checks ICE sends from both sides open their
 * firewalls, as they do NAT bindings — whatever their IPv4 NATs do (ADR-069).
 */
const GLOBAL_IPV6 = /^(?!2001:db8:)[23][0-9a-f]{0,3}:[0-9a-f:]+$/i

/**
 * Whether this device, or the other, has an address on the IPv6 internet: a
 * host candidate in global space — real once the microphone is allowed, as it
 * is for any call — or a STUN answer there. A relay's address is the TURN
 * server's, not the device's.
 */
export function hasPublicIpv6(candidates: readonly string[]): boolean {
  return candidates.some((candidate) => {
    const address = candidate.replace(/^candidate:/, '').split(/\s+/)[4] ?? ''
    return candidateType(candidate) !== 'relay' && GLOBAL_IPV6.test(address)
  })
}

/** An address others can reach: one a STUN server saw, or the device's own on the IPv6 internet. */
export const hasPublicAddress = (candidates: readonly string[]): boolean =>
  summarizeCandidates(candidates).srflx || hasPublicIpv6(candidates)

export function diagnoseIce(input: {
  local: readonly string[]
  remote: readonly string[]
  turnConfigured: boolean
}): IceDiagnosis {
  const local = {
    ...summarizeCandidates(input.local),
    symmetric: looksSymmetric(input.local),
    ipv6: hasPublicIpv6(input.local),
  }
  const remote = { ...summarizeCandidates(input.remote), ipv6: hasPublicIpv6(input.remote) }
  const kind: IceDiagnosisKind =
    input.turnConfigured && !local.relay
      ? 'turn-failed'
      : !local.srflx && !local.ipv6 && !local.relay
        ? 'blocked'
        : !remote.srflx && !remote.ipv6 && !remote.relay
          ? 'peer-blocked'
          : local.symmetric || (!local.relay && !remote.relay)
            ? 'symmetric-nat'
            : 'unknown'
  return { kind, local, remote }
}

/** The `a=candidate:` lines of a session description, as candidate strings. */
export function candidatesInSdp(sdp: string): string[] {
  const out: string[] = []
  for (const match of sdp.matchAll(/^a=(candidate:[^\r\n]+)/gm)) out.push(match[1] as string)
  return out
}
