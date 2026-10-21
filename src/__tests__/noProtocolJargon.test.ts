/**
 * Guard for #324: users never see protocol jargon or raw keys.
 *
 * The owner's rule: no npub, nsec, hex pubkeys, "relay", "NIP-05"/"NIP-xx",
 * "pubkey" or "Nostr" in anything a person reads. People are shown with the
 * profile component (avatar, name, handle); a key appears only where the user
 * must act on one (exporting or entering the backup key), and even there the
 * words are plain: "backup key", "account key", "handle".
 *
 * This scans the copy in `src/pages` and `src/components` with the TypeScript
 * parser (see `userFacingStrings.ts`): JSX text, text props such as
 * placeholder / aria-label / title / alt / label, literals inside JSX
 * expressions, message sinks (alert, confirm, toast*, set*Error, set*Status,
 * set*Notice), `new Error(...)` messages, and prose held in constants. Comments,
 * imports, identifiers, comparisons, console output and tests are not copy and
 * are never read.
 *
 * Library errors that reach the screen are covered separately: every page sink
 * goes through `userMessage`, whose own test lives beside it.
 */
import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

import { collectUserStrings, type UserString } from './userFacingStrings'
import { JARGON } from '../lib/userMessage'
import { LOGOUT_BLOCKED_COPY, LOGOUT_WARNING } from '../lib/logout'
import { blockedMessage } from '../lib/logoutBlockedCopy'
import { RECEIVE_PAUSED_MESSAGE } from '../lib/giftLinks'
import { SWAP_BACK_PAUSED_MESSAGE } from '../lib/swapBack'
import { SPEND_PAUSED_MESSAGE } from '../lib/receiveGate'
import { OTHER_WALLET_COPY } from '../lib/keySlotGuard'
import { TERMS_NOT_ACCEPTED_COPY, TERMS_NOT_CONFIGURED_COPY } from '../lib/terms'
import { CASHLINK_EXPIRED_RETURNED_BODY, CASHLINK_EXPIRED_TITLE, CASHLINK_EXPIRED_WAITING_BODY } from '../lib/cashlinkExpiryNotice'
import { GIFT_EXPIRES_SOON_COPY, GIFT_NOT_YET_COPY, expiryLimitCopy } from '../lib/giftLink'
import { tooManyExpiredMessage, tooManyLinksMessage } from '../lib/giftLinks'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCANNED = ['src/pages', 'src/components']

/**
 * The ONLY places a term may appear, each with the reason and an exact text so a
 * new string on the same screen is still caught. Keep this short: an entry is a
 * decision that a user must see this word, not a way to silence the test.
 *
 * Every entry must still match something, so a fixed string cannot leave a
 * stale exemption behind (see the last test).
 */
const ALLOWED: Array<{ file: string; text: string; why: string }> = []

const allowed = (s: UserString) => ALLOWED.some((a) => a.file === s.file && s.text.includes(a.text))

describe('no protocol jargon in the UI (#324)', () => {
  const strings = collectUserStrings(ROOT, SCANNED)

  it('actually reads the copy (the scanner is not silently empty)', () => {
    // A broken scanner reports zero violations and passes forever. These are
    // ordinary strings that exist today in different positions: JSX text, a
    // placeholder, and a message sink.
    const texts = strings.map((s) => s.text)
    expect(strings.length).toBeGreaterThan(500)
    expect(texts).toContain('Receive')
    expect(texts).toContain('Passphrase')
    expect(texts.some((t) => t.includes('Paste the code'))).toBe(true)
    // #332's prompt and the profile card's Finish copy are read too.
    expect(strings.some((s) => s.file.endsWith('FinishProfilePrompt.tsx'))).toBe(true)
    expect(texts.some((t) => t.includes('Every account has a handle'))).toBe(true)
  })

  it('finds no npub, nsec, nostr, relay, NIP-xx or pubkey in user-facing strings', () => {
    const violations = strings
      .filter((s) => JARGON.test(s.text) && !allowed(s))
      .map((s) => `${s.file}:${s.line}  ${JSON.stringify(s.text)}`)
    expect(violations).toEqual([])
  })

  it('names key-entry fields in plain words, never "nsec"', () => {
    // The owner's note on #324: the login key field showed "nsec". Every field
    // that takes a key says "key" / "backup key"; the input still ACCEPTS an
    // nsec (lib/nap toPrivkeyHex), only the wording is constrained.
    const keyFieldCopy = strings.filter(
      (s) => /\bkey\b/i.test(s.text) && /paste|enter|your/i.test(s.text) && !allowed(s),
    )
    for (const s of keyFieldCopy) expect(s.text, `${s.file}:${s.line}`).not.toMatch(/nsec|npub|hex/i)
  })

  it('keeps no stale allow-list entries', () => {
    const stale = ALLOWED.filter((a) => !strings.some((s) => s.file === a.file && s.text.includes(a.text)))
    expect(stale.map((a) => `${a.file}: ${a.text}`)).toEqual([])
  })

  // The screens #326 and #327 added. Their copy must be read by the scanner
  // (so a jargon word there fails the test above), and the logout copy that
  // lives in src/lib, outside the scanned folders, is checked directly.
  it.each([
    ['src/components/LogoutBlocked.tsx', 'Logout block'],
    ['src/components/BackupLogin.tsx', 'Where is your backup?'],
    ['src/components/FinishProfileStep.tsx', 'Finish your profile'],
    // #357: the Terms and Conditions checkbox (account step and Finish your profile).
    ['src/components/TermsCheckbox.tsx', 'Terms and Conditions'],
  ])('scans %s (%s)', (file, text) => {
    const own = strings.filter((s) => s.file === file)
    expect(own.length).toBeGreaterThan(0)
    if (text !== 'Logout block') expect(own.some((s) => s.text.includes(text))).toBe(true)
    for (const s of own) expect(s.text, `${s.file}:${s.line}`).not.toMatch(JARGON)
  })

  it('the logout block and warning say "key" but no Nostr, npub, nsec, relay or NIP words', () => {
    const coupon = { status: 'spendable', face_value: 500, face_unit: 'GBP', face_decimals: 2 } as never
    const copy = [
      LOGOUT_WARNING,
      ...Object.values(LOGOUT_BLOCKED_COPY).filter((v): v is string => typeof v === 'string'),
      LOGOUT_BLOCKED_COPY.unconfirmed(1, '£5.00'),
      LOGOUT_BLOCKED_COPY.unconfirmed(3, '£15.00'),
      // #331: the cashback stash block, and the gift paused while logging out.
      LOGOUT_BLOCKED_COPY.cashbackUnconfirmed(1),
      LOGOUT_BLOCKED_COPY.cashbackUnconfirmed(2),
      RECEIVE_PAUSED_MESSAGE,
      SWAP_BACK_PAUSED_MESSAGE,
      SPEND_PAUSED_MESSAGE,
      OTHER_WALLET_COPY,
      // #357: the Terms and Conditions refusals, rendered from src/lib.
      TERMS_NOT_CONFIGURED_COPY,
      TERMS_NOT_ACCEPTED_COPY,
      // #295 phase 0: the Cashlink limits, picker reasons, expiry choices and the bell entry.
      CASHLINK_EXPIRED_TITLE,
      CASHLINK_EXPIRED_WAITING_BODY,
      CASHLINK_EXPIRED_RETURNED_BODY,
      GIFT_NOT_YET_COPY,
      GIFT_EXPIRES_SOON_COPY,
      expiryLimitCopy(Date.UTC(2026, 10, 1), () => '1 November 2026'),
      tooManyLinksMessage(),
      tooManyExpiredMessage(),
      blockedMessage({ status: 'blocked', reason: 'other-tab', unconfirmed: [] }),
      ...(
        ['unconfirmed', 'locked', 'store-unreadable', 'changed', 'in-flight', 'cashback-unconfirmed'] as const
      ).map((reason) => blockedMessage({ status: 'blocked', reason, unconfirmed: [coupon], cashback: 1 })),
    ]
    for (const text of copy) {
      expect(text).not.toMatch(JARGON)
      expect(text).not.toMatch(/nostr|npub|nsec|relay|\bNIP/i)
    }
    expect(LOGOUT_WARNING).toMatch(/backup key/)
  })
})
