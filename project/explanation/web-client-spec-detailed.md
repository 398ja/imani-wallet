# Detailed Web Client Specification for Voucher Management

> **Document Type**: Explanation (Diátaxis)
> **Version**: 1.0.0
> **Last Updated**: 2025-11-17
> **Related Documents**:
> - [Web Client Specification (High-Level)](./web-client-spec.md)
> - [NUT Specifications Analysis for Web Client](../../docs/reference/nut-specifications-web-client-analysis.md)

This document provides detailed technical specifications for implementing the web client defined in the [high-level specification](./web-client-spec.md). It covers architecture decisions, API contracts, data models, security implementation, and deployment considerations based on the existing cashu-client codebase.

---

## Table of Contents

1. [Technology Stack](#technology-stack)
2. [Architecture](#architecture)
3. [Module Specifications](#module-specifications)
4. [API Integration Layer](#api-integration-layer)
5. [Data Models](#data-models)
6. [Security Implementation](#security-implementation)
7. [State Management](#state-management)
8. [Error Handling](#error-handling)
9. [Observability](#observability)
10. [Testing Strategy](#testing-strategy)
11. [Deployment](#deployment)
12. [Migration from CLI](#migration-from-cli)
13. [Open Questions & Decisions](#open-questions--decisions)

---

## Technology Stack

### Frontend Framework

**Recommendation: React 18+ with TypeScript**

**Rationale**:
- Strong typing support via TypeScript aligns with Java backend's type safety
- Mature ecosystem for cryptographic operations (Web Crypto API integration)
- Extensive testing tooling (Jest, React Testing Library, Playwright)
- Component-based architecture mirrors Java's modular structure
- Excellent support for Progressive Web App (PWA) features

**Alternative**: Vue 3 with TypeScript (if team preference exists)

### UI Component Library

**Recommendation: Radix UI + Tailwind CSS**

**Rationale**:
- **Radix UI**: Unstyled, accessible components (WCAG 2.1 AA compliant by default)
- **Tailwind CSS**: Utility-first CSS for rapid UI development
- No heavy framework lock-in (e.g., Material-UI, Ant Design)
- Smaller bundle size for <3s initial load requirement
- Full control over styling and theming

**Alternative**: shadcn/ui (Radix + Tailwind pre-composed components)

### State Management

**Recommendation: Zustand + Immer**

**Rationale**:
- **Zustand**: Minimal boilerplate, TypeScript-first, <1KB bundle size
- **Immer**: Immutable state updates (aligns with Java Record pattern)
- Simpler than Redux for this application scope
- Native support for localStorage persistence (with encryption wrapper)
- Easy to test with pure function state updates

**Data Flow**:
```
User Action → Action Creator → State Updater (Immer) → Zustand Store → UI Re-render
                                      ↓
                                 Side Effects (API calls, encryption)
```

### Build Tooling

**Recommendation: Vite**

**Rationale**:
- Fast cold start (<1s) and HMR for development
- Native ESM support with tree-shaking for production
- Built-in TypeScript support
- Optimized code splitting for <3s load time
- Easy PWA plugin integration

### Cryptography

**Primary**: Web Crypto API (native browser support)

**Polyfills/Libraries**:
- **@noble/secp256k1**: Schnorr signatures for P2PK (NUT-11) - used by nostr-tools
- **@noble/hashes**: HMAC-SHA256, SHA256 for NIP-44 encryption
- **@scure/bip39**: Mnemonic generation/validation for identity recovery
- **@scure/bip32**: HD key derivation for deterministic wallets (NUT-13)

**Security Considerations**:
- All key material remains in memory or encrypted localStorage
- No server-side key transmission
- Constant-time operations for MAC verification (NIP-44)
- CSPRNG (Crypto.getRandomValues) for secret generation

### API Client

**Recommendation: TanStack Query (React Query) + Axios**

**Rationale**:
- **TanStack Query**: Automatic caching, retries, optimistic updates, offline support
- **Axios**: Interceptors for authentication, error handling, request/response transformation
- Built-in request deduplication (reduces mint/relay load)
- Retry logic with exponential backoff (aligns with resilience4j in backend)

### WebSocket Management

**Recommendation: nostr-tools + Custom NUT-17 Adapter**

**Rationale**:
- **nostr-tools**: Battle-tested Nostr relay connection pooling
- Automatic reconnection with exponential backoff
- Event subscription management
- NIP-42 authentication support
- Extend for NUT-17 mint WebSocket subscriptions (JSON-RPC 2.0)

### Testing

**Unit Tests**: Vitest (Vite-native, Jest-compatible API)
**Integration Tests**: Vitest + MSW (Mock Service Worker) for API mocking
**E2E Tests**: Playwright (cross-browser, native network interception)
**Property-Based**: fast-check (equivalent to jqwik for TypeScript)

### Localization

**Recommendation: i18next + react-i18next**

**Languages (Phase 1)**: English (en-US)
**Languages (Future)**: Spanish (es), German (de), Japanese (ja)

### Accessibility

**Tools**:
- **axe-core**: Automated accessibility testing
- **eslint-plugin-jsx-a11y**: Linting for accessibility issues
- **React Aria**: Accessible interaction primitives (from Adobe)

**Targets**: WCAG 2.1 AA compliance

---

## Architecture

### High-Level Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Web Client (Browser)                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                  Presentation Layer                        │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │  │
│  │  │ Identity UI │  │ Wallet UI   │  │ Voucher UI  │  ...   │  │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘        │  │
│  └─────────┼────────────────┼────────────────┼────────────────┘  │
│            │                │                │                   │
│  ┌─────────┼────────────────┼────────────────┼────────────────┐  │
│  │         │   State Management Layer (Zustand)               │  │
│  │  ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐        │  │
│  │  │ Identity    │  │ Wallet      │  │ Voucher     │  ...   │  │
│  │  │ Store       │  │ Store       │  │ Store       │        │  │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘        │  │
│  └─────────┼────────────────┼────────────────┼────────────────┘  │
│            │                │                │                   │
│  ┌─────────┼────────────────┼────────────────┼────────────────┐  │
│  │         │    Application Service Layer                     │  │
│  │  ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐        │  │
│  │  │ Identity    │  │ Wallet      │  │ Voucher     │        │  │
│  │  │ Service     │  │ Service     │  │ Service     │  ...   │  │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘        │  │
│  └─────────┼────────────────┼────────────────┼────────────────┘  │
│            │                │                │                   │
│  ┌─────────┼────────────────┼────────────────┼────────────────┐  │
│  │         │    Infrastructure / Adapter Layer                │  │
│  │  ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐        │  │
│  │  │ Crypto      │  │ Storage     │  │ API Client  │        │  │
│  │  │ Adapter     │  │ Adapter     │  │ Adapter     │  ...   │  │
│  │  └─────────────┘  └─────────────┘  └──────┬──────┘        │  │
│  └────────────────────────────────────────────┼────────────────┘  │
│                                               │                   │
└───────────────────────────────────────────────┼───────────────────┘
                                                │
                ┌───────────────────────────────┼───────────────────────────┐
                │                               │                           │
        ┌───────▼─────────┐     ┌───────────────▼─────────┐     ┌───────────▼─────────┐
        │  Cashu Mint(s)  │     │  Nostr Relay(s)         │     │  Observability      │
        │  (REST API)     │     │  (WebSocket)            │     │  (OTLP/HTTP)        │
        └─────────────────┘     └─────────────────────────┘     └─────────────────────┘
```

### Architecture Layers

#### 1. Presentation Layer

**Responsibilities**:
- Render UI components based on state
- Capture user input and dispatch actions
- Display loading states, errors, and success feedback
- Accessibility (ARIA labels, keyboard navigation)

**Patterns**:
- **Presentational vs. Container Components**: Separate pure UI (presentational) from state-connected components (containers)
- **Compound Components**: For complex UI like voucher creation wizard
- **Render Props / Hooks**: For reusable logic (e.g., useVoucherStatus)

**Key Components**:
- `IdentityManager`: Create, import, recover identities
- `WalletDashboard`: Balance, mint connections, transaction history
- `VoucherIssueWizard`: Multi-step voucher creation
- `VoucherRedeemFlow`: Scan/paste, validate, redeem
- `VoucherStatusTracker`: Real-time status updates
- `SettingsPanel`: Network, language, allowlists, telemetry

#### 2. State Management Layer

**Responsibilities**:
- Centralized application state (identity, wallet, vouchers, settings)
- Derived state computation (e.g., total balance across units)
- State persistence to encrypted localStorage
- Optimistic UI updates with rollback on failure

**Stores** (Zustand slices):

```typescript
// Identity Store
interface IdentityState {
  identities: Identity[];
  activeIdentityId: string | null;
  createIdentity: (label: string) => Promise<Identity>;
  importIdentity: (mnemonic: string, label: string) => Promise<Identity>;
  selectIdentity: (id: string) => void;
  signEvent: (event: NostrEvent) => Promise<SignedEvent>;
}

// Wallet Store
interface WalletState {
  mints: MintConfig[];
  balances: Record<string, Record<string, number>>; // mintUrl -> unit -> amount
  keySets: Record<string, KeySet[]>; // mintUrl -> keySets[]
  proofs: Proof[];
  pendingOperations: PendingOperation[];
  addMint: (url: string, units: string[]) => Promise<void>;
  refreshBalance: (mintUrl?: string) => Promise<void>;
  refreshKeySets: (mintUrl: string) => Promise<void>;
}

// Voucher Store
interface VoucherState {
  vouchers: StoredVoucher[];
  drafts: VoucherDraft[];
  issueVoucher: (request: IssueVoucherRequest) => Promise<IssueVoucherResult>;
  redeemVoucher: (token: string) => Promise<RedeemVoucherResult>;
  checkVoucherStatus: (voucherId: string) => Promise<VoucherStatus>;
  subscribeToVoucher: (voucherId: string) => void;
  unsubscribeFromVoucher: (voucherId: string) => void;
}

// Settings Store
interface SettingsState {
  network: 'mainnet' | 'testnet';
  language: string;
  theme: 'light' | 'dark' | 'system';
  allowedMints: string[];
  allowedRelays: string[];
  telemetryEnabled: boolean;
  updateSettings: <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void;
}
```

**State Persistence**:
- Encrypt sensitive state (identities, proofs, vouchers) using passphrase-derived key (Argon2id + AES-256-GCM)
- Store in `localStorage` under namespaced keys (e.g., `cashu-wallet:encrypted-state`)
- Implement session timeout (e.g., 30 minutes) requiring re-unlock

#### 3. Application Service Layer

**Responsibilities**:
- Orchestrate multi-step operations (e.g., issue voucher = select proofs → create token → sign → backup)
- Business logic (e.g., proof selection, change calculation)
- Event publishing for audit trail
- Retry logic for transient failures

**Services**:

```typescript
// IdentityService
class IdentityService {
  async createIdentity(label: string): Promise<Identity>
  async importFromMnemonic(mnemonic: string): Promise<Identity>
  async exportMnemonic(identityId: string, passphrase: string): Promise<string>
  async signNostrEvent(event: NostrEvent, identityId: string): Promise<SignedEvent>
  async encryptForRecipient(content: string, recipientPubkey: string): Promise<string>
  async decryptFromSender(ciphertext: string, senderPubkey: string): Promise<string>
}

// WalletService
class WalletService {
  async connectToMint(mintUrl: string): Promise<MintInfo>
  async refreshBalance(mintUrl?: string): Promise<Balance>
  async requestMintQuote(amount: number, unit: string, mintUrl: string): Promise<MintQuote>
  async checkMintQuotePaid(quoteId: string, mintUrl: string): Promise<boolean>
  async mintTokens(quoteId: string, mintUrl: string): Promise<Proof[]>
  async swapProofs(proofs: Proof[], mintUrl: string): Promise<{keep: Proof[], send: Proof[]}>
  async checkProofStates(proofs: Proof[], mintUrl: string): Promise<ProofState[]>
}

// VoucherService
class VoucherService {
  async issueVoucher(request: IssueVoucherRequest): Promise<IssueVoucherResult>
  async redeemVoucher(token: string, verifyLedger: boolean): Promise<RedeemVoucherResult>
  async revokeVoucher(voucherId: string, reason: string): Promise<RevokeVoucherResult>
  async verifyVoucher(voucherId: string): Promise<VerifyVoucherResult>
  async checkVoucherStatus(voucherId: string): Promise<VoucherStatus>
  async exportVouchers(): Promise<Blob>
  async importVouchers(file: File): Promise<ImportVouchersResult>
}

// SharingService
class SharingService {
  async shareViaQR(token: string): Promise<QRCodeDataURL>
  async shareViaURL(token: string, baseUrl: string): Promise<string>
  async shareViaRelay(token: string, recipientPubkey: string, relayUrls: string[]): Promise<RelayDeliveryStatus>
  async copyToClipboard(content: string): Promise<void>
}
```

#### 4. Infrastructure / Adapter Layer

**Responsibilities**:
- Abstract external dependencies (API clients, storage, crypto, WebSockets)
- Implement retries, timeouts, circuit breakers
- Map domain models to/from API DTOs
- Handle network failures gracefully

**Adapters**:

```typescript
// CryptoAdapter (Web Crypto API)
interface CryptoAdapter {
  generateRandomBytes(length: number): Uint8Array;
  sha256(data: Uint8Array): Promise<Uint8Array>;
  hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
  encryptAES256GCM(plaintext: Uint8Array, key: Uint8Array): Promise<EncryptedData>;
  decryptAES256GCM(ciphertext: EncryptedData, key: Uint8Array): Promise<Uint8Array>;
  deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<Uint8Array>;
  schnorrSign(privateKey: Uint8Array, message: Uint8Array): Promise<Uint8Array>;
  schnorrVerify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean>;
}

// StorageAdapter (Encrypted localStorage)
interface StorageAdapter {
  save<T>(key: string, value: T): Promise<void>;
  load<T>(key: string): Promise<T | null>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
  lock(): void; // Clear in-memory keys
  unlock(passphrase: string): Promise<boolean>;
  isLocked(): boolean;
}

// MintApiAdapter (REST client for Cashu mints)
interface MintApiAdapter {
  getInfo(mintUrl: string): Promise<MintInfo>;
  getKeySets(mintUrl: string): Promise<KeySet[]>;
  requestMintQuote(mintUrl: string, amount: number, unit: string): Promise<MintQuote>;
  checkMintQuote(mintUrl: string, quoteId: string): Promise<MintQuoteStatus>;
  mint(mintUrl: string, request: MintRequest): Promise<MintResponse>;
  swap(mintUrl: string, request: SwapRequest): Promise<SwapResponse>;
  checkProofStates(mintUrl: string, proofs: Proof[]): Promise<ProofStateResponse>;
  requestMeltQuote(mintUrl: string, unit: string, invoice: string): Promise<MeltQuote>;
  melt(mintUrl: string, request: MeltRequest): Promise<MeltResponse>;
}

// RelayAdapter (Nostr relay WebSocket client)
interface RelayAdapter {
  connect(relayUrl: string): Promise<void>;
  disconnect(relayUrl: string): Promise<void>;
  publish(event: SignedEvent, relayUrls: string[]): Promise<PublishResult[]>;
  subscribe(filter: NostrFilter, relayUrls: string[]): Subscription;
  authenticate(relayUrl: string, identity: Identity): Promise<void>;
}

// ObservabilityAdapter (OpenTelemetry, structured logging)
interface ObservabilityAdapter {
  logEvent(event: AuditEvent): void;
  recordMetric(metric: Metric): void;
  startSpan(name: string, attributes?: Record<string, string>): Span;
  exportLogs(): Promise<Blob>;
}
```

---

## Module Specifications

### Identity Module

**Purpose**: Manage user identities (keypairs) for voucher signing and Nostr relay authentication.

**Responsibilities**:
- Generate new secp256k1 keypairs
- Import/export identities via BIP-39 mnemonic
- Sign Nostr events (NIP-01) and voucher payloads (NUT-11 P2PK)
- Encrypt/decrypt messages (NIP-44)
- Authenticate with Nostr relays (NIP-42)

**Data Model**:

```typescript
interface Identity {
  id: string; // UUID v4
  label: string; // User-defined label (1-100 chars)
  publicKey: string; // Hex-encoded secp256k1 public key (64 chars)
  privateKey: string; // Hex-encoded private key (64 chars, never exported unencrypted)
  createdAt: string; // ISO 8601 timestamp
  lastUsedAt: string; // ISO 8601 timestamp
}

interface IdentityBackup {
  version: 1;
  identities: {
    id: string;
    label: string;
    publicKey: string;
    encryptedMnemonic: string; // AES-256-GCM encrypted with user passphrase
    createdAt: string;
  }[];
  exportedAt: string;
}
```

**User Flows**:

1. **Create Identity**:
   - User clicks "Create New Identity"
   - UI prompts for label (optional)
   - System generates secp256k1 keypair via `nobleSecp256k1.utils.randomPrivateKey()`
   - System derives BIP-39 mnemonic (12 or 24 words)
   - UI displays mnemonic with "Write this down" warning
   - User confirms they've saved mnemonic (checkbox + re-enter 3 random words)
   - System stores identity in encrypted state

2. **Import Identity**:
   - User clicks "Import Identity"
   - UI prompts for BIP-39 mnemonic (paste or type)
   - System validates mnemonic checksum
   - System derives keypair from mnemonic
   - UI prompts for label
   - System stores identity

3. **Recover Identity**:
   - User unlocks wallet with passphrase
   - System decrypts identity state
   - System loads all identities into memory
   - UI displays identity list with labels and public keys (truncated)

**API Endpoints** (Future: Backend for identity storage):

```
POST   /api/v1/identities           - Create new identity (returns encrypted backup)
GET    /api/v1/identities            - List identities for current user
GET    /api/v1/identities/:id        - Get identity details
DELETE /api/v1/identities/:id        - Delete identity (requires confirmation)
POST   /api/v1/identities/:id/sign   - Sign event/payload
POST   /api/v1/identities/:id/encrypt - Encrypt message for recipient
POST   /api/v1/identities/:id/decrypt - Decrypt message from sender
```

**Security**:
- Private keys never leave browser (client-side signing only)
- Mnemonic encrypted with user passphrase (Argon2id KDF, 64MB memory, 3 iterations)
- Auto-lock after 30 minutes of inactivity
- Private keys cleared from memory on lock

**Testing**:
- Unit: Key generation, mnemonic validation, signing, encryption/decryption
- Integration: Nostr relay authentication flow (NIP-42), event publishing
- E2E: Create identity → export backup → import in new session → sign voucher

---

### Wallet Module

**Purpose**: Manage connections to Cashu mints, track balances, and perform token operations.

**Responsibilities**:
- Discover mint capabilities (NUT-06)
- Track balances by unit across multiple mints
- Manage proofs (unspent, pending, spent states)
- Request mint/melt quotes
- Perform mint, swap, melt operations
- Synchronize keySets and handle keySet rotation

**Data Model**:

```typescript
interface MintConfig {
  url: string; // Mint URL (e.g., https://mint.example.com)
  name: string; // Mint name from info endpoint
  units: string[]; // Supported units (e.g., ["sat", "usd"])
  mintMethods: string[]; // ["bolt11"]
  meltMethods: string[]; // ["bolt11"]
  isDefault: boolean; // Default mint for new operations
  addedAt: string; // ISO 8601 timestamp
}

interface Balance {
  totalsByUnit: Record<string, number>; // unit -> total amount
  byMint: Record<string, Record<string, number>>; // mintUrl -> unit -> amount
}

interface Proof {
  amount: number;
  secret: string; // Hex-encoded secret
  C: string; // Hex-encoded blinded signature
  id: string; // KeySet ID
}

interface ProofState {
  Y: string; // SHA256(secret)
  state: 'UNSPENT' | 'PENDING' | 'SPENT';
  witness?: string; // For P2PK proofs
}

interface MintQuote {
  quoteId: string;
  amount: number;
  unit: string;
  request: string; // Lightning invoice
  expiresAt: string; // ISO 8601 timestamp
  paid: boolean;
}

interface MeltQuote {
  quoteId: string;
  amount: number;
  unit: string;
  feeReserve: number;
  expiresAt: string;
  paid: boolean;
}

interface KeySet {
  id: string; // KeySet ID (first 12 chars of keyset hash)
  unit: string;
  active: boolean;
  keys: Record<number, string>; // amount -> public key (hex)
}
```

**User Flows**:

1. **Add Mint**:
   - User clicks "Add Mint"
   - UI prompts for mint URL
   - System validates URL format and HTTPS
   - System fetches mint info (`GET /v1/info`)
   - UI displays mint details (name, units, methods)
   - User confirms allowlist addition
   - System stores mint config and fetches keySets

2. **Refresh Balance**:
   - User clicks "Refresh Balance" or opens wallet dashboard
   - System fetches all unspent proofs from storage
   - System checks proof states via `POST /v1/check` (batched)
   - System updates proof states (mark spent proofs)
   - System calculates balance totals
   - UI displays updated balance with breakdown by mint/unit

3. **Mint Tokens (Lightning)**:
   - User selects mint and amount
   - System requests mint quote (`POST /v1/mint/quote/bolt11`)
   - UI displays Lightning invoice (QR code + copy)
   - User pays invoice externally
   - System polls quote status (`GET /v1/mint/quote/bolt11/:quoteId`) every 5s
   - When paid, system generates blinded messages
   - System calls mint endpoint (`POST /v1/mint/bolt11`)
   - System stores new proofs and updates balance

4. **Send Tokens (Lightning)**:
   - User enters Lightning invoice
   - System decodes invoice to extract amount
   - System selects mint with sufficient balance
   - System requests melt quote (`POST /v1/melt/quote/bolt11`)
   - UI displays quote details (amount, fee, total)
   - User confirms
   - System selects proofs to cover amount + fee
   - System calls melt endpoint (`POST /v1/melt/bolt11`)
   - System marks proofs as spent and updates balance

**API Endpoints** (Cashu Mint):

```
GET    /v1/info                         - Mint information
GET    /v1/keys                         - Active keySets
GET    /v1/keys/:id                     - Specific keySet
POST   /v1/mint/quote/bolt11            - Request mint quote
GET    /v1/mint/quote/bolt11/:quoteId   - Check mint quote status
POST   /v1/mint/bolt11                  - Mint tokens
POST   /v1/swap                         - Swap proofs
POST   /v1/check                        - Check proof states
POST   /v1/melt/quote/bolt11            - Request melt quote
GET    /v1/melt/quote/bolt11/:quoteId   - Check melt quote status
POST   /v1/melt/bolt11                  - Melt tokens (pay invoice)
```

**Security**:
- Secrets generated using CSPRNG (Crypto.getRandomValues)
- Proof selection algorithm prevents amount fingerprinting
- Proofs marked pending before network calls (rollback on failure)
- Mint allowlist enforcement (warn on unknown mints)

**Testing**:
- Unit: Proof selection, balance calculation, blinding/unblinding
- Integration: Mock mint API responses, test quote flows, keySet rotation
- E2E: Add mint → mint tokens → check balance → send tokens → verify balance

---

### Voucher Module

**Purpose**: Issue, share, redeem, and track vouchers (gift cards) backed by Cashu tokens.

**Responsibilities**:
- Create P2PK-locked vouchers (NUT-11)
- Sign vouchers with identity keypair
- Share vouchers via QR, URL, Nostr relay
- Validate voucher signatures and expiry
- Redeem vouchers into wallet
- Track voucher lifecycle (issued → delivered → redeemed/expired/revoked)

**Data Model**:

```typescript
interface StoredVoucher {
  voucherId: string; // UUID v4
  issuerId: string; // Identity ID (issuer's public key)
  unit: string; // Currency unit (e.g., "sat")
  faceValue: number; // Face value amount
  expiresAt: number | null; // Unix timestamp (null if no expiry)
  memo: string | null; // Optional memo
  issuerSignature: string; // Hex-encoded Schnorr signature
  issuerPublicKey: string; // Hex-encoded public key
  issuedAt: string; // ISO 8601 timestamp
  status: VoucherStatus; // "issued" | "redeemed" | "revoked" | "expired"
  token: string; // Cashu token (V4 CBOR, bech32-encoded)
  deliveryMetadata: DeliveryMetadata | null;
  redemptionMetadata: RedemptionMetadata | null;
}

type VoucherStatus = 'issued' | 'delivered' | 'redeemed' | 'revoked' | 'expired';

interface DeliveryMetadata {
  method: 'qr' | 'url' | 'relay' | 'clipboard';
  deliveredAt: string; // ISO 8601 timestamp
  recipientPubkey?: string; // For relay delivery
  relayUrls?: string[]; // For relay delivery
  eventId?: string; // Nostr event ID
}

interface RedemptionMetadata {
  redeemedAt: string; // ISO 8601 timestamp
  redeemedBy: string; // Redeemer's public key (if available)
  mintUrl: string; // Mint where redeemed
  proofsReceived: number; // Number of proofs received
}

interface IssueVoucherRequest {
  amount: number;
  unit: string;
  mintUrl: string;
  expiresInDays: number | null;
  memo: string | null;
  lockToPubkey: string | null; // Optional P2PK lock
}

interface IssueVoucherResult {
  voucher: StoredVoucher;
  token: string; // Bech32-encoded Cashu token
  backedUp: boolean; // Whether voucher was backed up to relay
  message: string; // Success message
}

interface RedeemVoucherRequest {
  token: string; // Cashu token to redeem
  verifyLedger: boolean; // Whether to check Nostr ledger for status
}

interface RedeemVoucherResult {
  voucherId: string;
  status: VoucherStatus;
  message: string;
  ledgerVerified: boolean;
  ledgerUpdated: boolean; // Whether ledger was updated with redemption
  proofsReceived: Proof[];
  amountReceived: number;
}
```

**User Flows**:

1. **Issue Voucher**:
   - User clicks "Issue Voucher"
   - UI displays wizard:
     - Step 1: Select mint and amount/unit
     - Step 2: Set expiry (optional, days from now)
     - Step 3: Add memo (optional, <280 chars)
     - Step 4: Lock to recipient pubkey (optional, for P2PK)
   - User confirms details
   - System:
     - Selects proofs from wallet (exact amount or with change)
     - Creates P2PK secret (if recipient pubkey provided)
     - Swaps proofs to create voucher tokens
     - Creates voucher payload
     - Signs voucher with identity keypair
     - Stores voucher with status "issued"
     - Optionally backs up to Nostr relay ledger
   - UI displays success with sharing options (QR, URL, Relay, Copy)

2. **Share Voucher**:
   - User selects sharing method:
     - **QR Code**: Generate QR code with token, display for scanning
     - **URL**: Generate URL (e.g., `https://redeem.example.com?token=<token>`), copy to clipboard
     - **Nostr Relay**: Prompt for recipient pubkey, encrypt token (NIP-44), publish to relay, update delivery metadata
     - **Clipboard**: Copy token directly
   - System updates voucher delivery metadata
   - UI shows "Voucher shared via [method]" confirmation

3. **Redeem Voucher**:
   - User clicks "Redeem Voucher"
   - UI prompts for token (paste or scan QR)
   - System:
     - Decodes token (V3 or V4)
     - Validates token format
     - Extracts mint URL, proofs, unit
     - Checks mint allowlist (warns if unknown)
     - If P2PK-locked:
       - Prompts user to select identity
       - Generates witness signature
     - Calls check endpoint to verify proof states
     - If unspent:
       - Calls swap endpoint to import proofs
       - Stores new proofs in wallet
       - Updates voucher status to "redeemed"
       - Records redemption metadata
     - If spent/pending:
       - Displays error with status
   - UI displays redemption result (success amount or error)

4. **Track Voucher Status**:
   - User views voucher list
   - UI displays vouchers grouped by status
   - For each voucher:
     - Shows face value, unit, memo, expiry, status badge
     - Click to expand: full details, delivery metadata, redemption metadata
   - User can click "Refresh Status" to check proof states
   - System updates status to "expired" if past expiry timestamp

**Voucher Lifecycle**:

```
   issued ──┬──> delivered ──┬──> redeemed
            │                 │
            └──> expired      └──> expired
            │
            └──> revoked
```

**Security**:
- Voucher signatures use Schnorr (compatible with Nostr tooling)
- Signature covers: `voucherId || issuerId || unit || faceValue || expiresAt || memo`
- P2PK witness signatures prevent unauthorized redemption
- Expiry checked before redemption (timestamp validation)
- Revocation requires publishing to Nostr ledger (NIP-XXX event kind TBD)

**Testing**:
- Unit: Voucher creation, signature generation/verification, expiry calculation, status transitions
- Integration: Mock mint API for swap/check, mock relay for delivery
- E2E: Issue voucher → share via relay → redeem by recipient → verify balance updated

---

### Sharing Module

**Purpose**: Generate shareable representations of vouchers (QR codes, URLs) and deliver via Nostr relays.

**Responsibilities**:
- Generate QR codes from tokens
- Create shareable URLs with embedded tokens
- Publish encrypted vouchers to Nostr relays
- Track delivery status

**Data Model**:

```typescript
interface ShareOptions {
  method: 'qr' | 'url' | 'relay' | 'clipboard';
  recipientPubkey?: string; // Required for relay method
  relayUrls?: string[]; // Required for relay method, falls back to defaults
  encrypt?: boolean; // Whether to encrypt token (default: true for relay)
}

interface ShareResult {
  success: boolean;
  method: string;
  data?: string; // QR data URL, URL string, or event ID
  error?: string;
}

interface RelayDeliveryStatus {
  eventId: string;
  publishedTo: string[]; // List of relay URLs
  failedRelays: string[]; // List of relays that rejected
  recipientPubkey: string;
  encryptedPayload: string; // NIP-44 encrypted token
}
```

**User Flows**:

1. **Share via QR Code**:
   - User clicks "Share" → "QR Code"
   - System generates QR code from token (using `qrcode` library)
   - UI displays QR code with "Scan to redeem" message
   - User shows QR code to recipient
   - Recipient scans with mobile wallet app

2. **Share via URL**:
   - User clicks "Share" → "Copy Link"
   - System generates URL: `https://redeem.example.com?token=cashuA...`
   - System copies URL to clipboard
   - UI shows "Link copied!" toast
   - User shares URL via messaging app

3. **Share via Nostr Relay**:
   - User clicks "Share" → "Send to Nostr Pubkey"
   - UI prompts for recipient pubkey (npub or hex)
   - User enters pubkey and confirms
   - System:
     - Validates pubkey format
     - Encrypts token using NIP-44 (recipient pubkey + sender private key)
     - Creates Nostr event (kind 4, encrypted DM)
     - Signs event with identity
     - Publishes to configured relays
     - Stores event ID in delivery metadata
   - UI shows "Voucher sent to [npub]" confirmation

**API** (Nostr Relay via nostr-tools):

```typescript
// Example relay delivery implementation
async function deliverViaRelay(
  token: string,
  recipientPubkey: string,
  relayUrls: string[],
  senderIdentity: Identity
): Promise<RelayDeliveryStatus> {
  // Encrypt token with NIP-44
  const encryptedToken = await encryptNip44(token, recipientPubkey, senderIdentity.privateKey);

  // Create Nostr event (kind 4 - encrypted DM)
  const event = {
    kind: 4,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', recipientPubkey]],
    content: encryptedToken,
    pubkey: senderIdentity.publicKey,
  };

  // Sign event
  const signedEvent = await signEvent(event, senderIdentity.privateKey);

  // Publish to relays
  const publishResults = await Promise.allSettled(
    relayUrls.map(url => publishToRelay(url, signedEvent))
  );

  const publishedTo = publishResults
    .filter(r => r.status === 'fulfilled')
    .map((r, i) => relayUrls[i]);

  const failedRelays = publishResults
    .filter(r => r.status === 'rejected')
    .map((r, i) => relayUrls[i]);

  return {
    eventId: signedEvent.id,
    publishedTo,
    failedRelays,
    recipientPubkey,
    encryptedPayload: encryptedToken,
  };
}
```

**Security**:
- QR codes contain full token (no server roundtrip)
- URLs use HTTPS only (enforced in settings)
- Relay delivery uses NIP-44 encryption (not deprecated NIP-04)
- Sender identity required for relay delivery (prevents impersonation)

**Testing**:
- Unit: QR code generation, URL generation, NIP-44 encryption/decryption
- Integration: Mock relay responses, test delivery failures and retries
- E2E: Share via relay → recipient connects → receives encrypted DM → decrypts token → redeems

---

### Settings / Policy Module

**Purpose**: Manage application configuration, security policies, and user preferences.

**Responsibilities**:
- Network selection (mainnet/testnet)
- Language and theme preferences
- Mint/relay allowlists
- Telemetry opt-in/out
- Session timeout configuration
- Export/import settings

**Data Model**:

```typescript
interface Settings {
  version: 1; // Settings schema version
  network: 'mainnet' | 'testnet';
  language: string; // ISO 639-1 code (e.g., "en", "es")
  theme: 'light' | 'dark' | 'system';
  allowedMints: string[]; // List of approved mint URLs
  allowedRelays: string[]; // List of approved relay URLs
  defaultMintUrl: string | null; // Default mint for new operations
  defaultRelays: string[]; // Default relays for voucher delivery
  sessionTimeout: number; // Minutes of inactivity before auto-lock (default: 30)
  telemetryEnabled: boolean; // Whether to send telemetry data
  telemetryEndpoint: string; // OTLP/HTTP endpoint
  autoBackupVouchers: boolean; // Auto-backup vouchers to relay
  confirmBeforeSend: boolean; // Require confirmation for send operations
  displayUnits: string[]; // Preferred units to display (e.g., ["sat", "btc"])
  fiatCurrency: string | null; // Fiat currency for balance display (e.g., "USD")
  exchangeRateSource: string | null; // Exchange rate API URL
}
```

**User Flows**:

1. **Configure Mint Allowlist**:
   - User navigates to Settings → Security → Mint Allowlist
   - UI displays current allowlist
   - User clicks "Add Mint"
   - UI prompts for mint URL
   - System validates URL (HTTPS, reachable, valid info endpoint)
   - UI displays mint info (name, units, methods)
   - User confirms addition
   - System adds to allowlist
   - Future mint operations check allowlist (warn if unknown)

2. **Enable Telemetry**:
   - User navigates to Settings → Privacy → Telemetry
   - UI explains what data is collected (events, metrics, no PII)
   - User toggles "Enable Telemetry"
   - System prompts for OTLP/HTTP endpoint (optional, defaults to built-in)
   - System starts sending telemetry data
   - User can export telemetry logs for inspection

3. **Export/Import Settings**:
   - User navigates to Settings → Backup
   - User clicks "Export Settings"
   - System serializes settings to JSON
   - System downloads settings.json file
   - User imports settings on new device
   - System validates schema version and merges settings

**Security**:
- Allowlists prevent accidental interaction with malicious mints/relays
- Session timeout auto-locks wallet after inactivity
- Telemetry data anonymized (no private keys, secrets, or PII)
- Settings export excludes sensitive data (private keys stored separately)

**Testing**:
- Unit: Settings validation, allowlist management, timeout calculation
- Integration: Mock telemetry endpoint, test export/import
- E2E: Configure settings → restart app → verify settings persisted

---

### Audit / Activity Module

**Purpose**: Maintain a tamper-evident log of all wallet operations for transparency and debugging.

**Responsibilities**:
- Record all user actions and system events
- Assign correlation IDs to multi-step operations
- Export logs for support/debugging
- Filter logs by date range, event type, mint, amount

**Data Model**:

```typescript
interface AuditEvent {
  id: string; // UUID v4
  timestamp: string; // ISO 8601 timestamp (client-side)
  correlationId: string; // Groups related events (e.g., voucher issuance)
  eventType: AuditEventType;
  actor: string; // Identity ID (public key)
  action: string; // Human-readable action (e.g., "issued_voucher", "redeemed_voucher")
  target: string | null; // Target entity (voucher ID, mint URL, etc.)
  metadata: Record<string, any>; // Event-specific data
  result: 'success' | 'failure'; // Outcome
  error: string | null; // Error message if failure
}

type AuditEventType =
  | 'identity_created'
  | 'identity_imported'
  | 'wallet_unlocked'
  | 'wallet_locked'
  | 'mint_added'
  | 'mint_removed'
  | 'balance_refreshed'
  | 'mint_quote_requested'
  | 'tokens_minted'
  | 'melt_quote_requested'
  | 'tokens_melted'
  | 'voucher_issued'
  | 'voucher_shared'
  | 'voucher_redeemed'
  | 'voucher_revoked'
  | 'settings_updated'
  | 'backup_created'
  | 'backup_restored';

interface AuditEventFilter {
  startDate?: string; // ISO 8601
  endDate?: string; // ISO 8601
  eventTypes?: AuditEventType[];
  actors?: string[]; // Identity IDs
  targets?: string[]; // Mint URLs, voucher IDs
  results?: ('success' | 'failure')[];
}

interface AuditExport {
  version: 1;
  exportedAt: string; // ISO 8601
  events: AuditEvent[];
}
```

**User Flows**:

1. **View Activity Log**:
   - User navigates to Activity tab
   - UI displays recent events (last 100)
   - Each event shows:
     - Timestamp (relative: "2 minutes ago")
     - Action (icon + label: "Issued Voucher")
     - Target (truncated: "Voucher abc123...")
     - Result (badge: success/failure)
   - User can expand event to see full metadata

2. **Filter Activity**:
   - User clicks "Filter"
   - UI displays filter panel:
     - Date range picker
     - Event type multi-select
     - Result filter (success/failure/all)
   - User applies filters
   - UI updates to show filtered events

3. **Export Activity Log**:
   - User clicks "Export Activity Log"
   - UI prompts for date range (default: all)
   - System serializes events to JSON
   - System downloads `activity-log-YYYY-MM-DD.json`
   - User can share with support for troubleshooting

**Audit Event Examples**:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2025-11-17T14:32:10.123Z",
  "correlationId": "corr-voucher-issue-001",
  "eventType": "voucher_issued",
  "actor": "npub1abc...",
  "action": "Issued voucher for 1000 sat",
  "target": "voucher-123",
  "metadata": {
    "amount": 1000,
    "unit": "sat",
    "mintUrl": "https://mint.example.com",
    "expiresAt": "2025-11-24T14:32:10.123Z",
    "memo": "Gift card for Alice"
  },
  "result": "success",
  "error": null
}

{
  "id": "660e8400-e29b-41d4-a716-446655440001",
  "timestamp": "2025-11-17T14:35:22.456Z",
  "correlationId": "corr-voucher-redeem-002",
  "eventType": "voucher_redeemed",
  "actor": "npub1def...",
  "action": "Redeemed voucher",
  "target": "voucher-456",
  "metadata": {
    "amount": 500,
    "unit": "sat",
    "mintUrl": "https://mint.example.com",
    "proofsReceived": 3
  },
  "result": "failure",
  "error": "Voucher already redeemed. Proofs are marked as SPENT. Suggestion: Contact the issuer to request a new voucher."
}
```

**Security**:
- Logs stored locally (encrypted with wallet state)
- Export redacts private keys and secrets
- Correlation IDs enable cross-operation tracing without exposing secrets
- No PII logged (public keys only, no IP addresses or device info)

**Testing**:
- Unit: Event creation, filtering, serialization
- Integration: Test event publishing from all modules
- E2E: Perform operation → verify audit event logged → export → verify JSON format

---

## API Integration Layer

### Backend API Design (Future: Optional Server-Side Storage)

While the web client is designed to be fully client-side (no backend required for core functionality), an optional backend API can provide:

1. **Identity Backup Service**: Store encrypted identity backups
2. **Voucher Ledger**: Public registry of voucher issuance/redemption events
3. **Relay Discovery**: Curated list of reliable Nostr relays
4. **Exchange Rate Feed**: Real-time fiat/BTC conversion rates
5. **Telemetry Ingestion**: OpenTelemetry collector endpoint

**API Design Principles**:
- RESTful endpoints with JSON payloads
- JWT authentication for user-specific resources
- Rate limiting per IP/user
- CORS headers for web client access
- OpenAPI/Swagger documentation

**Example Endpoints**:

```
# Identity Service
POST   /api/v1/auth/register              - Register user account (email/password or nostr pubkey)
POST   /api/v1/auth/login                 - Login (returns JWT)
POST   /api/v1/auth/logout                - Invalidate JWT
GET    /api/v1/identity/backup            - Retrieve encrypted identity backup
POST   /api/v1/identity/backup            - Store encrypted identity backup
DELETE /api/v1/identity/backup            - Delete identity backup

# Voucher Ledger Service
GET    /api/v1/vouchers                   - List vouchers (filtered by issuer pubkey)
GET    /api/v1/vouchers/:id               - Get voucher details
POST   /api/v1/vouchers                   - Publish voucher to ledger
PUT    /api/v1/vouchers/:id/status        - Update voucher status (redeem/revoke)
GET    /api/v1/vouchers/:id/events        - Get voucher event history

# Relay Discovery Service
GET    /api/v1/relays                     - List recommended relays
GET    /api/v1/relays/:url/health         - Check relay health status

# Exchange Rate Service
GET    /api/v1/rates                      - Get current exchange rates (BTC/USD, BTC/EUR, etc.)
GET    /api/v1/rates/history              - Get historical rates (for charts)

# Telemetry Service (OpenTelemetry Protocol)
POST   /v1/traces                         - Ingest trace data (OTLP/HTTP)
POST   /v1/metrics                        - Ingest metric data (OTLP/HTTP)
POST   /v1/logs                           - Ingest log data (OTLP/HTTP)
```

**Authentication**:
- Nostr NIP-42 style: Client signs challenge with identity private key
- Server verifies signature and issues JWT
- JWT includes identity public key as subject

**Data Models** (Backend):

```typescript
// User Account
interface UserAccount {
  id: string; // UUID
  pubkey: string; // Nostr public key (primary identifier)
  email: string | null; // Optional email
  createdAt: string;
  lastLoginAt: string;
}

// Identity Backup
interface IdentityBackupRecord {
  id: string;
  userId: string; // Foreign key to UserAccount
  encryptedData: string; // AES-256-GCM encrypted JSON blob
  version: number; // Schema version
  createdAt: string;
  updatedAt: string;
}

// Voucher Ledger Entry
interface VoucherLedgerEntry {
  id: string;
  voucherId: string; // Voucher ID from StoredVoucher
  issuerPubkey: string; // Issuer's public key
  faceValue: number;
  unit: string;
  issuedAt: string;
  status: VoucherStatus;
  events: VoucherEvent[]; // Timeline of events
}

interface VoucherEvent {
  id: string;
  voucherId: string;
  eventType: 'issued' | 'delivered' | 'redeemed' | 'revoked' | 'expired';
  timestamp: string;
  actorPubkey: string; // Who triggered the event
  metadata: Record<string, any>;
}
```

**Implementation**:
- **Framework**: Spring Boot 3.5+ (Java 21) - aligns with existing codebase
- **Database**: PostgreSQL 16+ for relational data
- **Caching**: Redis for JWT blacklist, rate limiting
- **Observability**: OpenTelemetry Java agent, export to Grafana Cloud
- **Deployment**: Docker container, Kubernetes ready

---

## Data Models

### Complete TypeScript Data Model Definitions

```typescript
// ============================================================================
// IDENTITY MODULE
// ============================================================================

interface Identity {
  id: string;
  label: string;
  publicKey: string;
  privateKey: string;
  createdAt: string;
  lastUsedAt: string;
}

interface IdentityBackup {
  version: 1;
  identities: {
    id: string;
    label: string;
    publicKey: string;
    encryptedMnemonic: string;
    createdAt: string;
  }[];
  exportedAt: string;
}

// ============================================================================
// WALLET MODULE
// ============================================================================

interface MintConfig {
  url: string;
  name: string;
  units: string[];
  mintMethods: string[];
  meltMethods: string[];
  isDefault: boolean;
  addedAt: string;
}

interface Balance {
  totalsByUnit: Record<string, number>;
  byMint: Record<string, Record<string, number>>;
}

interface Proof {
  amount: number;
  secret: string;
  C: string;
  id: string;
}

interface ProofState {
  Y: string;
  state: 'UNSPENT' | 'PENDING' | 'SPENT';
  witness?: string;
}

interface MintQuote {
  quoteId: string;
  amount: number;
  unit: string;
  request: string;
  expiresAt: string;
  paid: boolean;
}

interface MeltQuote {
  quoteId: string;
  amount: number;
  unit: string;
  feeReserve: number;
  expiresAt: string;
  paid: boolean;
}

interface KeySet {
  id: string;
  unit: string;
  active: boolean;
  keys: Record<number, string>;
}

// ============================================================================
// VOUCHER MODULE
// ============================================================================

interface StoredVoucher {
  voucherId: string;
  issuerId: string;
  unit: string;
  faceValue: number;
  expiresAt: number | null;
  memo: string | null;
  issuerSignature: string;
  issuerPublicKey: string;
  issuedAt: string;
  status: VoucherStatus;
  token: string;
  deliveryMetadata: DeliveryMetadata | null;
  redemptionMetadata: RedemptionMetadata | null;
}

type VoucherStatus = 'issued' | 'delivered' | 'redeemed' | 'revoked' | 'expired';

interface DeliveryMetadata {
  method: 'qr' | 'url' | 'relay' | 'clipboard';
  deliveredAt: string;
  recipientPubkey?: string;
  relayUrls?: string[];
  eventId?: string;
}

interface RedemptionMetadata {
  redeemedAt: string;
  redeemedBy: string;
  mintUrl: string;
  proofsReceived: number;
}

interface IssueVoucherRequest {
  amount: number;
  unit: string;
  mintUrl: string;
  expiresInDays: number | null;
  memo: string | null;
  lockToPubkey: string | null;
}

interface IssueVoucherResult {
  voucher: StoredVoucher;
  token: string;
  backedUp: boolean;
  message: string;
}

interface RedeemVoucherRequest {
  token: string;
  verifyLedger: boolean;
}

interface RedeemVoucherResult {
  voucherId: string;
  status: VoucherStatus;
  message: string;
  ledgerVerified: boolean;
  ledgerUpdated: boolean;
  proofsReceived: Proof[];
  amountReceived: number;
}

// ============================================================================
// SHARING MODULE
// ============================================================================

interface ShareOptions {
  method: 'qr' | 'url' | 'relay' | 'clipboard';
  recipientPubkey?: string;
  relayUrls?: string[];
  encrypt?: boolean;
}

interface ShareResult {
  success: boolean;
  method: string;
  data?: string;
  error?: string;
}

interface RelayDeliveryStatus {
  eventId: string;
  publishedTo: string[];
  failedRelays: string[];
  recipientPubkey: string;
  encryptedPayload: string;
}

// ============================================================================
// SETTINGS MODULE
// ============================================================================

interface Settings {
  version: 1;
  network: 'mainnet' | 'testnet';
  language: string;
  theme: 'light' | 'dark' | 'system';
  allowedMints: string[];
  allowedRelays: string[];
  defaultMintUrl: string | null;
  defaultRelays: string[];
  sessionTimeout: number;
  telemetryEnabled: boolean;
  telemetryEndpoint: string;
  autoBackupVouchers: boolean;
  confirmBeforeSend: boolean;
  displayUnits: string[];
  fiatCurrency: string | null;
  exchangeRateSource: string | null;
}

// ============================================================================
// AUDIT MODULE
// ============================================================================

interface AuditEvent {
  id: string;
  timestamp: string;
  correlationId: string;
  eventType: AuditEventType;
  actor: string;
  action: string;
  target: string | null;
  metadata: Record<string, any>;
  result: 'success' | 'failure';
  error: string | null;
}

type AuditEventType =
  | 'identity_created'
  | 'identity_imported'
  | 'wallet_unlocked'
  | 'wallet_locked'
  | 'mint_added'
  | 'mint_removed'
  | 'balance_refreshed'
  | 'mint_quote_requested'
  | 'tokens_minted'
  | 'melt_quote_requested'
  | 'tokens_melted'
  | 'voucher_issued'
  | 'voucher_shared'
  | 'voucher_redeemed'
  | 'voucher_revoked'
  | 'settings_updated'
  | 'backup_created'
  | 'backup_restored';

interface AuditEventFilter {
  startDate?: string;
  endDate?: string;
  eventTypes?: AuditEventType[];
  actors?: string[];
  targets?: string[];
  results?: ('success' | 'failure')[];
}

interface AuditExport {
  version: 1;
  exportedAt: string;
  events: AuditEvent[];
}

// ============================================================================
// NOSTR MODULE (for relay integration)
// ============================================================================

interface NostrEvent {
  id?: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  pubkey: string;
  sig?: string;
}

interface SignedEvent extends NostrEvent {
  id: string;
  sig: string;
}

interface NostrFilter {
  ids?: string[];
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
  '#e'?: string[];
  '#p'?: string[];
}

interface RelayConnection {
  url: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  lastConnected: string | null;
  lastError: string | null;
}

// ============================================================================
// ERROR MODELS
// ============================================================================

interface WalletOperationError {
  errorCode: string;
  retryable: boolean;
  userMessage: string;
  suggestion: string;
  timestamp: string;
  context?: Record<string, any>;
}

// Standard error codes (aligned with Java backend)
type ErrorCode =
  | 'PROOF_IMPORT_FAILED'
  | 'QUOTE_EXPIRED'
  | 'VOUCHER_REDEMPTION_FAILED'
  | 'INVALID_CHANGE'
  | 'LIGHTNING_FAILURE'
  | 'RELAY_DELIVERY_FAILED'
  | 'MINT_UNREACHABLE'
  | 'INVALID_TOKEN'
  | 'INSUFFICIENT_BALANCE'
  | 'ENCRYPTION_FAILED'
  | 'SIGNATURE_VERIFICATION_FAILED'
  | 'NETWORK_ERROR'
  | 'STORAGE_ERROR'
  | 'UNKNOWN_ERROR';
```

---

## Security Implementation

### Threat Model

**Assets**:
1. Private keys (identity keypairs)
2. Cashu proofs (bearer tokens)
3. Voucher tokens
4. User mnemonic backups
5. Session state (unlocked wallet)

**Threats**:

| Threat | Impact | Likelihood | Mitigation |
|--------|--------|------------|------------|
| XSS (stored/reflected) | High (key theft) | Medium | CSP, input sanitization, DOMPurify |
| CSRF | Medium (unauthorized actions) | Low | SameSite cookies, CSRF tokens |
| Man-in-the-Middle | High (token interception) | Low | HTTPS enforcement, HSTS |
| Malicious mint | High (proof theft) | Medium | Mint allowlist, domain verification |
| Phishing | High (mnemonic theft) | High | Clear UX warnings, domain pinning |
| Local storage compromise | High (key/proof theft) | Medium | Encryption at rest, auto-lock |
| Dependency supply chain | High (backdoor) | Medium | SRI, dependency scanning, lock files |
| Timing attacks (NIP-44 MAC) | Medium (message forgery) | Low | Constant-time MAC verification |

### Security Controls

#### 1. Content Security Policy (CSP)

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'self';
  script-src 'self' 'wasm-unsafe-eval';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https:;
  font-src 'self' data:;
  connect-src 'self' https://mint.* wss://relay.*;
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self';
">
```

**Rationale**:
- Prevents inline script execution (XSS mitigation)
- Restricts resource loading to trusted origins
- `wasm-unsafe-eval` required for Web Crypto API in some browsers
- `connect-src` whitelists mint/relay domains (configurable via settings)

#### 2. Subresource Integrity (SRI)

```html
<!-- Example: External dependencies with SRI -->
<script
  src="https://cdn.example.com/lib.js"
  integrity="sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC"
  crossorigin="anonymous"
></script>
```

**Enforcement**: All external resources (CDN-hosted libraries) must include SRI hashes.

#### 3. Key Management

**Storage**:
- Private keys stored in memory during session (never persisted unencrypted)
- Encrypted state in localStorage using AES-256-GCM
- Encryption key derived from user passphrase via Argon2id:
  - Memory: 64MB
  - Iterations: 3
  - Parallelism: 1
  - Output: 256-bit key

**Key Derivation**:
```typescript
async function deriveEncryptionKey(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  // Use Argon2id for passphrase-based KDF
  const argon2 = await import('argon2-browser');
  const result = await argon2.hash({
    pass: passphrase,
    salt: salt,
    type: argon2.ArgonType.Argon2id,
    mem: 65536, // 64MB
    time: 3,
    parallelism: 1,
    hashLen: 32, // 256 bits
  });
  return result.hash;
}
```

**Session Management**:
- Auto-lock after 30 minutes of inactivity (configurable)
- On lock: clear private keys from memory, require passphrase to unlock
- Session state stored in memory only (not persisted)

#### 4. Proof Security

**Secret Generation** (NUT-00):
```typescript
function generateSecret(): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHex(randomBytes); // 64-char hex string
}
```

**Proof Storage**:
- Proofs encrypted in localStorage (same key as identity state)
- Mark proofs as PENDING before network calls (prevent double-spend)
- Rollback to UNSPENT on failure

**Proof Selection**:
- Select smallest set of proofs to cover amount (minimize fingerprinting)
- Avoid reusing same proof amounts (privacy protection)

#### 5. Transport Security

**HTTPS Enforcement**:
- Reject HTTP URLs for mints/relays (enforce in settings)
- Upgrade insecure requests (CSP: `upgrade-insecure-requests`)
- HSTS header recommended for hosting (not client-side control)

**TLS Certificate Validation**:
- Browser handles validation (no client-side override)
- Display domain in UI before connecting (user verification)

#### 6. Nostr Encryption (NIP-44)

**Implementation**:
```typescript
import { secp256k1 } from '@noble/curves/secp256k1';
import { chacha20 } from '@noble/ciphers/chacha';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';

async function encryptNip44(
  plaintext: string,
  recipientPubkey: string,
  senderPrivkey: string
): Promise<string> {
  // 1. Shared secret via ECDH
  const sharedSecret = secp256k1.getSharedSecret(senderPrivkey, recipientPubkey);

  // 2. Derive encryption and MAC keys via HKDF
  const derivedKeys = hkdf(sha256, sharedSecret, 'nip44-v2', undefined, 76);
  const encKey = derivedKeys.slice(0, 32);
  const nonce = derivedKeys.slice(32, 44);
  const macKey = derivedKeys.slice(44, 76);

  // 3. Pad plaintext (power-of-two padding)
  const paddedPlaintext = padPlaintext(plaintext);

  // 4. Encrypt with ChaCha20
  const ciphertext = chacha20(encKey, nonce, paddedPlaintext);

  // 5. Compute MAC (HMAC-SHA256)
  const mac = hmac(sha256, macKey, ciphertext);

  // 6. Return base64(version || nonce || ciphertext || mac)
  const payload = new Uint8Array(1 + 12 + ciphertext.length + 32);
  payload[0] = 0x02; // NIP-44 v2
  payload.set(nonce, 1);
  payload.set(ciphertext, 13);
  payload.set(mac, 13 + ciphertext.length);

  return base64Encode(payload);
}

async function decryptNip44(
  ciphertext: string,
  senderPubkey: string,
  recipientPrivkey: string
): Promise<string> {
  const payload = base64Decode(ciphertext);

  // 1. Parse payload
  const version = payload[0];
  if (version !== 0x02) throw new Error('Unsupported NIP-44 version');

  const nonce = payload.slice(1, 13);
  const ct = payload.slice(13, -32);
  const mac = payload.slice(-32);

  // 2. Shared secret via ECDH
  const sharedSecret = secp256k1.getSharedSecret(recipientPrivkey, senderPubkey);

  // 3. Derive keys
  const derivedKeys = hkdf(sha256, sharedSecret, 'nip44-v2', undefined, 76);
  const encKey = derivedKeys.slice(0, 32);
  const macKey = derivedKeys.slice(44, 76);

  // 4. Verify MAC (constant-time comparison)
  const expectedMac = hmac(sha256, macKey, ct);
  if (!constantTimeEqual(mac, expectedMac)) {
    throw new Error('MAC verification failed');
  }

  // 5. Decrypt with ChaCha20
  const paddedPlaintext = chacha20(encKey, nonce, ct);

  // 6. Unpad and return
  return unpadPlaintext(paddedPlaintext);
}

// Constant-time MAC comparison (critical for security)
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}
```

#### 7. Input Validation

**Validation Rules**:

| Input | Validation |
|-------|------------|
| Mint URL | HTTPS, valid domain, reachable `/v1/info` endpoint |
| Relay URL | wss:// or ws://, valid domain, WebSocket handshake succeeds |
| Public key | 64-char hex (secp256k1), valid curve point |
| Mnemonic | Valid BIP-39 checksum, 12/24 words from wordlist |
| Token | Valid bech32 encoding, parses to TokenV3/V4 |
| Amount | Positive integer, ≤ available balance |
| Passphrase | Minimum 12 characters (recommend 16+) |

**Implementation**:
```typescript
import { bech32 } from '@scure/base';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

function validateMintUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

function validateRelayUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'wss:' || parsed.protocol === 'ws:') && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

function validatePubkey(pubkey: string): boolean {
  if (pubkey.length !== 64) return false;
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return false;
  // Optionally: verify valid curve point
  try {
    secp256k1.ProjectivePoint.fromHex(pubkey);
    return true;
  } catch {
    return false;
  }
}

function validateMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic, wordlist);
}
```

#### 8. Dependency Security

**Tools**:
- `npm audit` (automated checks in CI/CD)
- Dependabot (GitHub automated PRs for updates)
- `eslint-plugin-security` (static analysis)
- Snyk (vulnerability scanning)

**Policy**:
- Pin exact versions in `package-lock.json`
- Review dependency changes in PRs
- Reject dependencies with known high/critical CVEs
- Prefer minimal dependencies (reduce attack surface)

#### 9. XSS Mitigation

**Techniques**:
- React's automatic escaping (default)
- DOMPurify for user-generated HTML (if displaying rich content)
- Avoid `dangerouslySetInnerHTML` unless sanitized
- CSP to block inline scripts

**Example**:
```typescript
import DOMPurify from 'dompurify';

function renderUserMemo(memo: string): string {
  // Sanitize user input before rendering
  return DOMPurify.sanitize(memo, {
    ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a'],
    ALLOWED_ATTR: ['href', 'title'],
  });
}
```

#### 10. Phishing Protection

**Techniques**:
- Display full domain before connecting to mint/relay
- Visual indicators for trusted vs. unknown mints
- Warn on clipboard paste of tokens (confirm before redeem)
- Educate users: never share mnemonic, verify URLs

**UI Example**:
```
⚠️ Warning: You are about to connect to an unknown mint:

  https://suspicious-mint.xyz

This mint is NOT on your allowlist. Only proceed if you trust this domain.

[ Cancel ]  [ Trust and Continue ]
```

---

## State Management

### Zustand Store Architecture

**Store Structure**:
```typescript
import create from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

// Root store (combines all slices)
interface RootState {
  identity: IdentityState;
  wallet: WalletState;
  voucher: VoucherState;
  settings: SettingsState;
  audit: AuditState;
  ui: UIState;
}

// Create store with middleware
const useStore = create<RootState>()(
  persist(
    immer((set, get) => ({
      identity: createIdentitySlice(set, get),
      wallet: createWalletSlice(set, get),
      voucher: createVoucherSlice(set, get),
      settings: createSettingsSlice(set, get),
      audit: createAuditSlice(set, get),
      ui: createUISlice(set, get),
    })),
    {
      name: 'cashu-wallet-state',
      storage: createJSONStorage(() => encryptedStorage), // Custom encrypted storage
      partialize: (state) => ({
        // Only persist certain slices
        identity: state.identity,
        wallet: state.wallet,
        voucher: state.voucher,
        settings: state.settings,
        audit: state.audit,
        // Exclude UI state (ephemeral)
      }),
    }
  )
);
```

**Identity Slice**:
```typescript
function createIdentitySlice(set, get): IdentityState {
  return {
    identities: [],
    activeIdentityId: null,

    createIdentity: async (label: string) => {
      const identity = await identityService.createIdentity(label);
      set((state) => {
        state.identity.identities.push(identity);
        state.identity.activeIdentityId = identity.id;
      });
      auditService.logEvent({
        eventType: 'identity_created',
        actor: identity.publicKey,
        action: `Created identity "${label}"`,
        target: identity.id,
        result: 'success',
      });
      return identity;
    },

    importIdentity: async (mnemonic: string, label: string) => {
      const identity = await identityService.importFromMnemonic(mnemonic);
      set((state) => {
        state.identity.identities.push({ ...identity, label });
        state.identity.activeIdentityId = identity.id;
      });
      auditService.logEvent({
        eventType: 'identity_imported',
        actor: identity.publicKey,
        action: `Imported identity "${label}"`,
        target: identity.id,
        result: 'success',
      });
      return identity;
    },

    selectIdentity: (id: string) => {
      set((state) => {
        state.identity.activeIdentityId = id;
      });
      const identity = get().identity.identities.find(i => i.id === id);
      if (identity) {
        identityService.markAsUsed(identity);
      }
    },

    signEvent: async (event: NostrEvent) => {
      const activeId = get().identity.activeIdentityId;
      if (!activeId) throw new Error('No active identity');
      const identity = get().identity.identities.find(i => i.id === activeId);
      if (!identity) throw new Error('Active identity not found');
      return await identityService.signNostrEvent(event, identity.id);
    },
  };
}
```

**Wallet Slice**:
```typescript
function createWalletSlice(set, get): WalletState {
  return {
    mints: [],
    balances: {},
    keySets: {},
    proofs: [],
    pendingOperations: [],

    addMint: async (url: string, units: string[]) => {
      const mintInfo = await walletService.connectToMint(url);
      const mintConfig: MintConfig = {
        url,
        name: mintInfo.name,
        units: mintInfo.units,
        mintMethods: mintInfo.mintMethods,
        meltMethods: mintInfo.meltMethods,
        isDefault: get().wallet.mints.length === 0,
        addedAt: new Date().toISOString(),
      };
      set((state) => {
        state.wallet.mints.push(mintConfig);
      });
      await get().wallet.refreshKeySets(url);
      await get().wallet.refreshBalance(url);
      auditService.logEvent({
        eventType: 'mint_added',
        actor: get().identity.activeIdentityId || 'system',
        action: `Added mint "${mintConfig.name}"`,
        target: url,
        result: 'success',
      });
    },

    refreshBalance: async (mintUrl?: string) => {
      const mints = mintUrl ? [mintUrl] : get().wallet.mints.map(m => m.url);
      for (const url of mints) {
        const balance = await walletService.refreshBalance(url);
        set((state) => {
          state.wallet.balances[url] = balance.totalsByUnit;
        });
      }
    },

    refreshKeySets: async (mintUrl: string) => {
      const keySets = await mintApiAdapter.getKeySets(mintUrl);
      set((state) => {
        state.wallet.keySets[mintUrl] = keySets;
      });
    },
  };
}
```

**Encrypted Storage Adapter**:
```typescript
import { StateStorage } from 'zustand/middleware';

class EncryptedLocalStorage implements StateStorage {
  private encryptionKey: Uint8Array | null = null;

  async unlock(passphrase: string): Promise<boolean> {
    const salt = this.getSalt();
    this.encryptionKey = await deriveEncryptionKey(passphrase, salt);

    // Verify by attempting to decrypt existing state
    try {
      await this.getItem('cashu-wallet-state');
      return true;
    } catch {
      this.encryptionKey = null;
      return false;
    }
  }

  lock(): void {
    this.encryptionKey = null;
  }

  isLocked(): boolean {
    return this.encryptionKey === null;
  }

  async getItem(name: string): Promise<string | null> {
    if (!this.encryptionKey) throw new Error('Storage is locked');

    const encryptedData = localStorage.getItem(name);
    if (!encryptedData) return null;

    const decrypted = await cryptoAdapter.decryptAES256GCM(
      JSON.parse(encryptedData),
      this.encryptionKey
    );
    return new TextDecoder().decode(decrypted);
  }

  async setItem(name: string, value: string): Promise<void> {
    if (!this.encryptionKey) throw new Error('Storage is locked');

    const encrypted = await cryptoAdapter.encryptAES256GCM(
      new TextEncoder().encode(value),
      this.encryptionKey
    );
    localStorage.setItem(name, JSON.stringify(encrypted));
  }

  async removeItem(name: string): Promise<void> {
    localStorage.removeItem(name);
  }

  private getSalt(): Uint8Array {
    let salt = localStorage.getItem('cashu-wallet-salt');
    if (!salt) {
      const newSalt = crypto.getRandomValues(new Uint8Array(16));
      localStorage.setItem('cashu-wallet-salt', bytesToHex(newSalt));
      return newSalt;
    }
    return hexToBytes(salt);
  }
}

const encryptedStorage = new EncryptedLocalStorage();
```

---

## Error Handling

### Error Hierarchy (TypeScript)

```typescript
// Base error class (mirrors Java WalletOperationException)
class WalletOperationError extends Error {
  constructor(
    public errorCode: ErrorCode,
    public retryable: boolean,
    public userMessage: string,
    public suggestion: string,
    public context?: Record<string, any>,
    cause?: Error
  ) {
    super(userMessage);
    this.name = 'WalletOperationError';
    this.cause = cause;
  }

  getFormattedMessage(): string {
    return `${this.userMessage}. Suggestion: ${this.suggestion}`;
  }

  toJSON() {
    return {
      errorCode: this.errorCode,
      retryable: this.retryable,
      userMessage: this.userMessage,
      suggestion: this.suggestion,
      context: this.context,
      timestamp: new Date().toISOString(),
    };
  }
}

// Specific error classes
class ProofImportError extends WalletOperationError {
  constructor(reason: string, context?: Record<string, any>, cause?: Error) {
    super(
      'PROOF_IMPORT_FAILED',
      false,
      `Failed to import proofs: ${reason}`,
      'Verify the token format is correct (bech32-encoded Cashu token). If the issue persists, contact the sender.',
      context,
      cause
    );
  }
}

class QuoteExpiredError extends WalletOperationError {
  constructor(quoteId: string, expiredAt: string) {
    super(
      'QUOTE_EXPIRED',
      false,
      `Quote ${quoteId} expired at ${expiredAt}`,
      'Request a new quote and complete the payment within the validity period (typically 5 minutes).',
      { quoteId, expiredAt }
    );
  }
}

class VoucherRedemptionError extends WalletOperationError {
  static alreadyRedeemed(voucherId: string): VoucherRedemptionError {
    return new VoucherRedemptionError(
      'VOUCHER_REDEMPTION_FAILED',
      false,
      `Voucher ${voucherId} has already been redeemed`,
      'Contact the voucher issuer to request a new voucher.',
      { voucherId, reason: 'already_redeemed' }
    );
  }

  static expired(voucherId: string, expiredAt: string): VoucherRedemptionError {
    return new VoucherRedemptionError(
      'VOUCHER_REDEMPTION_FAILED',
      false,
      `Voucher ${voucherId} expired at ${expiredAt}`,
      'Contact the voucher issuer to request a new voucher or extension.',
      { voucherId, expiredAt, reason: 'expired' }
    );
  }

  static signatureInvalid(voucherId: string): VoucherRedemptionError {
    return new VoucherRedemptionError(
      'SIGNATURE_VERIFICATION_FAILED',
      false,
      `Voucher ${voucherId} has an invalid signature`,
      'This voucher may be counterfeit or corrupted. Do not redeem it. Contact the issuer.',
      { voucherId, reason: 'invalid_signature' }
    );
  }
}

class RelayDeliveryError extends WalletOperationError {
  constructor(relayUrl: string, reason: string, retryable: boolean, cause?: Error) {
    super(
      'RELAY_DELIVERY_FAILED',
      retryable,
      `Failed to deliver voucher to relay ${relayUrl}: ${reason}`,
      retryable
        ? 'Check your network connection and try again. If the issue persists, try a different relay.'
        : 'The relay rejected the event. Check that the recipient public key is correct and the relay is operational.',
      { relayUrl, reason },
      cause
    );
  }
}

class MintUnreachableError extends WalletOperationError {
  constructor(mintUrl: string, cause?: Error) {
    super(
      'MINT_UNREACHABLE',
      true,
      `Cannot connect to mint at ${mintUrl}`,
      'Check your network connection and verify the mint URL is correct. The mint may be temporarily offline.',
      { mintUrl },
      cause
    );
  }
}

// Error handling utility
function handleError(error: unknown, context: string): WalletOperationError {
  if (error instanceof WalletOperationError) {
    return error;
  }

  // Map common errors to WalletOperationError
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return new MintUnreachableError(context, error as Error);
  }

  // Unknown error
  return new WalletOperationError(
    'UNKNOWN_ERROR',
    false,
    `An unexpected error occurred: ${(error as Error).message}`,
    'Please try again. If the issue persists, export your activity log and contact support.',
    { context, originalError: String(error) },
    error as Error
  );
}
```

### Error Display (UI)

**Toast Notifications**:
```typescript
import { toast } from 'sonner'; // Recommended toast library

function displayError(error: WalletOperationError): void {
  toast.error(error.userMessage, {
    description: error.suggestion,
    duration: error.retryable ? 5000 : 10000,
    action: error.retryable ? {
      label: 'Retry',
      onClick: () => {
        // Retry logic
      },
    } : undefined,
  });

  // Log to audit trail
  auditService.logEvent({
    eventType: 'error_occurred',
    actor: 'system',
    action: error.userMessage,
    target: error.context?.target || null,
    result: 'failure',
    error: error.getFormattedMessage(),
    metadata: error.toJSON(),
  });
}
```

**Error Boundary** (React):
```typescript
import { Component, ReactNode } from 'react';

class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught error:', error, errorInfo);

    // Log to observability
    observabilityAdapter.logEvent({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      correlationId: 'error-boundary',
      eventType: 'ui_error',
      actor: 'system',
      action: 'React error boundary triggered',
      target: null,
      metadata: {
        error: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack,
      },
      result: 'failure',
      error: error.message,
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <h1>Something went wrong</h1>
          <p>{this.state.error?.message}</p>
          <button onClick={() => window.location.reload()}>
            Reload Application
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
```

---

## Observability

### Logging

**Structured Logging** (JSON format):
```typescript
interface LogEntry {
  timestamp: string; // ISO 8601
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  context: Record<string, any>;
  correlationId?: string;
}

class Logger {
  private correlationId: string | null = null;

  setCorrelationId(id: string): void {
    this.correlationId = id;
  }

  clearCorrelationId(): void {
    this.correlationId = null;
  }

  debug(message: string, context?: Record<string, any>): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: Record<string, any>): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: Record<string, any>): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: Record<string, any>, error?: Error): void {
    this.log('error', message, { ...context, error: error?.message, stack: error?.stack });
  }

  private log(level: LogEntry['level'], message: string, context?: Record<string, any>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: this.redactSecrets(context || {}),
      correlationId: this.correlationId || undefined,
    };

    // Console output (development)
    if (import.meta.env.DEV) {
      console.log(JSON.stringify(entry, null, 2));
    }

    // Store in audit log
    observabilityAdapter.logEvent({
      id: crypto.randomUUID(),
      timestamp: entry.timestamp,
      correlationId: entry.correlationId || 'unknown',
      eventType: 'log_entry',
      actor: 'system',
      action: message,
      target: null,
      metadata: entry.context,
      result: level === 'error' ? 'failure' : 'success',
      error: level === 'error' ? message : null,
    });
  }

  private redactSecrets(context: Record<string, any>): Record<string, any> {
    const redacted = { ...context };
    const secretKeys = ['privateKey', 'secret', 'passphrase', 'mnemonic', 'token'];

    for (const key of Object.keys(redacted)) {
      if (secretKeys.some(sk => key.toLowerCase().includes(sk))) {
        redacted[key] = '[REDACTED]';
      }
    }

    return redacted;
  }
}

const logger = new Logger();
export default logger;
```

**Usage Example**:
```typescript
async function issueVoucher(request: IssueVoucherRequest): Promise<IssueVoucherResult> {
  const correlationId = `voucher-issue-${crypto.randomUUID()}`;
  logger.setCorrelationId(correlationId);

  logger.info('Issuing voucher started', {
    amount: request.amount,
    unit: request.unit,
    mintUrl: request.mintUrl,
  });

  try {
    // ... voucher issuance logic
    logger.info('Voucher issued successfully', {
      voucherId: result.voucher.voucherId,
      token: '[REDACTED]',
    });
    return result;
  } catch (error) {
    logger.error('Voucher issuance failed', {
      amount: request.amount,
      mintUrl: request.mintUrl,
    }, error as Error);
    throw error;
  } finally {
    logger.clearCorrelationId();
  }
}
```

### Metrics

**Metrics Collection**:
```typescript
interface Metric {
  name: string;
  value: number;
  unit: string;
  tags: Record<string, string>;
  timestamp: string;
}

class MetricsCollector {
  private metrics: Metric[] = [];

  recordCounter(name: string, value: number, tags?: Record<string, string>): void {
    this.record(name, value, 'count', tags);
  }

  recordGauge(name: string, value: number, tags?: Record<string, string>): void {
    this.record(name, value, 'gauge', tags);
  }

  recordHistogram(name: string, value: number, tags?: Record<string, string>): void {
    this.record(name, value, 'histogram', tags);
  }

  private record(name: string, value: number, unit: string, tags?: Record<string, string>): void {
    const metric: Metric = {
      name,
      value,
      unit,
      tags: tags || {},
      timestamp: new Date().toISOString(),
    };

    this.metrics.push(metric);

    // Send to observability backend if enabled
    if (settingsStore.getState().telemetryEnabled) {
      observabilityAdapter.recordMetric(metric);
    }
  }

  getMetrics(): Metric[] {
    return [...this.metrics];
  }

  clearMetrics(): void {
    this.metrics = [];
  }
}

const metrics = new MetricsCollector();
export default metrics;
```

**Instrumentation Example**:
```typescript
async function redeemVoucher(request: RedeemVoucherRequest): Promise<RedeemVoucherResult> {
  const startTime = performance.now();

  try {
    const result = await voucherService.redeemVoucher(request.token, request.verifyLedger);

    // Record success metrics
    metrics.recordCounter('voucher.redemption.success', 1, {
      mintUrl: result.mintUrl,
      unit: result.unit,
    });

    metrics.recordHistogram('voucher.redemption.duration_ms', performance.now() - startTime, {
      mintUrl: result.mintUrl,
    });

    return result;
  } catch (error) {
    // Record failure metrics
    metrics.recordCounter('voucher.redemption.failure', 1, {
      errorCode: (error as WalletOperationError).errorCode,
    });

    throw error;
  }
}
```

### Tracing (OpenTelemetry)

**Trace Instrumentation**:
```typescript
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';

// Initialize tracer
const provider = new WebTracerProvider();
const exporter = new OTLPTraceExporter({
  url: settingsStore.getState().telemetryEndpoint + '/v1/traces',
});
provider.addSpanProcessor(new BatchSpanProcessor(exporter));
provider.register();

const tracer = trace.getTracer('cashu-web-client', '1.0.0');

// Trace example
async function issueVoucher(request: IssueVoucherRequest): Promise<IssueVoucherResult> {
  return tracer.startActiveSpan('voucher.issue', async (span) => {
    span.setAttribute('amount', request.amount);
    span.setAttribute('unit', request.unit);
    span.setAttribute('mint_url', request.mintUrl);

    try {
      const result = await voucherService.issueVoucher(request);
      span.setStatus({ code: SpanStatusCode.OK });
      span.setAttribute('voucher_id', result.voucher.voucherId);
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (error as Error).message,
      });
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  });
}
```

---

## Testing Strategy

### Testing Pyramid

```
        /\
       /  \          E2E Tests (10%)
      /____\         - Critical user flows
     /      \        - Cross-browser compatibility
    /        \
   /__________\      Integration Tests (30%)
  /            \     - API mocking with MSW
 /              \    - Multi-module interactions
/________________\   Unit Tests (60%)
                     - Pure functions
                     - Component logic
                     - Business logic
```

### Unit Tests (Vitest)

**Example: Voucher Validation**:
```typescript
import { describe, it, expect } from 'vitest';
import { validateVoucher } from './voucherService';

describe('validateVoucher', () => {
  it('should accept valid voucher with all required fields', () => {
    // Arrange
    const voucher: StoredVoucher = {
      voucherId: 'voucher-123',
      issuerId: 'npub1abc...',
      unit: 'sat',
      faceValue: 1000,
      expiresAt: Date.now() + 86400000, // +1 day
      memo: 'Test voucher',
      issuerSignature: '0'.repeat(128), // Valid hex
      issuerPublicKey: '0'.repeat(64), // Valid hex
      issuedAt: new Date().toISOString(),
      status: 'issued',
      token: 'cashuA...',
      deliveryMetadata: null,
      redemptionMetadata: null,
    };

    // Act
    const result = validateVoucher(voucher);

    // Assert
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should reject voucher with expired timestamp', () => {
    // Arrange
    const voucher: StoredVoucher = {
      // ... (same as above)
      expiresAt: Date.now() - 86400000, // -1 day (expired)
    };

    // Act
    const result = validateVoucher(voucher);

    // Assert
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Voucher has expired');
  });

  it('should reject voucher with invalid signature length', () => {
    // Arrange
    const voucher: StoredVoucher = {
      // ... (same as above)
      issuerSignature: '0'.repeat(64), // Too short (should be 128)
    };

    // Act
    const result = validateVoucher(voucher);

    // Assert
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Invalid signature format');
  });
});
```

**Example: Proof Selection Algorithm**:
```typescript
import { describe, it, expect } from 'vitest';
import { selectProofs } from './proofSelector';

describe('selectProofs', () => {
  const proofs: Proof[] = [
    { amount: 1, secret: 'secret1', C: 'C1', id: 'keyset1' },
    { amount: 2, secret: 'secret2', C: 'C2', id: 'keyset1' },
    { amount: 4, secret: 'secret3', C: 'C3', id: 'keyset1' },
    { amount: 8, secret: 'secret4', C: 'C4', id: 'keyset1' },
  ];

  it('should select exact amount when available', () => {
    // Act
    const result = selectProofs(proofs, 7); // 1 + 2 + 4 = 7

    // Assert
    expect(result.selected).toHaveLength(3);
    expect(result.total).toBe(7);
    expect(result.change).toBe(0);
  });

  it('should select minimal proofs with change', () => {
    // Act
    const result = selectProofs(proofs, 6); // 8 = 6 + 2 (change)

    // Assert
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0].amount).toBe(8);
    expect(result.total).toBe(8);
    expect(result.change).toBe(2);
  });

  it('should throw error when insufficient balance', () => {
    // Act & Assert
    expect(() => selectProofs(proofs, 20)).toThrow('Insufficient balance');
  });
});
```

### Integration Tests (MSW)

**Mock Mint API**:
```typescript
import { setupServer } from 'msw/node';
import { rest } from 'msw';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';

const server = setupServer(
  rest.get('https://mint.example.com/v1/info', (req, res, ctx) => {
    return res(
      ctx.json({
        name: 'Test Mint',
        pubkey: 'mint-pubkey',
        version: '1.0.0',
        description: 'Test mint for integration tests',
        description_long: '',
        contact: [],
        motd: '',
        nuts: {
          '4': { methods: [{ method: 'bolt11', unit: 'sat' }] },
          '5': { methods: [{ method: 'bolt11', unit: 'sat' }] },
        },
      })
    );
  }),

  rest.get('https://mint.example.com/v1/keys', (req, res, ctx) => {
    return res(
      ctx.json({
        keysets: [
          {
            id: 'keyset1',
            unit: 'sat',
            keys: {
              '1': 'key1',
              '2': 'key2',
              '4': 'key4',
              '8': 'key8',
            },
          },
        ],
      })
    );
  }),

  rest.post('https://mint.example.com/v1/mint/quote/bolt11', (req, res, ctx) => {
    return res(
      ctx.json({
        quote: 'quote-123',
        request: 'lnbc100n...',
        paid: false,
        expiry: Math.floor(Date.now() / 1000) + 300, // +5 minutes
      })
    );
  })
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('Mint Integration', () => {
  it('should fetch mint info and keys', async () => {
    // Arrange
    const walletService = new WalletService(mintApiAdapter, cryptoAdapter);

    // Act
    const mintInfo = await walletService.connectToMint('https://mint.example.com');

    // Assert
    expect(mintInfo.name).toBe('Test Mint');
    expect(mintInfo.units).toContain('sat');
  });

  it('should request mint quote', async () => {
    // Arrange
    const walletService = new WalletService(mintApiAdapter, cryptoAdapter);

    // Act
    const quote = await walletService.requestMintQuote(100, 'sat', 'https://mint.example.com');

    // Assert
    expect(quote.quoteId).toBe('quote-123');
    expect(quote.amount).toBe(100);
    expect(quote.paid).toBe(false);
  });
});
```

### E2E Tests (Playwright)

**Example: Voucher Issuance Flow**:
```typescript
import { test, expect } from '@playwright/test';

test.describe('Voucher Issuance', () => {
  test('should issue voucher and display QR code', async ({ page }) => {
    // Navigate to app
    await page.goto('http://localhost:5173');

    // Unlock wallet
    await page.fill('input[name="passphrase"]', 'test-passphrase');
    await page.click('button:has-text("Unlock")');

    // Wait for dashboard
    await expect(page.locator('h1:has-text("Wallet Dashboard")')).toBeVisible();

    // Navigate to Issue Voucher
    await page.click('a:has-text("Issue Voucher")');

    // Fill voucher form
    await page.fill('input[name="amount"]', '1000');
    await page.selectOption('select[name="unit"]', 'sat');
    await page.selectOption('select[name="mint"]', 'https://mint.example.com');
    await page.fill('input[name="memo"]', 'Test voucher');

    // Submit form
    await page.click('button:has-text("Issue Voucher")');

    // Wait for success
    await expect(page.locator('text=Voucher issued successfully')).toBeVisible();

    // Verify QR code displayed
    await expect(page.locator('canvas[aria-label="QR Code"]')).toBeVisible();

    // Verify voucher appears in list
    await page.click('a:has-text("My Vouchers")');
    await expect(page.locator('text=Test voucher')).toBeVisible();
  });

  test('should redeem voucher and update balance', async ({ page }) => {
    // Navigate to app
    await page.goto('http://localhost:5173');

    // Unlock wallet
    await page.fill('input[name="passphrase"]', 'test-passphrase');
    await page.click('button:has-text("Unlock")');

    // Get initial balance
    const initialBalance = await page.locator('[data-testid="balance-sat"]').textContent();

    // Navigate to Redeem Voucher
    await page.click('a:has-text("Redeem Voucher")');

    // Paste voucher token
    await page.fill('textarea[name="token"]', 'cashuA...');

    // Submit redemption
    await page.click('button:has-text("Redeem")');

    // Wait for success
    await expect(page.locator('text=Voucher redeemed successfully')).toBeVisible();

    // Verify balance increased
    await page.click('a:has-text("Dashboard")');
    const newBalance = await page.locator('[data-testid="balance-sat"]').textContent();
    expect(parseInt(newBalance!)).toBeGreaterThan(parseInt(initialBalance!));
  });
});
```

### Property-Based Testing (fast-check)

**Example: Proof Selection Properties**:
```typescript
import fc from 'fast-check';
import { describe, it } from 'vitest';
import { selectProofs } from './proofSelector';

describe('selectProofs (property-based)', () => {
  it('should always select proofs totaling >= requested amount', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({
          amount: fc.integer({ min: 1, max: 100 }),
          secret: fc.hexaString({ minLength: 64, maxLength: 64 }),
          C: fc.hexaString({ minLength: 64, maxLength: 64 }),
          id: fc.constant('keyset1'),
        }), { minLength: 1, maxLength: 20 }),
        fc.integer({ min: 1, max: 100 }),
        (proofs, amount) => {
          const totalAvailable = proofs.reduce((sum, p) => sum + p.amount, 0);

          if (totalAvailable < amount) {
            // Should throw error
            expect(() => selectProofs(proofs, amount)).toThrow();
          } else {
            // Should select proofs
            const result = selectProofs(proofs, amount);
            expect(result.total).toBeGreaterThanOrEqual(amount);
            expect(result.total).toBeLessThanOrEqual(totalAvailable);
          }
        }
      )
    );
  });
});
```

---

## Deployment

### Build Configuration

**Vite Configuration** (`vite.config.ts`):
```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Cashu Voucher Wallet',
        short_name: 'Cashu Wallet',
        description: 'Manage Cashu vouchers and wallets',
        theme_color: '#4f46e5',
        icons: [
          {
            src: '/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
        ],
      },
    }),
  ],
  build: {
    target: 'es2020',
    minify: 'terser',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-crypto': ['@noble/secp256k1', '@noble/hashes', '@scure/bip39'],
          'vendor-nostr': ['nostr-tools'],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
```

### Docker Deployment

**Dockerfile**:
```dockerfile
# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

# Production stage
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
```

**nginx.conf**:
```nginx
server {
  listen 80;
  server_name _;

  root /usr/share/nginx/html;
  index index.html;

  # Security headers
  add_header X-Frame-Options "DENY" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header X-XSS-Protection "1; mode=block" always;
  add_header Referrer-Policy "no-referrer" always;
  add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://mint.* wss://relay.*;" always;

  # SPA routing
  location / {
    try_files $uri $uri/ /index.html;
  }

  # Cache static assets
  location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }

  # Disable caching for index.html
  location = /index.html {
    add_header Cache-Control "no-cache, no-store, must-revalidate";
  }
}
```

### Hosting Options

**Option 1: Static Hosting (Vercel, Netlify, Cloudflare Pages)**
- Zero configuration deployment
- Automatic HTTPS
- Global CDN
- Free tier available

**Option 2: Self-Hosted (Docker + Nginx)**
- Full control over infrastructure
- Custom domain and certificates (Let's Encrypt)
- Can be hosted alongside Java backend

**Option 3: IPFS (Decentralized)**
- Censorship-resistant
- No single point of failure
- Access via IPFS gateways or native clients

---

## Migration from CLI

### Export CLI State

**CLI Command** (to be implemented):
```bash
cashu-wallet export-state --output wallet-state.json --encrypt
```

**Output Format** (aligned with `WalletState` record):
```json
{
  "schema": {
    "version": 1,
    "format": "cashu-wallet-state"
  },
  "exportedAt": "2025-11-17T14:32:10.123Z",
  "encryptedMnemonic": "...",
  "deterministicMode": true,
  "derivationCounters": {
    "keyset1": 10,
    "keyset2": 5
  },
  "tokens": [
    {
      "mintUrl": "https://mint.example.com",
      "tokenId": "token-123",
      "amount": 1000,
      "unit": "sat",
      "issuedAt": "2025-11-17T14:00:00.000Z",
      "proofs": ["proof1", "proof2"],
      "relay": null
    }
  ],
  "vouchers": [
    {
      "voucherId": "voucher-123",
      "issuerId": "npub1...",
      "unit": "sat",
      "faceValue": 1000,
      "expiresAt": 1732118400,
      "memo": "Test voucher",
      "issuerSignature": "...",
      "issuerPublicKey": "...",
      "issuedAt": "2025-11-17T14:00:00.000Z",
      "status": "issued"
    }
  ],
  "history": [...],
  "quarantined": []
}
```

### Import to Web Client

**Import Flow**:
1. User navigates to Settings → Import → CLI State
2. User uploads `wallet-state.json` file
3. Web client validates schema version
4. User enters passphrase (if encrypted)
5. Web client decrypts and parses state
6. Web client imports:
   - Identities (from encrypted mnemonic)
   - Mints (from tokens)
   - Proofs (from tokens)
   - Vouchers (from vouchers array)
   - History (from history array)
7. Web client displays import summary
8. User confirms import
9. Web client stores state in encrypted localStorage

**Code**:
```typescript
async function importCliState(file: File, passphrase?: string): Promise<ImportResult> {
  // Read file
  const fileContent = await file.text();
  const state = JSON.parse(fileContent);

  // Validate schema
  if (state.schema.version !== 1) {
    throw new Error(`Unsupported schema version: ${state.schema.version}`);
  }

  // Decrypt mnemonic
  if (state.encryptedMnemonic && !passphrase) {
    throw new Error('Passphrase required to decrypt mnemonic');
  }

  let mnemonic: string;
  if (state.encryptedMnemonic) {
    mnemonic = await decryptMnemonic(state.encryptedMnemonic, passphrase!);
  } else {
    throw new Error('No mnemonic found in state file');
  }

  // Import identity
  const identity = await identityService.importFromMnemonic(mnemonic);

  // Import mints
  const mints = new Set(state.tokens.map(t => t.mintUrl));
  for (const mintUrl of mints) {
    await walletService.addMint(mintUrl, ['sat']); // Units from tokens
  }

  // Import proofs
  const proofs = state.tokens.flatMap(t => t.proofs);
  await walletService.importProofs(proofs);

  // Import vouchers
  for (const voucher of state.vouchers) {
    await voucherService.importVoucher(voucher);
  }

  // Import history
  for (const event of state.history) {
    await auditService.logEvent(event);
  }

  return {
    identitiesImported: 1,
    mintsImported: mints.size,
    proofsImported: proofs.length,
    vouchersImported: state.vouchers.length,
    historyEventsImported: state.history.length,
  };
}
```

---

## Open Questions & Decisions

### 1. Framework Selection

**Question**: React vs. Vue vs. Svelte?

**Recommendation**: **React 18+ with TypeScript**

**Rationale**:
- Largest ecosystem and community
- Best TypeScript support
- Mature testing tooling
- Team familiarity (assumed)

**Decision Date**: TBD (requires team input)

---

### 2. Nostr Relay Authentication

**Question**: How to handle NIP-42 auth across tabs/sessions?

**Options**:

**A. Ephemeral Auth per Tab**:
- Each tab authenticates independently
- No shared session state
- Simple implementation
- **Downside**: Multiple auth challenges for same user

**B. Shared Auth via BroadcastChannel**:
- One tab authenticates, shares token with others
- Reduced relay load
- **Downside**: Complex synchronization, security risks

**Recommendation**: **Option A (Ephemeral Auth per Tab)**

**Rationale**:
- Simpler and more secure
- Relay auth is lightweight (one event per connection)
- No cross-tab synchronization complexity

**Decision Date**: TBD

---

### 3. Mint/Relay Timeout Defaults

**Question**: What SLA/timeout defaults for mint/relay operations?

**Recommendation**:

| Operation | Timeout | Retry Strategy |
|-----------|---------|----------------|
| Mint info fetch | 10s | 3 retries, exponential backoff (1s, 2s, 4s) |
| Mint quote request | 15s | 3 retries |
| Mint quote check | 5s | 10 retries (polling every 5s for 50s total) |
| Mint/swap operation | 30s | No retry (idempotency required) |
| Relay connection | 10s | 5 retries |
| Relay publish | 10s | 3 retries (different relays) |

**UI Exposure**:
- Display timeout progress bar
- Allow manual cancel
- Show retry count ("Retrying 2/3...")

**Decision Date**: TBD (validate with production data)

---

### 4. Multi-Identity Profiles

**Question**: Should the app support multiple identity profiles in one browser?

**Options**:

**A. Single Active Identity**:
- User selects one identity at a time
- Simpler UX
- **Downside**: Cannot manage multiple personas simultaneously

**B. Multi-Identity with Switching**:
- User can switch between identities
- Each identity has separate state (wallets, vouchers)
- **Downside**: Complex state management

**Recommendation**: **Option B (Multi-Identity with Switching)**

**Rationale**:
- Supports common use case (personal vs. business identities)
- Aligns with CLI multi-identity support
- Can be implemented incrementally (start with single identity in M1)

**Decision Date**: TBD

---

### 5. Voucher Draft Sharing Across Devices

**Question**: Should voucher drafts be shareable across devices?

**Options**:

**A. Local-Only Drafts**:
- Drafts stored in browser localStorage
- No cross-device sync
- **Downside**: Lost on browser clear/device change

**B. Nostr Relay Backup**:
- Drafts encrypted and published to relay
- User can fetch on new device
- **Downside**: Relay dependency, privacy concerns

**C. Optional Backend Sync**:
- User opts in to backend storage
- Encrypted drafts synced via backend API
- **Downside**: Requires backend service

**Recommendation**: **Option A (Local-Only) for M1, Option B (Relay Backup) for M4**

**Rationale**:
- Start simple with local-only
- Add relay backup in M4 (after core flows stable)
- Backend sync optional for future (M5+)

**Decision Date**: TBD

---

## Appendix

### A. Glossary

| Term | Definition |
|------|------------|
| **Proof** | A Cashu proof (blinded signature) representing value |
| **Token** | A collection of proofs serialized for transfer |
| **Voucher** | A P2PK-locked token with metadata (face value, expiry, memo) |
| **Mint** | A Cashu mint (issuer of proofs) |
| **KeySet** | A set of public keys used by a mint for signing |
| **Quote** | A mint's offer to mint or melt tokens (with expiry) |
| **Swap** | Exchange proofs with a mint (e.g., for change or consolidation) |
| **Melt** | Redeem proofs for Lightning payment |
| **P2PK** | Pay-to-public-key (spending condition requiring signature) |
| **NIP** | Nostr Implementation Possibility (protocol specification) |
| **NUT** | Notation, Usage, and Terminology (Cashu protocol specification) |

### B. References

- [Cashu NUT Specifications](https://github.com/cashubtc/nuts)
- [Nostr NIPs](https://github.com/nostr-protocol/nips)
- [NUT Specifications Analysis (Web Client)](../../docs/reference/nut-specifications-web-client-analysis.md)
- [Web Client High-Level Specification](./web-client-spec.md)
- [Clean Code (Robert C. Martin)](https://dev.398ja.xyz/books/Clean_Code.pdf)
- [Clean Architecture (Robert C. Martin)](https://dev.398ja.xyz/books/Clean_Architecture.pdf)
- [Diátaxis Documentation Framework](https://diataxis.fr/)

### C. Change Log

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2025-11-17 | Claude Code | Initial detailed specification |

