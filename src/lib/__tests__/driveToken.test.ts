/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ value: false }))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => native.value } }))

import { DriveError, NATIVE_UNSUPPORTED, TOKEN_TIMEOUT_MS, putBackup } from '../drive'

describe('drive access token', () => {
  const requestAccessToken = vi.fn()
  const initTokenClient = vi.fn(() => ({ requestAccessToken }))

  beforeEach(() => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'test-client')
    window.google = { accounts: { oauth2: { initTokenClient } } }
    native.value = false
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    delete window.google
  })

  it('fails fast in the native app instead of opening a GIS popup that never returns', async () => {
    native.value = true
    await expect(putBackup('{}')).rejects.toThrow(NATIVE_UNSUPPORTED)
    expect(initTokenClient).not.toHaveBeenCalled()
  })

  it('rejects after the timeout when GIS never calls back', async () => {
    vi.useFakeTimers()
    const result = putBackup('{}')
    const caught = result.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(TOKEN_TIMEOUT_MS)
    const error = await caught
    expect(error).toBeInstanceOf(DriveError)
    expect((error as Error).message).toMatch(/did not finish/)
    expect(requestAccessToken).toHaveBeenCalledOnce()
  })

  it('still reports cancellation through error_callback', async () => {
    initTokenClient.mockImplementationOnce(((config: { error_callback: () => void }) => ({
      requestAccessToken: () => config.error_callback(),
    })) as never)
    await expect(putBackup('{}')).rejects.toThrow('Google sign-in was cancelled.')
  })
})
