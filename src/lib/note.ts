/**
 * The free-text Note on a sale, a cashback, a send or a redeem.
 *
 * Capped at 280 UTF-16 code units, the same limit and the same unit as gateway-portal's cashback
 * `GenerateRequest` (`@Size(max = 280) String memo`) and as an HTML `maxLength`, so the field, the
 * portal and the till all agree on what fits.
 *
 * Why it must be capped at all: a till sends each sale row to the stall as a NIP-17 gift wrap
 * (`tillSales.ts`), and one row never splits. An uncapped note made a single row's wrap 76,965
 * bytes, over strfry's 65,536 `maxEventSize`. At 280 units the worst case is 280 three-byte
 * characters, 840 UTF-8 bytes (a 4-byte character is two units, so at most 560 bytes), which
 * leaves a capped row far inside the 24,000-byte wrap budget next to its 2 to 2.5 KB warrant.
 */
export const NOTE_MAX_CHARS = 280

/**
 * The note cut to `NOTE_MAX_CHARS` code units, never splitting a surrogate pair. Undefined stays
 * undefined, and a note within the cap is returned unchanged.
 */
export function clampNote(note: string | undefined): string | undefined {
  if (note === undefined || note.length <= NOTE_MAX_CHARS) return note
  let end = NOTE_MAX_CHARS
  // A high surrogate as the last unit kept is half a character: drop it with its pair.
  const last = note.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return note.slice(0, end)
}
