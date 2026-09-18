import { cn } from '../../lib/utils'

/**
 * A grey block standing in for something that has not arrived.
 *
 * This exists because the alternative the wallet had was worse than nothing: a
 * name that is still being fetched fell through `identityLabel`'s ladder to a
 * short hex key, so for the two-to-four seconds a cold kind-0 lookup takes, a
 * row asserted an identity — `aaaaaaaa…aaaa` — that was never the answer, only
 * the absence of one. A reader cannot tell a placeholder from a fact when the
 * placeholder is rendered in the same type as the fact. A pulsing grey bar can
 * only mean "wait".
 *
 * `animate-pulse` rather than a shimmer sweep: the pulse is one CSS animation on
 * opacity, which compositors handle without layout or paint, and it matches the
 * restraint of a monochrome app. A travelling gradient would be the loudest
 * thing on a screen whose job is to be calm.
 *
 * Marked `aria-hidden` with no text: a screen reader should hear the region's
 * `aria-busy`, not a description of a grey rectangle. Callers own that.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'block animate-pulse rounded-md bg-mono-200 dark:bg-mono-700',
        className,
      )}
    />
  )
}

/**
 * A skeleton standing in for a LINE OF TEXT, occupying exactly its height.
 *
 * Hand-picked pixel heights do not do this. A 14px `text-sm` line is a ~21px
 * line BOX — font size plus leading — so a 14px bar with a little margin lands
 * near it and misses, and "near" is a few pixels of reflow at the moment the
 * name arrives: the row grows, everything under it steps down the page, and on
 * a list of coupons that is the whole screen twitching as profiles trickle in.
 * Avoiding exactly that is the point of using a placeholder rather than leaving
 * the space empty.
 *
 * So the height is not chosen at all. The wrapper carries the SAME typography
 * class as the text it replaces, and its line box is therefore identical by
 * construction — the browser computes it from the same font metrics. The bar
 * inside is inline and shorter than the strut, so it rides within that box
 * without affecting it. Swap the text for this and nothing moves.
 *
 * @param text the typography class of the line being replaced, e.g. `text-sm`.
 */
export function SkeletonLine({ text, width }: { text: string; width: string }) {
  return (
    <span className={cn('block', text)}>
      <Skeleton className={cn('inline-block h-[0.72em] max-w-full align-middle', width)} />
    </span>
  )
}
