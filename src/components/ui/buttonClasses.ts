import { cn } from '../../lib/utils';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'outline';
export type ButtonSize = 'sm' | 'md' | 'lg';

/**
 * The button look, for anything that has to be a link but act like a button.
 *
 * A destination that is the screen's main action (Stripe's return pages, the
 * guest Buy screen) is a `<Link>`, and it used to restate the primary style by
 * hand: `rounded-full`, `text-white`, a 17px label. That drifted from `Button`
 * in three ways at once, so the same action read as a different control from
 * one screen to the next. Things that look the same must behave the same, and
 * the cheapest way to keep them looking the same is one source.
 */
export function buttonClasses(variant: ButtonVariant = 'primary', size: ButtonSize = 'md'): string {
  return cn(
    'pressable inline-flex items-center justify-center rounded-xl font-medium disabled:opacity-50 disabled:pointer-events-none',
    {
      'bg-mono-900 text-mono-50 hover:bg-mono-800 dark:bg-mono-50 dark:text-mono-900 dark:hover:bg-mono-200':
        variant === 'primary',
      'bg-mono-100 text-mono-900 hover:bg-mono-200 dark:bg-mono-800 dark:text-mono-50 dark:hover:bg-mono-700':
        variant === 'secondary',
      'bg-transparent hover:bg-mono-100 dark:hover:bg-mono-800':
        variant === 'ghost',
      'border border-mono-200 bg-transparent hover:bg-mono-100 dark:border-mono-700 dark:hover:bg-mono-800':
        variant === 'outline',
      'px-3 py-2 text-sm': size === 'sm',
      'px-6 py-3 text-base': size === 'md',
      'px-8 py-4 text-lg': size === 'lg',
    },
  );
}
