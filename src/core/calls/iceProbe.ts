import { hasTurnServer, looksSymmetric, summarizeCandidates } from '../models/call'

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
}

const PROBE_TIMEOUT_MS = 8000

export async function probeIce(
  servers: RTCIceServer[],
  opts: { createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection; timeoutMs?: number } = {},
): Promise<IceProbeResult> {
  const create = opts.createPeerConnection ?? ((config: RTCConfiguration) => new RTCPeerConnection(config))
  const pc = create({ iceServers: servers })
  const candidates: string[] = []
  try {
    const done = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, opts.timeoutMs ?? PROBE_TIMEOUT_MS)
      pc.onicecandidate = (event) => {
        if (event.candidate?.candidate) candidates.push(event.candidate.candidate)
        else {
          clearTimeout(timer)
          resolve()
        }
      }
    })
    // A data channel is the cheapest thing that gives the offer a transport
    // to gather candidates for; no camera or microphone is involved.
    pc.createDataChannel('probe')
    await pc.setLocalDescription(await pc.createOffer())
    await done
  } finally {
    pc.onicecandidate = null
    pc.close()
  }
  return judge(candidates, hasTurnServer(servers))
}

export function judge(candidates: readonly string[], turnConfigured: boolean): IceProbeResult {
  const found = summarizeCandidates(candidates)
  const symmetric = looksSymmetric(candidates)
  const turn = turnConfigured ? found.relay : null
  const verdict: IceVerdict =
    turn === false ? 'turn-failed' : turn ? 'good' : !found.srflx ? 'none' : symmetric ? 'symmetric' : 'stun'
  return { verdict, stun: found.srflx, turn, symmetric }
}
