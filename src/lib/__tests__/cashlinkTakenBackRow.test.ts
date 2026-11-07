/**
 * @vitest-environment jsdom
 */
import { expect, it, vi } from 'vitest'

/** Bug 2 (staging, 2026-11-05): a taken-back Cashlink wrote no History row. Now it writes one, in the link bundle. */
const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }))
vi.mock('../wallet', () => ({
  getWallet: () => ({ saveVoucher: async (r: unknown) => r, addTransaction: async (r: Record<string, unknown>) => void h.rows.push(r) }),
  notifyWalletChanged: () => {},
}))
vi.mock('../cashbackValidation', () => ({ cashbackValidation: () => undefined }))

const { takenBackRow, claimedRow } = await import('../cashlinkPorts')

it('is an incoming row of its own id, folded with the link bundle', () => {
  const row = { token_id: 't1', face_value: 300, face_unit: 'EUR', face_decimals: 2, issuer_id: 'a'.repeat(64), voucher_id: 'v' } as never
  const back = takenBackRow(row, 'cashuB', 1, 'bundle1') as unknown as Record<string, unknown>
  const claim = claimedRow(row, 'cashuB', 1, 'bundle1') as unknown as Record<string, unknown>
  expect(back.id).toBe('returned:t1')
  expect(back.id).not.toBe(claim.id)
  expect(back).toMatchObject({ type: 'received', direction: 'in', amount: 300, bundleId: 'bundle1', memo: 'Taken back from Cashlink' })
})
