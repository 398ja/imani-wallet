import { describe, expect, it } from 'vitest'

import { extractReceiptCode, receiptShareText } from '../shareText'

/**
 * A receipt sent as text (Share on the receipt dialog). The stall pastes whatever the
 * messaging app delivered, so the code has to come back out of the words around it intact.
 */

const CODE = 'imrc1:AAECAwQFBgcICQ-_Zz09#a2V5LWJ5dGVzLWhlcmU'

describe('receiptShareText', () => {
  it('carries the code exactly as the QR shows it', () => {
    // Arrange
    const code = CODE

    // Act
    const text = receiptShareText(code)

    // Assert
    expect(text).toContain(code)
    expect(text).toMatch(/Check a receipt/)
  })
})

describe('extractReceiptCode', () => {
  it('reads the code back out of the shared message', () => {
    // Arrange
    const message = receiptShareText(CODE)

    // Act
    const found = extractReceiptCode(message)

    // Assert
    expect(found).toBe(CODE)
  })

  it('leaves behind words a chat app added before and after', () => {
    // Arrange
    const message = `Forwarded:\n> here you go ${CODE} thanks!\nSent from my phone`

    // Act
    const found = extractReceiptCode(message)

    // Assert
    expect(found).toBe(CODE)
  })

  it('keeps a code with no evidence key whole', () => {
    // Arrange
    const message = 'imrc1:AAECAwQFBgcICQ.'

    // Act
    const found = extractReceiptCode(message)

    // Assert
    expect(found).toBe('imrc1:AAECAwQFBgcICQ')
  })

  it('accepts an upper case prefix, as a scan does', () => {
    // Arrange
    const message = 'see IMRC1:AAECAwQ'

    // Act
    const found = extractReceiptCode(message)

    // Assert
    expect(found).toBe('IMRC1:AAECAwQ')
  })

  it('finds nothing in text without a receipt', () => {
    // Arrange
    const inputs = ['', 'hello', 'imrc1:', 'cashuBo2FteBVodHRwczovL21pbnQ', 'imrc2:AAEC']

    // Act
    const found = inputs.map(extractReceiptCode)

    // Assert
    expect(found).toEqual([null, null, null, null, null])
  })
})
