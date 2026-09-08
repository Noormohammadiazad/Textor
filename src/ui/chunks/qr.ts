/**
 * QR encoding and scanning, as a lazy chunk.
 *
 * The `qr` package is the largest single dependency the app has after Dexie,
 * and it is only ever used to show or read an invite or a safety number.
 * See `src/ui/lazyViews.tsx`.
 */
export { QrCode, QrScanner } from '../components/QrCode'
