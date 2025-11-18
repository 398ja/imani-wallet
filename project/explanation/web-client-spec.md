# Web Client Specification for Voucher Management

This document defines the initial specification for a web client that manages user identities and wallets to issue, send, and receive Cashu vouchers. It covers goals, scope, architecture, and high-level requirements so implementation can begin with clear alignment across product, design, and engineering.

## Goals
- Deliver a browser-based experience for issuing, sending, and redeeming vouchers backed by a Cashu wallet.
- Provide seamless identity management so users can bind vouchers to identities and recover them.
- Prioritize security, transparency, and auditability for financial operations while keeping UX approachable.
- Ensure interoperability with existing Cashu services (mints, relays, identity providers) and compatibility with Java 21 backend services.

## Non-goals
- Replacing existing CLI tooling (web client complements CLI flows).
- Implementing mint or relay services (client consumes existing services).
- Providing custodial key management; keys remain client-side.

## Personas
- **New user**: Wants a quick path to create an identity, fund a wallet, and receive vouchers.
- **Issuer**: Creates vouchers tied to an identity and shares them securely.
- **Recipient**: Redeems received vouchers into a wallet with clear status feedback.
- **Support/Ops**: Needs observability, audit trails, and error context for troubleshooting.

## Functional scope
- Identity lifecycle: creation, import/export (mnemonic or NIP-XX seed), rotation, recovery, and linking to wallet instances.
- Wallet management: connect to configured mints, view balances by unit, configure default mint, and manage keysets.
- Voucher flows:
  - **Issue**: generate voucher, bind to identity, set face value/unit, expiry, usage cap, and redemption policy.
  - **Send**: share voucher via URL/QR with optional nostr relay delivery and metadata (memo, intended recipient pubkey).
  - **Receive/Redeem**: validate voucher authenticity, check status (unspent/spent/expired), redeem into wallet, and record provenance.
  - **Track**: display voucher status timeline (issued → delivered → redeemed/expired) with refresh and manual sync controls.
- Security and privacy features: client-side signing, encrypted storage for secrets, configurable relay list, domain allowlist for mints/relays, and warning banners for untrusted endpoints.
- Notifications: in-app toasts/banners for state changes; optional webhook/nostr events for delivery confirmation where available.
- Settings: network selection (mainnet/testnet), language preference, theme, and telemetry opt-in.

## Non-functional requirements
- **Security**: Zero-knowledge of secrets on the server; enforce HTTPS, Content Security Policy, and key material isolation. Align errors with standard error codes in wallet operations for observability.
- **Performance**: Initial load < 3s on broadband; voucher actions complete < 2s p50 against healthy mint/relay.
- **Reliability**: Offline-tolerant UI with queued actions where feasible; idempotent redemption to avoid double-spend.
- **Accessibility**: WCAG 2.1 AA; keyboard navigation and screen-reader labels on actionable controls.
- **Auditability**: Persist client-side event log (time, action, mint/relay URL, amounts) exportable as JSON for support.

## High-level architecture
- **Frontend stack**: Web client using modular component library (framework-agnostic in spec; target React/Vue in implementation). Strong typing and test coverage with unit and integration tests per module.
- **State management**: Store identity, wallet balances, voucher drafts/status in a secure state container with persistence guarded by encryption (e.g., Web Crypto). Derive UI views from immutable state snapshots to simplify testing.
- **API integrations**:
  - Wallet/mint APIs for quotes, proofs, redemption, and keyset discovery aligned with NUT specifications.
  - Identity service/nostr relay for publishing voucher payloads and verifying ownership (AUTH/DM depending on relay capability).
  - Telemetry/observability endpoints for structured logs and metrics (per observability SPI guidance).
- **Modules**:
  - Identity module (key management, backup/recovery, relay auth flow).
  - Wallet module (mint connections, balances, proof store interaction).
  - Voucher module (issue, send, redeem flows with validation and status polling/sync).
  - Sharing module (QR/URL generation, nostr delivery, clipboard helpers).
  - Settings/Policy module (network, language, mint/relay allowlists, telemetry toggle).
  - Audit/Activity module (local event log, export, filtering by voucher or mint).

## User flows
1. **Onboarding**: Create or import identity → configure default mint/relay → secure local backup → optional test voucher issuance for verification.
2. **Issue voucher**: Choose mint and amount/unit → set expiry and usage policy → bind to identity and sign → receive voucher payload/URL/QR → deliver via relay or share out-of-band.
3. **Send voucher**: Select existing voucher → pick recipient channel (nostr relay, QR, copy link) → optionally encrypt for recipient pubkey → track delivery status.
4. **Receive voucher**: Paste/scan voucher → validate signature and mint allowlist → show breakdown (unit, amount, expiry) → redeem to wallet with progress indicators → refresh status and update audit log.
5. **Recovery**: Import identity seed → resync mint keysets → restore voucher statuses via relay history or provided payloads → reconcile balances and highlight conflicts.

## Data model (conceptual)
- Identity: public key, mnemonic/seed reference (never stored raw), relay list, verification status.
- Wallet: default mint, keysets, balance by unit, pending operations.
- Voucher: id, face value/unit, issuer identity, expiry, redemption policy, delivery metadata (relay/url), status, history events.
- Audit event: timestamp, actor identity, action type, mint/relay URL, amounts, result (success/failure), correlation id.

## Security and compliance considerations
- Enforce mint/relay allowlists with user confirmation for new endpoints; display issuer domain on vouchers.
- Use client-side encryption for stored seeds and vouchers; require passphrase/unlock timer.
- Sign all voucher operations with identity keys; include replay protection (nonces/timestamps) per NUT guidance.
- Provide explicit warnings for expired/unknown keysets and block redemption when validation fails.
- Implement structured error handling aligned with wallet standard error codes for consistent UX and logging.

## Observability
- Collect client-side metrics: voucher issuance time, redemption latency, relay delivery success rate, error codes frequency.
- Emit structured logs with correlation ids per operation; allow export for support without exposing secrets.
- Surface health indicators for configured mints/relays (latency, last success) to guide users.

## Milestones and deliverables
1. **M1**: UI skeleton, onboarding, identity create/import, mint configuration, basic wallet balance view.
2. **M2**: Voucher issuance and sharing (URL/QR) with audit log and status display.
3. **M3**: Voucher redemption with validation, error surfacing, and status sync; recipient flow hardened.
4. **M4**: Relay delivery integration, notifications, offline queueing for sends/redeems.
5. **M5**: Hardening (accessibility, localization, telemetry opt-in, exportable logs) and production readiness checklist.

## Open questions
- Which framework and component library should be standardized (React + design system vs. lightweight alternative)?
- How should nostr relay authentication be handled across tabs/sessions to avoid redundant prompts?
- What SLA/timeout defaults should be imposed per mint/relay, and how are backoff/retries exposed in the UI?
- Do we require multi-identity profiles in one browser profile, and how is separation enforced?
- Should voucher drafts be shareable across devices, and if so what storage/transport is acceptable?
