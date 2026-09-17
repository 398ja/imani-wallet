/**
 * @vitest-environment jsdom
 *
 * Paging, as the reader experiences it.
 *
 * The cap exists because a stall that has issued hundreds of vouchers renders
 * every one of them into a page nobody can scroll, so the size of the window is
 * the requirement and is asserted literally. The rest of these cover the ways a
 * paged list goes wrong that are invisible in a screenshot: a page that stops
 * existing while someone is reading it, and a control strip that appears on a
 * list too short to need one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { Pagination } from '../Pagination'
import { PAGE_SIZE, usePagination } from '../usePagination'

afterEach(cleanup)

// jsdom has no layout and so no `scrollTo`; calling it prints an unimplemented
// error from deep inside jsdom on every page turn. The two tests that assert on
// scrolling stub it themselves with their own spy.
beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Renders whatever slice the hook hands back, plus the controls. */
function Probe({ items }: { items: string[] }) {
  const { visible, page, pageCount, setPage, total } = usePagination(items)
  return (
    <>
      <p data-testid="visible">{visible.join(',')}</p>
      <p data-testid="count">{visible.length}</p>
      <p data-testid="total">{total}</p>
      <Pagination page={page} pageCount={pageCount} onPage={setPage} />
    </>
  )
}

const rows = (n: number) => Array.from({ length: n }, (_, i) => `row${i + 1}`)
const shown = () => screen.getByTestId('visible').textContent?.split(',') ?? []
const next = () => fireEvent.click(screen.getByRole('button', { name: /Next/ }))
const previous = () => fireEvent.click(screen.getByRole('button', { name: /Previous/ }))

describe('usePagination', () => {
  it('shows at most 21 items per page', () => {
    // The number in the requirement, asserted as a number rather than through
    // the constant, so redefining PAGE_SIZE cannot quietly satisfy this.
    expect(PAGE_SIZE).toBe(21)

    render(<Probe items={rows(50)} />)

    expect(screen.getByTestId('count').textContent).toBe('21')
    expect(shown()[0]).toBe('row1')
    expect(shown()[20]).toBe('row21')
  })

  it('walks forward and back through the pages without losing or repeating a row', () => {
    render(<Probe items={rows(50)} />)

    next()
    expect(shown()[0]).toBe('row22')
    expect(shown()).toHaveLength(21)

    next()
    // The last page is the remainder, not a padded 21.
    expect(shown()).toEqual(['row43', 'row44', 'row45', 'row46', 'row47', 'row48', 'row49', 'row50'])

    previous()
    expect(shown()[0]).toBe('row22')
  })

  it('reports the total, so a caption can say how much there is', () => {
    render(<Probe items={rows(50)} />)
    expect(screen.getByTestId('total').textContent).toBe('50')
  })

  it('pulls the reader back in range when the list shrinks underneath them', () => {
    // These lists are live: `onWalletChanged` reloads them while the screen is
    // open, so the page someone is on can stop existing. Being left on page 3
    // of 1 shows an empty panel with no way back.
    const { rerender } = render(<Probe items={rows(50)} />)
    next()
    next()
    expect(shown()[0]).toBe('row43')

    act(() => {
      rerender(<Probe items={rows(5)} />)
    })

    expect(shown()).toEqual(['row1', 'row2', 'row3', 'row4', 'row5'])
  })

  it('handles an empty list without offering a page to turn', () => {
    render(<Probe items={[]} />)

    expect(screen.getByTestId('count').textContent).toBe('0')
    expect(screen.queryByRole('button', { name: /Next/ })).toBeNull()
  })

  it('reflects a row that changed in place, not just one that was added', () => {
    // These lists are live. An earlier draft memoised the slice on
    // `length:offset` to avoid re-slicing a new array each render, which served
    // the STALE row whenever content changed without the count changing — a
    // payment gaining its validation badge, a memo being edited.
    const { rerender } = render(<Probe items={['row1', 'row2']} />)
    expect(shown()).toEqual(['row1', 'row2'])

    act(() => {
      rerender(<Probe items={['row1', 'row2 edited']} />)
    })

    expect(shown()).toEqual(['row1', 'row2 edited'])
  })
})

describe('Pagination', () => {
  it('renders nothing for a list that fits on one page', () => {
    // A "Page 1 of 1" with two dead arrows tells the reader their list is
    // small, which they can already see.
    render(<Probe items={rows(21)} />)

    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('appears as soon as there is a second page', () => {
    render(<Probe items={rows(22)} />)

    expect(screen.getByRole('navigation')).toBeTruthy()
    expect(screen.getByText('Page 1 of 2')).toBeTruthy()
  })

  it('disables rather than hides the control at each end', () => {
    // Hiding one makes the other jump across the strip, and a moving target is
    // harder to hit than a dim one.
    render(<Probe items={rows(42)} />)

    expect(screen.getByRole('button', { name: /Previous/ })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: /Next/ })).toHaveProperty('disabled', false)

    next()

    expect(screen.getByRole('button', { name: /Previous/ })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: /Next/ })).toHaveProperty('disabled', true)
  })

  it('announces the page change to a screen reader', () => {
    // The buttons keep focus across the update, so without a live region the
    // move is silent for anyone not watching the rows.
    render(<Probe items={rows(50)} />)

    const status = screen.getByText('Page 1 of 3')
    expect(status.getAttribute('aria-live')).toBe('polite')
  })

  it('returns the reader to the top of the list, and glides only if they allow motion', () => {
    const scrollTo = vi.fn()
    vi.stubGlobal('scrollTo', scrollTo)
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false })),
    )

    render(<Probe items={rows(50)} />)
    next()

    // Without this, page 2 opens halfway down itself and reads as if rows are
    // missing.
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
    vi.unstubAllGlobals()
  })

  it('does not glide for a reader who asked for reduced motion', () => {
    const scrollTo = vi.fn()
    vi.stubGlobal('scrollTo', scrollTo)
    // A full-viewport glide is exactly the vestibular movement the setting
    // exists to stop. Same destination, no journey.
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    )

    render(<Probe items={rows(50)} />)
    next()

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' })
    vi.unstubAllGlobals()
  })
})
