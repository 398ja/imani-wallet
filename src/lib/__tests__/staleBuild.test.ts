import { describe, expect, it, vi } from 'vitest'
import { installStaleBuildReload } from '../staleBuild'

function harness(buildId = 'build-a') {
  const listeners = new Map<string, (e: Event) => void>()
  const store = new Map<string, string>()
  const reload = vi.fn()
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
  const install = (id = buildId) =>
    installStaleBuildReload({ addEventListener: (t, fn) => void listeners.set(t, fn), reload, storage, buildId: id })
  const fire = () => {
    const e = new Event('vite:preloadError', { cancelable: true })
    listeners.get('vite:preloadError')?.(e)
    return e
  }
  return { install, fire, reload }
}

describe('stale build reload (staging 2026-11-02: an old tab burnt a licence)', () => {
  it('reloads when a lazy chunk of this build is gone from the server', () => {
    const h = harness()
    h.install()
    const e = h.fire()
    expect(h.reload).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(true)
  })

  it('reloads only once per build, so a broken chunk cannot loop', () => {
    const h = harness()
    h.install()
    h.fire()
    h.install()
    h.fire()
    expect(h.reload).toHaveBeenCalledTimes(1)
  })

  it('reloads again after a later deploy strands the new build too', () => {
    const h = harness()
    h.install('build-a')
    h.fire()
    h.install('build-b')
    h.fire()
    expect(h.reload).toHaveBeenCalledTimes(2)
  })
})
