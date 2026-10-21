/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

/**
 * Review of #358. Two gaps the first round left open:
 *
 * 1. Finish your profile claims the FIRST handle for a key that has none (a pasted key, a backup
 *    whose account was never finished, or the logged-in card, #332). That claim is what creates
 *    the account on the service, so it must ask for the Terms and Conditions, and
 *    `claimProfileWith` must refuse without them, before anything is claimed.
 * 2. The acceptance is local only: the public kind-0 never carries it.
 *
 * The REAL profile gate, terms and profile store; only the network is stubbed.
 */
const signedFetch = vi.fn(async () => new Response(JSON.stringify({ nip05: 'x@imani.local' }), { status: 201 }))
const published: Array<{ kind: number; content: string }> = []
vi.mock('../config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config')>()),
  gatewayConfig: async () => ({ nip05Domain: 'imani.local', blossomServerUrl: null }),
}))
vi.mock('../nip98', async (importOriginal) => ({ ...(await importOriginal<typeof import('../nip98')>()), signedFetch }))
vi.mock('../relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../relay')>()),
  publish: async (event: { kind: number; content: string }) => {
    published.push(event)
    return { ok: 1, total: 1, errors: [] }
  },
}))
vi.mock('../onboardingHandoff', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../onboardingHandoff')>()),
  stashPendingBackup: vi.fn(),
}))

const { claimProfile, claimProfileWith } = await import('../profileGate')
const { register } = await import('../registration')
const { createWalletSigner } = await import('../signer')
const { acceptTerms, TermsNotAcceptedError, TermsNotConfiguredError } = await import('../terms')
const { buildProfileEvent, emptyProfile, loadProfile, saveProfile } = await import('../profile')
const { FinishProfileStep } = await import('../../components/FinishProfileStep')

const PRIV = '7'.repeat(64)
const TERMS = 'https://www.imani.casa/terms.html'

beforeEach(() => {
  localStorage.clear()
  signedFetch.mockClear()
  published.length = 0
  vi.stubEnv('VITE_WEBSITE_BASE_URL', 'https://www.imani.casa')
})
afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

describe('claimProfile refuses without the Terms and Conditions (review of #358)', () => {
  it('refuses a missing, malformed or foreign acceptance before claiming anything', async () => {
    await expect(claimProfile(PRIV, 'alice', null, undefined as never)).rejects.toBeInstanceOf(TermsNotAcceptedError)
    await expect(
      claimProfile(PRIV, 'alice', null, { url: 'https://evil.test/terms.html', acceptedAt: 1 }),
    ).rejects.toBeInstanceOf(TermsNotAcceptedError)
    await expect(
      claimProfileWith(createWalletSigner(PRIV), 'alice', null, undefined as never),
    ).rejects.toBeInstanceOf(TermsNotAcceptedError)
    expect(signedFetch).not.toHaveBeenCalled()
    expect(published).toEqual([])
  })

  it('refuses on a build that names no terms page', async () => {
    const terms = acceptTerms(1)
    vi.stubEnv('VITE_WEBSITE_BASE_URL', '')
    await expect(claimProfile(PRIV, 'alice', null, terms)).rejects.toBeInstanceOf(TermsNotConfiguredError)
    expect(signedFetch).not.toHaveBeenCalled()
  })

  it('records the acceptance on the profile it claims', async () => {
    const profile = await claimProfile(PRIV, 'alice', null, acceptTerms(9))
    expect(profile.termsAccepted).toEqual({ url: TERMS, acceptedAt: 9 })
    expect(loadProfile(profile.pubkey)?.termsAccepted).toEqual({ url: TERMS, acceptedAt: 9 })
  })

  it('never overwrites an acceptance the record already holds', async () => {
    const pubkey = createWalletSigner(PRIV).pubkey
    saveProfile({ ...emptyProfile(pubkey), termsAccepted: { url: TERMS, acceptedAt: 3 }, updatedAt: 1 })
    const profile = await claimProfile(PRIV, 'alice', null, acceptTerms(99))
    expect(profile.termsAccepted).toEqual({ url: TERMS, acceptedAt: 3 })
  })
})

describe('the acceptance is never published (review of #358)', () => {
  it('buildProfileEvent leaves it out of the kind-0', () => {
    const event = buildProfileEvent({
      ...emptyProfile('a'.repeat(64)),
      displayName: 'Alice',
      termsAccepted: { url: TERMS, acceptedAt: 5 },
      updatedAt: 1,
    })
    expect(event.content).not.toMatch(/terms/i)
    expect(Object.keys(JSON.parse(event.content) as object).sort()).toEqual(['display_name', 'name'])
  })

  it('register and claimProfile publish a kind-0 without it', async () => {
    await register('alice', 'a-passphrase', async () => {}, { terms: acceptTerms(5) })
    await claimProfile('8'.repeat(64), 'bob', null, acceptTerms(6))
    const kind0 = published.filter((e) => e.kind === 0)
    expect(kind0).toHaveLength(2)
    for (const e of kind0) expect(e.content).not.toMatch(/terms|acceptedAt/i)
  })
})

describe('Finish your profile asks for the Terms and Conditions (review of #358)', () => {
  const box = () => screen.getByRole('checkbox', { name: /I accept the Terms and Conditions/ }) as HTMLInputElement
  const finish = () => screen.getByRole('button', { name: 'Finish and log in' }) as HTMLButtonElement

  it('starts unticked, links to the terms, and keeps the button disabled until ticked', async () => {
    const onClaim = vi.fn(async () => {})
    render(<FinishProfileStep onClaim={onClaim} onCancel={() => {}} />)
    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'alice' } })
    expect(box().checked).toBe(false)
    const link = screen.getByRole('link', { name: 'Terms and Conditions' }) as HTMLAnchorElement
    expect(link.href).toBe(TERMS)
    expect(link.target).toBe('_blank')
    expect(link.rel.split(' ').sort()).toEqual(['noopener', 'noreferrer'])
    expect(finish().disabled).toBe(true)

    // Submitting the form some other way (Enter in the field) claims nothing either.
    await act(async () => {
      fireEvent.submit(finish().closest('form') as HTMLFormElement)
    })
    expect(onClaim).not.toHaveBeenCalled()

    fireEvent.click(box())
    expect(finish().disabled).toBe(false)
    await act(async () => {
      fireEvent.click(finish())
    })
    expect(onClaim).toHaveBeenCalledWith('alice', { url: TERMS, acceptedAt: expect.any(Number) })
  })

  it('with no base URL: no link, no box, and the button stays disabled', () => {
    vi.stubEnv('VITE_WEBSITE_BASE_URL', '')
    render(<FinishProfileStep onClaim={vi.fn()} onCancel={() => {}} />)
    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'alice' } })
    expect(screen.queryByRole('link', { name: 'Terms and Conditions' })).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(finish().disabled).toBe(true)
  })
})
