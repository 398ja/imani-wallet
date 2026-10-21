import { useState } from 'react';
import { User } from 'lucide-react';

import { cn, getInitials } from '../../lib/utils';
import { OWN_ACCOUNT, UNKNOWN_PERSON, UNKNOWN_STALL } from '../../lib/format';
import { useIsMerchant } from '../../hooks/useIsMerchant';
import { Skeleton } from './Skeleton';

interface AvatarProps {
  src?: string;
  name: string;
  /**
   * Whose avatar this is. Optional: given one, the avatar looks up whether they
   * trade as a merchant and wears the badge if they do — so no caller has to
   * know, and every screen showing the same person agrees.
   */
  pubkey?: string;
  /**
   * The profile behind this face has not arrived yet.
   *
   * Draws a pulsing disc instead of initials, because the initials would be
   * derived from whatever `name` fell back to — and for an unresolved profile
   * that is a hex key, so the circle read "AA". Two letters taken from a key
   * look exactly like two letters taken from a name, which is the whole problem:
   * the placeholder was indistinguishable from the answer.
   */
  loading?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

export function Avatar({ src, name, pubkey, loading, size = 'md', className }: AvatarProps) {
  // The only caller passes a URL from a merchant's own Nostr profile, so a dead
  // link is ordinary rather than exceptional. Falling back to the initials keeps
  // a broken-image icon off the card.
  //
  // Stores WHICH url failed rather than a boolean, so a new `src` is retried
  // without an effect to reset the flag — resetting state from an effect is the
  // cascading-render pattern react-hooks flags, and it fails lint.
  const [failedSrc, setFailedSrc] = useState<string>();
  // Whether THIS url has finished decoding. Keyed by url rather than a boolean
  // for the same reason `failedSrc` is: a new `src` must start pending again
  // without an effect resetting a flag.
  //
  // A picture is a network fetch too, and a large avatar on a slow connection
  // left an initials circle standing where a face was about to appear — the same
  // flash as the name, one element to the left. The pulse holds the space until
  // the bytes are there, and `complete` covers the case the browser had it
  // cached and fired `load` before React attached the handler.
  const [loadedSrc, setLoadedSrc] = useState<string>();
  const merchant = useIsMerchant(pubkey);

  const sizeClasses = {
    sm: 'w-8 h-8 text-xs',
    md: 'w-10 h-10 text-sm',
    lg: 'w-14 h-14 text-lg',
    xl: 'w-20 h-20 text-2xl',
  };

  // 35% of the avatar, floored at 12px — imani-apps' proportions, so the same
  // person looks the same in both apps.
  const badgeClasses = {
    sm: 'w-3 h-3',
    md: 'w-3.5 h-3.5',
    lg: 'w-5 h-5',
    xl: 'w-7 h-7',
  };

  const face =
    src && src !== failedSrc ? (
      /*
        The picture and its placeholder share one box, so the space is held
        while the bytes arrive and the face fades into exactly the same spot.

        `className` goes on the WRAPPER ONLY. It carries layout from the caller
        — `shrink-0` on every row in the app — and putting it on the inner img
        too meant the same flex rule applied twice at two nesting levels, which
        is at best redundant and at worst contradictory once a caller passes a
        margin.
      */
      <span className={cn('relative inline-block shrink-0', sizeClasses[size], className)}>
        {src !== loadedSrc && (
          <Skeleton className={cn('absolute inset-0 h-full w-full rounded-full')} />
        )}
        <img
          src={src}
          alt={name}
          /*
            STILL LAZY, and deliberately so after considering the alternative.

            A lazy image below the fold does not start loading until it nears
            the viewport, so the skeleton beneath it keeps pulsing until then —
            which argues for eager loading, until you read why `imageUrl` exists
            in branding.ts: these URLs point at hosts the ISSUER controls, and
            fetching one hands them the customer's IP and the moment they opened
            their wallet. Eager loading a deck of cards would beacon every stall
            the user has ever dealt with on app open, including the ones they
            never scroll to.

            A placeholder animating off-screen is invisible; a privacy
            regression is not. The pulse resolves as soon as the card is
            actually looked at, which is exactly when the promise it makes comes
            due.
          */
          loading="lazy"
          // Third-party host: send no referrer with the request.
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(src)}
          onLoad={() => setLoadedSrc(src)}
          ref={(node) => {
            // A CACHED image can finish decoding before React attaches `onLoad`,
            // and then the event never fires and the skeleton never lifts. This
            // catches that: `complete` with real pixels means it is already here.
            //
            // The callback returns undefined deliberately — React 19 treats a
            // returned value as a cleanup function, so the concise arrow body
            // this replaced was handing React a `setLoadedSrc` return as if it
            // were one.
            if (node?.complete && node.naturalWidth > 0) setLoadedSrc(src);
          }}
          className={cn(
            'h-full w-full rounded-full object-cover',
            // Faded in rather than popped in, so a picture that arrives late
            // does not snap over the placeholder it replaces.
            'transition-opacity duration-200',
            src === loadedSrc ? 'opacity-100' : 'opacity-0',
          )}
        />
      </span>
    ) : loading ? (
      <Skeleton className={cn('shrink-0 rounded-full', sizeClasses[size], className)} />
    ) : (
      <div
        className={cn(
          'rounded-full bg-mono-200 dark:bg-mono-700 flex items-center justify-center font-medium text-mono-600 dark:text-mono-300',
          sizeClasses[size],
          className
        )}
      >
        {/* The neutral fallback gets the generic person glyph, not an "S":
            initials of a placeholder word are no more a person than initials
            of a key were (#324). */}
        {name === UNKNOWN_PERSON || name === OWN_ACCOUNT || name === UNKNOWN_STALL ? (
          <User className="h-1/2 w-1/2" aria-hidden="true" />
        ) : (
          getInitials(name)
        )}
      </div>
    );

  if (!merchant) return face;

  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      {face}
      {/*
        The one spot of colour in a monochrome app, which is the point: it marks
        the handful of people you can buy from. Orange gradient, white glyph and
        surface-coloured ring are imani-apps' merchant badge verbatim, glyph path
        included — a customer who uses both should not have to learn two marks.
      */}
      <span
        className={cn(
          'absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full bg-gradient-to-br from-orange-500 to-orange-600 shadow ring-2 ring-mono-50 dark:ring-mono-950',
          badgeClasses[size]
        )}
        title="Merchant"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[60%] w-[60%] fill-white">
          <path d="M19 5v2h-4V5h4M9 5v6H5V5h4m10 8v6h-4v-6h4M9 17v2H5v-2h4M21 3h-8v6h8V3M11 3H3v10h8V3m10 8h-8v10h8V11m-10 4H3v6h8v-6z" />
        </svg>
      </span>
      <span className="sr-only">Merchant</span>
    </span>
  );
}
