/**
 * The shop address in `/shop/<handle>` (#410 §1.1, owner edit 1).
 *
 * A bare name means a handle on the default domain (`alice` → `alice@imani.casa`), a full NIP-05
 * is accepted too (`alice@example.com`, `@` possibly URL-encoded), and everything is lower-cased.
 * There is deliberately no hexpub or npub form: the handle is the shop's name.
 */

/** The default handle domain, `VITE_GIFTING_HANDLE_DOMAIN`, else imani.casa. */
export const DEFAULT_HANDLE_DOMAIN: string =
  (import.meta.env?.VITE_GIFTING_HANDLE_DOMAIN as string | undefined)?.trim().toLowerCase() || 'imani.casa'

export type ShopHandle =
  | {
      kind: 'ok'
      /** `alice@imani.casa`: what is resolved and pinned. */
      nip05: string
      /** The URL segment to show: bare on the default domain, else the full NIP-05. */
      canonical: string
      /** True when the URL used was not the canonical one, so the page should redirect. */
      redirect: boolean
    }
  | { kind: 'invalid' }

/** NIP-05 local part: a-z0-9-_. (case-insensitive), `_` alone is the domain's root. */
const LOCAL = /^[a-z0-9._-]{1,64}$/
/** A DNS name with at least one dot, labels 1–63 chars, no leading/trailing hyphen. */
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** Is `local@domain` a well-formed NIP-05 identifier? Exported for the recipient field. */
export function isNip05(value: string): boolean {
  const at = value.lastIndexOf('@')
  if (at <= 0 || at !== value.indexOf('@')) return false
  return LOCAL.test(value.slice(0, at)) && DOMAIN.test(value.slice(at + 1))
}

/** Parse the raw URL segment. */
export function parseShopHandle(raw: string | undefined, defaultDomain = DEFAULT_HANDLE_DOMAIN): ShopHandle {
  if (!raw) return { kind: 'invalid' }
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return { kind: 'invalid' }
  }
  const value = decoded.trim().toLowerCase()
  const nip05 = value.includes('@') ? value : `${value}@${defaultDomain}`
  if (!isNip05(nip05)) return { kind: 'invalid' }
  const [local, domain] = nip05.split('@')
  // `_@imani.casa` has no bare form: `/shop/_` would read as nothing.
  const canonical = domain === defaultDomain && local !== '_' ? local : nip05
  return { kind: 'ok', nip05, canonical, redirect: canonical !== decoded.trim() }
}

/** Normalise a recipient handle typed by the buyer: lower case, leading `@` dropped, bare → default domain. */
export function normaliseRecipientHandle(raw: string, defaultDomain = DEFAULT_HANDLE_DOMAIN): string | null {
  const value = raw.trim().replace(/^@/, '').toLowerCase()
  if (value === '') return null
  const nip05 = value.includes('@') ? value : `${value}@${defaultDomain}`
  return isNip05(nip05) ? nip05 : null
}
