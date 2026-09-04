# 05: Terminal enrolment, the owner side

**What to build:** A stall owner can put a device on the counter. They name the
terminal, choose its role, scan the code the device is showing, and issue it its
authority. The terminal is live at the end of this, and the owner keeps whatever
is needed to revoke it later without the device present.

Enrolment needs connectivity, and there is no degraded path: the authority has to
be created, and creating it is an online act. The owner is told so, so that
terminals are set up before the market opens rather than during the first queue.
Pre-issuing a stock of unassigned terminal authorities is deliberately not
offered, as those would be credentials to the stall sitting in a drawer.

**Blocked by:** 01, 04

**Status:** part-landed — the rules and the credential are built and tested; the SCREEN and the mint call remain

- [x] The owner names a terminal and picks a role from the fixed catalog; a
      terminal cannot go live without a role.
- [x] Scanning the device's code and confirming issues its authority.
- [x] The owner retains the means to revoke this terminal later without the device.
- [x] Enrolment requires connectivity, and says so plainly rather than failing
      obscurely.
- [x] Authority is issued for the owner's own stall, and cannot be issued for
      another.

## What has landed

`src/lib/terminalIssue.ts`: `checkEnrolment` and `prepareEnrolment`. The rules,
not the form.

- **No role, no terminal.** There is no default, because a default would be the
  app deciding what a device may do.
- **The stall comes from the session, never the request.** Made structural: a
  test smuggles `stallPubkey`, `issuerPubkey` and `stall` into the request and
  asserts the issued credential names the owner's stall and mentions the other
  nowhere. That is the fifth criterion attacked rather than confirmed.
- **The owner's own device is refused.** Terminal 1 is counted, not converted;
  enrolling it would hand the stall a second, weaker authority over its own
  business.
- **Offline is refused with a sentence, last.** It is the only refusal that
  might fix itself, and the spec rules out pre-issuing unassigned credentials —
  bearer authorities to the stall sitting in a drawer.
- **The subscription gate is consulted HERE**, at the point of enrolment, which
  closes subscriptions ticket 07's first criterion: refused at enrolment rather
  than by hiding a button. The refusal message is passed through from `mayEnrol`
  verbatim rather than reworded, so there is one sentence per situation.

NOT landed: the screen itself, and the mint call. `prepareEnrolment` returns
exactly what the credential must contain, so ticket 10 adds a network round trip
and no rules.

## Evidence

16 tests, run against the REAL gateway-minted licence so the gate is exercised
by the artefact a customer would hold.

Two of them are the end-to-end handshake — the device shows a key, the owner
issues authority for it, the device stores and reuses it — which is the property
neither ticket 04 nor 05 can assert alone. The second proves a credential
prepared for one terminal is rejected by another, which is the photographed-QR
case end to end.

Mutation controls:

- Dropping the subscription gate — 2 failures.
- Taking the stall from the request instead of the session — SURVIVED at first,
  because nothing supplied one. The smuggling test above was written for it, and
  the mutant now fails.
