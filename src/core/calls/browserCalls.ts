import type { Messenger } from '../engine/messenger'
import { CallManager } from './callManager'
import { browserMedia } from './media'

/** A call manager wired to the running engine and the browser's own WebRTC. */
export function createCallManager(messenger: Messenger): CallManager {
  return new CallManager({
    self: messenger.pubkey,
    signal: (peer, frame) => messenger.sendCallSignal(peer, frame),
    record: (peer, id, direction, record, at) => messenger.recordCall(peer, id, direction, record, at),
    config: () => messenger.callConfig(),
    createPeerConnection: (config) => new RTCPeerConnection(config),
    createStream: (tracks) => new MediaStream(tracks),
    media: browserMedia(),
  })
}
