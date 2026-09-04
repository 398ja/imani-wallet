# What is actually outstanding

All 18 tickets across both specs are marked done and all 82 acceptance
criteria are checked. That is true at the level the tickets are written — the
rules, the enforcement points and the screens all exist and are tested,
several against real gateway-minted artefacts and a live mint.

But the tickets were scoped as units of behaviour, not as an end-to-end
journey, and three seams between them were never anybody's ticket. None is a
bug in what was built; each is a connection nothing asked for.

Recorded here rather than left implicit, because "18/18 done" reads as
"a merchant can run a second till today", and they cannot.

## 1. Enrolment never calls the mint

`TerminalEnrolPage` calls `prepareEnrolment`, which returns exactly what the
credential must contain, and then records the roster row. It never mints.

Ticket 05 said this explicitly — "NOT landed: the mint call alone" — and
ticket 10 built the minting, as `scripts/mint-terminal-credential.mjs`. But
nothing connected the two: the script is run by hand, and the screen still
produces a roster entry with no credential behind it.

So an owner completing the enrolment screen gets a terminal in their list
that no device can ever log in as.

**What it needs:** the screen calls the same wallet-tier endpoint the script
does, then passes the resulting token to the device. The rules, the shape and
the delivery are all built and tested; this is the wiring.

## 2. There is no device-side enrolment screen

`terminalEnrol.ts` has `beginEnrolment` (mint a key, show its public half) and
`completeEnrolment` (verify and store), both tested. No page calls either.

Ticket 04 built the device side as a module; every ticket after it assumed a
device that was already enrolled, and the tests seed that state directly. So
the QR a terminal is supposed to display has no screen to display it on.

**What it needs:** a screen that shows `beginEnrolment().uri` as a QR, waits
for the owner's scan, and calls `completeEnrolment` with the returned
credential and a passphrase.

## 3. Login never asks the mint whether the credential is still live

`useTerminalIdentity` takes an optional mint client. `App` calls it with none.

With no client, `unspent` is always `null`, which `loginTerminal` reads as "we
could not ask" — so every terminal opens on REDUCED authority (redemption
only, never issuance), and a revoked credential is never detected at login.

Failing safe rather than open, which is why this is a limitation and not a
vulnerability: a revoked terminal still cannot issue, and `issueAndDeliver`
refuses it independently. But revocation does not bite where the spec says it
does, and no full till can ever sell.

**What it needs:** `App` passes the same `legacyApi()` client
`SecurityPage` already uses for decommissioning.

## What IS wired and working

Worth stating, so this reads as a list of seams rather than a verdict on the
work:

- The owner's own device is unaffected by every terminal rule, checked in a
  real browser after each one.
- Role gating, the lapse notice, the dashboard guard, decommissioning and the
  lapse markers all run in the shipped app (47 browser checks).
- Revocation genuinely spends at the mint, and verification genuinely does
  not — observed against cashu-mint 0.35.0.
- Subscriptions are complete end to end: a real gateway-minted licence is
  sold, delivered, verified, expires, and gates enrolment.
