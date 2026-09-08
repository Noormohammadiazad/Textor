/**
 * What `virtual:pwa-register/react` gives the shell, which only the build makes:
 * a service worker that never has anything newer, so the shell imports under test.
 */
export function useRegisterSW(): {
  needRefresh: [boolean, (value: boolean) => void]
  offlineReady: [boolean, (value: boolean) => void]
  updateServiceWorker: (reload?: boolean) => Promise<void>
} {
  return {
    needRefresh: [false, () => undefined],
    offlineReady: [false, () => undefined],
    updateServiceWorker: async () => undefined,
  }
}
