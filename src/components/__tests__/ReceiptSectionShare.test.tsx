/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

/**
 * Show receipt, then Share: the same code the QR carries goes out as text, for a stall that
 * cannot scan it (a remote shop, a broken camera). Close replaces the old Done.
 */

const shared: string[] = []
const copied: string[] = []
const native = { canShare: true, shareOk: true, copyOk: true }
vi.mock('../../lib/native', () => ({
  canShare: () => native.canShare,
  shareText: async (t: string) => (shared.push(t), native.shareOk),
  writeClipboard: async (t: string) => (copied.push(t), native.copyOk),
}))

let signed = 0
vi.mock('../../lib/receipts', () => ({
  onReceiptsChanged: () => () => undefined,
  receiptForTransaction: async () => ({
    paymentId: 'p1',
    role: 'PAYER',
    status: 'acknowledged',
    amount: 100,
    unit: 'sat',
    paidAt: 1_795_000_000,
  }),
  presentReceipt: async () => ({ qrText: `imrc1:CODE${++signed}`, refreshAt: Date.now() + 60_000, evidence: 'none' }),
}))
vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,AA' } }))

const { ReceiptSection } = await import('../ReceiptSection')

beforeAll(() => {
  // jsdom has no <dialog> behaviour.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false
    this.dispatchEvent(new Event('close'))
  }
})

afterEach(() => {
  cleanup()
  shared.length = 0
  copied.length = 0
  signed = 0
  Object.assign(native, { canShare: true, shareOk: true, copyOk: true })
})

async function openDialog() {
  render(<ReceiptSection txId="t1" />)
  fireEvent.click(await screen.findByRole('button', { name: /Show receipt/ }))
  const share = await screen.findByRole('button', { name: 'Share' })
  await waitFor(() => expect((share as HTMLButtonElement).disabled).toBe(false))
  return share
}

describe('the receipt dialog', () => {
  it('offers Share and Close, and no Done', async () => {
    // Arrange / Act
    await openDialog()

    // Assert
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
  })

  it('shares the code on screen as text through the share sheet, with no new round trip', async () => {
    // Arrange
    const share = await openDialog()
    const signedBefore = signed

    // Act
    fireEvent.click(share)

    // Assert
    await waitFor(() => expect(shared).toHaveLength(1))
    expect(shared[0]).toContain('imrc1:CODE1')
    expect(signed).toBe(signedBefore)
    expect(copied).toEqual([])
  })

  it('copies the text when there is no share sheet, and says so', async () => {
    // Arrange
    native.canShare = false
    const share = await openDialog()

    // Act
    fireEvent.click(share)

    // Assert
    expect(await screen.findByText(/Receipt copied/)).toBeTruthy()
    expect(copied[0]).toContain('imrc1:CODE1')
    expect(shared).toEqual([])
  })

  it('copies when the share sheet could not open', async () => {
    // Arrange
    native.shareOk = false
    const share = await openDialog()

    // Act
    fireEvent.click(share)

    // Assert
    expect(await screen.findByText(/Receipt copied/)).toBeTruthy()
    expect(copied).toHaveLength(1)
  })

  it('says so when neither sharing nor copying worked', async () => {
    // Arrange
    native.canShare = false
    native.copyOk = false
    const share = await openDialog()

    // Act
    fireEvent.click(share)

    // Assert
    expect(await screen.findByText(/Could not share or copy/)).toBeTruthy()
  })

  it('Close shuts the dialog', async () => {
    // Arrange
    await openDialog()

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    // Assert
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Share' })).toBeNull())
  })
})
