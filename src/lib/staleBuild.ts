/**
 * Reload a tab that is running a build the server no longer serves.
 *
 * The wallet is a single page app with no caching service worker, so a tab left open across a
 * deploy keeps running the OLD bundle until it is reloaded. On staging 2026-11-02 that is how
 * corda's re-granted licence 4de7f5b0 was burnt: an Android tab still on a pre-v0.46.5 bundle ran
 * the old self-lock sweep (no licence guard) a minute after receiving the grant.
 *
 * The cheapest proof that a newer build is live is a lazy chunk that 404s: Vite hashes chunk names,
 * a deploy removes the old ones, and Vite fires `vite:preloadError` when a dynamic import fails.
 * We reload then, once per build per session, so a genuinely broken chunk cannot loop.
 */
const RELOADED_KEY = 'imani.staleBuild.reloadedFor'

export interface StaleBuildPorts {
  addEventListener: (type: string, fn: (event: Event) => void) => void
  reload: () => void
  storage: Pick<Storage, 'getItem' | 'setItem'>
  buildId: string
}

export function installStaleBuildReload(ports: StaleBuildPorts): void {
  ports.addEventListener('vite:preloadError', (event) => {
    try {
      if (ports.storage.getItem(RELOADED_KEY) === ports.buildId) return
      ports.storage.setItem(RELOADED_KEY, ports.buildId)
    } catch {
      // No storage: still reload. A loop needs a broken chunk AND no storage.
    }
    event.preventDefault()
    ports.reload()
  })
}
