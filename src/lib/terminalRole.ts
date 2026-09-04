/**
 * What a terminal may do, and for which stall.
 *
 * Terminals ticket 01. It ships no screen on purpose: the stall parameter on a
 * granted permission is the boundary between one stall's terminals and every
 * other stall's business, and the spec calls it "the riskiest single line in
 * the feature". It is settled and attacked here, alone, rather than arrived at
 * while building an enrolment flow.
 *
 * ## The shape, and why the stall is in the string
 *
 * A granted permission is `voucher:redeem:<stall pubkey>`, not a bare
 * `redeem`. The stall is IN the permission rather than beside it because the
 * thing that checks permissions checks strings: NAP's registry validates grant
 * output, and `@PreAuthorize("hasAuthority(...)")` on the gateway compares
 * authorities. A bare role would authorise a terminal against every stall on
 * the deployment, and nothing in either check would notice — the terminal would
 * hold "may redeem" and every stall's endpoint would agree.
 *
 * So `permissionFor` takes a stall and cannot be called without one. There is
 * no overload, no default, and no "current stall" read from anywhere: the
 * caller has to say whose authority this is, every time.
 *
 * ## Roles are a closed catalog
 *
 * Two, and adding a third is a deliberate act. `roleOf` refuses anything else
 * rather than passing it through, because a role that arrives from a voucher
 * tag is data from outside — it has been through a mint and a QR code — and an
 * unknown role must be a denial rather than an empty permission list that some
 * later check reads as "no restrictions".
 *
 * ## Vocabulary
 *
 * Terminals and stalls, per CONTEXT.md. Not subaccounts, not employees, not
 * merchants, not tills.
 */

/**
 * The jobs a device can be put on a counter to do.
 *
 * `REDEEM_ONLY` is the door: honour this stall's coupons and nothing else.
 * `ISSUE_AND_REDEEM` is the counter: sell as well.
 *
 * Deliberately not a permission list. A role is what an owner CHOOSES, in the
 * words they would use; the permissions are derived. Letting an owner assemble
 * arbitrary permission sets would be per-terminal policy, which the spec puts
 * out of scope ("no policy beyond the role").
 */
export const TERMINAL_ROLES = {
  REDEEM_ONLY: 'redeem-only',
  ISSUE_AND_REDEEM: 'issue-and-redeem',
} as const

export type TerminalRole = (typeof TERMINAL_ROLES)[keyof typeof TERMINAL_ROLES]

/** Every role, for a picker that must not invent one. */
export const ALL_TERMINAL_ROLES: readonly TerminalRole[] = Object.values(TERMINAL_ROLES)

/**
 * What an owner sees when choosing. Kept beside the catalog so a new role
 * cannot be added without someone writing the words for it.
 *
 * House voice, matching every `SettingRow` in the app: a sentence-case name and
 * a hint that is a NOUN PHRASE with no terminal punctuation ("Categories,
 * location, voucher currency"). Full sentences here would read as instructions
 * in a list that is really a set of labels.
 *
 * Named for what the device DOES rather than for what it is denied. "Redemption
 * only" is the job at the door; describing it as "cannot sell" would put the
 * limitation first, and an owner is choosing a purpose rather than declining a
 * feature.
 */
export const TERMINAL_ROLE_LABELS: Record<TerminalRole, { name: string; hint: string }> = {
  [TERMINAL_ROLES.REDEEM_ONLY]: {
    name: 'Redemption only',
    hint: 'Honours your coupons, cannot sell',
  },
  [TERMINAL_ROLES.ISSUE_AND_REDEEM]: {
    name: 'Sell and redeem',
    hint: 'A full till: sells and honours',
  },
}

/**
 * A role from untrusted input, or null.
 *
 * Null rather than a default, and rather than a throw. The input reaches here
 * from a voucher tag — through a mint and a QR code — so an unrecognised value
 * is not a programming error, it is a credential this deployment cannot honour.
 * Defaulting to the weaker role would be a silent downgrade that a terminal
 * could not distinguish from working correctly; defaulting to the stronger one
 * needs no explanation.
 */
export function roleOf(value: unknown): TerminalRole | null {
  return typeof value === 'string' && (ALL_TERMINAL_ROLES as readonly string[]).includes(value)
    ? (value as TerminalRole)
    : null
}

/**
 * The actions a terminal can hold, before a stall is attached.
 *
 * Not permissions yet — deliberately a separate type, so that the only way to
 * reach a real permission string is through a function that demands a stall.
 */
export const TERMINAL_ACTIONS = {
  REDEEM: 'voucher:redeem',
  ISSUE: 'voucher:issue',
} as const

export type TerminalAction = (typeof TERMINAL_ACTIONS)[keyof typeof TERMINAL_ACTIONS]

/** What each role does. The whole of the role-to-action mapping. */
const ROLE_ACTIONS: Record<TerminalRole, readonly TerminalAction[]> = {
  // Redemption must never need the network to authorise it, and it is the one
  // action that carries no value out of the stall — so it is the floor.
  [TERMINAL_ROLES.REDEEM_ONLY]: [TERMINAL_ACTIONS.REDEEM],
  // Issuance is value-bearing and additive: a full till redeems too.
  [TERMINAL_ROLES.ISSUE_AND_REDEEM]: [TERMINAL_ACTIONS.ISSUE, TERMINAL_ACTIONS.REDEEM],
}

/** A stall pubkey: 32-byte hex, lowercased. */
const STALL_PUBKEY = /^[0-9a-f]{64}$/

/**
 * One permission, bound to one stall.
 *
 * The ONLY way to build a permission string in this module. There is no
 * `permission(action)` without a stall, because a bare permission is the bug
 * this ticket exists to prevent and an unused-but-available constructor is how
 * it would come back.
 *
 * Throws on a malformed stall rather than emitting something. An authority
 * string is compared, not parsed, so `voucher:redeem:undefined` would be a
 * permission that silently matches nothing — or worse, matches another
 * malformed one. Refusing to construct it keeps the mistake at the call site.
 */
export function permissionFor(action: TerminalAction, stallPubkey: string): string {
  const stall = stallPubkey.trim().toLowerCase()
  if (!STALL_PUBKEY.test(stall)) {
    throw new Error('a terminal permission must name the stall it was granted for')
  }
  return `${action}:${stall}`
}

/**
 * Everything a terminal with this role may do for this stall.
 *
 * This is `grant()` in the spec's terms: the output a NAP session's permissions
 * are derived from. Every string it returns names the stall, so a session built
 * from it cannot be replayed against another.
 */
export function grantFor(role: TerminalRole, stallPubkey: string): readonly string[] {
  return ROLE_ACTIONS[role].map((action) => permissionFor(action, stallPubkey))
}

/**
 * May a terminal holding these permissions take this action for THIS stall?
 *
 * The stall is a required argument for the same reason it is in the string. A
 * check that took only the action would answer "yes, for somebody" — which is
 * exactly the cross-stall hole, phrased as a helper.
 *
 * An empty permission list is a denial like any other, matching `canTrade` in
 * `merchant.ts`: treating silence as consent is what an authorization check
 * must not do.
 */
export function mayAct(
  permissions: readonly string[],
  action: TerminalAction,
  stallPubkey: string,
): boolean {
  let required: string
  try {
    required = permissionFor(action, stallPubkey)
  } catch {
    // No stall, no authority. A caller that cannot name the stall is a caller
    // that has not established one.
    return false
  }
  return permissions.includes(required)
}

/**
 * The permissions a role should produce, checked against what it did.
 *
 * The spec asks that granted output be "validated against the permission
 * registry, and an undeclared role or permission is a denial rather than a
 * silent pass". This is that check, kept separate from `grantFor` so it can be
 * run over permissions that came from ANYWHERE — a session the gateway
 * returned, a voucher tag — not only over ones this module just built.
 *
 * Refuses on: an unknown role, a permission that is not in the catalog at all,
 * and a permission for a different stall. That last one is the adversarial
 * case: a session carrying `voucher:issue:<other stall>` is not a weaker
 * session, it is a session for someone else's business.
 */
export function isValidGrant(
  permissions: readonly string[],
  role: unknown,
  stallPubkey: string,
): boolean {
  const known = roleOf(role)
  if (!known) return false

  let expected: readonly string[]
  try {
    expected = grantFor(known, stallPubkey)
  } catch {
    return false
  }

  // Exactly the expected set: no extras, in any order. Subset would let a
  // redeem-only terminal carry an issue permission unnoticed; superset would
  // let anything the registry does not declare ride along.
  return (
    permissions.length === expected.length &&
    expected.every((p) => permissions.includes(p))
  )
}
