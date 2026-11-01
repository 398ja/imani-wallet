import { TERMS_NOT_CONFIGURED_COPY } from '../lib/terms'

/**
 * "I accept the Terms and Conditions" (#357), the words linking to the terms page in a new tab.
 *
 * Shared by every screen that creates an account on the service: registration (OnboardingPage)
 * and Finish your profile, which claims the first handle for a key that has none (review of
 * #358). Unticked to start: the caller owns `checked` and starts it at false.
 *
 * The whole row is the tap target, at least 44px tall, and the box sits in a 44px column so a
 * thumb aimed at it lands. The link is the only part that does not toggle: it opens the terms,
 * so reading them never ticks the box by accident. A build that names no website shows plain
 * copy instead and no box at all: there is nothing to accept and no account to create, and a
 * link to a page that is not there would be worse than none.
 */
export function TermsCheckbox({
  url,
  checked,
  disabled,
  onChange,
}: {
  url: string | null
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  if (url === null) {
    return (
      <p role="status" className="rounded-2xl bg-mono-100 p-4 text-sm text-mono-600 dark:bg-mono-800 dark:text-mono-300">
        {TERMS_NOT_CONFIGURED_COPY}
      </p>
    )
  }
  return (
    // -ml-3: the 44px column centres a 20px box, so pulling the row back by the difference lines
    // the box up with the fields' left edge while the tap target keeps its full size.
    <label
      className={`-ml-3 flex min-h-11 items-center gap-1 rounded-2xl text-sm text-mono-700 dark:text-mono-200 ${
        disabled ? 'opacity-50' : 'cursor-pointer'
      }`}
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="h-5 w-5 accent-mono-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-900 focus-visible:ring-offset-2 dark:accent-mono-50 dark:focus-visible:ring-mono-50"
        />
      </span>
      <span>
        I accept the{' '}
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="pressable font-medium text-mono-900 underline underline-offset-2 dark:text-mono-50"
          onClick={(e) => e.stopPropagation()}
        >
          Terms and Conditions
        </a>
      </span>
    </label>
  )
}
