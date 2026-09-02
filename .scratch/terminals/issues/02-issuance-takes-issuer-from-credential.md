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

**Status:** ready-for-agent

- [ ] A coupon issued through a credential carries the stall named in that
      credential.
- [ ] Issuance with no credential is refused, and does not fall back to the
      session.
- [ ] A caller cannot supply the issuer directly; it is read from the verified
      credential only.
- [ ] A stall issuing on its own device is unaffected, and its coupons are stamped
      exactly as they are today.
