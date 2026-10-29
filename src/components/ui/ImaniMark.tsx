import type { CSSProperties } from 'react'

/**
 * The imani mark: public/imani.svg's single evenodd path, in `currentColor` so
 * the caller's text colour carries it. One definition of the shape for the
 * header lockup and the voucher card, so the two cannot drift.
 */
export function ImaniMark({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 48 48" className={className} style={style} aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M10 2 H24 A8 8 0 0 1 32 10 V24 A8 8 0 0 1 24 32 H10 A8 8 0 0 1 2 24 V10 A8 8 0 0 1 10 2 Z M24 16 H38 A8 8 0 0 1 46 24 V38 A8 8 0 0 1 38 46 H24 A8 8 0 0 1 16 38 V24 A8 8 0 0 1 24 16 Z"
      />
    </svg>
  )
}
