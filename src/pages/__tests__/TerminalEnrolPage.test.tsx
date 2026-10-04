/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * The enrolment form, driven as a screen.
 *
 * `terminalIssue.ts` has the rules and its own tests. What only a rendered
 * screen can be wrong about is whether the form can be made to produce
 * authority the rules would have refused — so most of these assert that the
 * button STAYS disabled, and one drives the whole flow to check the owner's
 * roster ends up holding what revocation later needs.
 *
 * The camera component is stubbed to a button, because jsdom has no camera.
 * Nothing else is: the real `checkEnrolment`, `prepareEnrolment` and roster all
 * run, since they are the part the wiring could get wrong.
 */

import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils'
import { buildLockedCredentialToken } from '../../lib/__tests__/voucherFixtures'

/** The stall holds a real key, so the fake gateway can sign the credential it returns. */
const STALL_KEY = schnorr.utils.randomSecretKey()
const STALL = bytesToHex(schnorr.getPublicKey(STALL_KEY))
/** A real point on the curve. Off-curve codes are refused since #160 phase 0. */
const DEVICE = bytesToHex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()))

/**
 * The gateway, faked at the network edge only. It mints what it is asked for,
 * signed by the stall, the way gateway-customer does since #160 phase 1, unless
 * a test makes it mint the wrong device.
 */
let mintWrongDevice = false
const posts: unknown[] = []
const fakeTransport = {
  post: async (_path: string, body: unknown) => {
    posts.push(body)
    return new Response(JSON.stringify({ voucher_id: '5f8a487d-6cea-4a7d-b681-9d5d62cc9dd9' }), {
      status: 201,
    })
  },
  get: async () => {
    const meta = (posts.at(-1) as { merchant_metadata: { role: string } }).merchant_metadata
    const token = buildLockedCredentialToken({
      stallKey: STALL_KEY,
      devicePubkey: mintWrongDevice ? bytesToHex(schnorr.getPublicKey(schnorr.utils.randomSecretKey())) : DEVICE,
      role: meta.role,
    })
    return new Response(JSON.stringify({ status: 'ISSUED', token }), { status: 200 })
  },
  sleep: async () => {},
}
const spends: string[] = []
const fakeSpend = async () => ({
  validateToken: async () => ({ state: 'UNSPENT' }),
  receive: async (token: string) => {
    spends.push(token)
    return {}
  },
})

/** When set, the stub scanner returns 64 hex characters that are not a key. */
let offCurve = false

vi.mock('../../components/ScanRecipient', () => ({
  ScanRecipient: ({ onFound }: { onFound: (k: string) => void }) => (
    <button onClick={() => onFound(offCurve ? 'c'.repeat(64) : DEVICE)}>scan</button>
  ),
}))

/**
 * Only the CHECK is stubbed, not the module. `mayEnrol` reads `grants` from
 * here too, and replacing that as well would leave the free-allowance rule
 * untested at exactly the point this screen depends on it.
 */
let granted = true
vi.mock('../../lib/licenceStatus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/licenceStatus')>()
  return {
    ...actual,
    licenceStatus: async () => ({
      checkedAt: Date.now(),
      decision: granted
        ? { granted: true as const, source: 'verified' as const, grant: { features: ['terminals'] } }
        : { granted: false as const, reason: 'no-licence' as const },
    }),
  }
})

const { TerminalEnrolPage } = await import('../TerminalEnrolPage')
const { allTerminals, recordTerminal } = await import('../../lib/terminalRoster')
const { TERMINAL_ROLES } = await import('../../lib/terminalRole')

function renderPage() {
  return render(
    <MemoryRouter>
      <TerminalEnrolPage stallPubkey={STALL} transport={fakeTransport} spendApi={fakeSpend} />
    </MemoryRouter>,
  )
}

/** The form filled in correctly, so each test can remove exactly one thing. */
async function fillEverything() {
  renderPage()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add terminal' })).toBeTruthy())
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Front counter' } })
  fireEvent.click(screen.getByRole('button', { name: /Redemption only/ }))
  fireEvent.click(screen.getByRole('button', { name: 'scan' }))
}

const addButton = () => screen.getByRole('button', { name: 'Add terminal' }) as HTMLButtonElement

beforeEach(() => {
  localStorage.clear()
  granted = true
  offCurve = false
  mintWrongDevice = false
  posts.length = 0
  spends.length = 0
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('nothing goes live without the three answers', () => {
  it('refuses a terminal with no role, however complete the rest is', async () => {
    // The ticket's first criterion. There is no default role, so this is the
    // state an owner reaches by simply not choosing — the likeliest way a door
    // device would end up able to sell.
    renderPage()
    await waitFor(() => expect(addButton()).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Front counter' } })
    fireEvent.click(screen.getByRole('button', { name: 'scan' }))

    expect(addButton().disabled).toBe(true)
    expect(allTerminals(STALL)).toEqual([])
  })

  it('refuses a terminal with no name', async () => {
    renderPage()
    await waitFor(() => expect(addButton()).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Redemption only/ }))
    fireEvent.click(screen.getByRole('button', { name: 'scan' }))

    expect(addButton().disabled).toBe(true)
  })

  it('refuses before anything has been scanned', async () => {
    renderPage()
    await waitFor(() => expect(addButton()).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Front counter' } })
    fireEvent.click(screen.getByRole('button', { name: /Redemption only/ }))

    expect(addButton().disabled).toBe(true)
  })

  it('does not scold an untouched form', async () => {
    // Empty is not yet a mistake. A form that opens already complaining reads
    // as broken.
    renderPage()
    await waitFor(() => expect(addButton()).toBeTruthy())

    expect(screen.queryByText(/Give this terminal a name/)).toBeNull()
  })

  it('names what is missing once the owner has started', async () => {
    renderPage()
    await waitFor(() => expect(addButton()).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Redemption only/ }))

    expect(screen.getByText(/Give this terminal a name/)).toBeTruthy()
  })
})

describe('scanning does not enrol', () => {
  it('creates no authority from a scan alone', async () => {
    /**
     * The enrolment QR is safe to observe, which is only true if seeing one
     * cannot create authority. A camera catching a code across a market must
     * fill the field and stop there.
     */
    renderPage()
    await waitFor(() => expect(addButton()).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'scan' }))

    expect(allTerminals(STALL)).toEqual([])
    expect(screen.queryByText(/Terminal added/)).toBeNull()
  })
})

describe('the subscription gate is on the screen, not behind it', () => {
  it('refuses in words rather than hiding the form', async () => {
    // Subscriptions ticket 07: refused AT enrolment, not by a missing button.
    // A hidden button leaves an owner with no idea what to fix.
    granted = false
    // One terminal already out, so the free allowance is used up.
    recordTerminal(STALL, {
      terminalPubkey: 'd'.repeat(64),
      name: 'Existing',
      role: TERMINAL_ROLES.REDEEM_ONLY,
      enrolledAt: 1,
    })

    await fillEverything()

    expect(addButton().disabled).toBe(true)
    // The form is still there to be read, and a sentence explains the refusal.
    expect(screen.getByLabelText('Name')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBeTruthy()
  })

  it('allows the first terminal without a subscription', async () => {
    // The free allowance. A stall trying the product must reach a working
    // terminal, or nobody ever sees what they would be paying for.
    granted = false
    await fillEverything()

    expect(addButton().disabled).toBe(false)
  })
})

describe('connectivity is stated before the attempt', () => {
  it('says so up front, before the form is filled in', async () => {
    // Enrolment has no offline path and pre-issuing is ruled out, so the owner
    // should learn this before typing, not after.
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    renderPage()
    await waitFor(() => expect(addButton()).toBeTruthy())

    expect(screen.getByText(/needs a connection/)).toBeTruthy()
  })

  it('will not enrol while offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    await fillEverything()

    expect(addButton().disabled).toBe(true)
    expect(allTerminals(STALL)).toEqual([])
  })
})

describe('enrolling', () => {
  it('records what revocation will later need, on the OWNER’s device', async () => {
    /**
     * Ticket 06's third criterion depends on this happening HERE. If the
     * roster row were only written by the terminal, a lost device could never
     * be revoked — which is the case that matters most.
     */
    await fillEverything()
    fireEvent.click(addButton())

    await waitFor(() => expect(allTerminals(STALL)).toHaveLength(1))
    const [row] = allTerminals(STALL)
    expect(row.terminalPubkey).toBe(DEVICE)
    expect(row.name).toBe('Front counter')
    expect(row.role).toBe(TERMINAL_ROLES.REDEEM_ONLY)
    expect(row.revokedAt).toBeUndefined()
  })

  it('records the role the owner chose, not a default', async () => {
    // Reads the DELIVERED record rather than the form state, so a screen that
    // showed one role and stored another would fail here.
    renderPage()
    await waitFor(() => expect(addButton()).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Till' } })
    fireEvent.click(screen.getByRole('button', { name: /Sell and redeem/ }))
    fireEvent.click(screen.getByRole('button', { name: 'scan' }))
    fireEvent.click(addButton())

    await waitFor(() => expect(allTerminals(STALL)).toHaveLength(1))
    expect(allTerminals(STALL)[0].role).toBe(TERMINAL_ROLES.ISSUE_AND_REDEEM)
  })

  it('tells the owner the job is not finished on this device', async () => {
    // The terminal still needs a passphrase entered on IT. An owner who walks
    // away here has a device that cannot open, and no reason to know why.
    await fillEverything()
    fireEvent.click(addButton())

    expect(await screen.findByRole('heading', { name: /Waiting for the device/ })).toBeTruthy()
    expect(screen.getByText(/passphrase/)).toBeTruthy()
  })

  // #160 phase 0: nothing has reached the device and no credential exists, so
  // the screen must never claim the terminal can trade. It used to say
  // "<name> can now trade for your stall" after making no call at all.
  it('never claims the terminal can trade', async () => {
    await fillEverything()
    fireEvent.click(addButton())

    await screen.findByRole('heading', { name: /Waiting for the device/ })
    expect(document.body.textContent).not.toMatch(/can now trade|can trade for your stall/i)
    expect(document.body.textContent).toMatch(/cannot take payments yet/)
  })

  // The owner's list says the same thing as the screen: the row is waiting,
  // not a till that is ready and has simply never been used.
  it('records the row as waiting for its device', async () => {
    await fillEverything()
    fireEvent.click(addButton())

    await waitFor(() => expect(allTerminals(STALL)).toHaveLength(1))
    expect(allTerminals(STALL)[0].status).toBe('waiting')
  })

  // #160 phase 1 (G1): Add used to build the credential and throw it away. It
  // must now make exactly one minting call and keep the token, which is what
  // revoking the terminal later spends.
  it('mints once and keeps the credential token on the owner\'s row', async () => {
    await fillEverything()
    fireEvent.click(addButton())

    await waitFor(() => expect(allTerminals(STALL)).toHaveLength(1))
    expect(posts).toHaveLength(1)
    const [row] = allTerminals(STALL)
    expect(row.token).toMatch(/^cashuB/)
    expect(row.voucherId).toBe('5f8a487d-6cea-4a7d-b681-9d5d62cc9dd9')
    expect(row.waitingUntil).toBeGreaterThan(Date.now())
  })

  // The owner reads the same check code the device will show (spec 2.1).
  it('shows a six-digit check code', async () => {
    await fillEverything()
    fireEvent.click(addButton())

    expect(await screen.findByText(/^\d{3} \d{3}$/)).toBeTruthy()
  })

  // A credential that came back locked to another device is spent at once
  // and nothing is recorded, so no unusable or foreign authority sits on the
  // owner's list.
  it('records nothing and cancels a credential that came back wrong', async () => {
    mintWrongDevice = true
    await fillEverything()
    fireEvent.click(addButton())

    expect(await screen.findByText(/different device/)).toBeTruthy()
    expect(allTerminals(STALL)).toEqual([])
    expect(spends).toHaveLength(1)
  })

  // Decision 4: two waiting rows is the limit. A third Add is refused in
  // words, before any mint.
  it('refuses a third terminal while two are waiting', async () => {
    for (const k of ['2', '3']) {
      recordTerminal(STALL, {
        terminalPubkey: k.repeat(64),
        name: `Waiting ${k}`,
        role: TERMINAL_ROLES.REDEEM_ONLY,
        enrolledAt: Date.now(),
        status: 'waiting',
      })
    }
    await fillEverything()

    expect(addButton().disabled).toBe(true)
    expect(screen.getByText(/Two terminals are already waiting/)).toBeTruthy()
    expect(posts).toEqual([])
  })

  // Decision 4: a waiting row does not use the free terminal, so an owner with
  // no subscription and one botched setup can still add the device again.
  it('does not count a waiting row against the free terminal', async () => {
    granted = false
    recordTerminal(STALL, {
      terminalPubkey: '2'.repeat(64),
      name: 'Botched',
      role: TERMINAL_ROLES.REDEEM_ONLY,
      enrolledAt: Date.now(),
      status: 'waiting',
    })
    await fillEverything()

    expect(addButton().disabled).toBe(false)
  })
})

describe('a wrong scan can be corrected', () => {
  it('lets the owner rescan without leaving the screen', async () => {
    // Two devices on a counter showing similar codes is the ordinary case.
    // Without a way back, the remedy for a wrong scan is to abandon the form —
    // or to shrug and enrol the wrong device.
    await fillEverything()
    expect(addButton().disabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }))

    // Back to not-yet-scanned: the scanner returns and enrolling is refused
    // again, so a stale key cannot be issued to.
    expect(addButton().disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'scan' })).toBeTruthy()
    expect(allTerminals(STALL)).toEqual([])
  })
})

describe('#160 phase 0: a code that is nobody\'s key', () => {
  // The owner types (or scans) 64 hex characters that are not a point on the
  // curve. No device holds such a key, and the gateway would mint an unlocked
  // credential for it, so the form refuses in words and records nothing.
  it('refuses an off-curve key and records nothing', async () => {
    offCurve = true
    await fillEverything()

    expect(addButton().disabled).toBe(true)
    expect(screen.getByText(/not a terminal code/)).toBeTruthy()
    expect(allTerminals(STALL)).toEqual([])
  })
})
