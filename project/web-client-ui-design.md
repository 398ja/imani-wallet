# Imani Wallet - Web Client UI/UX Design

> **Document Type**: Reference (Diátaxis)
> **Purpose**: Complete UI/UX specification for Imani Wallet web application
> **Platform**: Web (Kotlin/JS + Compose Multiplatform)
> **Design System**: Material 3 (Imani Brand Theme)
> **Version**: 2.0.0
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

**Imani Wallet** is a web-based self-custody digital voucher marketplace that enables:

**For Merchants**:
- Create and manage merchant profiles (Nostr-based)
- Issue voucher offers (e.g., "100 sat coffee voucher")
- Receive Lightning payments for voucher sales
- Accept voucher redemptions (online and in-person POS)
- Track sales and redemptions

**For Customers**:
- Discover merchants via Nostr npub (decentralized)
- Purchase vouchers with Lightning payments
- **Send vouchers to other customers** (P2P transfers)
- Hold vouchers from multiple merchants in one wallet
- Redeem vouchers (full or partial redemption)
- Track voucher balances and expiry dates
- **Backup/restore wallet** via encrypted Nostr

**Key Innovation**: **One app, dual roles** - any user can be both customer AND merchant.

---

### Business Model

**Merchant-Customer Marketplace + P2P Transfers**:

**Merchant → Customer**:
1. **Merchant** creates voucher offer (e.g., "100 sat coffee voucher - valid 30 days")
2. **Merchant** shares Nostr npub with customers (QR code, social media, in-store)
3. **Customer** discovers merchant by npub, browses voucher offers
4. **Customer** purchases voucher → pays Lightning invoice → receives Cashu token
5. **Customer** redeems voucher at merchant (scan QR code) → merchant accepts
6. **Partial Redemption**: 100 sat voucher used for 30 sat purchase → 70 sat balance remains

**Customer → Customer** (P2P Transfers):
1. **CustA** has a 100 sat voucher
2. **CustA** shares voucher token with **CustB** (QR code, URL, or Nostr DM)
3. **CustB** redeems the token → voucher added to CustB's wallet
4. **CustA** can no longer use that voucher (single-use tokens)

**Decentralized**: No central marketplace. Merchants share npubs, customers follow/search. All data on Nostr.

**Payment Flow**: Lightning → Cashu token (voucher) → Redemption

---

### Target Users

| User Type | Primary Goal | Technical Level |
|-----------|--------------|-----------------|
| **Small Merchants** | Issue vouchers, boost customer loyalty, accept Lightning | Low (simple POS interface) |
| **Customers** | Buy vouchers for discounts, support local businesses | Very low (familiar shopping UX) |
| **Power Users** | Manage multiple merchant profiles, bulk operations | Medium (advanced features) |

---

## Design Principles

### Brand Identity (Imani)

**Color Palette**:
- **Primary**: Deep Purple (#6B46C1) - Trust, wisdom
- **Secondary**: Deep Blue (#1E40AF) - Security
- **Tertiary**: Gold (#F59E0B) - Value, warmth
- **Background**: Cream (#FFFBEB) - Clarity
- **Surface**: White (#FFFFFF)
- **Success**: Green (#10B981) - Voucher active, payment received
- **Warning**: Orange (#F59E0B) - Expiring soon
- **Error**: Red (#DC2626) - Expired, payment failed

**Typography**:
- **Headers**: Inter Bold, 24-40px
- **Body**: Inter Regular, 14-16px
- **Captions**: Inter Regular, 12px
- **Monospace**: JetBrains Mono (for Nostr npub, Lightning invoices)

**Spacing**: 8dp base unit (8px, 16px, 24px, 32px)

**Elevation** (Material 3):
- Cards: 2dp, FAB: 6dp, Modals: 8dp

---

### UI Principles

1. **Role Clarity**: Clear distinction between Customer Mode and Merchant Mode
2. **Progressive Disclosure**: Advanced features hidden until needed
3. **Instant Feedback**: Loading states, success animations, clear errors
4. **Offline-First**: All operations work offline, sync when online
5. **Self-Custody**: Keys never leave browser, Lightning invoices paid externally
6. **Forgiving**: Easy undo, auto-save, recoverable actions

---

## Navigation Structure

### Primary Navigation (Bottom Tabs)

```
┌────────────────────────────────────────────────────────────┐
│                       Content Area                          │
│                                                             │
│                                                             │
├────────────────────────────────────────────────────────────┤
│   [🛒 Shop]        [💼 Merchant]        [⚙️ Settings]      │
└────────────────────────────────────────────────────────────┘
```

**Tab Navigation**:
- **Shop** (Customer Mode): Browse merchants, my vouchers, purchase history
- **Merchant** (Merchant Mode): My profile, create offers, sales dashboard, POS
- **Settings**: Identity management, payment settings, backup/restore

**Why Bottom Tabs?**:
- Mobile-friendly (thumb-reachable on phones)
- Clear role separation (Shop vs. Merchant)
- Familiar pattern (similar to WhatsApp, Instagram)

---

### Shop Tab (Customer Mode)

**Default View**: My Vouchers (grouped by merchant)

```
┌────────────────────────────────────────────────────────────┐
│  🛒 Shop                                    [+ Add Merchant]│
├────────────────────────────────────────────────────────────┤
│                                                             │
│  My Vouchers (3)                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ ☕ Coffee Shop Downtown                              │  │
│  │ Coffee Voucher       Balance: 70/100 sat  [Redeem] │  │
│  │ Expires in 25 days                                  │  │
│  └─────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ 🍕 Pizza Palace                                      │  │
│  │ Large Pizza Voucher  Balance: 500/500 sat [Redeem] │  │
│  │ Expires in 10 days                                  │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  Discover Merchants                                        │
│  [Enter Nostr npub or scan QR code]                       │
└────────────────────────────────────────────────────────────┘
```

**Sub-Screens**:
- My Vouchers (default)
- Discover Merchants (enter npub, scan QR)
- Merchant Detail (view offers)
- Purchase Voucher (Lightning payment)
- Redeem Voucher (show QR or enter merchant npub)
- Purchase History

---

### Merchant Tab (Merchant Mode)

**Default View**: Sales Dashboard

```
┌────────────────────────────────────────────────────────────┐
│  💼 Merchant                               [Edit Profile]  │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  ☕ Coffee Shop Downtown                                   │
│  npub1abc...xyz                            [Copy] [QR]     │
│                                                             │
│  Today's Sales                                             │
│  ┌──────────────┬──────────────┬─────────────────┐        │
│  │ 15 vouchers  │ 1,500 sat    │ 3 redemptions   │        │
│  │ sold         │ revenue      │ today           │        │
│  └──────────────┴──────────────┴─────────────────┘        │
│                                                             │
│  Active Offers (2)                     [+ Create Offer]    │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Coffee Voucher - 100 sat - 30 days                  │  │
│  │ 45 sold, 12 redeemed                      [Edit]    │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  [Scan Voucher to Redeem (POS)]                           │
└────────────────────────────────────────────────────────────┘
```

**Sub-Screens**:
- Sales Dashboard (default)
- My Merchant Profile (edit name, logo, description)
- Create Voucher Offer
- Edit Voucher Offer
- Sales Reports (daily, weekly, monthly)
- Redeem Voucher (POS scanner)

---

### Settings Tab

**Default View**: Identity + Payment Settings

```
┌────────────────────────────────────────────────────────────┐
│  ⚙️ Settings                                                │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Identity                                                  │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ 👤 My Identity                                       │  │
│  │ npub1abc...xyz                       [View Mnemonic]│  │
│  └─────────────────────────────────────────────────────┘  │
│  [+ Create New Identity] [Import Identity]                │
│                                                             │
│  Payment                                                   │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ ⚡ Lightning Wallet                                  │  │
│  │ Connected: Alby                          [Change]   │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  Backup & Security                                         │
│  [Backup to Nostr] [Export Wallet Data]                   │
│                                                             │
│  About                                                     │
│  Version 1.0.0 • Privacy Policy • Terms                   │
└────────────────────────────────────────────────────────────┘
```

---

## Screen Specifications

### 1. My Vouchers Screen (`/shop`)

**Purpose**: View all vouchers owned by the customer, grouped by merchant

**Layout**:
```
┌────────────────────────────────────────────────────────────┐
│  🛒 Shop                                    [+ Add Merchant]│
├────────────────────────────────────────────────────────────┤
│                                                             │
│  My Vouchers (3)                            [Sort ▼]       │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ ☕ Coffee Shop Downtown                              │  │
│  │ ─────────────────────────────────────────────────── │  │
│  │ Coffee Voucher                                      │  │
│  │ Balance: 70 / 100 sat                    [Redeem ›] │  │
│  │ Expires: 2025-12-20 (25 days)                      │  │
│  │                                                      │  │
│  │ 🟢 Active                                            │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ 🍕 Pizza Palace                                      │  │
│  │ ─────────────────────────────────────────────────── │  │
│  │ Large Pizza Voucher                                 │  │
│  │ Balance: 500 / 500 sat                   [Redeem ›] │  │
│  │ Expires: 2025-11-30 (10 days)                      │  │
│  │                                                      │  │
│  │ 🟠 Expiring Soon                                     │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ No vouchers yet?                                     │  │
│  │ Discover merchants and purchase your first voucher  │  │
│  │                                                      │  │
│  │               [Discover Merchants]                   │  │
│  └─────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

**Components**:
- **Voucher Card**: Merchant logo, name, voucher type, balance, expiry, status badge
- **Status Badges**: 🟢 Active, 🟠 Expiring Soon (<7 days), 🔴 Expired, ⚫ Redeemed
- **Sort Options**: By expiry (default), by merchant, by balance
- **Empty State**: Prompt to discover merchants

**Actions**:
- Tap voucher card → Voucher Details Screen
- [+ Add Merchant] → Discover Merchants Screen
- [Redeem] → Redeem Voucher Screen

---

### 2. Discover Merchants Screen (`/shop/discover`)

**Purpose**: Find merchants by Nostr npub or QR code scan

**Layout**:
```
┌────────────────────────────────────────────────────────────┐
│  [←] Discover Merchants                                     │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Find a merchant by their Nostr public key                 │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ npub1...                                    [Scan QR] │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  [Search]                                                  │
│                                                             │
│  Recent Merchants                                          │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ ☕ Coffee Shop Downtown                              │  │
│  │ npub1abc...xyz                             [View ›]  │  │
│  └─────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ 🍕 Pizza Palace                                      │  │
│  │ npub1def...xyz                             [View ›]  │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  💡 Tip: Ask merchants for their Nostr npub or scan       │
│     their QR code in-store                                 │
└────────────────────────────────────────────────────────────┘
```

**Components**:
- **Search Input**: Text field for pasting Nostr npub (npub1... format)
- **Scan QR Button**: Opens camera to scan merchant QR code
- **Recent Merchants**: List of previously viewed merchants
- **Validation**: Check npub format, show error if invalid

**Actions**:
- Enter npub → [Search] → Merchant Detail Screen
- [Scan QR] → Camera opens → Scans npub → Merchant Detail Screen
- Tap recent merchant → Merchant Detail Screen

---

### 3. Merchant Detail Screen (`/shop/merchant/:npub`)

**Purpose**: View merchant profile and available voucher offers

**Layout**:
```
┌────────────────────────────────────────────────────────────┐
│  [←] Coffee Shop Downtown                                   │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │             [Merchant Logo]                          │  │
│  │                                                      │  │
│  │  ☕ Coffee Shop Downtown                             │  │
│  │  Best coffee in town since 2020                     │  │
│  │                                                      │  │
│  │  npub1abc...xyz                  [Copy] [QR] [⭐]   │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  Available Vouchers (3)                                    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Coffee Voucher                                       │  │
│  │ 100 sat • Valid 30 days                              │  │
│  │ Get any regular coffee                               │  │
│  │                                                      │  │
│  │                                       [Buy for 100]  │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Pastry Voucher                                       │  │
│  │ 50 sat • Valid 30 days                               │  │
│  │ Any pastry or cookie                                 │  │
│  │                                                      │  │
│  │                                        [Buy for 50]  │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Lunch Combo                                          │  │
│  │ 500 sat • Valid 30 days                              │  │
│  │ Sandwich + coffee + pastry                           │  │
│  │                                                      │  │
│  │                                       [Buy for 500]  │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

**Components**:
- **Merchant Header**: Logo, name, description, npub (truncated)
- **Actions**: Copy npub, show QR code, favorite merchant (⭐)
- **Voucher Offer Cards**: Name, price, validity, description, [Buy] button
- **Empty State**: "No active offers" if merchant has no vouchers

**Actions**:
- Tap [Buy for X sat] → Purchase Voucher Screen (Lightning payment)
- [Copy] → Copy npub to clipboard
- [QR] → Show QR code with npub (for sharing)
- [⭐] → Favorite merchant (shows in "Favorites" section)

---

### 4. Purchase Voucher Screen (`/shop/purchase/:offerId`)

**Purpose**: Pay Lightning invoice to purchase voucher

**Layout (Step 1: Confirm Purchase)**:
```
┌────────────────────────────────────────────────────────────┐
│  [←] Purchase Voucher                                       │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  You're buying:                                            │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ ☕ Coffee Shop Downtown                              │  │
│  │ ─────────────────────────────────────────────────── │  │
│  │ Coffee Voucher                                       │  │
│  │ 100 sat • Valid 30 days                              │  │
│  │ Get any regular coffee                               │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  Payment Details                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Amount:          100 sat                             │  │
│  │ Network Fee:     ~2 sat (Lightning)                  │  │
│  │ Total:           102 sat                             │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  Payment Method                                            │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ ⚡ Lightning Wallet (Alby)              [Change]    │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  [Cancel]                              [Confirm Purchase]  │
└────────────────────────────────────────────────────────────┘
```

**Layout (Step 2: Lightning Payment)**:
```
┌────────────────────────────────────────────────────────────┐
│  [←] Pay Lightning Invoice                                  │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Scan with your Lightning wallet                           │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │                                                      │  │
│  │         [QR Code: Lightning Invoice]                │  │
│  │              lnbc102...                              │  │
│  │                                                      │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  Or copy invoice:                                          │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ lnbc102n1...                            [Copy]       │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  [Open in Alby]  [Open in Zeus]  [Open in Phoenix]        │
│                                                             │
│  ⏳ Waiting for payment...                                 │
│                                                             │
│  [Cancel]                                                  │
└────────────────────────────────────────────────────────────┘
```

**Layout (Step 3: Success)**:
```
┌────────────────────────────────────────────────────────────┐
│  [×] Purchase Complete                                      │
├────────────────────────────────────────────────────────────┤
│                                                             │
│              ✅                                             │
│                                                             │
│  Payment received!                                         │
│                                                             │
│  Your voucher is ready:                                    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ ☕ Coffee Shop Downtown                              │  │
│  │ Coffee Voucher                                       │  │
│  │ Balance: 100/100 sat                                 │  │
│  │ Expires: 2025-12-20                                  │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  [View Voucher]                       [Buy Another]        │
└────────────────────────────────────────────────────────────┘
```

**Flow**:
1. Confirm purchase details → [Confirm Purchase]
2. Merchant generates Lightning invoice → Display QR code
3. Customer scans QR with external Lightning wallet (Alby, Zeus, Phoenix)
4. Payment received → Merchant issues Cashu token voucher
5. Voucher added to customer's wallet → Success screen

**Error Handling**:
- **Invoice expired** (default 5 min): "Invoice expired. Try again?"
- **Payment failed**: "Payment failed. Check your Lightning wallet balance."
- **Merchant offline**: "Merchant is offline. Try again later."

---

### 5. Redeem Voucher Screen (`/shop/redeem/:voucherId`)

**Purpose**: Redeem voucher at merchant (full or partial)

**Layout (Customer View)**:
```
┌────────────────────────────────────────────────────────────┐
│  [←] Redeem Voucher                                         │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Show this to the merchant:                                │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │                                                      │  │
│  │         [QR Code: Voucher Token]                    │  │
│  │          cashuA...                                   │  │
│  │                                                      │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  ☕ Coffee Shop Downtown                                   │
│  Coffee Voucher                                            │
│  Balance: 70 / 100 sat                                     │
│  Expires: 2025-12-20 (25 days)                             │
│                                                             │
│  ⏳ Waiting for merchant to scan...                        │
│                                                             │
│  Or enter redemption amount:                               │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Amount to redeem: [____] sat (max 70)               │  │
│  └─────────────────────────────────────────────────────┘  │
│  [Submit Redemption]                                       │
│                                                             │
│  [Cancel]                                                  │
└────────────────────────────────────────────────────────────┘
```

**Layout (Merchant Scanning - Success)**:
```
┌────────────────────────────────────────────────────────────┐
│  [×] Redemption Complete                                    │
├────────────────────────────────────────────────────────────┤
│                                                             │
│              ✅                                             │
│                                                             │
│  30 sat redeemed                                           │
│                                                             │
│  Remaining balance: 40 sat                                 │
│                                                             │
│  ☕ Coffee Shop Downtown                                   │
│  Coffee Voucher                                            │
│                                                             │
│  [Done]                                                    │
└────────────────────────────────────────────────────────────┘
```

**Flow**:
1. Customer selects voucher → [Redeem]
2. Display QR code with Cashu token
3. **Option A (In-Person POS)**: Merchant scans QR → Enters amount → Confirms redemption
4. **Option B (Manual)**: Customer enters amount → Merchant confirms via their app
5. Voucher balance updated → Success screen

**Partial Redemption Logic**:
- Voucher balance: 100 sat
- Purchase amount: 30 sat
- After redemption: 70 sat balance remains
- Voucher still active (can be redeemed again until balance = 0)

---

### 6. Sales Dashboard Screen (`/merchant`)

**Purpose**: Overview of merchant's sales, active offers, and redemptions

**Layout**:
```
┌────────────────────────────────────────────────────────────┐
│  💼 Merchant                               [Edit Profile]  │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  ☕ Coffee Shop Downtown                                   │
│  npub1abc...xyz                            [Copy] [QR]     │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Share your profile:                                  │  │
│  │ [QR Code: npub1abc...]         [Print QR for Store] │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  Today's Sales                              [View Report]  │
│  ┌────────────┬────────────┬────────────┬──────────────┐  │
│  │ 15 vouchers│ 1,500 sat  │ 3 redeemed │ 1,400 sat    │  │
│  │ sold       │ revenue    │ today      │ outstanding  │  │
│  └────────────┴────────────┴────────────┴──────────────┘  │
│                                                             │
│  Active Offers (2)                     [+ Create Offer]    │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Coffee Voucher - 100 sat - 30 days                  │  │
│  │ 45 sold, 12 redeemed, 33 active                     │  │
│  │                                         [Edit] [⋮]   │  │
│  └─────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Pastry Voucher - 50 sat - 30 days                   │  │
│  │ 20 sold, 5 redeemed, 15 active                      │  │
│  │                                         [Edit] [⋮]   │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  [Scan Voucher to Redeem (POS)]                           │
│                                                             │
│  Recent Redemptions                                        │
│  • Coffee Voucher - 100 sat - 2 min ago                   │
│  • Coffee Voucher - 30 sat (partial) - 15 min ago         │
│  • Pastry Voucher - 50 sat - 1 hour ago                   │
└────────────────────────────────────────────────────────────┘
```

**Components**:
- **Merchant Header**: Name, npub, QR code for sharing
- **Sales Metrics**: Vouchers sold today, revenue, redemptions, outstanding balance
- **Active Offers**: List of voucher offers with sales stats
- **POS Button**: Large button to scan customer vouchers
- **Recent Redemptions**: Real-time feed of redemptions

**Actions**:
- [Edit Profile] → Edit Merchant Profile Screen
- [View Report] → Sales Reports Screen (daily, weekly, monthly)
- [+ Create Offer] → Create Voucher Offer Screen
- [Edit] → Edit Voucher Offer Screen
- [⋮] → More options (pause, delete offer)
- [Scan Voucher to Redeem] → POS Redemption Screen

---

### 7. Create Voucher Offer Screen (`/merchant/create-offer`)

**Purpose**: Merchant creates new voucher offer

**Layout**:
```
┌────────────────────────────────────────────────────────────┐
│  [←] Create Voucher Offer                                   │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Voucher Details                                           │
│                                                             │
│  Voucher Name                                              │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Coffee Voucher                                       │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  Description                                               │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Get any regular coffee (hot or iced)                │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  Price (sat)                                               │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ 100                                                  │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  Validity Period                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ [○ 7 days] [○ 30 days] [●] [○ 90 days] [○ Custom] │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  ☑️ Allow partial redemption                               │
│  ☑️ Allow multiple redemptions per voucher                 │
│                                                             │
│  Preview                                                   │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Coffee Voucher                                       │  │
│  │ 100 sat • Valid 30 days                              │  │
│  │ Get any regular coffee (hot or iced)                │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  [Cancel]                              [Create Offer]      │
└────────────────────────────────────────────────────────────┘
```

**Form Fields**:
- **Voucher Name** (required): Short name (e.g., "Coffee Voucher")
- **Description** (optional): What customer gets (e.g., "Any regular coffee")
- **Price** (required): Amount in sats (e.g., 100)
- **Validity Period** (required): 7/30/90 days or custom
- **Partial Redemption** (checkbox): Allow using voucher multiple times until balance = 0
- **Multiple Redemptions** (checkbox): Allow redeeming same voucher multiple times

**Validation**:
- Price > 0
- Voucher name not empty
- Validity period > 0

**Actions**:
- [Create Offer] → Offer published to Nostr → Success message → Back to Sales Dashboard
- [Cancel] → Discard changes → Back to Sales Dashboard

---

### 8. POS Redemption Screen (`/merchant/redeem`)

**Purpose**: Merchant scans customer voucher QR code and confirms redemption

**Layout (Step 1: Scan QR)**:
```
┌────────────────────────────────────────────────────────────┐
│  [←] Redeem Voucher (POS)                                   │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Scan customer's voucher QR code                           │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │                                                      │  │
│  │         [Camera View: QR Scanner]                   │  │
│  │                                                      │  │
│  │                                                      │  │
│  │         Point camera at voucher QR code             │  │
│  │                                                      │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  Or enter voucher code manually:                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ cashuA...                                            │  │
│  └─────────────────────────────────────────────────────┘  │
│  [Submit]                                                  │
│                                                             │
│  [Cancel]                                                  │
└────────────────────────────────────────────────────────────┘
```

**Layout (Step 2: Confirm Redemption)**:
```
┌────────────────────────────────────────────────────────────┐
│  [←] Confirm Redemption                                     │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Voucher Details                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Coffee Voucher                                       │  │
│  │ Balance: 70 / 100 sat                                │  │
│  │ Expires: 2025-12-20 (25 days)                       │  │
│  │ Status: ✅ Valid                                     │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  Redemption Amount                                         │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Amount (sat): [30____]           (max 70 sat)       │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  [Quick Fill: 10] [25] [50] [70 (Full)]                   │
│                                                             │
│  After Redemption                                          │
│  • Customer balance: 40 sat remaining                      │
│  • Your revenue: +30 sat                                   │
│                                                             │
│  [Cancel]                              [Confirm Redeem]    │
└────────────────────────────────────────────────────────────┘
```

**Layout (Step 3: Success)**:
```
┌────────────────────────────────────────────────────────────┐
│  [×] Redemption Complete                                    │
├────────────────────────────────────────────────────────────┤
│                                                             │
│              ✅                                             │
│                                                             │
│  30 sat redeemed                                           │
│                                                             │
│  Customer balance: 40 sat remaining                        │
│                                                             │
│  [Scan Another]                         [Done]             │
└────────────────────────────────────────────────────────────┘
```

**Flow**:
1. Merchant opens POS → Camera activates
2. Customer shows voucher QR code → Merchant scans
3. Voucher details displayed → Merchant enters redemption amount
4. [Confirm Redeem] → Voucher balance updated → Success screen

**Error Handling**:
- **Invalid voucher**: "This voucher is not from your store"
- **Expired voucher**: "Voucher expired on [date]"
- **Already redeemed**: "Voucher fully redeemed"
- **Amount > balance**: "Amount exceeds voucher balance (max 70 sat)"

---

### 9. Edit Merchant Profile Screen (`/merchant/profile/edit`)

**Purpose**: Edit merchant name, description, logo

**Layout**:
```
┌────────────────────────────────────────────────────────────┐
│  [←] Edit Merchant Profile                                  │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Merchant Logo                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │         [Current Logo or Placeholder]                │  │
│  └─────────────────────────────────────────────────────┘  │
│  [Upload New Logo]                                         │
│                                                             │
│  Business Name                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Coffee Shop Downtown                                 │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  Description                                               │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Best coffee in town since 2020. We source organic   │  │
│  │ beans from local farms and roast in-house.          │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  Contact (optional)                                        │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Email: coffee@example.com                            │  │
│  │ Phone: +1234567890                                   │  │
│  │ Website: https://coffeeshop.com                      │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  Nostr Identity (read-only)                                │
│  npub1abc...xyz                            [Copy]          │
│                                                             │
│  [Cancel]                              [Save Changes]      │
└────────────────────────────────────────────────────────────┘
```

---

### 10. Settings Screen (`/settings`)

**Purpose**: Manage identity, payment settings, backup, app settings

**Layout**:
```
┌────────────────────────────────────────────────────────────┐
│  ⚙️ Settings                                                │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Identity (Single Account)                                 │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ 👤 My Identity                                       │  │
│  │ npub1abc...xyz                         [Copy npub]  │  │
│  │ [View Private Key (nsec)]                           │  │
│  │                                                      │  │
│  │ ⚠️ Warning: Never share your nsec (private key)     │  │
│  └─────────────────────────────────────────────────────┘  │
│  [Logout]                                                  │
│                                                             │
│  Payment                                                   │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ ⚡ Lightning Wallet                                  │  │
│  │ Connected: Alby                                      │  │
│  │ [Change Wallet] [Disconnect]                         │  │
│  └─────────────────────────────────────────────────────┘  │
│  [+ Add Payment Method]                                   │
│                                                             │
│  Backup & Security                                         │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ 🔐 Encrypted Nostr Backup                           │  │
│  │ Last backup: 2025-11-20 10:30 AM                    │  │
│  │ Status: ✅ Synced                                    │  │
│  │                                                      │  │
│  │ [Backup Now] [Restore from Nostr]                   │  │
│  └─────────────────────────────────────────────────────┘  │
│  [Export Wallet Data (JSON)]                               │
│                                                             │
│  App Settings                                              │
│  • Currency Display: [USD ▼]                               │
│  • Language: [English ▼]                                   │
│  • Notifications: [Enabled ▼]                              │
│  • Auto-backup: [Enabled ▼]                                │
│                                                             │
│  About                                                     │
│  Version 1.0.0                                             │
│  [Privacy Policy] [Terms of Service] [Help & Support]     │
└────────────────────────────────────────────────────────────┘
```

**Notes**:
- **Single Identity Model**: One account per user (no multi-identity support)
- **No Mnemonic**: Uses npub/nsec format only (Nostr standard)
- **Automatic Backup**: Wallet state backed up to Nostr relays (NIP-17 + NIP-44)
- **Restore**: One-click restore from Nostr on new device/browser

---

## User Flows

### Flow 1: First-Time Merchant Setup (<3 minutes)

**Goal**: Coffee shop owner registers, sets up merchant profile, creates first voucher offer

```
1. User opens app (first time)
   ↓
2. Landing page → [Register]
   • Generate new keys automatically
   • Display npub (public key): "npub1abc...xyz"
   • Display nsec (private key): "nsec1def...uvw"
   • ⚠️ "Save your nsec securely - this is your login!"
   • [Copy npub] [Copy nsec] [I've saved my keys →]
   ↓
3. /merchant → Edit Profile
   • Business name: "Coffee Shop Downtown"
   • Description: "Best coffee in town"
   • Upload logo (optional)
   • [Save]
   ↓
4. /merchant → [+ Create Offer]
   • Voucher name: "Coffee Voucher"
   • Price: 100 sat
   • Validity: 30 days
   • ✓ Allow partial redemption
   • [Create Offer]
   ↓
5. Success! Merchant Dashboard shows:
   • QR code with npub (print for in-store display)
   • Active offer: "Coffee Voucher - 100 sat"
   ↓
6. Merchant shares npub on social media, in-store signage
   ✅ Setup complete (<3 minutes)
```

**Note**: No mnemonic phrase - users save their nsec (private key) directly. Simpler UX.

---

### Flow 2: Customer Purchases and Redeems Voucher (<2 minutes)

**Goal**: Customer discovers merchant, buys voucher, redeems at POS

```
1. Customer sees QR code at coffee shop (in-store)
   ↓
2. Opens app → /shop/discover → [Scan QR]
   • Scans merchant QR code → Merchant Detail Screen
   ↓
3. Views available vouchers
   • "Coffee Voucher - 100 sat - Valid 30 days"
   • [Buy for 100]
   ↓
4. Purchase flow:
   • Confirm purchase → Lightning invoice generated
   • Scan QR with Alby wallet → Pay 102 sat (including fee)
   • Payment confirmed → Voucher added to wallet
   ↓
5. Customer orders coffee at counter
   ↓
6. /shop → My Vouchers → Tap "Coffee Voucher" → [Redeem]
   • Display QR code to merchant
   ↓
7. Merchant scans QR code
   • Enters redemption amount: 100 sat (full redemption)
   • [Confirm Redeem]
   ↓
8. Success! Voucher redeemed
   • Customer wallet: Voucher marked as redeemed
   • Merchant dashboard: +100 sat revenue
   ✅ Transaction complete (<2 minutes from purchase to redemption)
```

---

### Flow 3: Partial Redemption (<1 minute)

**Goal**: Customer uses 100 sat voucher for 30 sat purchase, balance remains

```
1. Customer has voucher: Balance 100/100 sat
   ↓
2. Customer buys 30 sat item at coffee shop
   ↓
3. Customer: /shop → My Vouchers → [Redeem]
   • Shows QR code
   ↓
4. Merchant: /merchant → [Scan Voucher to Redeem]
   • Scans customer QR
   • Voucher details: "Balance 100 sat"
   • Enter amount: 30 sat
   • [Confirm Redeem]
   ↓
5. Success!
   • Customer balance: 70 sat remaining
   • Merchant revenue: +30 sat
   • Voucher still active (can be used again)
   ✅ Partial redemption complete
```

---

### Flow 4: Merchant Views Sales Report

**Goal**: Coffee shop owner checks daily sales and redemptions

```
1. Merchant: /merchant (Sales Dashboard)
   ↓
2. Today's Sales:
   • 15 vouchers sold → 1,500 sat revenue
   • 3 redemptions → 300 sat redeemed
   • Outstanding: 1,200 sat (unredeemed vouchers)
   ↓
3. [View Report] → Sales Reports Screen
   • Daily: 15 vouchers, 1,500 sat
   • Weekly: 78 vouchers, 7,800 sat
   • Monthly: 320 vouchers, 32,000 sat
   ↓
4. Download CSV report (optional)
   ✅ Sales insights gained
```

---

### Flow 5: P2P Voucher Transfer (<30 seconds)

**Goal**: CustA sends 100 sat voucher to CustB (friend/family)

```
1. CustA: /shop → My Vouchers
   • Has "Coffee Voucher - 100 sat"
   ↓
2. CustA: Tap voucher → [Send to Friend]
   • Display QR code with token: "cashuA..."
   • [Copy Token] [Share via...]
   ↓
3. CustA shares token with CustB
   • Option 1: Show QR code, CustB scans
   • Option 2: Copy token, send via WhatsApp/Telegram
   • Option 3: Send via Nostr DM (future)
   ↓
4. CustB: Opens app → /shop/discover → [Redeem Token]
   • Paste token: "cashuA..."
   • [Redeem]
   ↓
5. Success!
   • CustA: Voucher marked as transferred (no longer in wallet)
   • CustB: Voucher added to wallet (100 sat balance)
   • CustB can now redeem at merchant or send to someone else
   ✅ P2P transfer complete (<30 seconds)
```

**Note**: P2P transfers work because Cashu tokens are bearer assets. Whoever has the token owns the voucher.

---

### Flow 6: Wallet Backup & Restore (<1 minute)

**Goal**: User backs up wallet to Nostr, restores on new device

**Backup**:
```
1. User: /settings → Backup & Security
   ↓
2. [Backup Now]
   • Encrypts wallet state (NIP-44)
   • Publishes to Nostr relays (NIP-17)
   • Status: ✅ Synced
   ✅ Backup complete
```

**Restore** (on new device):
```
1. New device: Open app → [Login]
   • Enter nsec (private key)
   ↓
2. [Restore from Nostr]
   • Queries Nostr relays for encrypted backups
   • Decrypts with nsec
   • Restores vouchers, proofs, merchant profile
   ↓
3. Success!
   • All vouchers restored
   • Merchant offers restored
   • Ready to use
   ✅ Restore complete (<1 minute)
```

---

## Component Library

### 1. VoucherCard (Reusable)

**Purpose**: Display voucher summary in lists (customer and merchant views)

**Code**:
```kotlin
@Composable
fun VoucherCard(
    merchantName: String,
    merchantLogo: String? = null,
    voucherName: String,
    balance: Int, // Current balance
    originalAmount: Int, // Original amount
    expiresAt: Long, // Epoch seconds
    status: VoucherStatus, // ACTIVE, EXPIRING_SOON, EXPIRED, REDEEMED
    onClick: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        elevation = CardDefaults.cardElevation(2.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        )
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                // Merchant logo
                if (merchantLogo != null) {
                    Image(
                        painter = rememberImagePainter(merchantLogo),
                        contentDescription = null,
                        modifier = Modifier.size(40.dp).clip(CircleShape)
                    )
                    Spacer(Modifier.width(12.dp))
                }

                // Merchant name
                Text(
                    text = merchantName,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold
                )
            }

            Spacer(Modifier.height(8.dp))
            Divider()
            Spacer(Modifier.height(8.dp))

            // Voucher name
            Text(
                text = voucherName,
                style = MaterialTheme.typography.bodyLarge
            )

            Spacer(Modifier.height(4.dp))

            // Balance
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "Balance: $balance / $originalAmount sat",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )

                Button(
                    onClick = onClick,
                    modifier = Modifier.height(36.dp)
                ) {
                    Text("Redeem")
                }
            }

            Spacer(Modifier.height(4.dp))

            // Expiry
            val daysUntilExpiry = calculateDaysUntil(expiresAt)
            Text(
                text = "Expires: ${formatDate(expiresAt)} ($daysUntilExpiry days)",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            Spacer(Modifier.height(8.dp))

            // Status badge
            StatusBadge(status = status)
        }
    }
}
```

---

### 2. StatusBadge

**Purpose**: Display voucher status with color-coded badge

**Code**:
```kotlin
enum class VoucherStatus {
    ACTIVE, EXPIRING_SOON, EXPIRED, REDEEMED
}

@Composable
fun StatusBadge(status: VoucherStatus) {
    val (color, icon, text) = when (status) {
        VoucherStatus.ACTIVE -> Triple(
            Color(0xFF10B981), // Green
            Icons.Default.CheckCircle,
            "Active"
        )
        VoucherStatus.EXPIRING_SOON -> Triple(
            Color(0xFFF59E0B), // Orange
            Icons.Default.Warning,
            "Expiring Soon"
        )
        VoucherStatus.EXPIRED -> Triple(
            Color(0xFFDC2626), // Red
            Icons.Default.Cancel,
            "Expired"
        )
        VoucherStatus.REDEEMED -> Triple(
            Color(0xFF6B7280), // Gray
            Icons.Default.Check,
            "Redeemed"
        )
    }

    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .background(color.copy(alpha = 0.1f), RoundedCornerShape(12.dp))
            .padding(horizontal = 12.dp, vertical = 6.dp)
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = color,
            modifier = Modifier.size(16.dp)
        )
        Spacer(Modifier.width(6.dp))
        Text(
            text = text,
            style = MaterialTheme.typography.labelMedium,
            color = color,
            fontWeight = FontWeight.Medium
        )
    }
}
```

---

### 3. QRCodeDisplay

**Purpose**: Display QR code for voucher redemption or merchant profile sharing

**Code**:
```kotlin
@Composable
fun QRCodeDisplay(
    data: String, // Voucher token or Nostr npub
    size: Dp = 250.dp,
    label: String? = null
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier.fillMaxWidth()
    ) {
        // QR Code (using external library or Canvas)
        Box(
            modifier = Modifier
                .size(size)
                .background(Color.White, RoundedCornerShape(8.dp))
                .padding(16.dp),
            contentAlignment = Alignment.Center
        ) {
            // TODO: Implement QR code generation (using qrcode.js or kotlinx-qrcode)
            Text("QR CODE", fontFamily = FontFamily.Monospace)
        }

        if (label != null) {
            Spacer(Modifier.height(8.dp))
            Text(
                text = label,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }

        Spacer(Modifier.height(12.dp))

        // Data preview (truncated)
        SelectionContainer {
            Text(
                text = data.take(20) + "..." + data.takeLast(20),
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }

        Spacer(Modifier.height(8.dp))

        OutlinedButton(
            onClick = { copyToClipboard(data) }
        ) {
            Icon(Icons.Default.ContentCopy, contentDescription = null)
            Spacer(Modifier.width(4.dp))
            Text("Copy")
        }
    }
}
```

---

### 4. LightningInvoiceDisplay

**Purpose**: Display Lightning invoice QR code and payment options

**Code**:
```kotlin
@Composable
fun LightningInvoiceDisplay(
    invoice: String, // lnbc...
    amount: Int, // sats
    onPaymentReceived: () -> Unit
) {
    var paymentStatus by remember { mutableStateOf(PaymentStatus.PENDING) }

    LaunchedEffect(invoice) {
        // Poll for payment confirmation
        while (paymentStatus == PaymentStatus.PENDING) {
            delay(2000)
            val isPaid = checkInvoicePaid(invoice) // API call
            if (isPaid) {
                paymentStatus = PaymentStatus.PAID
                onPaymentReceived()
            }
        }
    }

    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier.fillMaxWidth()
    ) {
        Text(
            text = "Scan with your Lightning wallet",
            style = MaterialTheme.typography.titleMedium
        )

        Spacer(Modifier.height(16.dp))

        // QR Code
        QRCodeDisplay(data = invoice, size = 250.dp)

        Spacer(Modifier.height(16.dp))

        // Amount
        Text(
            text = "$amount sat",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            color = Color(0xFFF59E0B) // Gold
        )

        Spacer(Modifier.height(24.dp))

        // Quick links to open in wallets
        Text(
            text = "Or open in:",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )

        Spacer(Modifier.height(8.dp))

        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            OutlinedButton(onClick = { openInAlby(invoice) }) {
                Text("Alby")
            }
            OutlinedButton(onClick = { openInZeus(invoice) }) {
                Text("Zeus")
            }
            OutlinedButton(onClick = { openInPhoenix(invoice) }) {
                Text("Phoenix")
            }
        }

        Spacer(Modifier.height(24.dp))

        // Payment status
        when (paymentStatus) {
            PaymentStatus.PENDING -> {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(20.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = "Waiting for payment...",
                        style = MaterialTheme.typography.bodyMedium
                    )
                }
            }
            PaymentStatus.PAID -> {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        Icons.Default.CheckCircle,
                        contentDescription = null,
                        tint = Color(0xFF10B981)
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = "Payment received!",
                        style = MaterialTheme.typography.bodyMedium,
                        color = Color(0xFF10B981)
                    )
                }
            }
            PaymentStatus.EXPIRED -> {
                Text(
                    text = "Invoice expired. Please try again.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error
                )
            }
        }
    }
}

enum class PaymentStatus {
    PENDING, PAID, EXPIRED
}
```

---

### 5. MerchantProfileCard

**Purpose**: Display merchant profile in discovery/detail screens

**Code**:
```kotlin
@Composable
fun MerchantProfileCard(
    name: String,
    description: String,
    npub: String,
    logo: String? = null,
    isFavorite: Boolean = false,
    onFavoriteClick: () -> Unit = {},
    onViewProfile: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onViewProfile),
        elevation = CardDefaults.cardElevation(2.dp)
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                // Logo + Name
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (logo != null) {
                        Image(
                            painter = rememberImagePainter(logo),
                            contentDescription = null,
                            modifier = Modifier.size(48.dp).clip(CircleShape)
                        )
                        Spacer(Modifier.width(12.dp))
                    }

                    Column {
                        Text(
                            text = name,
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            text = npub.take(12) + "...",
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }

                // Favorite button
                IconButton(onClick = onFavoriteClick) {
                    Icon(
                        imageVector = if (isFavorite) Icons.Default.Star else Icons.Default.StarOutline,
                        contentDescription = "Favorite",
                        tint = if (isFavorite) Color(0xFFF59E0B) else MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            Spacer(Modifier.height(8.dp))

            // Description
            Text(
                text = description,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )

            Spacer(Modifier.height(12.dp))

            // Actions
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                OutlinedButton(
                    onClick = { copyToClipboard(npub) },
                    modifier = Modifier.weight(1f)
                ) {
                    Icon(Icons.Default.ContentCopy, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(4.dp))
                    Text("Copy")
                }

                Button(
                    onClick = onViewProfile,
                    modifier = Modifier.weight(1f)
                ) {
                    Text("View Offers")
                }
            }
        }
    }
}
```

---

## Responsive Design

### Breakpoints

| Device | Width | Layout Strategy |
|--------|-------|-----------------|
| **Mobile** | < 640px | Single column, bottom tabs, stacked content |
| **Tablet** | 640-1024px | Two-column layout for lists, side-by-side forms |
| **Desktop** | > 1024px | Three-column dashboard, persistent navigation rail |

---

### Mobile (<640px)

**Layout**:
- Bottom navigation tabs (Shop, Merchant, Settings)
- Single-column content
- Full-width cards
- Large touch targets (48x48dp minimum)
- Bottom sheets for modals

**Example** (My Vouchers):
```
┌──────────────────────┐
│  🛒 Shop   [+ Add]   │ TopAppBar
├──────────────────────┤
│                      │
│  [Voucher Card 1]    │ Full width
│  [Voucher Card 2]    │
│  [Voucher Card 3]    │
│                      │
├──────────────────────┤
│ [Shop] [Merchant] [⚙️]│ Bottom tabs
└──────────────────────┘
```

---

### Tablet (640-1024px)

**Layout**:
- Side navigation rail (left) + content (right)
- Two-column grid for voucher lists
- Side-by-side forms (2 fields per row)
- Modal dialogs instead of bottom sheets

**Example** (My Vouchers):
```
┌────────────────────────────────────────┐
│ [Shop]   │  My Vouchers        [+ Add] │
│ [Merchant]├──────────────────────────────┤
│ [Settings]│  [Voucher 1]  [Voucher 2]  │
│           │  [Voucher 3]  [Voucher 4]  │
│           │                             │
└────────────────────────────────────────┘
```

---

### Desktop (>1024px)

**Layout**:
- Three-column layout: Nav rail (left) + Main content (center) + Details panel (right)
- Grid layouts for vouchers (3-4 columns)
- Persistent navigation rail
- Multi-window support (open multiple vouchers in tabs)

**Example** (Sales Dashboard):
```
┌────────────────────────────────────────────────────────────┐
│ [Shop]     │  Sales Dashboard         │ Voucher Details   │
│ [Merchant] ├───────────────────────────┤                   │
│ [Settings] │  Today's Sales            │ Coffee Voucher    │
│            │  [15 sold] [1,500 sat]   │ Balance: 70/100   │
│            │                           │                   │
│            │  Active Offers            │ [Redeem]          │
│            │  [Offer 1] [Offer 2]     │                   │
│            │  [Offer 3] [Offer 4]     │                   │
└────────────────────────────────────────────────────────────┘
```

---

## Accessibility

### WCAG 2.1 Level AA Compliance

| Guideline | Implementation |
|-----------|----------------|
| **Contrast** | Text-background contrast ≥ 4.5:1 (normal), ≥ 3:1 (large 18px+) |
| **Keyboard Navigation** | All interactive elements focusable via Tab, Enter/Space activates |
| **Screen Readers** | Semantic HTML, ARIA labels for icons, descriptive alt text |
| **Touch Targets** | Minimum 48x48dp (12mm) for buttons, 8dp spacing between targets |
| **Focus Indicators** | Visible focus ring (2px solid, high contrast) |
| **Color Blindness** | Status uses icons + text (not color alone) |

---

### Keyboard Shortcuts (Desktop)

| Shortcut | Action |
|----------|--------|
| `Tab` | Navigate between interactive elements |
| `Enter` / `Space` | Activate button or link |
| `Ctrl + C` | Copy selected text (npub, invoice) |
| `Esc` | Close modal/bottom sheet |
| `Ctrl + 1/2/3` | Switch tabs (Shop, Merchant, Settings) |
| `Ctrl + F` | Search merchants |

---

### Screen Reader Support

**Example Announcements**:
- "Coffee Shop Downtown voucher, balance 70 out of 100 satoshis, expires in 25 days, active, redeem button"
- "Lightning invoice for 100 satoshis, scan QR code or copy invoice to clipboard"
- "Merchant profile: Coffee Shop Downtown, Nostr public key npub1abc, copy button, view offers button"

---

## Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **UI Framework** | Compose Multiplatform (Kotlin/JS) | Declarative UI, shared code with Android |
| **Navigation** | Voyager Navigator | Type-safe navigation with deep linking |
| **State Management** | StateFlow + ViewModel | Reactive state updates |
| **Storage** | IndexedDB (via JS interop) | Persistent browser storage |
| **Crypto** | Web Crypto API + @noble/secp256k1 | secp256k1, Schnorr signatures |
| **QR Codes** | kotlinx-qrcode or qrcode.js | Generate QR codes for vouchers |
| **HTTP Client** | Ktor Client (Kotlin/JS) | Lightning invoice fetching |
| **Styling** | Material 3 (Compose) | Design system |

---

## Change Log

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2025-11-20 | Initial P2P voucher design (deprecated) |
| 2.0.0 | 2025-11-20 | **Complete redesign for merchant-customer marketplace**. New navigation (Shop/Merchant/Settings tabs), Lightning payment integration, partial redemption, Nostr-based merchant discovery, dual-role UX (customer + merchant in one app). |

---

**Related Documents**:
- [Android Client UI/UX Design](android-client-ui-design.md)
- [Cashu Client Integration Master Plan](cashu-client-integration-master-plan.md)
- [Kotlin Voucher Client Roadmap](kotlin-voucher-client-roadmap.md)
