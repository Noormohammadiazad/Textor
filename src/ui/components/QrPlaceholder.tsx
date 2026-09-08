/**
 * The space a QR code or the camera viewfinder will occupy, held while the QR
 * chunk loads, so the invite text and buttons below do not jump when it
 * arrives.
 */
export function QrPlaceholder({ scanner = false }: { scanner?: boolean }) {
  if (scanner) return <div className="scanner-frame" aria-hidden="true" />
  return (
    <div className="qr-frame" aria-hidden="true">
      <span className="qr-pending-square" />
    </div>
  )
}
