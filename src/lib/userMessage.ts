/**
 * The words to show a person for an error, without protocol jargon (#324).
 *
 * Pages surface `e.message` straight into an Alert, and some of those messages
 * come from libraries that speak the protocol: "relay refused the record",
 * "NIP-98 authentication required", "Invalid npub format". The owner's rule is
 * that users never see those terms, so a message that carries one is replaced
 * by a plain, generic one. Everything else passes through unchanged: most
 * errors this app throws are already written for a person, and rewording them
 * all would lose real information.
 *
 * Deliberately a filter, not a translation table. A table would need an entry
 * per library message and silently miss the next one; a term check catches
 * every message at the one place it reaches the screen.
 */

/** The same terms the #324 guard test bans from the UI's own copy. */
export const JARGON = /\b(npub\w*|nsec\w*|nostr|relays?|NIP-?\d+|pubkeys?|bech32|kind[- ]?\d+)\b/i

/** Said instead of a message that would have shown jargon. */
export const GENERIC_ERROR = 'Something went wrong. Check your connection and try again.'

export function userMessage(error: unknown, fallback: string = GENERIC_ERROR): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (!message.trim()) return fallback
  return JARGON.test(message) ? fallback : message
}
