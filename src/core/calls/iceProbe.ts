import { candidateType, hasTurnServer, looksSymmetric, summarizeCandidates } from '../models/call'
import type { TurnOutcome } from './turn'

/**
 * Test the network the way a call would use it, without calling anyone.
 *
 * A peer connection is opened with the configured servers and nobody on the
 * other end; gathering its candidates asks each STUN server for this device's
 * public address and each TURN server for a relay, which is everything a call
 * needs from them. Nothing is sent to any contact. Only Settings runs it, when
 * asked to.
 */

export type IceVerdict = 'good' | 'stun' | 'symmetric' | 'none' | 'turn-failed'

export interface IceProbeResult {
  verdict: IceVerdict
  /** A public address was learned. */
  stun: boolean
  /** A relay was allocated; null when no TURN server is configured. */
  turn: boolean | null
  /** The public ports differ by destination, the mark of symmetric NAT. */
  symmetric: boolean
  /**
   * This device has an address on the IPv6 internet. Without camera or
   * microphone permission the browser hides its own addresses, but a STUN
   * server reached over IPv6 still reports the address back (ADR-069).
   */
  ipv6: boolean
  /** What each TURN server did, by the address the browser reported it under. */
  relays: TurnOutcome[]
}

const PROBE_TIMEOUT_MS = 8000

export async function probeIce(
  servers: RTCIceServer[],
  opts: { createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection; timeoutMs?: number } = {},
): Promise<IceProbeResult> {
  const create = opts.createPeerConnection ?? ((config: RTCConfiguration) => new RTCPeerConnection(config))
  const pc = create({ iceServers: servers })
  const candidates: string[] = []
  const relays = new Map<string, { ms: number } | { error: number }>()
  const startedAt = Date.now()
  try {
    const done = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, opts.timeoutMs ?? PROBE_TIMEOUT_MS)
      pc.onicecandidate = (event) => {
        const found = event.candidate
        if (!found?.candidate) {
          clearTimeout(timer)
          resolve()
          return
        }
        candidates.push(found.candidate)
        const url = (found as { url?: string | null }).url ?? (event as { url?: string | null }).url
        if (url && candidateType(found.candidate) === 'relay') relays.set(url, { ms: Date.now() - startedAt })
      }
      // A server may fail over one address family and succeed over the
      // other: a relay found is the last word.
      pc.onicecandidateerror = (event) => {
        const known = relays.get(event.url)
        if (!/^turns?:/i.test(event.url) || (known && 'ms' in known)) return
        // A STUN error code, or 0 — no answer — for the browser's own 7xx codes.
        relays.set(event.url, {
          error: event.errorCode >= 300 && event.errorCode < 700 ? event.errorCode : 0,
        })
      }
    })
    // A data channel is the cheapest thing that gives the offer a transport
    // to gather candidates for; no camera or microphone is involved.
    pc.createDataChannel('probe')
    await pc.setLocalDescription(await pc.createOffer())
    await done
  } finally {
    pc.onicecandidate = null
    pc.onicecandidateerror = null
    pc.close()
  }
  return {
    ...judge(candidates, hasTurnServer(servers)),
    relays: [...relays].map(([url, o]) => ({ url, ...o })),
  }
}

export function judge(
  candidates: readonly string[],
  turnConfigured: boolean,
): Omit<IceProbeResult, 'relays'> {
  const found = summarizeCandidates(candidates)
  const symmetric = looksSymmetric(candidates)
  const turn = turnConfigured ? found.relay : null
  const verdict: IceVerdict =
    turn === false ? 'turn-failed' : turn ? 'good' : !found.srflx ? 'none' : symmetric ? 'symmetric' : 'stun'
  // The rule of `hasPublicIpv6` in ./diagnose, which this chunk does not load.
  const ipv6 = candidates.some(
    (candidate) =>
      candidateType(candidate) !== 'relay' &&
      /^(?!2001:db8:)[23][0-9a-f]{0,3}:[0-9a-f:]+$/i.test(
        candidate.replace(/^candidate:/, '').split(/\s+/)[4] ?? '',
      ),
  )
  return { verdict, stun: found.srflx, turn, symmetric, ipv6 }
}
