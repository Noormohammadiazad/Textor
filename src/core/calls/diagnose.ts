import { looksSymmetric, summarizeCandidates, type CandidateSummary } from '../models/call'

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
 *  - `blocked`       this device learned no public address at all: the
 *                    network blocks STUN, which usually means it blocks UDP.
 *                    Only a TURN server reached over TCP or TLS gets out.
 *  - `peer-blocked`  the same, on the other person's side.
 *  - `symmetric-nat` both sides learned public addresses and still could not
 *                    meet — the signature of symmetric NAT or a strict
 *                    firewall, which only a relay gets around.
 *  - `unknown`       none of the above could be established.
 */
export type IceDiagnosisKind = 'turn-failed' | 'blocked' | 'peer-blocked' | 'symmetric-nat' | 'unknown'

export interface IceDiagnosis {
  kind: IceDiagnosisKind
  local: CandidateSummary & { symmetric: boolean }
  remote: CandidateSummary
}

export function diagnoseIce(input: {
  local: readonly string[]
  remote: readonly string[]
  turnConfigured: boolean
}): IceDiagnosis {
  const local = { ...summarizeCandidates(input.local), symmetric: looksSymmetric(input.local) }
  const remote = summarizeCandidates(input.remote)
  const kind: IceDiagnosisKind =
    input.turnConfigured && !local.relay
      ? 'turn-failed'
      : !local.srflx && !local.relay
        ? 'blocked'
        : !remote.srflx && !remote.relay
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
