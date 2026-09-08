import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Mirror the build-time constants Vite injects, so modules that report the
  // app version import cleanly under test.
  define: {
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
    __BUILD_TIME__: JSON.stringify('1970-01-01T00:00:00.000Z'),
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/core/**/*.ts'],
      exclude: ['src/core/**/*.worker.ts'],
      reporter: [['text', { skipFull: true }], 'html'],
      // Forward-secret groups, inbox sync, attachment transfer, every way the
      // vault opens, the order a conversation is shown in, and where anyone is
      // are held to every line and branch: a gap there is a path through the
      // protocol, into someone's messages, out of the order things were said,
      // or to a position shared longer or wider than meant, that nobody has run.
      thresholds: {
        'src/core/mls/**': { 100: true },
        'src/core/engine/inboxSync.ts': { 100: true },
        'src/core/transport/negentropy.ts': { 100: true },
        'src/core/engine/blobTransfer.ts': { 100: true },
        'src/core/crypto/blobCrypto.ts': { 100: true },
        'src/core/vault/vault.ts': { 100: true },
        'src/core/vault/keyslots.ts': { 100: true },
        'src/core/vault/exportImport.ts': { 100: true },
        'src/core/crypto/biometricGate.ts': { 100: true },
        'src/core/crypto/biometricEnrol.ts': { 100: true },
        'src/core/models/timeline.ts': { 100: true },
        'src/core/models/location.ts': { 100: true },
        'src/core/location/**': { 100: true },
      },
    },
  },
})
