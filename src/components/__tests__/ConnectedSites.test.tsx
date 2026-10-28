/**
 * @vitest-environment jsdom
 *
 * Settings › Security › Connected sites (#411): lists this key's remembered "yes" answers from the
 * signer popup, and Remove forgets one so the popup asks again.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ConnectedSites } from '../ConnectedSites'
import { CONSENT_STORAGE_KEY } from '../../lib/napSignerPage'

const ME = 'a'.repeat(64)
const SOMEONE_ELSE = 'b'.repeat(64)

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('Connected sites', () => {
  it('shows only this key\'s sites, and Remove forgets one', () => {
    localStorage.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify([
        { origin: 'https://gifting.imani.casa', pubkey: ME, scope: '27235|https://gifting.imani.casa' },
        { origin: 'https://subscription.imani.casa', pubkey: SOMEONE_ELSE, scope: '27235|https://subscription.imani.casa' },
      ]),
    )
    render(<ConnectedSites pubkey={ME} />)
    expect(screen.getByText('gifting.imani.casa')).toBeTruthy()
    expect(screen.queryByText('subscription.imani.casa')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    return Promise.resolve().then(async () => {
      await screen.findByText(/No site can sign you in without asking first/)
      const left = JSON.parse(localStorage.getItem(CONSENT_STORAGE_KEY) ?? '[]') as Array<{ pubkey: string }>
      expect(left.map((r) => r.pubkey)).toEqual([SOMEONE_ELSE])
    })
  })

  it('says so when nothing is remembered', () => {
    render(<ConnectedSites pubkey={ME} />)
    expect(screen.getByText(/No site can sign you in without asking first/)).toBeTruthy()
  })
})
