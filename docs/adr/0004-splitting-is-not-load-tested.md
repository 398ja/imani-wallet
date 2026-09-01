# Splitting is not load tested either

[ADR 0003](./0003-redemption-is-not-load-tested.md) records why redemption has
no gateway scenario. **Splitting** turns out to be the same case, discovered
the same way, and it is worth recording separately because a reader looking for
a split scenario will not think to look under redemption.

A split divides one coupon into a spent part and a returned remainder. Like
redemption, it happens on the customer's own device, and the gateway refuses to
do it:

    Voucher split execution is not supported on JdbcWalletPort — the
    customer-wallet is self-custodial (Constitution Principle II). Voucher
    state is client-held; the backend MUST NOT persist vouchers, proofs, or
    balances.

The obvious alternative was to load test it like sending or issuance. We
rejected it because there is nothing on the gateway to measure. Building a
network path in order to measure one would install exactly the dependency
self-custody exists to avoid, and a green result on that path would then read
as evidence that splitting is healthy while measuring something no correct
client does.

This was not a design decision made in advance. It was found by pointing a load
script at `/api/v1/wallet/vouchers/split` and reading why it answered 500.

## Consequences

- `splitCoupon()` in the gateway suite is exported and **throws**, carrying this
  reasoning. An absence would read as an oversight; a refusal with a reason does
  not.
- Splitting's cost belongs in the browser suite, alongside redemption, where the
  work actually happens. Spend-plan construction against a large coupon set is
  where a climbing cost would hurt, and that is a device measurement.
- The same test applies to any future flow: if the customer gateway refuses it
  as self-custodial, it has no gateway scenario, and the question becomes what
  it costs on the device instead.
- If splitting ever gains a network path, this decision is void. The presence of
  such a path is itself the signal to revisit, and to ask whether it should
  exist at all.
