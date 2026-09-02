# 03: Payment requests always name the stall as recipient

**What to build:** A request for payment names the stall's own key as the
recipient of whatever comes back, whoever is signed in on the device displaying
it.

Takings are gift-wrapped to the recipient's key, so a device that named itself
would collect coupons its owner cannot decrypt. That is money stranded on a
device, and it would make withdrawing a device's access a way to destroy funds
rather than only access. A terminal is an instrument for asking for payment, and
never a place money rests.

This is verifiable today, before any terminal exists, because the property is
about the request rather than about who built it.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] A payment request names the stall's key as recipient.
- [ ] The recipient does not change when the signed-in key is not the stall's.
- [ ] Takings arrive decryptable by the stall.
- [ ] A stall taking payment on its own device behaves exactly as it does today.
