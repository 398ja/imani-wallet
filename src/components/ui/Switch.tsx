/**
 * A switch, built on a real checkbox.
 *
 * `sr-only` on the input rather than a div-with-onClick, so keyboard focus,
 * space-to-toggle and screen-reader state come from the platform instead of
 * being reimplemented. `role="switch"` makes it read as on/off rather than
 * checked/unchecked, and the visual track and knob are siblings AFTER the input
 * so Tailwind's `peer-checked:` can reach them.
 *
 * The whole thing is wrapped in the `<label>`, so a tap anywhere on the row —
 * text included — toggles it. That is also why the track needs no click handler.
 */
export function Switch({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <label
      className={`flex items-center justify-between gap-4 rounded-2xl border border-mono-200 p-4 dark:border-mono-800 ${
        disabled ? 'opacity-50' : 'press-row cursor-pointer'
      }`}
    >
      <span className="min-w-0">
        <span className="block font-medium text-mono-900 dark:text-mono-50">{label}</span>
        {hint && <span className="mt-0.5 block text-sm text-mono-500">{hint}</span>}
      </span>

      <span className="relative inline-flex shrink-0 items-center">
        <input
          type="checkbox"
          role="switch"
          className="peer sr-only"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="h-6 w-11 rounded-full bg-mono-300 transition-colors duration-150 ease-out peer-checked:bg-mono-900 peer-focus-visible:ring-2 peer-focus-visible:ring-mono-900 peer-focus-visible:ring-offset-2 dark:bg-mono-700 dark:peer-checked:bg-mono-50 dark:peer-focus-visible:ring-mono-50" />
        {/* Inverted against the track the way MethodCard inverts in dark, so the
            knob stays visible in all four track/theme combinations. */}
        <span className="pointer-events-none absolute left-0.5 h-5 w-5 rounded-full bg-mono-50 shadow-sm ring-1 ring-mono-900/10 transition-transform duration-150 ease-out peer-checked:translate-x-5 motion-reduce:transition-none dark:bg-mono-900 dark:ring-0" />
      </span>
    </label>
  )
}
