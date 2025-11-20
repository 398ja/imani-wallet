# Imani Wallet - Web Client UI/UX Design

> **Document Type**: Reference (Diátaxis)
> **Purpose**: Complete UI/UX specification for Imani Wallet web application
> **Platform**: Web (Kotlin/JS + Compose Multiplatform)
> **Design System**: Material 3 (Imani Brand Theme)
> **Last Updated**: 2025-11-20

---

## Table of Contents

1. [Overview](#overview)
2. [Design Principles](#design-principles)
3. [Navigation Structure](#navigation-structure)
4. [Screen Specifications](#screen-specifications)
5. [User Flows](#user-flows)
6. [Component Library](#component-library)
7. [Responsive Design](#responsive-design)
8. [Accessibility](#accessibility)

---

## Overview

### Application Purpose

**Imani Wallet** is a web-based self-custody digital voucher wallet that allows users to:
- Create and manage Nostr identities
- Issue cryptographically-signed vouchers
- Share vouchers via QR codes or links
- Redeem received vouchers
- Track voucher lifecycle (issued → delivered → redeemed)

### Target Users

- **Primary**: Individuals sending digital gifts (birthdays, holidays, thanks)
- **Secondary**: Small merchants issuing store credit
- **Technical Level**: Non-technical users (simple interface) to power users (advanced features)

### Key User Needs

1. **Simple**: Create voucher in <3 clicks
2. **Secure**: Self-custody (keys never leave browser)
3. **Private**: No account required, no tracking
4. **Trustworthy**: Visual verification of cryptographic signatures
5. **Accessible**: Works on desktop and mobile web browsers

---

## Design Principles

### Brand Identity (Imani)

**Color Palette**:
- **Primary**: Deep Purple (#6B46C1) - Trust, wisdom
- **Accent**: Gold (#F59E0B) - Value, warmth
- **Secondary**: Deep Blue (#1E40AF) - Security
- **Background**: Cream (#FFFBEB) - Clarity
- **Surface**: White (#FFFFFF)
- **Error**: Red (#DC2626)
- **Success**: Green (#10B981)

**Typography**:
- **Headers**: Inter Bold, 24-40px
- **Body**: Inter Regular, 14-16px
- **Captions**: Inter Regular, 12px
- **Monospace**: JetBrains Mono (for keys, tokens)

**Spacing**:
- **Base Unit**: 8px
- **Small**: 8px, **Medium**: 16px, **Large**: 24px, **XLarge**: 32px

**Elevation** (Material 3):
- **Cards**: 2dp (subtle shadow)
- **FAB**: 6dp (prominent)
- **Modals**: 8dp (overlay)

### UI Principles

1. **Progressive Disclosure**: Show advanced features only when needed
2. **Feedback First**: Every action shows immediate feedback (loading, success, error)
3. **Offline-Capable**: All operations work offline, sync when online
4. **Forgiving**: Easy undo, clear error messages, auto-save
5. **Consistent**: Same patterns across all screens

---

## Navigation Structure

### Primary Navigation (Top App Bar)

```
┌────────────────────────────────────────────────────────────┐
│  🔷 Imani Wallet          [Identities] [Vouchers] [⚙️]     │
└────────────────────────────────────────────────────────────┘
```

**Layout**:
- **Left**: Logo + App Title
- **Center**: Tab Navigation (Identities, Vouchers)
- **Right**: Settings Icon

**Behavior**:
- Sticky header (always visible)
- Active tab highlighted with purple underline
- Smooth transitions between tabs

### Tab Structure

| Tab | Icon | Route | Primary Action |
|-----|------|-------|----------------|
| **Identities** | 👤 | `/identities` | Create Identity (FAB) |
| **Vouchers** | 🎁 | `/vouchers` | Issue Voucher (FAB) |
| **Settings** | ⚙️ | `/settings` | N/A (config screen) |

### Navigation Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Imani Wallet (/)                          │
│                         ↓                                    │
│              Auto-redirect to /identities                    │
└─────────────────────────────────────────────────────────────┘

┌──────────────┬──────────────┬──────────────────────────────┐
│  Identities  │   Vouchers   │          Settings            │
│  /identities │   /vouchers  │          /settings           │
└──────┬───────┴──────┬───────┴──────────────────────────────┘
       │              │
       ↓              ↓
┌──────────────┐  ┌──────────────────────────────────────────┐
│ Create       │  │ Issue Voucher                            │
│ /identities/ │  │ /vouchers/issue                          │
│ create       │  │   ↓                                      │
│   ↓          │  │ Share Voucher                            │
│ View Mnemonic│  │ /vouchers/share/:id                      │
│   ↓          │  │                                          │
│ Back to List │  │ Redeem Voucher                           │
└──────────────┘  │ /vouchers/redeem                         │
                  │   ↓                                      │
┌──────────────┐  │ Voucher Details                          │
│ Import       │  │ /vouchers/:id                            │
│ /identities/ │  └──────────────────────────────────────────┘
│ import       │
└──────────────┘
```

---

## Screen Specifications

### 1. Identity List Screen (`/identities`)

**Purpose**: View and manage Nostr identities used for voucher signing.

**Layout**:
```
┌────────────────────────────────────────────────────────────┐
│  🔷 Imani Wallet    [Identities] Vouchers ⚙️               │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Identities                                                │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 👤 My Main Identity                         ✅ Active│  │
│  │ npub1abc...xyz (32 chars truncated)                 │  │
│  │ Created 2 days ago · Last used 5 min ago            │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 👤 Store Account                           ⚪ Inactive│ │
│  │ npub1def...uvw                                       │  │
│  │ Created 30 days ago · Last used 25 days ago         │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  [Empty State if no identities]                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │         🔑                                           │  │
│  │   No identities yet                                  │  │
│  │   Create your first identity to start issuing       │  │
│  │   vouchers                                           │  │
│  │                                                       │  │
│  │   [Create Identity Button]                           │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│                                                       [+]   │ FAB
└────────────────────────────────────────────────────────────┘
```

**Components**:
- **Identity Card** (per identity):
  - Icon: 👤
  - Label: User-defined name
  - Status Badge: Active (green) / Inactive (gray)
  - Npub: First 12 + last 8 chars (e.g., `npub1abc...xyz`)
  - Metadata: Created date, Last used date
  - Click: Navigate to identity details
- **FAB**: "+" button → Navigate to `/identities/create`
- **Empty State**: Shows when no identities exist

**Actions**:
- **Click Card**: View identity details (npub, private key export)
- **Click FAB**: Create new identity
- **Top-right Menu** (on card hover):
  - Edit Label
  - Export Mnemonic
  - Delete Identity

**Data Display**:
- **Active Status**: Last used within 90 days
- **Sort Order**: Active identities first, then by last used date

---

### 2. Create Identity Screen (`/identities/create`)

**Purpose**: Generate new Nostr identity with mnemonic backup.

**Layout** (Step 1 - Enter Label):
```
┌────────────────────────────────────────────────────────────┐
│  ← Back                Create Identity                     │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Step 1 of 2: Choose a Name                                │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Identity Label                                       │  │
│  │ ┌──────────────────────────────────────────────────┐ │  │
│  │ │ My Main Identity                                 │ │  │
│  │ └──────────────────────────────────────────────────┘ │  │
│  │ 1-100 characters                                     │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  💡 This is just a nickname. You can change it later.      │
│                                                             │
│  [Cancel]                           [Create Identity →]    │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

**Layout** (Step 2 - Mnemonic Backup):
```
┌────────────────────────────────────────────────────────────┐
│  ← Back                Create Identity                     │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Step 2 of 2: Back Up Your Recovery Phrase                │
│                                                             │
│  ⚠️  Critical: Save This Recovery Phrase                   │
│  This is the ONLY way to recover your identity.           │
│  Write it down and store it safely.                        │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  1. abandon    5. ecology     9. merge             │  │
│  │  2. ability    6. edge        10. merit            │  │
│  │  3. able       7. edit        11. merry            │  │
│  │  4. about      8. educate     12. mesh             │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  [📋 Copy to Clipboard]                                    │
│                                                             │
│  ☐ I have securely backed up my recovery phrase           │
│                                                             │
│  [← Back]                                    [Done]        │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

**Flow**:
1. **Enter Label** → Click "Create Identity"
2. **Show Loading** (Generating keys... ~500ms)
3. **Display Mnemonic** → User copies/saves
4. **Check Confirmation Box** → "Done" button enables
5. **Click Done** → Navigate to `/identities` with success toast

**Validation**:
- Label: 1-100 characters, trimmed
- Confirmation: Checkbox must be checked to enable "Done"

**Security**:
- Mnemonic displayed only once (not stored in state after navigation)
- Warning text in red/orange
- Copy button for convenience

---

### 3. Import Identity Screen (`/identities/import`)

**Purpose**: Restore identity from 12-word mnemonic.

**Layout**:
```
┌────────────────────────────────────────────────────────────┐
│  ← Back                Import Identity                     │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Restore from Recovery Phrase                              │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Recovery Phrase (12 words)                           │  │
│  │ ┌──────────────────────────────────────────────────┐ │  │
│  │ │ abandon ability able about...                    │ │  │
│  │ │                                                  │ │  │
│  │ └──────────────────────────────────────────────────┘ │  │
│  │ Separate words with spaces                           │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Identity Label                                       │  │
│  │ ┌──────────────────────────────────────────────────┐ │  │
│  │ │ Restored Identity                                │ │  │
│  │ └──────────────────────────────────────────────────┘ │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  [Cancel]                                  [Import]        │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

**Validation**:
- Mnemonic: Exactly 12 words from BIP39 wordlist
- Label: 1-100 characters
- Show error if invalid mnemonic

**Flow**:
1. **Paste/Enter Mnemonic** → Validates on blur
2. **Enter Label** → Pre-filled with "Restored Identity"
3. **Click Import** → Derives keys, saves identity
4. **Success** → Navigate to `/identities` with toast

---

### 4. Voucher List Screen (`/vouchers`)

**Purpose**: View all vouchers (issued, received, redeemed).

**Layout**:
```
┌────────────────────────────────────────────────────────────┐
│  🔷 Imani Wallet    Identities [Vouchers] ⚙️               │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Vouchers                                     [🔽 Filter]   │
│                                                             │
│  ── Issued ─────────────────────────────────────────────   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 🎁 Birthday Gift                          1000 sat   │  │
│  │ Issued 2 hours ago                       📤 Shared   │  │
│  │ Expires in 88 days                                   │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ── Received ───────────────────────────────────────────   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 🎁 Thank You!                              500 sat   │  │
│  │ Received 1 day ago                    ✅ Redeemed    │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  [Empty State if no vouchers]                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │         🎁                                           │  │
│  │   No vouchers yet                                    │  │
│  │   Issue your first voucher to get started           │  │
│  │                                                       │  │
│  │   [Issue Voucher]  [Redeem Voucher]                 │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│                                            [+] [Redeem]    │ FAB
└────────────────────────────────────────────────────────────┘
```

**Components**:
- **Voucher Card**:
  - Icon: 🎁
  - Memo: User-defined or "Voucher {id}"
  - Amount: Face value + unit (sat)
  - Status Badge: Issued (blue), Delivered (cyan), Redeemed (green), Expired (gray)
  - Metadata: Issued/received date, expiry
  - Click: Navigate to voucher details
- **Filter Dropdown**: All / Issued / Received / Redeemed
- **Dual FAB**:
  - Primary: "+" → Issue voucher
  - Secondary: "Redeem" → Redeem voucher

**Grouping**:
- **Issued**: Vouchers created by user
- **Received**: Vouchers redeemed by user
- **Sort**: Newest first within each group

---

### 5. Issue Voucher Screen (`/vouchers/issue`)

**Purpose**: Create new voucher locked to recipient's public key.

**Layout** (Step 1 - Voucher Details):
```
┌────────────────────────────────────────────────────────────┐
│  ← Back                 Issue Voucher                      │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Step 1 of 2: Voucher Details                              │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Amount (sats)                                        │  │
│  │ ┌──────────────────────────────────────────────────┐ │  │
│  │ │ 1000                                             │ │  │
│  │ └──────────────────────────────────────────────────┘ │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Memo (optional)                                      │  │
│  │ ┌──────────────────────────────────────────────────┐ │  │
│  │ │ Happy Birthday!                                  │ │  │
│  │ └──────────────────────────────────────────────────┘ │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Expires In (days)                                    │  │
│  │ ┌──────────────────────────────────────────────────┐ │  │
│  │ │ 90                                               │ │  │
│  │ └──────────────────────────────────────────────────┘ │  │
│  │ Leave blank for no expiry                            │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  🔒 Advanced Options (collapsed)                           │
│                                                             │
│  [Cancel]                              [Continue →]        │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

**Layout** (Step 2 - Share):
```
┌────────────────────────────────────────────────────────────┐
│  ← Back                 Share Voucher                      │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  ✅ Voucher Issued Successfully                            │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                                                       │  │
│  │         [QR CODE - 200x200px]                        │  │
│  │                                                       │  │
│  │                                                       │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  Scan QR code to redeem                                    │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ cashuAbc123...xyz456                                 │  │
│  │ (Token truncated, click to expand)                   │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  [📋 Copy Token]  [🔗 Copy Link]  [📧 Email]  [💬 SMS]     │
│                                                             │
│  [← Back to Vouchers]                        [Done]        │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

**Flow**:
1. **Enter Details** → Validate (amount > 0)
2. **Click Continue** → Issue voucher (calls VoucherAdapter)
3. **Show Loading** → "Issuing voucher..."
4. **Display QR + Token** → Share options
5. **Click Done** → Navigate to `/vouchers`

**Validation**:
- Amount: Positive integer
- Memo: Optional, max 200 chars
- Expiry: Positive integer or blank

**Advanced Options** (collapsed by default):
- Lock to recipient pubkey (P2PK)
- Select mint URL

---

### 6. Redeem Voucher Screen (`/vouchers/redeem`)

**Purpose**: Claim received voucher by scanning QR or pasting token.

**Layout**:
```
┌────────────────────────────────────────────────────────────┐
│  ← Back                Redeem Voucher                      │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Scan QR Code or Paste Token                               │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                                                       │  │
│  │         [QR Scanner - 300x300px]                     │  │
│  │         (Camera access required)                     │  │
│  │                                                       │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ─── or ────────────────────────────────────────────────   │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Voucher Token                                        │  │
│  │ ┌──────────────────────────────────────────────────┐ │  │
│  │ │ cashuAbc123...                                   │ │  │
│  │ │                                                  │ │  │
│  │ └──────────────────────────────────────────────────┘ │  │
│  │ Paste Cashu token (cashuA...)                        │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  [Cancel]                                 [Redeem]         │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

**Flow**:
1. **Scan QR** or **Paste Token**
2. **Click Redeem** → Validate token format
3. **Show Loading** → "Verifying voucher..."
4. **Verify Proofs** → Check mint for unspent status
5. **Import Proofs** → Add to wallet
6. **Show Success** → Display amount received
7. **Navigate** → `/vouchers` with success toast

**Error Handling**:
- Invalid token format → "Invalid voucher token"
- Already redeemed → "This voucher has already been redeemed"
- Expired → "This voucher has expired"
- Network error → "Could not verify voucher. Try again?"

---

### 7. Voucher Details Screen (`/vouchers/:id`)

**Purpose**: View voucher details, status, and actions.

**Layout**:
```
┌────────────────────────────────────────────────────────────┐
│  ← Back                Voucher Details                     │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  🎁 Birthday Gift                                          │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Amount:        1000 sat                              │  │
│  │ Status:        ✅ Redeemed                            │  │
│  │ Issued:        Dec 15, 2025 at 3:45 PM              │  │
│  │ Redeemed:      Dec 16, 2025 at 10:20 AM             │  │
│  │ Expires:       Mar 15, 2026 (88 days left)          │  │
│  │ Issuer:        npub1abc...xyz                        │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  Memo                                                      │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Happy Birthday! Enjoy this gift from the team.      │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  Signature                                                 │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ a1b2c3d4e5f6... (64 hex chars)                       │  │
│  │ ✅ Valid signature                                    │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  [🗑️ Delete]  [📤 Share Again]  [⬇️ Export JSON]          │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

**Actions**:
- **Share Again**: Show QR code + token (if issued by user)
- **Export JSON**: Download voucher metadata
- **Delete**: Remove from local storage (confirm dialog)

**Data Display**:
- Amounts in sats (no decimals)
- Dates in local timezone (Dec 15, 2025 at 3:45 PM)
- Status with color-coded badge
- Signature validation indicator

---

### 8. Settings Screen (`/settings`)

**Purpose**: Configure app preferences and view system info.

**Layout**:
```
┌────────────────────────────────────────────────────────────┐
│  🔷 Imani Wallet    Identities Vouchers [⚙️ Settings]      │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Settings                                                  │
│                                                             │
│  ── General ────────────────────────────────────────────   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Default Mint URL                                     │  │
│  │ http://localhost:7777                     [Edit]     │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Default Currency Unit                                │  │
│  │ sat                                       [Change]   │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ── Nostr ──────────────────────────────────────────────   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Relays (4 configured)                     [Manage]   │  │
│  │ • wss://relay.damus.io                               │  │
│  │ • wss://relay.snort.social                           │  │
│  │ • wss://nos.lol                                      │  │
│  │ • wss://relay.nostr.band                             │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ── Privacy ────────────────────────────────────────────   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ ☑ Auto-backup vouchers to Nostr                      │  │
│  │ ☐ Share anonymous usage analytics                    │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ── Storage ────────────────────────────────────────────   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ IndexedDB Storage: 2.3 MB / 50 MB                    │  │
│  │ [Clear Cache]  [Export All Data]                     │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ── About ──────────────────────────────────────────────   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Imani Wallet v1.0.0                                  │  │
│  │ Built with ❤️ for self-custody                        │  │
│  │ [Documentation]  [GitHub]  [Report Issue]            │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

**Sections**:
1. **General**: Mint URL, currency unit
2. **Nostr**: Relay configuration
3. **Privacy**: Auto-backup, analytics
4. **Storage**: Cache size, export data
5. **About**: Version, links

---

## User Flows

### Flow 1: First-Time User Journey

```
1. User visits https://wallet.imani.cash
   ↓
2. Lands on /identities (empty state)
   "No identities yet. Create your first identity to start issuing vouchers"
   ↓
3. Clicks "Create Identity"
   ↓
4. /identities/create
   - Enters label: "My Main Identity"
   - Clicks "Create Identity"
   ↓
5. Sees mnemonic:
   "abandon ability able about..."
   - Copies to password manager
   - Checks "I have securely backed up my recovery phrase"
   - Clicks "Done"
   ↓
6. Returns to /identities
   ✅ Success toast: "Identity created successfully"
   Shows identity card with npub
   ↓
7. Navigates to /vouchers (empty state)
   "No vouchers yet. Issue your first voucher to get started"
   ↓
8. Clicks "Issue Voucher" FAB
   ↓
9. /vouchers/issue
   - Amount: 1000
   - Memo: "Happy Birthday!"
   - Expiry: 90 days
   - Clicks "Continue"
   ↓
10. Sees QR code + token
    - Clicks "Copy Link"
    - Shares via WhatsApp
    ↓
11. Returns to /vouchers
    ✅ Success toast: "Voucher issued and shared"
    Shows voucher card with status "Issued"
```

**Time to First Voucher**: <2 minutes

---

### Flow 2: Redeem Received Voucher

```
1. Recipient receives WhatsApp message with link:
   https://wallet.imani.cash/vouchers/redeem?token=cashuAbc...
   ↓
2. Opens link → Auto-fills token field
   ↓
3. /vouchers/redeem (pre-filled)
   - Shows token preview
   - Clicks "Redeem"
   ↓
4. Loading: "Verifying voucher..."
   ↓
5. Success screen:
   "✅ Redeemed 1000 sat"
   "Happy Birthday!"
   ↓
6. Navigates to /vouchers
   Shows voucher in "Received" section
   Status: "Redeemed"
```

**Time to Redeem**: <30 seconds

---

### Flow 3: Recover Wallet

```
1. User on new device visits https://wallet.imani.cash
   ↓
2. /identities (empty state)
   ↓
3. Clicks "Import Identity" (secondary button)
   ↓
4. /identities/import
   - Pastes mnemonic: "abandon ability able..."
   - Label: "Restored Identity"
   - Clicks "Import"
   ↓
5. Returns to /identities
   ✅ "Identity restored successfully"
   ↓
6. Navigates to /settings
   - Clicks "Export All Data"
   - Downloads JSON backup
   ↓
7. Checks /vouchers
   - If auto-backup enabled: Vouchers sync from Nostr
   - If not: Manually import from backup JSON
```

---

## Component Library

### Core Components

#### 1. **ImaniCard**
```kotlin
@Composable
fun ImaniCard(
    title: String,
    subtitle: String? = null,
    badge: String? = null,
    badgeColor: Color = Color.Blue,
    onClick: () -> Unit = {}
) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = Color.White),
        elevation = CardDefaults.cardElevation(2.dp)
    ) {
        Row(modifier = Modifier.padding(16.dp)) {
            Column(modifier = Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleMedium)
                subtitle?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall)
                }
            }
            badge?.let {
                StatusBadge(text = it, color = badgeColor)
            }
        }
    }
}
```

#### 2. **StatusBadge**
```kotlin
@Composable
fun StatusBadge(text: String, color: Color) {
    Surface(
        color = color.copy(alpha = 0.1f),
        shape = RoundedCornerShape(12.dp)
    ) {
        Text(
            text = text,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            style = MaterialTheme.typography.labelSmall,
            color = color
        )
    }
}
```

#### 3. **ImaniButton**
```kotlin
@Composable
fun ImaniButton(
    text: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
    variant: ButtonVariant = ButtonVariant.Primary
) {
    val colors = when (variant) {
        ButtonVariant.Primary -> ButtonDefaults.buttonColors(
            containerColor = ImaniColors.Primary
        )
        ButtonVariant.Secondary -> ButtonDefaults.outlinedButtonColors()
    }

    Button(
        onClick = onClick,
        enabled = enabled,
        colors = colors,
        modifier = Modifier.fillMaxWidth()
    ) {
        Text(text)
    }
}
```

#### 4. **QRCodeDisplay**
```kotlin
@Composable
fun QRCodeDisplay(data: String, size: Dp = 200.dp) {
    Box(
        modifier = Modifier.size(size),
        contentAlignment = Alignment.Center
    ) {
        // Use qrcode.js library via JS interop
        QRCodeCanvas(data = data)
    }
}
```

#### 5. **EmptyState**
```kotlin
@Composable
fun EmptyState(
    icon: String,
    title: String,
    message: String,
    primaryAction: (() -> Unit)? = null,
    primaryActionText: String = "Get Started"
) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Text(icon, fontSize = 64.sp)
        Spacer(Modifier.height(16.dp))
        Text(title, style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(8.dp))
        Text(message, style = MaterialTheme.typography.bodyMedium)
        primaryAction?.let {
            Spacer(Modifier.height(24.dp))
            Button(onClick = it) {
                Text(primaryActionText)
            }
        }
    }
}
```

---

## Responsive Design

### Breakpoints

| Breakpoint | Width | Layout |
|------------|-------|--------|
| **Mobile** | <640px | Single column, full-width cards |
| **Tablet** | 640-1024px | Centered content, max-width 768px |
| **Desktop** | >1024px | Centered content, max-width 1024px, side margins |

### Mobile Adaptations

- **Navigation**: Bottom navigation bar (Material 3 pattern)
- **Cards**: Full-width with 16px horizontal padding
- **Forms**: Full-width inputs, stacked buttons
- **QR Codes**: Responsive sizing (min 150px, max 300px)
- **FAB**: Bottom-right, 16px from edges

### Desktop Enhancements

- **Hover States**: Cards elevate on hover
- **Keyboard Shortcuts**: Ctrl+N (new voucher), Ctrl+I (import)
- **Multi-column**: Voucher list can show 2 columns on wide screens

---

## Accessibility

### WCAG 2.1 Level AA Compliance

**Visual**:
- Contrast ratio ≥4.5:1 for text
- Focus indicators on all interactive elements
- No color-only information (use icons + text)

**Keyboard**:
- Tab navigation in logical order
- Escape key closes modals
- Enter key activates primary button

**Screen Readers**:
- Semantic HTML via Compose for Web
- ARIA labels on icons
- Status announcements for async actions

**Motion**:
- Respects `prefers-reduced-motion`
- No auto-play animations
- Smooth scrolling optional

---

## Implementation Notes

### Technology Stack

- **Framework**: Compose Multiplatform (Kotlin/JS)
- **Routing**: Voyager Navigator
- **State**: StateFlow (ViewModel pattern)
- **Storage**: IndexedDB (via JS interop)
- **HTTP**: Ktor Client (JS engine)
- **Crypto**: Web Crypto API (@noble/secp256k1)
- **QR**: qrcode.js library

### Performance Targets

| Metric | Target |
|--------|--------|
| **Initial Load** | <3s (on 3G) |
| **Interaction Response** | <100ms |
| **Voucher Issuance** | <2s |
| **QR Generation** | <500ms |

### Browser Support

- Chrome/Edge: Latest 2 versions
- Firefox: Latest 2 versions
- Safari: Latest 2 versions
- Mobile: iOS Safari 14+, Chrome Android 90+

---

## Related Documentation

- [Android Client UI Design](android-client-ui-design.md) - Android app design
- [cashu-client Integration Master Plan](cashu-client-integration-master-plan.md) - Implementation roadmap
- [Kotlin Voucher Client Roadmap](kotlin-voucher-client-roadmap.md) - Main project roadmap

---

## Change Log

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2025-11-20 | Initial web client UI/UX specification |
