/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const platform = vi.hoisted(() => ({ value: 'web' }))
const plugin = vi.hoisted(() => ({ authorize: vi.fn(), clearToken: vi.fn() }))
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => platform.value, isNativePlatform: () => platform.value !== 'web' },
  registerPlugin: () => plugin,
}))

import { DriveError, NATIVE_UNSUPPORTED, TOKEN_TIMEOUT_MS, driveConfigured, listBackups, putBackup } from '../drive'
import { CANCELLED, DRIVE_SCOPE, SCOPE_NOT_GRANTED } from '../googleToken'

const fetchMock = vi.fn()
const BACKUP = JSON.stringify({ pubkey: 'a'.repeat(64) })

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

function bearer(n: number): string | undefined {
  const init = fetchMock.mock.calls[n]?.[1] as RequestInit | undefined
  return (init?.headers as Record<string, string> | undefined)?.Authorization
}

describe('drive access token', () => {
  const requestAccessToken = vi.fn()
  const initTokenClient = vi.fn(() => ({ requestAccessToken }))

  beforeEach(() => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'test-client')
    vi.stubGlobal('fetch', fetchMock)
    window.google = { accounts: { oauth2: { initTokenClient } } }
    platform.value = 'web'
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetAllMocks()
    delete window.google
  })

  describe('web (GIS)', () => {
    it('uses GIS and never the native plugin', async () => {
      initTokenClient.mockImplementationOnce(((config: { callback: (r: { access_token: string }) => void }) => ({
        requestAccessToken: () => config.callback({ access_token: 'gis-token' }),
      })) as never)
      fetchMock.mockResolvedValueOnce(json({ files: [] }))
      await expect(listBackups()).resolves.toEqual([])
      expect(bearer(0)).toBe('Bearer gis-token')
      expect(plugin.authorize).not.toHaveBeenCalled()
    })

    it('rejects after the timeout when GIS never calls back', async () => {
      vi.useFakeTimers()
      const caught = putBackup(BACKUP).catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(TOKEN_TIMEOUT_MS)
      const error = await caught
      expect(error).toBeInstanceOf(DriveError)
      expect((error as Error).message).toMatch(/did not finish/)
      expect(requestAccessToken).toHaveBeenCalledOnce()
    })

    it('reports cancellation through error_callback', async () => {
      initTokenClient.mockImplementationOnce(((config: { error_callback: () => void }) => ({
        requestAccessToken: () => config.error_callback(),
      })) as never)
      await expect(putBackup(BACKUP)).rejects.toThrow(CANCELLED)
    })

    it('does not retry a 401 on the web', async () => {
      initTokenClient.mockImplementation(((config: { callback: (r: { access_token: string }) => void }) => ({
        requestAccessToken: () => config.callback({ access_token: 'gis-token' }),
      })) as never)
      fetchMock.mockResolvedValue(new Response('', { status: 401 }))
      await expect(listBackups()).rejects.toThrow('(401)')
      expect(fetchMock).toHaveBeenCalledOnce()
    })
  })

  describe('android (native AuthorizationClient)', () => {
    beforeEach(() => {
      platform.value = 'android'
      vi.stubEnv('VITE_GOOGLE_CLIENT_ID', '')
    })

    it('is configured without a web client id', () => {
      expect(driveConfigured()).toBe(true)
    })

    it('uses the plugin for drive.appdata and never GIS', async () => {
      plugin.authorize.mockResolvedValueOnce({ accessToken: 'native-token', grantedScopes: [DRIVE_SCOPE] })
      fetchMock.mockResolvedValueOnce(json({ files: [] }))
      await expect(listBackups()).resolves.toEqual([])
      expect(plugin.authorize).toHaveBeenCalledWith({ scopes: [DRIVE_SCOPE] })
      expect(bearer(0)).toBe('Bearer native-token')
      expect(initTokenClient).not.toHaveBeenCalled()
    })

    it('maps a cancelled rejection to the cancel message', async () => {
      plugin.authorize.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { code: 'cancelled' }))
      await expect(putBackup(BACKUP)).rejects.toThrow(CANCELLED)
    })

    it('refuses a grant without drive.appdata', async () => {
      plugin.authorize.mockResolvedValueOnce({ accessToken: 't', grantedScopes: ['openid'] })
      await expect(putBackup(BACKUP)).rejects.toThrow(SCOPE_NOT_GRANTED)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('on a 401 clears the token, re-authorizes once and retries once', async () => {
      plugin.authorize
        .mockResolvedValueOnce({ accessToken: 'stale', grantedScopes: [DRIVE_SCOPE] })
        .mockResolvedValueOnce({ accessToken: 'fresh', grantedScopes: [DRIVE_SCOPE] })
      plugin.clearToken.mockResolvedValue(undefined)
      fetchMock
        .mockResolvedValueOnce(new Response('', { status: 401 }))
        .mockResolvedValueOnce(json({ files: [{ id: 'f1', name: 'imani-wallet-account-x.json' }] }))
        .mockResolvedValueOnce(new Response('backup-text'))
      await expect(listBackups()).resolves.toMatchObject([{ id: 'f1', text: 'backup-text' }])
      expect(plugin.clearToken).toHaveBeenCalledExactlyOnceWith({ accessToken: 'stale' })
      expect(plugin.authorize).toHaveBeenCalledTimes(2)
      expect(bearer(1)).toBe('Bearer fresh')
    })

    it('a second 401 is final: no second retry', async () => {
      plugin.authorize.mockResolvedValue({ accessToken: 't', grantedScopes: [DRIVE_SCOPE] })
      plugin.clearToken.mockResolvedValue(undefined)
      fetchMock.mockResolvedValue(new Response('', { status: 401 }))
      await expect(putBackup(BACKUP)).rejects.toThrow('(401)')
      expect(plugin.clearToken).toHaveBeenCalledOnce()
      expect(plugin.authorize).toHaveBeenCalledTimes(2)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('times out a plugin call that never settles', async () => {
      vi.useFakeTimers()
      plugin.authorize.mockReturnValueOnce(new Promise(() => {}))
      const caught = putBackup(BACKUP).catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(TOKEN_TIMEOUT_MS)
      const error = await caught
      expect(error).toBeInstanceOf(DriveError)
      // No "allow pop-ups" advice in the app: there are no pop-ups there.
      expect((error as Error).message).not.toMatch(/pop-up/)
    })
  })

  it('fails fast on iOS', async () => {
    platform.value = 'ios'
    await expect(putBackup(BACKUP)).rejects.toThrow(NATIVE_UNSUPPORTED)
    expect(initTokenClient).not.toHaveBeenCalled()
    expect(plugin.authorize).not.toHaveBeenCalled()
  })
})
