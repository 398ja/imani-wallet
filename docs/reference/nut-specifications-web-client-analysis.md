# NUT Specifications Analysis for Web Client Implementation

This document provides a structured analysis of Cashu NUT specifications relevant to the web client voucher management system. Each section maps protocol requirements to frontend implementation concerns including UI/UX patterns, data structures, error handling, and security considerations.

## Table of Contents
1. [NUT-00: Core Protocol Foundation](#nut-00-core-protocol-foundation)
2. [NUT-07: Token State Check](#nut-07-token-state-check)
3. [NUT-10: Spending Conditions](#nut-10-spending-conditions)
4. [NUT-11: Pay-to-Public-Key (P2PK)](#nut-11-pay-to-public-key-p2pk)
5. [NUT-17: WebSocket Subscriptions](#nut-17-websocket-subscriptions)
6. [Nostr Integration: NIP-04, NIP-42, NIP-44](#nostr-integration-nip-04-nip-42-nip-44)
7. [Implementation Roadmap](#implementation-roadmap)

---

## NUT-00: Core Protocol Foundation

### 1. Core Concepts Relevant to Web Client UI/UX

**Key Actors**:
- **Alice** (User/Sender): Client-side entity creating and managing vouchers
- **Bob** (Mint): Server providing blind signatures for proof issuance
- **Carol** (Receiver): Recipient validating and redeeming vouchers

**Essential Entities**:
- **Token**: Serialized collection of proofs representing value, transferred via URLs/QR codes
- **Proof**: Individual cryptographic assertion containing `{amount, id, secret, C}`
- **Keyset**: Mint's public keys for a specific denomination set, identified by keyset ID

**Blind Diffie-Hellman Key Exchange (BDHKE)**:
- Mint cannot observe the secret before signing, preserving user privacy
- Client performs blinding/unblinding operations transparently
- Hash-to-curve operations map secrets to elliptic curve points deterministically

### 2. Data Structures for Frontend

**BlindedMessage** (Client → Mint during issuance/swap):
```json
{
  "amount": 8,
  "id": "009a1f293253e41e",
  "B_": "02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2"
}
```

**BlindSignature** (Mint → Client response):
```json
{
  "amount": 8,
  "id": "009a1f293253e41e",
  "C_": "02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2"
}
```

**Proof** (Final token structure):
```json
{
  "amount": 8,
  "id": "009a1f293253e41e",
  "secret": "407915bc212be61a77e3e6d2aeb4c727980bda51cd06a6afc29e2861768a7837",
  "C": "02bc9097997d81afb2cc7346b5e4345a9346bd2a506eb7958598a72f0cf85163ea"
}
```

**Token Serialization Formats**:

**V3 (Deprecated)**: Base64-encoded JSON, supports multi-mint tokens
```
cashuAeyJ0b2tlbiI6W3sibWludCI6Imh0dHBzOi8vODMzMy5zcGFjZTo...
```

**V4 (Current)**: CBOR binary format, single-mint, space-efficient
```
cashuBo2F0gaJhYQFhc3RjYXNodWF1Z...
```

**Token Structure (V4)**:
```json
{
  "token": [
    {
      "mint": "https://mint.example.com",
      "proofs": [
        {/* proof object */}
      ]
    }
  ],
  "unit": "sat",
  "memo": "Birthday gift from Alice"
}
```

### 3. User-Facing Operations

**User-Initiated Actions**:
- **Mint new tokens**: Request quote, pay invoice, receive proofs
- **Send tokens**: Serialize proofs, generate URL/QR, share with recipient
- **Receive tokens**: Parse token string, validate proofs, redeem at mint
- **Swap tokens**: Split/combine amounts, rotate secrets for privacy

**Automatic/Background Operations** (Hidden from UI):
- Blinding factor generation (`r = random_bytes(32)`)
- Hash-to-curve computation (`Y = hash_to_curve(secret)`)
- Blind signature unblinding (`C = C_ - r*K`)
- Proof verification (`k*hash_to_curve(secret) == C`)
- Keyset management and rotation

**UI Implications**:
- Display simplified "Issue Voucher" → "Share" → "Redeem" flow
- Show progress indicators for cryptographic operations
- Present token amounts and units prominently
- Allow optional memo attachment for context

### 4. Error Conditions Requiring UI Handling

**HTTP 400 Error Response Format**:
```json
{
  "detail": "Token already spent",
  "code": 11001
}
```

**Error Categories**:
- **Invalid Signature**: Proof verification failed, display "Invalid voucher"
- **Spent Secret**: Token already redeemed, show "Already redeemed by someone else"
- **Unknown Keyset**: Mint rotated keys, suggest "Update mint configuration"
- **Network Failure**: Mint unreachable, offer "Retry" or "Try different mint"
- **Invalid Format**: Malformed token string, show "Invalid voucher format"

**UI Error Handling Pattern**:
```
{WHAT_HAPPENED}. {WHY_IT_HAPPENED}. Suggestion: {ACTIONABLE_STEP}.
```

Example:
```
"Voucher redemption failed. The voucher has already been spent. Suggestion: Verify with the sender that you received the correct voucher link."
```

### 5. Security Considerations for Client-Side Implementation

**Secret Generation**:
- Use `crypto.getRandomValues()` (Web Crypto API) for 32-byte secrets
- Encode as 64-character hex string to prevent fingerprinting
- Never reuse secrets across proofs

**Blinding Factor Security**:
- Generate fresh random `r` for each proof request
- Discard immediately after unblinding
- Prevent linkability between request and redemption

**Token Verification Before Acceptance**:
```javascript
// Verify proof signature client-side before storing
const Y = hashToCurve(proof.secret);
const valid = multiply(keyset.publicKey, Y).equals(proof.C);
if (!valid) {
  throw new Error("Invalid proof signature");
}
```

**URL Handling**:
- Strip trailing slashes from mint URLs: `https://mint.example.com/` → `https://mint.example.com`
- Enforce HTTPS-only for production mints
- Validate mint domain against allowlist before connecting

**Local Storage Security**:
- Encrypt proofs before storing in `localStorage`/`IndexedDB`
- Use user-provided passphrase with PBKDF2 key derivation
- Clear sensitive data from memory after operations

**Privacy Considerations**:
- Token serialization reveals mint URL, amounts, and memo
- Secrets are sensitive—treat like private keys
- Consider rotating secrets periodically via swaps

---

## NUT-07: Token State Check

### 1. Core Concepts Relevant to Web Client

**Proof States**:
- **UNSPENT**: Voucher has not been redeemed yet
- **PENDING**: Voucher is currently being processed in a transaction (mutex-locked by mint)
- **SPENT**: Voucher has been redeemed, secret is in spent list

**State Check Use Cases**:

**Ecash Transfer Tracking**:
- Sender marks vouchers as "sent" locally
- Periodically checks if recipient redeemed them (SPENT)
- Deletes local records once confirmed spent

**Long-Running Payment Monitoring**:
- User initiates Lightning melt operation
- Operation takes extended time (route finding, settlement)
- Client reconnects and checks PENDING proofs to determine outcome
- Display appropriate status: "Processing...", "Completed", or "Failed"

**Mutex Locking Behavior**:
- Mint locks proofs during active transactions using Y-value as mutex key
- Prevents concurrent double-spend attempts
- Locked proofs return PENDING state until transaction completes

### 2. Data Structures

**Request Format** (POST `/v1/checkstate`):
```json
{
  "Ys": [
    "02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2",
    "02b3e9b5d6c5e1f6d8a9c5e1f6d8a9c5e1f6d8a9c5e1f6d8a9c5e1f6d8a9c5e1f6"
  ]
}
```

Where `Ys` contains compressed elliptic curve points derived from proof secrets:
```javascript
const Y = hashToCurve(proof.secret);
const compressedY = Y.toHex(true); // compressed format
```

**Response Format**:
```json
{
  "states": [
    {
      "Y": "02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2",
      "state": "SPENT",
      "witness": null
    },
    {
      "Y": "02b3e9b5d6c5e1f6d8a9c5e1f6d8a9c5e1f6d8a9c5e1f6d8a9c5e1f6d8a9c5e1f6",
      "state": "UNSPENT",
      "witness": null
    }
  ]
}
```

**Response Array Ordering**:
- Response order MUST match request order
- Map results back to original proofs by index

**Witness Field**:
- Contains serialized spending condition data for NUT-10/11/14 proofs
- Null for standard proofs
- Used for P2PK signatures, HTLC preimages, etc.

### 3. User-Facing Operations

**Voucher Validation Before Acceptance**:
```
User receives voucher link
  → Client parses proofs
  → Check state for all proofs
  → Display status: "Valid (Unspent)" or "Already redeemed"
  → Allow redemption only if all UNSPENT
```

**Sent Voucher Tracking**:
```
User sends voucher to recipient
  → Mark as "Sent, awaiting redemption" locally
  → Background polling: check state every 30s
  → Transition to "Redeemed by recipient" when SPENT
  → Offer "Delete record" action
```

**Payment Status Monitoring**:
```
User initiates Lightning payment (melt)
  → Display "Processing payment..."
  → Poll state every 5s for PENDING proofs
  → Transition to "Payment complete" (SPENT) or "Payment failed" (UNSPENT)
```

**UI State Indicators**:
- 🟢 **UNSPENT**: "Ready to redeem" or "Available"
- 🟡 **PENDING**: "Processing..." with spinner
- 🔴 **SPENT**: "Already redeemed" or "Completed"

### 4. Error Conditions

**No Explicit Error Spec**:
- NUT-07 does not define specific error codes
- Standard HTTP errors apply (400 for invalid request, 500 for server error)

**Client-Side Error Handling**:
```javascript
try {
  const response = await checkProofState(Ys);
  // Handle states
} catch (error) {
  if (error.status === 400) {
    // Invalid Y values or malformed request
    displayError("Unable to verify voucher status. Invalid proof data.");
  } else if (error.status === 500) {
    // Mint error
    displayError("Mint unavailable. Please try again later.");
  } else {
    // Network error
    displayError("Network error. Check your connection and retry.");
  }
}
```

**Missing Y Values**:
- If mint does not recognize a Y value, it may return UNSPENT (never seen) or error
- Client should handle gracefully and log for debugging

### 5. Security Considerations

**Privacy Risk**:
> "This behavior can make it easier for the mint to correlate the sender to the receiver."

**Mitigation Strategies**:
- Minimize state check frequency to reduce correlation opportunities
- Batch multiple proof checks in single request when possible
- Consider using different network paths (VPN/Tor) for checks vs. redemptions
- Implement randomized check intervals to prevent timing analysis

**Rate Limiting**:
- Mints may rate-limit state check requests
- Implement exponential backoff for polling
- Cache results locally with TTL to reduce redundant checks

**Concurrent Transaction Safety**:
- PENDING state prevents double-spend during active transactions
- Client should retry redemption if PENDING state persists unexpectedly
- Timeout after reasonable period (e.g., 5 minutes) and escalate to user

**Client-Side Best Practices**:
- Never check state for proofs you don't own (privacy leak)
- Clear Y-value records from memory after checks
- Log check operations with correlation IDs for troubleshooting
- Allow user to manually refresh state rather than aggressive auto-polling

---

## NUT-10: Spending Conditions

### 1. Core Concepts

**Spending Conditions** extend basic ecash with programmable unlock requirements. Instead of revealing a random secret to spend a proof, the secret follows a structured JSON format that encodes constraints enforced by the mint.

**Secret Format Evolution**:
- **Basic Ecash**: `"secret": "407915bc212be61a77e3e6d2aeb4c727980bda51cd06a6afc29e2861768a7837"`
- **Spending Condition**: `"secret": "[\"P2PK\", {\"nonce\": \"...\", \"data\": \"...\", \"tags\": [...]}]"`

**Key Principle**:
> "Spending conditions are expressed in a well-known secret format that is revealed to the mint when spending."

**Privacy Preservation**:
- Conditions are NOT visible during issuance (blind signatures)
- Only revealed when proofs are spent/redeemed
- Mint validates conditions at redemption time

### 2. Data Structures

**Structured Secret Format**:
```json
[
  "<condition_kind>",
  {
    "nonce": "<random_hex_32_bytes>",
    "data": "<condition_specific_data>",
    "tags": [
      ["<tag_name>", "<tag_value>"],
      ["<tag_name>", "<tag_value>"]
    ]
  }
]
```

**Components**:
- **kind**: Identifies condition type (e.g., "P2PK", "HTLC")
- **nonce**: Unique random value preventing secret reuse across conditions
- **data**: Condition-specific constraint information (e.g., public key for P2PK)
- **tags**: Optional metadata supporting variations (e.g., signature flags, locktime)

**Example P2PK Secret**:
```json
[
  "P2PK",
  {
    "nonce": "859d4935c4907062a6297cf4e663e2835d90d97ecdd510745d32f6816323a41f",
    "data": "0249098aa8b9d2fbec49ff8598feb17b592b986e62319a4fa488a3dc36387157a7",
    "tags": [
      ["sigflag", "SIG_INPUTS"]
    ]
  }
]
```

**Witness Data** (provided during spending):
```json
{
  "witness": "{\"signatures\": [\"<signature_hex>\"]}"
}
```

Witness contains proof-specific unlock data:
- **P2PK**: Schnorr signatures
- **HTLC**: Hash preimages
- **Future conditions**: Custom unlock mechanisms

### 3. User Operations vs. Automatic Verification

**User-Initiated Actions**:

**Creating Locked Vouchers**:
```
User selects "Lock to recipient identity"
  → Client generates P2PK secret with recipient's pubkey
  → Request blind signature from mint
  → Receive proof with locked secret
  → Share voucher (recipient's key required to unlock)
```

**Unlocking Received Vouchers**:
```
User receives identity-locked voucher
  → Client detects P2PK condition in secret
  → Prompt user: "This voucher is locked to your identity. Sign to redeem?"
  → Generate signature using user's private key
  → Attach witness to proof
  → Submit to mint for redemption
```

**Automatic Verification**:
- **Mint-Side**: Validate signatures/preimages match conditions in secrets
- **Client-Side**: Verify mint supports required condition types before issuance
- **Proof-Level Enforcement**: Each proof validated independently, all must pass

**Important Constraint**:
> "All proofs in a transaction must unlock successfully for validity."

Single failed condition blocks entire transaction.

### 4. Error Conditions

**Unsupported Condition Type**:
```
Mint does not implement requested condition kind
  → Proofs may be treated as "anyone-can-spend" tokens (security risk!)
  → Client MUST verify mint capability before creating locked proofs
```

**Verification Check** (via NUT-06 info endpoint):
```json
GET /v1/info
{
  "nuts": {
    "10": {
      "supported": ["P2PK", "HTLC"]
    }
  }
}
```

**Client Error Handling**:
```javascript
const mintInfo = await fetchMintInfo(mintUrl);
if (!mintInfo.nuts[10]?.supported.includes("P2PK")) {
  throw new Error(
    "This mint does not support identity-locked vouchers. " +
    "Suggestion: Choose a different mint or create a standard voucher."
  );
}
```

**Invalid Witness**:
```
Mint validates spending condition and rejects invalid witness
  → HTTP 400: "Invalid signature for P2PK condition"
  → Client displays: "Failed to unlock voucher. Verify you used the correct identity key."
```

**Partial Condition Failure**:
```
Transaction contains 5 proofs, 4 unlock successfully, 1 fails
  → Entire transaction rejected
  → Display: "Unable to redeem voucher. One or more proofs failed validation."
```

### 5. Security Considerations for Web Clients

**Capability Verification**:
- **ALWAYS check mint support** before creating locked proofs
- Cache mint capabilities to avoid redundant requests
- Display warning if switching to mint with reduced capability

**Key Management**:
- P2PK requires secure storage of private keys
- Use Web Crypto API `SubtleCrypto` for signing operations
- Never expose private keys in logs or error messages
- Consider hardware wallet integration for high-value vouchers

**Downgrade Attack Prevention**:
```
Attacker provides mint URL claiming P2PK support
  → Mint silently ignores conditions, treats as anyone-can-spend
  → Recipient redeems without signature, stealing funds
```

**Mitigation**:
- Verify mint advertises condition support in `/v1/info`
- Warn user if redeeming locked proof at unsupported mint
- Consider requiring explicit user confirmation for high-value locked proofs

**Privacy Implications**:
- Spending conditions reveal constraint details to mint at redemption
- P2PK exposes recipient's public key to mint
- Consider privacy/security tradeoff when choosing condition types

**Multi-Proof Coordination**:
- Generate unique nonces for each proof even within same transaction
- Track witness data per proof independently
- Handle partial signing scenarios (multisig) carefully

**Client-Side Validation**:
- Verify proof structure before submission
- Validate witness format matches condition requirements
- Log condition types and outcomes for audit trail

---

## NUT-11: Pay-to-Public-Key (P2PK)

### 1. Core Concepts Relevant to Web Client

**Pay-to-Public-Key (P2PK)** enables identity-bound ecash tokens locked to a recipient's ECC public key. The mint enforces unlocking by validating Schnorr signatures over SHA256 message hashes.

**Key Features**:
- **Identity Binding**: Tokens redeemable only by holder of corresponding private key
- **Multisig Support**: Require N-of-M signatures from specified public keys
- **Time Locks**: Optional `locktime` for delayed spending, `refund` for recovery
- **Signature Modes**:
  - **SIG_INPUTS** (default): Each proof signed independently
  - **SIG_ALL**: All inputs/outputs signed together in aggregated message

**Use Cases in Voucher Flows**:
- Recipient-specific vouchers preventing theft/interception
- Gift vouchers redeemable only by intended person
- Conditional vouchers with time-based unlock
- Multi-party escrow requiring multiple signatures

### 2. Data Structures for Frontend

**P2PK Secret Structure**:
```json
[
  "P2PK",
  {
    "nonce": "859d4935c4907062a6297cf4e663e2835d90d97ecdd510745d32f6816323a41f",
    "data": "0249098aa8b9d2fbec49ff8598feb17b592b986e62319a4fa488a3dc36387157a7",
    "tags": [
      ["sigflag", "SIG_INPUTS"]
    ]
  }
]
```

**Components**:
- **nonce**: 32 random bytes (hex-encoded), prevents secret reuse
- **data**: Recipient's compressed secp256k1 public key (33 bytes hex)
- **tags**: Optional configuration arrays

**Supported Tags**:

**sigflag**:
```json
["sigflag", "SIG_INPUTS"]  // Default: sign each proof individually
["sigflag", "SIG_ALL"]     // Sign all inputs/outputs together
```

**n_sigs** (multisig):
```json
["n_sigs", "2"]  // Require 2 unique signatures
```

**pubkeys** (multisig):
```json
["pubkeys", "pubkey1", "pubkey2", "pubkey3"]  // Allowed signers
```

**locktime** (Unix timestamp):
```json
["locktime", "1736870400"]  // Spendable after 2025-01-14 12:00:00 UTC
```

**refund** (refund public key):
```json
["refund", "pubkey_hex"]  // Refund destination if locktime expires
```

**Proof with P2PK Witness**:
```json
{
  "amount": 8,
  "secret": "[\"P2PK\", {...}]",
  "C": "02698c4e2b5f9534cd0687d87513c759790cf829aa5739184a3e3735471fbda904",
  "id": "009a1f293253e41e",
  "witness": "{\"signatures\": [\"6d519b8f37f21b0c8b3ba05c287e6e17d53e0779b353e1b71234ac05be6c6a2ffbb5af2f318c5c2f7af8b80f9ba11cd0bde1c79e786a1f5b9d36f3a3ccf2d0c0\"]}"
}
```

**P2PKWitness Structure**:
```json
{
  "signatures": [
    "signature_hex_1",
    "signature_hex_2"  // For multisig
  ]
}
```

### 3. User-Facing Operations

**Creating Identity-Locked Vouchers**:

**UI Flow**:
```
1. User initiates "Issue Voucher"
2. Optional step: "Lock to recipient identity?"
   - Toggle: "Lock voucher" (off by default)
   - If enabled: Input recipient's public key or NIP-05 identifier
3. Client generates P2PK secret with recipient's pubkey
4. Display: "Creating identity-locked voucher for [recipient]..."
5. Request blind signature from mint
6. Show success: "Voucher created and locked to [recipient_id]"
7. Share voucher link/QR
```

**Sample UI Message**:
```
🔒 This voucher is locked to alice@example.com
Only they can redeem it with their identity key.
```

**Unlocking Received Vouchers**:

**UI Flow**:
```
1. User receives voucher link, clicks/scans
2. Client parses proofs, detects P2PK condition
3. Display modal:
   "🔑 Identity Verification Required

   This voucher is locked to your identity.
   Sign with your key to redeem.

   [Sign and Redeem] [Cancel]"
4. User confirms
5. Client generates Schnorr signature:
   - Message: serialized secret string
   - Private key: user's identity key
6. Attach witness to proof
7. Submit to mint for redemption
8. Display: "Voucher redeemed successfully! +8 sats"
```

**Locktime-Based Vouchers**:

**UI Flow**:
```
1. User receives voucher with locktime: 1736870400
2. Current time: 1736860000 (before locktime)
3. Display:
   "⏰ Time-Locked Voucher

   This voucher can be redeemed after:
   January 14, 2025 at 12:00 PM UTC

   Time remaining: 2 hours 53 minutes

   [Set Reminder] [Close]"
4. After locktime expires:
   "✅ Voucher Ready

   The time lock has expired. You can now redeem this voucher.

   [Redeem Now]"
```

**Signature Mode Handling (SIG_ALL)**:

**Automatic for Most Users**:
- Client detects SIG_ALL flag in first proof
- Aggregates message from all inputs/outputs:
  ```
  msg = secret_0 || C_0 || ... || secret_n || C_n || amount_0 || B_0 || ... || amount_m || B_m
  ```
- Sign aggregated message once
- Attach witness to first proof only
- Submit transaction

**UI Simplification**:
- Hide signature mode complexity from users
- Display as standard "Sign to redeem" flow
- Log aggregation details for debugging

### 4. Error Conditions During P2PK Operations

**Mint Lacks P2PK Support**:
```
Request: Create P2PK locked voucher
Mint response: Does not advertise NUT-11 in /v1/info

Error: "Identity-locked vouchers not supported by this mint. Suggestion: Choose a different mint from the list or create a standard voucher."
```

**Invalid Signature**:
```
Request: Redeem P2PK proof with incorrect signature
Mint response: HTTP 400 - "Invalid P2PK signature"

Error: "Failed to unlock voucher. The signature verification failed. Suggestion: Verify you're using the correct identity key."
```

**Insufficient Multisig Signatures**:
```
Request: Redeem multisig proof requiring 2 signatures, only 1 provided
Mint response: HTTP 400 - "Insufficient signatures for multisig condition"

Error: "This voucher requires 2 signatures but only 1 was provided. Suggestion: Contact the other authorized parties to complete redemption."
```

**Locktime Not Yet Expired**:
```
Request: Redeem time-locked proof before locktime
Mint response: HTTP 400 - "Locktime condition not satisfied"

Error: "This voucher is time-locked and cannot be redeemed until January 14, 2025 at 12:00 PM UTC. Suggestion: Wait until the unlock time or request a refund if available."
```

**Mismatched Public Keys in SIG_ALL**:
```
Request: Swap with SIG_ALL, proofs have different pubkeys in data field
Mint response: HTTP 400 - "All proofs must have same pubkey for SIG_ALL"

Error: "Unable to process transaction. Mixed identity-locked proofs detected. Suggestion: Redeem proofs locked to different identities separately."
```

**Refund Key Not Recognized**:
```
Request: Attempt refund after locktime with invalid refund key
Mint response: HTTP 400 - "Invalid refund signature"

Error: "Refund failed. The refund key signature is invalid. Suggestion: Verify you're using the correct refund key specified when the voucher was created."
```

### 5. Security Best Practices for Client-Side P2PK

**Key Management**:

**Private Key Storage**:
- Use Web Crypto API `SubtleCrypto.generateKey()` for key generation
- Store private keys encrypted in IndexedDB
- Derive encryption key from user passphrase using PBKDF2
- Never expose private keys in logs, error messages, or network requests

**Signing Operations**:
```javascript
// Secure signing flow
async function signP2PKProof(proof, privateKey) {
  // Hash the secret (SHA256)
  const message = new TextEncoder().encode(proof.secret);
  const messageHash = await crypto.subtle.digest('SHA-256', message);

  // Generate Schnorr signature
  const signature = await schnorrSign(messageHash, privateKey);

  // Attach witness
  proof.witness = JSON.stringify({
    signatures: [signature.toString('hex')]
  });

  // Clear sensitive data from memory
  messageHash.fill(0);

  return proof;
}
```

**Capability Verification**:

**Pre-Issuance Check**:
```javascript
async function validateMintSupportsP2PK(mintUrl) {
  const info = await fetch(`${mintUrl}/v1/info`).then(r => r.json());

  if (!info.nuts?.[11]?.supported) {
    throw new WalletOperationException(
      "MINT_P2PK_UNSUPPORTED",
      false,
      `Mint ${mintUrl} does not support identity-locked vouchers.`,
      "Choose a different mint or create a standard voucher without identity locking."
    );
  }

  // Check for specific features
  const supportsMultisig = info.nuts[11].methods?.includes('multisig');
  const supportsLocktime = info.nuts[11].methods?.includes('locktime');

  return { supportsMultisig, supportsLocktime };
}
```

**Downgrade Attack Prevention**:

**Threat Model**:
```
Attacker provides malicious mint URL
  → Mint claims P2PK support in /v1/info
  → Mint silently ignores P2PK conditions during redemption
  → Anyone can redeem "locked" voucher without signature
```

**Mitigation**:
- Maintain allowlist of trusted mints
- Require user confirmation for new mints
- Test P2PK functionality on low-value voucher before trusting mint
- Monitor mint behavior and flag inconsistencies

**Offline Signature Verification**:

**DLEQ Proofs** (NUT-12):
- Combine P2PK with DLEQ proofs for offline verification
- Recipient can validate voucher authenticity before online redemption
- Prevents double-spend attacks in delayed redemption scenarios

**Privacy Implications**:

**Public Key Disclosure**:
- P2PK reveals recipient's public key to mint at redemption
- Mint can correlate redemptions to identities
- Consider using derived keys for each voucher to preserve privacy

**Nonce Uniqueness**:
- Generate unique nonces for each P2PK secret
- Reused nonces across proofs may leak information
- Use cryptographically secure random number generator

**SIG_ALL Linkability**:
- SIG_ALL aggregates all inputs/outputs in single signature
- Mint can trivially link all proofs in transaction
- Use only when necessary (e.g., atomic swaps)

**Multisig Coordination**:

**Secure Communication**:
- Exchange partial signatures over encrypted channels (NIP-44)
- Verify each signer's identity before accepting signatures
- Implement timeout mechanism for unresponsive signers

**Signature Aggregation**:
- Validate each partial signature before combining
- Ensure no duplicate public keys in multisig set
- Use deterministic signature ordering to prevent malleability

**Client-Side Validation Checklist**:
- ✅ Verify mint advertises P2PK support before creating locked proofs
- ✅ Validate public key format (33-byte compressed secp256k1)
- ✅ Generate cryptographically secure nonces (32 bytes)
- ✅ Check locktime constraints before attempting redemption
- ✅ Validate signature count matches n_sigs requirement
- ✅ Verify message aggregation for SIG_ALL matches spec
- ✅ Clear sensitive data from memory after operations
- ✅ Log P2PK operations with correlation IDs for audit

---

## NUT-17: WebSocket Subscriptions

### 1. Core Concepts Relevant to Web Client

**Real-Time Notifications** enable wallets to monitor state changes without polling. The protocol uses bidirectional JSON-RPC 2.0 over WebSockets for push-based updates.

**Subscription Types**:
- **Quote Updates**: MintQuote and MeltQuote status changes (NUT-04/05)
- **Proof States**: CheckState responses for tracking spending status (NUT-07)

**Push Mechanism**:
> "The mint sends a WsNotification of the current state of the subscribed objects and whenever there is an update."

**Initial State Delivery**:
- Upon successful subscription, mint immediately pushes current state
- Subsequent updates pushed as state changes occur
- Reduces race conditions between subscription and state changes

### 2. Message Formats and Subscription Protocol

**Request Message** (Subscribe):
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "subscribe",
  "params": {
    "kind": "proof_state",
    "filters": [
      "02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2",
      "02b3e9b5d6c5e1f6d8a9c5e1f6d8a9c5e1f6d8a9c5e1f6d8a9c5e1f6d8a9c5e1f6"
    ],
    "subId": "3e4a8c91-7b5d-4f2e-9c8a-1d3e5f7a9b2c"
  }
}
```

**Request Message** (Unsubscribe):
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "unsubscribe",
  "params": {
    "subId": "3e4a8c91-7b5d-4f2e-9c8a-1d3e5f7a9b2c"
  }
}
```

**Response Message**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "status": "OK",
    "subId": "3e4a8c91-7b5d-4f2e-9c8a-1d3e5f7a9b2c"
  }
}
```

**Notification Message**:
```json
{
  "jsonrpc": "2.0",
  "method": "notification",
  "params": {
    "subId": "3e4a8c91-7b5d-4f2e-9c8a-1d3e5f7a9b2c",
    "payload": {
      "Y": "02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2",
      "state": "SPENT",
      "witness": null
    }
  }
}
```

**Subscription Kinds**:
- `"bolt11_mint_quote"`: Monitor mint quote status (NUT-04)
- `"bolt11_melt_quote"`: Monitor melt quote status (NUT-05)
- `"proof_state"`: Monitor proof state changes (NUT-07)

**Filters Format**:
- For quotes: Array of quote IDs
- For proofs: Array of Y-value hex strings

### 3. User Experience Considerations

**Voucher Status Tracking**:

**Use Case**: User sends voucher, wants real-time notification when redeemed

**Implementation**:
```
1. User shares voucher
2. Client opens WebSocket to mint
3. Subscribe to proof_state for all Y-values in voucher
4. Display: "Waiting for recipient to redeem..."
5. Receive notification: state changed to SPENT
6. Display toast: "✅ Voucher redeemed by recipient!"
7. Unsubscribe and close connection
```

**Payment Monitoring**:

**Use Case**: User initiates Lightning payment, wants real-time updates

**Implementation**:
```
1. User pays Lightning invoice (melt operation)
2. Receive melt quote ID
3. Subscribe to bolt11_melt_quote
4. Display: "Processing Lightning payment..."
5. Receive notification: quote status "PAID"
6. Display: "✅ Payment successful!"
7. Unsubscribe and close connection
```

**Persistent Subscriptions**:

**Use Case**: Dashboard view monitoring multiple vouchers

**Implementation**:
```
1. User opens "Sent Vouchers" dashboard
2. Open WebSocket connection
3. Subscribe to proof_state for all sent vouchers
4. Display status indicators per voucher
5. Update UI in real-time as notifications arrive
6. Close connection when user navigates away
```

**Connection State UI**:
- 🟢 Connected: Show "Live updates active"
- 🟡 Connecting: Show "Connecting to mint..."
- 🔴 Disconnected: Show "Offline - using cached status" with [Retry] button
- ⚠️ Error: Show "Failed to connect - manual refresh required"

**Notification Preferences**:
- Allow users to enable/disable WebSocket subscriptions in settings
- Fallback to HTTP polling if WebSocket unavailable
- Display bandwidth savings: "Live updates reduce data usage by 90%"

### 4. Error Handling and Reconnection Logic

**Error Response Format**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32600,
    "message": "Invalid request parameters"
  }
}
```

**Standard JSON-RPC Error Codes**:
- `-32700`: Parse error (invalid JSON)
- `-32600`: Invalid request
- `-32601`: Method not found
- `-32602`: Invalid params
- `-32603`: Internal error

**Client Error Handling**:

**Connection Failures**:
```javascript
ws.onerror = (error) => {
  console.error('WebSocket error:', error);
  displayToast(
    "Failed to establish live updates connection. " +
    "Suggestion: Check your network connection or use manual refresh.",
    "error"
  );

  // Fallback to HTTP polling
  startPolling(subscriptions);
};
```

**Invalid Subscription**:
```javascript
// Error: -32602 Invalid params
{
  "error": {
    "code": -32602,
    "message": "Unknown subscription kind: invalid_kind"
  }
}

// Handle gracefully
displayError(
  "Live updates unavailable for this resource. " +
  "Suggestion: Use manual refresh to check status."
);
```

**Reconnection Strategy**:

**Exponential Backoff**:
```javascript
let reconnectDelay = 1000; // Start with 1 second
const maxDelay = 60000; // Max 60 seconds

function reconnectWithBackoff() {
  setTimeout(() => {
    console.log(`Attempting WebSocket reconnection in ${reconnectDelay}ms`);
    connectWebSocket();
    reconnectDelay = Math.min(reconnectDelay * 2, maxDelay);
  }, reconnectDelay);
}

ws.onclose = (event) => {
  if (event.wasClean) {
    console.log('WebSocket closed cleanly');
  } else {
    console.warn('WebSocket connection lost, reconnecting...');
    reconnectWithBackoff();
  }
};
```

**Connection Timeout**:
```javascript
const CONNECTION_TIMEOUT = 10000; // 10 seconds

function connectWebSocket(mintUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(mintUrl.replace('https://', 'wss://'));

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('WebSocket connection timeout'));
    }, CONNECTION_TIMEOUT);

    ws.onopen = () => {
      clearTimeout(timeout);
      resolve(ws);
    };

    ws.onerror = (error) => {
      clearTimeout(timeout);
      reject(error);
    };
  });
}
```

**Subscription Resumption**:
```javascript
// Store subscriptions in memory
const activeSubscriptions = new Map();

// On reconnect, resubscribe to all active subscriptions
ws.onopen = async () => {
  console.log('WebSocket reconnected, resuming subscriptions...');

  for (const [subId, subscription] of activeSubscriptions) {
    await sendSubscribeRequest(ws, subscription);
  }

  displayToast('Live updates reconnected', 'success');
};
```

**Graceful Degradation**:
```javascript
// If WebSocket unavailable, fall back to HTTP polling
async function monitorProofState(Ys) {
  if (supportsWebSocket(mintUrl)) {
    try {
      return await subscribeViaWebSocket(Ys);
    } catch (error) {
      console.warn('WebSocket unavailable, falling back to polling');
    }
  }

  // Fallback: HTTP polling every 5 seconds
  return startPolling(Ys, 5000);
}
```

### 5. Security Considerations for WebSocket Connections

**TLS/Encryption Requirements**:
- **ALWAYS use `wss://` (WebSocket Secure)** for production
- Reject unencrypted `ws://` connections
- Validate TLS certificate before connecting
- Display warning if mint only supports `ws://`

**Connection Validation**:
```javascript
function validateWebSocketUrl(mintUrl) {
  const wsUrl = mintUrl.replace(/^https?:\/\//, 'wss://');

  if (wsUrl.startsWith('ws://') && !isDevelopmentMode()) {
    throw new Error(
      'Insecure WebSocket connection detected. ' +
      'Suggestion: Use a mint that supports encrypted connections (wss://).'
    );
  }

  return wsUrl;
}
```

**Authentication** (if mint requires NIP-42):
- Some mints may require WebSocket authentication
- Implement NIP-42 challenge-response over WebSocket
- Store authenticated session token for reconnections
- See [Nostr Integration](#nostr-integration-nip-04-nip-42-nip-44) section

**Rate Limiting Protection**:
- Mint may rate-limit subscriptions per IP/user
- Implement client-side throttling for subscription requests
- Batch multiple filters into single subscription when possible
- Respect mint's subscription limits advertised in `/v1/info`

**Subscription Isolation**:
- Generate unique `subId` (UUID v4) for each subscription
- Never reuse `subId` across connections
- Track subscriptions per mint to avoid cross-contamination
- Unsubscribe explicitly before closing connection

**Message Validation**:
```javascript
function validateNotification(notification) {
  // Verify notification structure
  if (!notification.params?.subId || !notification.params?.payload) {
    throw new Error('Invalid notification structure');
  }

  // Verify subId matches active subscription
  if (!activeSubscriptions.has(notification.params.subId)) {
    console.warn('Received notification for unknown subscription:', notification.params.subId);
    return false;
  }

  // Validate payload schema based on subscription kind
  const subscription = activeSubscriptions.get(notification.params.subId);
  validatePayloadSchema(notification.params.payload, subscription.kind);

  return true;
}
```

**DoS Protection**:
- Set maximum number of concurrent subscriptions per mint
- Implement subscription timeout (auto-unsubscribe after N minutes of inactivity)
- Close connection if mint sends excessive notifications
- Monitor bandwidth usage and disconnect if exceeding threshold

**Privacy Considerations**:
- Subscriptions reveal user interest in specific proofs/quotes to mint
- Mint can correlate subscriptions with IP addresses
- Consider using VPN/Tor for privacy-sensitive operations
- Avoid subscribing to proofs you don't own

**Client-Side Best Practices**:
- Close WebSocket connections when not needed (e.g., user navigates away)
- Implement connection pooling to avoid opening multiple connections to same mint
- Log subscription lifecycle events with correlation IDs
- Clear subscription state on user logout
- Handle connection interruptions gracefully without exposing user data

---

## Nostr Integration: NIP-04, NIP-42, NIP-44

### NIP-04: Encrypted Direct Messages (Deprecated)

**Status**: ⚠️ **DEPRECATED** - Do NOT use for new implementations

**Reason for Deprecation**:
> "NIP-04 is considered harmful. It could leak your secret key."

**Security Issues**:
- Uses AES-256-CBC with no message authentication
- Vulnerable to message tampering in transit
- Unconventional ECDH implementation (uses X coordinate without hashing)
- Leaks metadata in events
- Replaced by NIP-17 for private messaging

**Recommendation for Web Client**:
- **Do NOT implement NIP-04** for voucher delivery
- Use NIP-44 (versioned encrypted payloads) instead
- If existing vouchers use NIP-04, display migration warning

### NIP-42: Authentication of Clients to Relays

### 1. Core Concepts

NIP-42 defines relay authentication using challenge-response with signed ephemeral events. Enables relays to enforce access control and associate connections with identities.

**Authentication Flow**:
```
1. Client connects to relay
2. Relay sends: ["AUTH", "<challenge-string>"]
3. Client signs ephemeral event (kind 22242) with challenge
4. Client sends: ["EVENT", {signed_event}]
5. Relay validates signature and challenge
6. Relay grants authenticated access
```

**Use Cases in Voucher System**:
- Publishing identity-bound vouchers to private relays
- Subscribing to voucher notifications requiring authentication
- Accessing restricted relay endpoints for premium users

### 2. Event Format for Authentication

**AUTH Event Structure** (kind 22242):
```json
{
  "id": "...",
  "pubkey": "0249098aa8b9d2fbec49ff8598feb17b592b986e62319a4fa488a3dc36387157a7",
  "created_at": 1736870400,
  "kind": 22242,
  "tags": [
    ["relay", "wss://relay.example.com"],
    ["challenge", "challengestringhere"]
  ],
  "content": "",
  "sig": "..."
}
```

**Required Fields**:
- **kind**: Must be 22242 (ephemeral, not broadcasted)
- **tags**: Must include `["relay", "<url>"]` and `["challenge", "<string>"]`
- **created_at**: Should be within ~10 minutes of current time
- **sig**: Schnorr signature per NIP-01

**Challenge Message Format**:
```json
["AUTH", "random_challenge_string_from_relay"]
```

### 3. Error Codes and Relay Responses

**Authentication Required**:
```json
["OK", "<event-id>", false, "auth-required: This relay requires authentication"]
```

**Restricted Access**:
```json
["OK", "<event-id>", false, "restricted: Your key is not authorized for this action"]
```

**Authentication Success**:
```json
["OK", "<event-id>", true, ""]
```

**CLOSED Message** (subscription denied):
```json
["CLOSED", "<subscription-id>", "auth-required: Authentication required to access this resource"]
```

### 4. Implementation Requirements for Web Client

**Client-Side Authentication Flow**:

```javascript
class NostrRelayAuth {
  constructor(relay, privateKey) {
    this.relay = relay;
    this.privateKey = privateKey;
    this.challenge = null;
  }

  async handleAuthChallenge(challengeMessage) {
    // Parse challenge: ["AUTH", "challenge_string"]
    this.challenge = challengeMessage[1];

    // Create auth event
    const event = {
      kind: 22242,
      pubkey: getPublicKey(this.privateKey),
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["relay", this.relay.url],
        ["challenge", this.challenge]
      ],
      content: ""
    };

    // Sign event
    event.id = await computeEventId(event);
    event.sig = await signEvent(event, this.privateKey);

    // Send auth response
    this.relay.send(["EVENT", event]);
  }

  async authenticate() {
    // Wait for AUTH message or timeout
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('AUTH timeout - relay did not send challenge'));
      }, 10000);

      this.relay.on('message', (msg) => {
        if (msg[0] === 'AUTH') {
          clearTimeout(timeout);
          this.handleAuthChallenge(msg)
            .then(resolve)
            .catch(reject);
        }
      });
    });
  }
}
```

**User Experience**:

**Transparent Authentication**:
```
User publishes voucher to authenticated relay
  → Client detects AUTH requirement
  → Automatically signs auth event in background
  → Display: "Connecting to secure relay..."
  → Success: "Voucher published to private relay"
```

**Authentication Prompt** (for new relays):
```
🔐 Relay Authentication Required

relay.example.com requires authentication to publish vouchers.

Authenticate with your identity key?

[Authenticate] [Cancel]
```

**Failed Authentication**:
```
❌ Authentication Failed

You are not authorized to access this relay.

Suggestion: Contact the relay operator or choose a different relay.
```

### 5. Security Considerations and Best Practices

**Timestamp Validation**:
- Relays MUST verify `created_at` within ±10 minutes of current time
- Prevents replay attacks using old auth events
- Clients should use accurate system time or NTP synchronization

**Challenge Uniqueness**:
- Relays should generate unique challenges per connection
- Challenges should expire after use or timeout
- Clients should never reuse auth events across connections

**Event Ephemerality**:
- Kind 22242 events are NOT meant to be broadcasted or stored
- Clients should not persist auth events to local storage
- Relay should not gossip auth events to other relays

**Key Management**:
- Use identity private key for signing auth events
- Never expose private key in logs or error messages
- Consider using separate "relay auth key" for enhanced privacy

**Multi-Key Authentication**:
- Relays may send multiple AUTH messages for multi-step authentication
- Client should handle sequential auth challenges
- Each challenge requires fresh signature

**URL Normalization**:
- Relay URL in tags must match actual connection URL
- Normalize URLs: `wss://relay.com/` → `wss://relay.com`
- Handle trailing slashes consistently

**Rate Limiting**:
- Relays may rate-limit auth attempts
- Implement exponential backoff for failed auth
- Display user-friendly error for rate limit exceeded

**Client-Side Validation Checklist**:
- ✅ Verify relay sent AUTH message before sending auth event
- ✅ Match challenge string exactly (case-sensitive)
- ✅ Include correct relay URL in tags
- ✅ Use current timestamp (±10 minutes)
- ✅ Generate valid event ID and signature per NIP-01
- ✅ Handle auth success/failure responses
- ✅ Implement timeout for AUTH challenge (10 seconds)
- ✅ Clear challenge from memory after use

### NIP-44: Encrypted Payloads (Versioned)

### 1. Core Concepts

NIP-44 version 2 provides secure keypair-based encryption for Nostr events using ChaCha20 + HMAC-SHA256. Designed for authenticated encryption with versioning support.

**Key Features**:
- **ChaCha20 Encryption**: Faster than AES, better multi-key attack resistance
- **HMAC-SHA256 Authentication**: Prevents message tampering
- **Custom Padding**: Power-of-two padding for small message privacy
- **Versioned Format**: Supports algorithm upgrades without breaking changes

**Use Cases in Voucher System**:
- Encrypting voucher delivery messages to recipient's pubkey
- Secure memo/note transmission with vouchers
- Privacy-preserving voucher metadata storage

### 2. Encryption Algorithm Details

**Key Derivation**:

**Step 1: Conversation Key** (ECDH + HKDF-extract):
```javascript
// ECDH: Scalar multiplication
const sharedSecret = secp256k1.getSharedSecret(privateKey, recipientPubkey);

// HKDF-extract with salt 'nip44-v2'
const conversationKey = hkdf_extract(
  sha256,
  'nip44-v2',
  sharedSecret
);
```

**Step 2: Per-Message Keys** (HKDF-expand):
```javascript
// Generate random 32-byte nonce
const nonce = crypto.getRandomValues(new Uint8Array(32));

// Derive ChaCha20 and HMAC keys
const chachaKey = hkdf_expand(conversationKey, nonce, 'chacha20_key', 32);
const hmacKey = hkdf_expand(conversationKey, nonce, 'hmac_key', 32);
```

**Padding Scheme**:
```javascript
function calcPaddedLength(unpadded_length) {
  const next_power = 1 << (Math.floor(Math.log2(unpadded_length - 1)) + 1);

  if (next_power <= 256) {
    return 32 * Math.floor((unpadded_length - 1) / 32) + 32;
  } else {
    return next_power;
  }
}

// Examples:
// 5 bytes → 32 bytes (minimum)
// 42 bytes → 64 bytes
// 300 bytes → 512 bytes
```

**Encryption Process**:
```
1. Pad plaintext to power-of-two length (min 32 bytes)
2. Prepend 2-byte big-endian length prefix
3. Encrypt with ChaCha20 using chachaKey and nonce
4. Compute HMAC-SHA256 over nonce || ciphertext
5. Concatenate: version_byte || nonce || ciphertext || mac
6. Base64-encode final payload
```

### 3. Message Format and Structure

**Encrypted Payload Format**:
```
[1 byte version][32 bytes nonce][variable ciphertext][32 bytes MAC]
```

**Version Byte**:
- `0x02`: NIP-44 version 2 (current)
- Future versions may use different algorithms

**Full Message Structure**:
```
version (1 byte)
nonce (32 bytes)
ciphertext (padded_plaintext_length bytes)
mac (32 bytes)
```

**Encoded Format** (in Nostr event):
```json
{
  "content": "AgK2hZ8P9c4T... (base64)",
  ...
}
```

**Example Implementation**:
```javascript
async function encryptNIP44(plaintext, senderPrivkey, recipientPubkey) {
  // 1. Derive conversation key
  const conversationKey = await deriveConversationKey(senderPrivkey, recipientPubkey);

  // 2. Generate random nonce
  const nonce = crypto.getRandomValues(new Uint8Array(32));

  // 3. Pad plaintext
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const paddedLength = calcPaddedLength(plaintextBytes.length);
  const padded = new Uint8Array(paddedLength + 2);

  // 4. Add length prefix (big-endian)
  padded[0] = (plaintextBytes.length >> 8) & 0xFF;
  padded[1] = plaintextBytes.length & 0xFF;
  padded.set(plaintextBytes, 2);

  // 5. Derive per-message keys
  const { chachaKey, hmacKey } = await deriveMessageKeys(conversationKey, nonce);

  // 6. Encrypt
  const ciphertext = await chacha20Encrypt(padded, chachaKey, nonce);

  // 7. Compute MAC
  const macData = new Uint8Array(nonce.length + ciphertext.length);
  macData.set(nonce);
  macData.set(ciphertext, nonce.length);
  const mac = await hmacSHA256(hmacKey, macData);

  // 8. Assemble final payload
  const payload = new Uint8Array(1 + nonce.length + ciphertext.length + mac.length);
  payload[0] = 0x02; // Version 2
  payload.set(nonce, 1);
  payload.set(ciphertext, 1 + nonce.length);
  payload.set(mac, 1 + nonce.length + ciphertext.length);

  // 9. Base64-encode
  return btoa(String.fromCharCode(...payload));
}
```

### 4. Implementation Requirements for Web Clients

**Web Crypto API Usage**:

```javascript
// ECDH shared secret derivation
async function deriveSharedSecret(privateKeyBytes, publicKeyHex) {
  const privateKey = await crypto.subtle.importKey(
    'raw',
    privateKeyBytes,
    { name: 'ECDH', namedCurve: 'secp256k1' },
    false,
    ['deriveBits']
  );

  const publicKey = await crypto.subtle.importKey(
    'raw',
    hexToBytes(publicKeyHex),
    { name: 'ECDH', namedCurve: 'secp256k1' },
    false,
    []
  );

  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    256
  );

  return new Uint8Array(sharedSecret);
}

// HKDF key derivation
async function hkdfExtract(salt, ikm) {
  const key = await crypto.subtle.importKey(
    'raw',
    ikm,
    { name: 'HKDF' },
    false,
    ['deriveBits']
  );

  return crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(salt),
      info: new Uint8Array()
    },
    key,
    256
  );
}

// HMAC-SHA256
async function hmacSHA256(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    data
  );

  return new Uint8Array(signature);
}
```

**Decryption with Validation**:

```javascript
async function decryptNIP44(encryptedContent, recipientPrivkey, senderPubkey) {
  // 1. Base64-decode
  const payload = base64ToBytes(encryptedContent);

  // 2. Parse payload
  const version = payload[0];
  if (version !== 0x02) {
    throw new Error(`Unsupported NIP-44 version: ${version}`);
  }

  const nonce = payload.slice(1, 33);
  const ciphertext = payload.slice(33, -32);
  const mac = payload.slice(-32);

  // 3. Derive conversation key
  const conversationKey = await deriveConversationKey(recipientPrivkey, senderPubkey);

  // 4. Derive per-message keys
  const { chachaKey, hmacKey } = await deriveMessageKeys(conversationKey, nonce);

  // 5. Verify MAC (constant-time comparison!)
  const macData = new Uint8Array(nonce.length + ciphertext.length);
  macData.set(nonce);
  macData.set(ciphertext, nonce.length);
  const expectedMac = await hmacSHA256(hmacKey, macData);

  if (!constantTimeEqual(mac, expectedMac)) {
    throw new Error('NIP-44 MAC verification failed - message may be tampered');
  }

  // 6. Decrypt
  const padded = await chacha20Decrypt(ciphertext, chachaKey, nonce);

  // 7. Extract plaintext length from prefix
  const plaintextLength = (padded[0] << 8) | padded[1];

  // 8. Validate length
  if (plaintextLength > padded.length - 2) {
    throw new Error('Invalid NIP-44 plaintext length');
  }

  // 9. Extract plaintext
  const plaintext = padded.slice(2, 2 + plaintextLength);

  return new TextDecoder().decode(plaintext);
}

// Constant-time comparison to prevent timing attacks
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }

  return result === 0;
}
```

**UI Integration**:

**Encrypted Voucher Delivery**:
```
User sends voucher to recipient
  → Input recipient's Nostr pubkey or NIP-05 identifier
  → Enable toggle: "Encrypt voucher message"
  → Client encrypts voucher payload with NIP-44
  → Publish encrypted event to relay
  → Display: "Voucher sent securely to [recipient]"
```

**Decrypting Received Vouchers**:
```
User receives encrypted voucher notification
  → Client detects NIP-44 encrypted content
  → Automatically decrypt using user's private key
  → Verify MAC before displaying content
  → Parse voucher token and display details
  → Offer redemption action
```

### 5. Security Considerations and Known Limitations

**Known Limitations** (per specification):

> "On its own, messages sent using this scheme have important shortcomings:
> - No deniability
> - No forward secrecy
> - No post-compromise security"

**Additional Privacy Leaks**:
- Message timestamps remain public in Nostr events
- IP addresses visible to relays during publication
- True message lengths partially leak despite padding

**Mitigation Strategies**:

**Forward Secrecy**:
- Generate ephemeral key pairs for each voucher delivery session
- Rotate conversation keys periodically
- Never reuse nonces across messages

**Metadata Minimization**:
- Use anonymous relays or Tor for publishing encrypted vouchers
- Randomize timestamps within acceptable range
- Pad all vouchers to uniform size when possible

**Post-Compromise Security**:
- Implement key rotation mechanism
- Allow users to revoke compromised keys
- Display warning: "Encrypting voucher protects content, not metadata"

**MAC Verification** (Critical):
```javascript
// ❌ WRONG: Timing attack vulnerable
if (mac.toString() !== expectedMac.toString()) {
  throw new Error('MAC verification failed');
}

// ✅ CORRECT: Constant-time comparison
if (!constantTimeEqual(mac, expectedMac)) {
  throw new Error('MAC verification failed');
}
```

**Signature Validation Before Decryption**:
```javascript
// Per spec: "Validate event's pubkey and signature before decryption"
async function decryptVoucherEvent(event, recipientPrivkey) {
  // 1. Verify event signature (NIP-01)
  if (!await verifyNostrEventSignature(event)) {
    throw new Error(
      'Invalid event signature. ' +
      'Suggestion: This voucher may be forged - do not decrypt or redeem.'
    );
  }

  // 2. Decrypt content
  const decrypted = await decryptNIP44(
    event.content,
    recipientPrivkey,
    event.pubkey
  );

  return decrypted;
}
```

**Client-Side Best Practices**:
- ✅ Verify Cure53 audit recommendations (December 2023)
- ✅ Use constant-time MAC comparison to prevent timing attacks
- ✅ Validate event signatures before decryption (prevent forgery)
- ✅ Generate cryptographically secure nonces (32 bytes)
- ✅ Clear sensitive keys from memory after operations
- ✅ Implement proper padding to minimize length leakage
- ✅ Display warnings about metadata leakage to users
- ✅ Consider using specialized E2EE messaging for high-risk scenarios
- ✅ Log encryption/decryption operations with correlation IDs
- ✅ Test against official test vectors from NIP-44 repository

**Recommended Warning Message**:
```
🔒 Encrypted Delivery

Voucher content is encrypted, but metadata (timestamp, sender identity,
relay used) remains public. For maximum privacy, share vouchers
out-of-band via secure messaging apps.

[I Understand] [Learn More]
```

---

## Implementation Roadmap

### Phase 1: Core Protocol Integration (M1-M2)

**Milestone 1: Foundation**
- ✅ Implement NUT-00 proof verification and token serialization (V4 CBOR)
- ✅ Integrate Web Crypto API for secret generation and blinding
- ✅ Build mint connection module with keyset discovery
- ✅ Create basic wallet balance view with proof storage

**Milestone 2: Voucher Issuance and Sharing**
- ✅ Implement voucher issuance flow (mint quote, blind signatures)
- ✅ Build QR code and URL generation for token sharing
- ✅ Add NUT-07 state checking for basic voucher validation
- ✅ Create audit log for all voucher operations

### Phase 2: Identity-Bound Vouchers (M3)

**NUT-10 and NUT-11 Integration**:
- ✅ Implement P2PK secret generation and witness signing
- ✅ Add UI toggle: "Lock voucher to recipient identity"
- ✅ Build recipient public key input with NIP-05 lookup
- ✅ Implement mint capability checking (NUT-06 /v1/info)
- ✅ Create signature generation flow for unlocking received P2PK vouchers
- ✅ Add multisig and locktime UI controls (advanced mode)

**Error Handling**:
- ✅ Implement structured error codes per AGENTS.md guidelines
- ✅ Build user-friendly error messages with actionable suggestions
- ✅ Add retry logic for transient failures
- ✅ Create error logging with correlation IDs

### Phase 3: Real-Time Updates (M4)

**NUT-17 WebSocket Integration**:
- ✅ Implement WebSocket connection management with reconnection logic
- ✅ Build subscription system for proof state and quote status
- ✅ Add UI indicators for connection state (connected, connecting, offline)
- ✅ Implement exponential backoff for reconnection attempts
- ✅ Create fallback HTTP polling for WebSocket failures
- ✅ Add user preference toggle: "Enable live updates"

**Notification System**:
- ✅ Build in-app toast notifications for state changes
- ✅ Create "Sent Vouchers" dashboard with real-time status
- ✅ Add browser notifications (with user consent)
- ✅ Implement notification preference management

### Phase 4: Nostr Relay Integration (M4-M5)

**NIP-42 Authentication**:
- ✅ Implement relay authentication challenge-response flow
- ✅ Build automatic auth event signing and submission
- ✅ Add user prompts for new relay authentication
- ✅ Create authenticated relay allowlist management

**NIP-44 Encrypted Delivery**:
- ✅ Implement NIP-44 encryption/decryption with Web Crypto API
- ✅ Build encrypted voucher delivery flow
- ✅ Add recipient pubkey/NIP-05 resolution
- ✅ Implement constant-time MAC verification
- ✅ Create UI warnings about metadata leakage
- ✅ Add encrypted voucher parsing for received messages

**Relay Management**:
- ✅ Build relay configuration UI with add/remove/test
- ✅ Implement relay health monitoring (latency, success rate)
- ✅ Add relay selection for voucher publication
- ✅ Create relay allowlist with domain verification

### Phase 5: Hardening and Production Readiness (M5)

**Security Enhancements**:
- ✅ Implement client-side encryption for local storage (IndexedDB)
- ✅ Add passphrase-based key derivation (PBKDF2)
- ✅ Build mint/relay domain allowlist enforcement
- ✅ Implement HTTPS-only policy for production
- ✅ Add Content Security Policy headers
- ✅ Create security audit checklist

**Accessibility and Localization**:
- ✅ Achieve WCAG 2.1 AA compliance
- ✅ Add keyboard navigation for all interactive elements
- ✅ Implement screen-reader labels and ARIA attributes
- ✅ Build multi-language support (i18n framework)
- ✅ Create language preference selector

**Observability**:
- ✅ Implement structured logging with correlation IDs
- ✅ Build client-side metrics collection (opt-in)
- ✅ Create exportable audit log (JSON format)
- ✅ Add performance monitoring (voucher issuance/redemption latency)
- ✅ Build mint/relay health dashboard

**Testing and Documentation**:
- ✅ Write unit tests for all protocol implementations
- ✅ Create integration tests for voucher flows
- ✅ Build E2E tests for critical user journeys
- ✅ Write API documentation for frontend modules
- ✅ Create user guides following Diátaxis framework
- ✅ Add inline help and tooltips for complex features

### Recommended Implementation Priority

**High Priority (Essential for MVP)**:
1. NUT-00: Core protocol and token serialization
2. NUT-07: Token state checking
3. NUT-11: P2PK for identity-bound vouchers
4. NIP-42: Relay authentication
5. Basic error handling and logging

**Medium Priority (Enhanced UX)**:
6. NUT-17: WebSocket subscriptions for real-time updates
7. NIP-44: Encrypted voucher delivery
8. Advanced P2PK features (multisig, locktime)
9. Comprehensive error messages with suggestions
10. Audit log and observability

**Lower Priority (Polish and Optimization)**:
11. Performance optimizations (connection pooling, caching)
12. Advanced accessibility features
13. Internationalization (i18n)
14. Telemetry and analytics
15. Advanced relay management features

### Testing Strategy Per NUT/NIP

**NUT-00 Tests**:
- Proof verification against test vectors
- CBOR serialization/deserialization roundtrip
- Blinding/unblinding correctness
- Hash-to-curve determinism

**NUT-07 Tests**:
- State check request/response parsing
- Polling loop with backoff verification
- Error handling for network failures
- Privacy leak prevention (minimize check frequency)

**NUT-11 Tests**:
- P2PK secret generation with valid nonces
- Schnorr signature generation and verification
- SIG_ALL message aggregation correctness
- Multisig threshold enforcement
- Locktime validation

**NUT-17 Tests**:
- WebSocket connection establishment and teardown
- Subscription lifecycle (subscribe, notify, unsubscribe)
- Reconnection logic with exponential backoff
- Graceful degradation to HTTP polling
- Error handling for invalid subscriptions

**NIP-42 Tests**:
- Auth event generation with correct structure
- Challenge-response flow with timing constraints
- Signature validation per NIP-01
- Error handling for auth failures
- Multi-key authentication scenarios

**NIP-44 Tests**:
- Encryption/decryption roundtrip
- MAC verification (constant-time comparison)
- Padding scheme correctness
- Test against official NIP-44 test vectors
- Key derivation chain validation

### Success Criteria

**Functional Completeness**:
- ✅ Users can create, send, and redeem identity-bound vouchers
- ✅ Real-time status updates via WebSocket subscriptions
- ✅ Encrypted voucher delivery to Nostr relays
- ✅ Authenticated relay access with NIP-42
- ✅ Comprehensive error handling with actionable suggestions

**Security and Privacy**:
- ✅ All cryptographic operations use Web Crypto API
- ✅ Private keys never exposed in logs or network requests
- ✅ Client-side encryption for local storage
- ✅ HTTPS-only policy enforced
- ✅ Privacy warnings displayed for metadata leakage

**Performance**:
- ✅ Initial load < 3s on broadband
- ✅ Voucher issuance/redemption < 2s p50
- ✅ WebSocket subscriptions establish < 1s
- ✅ No memory leaks during extended sessions

**Usability**:
- ✅ WCAG 2.1 AA compliance
- ✅ Keyboard navigation for all features
- ✅ Clear error messages with recovery suggestions
- ✅ Inline help and tooltips for complex operations
- ✅ Responsive design for mobile and desktop

**Observability**:
- ✅ Structured logs with correlation IDs
- ✅ Exportable audit trail (JSON format)
- ✅ Client-side metrics (opt-in)
- ✅ Mint/relay health indicators
- ✅ Performance monitoring dashboards

---

## Conclusion

This analysis provides a comprehensive mapping of Cashu NUT specifications and Nostr NIPs relevant to building a web client for voucher management. Key takeaways:

**Protocol Foundation**:
- **NUT-00** defines core data structures (proofs, tokens, blind signatures)
- **NUT-07** enables voucher status tracking (UNSPENT, PENDING, SPENT)
- **NUT-10/11** add identity-bound vouchers via P2PK spending conditions
- **NUT-17** provides real-time updates via WebSocket subscriptions

**Nostr Integration**:
- **NIP-42** enables authenticated relay access for private voucher delivery
- **NIP-44** provides secure end-to-end encryption for voucher metadata
- **NIP-04** is deprecated and should NOT be used

**Implementation Priorities**:
1. Start with core protocol (NUT-00) and basic voucher flows
2. Add identity binding (NUT-11) for enhanced security
3. Integrate real-time updates (NUT-17) for better UX
4. Implement Nostr integration (NIP-42, NIP-44) for privacy

**Security Considerations**:
- Use Web Crypto API for all cryptographic operations
- Implement constant-time MAC verification to prevent timing attacks
- Encrypt local storage with user-provided passphrase
- Validate mint capabilities before creating locked vouchers
- Display privacy warnings for metadata leakage

**User Experience**:
- Hide cryptographic complexity behind intuitive UI
- Provide clear error messages with actionable suggestions
- Implement graceful degradation for missing features
- Add real-time status indicators and notifications
- Support offline operation where feasible

This document should serve as the technical foundation for web client implementation, ensuring compliance with Cashu specifications and Nostr standards while maintaining security and usability best practices.