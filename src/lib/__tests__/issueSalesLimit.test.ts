/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * The gateway's free-allowance refusal reaches the Sell screen as a SalesLimitError.
 *
 * The incident: a free stall at 30 GBP was let through a 100 GBP sale, then a 3 GBP one. The
 * gateway now refuses with 422 SALES_LIMIT_REACHED before minting; the wallet must recognise the
 * code in every shape the tiers write it (the portal's flat `error_code`/`code`, the customer
 * tier's nested `error.code`), deliver nothing, record nothing, and let Sell invite an upgrade.
 */

const calls: string[] = []
const transactions: Array<Record<string, unknown>> = []
let refusal: unknown = null

vi.mock('../nip98', () => ({
  signedFetch: async (path: string) => {
    calls.push(path)
    if (path === '/api/v1/portal/vouchers') {
      return { ok: false, status: 422, json: async () => refusal, text: async () => JSON.stringify(refusal) }
    }
    return { ok: true, json: async () => ({}), text: async () => '' }
  },
}))

vi.mock('../wallet', () => ({
  getWallet: () => ({
    addTransaction: async (row: Record<string, unknown>) => {
      transactions.push(row)
    },
  }),
  notifyWalletChanged: () => {},
}))

vi.mock('../relay', () => ({ INTERNAL_RELAY_URL: 'ws://relay.test' }))

vi.mock('../nap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../nap')>()),
  getSigner: () => ({
    pubkey: 'a'.repeat(64),
    withPrivkey: <T,>(borrow: (key: Uint8Array) => T): T => borrow(new Uint8Array(32).fill(7)),
  }),
}))

const { issueAndDeliver, isSalesLimitBody } = await import('../issue')
const { ownerActor } = await import('../actor')
const { SalesLimitError, SALES_LIMIT_MESSAGE } = await import('../entitlement')

const params = {
  faceValueMinor: 100_00,
  currency: 'GBP',
  expiryDays: 30,
  recipientPubkey: 'b'.repeat(64),
  actor: ownerActor('a'.repeat(64))!,
}

beforeEach(() => {
  calls.length = 0
  transactions.length = 0
})

describe('a sale refused for the plan allowance', () => {
  it.each([
    ['the portal relay', { error: 'This sale would…', error_code: 'SALES_LIMIT_REACHED', code: 'SALES_LIMIT_REACHED' }],
    ['the portal, error_code only', { error: 'x', error_code: 'SALES_LIMIT_REACHED' }],
    ['gateway-customer directly', { error: { code: 'SALES_LIMIT_REACHED', message: 'x' } }],
  ])('is a SalesLimitError from %s, and nothing is delivered or recorded', async (_name, body) => {
    refusal = body
    const error = await issueAndDeliver(params).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(SalesLimitError)
    expect((error as InstanceType<typeof SalesLimitError>).code).toBe('SALES_LIMIT_REACHED')
    expect((error as Error).message).toBe(SALES_LIMIT_MESSAGE)
    expect((error as Error).message).toMatch(/Upgrade/)
    expect((error as Error).message).toMatch(/nothing was issued/)
    expect(calls).not.toContain('/api/v1/dm/tokens/send')
    expect(transactions).toHaveLength(0)
  })

  it('leaves any other 422 an ordinary error', async () => {
    refusal = { error: { code: 'SUBSCRIPTION_REVOKED', message: 'revoked' } }
    const error = await issueAndDeliver(params).catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(SalesLimitError)
    expect((error as Error).message).toBe('revoked')
  })

  it('recognises only the code, never a lookalike', () => {
    expect(isSalesLimitBody({ code: 'SALES_LIMIT' })).toBe(false)
    expect(isSalesLimitBody(null)).toBe(false)
    expect(isSalesLimitBody({ error: { code: 'SALES_LIMIT_REACHED' } })).toBe(true)
  })
})
