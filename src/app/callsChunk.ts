/**
 * The one way into the calling subsystem: peer connections, cameras, the
 * in-call screen and its styles, all behind this `import()`.
 *
 * Deliberately not in `LAZY_CHUNKS`. That table is fetched in the background
 * after start-up so the app is complete offline; calls load only when a call
 * is placed or an offer rings (ADR-046). A call needs the network by
 * definition, so an offline session has nothing to gain from having it cached.
 */
export const loadCallsChunk = () => import('../ui/chunks/calls')
