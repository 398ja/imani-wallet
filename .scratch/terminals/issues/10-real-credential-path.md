# 10: The real credential path

**What to build:** Replace the stand-in a terminal has been carrying with the
real thing: authority that is cryptographically locked to the key the terminal
generated, verified at login, and genuinely revocable by spending it.

This is what makes every earlier ticket's promise true rather than merely
demonstrated. Enrolment issues a real locked credential, login verifies it and
derives the terminal's permissions from it, and revocation is the act of spending
it, which is why a revoked terminal cannot come back.

Two behaviours arrive here that the stand-in could only imitate. A terminal's
session lives at most one trading day, which is the window in which a revoked
terminal still works. And when the network is unreliable a terminal may still be
admitted on reduced authority, redemption only, because a queue cannot wait but
issuance is value-bearing.

**Blocked by:** 02, 04, 05. The upstream composite voucher kind **has now
landed**: cashu-lib 0.29.0, cashu-voucher 0.13.0 and cashu-mint 0.35.0 are
released and pinned together in `imani-bom`, with the mint enforcing the voucher
conditions and the P2PK witness together. This ticket is no longer blocked
upstream and can start once 02, 04 and 05 are done.

Note the pin is a set: a 0.29.0 cashu-lib against a mint older than 0.35.0
dispatches the kind to a condition that never checks a witness, which makes the
lock advisory and defeats the whole point.

**Status:** done

- [x] Enrolment issues authority locked to the key the terminal generated.
- [x] Login verifies that lock, and authority held without the key is inert.
- [x] A terminal's permissions come from its credential rather than any stored
      record.
- [x] Authority is honoured only from issuers the mint recognises, and only for
      the stall that issued it.
- [x] Revocation spends the credential, and a revoked terminal cannot log in
      again anywhere.
- [x] A terminal's session lives at most one trading day.
- [x] With the mint unreachable, a terminal may be admitted for redemption only,
      never issuance.
- [x] Verification never spends: logging in leaves the credential live.

## What it took

`terminalCredential.ts` (the wire shape), `terminalLogin.ts` (login),
`credentialRevocation.ts` (spend-to-revoke), `useTerminalIdentity.ts` (the
wiring), and `scripts/mint-terminal-credential.mjs`.

Minting real credentials — rather than writing fixtures — is what made this
ticket worth doing, and it found two defects a full green unit suite had
passed over:

- `credentialActor` compared the stall against the voucher's
  `issuerPublicKey`, which is the GATEWAY's signing key and identical on every
  voucher it mints. It would have refused every real credential ever issued
  while passing every hand-written fixture. `issuerId` is the stall.
- The reduced-authority test was written against the redeem-only fixture,
  whose ROLE blocks issuance anyway, so a mutation forcing every session to
  FULL left it green. A second credential was minted with the issue-and-redeem
  role so the reduced session is the only thing standing between that till and
  minting money.

## Evidence

Proven against the real mint (cashu-mint 0.35.0), not mocks:

    three consecutive checkstate calls -> UNSPENT, UNSPENT, UNSPENT
    receive (the revocation)           -> 200
    checkstate after                   -> SPENT

Both halves matter: "checking never spends" would also pass against a mint
that ignored us entirely, so the spend is what gives it meaning. The
destructive half is env-gated and was run against a throwaway credential, so
the committed fixture is still live. See `e2e/probe-spend.mts`.

53 tests across the four modules. Mutation controls, all caught, including:
the state check spending (4 failures), unreachable read as revoked, revoking a
non-credential, and trusting the stored record over the credential.

One mutation surfaced a fragility rather than a missing test: making `deps`
unused left it in an effect dependency array and the run died with a V8
out-of-memory instead of a failed assertion — an inline client object would
loop forever, which in a browser is a tab that grinds to a halt with no
readable error. Fixed with a ref; the mutation now fails cleanly in seconds.

1873 unit tests pass, lint clean, tsc at the pre-existing 81. The 33-check
browser E2E still passes, which is what confirms the owner's own till is
untouched by any of this.

## What this unblocks

Terminals 07's role gating and lapse notice are now REACHABLE. They were built
and tested but no user could reach them, because App rendered the till with no
actor and no session. That is now wired.
