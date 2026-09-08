import type { Messenger } from '../engine/messenger'
import { DEFAULT_ICE_SERVERS } from '../transport/defaultRelays'
import type { VaultRepo } from '../vault/repo'
import { CallManager } from './callManager'
import { browserMedia } from './media'
import { browserVoice } from './voiceAudio'

/** A call manager wired to the running engine, the vault and the browser's own WebRTC. */
export function createCallManager(
  messenger: Messenger,
  repo: Pick<VaultRepo, 'getState' | 'putState'>,
): CallManager {
  const media = browserMedia()
  return new CallManager({
    self: messenger.pubkey,
    signal: (peer, frame) => messenger.sendCallSignal(peer, frame),
    record: (peer, id, direction, record, at) => messenger.recordCall(peer, id, direction, record, at),
    handled: (peer, id) => messenger.noteCallHandled(id, peer),
    // The public STUN defaults, then the user's own servers (ADR-046).
    config: () => ({
      iceServers: [...DEFAULT_ICE_SERVERS, ...messenger.settings.iceServers],
      relayOnly: messenger.settings.callRelayOnly,
    }),
    store: repo,
    // A chunk of its own, shared with Settings: imported by either, it would
    // be hoisted into a chunk the shell precaches (ADR-068).
    turn: () => import('./turn'),
    voice: { pool: messenger.pool, platform: browserVoice(media) },
    createPeerConnection: (config) => new RTCPeerConnection(config),
    createStream: (tracks) => new MediaStream(tracks),
    media,
  })
}
