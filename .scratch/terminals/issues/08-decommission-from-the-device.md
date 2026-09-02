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

**Status:** ready-for-agent

- [ ] Decommissioning revokes the terminal's authority before erasing anything.
- [ ] A failed revocation does not wipe and does not report success.
- [ ] After decommissioning, the device cannot act for the stall.
- [ ] The wording is written for a terminal, and promises no self-service recovery.
- [ ] A person logging out of their own wallet sees the existing wording,
      unchanged.
