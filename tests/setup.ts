import 'fake-indexeddb/auto'

// The vault talks to WebCrypto for randomness and to structuredClone through
// Dexie; Node 20+ provides both natively, so nothing else needs shimming.
