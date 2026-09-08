import { useEffect, useState } from 'react'

/**
 * The time, kept current every `everyMs` while it is asked for — a countdown
 * and an "updated 2 minutes ago" go stale otherwise — and not at all once
 * `everyMs` is null, when nothing on screen is moving.
 */
export function useNow(everyMs: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (everyMs === null) return
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}
