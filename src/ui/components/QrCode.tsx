import { useEffect, useMemo, useRef, useState } from 'react'
import encodeQR from 'qr'
import { frameLoop, frontalCamera, QRCanvas } from 'qr/dom.js'
import { useT } from '../../i18n'
import { Banner } from './primitives'
import { createLogger } from '../../core/util/log'

const log = createLogger('qr')

/**
 * QR rendering, done locally.
 *
 * Every hosted QR generator would mean sending an invite — which contains a
 * public key and relay hints — to a third party. The `qr` package encodes in
 * a few kilobytes of dependency-free JavaScript, so there is no reason to.
 */
export function QrCode({ value, label }: { value: string; label?: string }) {
  const svg = useMemo(() => {
    try {
      // Error level M survives a fingerprint or a slight fold and still scans.
      return encodeQR(value, 'svg', { ecc: 'medium', border: 2 })
    } catch (err) {
      log.warn('failed to encode QR', err)
      return null
    }
  }, [value])

  if (!svg) return null
  return (
    <div className="qr-frame" role="img" aria-label={label ?? 'QR code'}>
      <div dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  )
}

export type ScanState = 'idle' | 'starting' | 'scanning' | 'denied' | 'unavailable'

/**
 * Camera-based QR scanner.
 *
 * Frames never leave the page: they are decoded in JavaScript from a canvas.
 * The stream is stopped on unmount, on a successful scan, and when the tab is
 * hidden — a camera left running in a background tab is exactly the kind of
 * thing a privacy app must not do.
 */
export function QrScanner({
  onResult,
  onCancel,
}: {
  onResult: (text: string) => void
  onCancel: () => void
}) {
  const t = useT()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [state, setState] = useState<ScanState>('starting')

  useEffect(() => {
    let cancelled = false
    let stop: (() => void) | null = null
    let camera: Awaited<ReturnType<typeof frontalCamera>> | null = null
    // Frames are drawn into an offscreen canvas and decoded there; nothing is
    // uploaded and no preview canvas is attached to the DOM.
    const canvas = new QRCanvas()

    const start = async () => {
      const video = videoRef.current
      if (!video) return
      if (!navigator.mediaDevices?.getUserMedia) {
        setState('unavailable')
        return
      }
      try {
        camera = await frontalCamera(video)
        if (cancelled) {
          camera.stop()
          return
        }
        setState('scanning')
        stop = frameLoop(() => {
          if (cancelled || !camera) return
          try {
            const result = camera.readFrame(canvas)
            if (result) {
              cancelled = true
              onResult(result)
            }
          } catch {
            // A frame with no readable code throws; that is the normal case.
          }
        })
      } catch (err) {
        log.info('camera unavailable', err)
        setState(err instanceof DOMException && err.name === 'NotAllowedError' ? 'denied' : 'unavailable')
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        stop?.()
        camera?.stop()
        camera = null
        stop = null
      }
    }

    void start()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      stop?.()
      camera?.stop()
      canvas.clear()
    }
  }, [onResult])

  return (
    <div className="stack">
      <div className="scanner-frame">
        <video ref={videoRef} playsInline muted aria-label={t('contacts.scan')} />
        {state === 'scanning' ? <div className="scanner-reticle" /> : null}
      </div>
      {state === 'denied' ? <Banner tone="warning">{t('contacts.cameraDenied')}</Banner> : null}
      {state === 'unavailable' ? <Banner tone="warning">{t('contacts.cameraUnavailable')}</Banner> : null}
      {state === 'starting' ? <p className="muted center small">{t('common.loading')}…</p> : null}
      <button type="button" className="btn btn-outline btn-block" onClick={onCancel}>
        {t('common.cancel')}
      </button>
    </div>
  )
}
