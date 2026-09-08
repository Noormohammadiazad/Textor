/**
 * What the shell and the call chunk need of WebRTC, apart from the direct
 * channel, which is a lazy chunk of its own (ADR-073).
 */

export const supportsWebRtc = (): boolean => typeof globalThis.RTCPeerConnection === 'function'

/** Pull `a=fingerprint:sha-256 AB:CD:...` out of an SDP blob. */
export function extractFingerprint(sdp: string): string | null {
  const match = sdp.match(/^a=fingerprint:(\S+)\s+(\S+)/m)
  return match ? `${match[1]} ${match[2]}` : null
}
