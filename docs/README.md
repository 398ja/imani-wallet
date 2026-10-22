# Imani Wallet docs

The wallet's guides, explanations, specs and design notes live in the
**imani-docs** repository, under `wallet/`. Its index is
`imani-docs/wallet/README.md`, and the series is also linked from the
imani-docs `README.md` (Diátaxis: tutorials, how-to, reference, explanation).

What stays here, beside the code:

- [adr/](adr) — architecture decision records.
- [research/](research) — research notes.

## Where each moved page is now

| Was | Now |
|---|---|
| `docs/customers.md` | `imani-docs/wallet/customers.md` |
| `docs/merchants.md` | `imani-docs/wallet/merchants.md` |
| `docs/terminals.md` | `imani-docs/wallet/terminals.md` |
| `docs/how-it-works.md` | `imani-docs/wallet/how-it-works.md` |
| `docs/decentralised-posture.md` | `imani-docs/wallet/decentralised-posture.md` |
| `docs/redemption-ledger-user-guide.md` | `imani-docs/wallet/redemption-ledger-user-guide.md` |
| `docs/redemption-ledger-technical-guide.md` | `imani-docs/wallet/redemption-ledger-technical-guide.md` |
| `docs/card-payments-locally.md` | `imani-docs/wallet/card-payments-locally.md` |
| `docs/native-push-activation.md` | `imani-docs/wallet/native-push-activation.md` |
| `docs/explanation/*.md` | `imani-docs/wallet/explanation/*.md` |
| `docs/spec-claim-links.md` | `imani-docs/wallet/spec-claim-links.md` |
| `docs/spec-terminals-in-service.md` | `imani-docs/wallet/spec-terminals-in-service.md` |
| `docs/design-226-licence-revocation.md` | `imani-docs/wallet/design-226-licence-revocation.md` |
| Handoffs, plans, replies and other design notes | `imani-docs/wallet/` under the same file name |
| `docs/screenshots/` | `imani-docs/wallet/screenshots/` |

## Changing user-facing behaviour

A PR that changes what a shopper or merchant sees updates the matching guide in
**imani-docs** (`wallet/customers.md`, `wallet/merchants.md`,
`wallet/terminals.md`), not a file here. Say so in the PR description and link
the imani-docs change. ADRs and research notes are still edited in this repo.
