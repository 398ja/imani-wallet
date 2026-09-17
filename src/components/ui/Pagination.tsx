import { ChevronLeft, ChevronRight } from 'lucide-react'

/**
 * The control strip for a paged list. The paging itself — and the reasoning
 * behind it — lives in `usePagination.ts`; the two are split only because a
 * module that exports both a component and a hook defeats fast refresh.
 */

/**
 * The control strip under a paged list.
 *
 * Renders NOTHING for a single page. A "Page 1 of 1" with two dead arrows is
 * furniture that tells the reader their list is small, which they can already
 * see.
 */
export function Pagination({
  page,
  pageCount,
  onPage,
  label = 'Pagination',
}: {
  page: number
  pageCount: number
  onPage: (page: number) => void
  /** Names this control when a screen has more than one paged list. */
  label?: string
}) {
  if (pageCount <= 1) return null

  const go = (to: number) => {
    onPage(Math.min(pageCount, Math.max(1, to)))
    // Back to the top of the list, because the reader's eye is at the BOTTOM
    // of the previous page when they tap. Without this, page 2 opens halfway
    // down itself and reads as if rows are missing.
    //
    // The smooth scroll is asked for HERE rather than in CSS because this is a
    // scripted jump, and it is withdrawn for anyone who asked for reduced
    // motion: a full-viewport glide is exactly the vestibular movement that
    // setting exists to stop. They get the same destination, instantly.
    const gentle = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    window.scrollTo({ top: 0, behavior: gentle ? 'auto' : 'smooth' })
  }

  // One button treatment, defined once — the two differ only in direction.
  // `pressable` is the app's press feedback: it reacts on pointer-DOWN and is
  // already reduced-motion aware, so paging feels like every other control here.
  const button =
    'pressable inline-flex items-center gap-1 rounded-xl border border-mono-200 px-3 py-2 text-sm text-mono-600 disabled:opacity-40 dark:border-mono-800 dark:text-mono-300'

  return (
    <nav
      aria-label={label}
      className="mt-4 flex items-center justify-between gap-3"
    >
      <button
        type="button"
        onClick={() => go(page - 1)}
        disabled={page === 1}
        // Disabled rather than hidden: a control that disappears at the ends
        // makes the other one jump across the strip, and a moving target is
        // harder to hit than a dim one.
        className={button}
      >
        <ChevronLeft className="h-4 w-4" />
        Previous
      </button>

      {/* `aria-live` so a screen reader hears the page change. The buttons keep
          focus across the update, so without this the move is silent.
          `tabular-nums` stops the strip twitching as the digits change. */}
      <p aria-live="polite" className="text-sm tabular-nums text-mono-500">
        Page {page} of {pageCount}
      </p>

      <button type="button" onClick={() => go(page + 1)} disabled={page === pageCount} className={button}>
        Next
        <ChevronRight className="h-4 w-4" />
      </button>
    </nav>
  )
}
