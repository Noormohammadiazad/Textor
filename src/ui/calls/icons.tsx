import { Icon, type IconProps } from '../components/Icons'

/*
 * Icons only the in-call screen draws, so they ship in the call chunk. None
 * is directional: a microphone or a camera means the same thing whichever
 * way the page reads, so none is mirrored in Persian.
 */

export const MicIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4M8 22h8" />
  </Icon>
)

export const MicOffIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m2 2 20 20M9 9v2a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.68-1.34" />
    <path d="M17 16.95A7 7 0 0 1 5 11v-1m14 0v1a7 7 0 0 1-.11 1.23M12 18v4M8 22h8" />
  </Icon>
)

export const VideoOffIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m2 2 20 20M10.66 6H14a2 2 0 0 1 2 2v2.34l1 1L22 8v8M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2" />
  </Icon>
)

export const HangUpIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10.7 13.3a16 16 0 0 0 3.4 2.6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.9.6 2.8.7a2 2 0 0 1 1.7 2v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.4 19.4 0 0 1-3.3-2.6M5.3 12.7a19.8 19.8 0 0 1-3.2-8.5A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.9.7 2.8a2 2 0 0 1-.4 2.1L8.1 9.9" />
    <path d="M22 2 2 22" />
  </Icon>
)

export const FlipCameraIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M11 19H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5M13 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5" />
    <circle cx="12" cy="12" r="3" />
    <path d="m18 22-3-3 3-3M6 2l3 3-3 3" />
  </Icon>
)

export const ScreenShareIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3M8 21h8M12 17v4M17 8l5-5M17 3h5v5" />
  </Icon>
)

export const MinimizeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
  </Icon>
)
