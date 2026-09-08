/**
 * Making something to send: re-encoding a picture or a video's poster, and
 * recording a voice note — loaded when a file is picked or the microphone is
 * pressed (ADR-060). Reading and answering a message needs neither, and the
 * shell keeps only the check that decides whether to offer the microphone.
 * See `src/ui/lazyViews.tsx`.
 */
export { audioDuration, kindForFile, prepareImage, prepareVideoPoster } from '../../media/image'
export { VoiceRecorder } from '../../media/recorder'
