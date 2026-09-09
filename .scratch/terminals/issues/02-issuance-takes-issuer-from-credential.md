# 02: Issuance takes its issuer from the credential

**What to build:** A coupon issued at any device is stamped with the stall, taken
from the verified credential the caller presented, rather than from whichever key
happens to be signed in.

Today the issuer is derived from the authenticated session, and the code says so
deliberately. That holds while a stall is one durable key and breaks the moment a
device signs in with a disposable one: coupons would be stamped with a key that
stops existing when the device is re-enrolled, leaving customers holding coupons
from an issuer nobody can honour.

Where no credential is presented, issuance is refused. Falling back to the
session pubkey is the failure this ticket exists to remove, so the fallback must
not survive as a convenience.

**Blocked by:** 01

**Status:** done

- [x] A coupon issued through a credential carries the stall named in that
      credential.
- [x] Issuance with no credential is refused, and does not fall back to the
      session.
- [x] A caller cannot supply the issuer directly; it is read from the verified
      credential only.
- [x] A stall issuing on its own device is unaffected, and its coupons are stamped
      exactly as they are today.

## What it took

`src/lib/actor.ts` answers "which stall is this?", and `issue.ts` asks it.

`IssueParams.issuerPubkey: string` became `actor: Actor`. That is the third
acceptance criterion made structural rather than documented: a caller cannot
supply the issuer because there is no longer a field to put one in. The stall is
read through `issuingStall(actor)` and nowhere else.

Two actor shapes, because the subscriptions spec settles that the owner's device
is "counted, not converted":

- `owner` — signed in as the stall, so the stall IS the session key. This is not
  the banned fallback: it is a positive claim, constructed deliberately. A stall
  issuing on its own device is unaffected.
- `terminal` — a disposable key carrying a credential that names the stall.

Both answer `stallPubkey`, so `issue.ts` asks one question and never learns which
kind of device it is on. If they diverged, every caller would need a branch, and
the branch is where the session pubkey would creep back.

`terminalActor` refuses four ways, each a refusal a caller must not talk past: a
malformed stall, a role outside the catalog, a credential not locked to THIS
device, and permissions that do not match the role for that stall. The third is
what the spec's "the enrolment QRs are safe to observe" rests on — a credential
photographed off a screen authorises nobody.

## Evidence

20 tests across `actor.test.ts` (15) and `issueActor.test.ts` (5).

Two mutation controls, and the second is the one worth recording:

- Moving the refusal to AFTER minting fails 2 tests. A late check would leave a
  minted voucher with nobody to deliver it to.
- Stamping the terminal's own key instead of the stall SURVIVED the first
  version of these tests — everything asserted `issuingStall` and nothing
  asserted the delivered payload. A test now reads the DM body and asserts the
  disposable key appears nowhere on it. That mutant now fails.
