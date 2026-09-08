/**
 * Making something to send: preparing a picked photo, video, file or sticker,
 * and recording a voice note — loaded when a file is picked or the microphone is
 * pressed (ADR-060). Reading and answering a message needs neither, and the
 * shell keeps only the check that decides whether to offer the microphone.
 * See `src/ui/lazyViews.tsx`.
 */
export { prepareAttachment } from '../../media/attach'
export { prepareImage, STICKER_EDGE } from '../../media/image'
export { VoiceRecorder } from '../../media/recorder'
