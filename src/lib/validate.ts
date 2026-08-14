/**
 * Form validation for the account screens.
 *
 * One module because bottin learned this the hard way: its password-strength
 * scorer exists in three places (step-register, step-import, settings/security)
 * and its URL guard in two, which is three and two chances to fix a rule in one
 * place only.
 */

/**
 * Handle rule, taken from the GATEWAY's regex, not bottin's.
 *
 * These differ, and the difference is a silent trap: bottin's own form allows
 * `[a-z0-9_-]+` (hyphen included), but `POST /api/v1/nip05` validates
 * `^[a-z0-9_]+$` and rejects the hyphen. Using bottin's rule here would let the
 * form accept `farm-stand`, show it as available, and fail only at the claim —
 * after a key has already been minted. Match the endpoint that decides.
 */
const HANDLE = /^[a-z0-9_]+$/
const HANDLE_MAX = 64

export function validateHandle(value: string): string | undefined {
  const handle = value.trim()
  if (handle === '') return 'Choose a handle.'
  if (handle.length > HANDLE_MAX) return `At most ${HANDLE_MAX} characters.`
  if (!HANDLE.test(handle)) return 'Use lowercase letters, numbers and underscores only.'
  return undefined
}

/**
 * Minimum passphrase length.
 *
 * 8 is bottin's rule, kept for parity. It is a floor, not a recommendation — the
 * strength meter is what actually pushes people past it.
 */
export const MIN_PASSPHRASE = 8

export function validatePassphrase(value: string): string | undefined {
  if (value.length < MIN_PASSPHRASE) return `At least ${MIN_PASSPHRASE} characters.`
  return undefined
}

export function validateConfirmation(passphrase: string, confirm: string): string | undefined {
  if (passphrase !== confirm) return 'The two passphrases do not match.'
  return undefined
}

/**
 * Website must be http(s).
 *
 * Rejecting other schemes is a safety rule, not a formatting preference: this
 * value becomes an `href`, and `javascript:` is a URL too.
 */
export function validateWebsite(value: string): string | undefined {
  const website = value.trim()
  if (website === '') return undefined
  try {
    const { protocol } = new URL(website)
    if (protocol !== 'http:' && protocol !== 'https:') return 'Must start with http:// or https://'
    return undefined
  } catch {
    return 'That does not look like a web address.'
  }
}

export type Strength = 'weak' | 'fair' | 'good' | 'strong'

/**
 * Passphrase strength, scored as bottin scores it: length twice, then variety.
 *
 * Advisory only — nothing gates on it beyond the length minimum. It exists to
 * make a longer passphrase feel worth typing, and this one guards a key that
 * cannot be reset.
 */
export function passphraseStrength(value: string): Strength {
  let score = 0
  if (value.length >= 8) score++
  if (value.length >= 12) score++
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score++
  if (/[0-9]/.test(value)) score++
  if (/[^A-Za-z0-9]/.test(value)) score++

  if (score <= 1) return 'weak'
  if (score === 2) return 'fair'
  if (score === 3) return 'good'
  return 'strong'
}
