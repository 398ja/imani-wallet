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

**Blocked by:** 02, 04, 05, and the upstream composite voucher kind landing in
`cashu-lib`, `cashu-voucher`, and `cashu-mint`. This ticket cannot start until
that upstream work is released; every other ticket in this set can.

**Status:** blocked

- [ ] Enrolment issues authority locked to the key the terminal generated.
- [ ] Login verifies that lock, and authority held without the key is inert.
- [ ] A terminal's permissions come from its credential rather than any stored
      record.
- [ ] Authority is honoured only from issuers the mint recognises, and only for
      the stall that issued it.
- [ ] Revocation spends the credential, and a revoked terminal cannot log in
      again anywhere.
- [ ] A terminal's session lives at most one trading day.
- [ ] With the mint unreachable, a terminal may be admitted for redemption only,
      never issuance.
- [ ] Verification never spends: logging in leaves the credential live.
