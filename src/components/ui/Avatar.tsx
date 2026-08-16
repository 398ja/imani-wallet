import { useEffect, useState } from 'react';

import { cn, getInitials } from '../../lib/utils';
import { isMerchantPubkey } from '../../lib/merchant';

interface AvatarProps {
  src?: string;
  name: string;
  /**
   * Whose avatar this is. Optional: given one, the avatar looks up whether they
   * trade as a merchant and wears the badge if they do — so no caller has to
   * know, and every screen showing the same person agrees.
   */
  pubkey?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

/**
 * Does this pubkey have a stall? False until the answer arrives.
 *
 * The pubkey is stored WITH the answer and compared on the way out, for the same
 * reason `useIdentity` does it: this component is reused across rows, and a badge
 * left over from the previous person is a claim about the wrong person.
 */
function useIsMerchant(pubkey: string | undefined): boolean {
  const [resolved, setResolved] = useState<{ pubkey: string; merchant: boolean }>();

  useEffect(() => {
    if (!pubkey) return;
    let cancelled = false;
    void isMerchantPubkey(pubkey).then((merchant) => {
      if (!cancelled) setResolved({ pubkey, merchant });
    });
    return () => {
      cancelled = true;
    };
  }, [pubkey]);

  return resolved !== undefined && resolved.pubkey === pubkey && resolved.merchant;
}

export function Avatar({ src, name, pubkey, size = 'md', className }: AvatarProps) {
  // The only caller passes a URL from a merchant's own Nostr profile, so a dead
  // link is ordinary rather than exceptional. Falling back to the initials keeps
  // a broken-image icon off the card.
  //
  // Stores WHICH url failed rather than a boolean, so a new `src` is retried
  // without an effect to reset the flag — resetting state from an effect is the
  // cascading-render pattern react-hooks flags, and it fails lint.
  const [failedSrc, setFailedSrc] = useState<string>();
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
      <img
        src={src}
        alt={name}
        loading="lazy"
        // Third-party host: send no referrer with the request.
        referrerPolicy="no-referrer"
        onError={() => setFailedSrc(src)}
        className={cn('rounded-full object-cover', sizeClasses[size], className)}
      />
    ) : (
      <div
        className={cn(
          'rounded-full bg-mono-200 dark:bg-mono-700 flex items-center justify-center font-medium text-mono-600 dark:text-mono-300',
          sizeClasses[size],
          className
        )}
      >
        {getInitials(name)}
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
