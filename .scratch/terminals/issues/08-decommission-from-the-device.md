# 08: Decommission a terminal from the device

**What to build:** A device leaving the stall can be decommissioned from the
device itself. It revokes its own authority first, then erases what it holds, so
a wiped device is not still authorised.

The order is the whole point. Wiping without revoking leaves a live authority
attached to a device nobody controls any more, which is the failure the burn
prevents. If the revocation cannot be carried out, the device says so rather than
wiping and reporting success.

The wording is a terminal's, not a customer's. The existing logout copy promises
that an account, a business, and past sales all return with a backup key, and
none of that is true here: a terminal holds no coupons, has no key its holder
should ever write down, and comes back only by being enrolled again by the owner.

**Blocked by:** 04, 06

**Status:** done

- [x] Decommissioning revokes the terminal's authority before erasing anything.
- [x] A failed revocation does not wipe and does not report success.
- [x] After decommissioning, the device cannot act for the stall.
- [x] The wording is written for a terminal, and promises no self-service recovery.
- [x] A person logging out of their own wallet sees the existing wording,
      unchanged.

## What it took

`src/lib/terminalDecommission.ts` and a terminal-specific danger zone on
`SecurityPage`.

The order is enforced structurally: `revokeCredential` first, and the erase is
unreachable unless it succeeded. `already-revoked` counts as success, because
the owner has revoked remotely and the device is finishing the job — refusing
there would strand a device that is already powerless while still holding a
key.

Reuses `logout` for the erasing rather than reimplementing it. That is where
the hard parts live: stopping the pollers before the key goes, clearing the
resume cache that would otherwise walk straight back in, and wiping every
`imani-wallet:*` key rather than a list that has already grown three times. It
is called with the confirmation ALREADY given, because `logout`'s own prompt
promises a backup key a terminal's holder does not have.

The wording criterion turned out to go further than wording. A terminal now
gets a different danger zone entirely, without the passphrase and key-reveal
panels — both are about a personal key, and a terminal's is a disposable the
owner issued authority against, never something its holder should write down.

## Evidence

16 tests. Seven mutation controls, all caught:

| Mutation | Tests killed |
| --- | --- |
| Wipe first, revoke after | 1 |
| Failed revocation wipes anyway | 2 |
| Failed revocation reports success | 2 |
| The copy promises a backup key | 1 |
| Terminal gets the customer logout copy | 3 |
| Owner loses the existing logout copy | 2 |
| Terminal shown the key-reveal panel | 2 |

The fifth criterion is asserted in both directions: a terminal must not see
the logout copy, AND an ordinary person must still see it unchanged. Every
non-terminal device takes that path, so it is the regression that would hurt
most.

1903 tests pass, lint clean, tsc at the pre-existing 81, and the 33-check
browser E2E still passes.
