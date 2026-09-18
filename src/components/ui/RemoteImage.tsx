import { useState } from 'react'

import { cn } from '../../lib/utils'
import { Skeleton } from './Skeleton'

/**
 * A remote image that holds its space and fades in when it arrives.
 *
 * The wallet's banners and coupon strips are fetched from hosts the ISSUER
 * controls, over whatever connection the phone has, and every one of them
 * rendered as a blank band until the bytes landed — then snapped into place.
 * The band is the right SIZE (the caller fixes the height, so nothing reflows),
 * but an empty grey rectangle says "there is nothing here" when the truth is
 * "there is something here and it is on its way". Those are different claims,
 * and only one of them is true.
 *
 * `Avatar` already solved this for faces and this is the same logic for the
 * rectangles, extracted rather than copied a fourth time. The pieces that matter
 * and are easy to get wrong alone:
 *
 *  - The skeleton is keyed to the URL, not a boolean, so a NEW `src` starts
 *    pending again without an effect resetting a flag.
 *  - `complete && naturalWidth > 0` in a ref callback, because a CACHED image
 *    can finish decoding before React attaches `onLoad` — and then the event
 *    never fires and the placeholder pulses forever over a picture that is
 *    already there.
 *  - A failed load falls back to the plain band rather than a broken-image
 *    icon. These URLs are self-published and dying is ordinary.
 *
 * `loading="lazy"` and `referrerPolicy="no-referrer"` are not tuning. See
 * `imageUrl` in branding.ts: fetching one of these hands the host the
 * customer's IP and the moment they opened their wallet, so an image is
 * requested when it is actually looked at, and never carries the wallet route
 * that asked for it.
 */
export function RemoteImage({
  src,
  alt = '',
  className,
  skeletonClassName,
}: {
  /** Absent renders nothing at all — the caller's own "no image" case. */
  src?: string
  alt?: string
  className?: string
  /** Overrides the placeholder's shape where it is not the image's own. */
  skeletonClassName?: string
}) {
  const [loadedSrc, setLoadedSrc] = useState<string>()
  const [failedSrc, setFailedSrc] = useState<string>()

  if (!src) return null

  // A dead link leaves the plain band the callers already had, which is the
  // honest end state: we tried, there is no picture.
  if (src === failedSrc) return <span className={cn('block', className)} />

  const loaded = src === loadedSrc

  return (
    <span className={cn('relative block overflow-hidden', className)}>
      {!loaded && (
        <Skeleton className={cn('absolute inset-0 h-full w-full rounded-none', skeletonClassName)} />
      )}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        referrerPolicy="no-referrer"
        onLoad={() => setLoadedSrc(src)}
        onError={() => setFailedSrc(src)}
        ref={(node) => {
          // Already decoded before React got here. Returns undefined
          // deliberately: React 19 reads a returned value as a cleanup function.
          if (node?.complete && node.naturalWidth > 0) setLoadedSrc(src)
        }}
        className={cn(
          'h-full w-full object-cover transition-opacity duration-200',
          loaded ? 'opacity-100' : 'opacity-0',
        )}
      />
    </span>
  )
}
