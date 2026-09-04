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

**Status:** done — ticket 10 landed the real minted credential this screen issues.

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

NOT landed: the mint call alone. `prepareEnrolment` returns
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


## The screen (landed later)

`src/pages/TerminalEnrolPage.tsx` at `/settings/terminals/add`, reached from
the terminal list. Name, then role, then scan — scanning last because it is the
only step needing the other device present, and asking for it first would make
the owner hold two devices while typing.

Deliberately thin. Every rule stays in `terminalIssue.ts`; anything the form
decided for itself would be a second place the rules live.

Two properties the rules could not assert alone:

- **A scan does not enrol.** The QR is safe to observe only if seeing one
  cannot create authority.
- **The roster row is written here, on the OWNER's device**, which is what
  makes ticket 06's revocation-without-the-device possible at all.

The design pass found a real gap: no way to correct a wrong scan. Two devices
on a counter showing similar codes is ordinary, and the only remedies were to
abandon the form or enrol the wrong device. Added Rescan.

Three pre-existing, app-wide defects fell out of writing the tests:

- `Input` had a `<label>` with no `htmlFor` — tapping it did not focus the
  field, and a screen reader announced an unlabelled box. Every form uses it.
- `Alert` had no `role`, so refusals were announced to nobody.
- `prepareEnrolment` returned the loose `TerminalCredential` (fields `unknown`,
  correct for data arriving from outside) for a credential we construct
  ourselves. Now returns `PreparedCredential`.

14 screen tests. Five mutation controls, all caught: defaulting the role (2
failures), enrolling on scan (4), ignoring the check (5), storing a fixed role
(1), skipping the roster write (2).

## Verified in the real app

Everything above was originally evidenced by jsdom component tests. That
proves the component, not the product, so the terminal screens were afterwards
driven in a real browser against the running `imani-test` stack: a merchant
registers for real, then the list, revocation and enrolment screens are
clicked through. 27 checks, all passing (`npm run e2e`).

Doing that immediately found a defect no unit test could reach: registration
died with HTTP 500 because imani-gateway-core's `application.yml` spelled the
Bottin password fallback `MERCHANT_IDENTITY_BOTTIN_PASS` instead of
`..._PASSWORD`. The username resolved, the password did not, and the client
disables itself when either is blank. Fixed, image rebuilt, and the gateway
now logs `bottin_record_client_created ... auth=basic` from a clean container
with no hand-patching.


## The mint call (ticket 10)

The note above said the mint call remained. It landed with ticket 10:
`scripts/mint-terminal-credential.mjs` mints a real locked credential through
the live gateway, and `terminalCredential.ts` defines the shape both sides
read. Enrolment now issues authority a mint actually signed rather than a
record the device wrote for itself.
