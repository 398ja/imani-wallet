import type { CSSProperties } from 'react'

const PATH =
  'M10 2 H24 A8 8 0 0 1 32 10 V24 A8 8 0 0 1 24 32 H10 A8 8 0 0 1 2 24 V10 A8 8 0 0 1 10 2 Z M24 16 H38 A8 8 0 0 1 46 24 V38 A8 8 0 0 1 38 46 H24 A8 8 0 0 1 16 38 V24 A8 8 0 0 1 24 16 Z'

/**
 * The imani mark: public/imani.svg's single evenodd path, in `currentColor` so
 * the caller's text colour carries it. One definition of the shape for the
 * header lockup and the voucher card, so the two cannot drift.
 *
 * `outlined` draws a black border that follows the mark's own edges (#419),
 * for a white mark sitting on a picture. `paint-order: stroke` puts the stroke
 * under the fill, so only its outer half shows and the mark keeps its exact
 * shape; the viewBox grows by the stroke's reach so the border is not clipped.
 */
export function ImaniMark({
  className,
  style,
  outlined,
}: {
  className?: string
  style?: CSSProperties
  outlined?: boolean
}) {
  return (
    <svg
      viewBox={outlined ? '-4 -4 56 56' : '0 0 48 48'}
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d={PATH}
        {...(outlined && {
          stroke: 'black',
          strokeWidth: 6,
          strokeLinejoin: 'round' as const,
          paintOrder: 'stroke',
        })}
      />
    </svg>
  )
}
