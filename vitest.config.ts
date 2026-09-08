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
      reporter: ['text', 'html'],
    },
  },
})
