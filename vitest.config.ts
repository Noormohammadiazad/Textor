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
      include: [
        'src/core/**/*.ts',
        'src/ui/screens/ContactDetail.tsx',
        'src/ui/screens/InviteScreen.tsx',
        'src/ui/screens/TextorIdScreen.tsx',
        'src/ui/screens/peopleText.ts',
        'src/ui/screens/textorIdText.ts',
      ],
      exclude: ['src/core/**/*.worker.ts'],
      reporter: [['text', { skipFull: true }], 'html'],
      // Forward-secret groups, inbox sync, attachment transfer, every way the
      // vault opens, the order a conversation is shown in, where anyone is,
      // which relays carry the mail, and how a call finds its way through are
      // held to every line and branch: a gap there is a path through the
      // protocol, into someone's messages, out of the order things were said,
      // to a position shared longer or wider than meant, to an inbox read from
      // nowhere, or to an address given to a server nobody asked, that nobody
      // has run.
      thresholds: {
        'src/core/mls/**': { 100: true },
        'src/core/engine/inboxSync.ts': { 100: true },
        'src/core/engine/deviceSync.ts': { 100: true },
        'src/core/engine/deviceRoster.ts': { 100: true },
        'src/core/engine/deletionLog.ts': { 100: true },
        'src/core/engine/profileRecord.ts': { 100: true },
        'src/core/identity/**': { 100: true },
        'src/ui/screens/ContactDetail.tsx': { 100: true },
        'src/ui/screens/InviteScreen.tsx': { 100: true },
        'src/ui/screens/TextorIdScreen.tsx': { 100: true },
        'src/ui/screens/peopleText.ts': { 100: true },
        'src/ui/screens/textorIdText.ts': { 100: true },
        'src/core/crypto/giftwrap.ts': { 100: true },
        'src/core/transport/negentropy.ts': { 100: true },
        'src/core/engine/blobTransfer.ts': { 100: true },
        'src/core/engine/blobDrop.ts': { 100: true },
        'src/core/models/attachment.ts': { 100: true },
        'src/core/crypto/blobCrypto.ts': { 100: true },
        'src/core/vault/vault.ts': { 100: true },
        'src/core/vault/keyslots.ts': { 100: true },
        'src/core/vault/exportImport.ts': { 100: true },
        'src/core/crypto/biometricGate.ts': { 100: true },
        'src/core/crypto/biometricEnrol.ts': { 100: true },
        'src/core/models/timeline.ts': { 100: true },
        'src/core/models/location.ts': { 100: true },
        'src/core/location/**': { 100: true },
        'src/core/transport/relayPool.ts': { 100: true },
        'src/core/transport/relayScore.ts': { 100: true },
        'src/core/transport/relayHealth.ts': { 100: true },
        'src/core/transport/relayScout.ts': { 100: true },
        'src/core/transport/defaultRelays.ts': { 100: true },
        'src/core/calls/**': { 100: true },
      },
    },
  },
})
