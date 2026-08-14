import { useState } from 'react';

import { cn, getInitials } from '../../lib/utils';

interface AvatarProps {
  src?: string;
  name: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

export function Avatar({ src, name, size = 'md', className }: AvatarProps) {
  // The only caller passes a URL from a merchant's own Nostr profile, so a dead
  // link is ordinary rather than exceptional. Falling back to the initials keeps
  // a broken-image icon off the card.
  //
  // Stores WHICH url failed rather than a boolean, so a new `src` is retried
  // without an effect to reset the flag — resetting state from an effect is the
  // cascading-render pattern react-hooks flags, and it fails lint.
  const [failedSrc, setFailedSrc] = useState<string>();

  const sizeClasses = {
    sm: 'w-8 h-8 text-xs',
    md: 'w-10 h-10 text-sm',
    lg: 'w-14 h-14 text-lg',
    xl: 'w-20 h-20 text-2xl',
  };

  if (src && src !== failedSrc) {
    return (
      <img
        src={src}
        alt={name}
        loading="lazy"
        // Third-party host: send no referrer with the request.
        referrerPolicy="no-referrer"
        onError={() => setFailedSrc(src)}
        className={cn(
          'rounded-full object-cover',
          sizeClasses[size],
          className
        )}
      />
    );
  }

  return (
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
}
