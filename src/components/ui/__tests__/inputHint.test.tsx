/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { Input } from '../Input'

afterEach(cleanup)

describe('Input hint', () => {
  it('shows the hint under the field and reads it out with it', () => {
    render(<Input label="Note (optional)" hint="Shown on the receipt for this payment." />)
    const field = screen.getByLabelText('Note (optional)')
    const hint = screen.getByText('Shown on the receipt for this payment.')
    expect(field.getAttribute('aria-describedby')).toBe(hint.id)
  })

  it('an error replaces the hint; no hint, no description', () => {
    render(<Input label="A" hint="h" error="Too long" />)
    expect(screen.queryByText('h')).toBeNull()
    cleanup()
    render(<Input label="B" />)
    expect(screen.getByLabelText('B').getAttribute('aria-describedby')).toBeNull()
  })

  it('keeps a caller’s own description', () => {
    render(<Input label="C" hint="h" aria-describedby="mine" />)
    expect(screen.getByLabelText('C').getAttribute('aria-describedby')).toMatch(/^mine \S+-hint$/)
  })
})
