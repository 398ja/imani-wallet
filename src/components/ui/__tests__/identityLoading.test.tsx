/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { IdentityInline } from '../IdentityInline'
import { clearBrandingCache } from '../../../lib/branding'

/**
 * A profile that has not arrived yet must not be rendered as a key.
 *
 * Reported from the app: avatars, display names and NIP-05s "sometimes take a
 * bit too long", and what stood in the gap was `identityLabel`'s last rung —
 * `aaaaaaaa…aaaa`. That is not a degraded name, it is a different KIND of
 * thing: a truncated hex key, in the same type and the same position as a real
 * name, which a reader has no way to tell apart from one. Someone glancing at a
 * receipt reads it as who they paid.
 *
 * The rung itself stays. It is right for a pubkey whose lookup CAME BACK EMPTY
 * — a stall that published no kind-0 has no name, forever, and a stable
 * identifier beats a blank. The fix is to stop conflating that settled answer
 * with a fetch still in flight.
 */

const STALL = 'a'.repeat(64)

// The lookup this component depends on, stubbed at its module boundary. The
// promise is left UNRESOLVED in the pending cases on purpose: that is the state
// under test, and a stub that resolves immediately would skip straight past it.
const pending = new Promise<never>(() => {})
let brandingFor: (pubkey: string) => Promise<unknown>

vi.mock('../../../lib/branding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/branding')>()),
  merchantBranding: (pubkey: string) => brandingFor(pubkey),
}))

vi.mock('../../../lib/merchant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/merchant')>()),
  isMerchantPubkey: () => Promise.resolve(false),
}))

const draw = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>)

beforeEach(() => {
  localStorage.clear()
  clearBrandingCache()
  brandingFor = () => pending
})

afterEach(cleanup)

describe('a name that has not arrived', () => {
  it('shows a loading placeholder rather than a truncated key', () => {
    draw(<IdentityInline pubkey={STALL} />)

    // The key must be nowhere on the row, in either form.
    expect(screen.queryByText(/aaaaaaaa/)).toBeNull()
    expect(document.body.textContent).not.toContain(STALL.slice(0, 8))
    // And something must say "wait" — announced once for the region, not as a
    // description of each grey bar.
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(document.querySelector('.animate-pulse')).not.toBeNull()
  })

  it('replaces the placeholder with the name when it lands', async () => {
    brandingFor = () => Promise.resolve({ organizationName: 'Rosa Green Farm' })

    draw(<IdentityInline pubkey={STALL} />)

    await waitFor(() => expect(screen.getByText('Rosa Green Farm')).toBeTruthy())
    expect(document.querySelector('[aria-busy="true"]')).toBeNull()
  })

  /**
   * A lookup that came back EMPTY is a settled answer, not a wait. The short key
   * is the right thing to show — it is stable, it is unforgeable, and a blank
   * row on "who is this coupon from" is worse. A spinner that never stops would
   * be worse still.
   */
  it('falls back to the short key once the lookup comes back empty', async () => {
    brandingFor = () => Promise.resolve({})

    draw(<IdentityInline pubkey={STALL} />)

    await waitFor(() => expect(screen.getByText('aaaaaaaa…aaaa')).toBeTruthy())
    expect(document.querySelector('[aria-busy="true"]')).toBeNull()
  })

  /**
   * A caller that already knows the name never waits. Pay knows the issuer from
   * the coupon it is spending; a skeleton there would hide a name we hold in
   * order to wait for one we do not need.
   */
  it('does not wait when the caller supplied a name', () => {
    draw(<IdentityInline pubkey={STALL} fallbackName="Rosa Green Farm" />)

    expect(screen.getByText('Rosa Green Farm')).toBeTruthy()
    expect(document.querySelector('[aria-busy="true"]')).toBeNull()
  })

  /** Same argument for a handle: Send knows the address that was typed. */
  it('does not wait when the caller supplied a handle', () => {
    draw(<IdentityInline pubkey={STALL} fallbackHandle="rosa@x.test" />)

    expect(screen.getByText('@rosa')).toBeTruthy()
    expect(document.querySelector('[aria-busy="true"]')).toBeNull()
  })

  /**
   * THE POINT OF PERSISTING PROFILES. A name the user has already seen renders
   * on the FIRST frame of the next visit, with no loading state at all — the
   * fetch behind it becomes a correction rather than a wait. Without this the
   * skeleton would simply replace the key on every cold start, which is politer
   * but no faster.
   */
  it('shows a previously seen name immediately, with no loading state', () => {
    localStorage.setItem(
      `imani-wallet:identity:${STALL}`,
      JSON.stringify({ branding: { organizationName: 'Rosa Green Farm' }, at: Date.now() }),
    )

    draw(<IdentityInline pubkey={STALL} />)

    // Synchronously, before any promise settles.
    expect(screen.getByText('Rosa Green Farm')).toBeTruthy()
    expect(document.querySelector('[aria-busy="true"]')).toBeNull()
  })

  /**
   * A FAILED LOOKUP MUST NOT ERASE A KNOWN NAME, found in review.
   *
   * `merchantBranding` resolves to empty fields when both stores were briefly
   * unreachable — ordinary on a phone. Written as `fetched ?? known` the empty
   * answer wins, because `??` only falls through on null, and the row would
   * drop from a name the user has seen a hundred times back to a hex key the
   * moment the signal dips. That is the exact failure this change removes,
   * arriving by a different door.
   */
  it('keeps a known name when the lookup comes back empty', async () => {
    localStorage.setItem(
      `imani-wallet:identity:${STALL}`,
      JSON.stringify({ branding: { organizationName: 'Rosa Green Farm' }, at: Date.now() }),
    )
    brandingFor = () => Promise.resolve({})

    draw(<IdentityInline pubkey={STALL} />)

    // Still named after the empty answer has settled.
    await new Promise((r) => setTimeout(r, 10))
    expect(screen.getByText('Rosa Green Farm')).toBeTruthy()
    expect(screen.queryByText('aaaaaaaa…aaaa')).toBeNull()
  })
})
