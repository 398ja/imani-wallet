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
    // Signs back exactly the metadata it was sent, attestation included, and writes the owner's
    // `T` as the credential's expiry, as gateway-customer does since 5b-2 (spec 4.6.2).
    const meta = (posts.at(-1) as { merchant_metadata: Record<string, unknown> & { owner_attestation?: { expires_at: string } } })
      .merchant_metadata
    const device = mintWrongDevice ? bytesToHex(schnorr.getPublicKey(schnorr.utils.randomSecretKey())) : DEVICE
    const token = buildLockedCredentialToken({
      stallKey: STALL_KEY,
      devicePubkey: device,
      metadata: JSON.stringify({ ...meta, lock_key: device }),
      ...(meta.owner_attestation ? { expiresAt: Number(meta.owner_attestation.expires_at) } : {}),
    })
    return new Response(JSON.stringify({ status: 'ISSUED', token }), { status: 200 })
  },
  sleep: async () => {},
}
const spends: string[] = []
/** Credential DMs the owner's phone published (phase 2). */
const sentDms: Array<import('nostr-tools').Event> = []
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
      <TerminalEnrolPage
        stallPubkey={STALL}
        transport={fakeTransport}
        spendApi={fakeSpend}
        publisher={{ publish: async (w) => (sentDms.push(w), true) }}
        seal={(borrow) => borrow(STALL_KEY)}
        stallSigner={stallSigner}
      />
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

/** The stall's own signer, which attests every till at enrolment (#160 decision 5). */
const stallSigner = () => ({ pubkey: STALL, withPrivkey: <T,>(borrow: (key: Uint8Array) => T) => borrow(STALL_KEY) })

const addButton = () => screen.getByRole('button', { name: 'Add terminal' }) as HTMLButtonElement

beforeEach(() => {
  localStorage.clear()
  granted = true
  offCurve = false
  mintWrongDevice = false
  posts.length = 0
  spends.length = 0
  sentDms.length = 0
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
    expect(document.body.textContent).toMatch(/cannot take payments until then/)
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

  // Review rev-5b M2 (P4): the attestation is persisted on the `minting` row at its source, before
  // the request leaves, and it is the one the request carried. Without it, a resumed mint would
  // re-send a body with no attestation under the same Idempotency-Key.
  it('persists the attestation it sent on the minting row', async () => {
    const minting: Array<Record<string, unknown>> = []
    const roster = await import('../../lib/terminalRoster')
    const real = roster.recordTerminal
    const spy = vi.spyOn(roster, 'recordTerminal').mockImplementation((stall, row) => {
      if (row.status === 'minting') minting.push({ ...row, postsSoFar: posts.length })
      return real(stall, row)
    })
    renderPage()
    await waitFor(() => expect(addButton()).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Till' } })
    fireEvent.click(screen.getByRole('button', { name: /Sell and redeem/ }))
    fireEvent.click(screen.getByRole('button', { name: 'scan' }))
    fireEvent.click(addButton())

    await waitFor(() => expect(posts).toHaveLength(1))
    spy.mockRestore()
    expect(minting).toHaveLength(1)
    const sent = (posts[0] as { merchant_metadata: { owner_attestation: unknown } }).merchant_metadata.owner_attestation
    expect(sent).toMatchObject({ v: '1', sig: expect.stringMatching(/^[0-9a-f]{128}$/) })
    expect(minting[0].attestation).toEqual(sent)
    expect(minting[0].postsSoFar).toBe(0)
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
    // Waiting rows that were really minted, so each holds a token.
    for (const k of ['2', '3']) {
      recordTerminal(STALL, {
        terminalPubkey: k.repeat(64),
        name: `Waiting ${k}`,
        role: TERMINAL_ROLES.REDEEM_ONLY,
        enrolledAt: Date.now(),
        status: 'waiting',
        token: `cashuB-waiting-${k}`,
        voucherId: `v-${k}`,
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

describe('#160 review: re-adding a device already on the list', () => {
  // BLOCKER from the review. The owner adds a device, then scans the same
  // device again (a retry, or the code still on its screen). Before the fix a
  // second credential was minted and the roster row holding the FIRST one's
  // token was replaced, so the first credential stayed live with no way to
  // revoke it. Now the second Add is refused before anything is minted, and
  // the first row, token and all, is untouched.
  it('refuses, mints nothing, and keeps the first credential revocable', async () => {
    await fillEverything()
    fireEvent.click(addButton())
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Waiting for the device' })).toBeTruthy())
    const first = allTerminals(STALL)[0]
    expect(first.token).toBeTruthy()
    cleanup()

    await fillEverything()

    expect(addButton().disabled).toBe(true)
    expect(screen.getByText(/already on your list with a live authority/)).toBeTruthy()
    expect(posts).toHaveLength(1)
    expect(allTerminals(STALL)).toHaveLength(1)
    expect(allTerminals(STALL)[0].token).toBe(first.token)
  })

  // A device whose earlier credential was revoked has nothing live left, so it
  // can be added again: that is how a terminal comes back.
  it('allows a device whose earlier credential was revoked', async () => {
    recordTerminal(STALL, {
      terminalPubkey: DEVICE,
      name: 'Old',
      role: TERMINAL_ROLES.REDEEM_ONLY,
      enrolledAt: 1,
      token: 'cashuB-old',
      revokedAt: 2,
    })
    await fillEverything()

    expect(addButton().disabled).toBe(false)
  })
})

describe('#160 review: a mint whose answer is lost is not orphaned', () => {
  // The gateway accepted the request and named the voucher, but the token
  // never arrived before the poll gave up. Before the fix nothing was recorded,
  // so a credential that may be live was unknown to the roster. Now a row is
  // written before the request, keeps the voucher id, and stays `minting` so
  // the next open of Terminals can finish or clean it up.
  it('keeps a minting row with the voucher id when the token never arrives', async () => {
    const slow = {
      ...fakeTransport,
      get: async () => new Response(JSON.stringify({ status: 'PENDING' }), { status: 200 }),
    }
    // Each poll moves the clock a minute on, so the 60-second wait gives up.
    let clock = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 60_000))
    render(
      <MemoryRouter>
        <TerminalEnrolPage stallPubkey={STALL} transport={slow} spendApi={fakeSpend} stallSigner={stallSigner} />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add terminal' })).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Front counter' } })
    fireEvent.click(screen.getByRole('button', { name: /Redemption only/ }))
    fireEvent.click(screen.getByRole('button', { name: 'scan' }))
    fireEvent.click(addButton())

    await waitFor(() => expect(screen.getByText(/not ready in time/)).toBeTruthy())
    const [row] = allTerminals(STALL)
    expect(row.status).toBe('minting')
    expect(row.voucherId).toBe('5f8a487d-6cea-4a7d-b681-9d5d62cc9dd9')
    expect(row.mintKey).toBeTruthy()
  })

  // The request carries an Idempotency-Key, and the same key is on the row,
  // so a resumed request replays the credential instead of minting another.
  it('sends the Idempotency-Key it recorded', async () => {
    const headers: Array<Record<string, string> | undefined> = []
    const keyed = {
      ...fakeTransport,
      post: async (path: string, body: unknown, h?: Record<string, string>) => {
        headers.push(h)
        return fakeTransport.post(path, body)
      },
    }
    render(
      <MemoryRouter>
        <TerminalEnrolPage stallPubkey={STALL} transport={keyed} spendApi={fakeSpend} stallSigner={stallSigner} />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add terminal' })).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Front counter' } })
    fireEvent.click(screen.getByRole('button', { name: /Redemption only/ }))
    fireEvent.click(screen.getByRole('button', { name: 'scan' }))
    fireEvent.click(addButton())

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Waiting for the device' })).toBeTruthy())
    expect(headers[0]?.['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
  })

  // The gateway refused (for example its own two-waiting limit, 409). Nothing
  // was minted, so no row is left behind and the owner reads the reason.
  it('leaves no row when the gateway refuses', async () => {
    const refusing = {
      ...fakeTransport,
      post: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'TERMINAL_PENDING_LIMIT',
              message: 'Two terminals are already waiting for their device. Finish or cancel one first.',
            },
          }),
          { status: 409 },
        ),
    }
    render(
      <MemoryRouter>
        <TerminalEnrolPage stallPubkey={STALL} transport={refusing} spendApi={fakeSpend} stallSigner={stallSigner} />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add terminal' })).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Front counter' } })
    fireEvent.click(screen.getByRole('button', { name: /Redemption only/ }))
    fireEvent.click(screen.getByRole('button', { name: 'scan' }))
    fireEvent.click(addButton())

    await waitFor(() => expect(screen.getByText(/Two terminals are already waiting/)).toBeTruthy())
    expect(allTerminals(STALL)).toEqual([])
  })
})

describe('#160 phase 2: the credential goes to the device', () => {
  // After minting, the owner's phone DMs the credential to the scanned key,
  // sealed by the stall, with the idle lock the owner chose (decision 2).
  it('sends the credential to the device, sealed by the stall, with the chosen idle lock', async () => {
    const { unwrapSealed } = await import('../../lib/terminalDelivery')
    await fillEverything()
    fireEvent.change(screen.getByLabelText('Lock when idle'), { target: { value: '30' } })
    fireEvent.click(addButton())

    expect(await screen.findByText(/Sent to Front counter/)).toBeTruthy()
    expect(sentDms).toHaveLength(1)
    expect(sentDms[0].tags).toEqual([['p', DEVICE]])
    expect(allTerminals(STALL)[0].idleLockMinutes).toBe(30)
    // The DM is addressed to the device, so the stall's key cannot open it; its
    // content is checked end to end in terminalDelivery.test.ts.
    expect(unwrapSealed(sentDms[0], STALL_KEY)).toBeNull()
  })

  // Decision 2: the idle lock defaults to 10 minutes and can be switched off.
  it('defaults the idle lock to 10 minutes, and offers Never', async () => {
    await fillEverything()
    const select = screen.getByLabelText('Lock when idle') as HTMLSelectElement

    expect(select.value).toBe('10')
    expect([...select.options].map((o) => o.textContent)).toContain('Never')
  })
})

describe('#160 review: the owner shows the setup code the device scans', () => {
  // The device accepts only the offer the owner's setup code names, so the
  // owner's screen must show that code: this stall and this credential.
  it('shows a setup code naming this stall and the minted credential', async () => {
    await fillEverything()
    fireEvent.click(addButton())

    await screen.findByText(/Sent to Front counter/)
    expect(screen.getByTestId('setup-code').textContent).toBe(
      `imani-terminal:1:${STALL}:5f8a487d-6cea-4a7d-b681-9d5d62cc9dd9`,
    )
  })
})
