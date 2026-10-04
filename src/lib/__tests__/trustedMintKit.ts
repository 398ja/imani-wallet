import { vi } from 'vitest'

import { clearConfigCache } from '../config'
import { loadTrustedMints, resetTrustedMints } from '../trustedMint'

/**
 * Puts the trusted-mint gate into a known state through the path production uses.
 *
 * The gate learns the gateway's mints from `GET /api/v1/config`, fetched at
 * start-up by `loadTrustedMints`. These helpers stub that fetch and run the real
 * loader, so a test exercises the same parsing and the same readiness signal the
 * app does rather than poking a global.
 */

/**
 * The gateway has answered `/api/v1/config`, naming `mintUrl` (or none, for '')
 * and, when given, the `token_mint_urls` customer-wallet stamps into tokens.
 */
export async function gatewayAnswers(mintUrl: string, tokenMintUrls?: string[]): Promise<void> {
  resetGate()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(configBody(mintUrl, tokenMintUrls))))
  await loadTrustedMints()
}

/** The JSON `/api/v1/config` returns for a gateway naming these mints. */
export function configBody(mintUrl: string, tokenMintUrls?: string[]): Record<string, unknown> {
  return {
    nip05_domain: 'imani.test',
    mint_url: mintUrl,
    ...(tokenMintUrls ? { token_mint_urls: tokenMintUrls } : {}),
  }
}

/** The gateway could not be reached, so the trusted set is still unknown. */
export async function gatewayUnreachable(): Promise<void> {
  resetGate()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('network down')
    }),
  )
  await loadTrustedMints()
}

/** Forget whatever an earlier test taught the gate, including the cached config. */
export function resetGate(): void {
  clearConfigCache()
  resetTrustedMints()
}
