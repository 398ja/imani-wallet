# Imani Wallet - Android Client UI/UX Design

> **Document Type**: Reference (Diátaxis)
> **Purpose**: Complete UI/UX specification for Imani Wallet Android application
> **Platform**: Android (Kotlin + Jetpack Compose)
> **Design System**: Material 3 (Imani Brand Theme)
> **Min SDK**: 26 (Android 8.0)
> **Target SDK**: 34 (Android 14)
> **Last Updated**: 2025-11-20

---

## Table of Contents

1. [Overview](#overview)
2. [Design Principles](#design-principles)
3. [Navigation Structure](#navigation-structure)
4. [Screen Specifications](#screen-specifications)
5. [User Flows](#user-flows)
6. [Android-Specific Features](#android-specific-features)
7. [Component Library](#component-library)
8. [Responsive Design](#responsive-design)
9. [Accessibility](#accessibility)

---

## Overview

### Application Purpose

**Imani Wallet** is a native Android self-custody digital voucher wallet that allows users to:
- Create and manage Nostr identities with Android Keystore encryption
- Issue cryptographically-signed vouchers (P2PK-locked)
- Share vouchers via QR codes, deep links, or Android Share Sheet
- Scan and redeem received vouchers using CameraX
- Track voucher lifecycle with offline-first SQLDelight storage
- Backup/restore via Nostr relays (NIP-17 + NIP-44)

### Target Devices

- **Primary**: Phones (4.7" - 6.7" screens, portrait)
- **Secondary**: Tablets (7" - 12" screens, landscape support)
- **Foldables**: Adaptive layouts for unfolded/folded states
- **Android TV**: Future consideration (voucher redemption kiosks)

### Key Android Advantages

1. **Biometric Auth**: Fingerprint/Face unlock for identity access
2. **System Share**: Native share intents for voucher distribution
3. **Camera Integration**: Fast QR scanning with CameraX
4. **Secure Storage**: Android Keystore for private key encryption
5. **Offline-First**: SQLDelight + Nostr sync architecture
6. **Widgets**: Home screen widget for quick voucher balance (future)

---

## Design Principles

### Material 3 for Android

**Dynamic Color** (Android 12+):
- Supports user-selected wallpaper-based theming
- Fallback to Imani brand colors on older devices

**Imani Brand Palette**:
```kotlin
object ImaniColors {
    val Primary = Color(0xFF6B46C1)      // Deep Purple
    val OnPrimary = Color(0xFFFFFFFF)    // White
    val PrimaryContainer = Color(0xFFE9DEFF)
    val OnPrimaryContainer = Color(0xFF23005C)

    val Secondary = Color(0xFF1E40AF)     // Deep Blue
    val OnSecondary = Color(0xFFFFFFFF)
    val SecondaryContainer = Color(0xFFDBE1FF)

    val Tertiary = Color(0xFFF59E0B)      // Gold
    val OnTertiary = Color(0xFF000000)

    val Background = Color(0xFFFFFBEB)    // Cream
    val Surface = Color(0xFFFFFFFF)       // White
    val SurfaceVariant = Color(0xFFF4F4F4)

    val Error = Color(0xFFDC2626)
    val OnError = Color(0xFFFFFFFF)

    val Success = Color(0xFF10B981)
    val Warning = Color(0xFFF59E0B)
}
```

**Typography** (Roboto/Inter):
```kotlin
object ImaniTypography {
    val DisplayLarge = TextStyle(fontSize = 57.sp, fontWeight = FontWeight.Normal)
    val TitleLarge = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
    val BodyLarge = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Normal)
    val LabelSmall = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Medium)
}
```

**Spacing** (8dp grid):
- **Extra Small**: 4dp
- **Small**: 8dp
- **Medium**: 16dp
- **Large**: 24dp
- **Extra Large**: 32dp

**Elevation** (Material 3):
- **Level 0**: 0dp (Surface)
- **Level 1**: 1dp (Cards at rest)
- **Level 2**: 3dp (Cards on hover/drag)
- **Level 3**: 6dp (FAB)
- **Level 4**: 8dp (Navigation drawer)
- **Level 5**: 12dp (Dialogs)

---

## Navigation Structure

### Bottom Navigation Bar (Material 3)

```
┌────────────────────────────────────────────────────────────┐
│                      Status Bar                            │
├────────────────────────────────────────────────────────────┤
│  [←]  Imani Wallet                              [⋮ Menu]   │ Top App Bar
├────────────────────────────────────────────────────────────┤
│                                                             │
│                                                             │
│                     Content Area                            │
│                                                             │
│                                                             │
├────────────────────────────────────────────────────────────┤
│  [👤 Identities]    [🎁 Vouchers]    [⚙️ Settings]        │ Bottom Nav
└────────────────────────────────────────────────────────────┘
```

**Navigation Items**:

| Tab | Icon | Label | Route | Destination |
|-----|------|-------|-------|-------------|
| 1 | `Icons.Outlined.Person` | Identities | `/identities` | Identity list |
| 2 | `Icons.Outlined.CardGiftcard` | Vouchers | `/vouchers` | Voucher list |
| 3 | `Icons.Outlined.Settings` | Settings | `/settings` | Settings |

**Behavior**:
- Active tab: Filled icon + Imani Purple tint
- Inactive tabs: Outlined icon + Gray tint
- Tap: Navigate to destination (with fade transition)
- Long press: Show tooltip with label

**Navigation Type**: `androidx.navigation.compose.NavHost`

---

### Floating Action Buttons (Context-Aware)

Each screen has a primary action FAB in the bottom-right:

| Screen | FAB Icon | Action | Destination |
|--------|----------|--------|-------------|
| **Identities** | `+` | Create Identity | `/identities/create` |
| **Vouchers** | `+` | Issue Voucher | `/vouchers/issue` |
| **Vouchers** | QR Scan | Redeem Voucher | `/vouchers/redeem` |

**Extended FAB** (on scroll up):
```kotlin
FloatingActionButton(
    onClick = { /* navigate */ },
    containerColor = ImaniColors.Primary,
    contentColor = ImaniColors.OnPrimary
) {
    Row(modifier = Modifier.padding(horizontal = 16.dp)) {
        Icon(Icons.Default.Add, contentDescription = null)
        AnimatedVisibility(visible = expanded) {
            Text("Create Identity", modifier = Modifier.padding(start = 8.dp))
        }
    }
}
```

---

### Navigation Graph

```
MainActivity
  ├── NavigationScreen.Identities
  │   ├── IdentityListScreenNav (default)
  │   ├── CreateIdentityScreenNav
  │   │   └── MnemonicBackupScreenNav
  │   ├── ImportIdentityScreenNav
  │   └── IdentityDetailsScreenNav(id)
  │
  ├── NavigationScreen.Vouchers
  │   ├── VoucherListScreenNav (default)
  │   ├── IssueVoucherScreenNav
  │   │   └── ShareVoucherScreenNav(id)
  │   ├── RedeemVoucherScreenNav
  │   │   └── QRScannerScreenNav
  │   └── VoucherDetailsScreenNav(id)
  │
  └── NavigationScreen.Settings
      ├── SettingsScreenNav (default)
      ├── RelaySettingsScreenNav
      ├── MintSettingsScreenNav
      └── AboutScreenNav
```

---

## Screen Specifications

### 1. Identity List Screen

**Route**: `/identities`

**Layout**:
```
┌────────────────────────────────────────────────────────────┐
│ Status Bar (24dp)                                          │
├────────────────────────────────────────────────────────────┤
│ [←] Identities                                  [⋮]        │ TopAppBar (64dp)
├────────────────────────────────────────────────────────────┤
│                                                             │
│  LazyColumn (scrollable)                                   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 👤 My Main Identity                  ✅ Active       │  │
│  │ npub1abc...xyz                                       │  │
│  │ Created 2 days ago                                   │  │
│  │ ───────────────────────────────────────────────────  │  │
│  │ [🔑 Export]  [✏️ Edit]  [🗑️ Delete]                 │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 👤 Store Account                    ⚪ Inactive      │  │
│  │ npub1def...uvw                                       │  │
│  │ Created 30 days ago                                  │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  [Empty State - if no identities]                          │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              🔑                                       │  │
│  │         No identities yet                            │  │
│  │    Create your first identity                        │  │
│  │    to start issuing vouchers                         │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│                                                       [+]   │ FAB (56x56dp)
├────────────────────────────────────────────────────────────┤
│ [👤] Identities    🎁 Vouchers    ⚙️ Settings            │ BottomNav (80dp)
└────────────────────────────────────────────────────────────┘
```

**Components**:
- **TopAppBar**: Title "Identities", overflow menu (⋮)
- **LazyColumn**: Scrollable list of identity cards
- **Identity Card** (per identity):
  - Icon: Person outline
  - Label: Bold, 16sp
  - Status Badge: "Active" (green) / "Inactive" (gray)
  - Npub: Monospace, 12sp, truncated (npub1abc...xyz)
  - Created date: Caption, 11sp, gray
  - Action Row: Export, Edit, Delete (IconButtons)
- **FAB**: "+" icon → Navigate to Create Identity
- **Empty State**: Icon + message + CTA button

**Interactions**:
- **Tap Card**: Expand/collapse action row
- **Long Press Card**: Show bottom sheet with all actions
- **Swipe Left**: Quick delete (with undo snackbar)
- **Pull to Refresh**: Sync with Nostr (if enabled)

---

### 2. Create Identity Screen

**Route**: `/identities/create`

**Layout** (Step 1 - Enter Label):
```
┌────────────────────────────────────────────────────────────┐
│ Status Bar                                                 │
├────────────────────────────────────────────────────────────┤
│ [←] Create Identity                              [✓]       │ TopAppBar
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Step 1 of 2                                               │
│                                                             │
│  Choose a Name                                             │
│  This is just a nickname for this identity.                │
│  You can change it later.                                  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Identity Label                                       │  │
│  │ ┌──────────────────────────────────────────────────┐ │  │
│  │ │ My Main Identity                    [×]          │ │  │ TextField
│  │ └──────────────────────────────────────────────────┘ │  │
│  │ 1-100 characters                                     │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  💡 Tip: Use a name that helps you identify this          │
│          identity's purpose (e.g., "Personal" or           │
│          "Store Account")                                  │
│                                                             │
│                                                             │
│  [Cancel]                              [Create →]          │ Buttons
│                                                             │
├────────────────────────────────────────────────────────────┤
│ 👤 Identities    🎁 Vouchers    ⚙️ Settings               │ BottomNav (hidden)
└────────────────────────────────────────────────────────────┘
```

**Layout** (Step 2 - Mnemonic Backup):
```
┌────────────────────────────────────────────────────────────┐
│ [←] Back Up Recovery Phrase                                │ TopAppBar
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Step 2 of 2                                               │
│                                                             │
│  ⚠️  Save This Recovery Phrase                             │
│  This is the ONLY way to recover your identity.           │
│  Write it down and keep it safe.                           │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  1. abandon    5. ecology     9. merge             │  │
│  │  2. ability    6. edge        10. merit            │  │
│  │  3. able       7. edit        11. merry            │  │
│  │  4. about      8. educate     12. mesh             │  │ Card (mnemonic)
│  │                                                      │  │
│  │  [📋 Copy to Clipboard]                             │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ ☐ I have securely backed up my recovery phrase     │  │ Checkbox
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  🔒 Security Tips:                                         │
│  • Write it on paper (don't screenshot)                    │
│  • Store in a safe or fireproof container                  │
│  • Never share with anyone                                 │
│                                                             │
│  [← Back]                                    [Done]        │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

**Behavior**:
1. Enter label → "Create" button enabled when valid (1-100 chars)
2. Click "Create" → Show loading indicator → Generate keys
3. Navigate to mnemonic screen → Display 12 words in grid
4. "Copy" button → Copy to clipboard, show snackbar
5. Checkbox unchecked → "Done" button disabled
6. Check checkbox → "Done" button enabled
7. Click "Done" → Navigate to identity list with success snackbar

**Security Features**:
- **Screen Security**: `WindowManager.LayoutParams.FLAG_SECURE` prevents screenshots
- **Copy Warning**: Snackbar warns "Never share your recovery phrase"
- **Clipboard Clear**: Auto-clear clipboard after 60 seconds

---

### 3. Voucher List Screen

**Route**: `/vouchers`

**Layout**:
```
┌────────────────────────────────────────────────────────────┐
│ [←] Vouchers                           [🔍] [Filter ▾]     │ TopAppBar
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Balance: 2,500 sat                                        │ Summary Card
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 📤 Issued: 3 vouchers (3,000 sat)                   │  │
│  │ 📥 Received: 2 vouchers (2,500 sat)                 │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ── Issued ─────────────────────────────────────────────   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 🎁 Birthday Gift              1,000 sat  📤 Shared   │  │
│  │ Issued 2 hours ago                                   │  │
│  │ Expires in 88 days                                   │  │
│  │ ───────────────────────────────────────────────────  │  │
│  │ [Share Again]  [Details]                             │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 🎁 Thank You Gift                 500 sat  ✅ Issued │  │
│  │ Issued 1 day ago                                     │  │
│  │ Expires in 89 days                                   │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ── Received ───────────────────────────────────────────   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 🎁 From Alice                   2,000 sat ✅ Redeemed│  │
│  │ Redeemed 3 days ago                                  │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│                                               [+] [Scan]   │ Dual FAB
├────────────────────────────────────────────────────────────┤
│ 👤 Identities    [🎁] Vouchers    ⚙️ Settings             │ BottomNav
└────────────────────────────────────────────────────────────┘
```

**Components**:
- **Balance Card**: Total balance from redeemed vouchers
- **Section Headers**: "Issued" / "Received" (sticky headers)
- **Voucher Card**:
  - Gift icon
  - Memo (or "Voucher {id}")
  - Amount + unit
  - Status badge (color-coded)
  - Date + expiry info
  - Action buttons (swipe to reveal or always visible)
- **Dual FAB**:
  - Primary: "+" → Issue voucher
  - Secondary: QR scan → Redeem voucher (speed dial)

**Filter Options** (dropdown):
- All Vouchers
- Issued Only
- Received Only
- Redeemed
- Active (not redeemed, not expired)
- Expired

**Search** (top-right):
- Search by memo, amount, or issuer npub

---

### 4. Issue Voucher Screen

**Route**: `/vouchers/issue`

**Layout**:
```
┌────────────────────────────────────────────────────────────┐
│ [←] Issue Voucher                               [✓ Save]   │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Voucher Details                                           │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Amount (sats) *                                      │  │
│  │ ┌──────────────────────────────────────────────────┐ │  │
│  │ │ 1000                                    [×]       │ │  │ TextField
│  │ └──────────────────────────────────────────────────┘ │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Memo (optional)                                      │  │
│  │ ┌──────────────────────────────────────────────────┐ │  │
│  │ │ Happy Birthday! 🎉                      [×]       │ │  │
│  │ └──────────────────────────────────────────────────┘ │  │
│  │ 0/200 characters                                     │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Expires In (days)                                    │  │
│  │ ┌──────────────────────────────────────────────────┐ │  │
│  │ │ 90                                      [×]       │ │  │
│  │ └──────────────────────────────────────────────────┘ │  │
│  │ Leave blank for no expiry                            │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ ▶ Advanced Options                                   │  │ Expandable
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  💡 Your voucher will be backed up to Nostr relays         │
│                                                             │
│  [Cancel]                            [Continue →]          │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

**Advanced Options** (expanded):
```
│  ┌──────────────────────────────────────────────────────┐  │
│  │ ▼ Advanced Options                                   │  │
│  │                                                       │  │
│  │ Mint URL                                             │  │
│  │ ┌──────────────────────────────────────────────────┐ │  │
│  │ │ http://localhost:7777                   [×]      │ │  │
│  │ └──────────────────────────────────────────────────┘ │  │
│  │                                                       │  │
│  │ Lock to Recipient (P2PK)                             │  │
│  │ ┌──────────────────────────────────────────────────┐ │  │
│  │ │ npub1...                                 [×]      │ │  │
│  │ └──────────────────────────────────────────────────┘ │  │
│  │ Optional: Voucher can only be redeemed by this      │  │
│  │ public key                                           │  │
│  └──────────────────────────────────────────────────────┘  │
```

**Validation**:
- Amount: Required, positive integer, max 21M
- Memo: Optional, max 200 chars
- Expiry: Optional, positive integer
- Mint URL: Valid URL format

**Flow**:
1. Enter details → "Continue" enabled when valid
2. Click "Continue" → Show loading dialog "Issuing voucher..."
3. Success → Navigate to Share screen with voucher ID

---

### 5. Share Voucher Screen

**Route**: `/vouchers/share/:id`

**Layout**:
```
┌────────────────────────────────────────────────────────────┐
│ [×] Share Voucher                                          │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  ✅ Voucher Issued Successfully                            │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                                                       │  │
│  │               [QR CODE]                              │  │ 300x300dp
│  │              (200x200dp)                             │  │
│  │                                                       │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  Scan QR code or share link to send this voucher          │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ cashuAbc123...xyz456                                 │  │ Monospace
│  │ (Tap to expand full token)                           │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌────────────────────────────────────────────────────── │  │
│  │ [📋]       [🔗]       [📧]       [💬]       [...]    │  │ Action Row
│  │ Copy      Link     Email      SMS      More         │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  📤 Backed up to Nostr relays                              │
│                                                             │
│  [Done]                                                    │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

**Share Actions**:
- **Copy**: Copy token to clipboard → Snackbar confirmation
- **Link**: Copy deep link `https://wallet.imani.cash/redeem?token=...`
- **Email**: Open email app with pre-filled subject + body
- **SMS**: Open SMS app with token
- **More**: Android Share Sheet with all apps

**Android Share Intent**:
```kotlin
val sendIntent = Intent(Intent.ACTION_SEND).apply {
    type = "text/plain"
    putExtra(Intent.EXTRA_SUBJECT, "Imani Voucher - $amount sat")
    putExtra(Intent.EXTRA_TEXT, "Redeem this voucher: $token")
}
startActivity(Intent.createChooser(sendIntent, "Share voucher via"))
```

---

### 6. Redeem Voucher Screen

**Route**: `/vouchers/redeem`

**Layout** (QR Scanner):
```
┌────────────────────────────────────────────────────────────┐
│ [←] Scan Voucher QR                           [💡 Torch]   │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                                                       │  │
│  │                  [Camera Preview]                    │  │ CameraX
│  │                   (Full screen)                      │  │ Preview
│  │                                                       │  │
│  │     ┌───────────────────────────────────┐            │  │
│  │     │                                   │            │  │
│  │     │      Scanning frame               │            │  │ Overlay
│  │     │      (Animated corners)           │            │  │
│  │     │                                   │            │  │
│  │     └───────────────────────────────────┘            │  │
│  │                                                       │  │
│  │                                                       │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  Point camera at voucher QR code                           │
│                                                             │
│  [Enter Token Manually]                                    │ Button (bottom)
│                                                             │
└────────────────────────────────────────────────────────────┘
```

**Layout** (Manual Entry):
```
┌────────────────────────────────────────────────────────────┐
│ [←] Redeem Voucher                             [QR Scan]   │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Enter Voucher Token                                       │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Voucher Token                                        │  │
│  │ ┌──────────────────────────────────────────────────┐ │  │
│  │ │ cashuAbc123...                          [Paste]  │ │  │ TextField
│  │ └──────────────────────────────────────────────────┘ │  │
│  │ Paste Cashu token (starts with cashuA...)           │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  💡 You can also scan a QR code instead                    │
│                                                             │
│  [Cancel]                                 [Redeem]         │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

**Scan Flow**:
1. **Camera Permission** → Request on first launch
2. **Camera Preview** → CameraX with ML Kit QR detection
3. **Detect QR** → Extract token, vibrate, play sound
4. **Validate** → Show loading "Verifying voucher..."
5. **Success** → Show bottom sheet with voucher preview
6. **Confirm** → "Redeem 1000 sat voucher?" → Yes/No
7. **Redeem** → Import proofs → Success snackbar

**Error Handling**:
- Invalid QR → Snackbar "Not a valid voucher QR code"
- Already redeemed → Dialog "This voucher has been redeemed"
- Expired → Dialog "This voucher expired on Dec 15, 2025"
- Network error → Retry button

---

### 7. Settings Screen

**Route**: `/settings`

**Layout**:
```
┌────────────────────────────────────────────────────────────┐
│ [←] Settings                                               │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  General                                                   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Default Mint URL                            [→]      │  │ Clickable
│  │ http://localhost:7777                                │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Default Currency                            [→]      │  │
│  │ sat                                                  │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  Security                                                  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 🔒 Biometric Unlock                      [Toggle]    │  │ Switch
│  │ Require fingerprint to access identities             │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 📱 Screen Security                        [Toggle]    │  │
│  │ Prevent screenshots (enabled by default)             │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  Nostr                                                     │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Relays (4 configured)                       [→]      │  │
│  │ wss://relay.damus.io, wss://nos.lol...               │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ ☑ Auto-backup vouchers                   [Toggle]    │  │
│  │ Automatically backup issued vouchers to Nostr        │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  Storage                                                   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Database Size: 2.3 MB                                │  │
│  │ [Clear Cache]  [Export All Data]                     │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  About                                                     │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Imani Wallet v1.0.0 (Build 42)                       │  │
│  │ [Help & Docs]  [GitHub]  [Report Issue]              │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
├────────────────────────────────────────────────────────────┤
│ 👤 Identities    🎁 Vouchers    [⚙️] Settings             │
└────────────────────────────────────────────────────────────┘
```

**Settings Sections**:
1. **General**: Mint URL, currency unit
2. **Security**: Biometric auth, screen security
3. **Nostr**: Relay configuration, auto-backup
4. **Storage**: Cache management, data export
5. **About**: Version, links

**Biometric Auth** (Material 3 BiometricPrompt):
```kotlin
val biometricPrompt = BiometricPrompt(
    activity,
    executor,
    object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: AuthenticationResult) {
            // Unlock identity access
        }
    }
)

val promptInfo = BiometricPrompt.PromptInfo.Builder()
    .setTitle("Unlock Imani Wallet")
    .setSubtitle("Authenticate to access your identities")
    .setNegativeButtonText("Cancel")
    .build()

biometricPrompt.authenticate(promptInfo)
```

---

## User Flows

### Flow 1: First-Time User (Happy Path)

```
1. Install app from Google Play
   ↓
2. Launch app → Splash screen (1s)
   ↓
3. Onboarding (3 screens, swipeable):
   - Screen 1: "Welcome to Imani Wallet"
   - Screen 2: "Self-custody. Your keys, your vouchers."
   - Screen 3: "Get Started" button
   ↓
4. Permission requests:
   - Notifications: "Get alerts when vouchers are redeemed"
   - Camera: "Scan QR codes to redeem vouchers"
   ↓
5. Lands on Identities tab (empty state)
   "No identities yet. Create your first identity."
   ↓
6. Taps FAB "+" → Navigate to Create Identity
   ↓
7. Enters label: "My Main Identity"
   ↓
8. Taps "Create" → Loading (500ms) → Shows mnemonic
   ↓
9. Copies mnemonic to password manager
   ↓
10. Checks "I have securely backed up..."
    ↓
11. Taps "Done" → Returns to Identities
    ✅ Snackbar: "Identity created successfully"
    ↓
12. Navigates to Vouchers tab (empty state)
    ↓
13. Taps FAB "+" → Navigate to Issue Voucher
    ↓
14. Fills form:
    - Amount: 1000
    - Memo: "Happy Birthday!"
    - Expiry: 90 days
    ↓
15. Taps "Continue" → Loading → Shows QR code
    ↓
16. Taps "Share" (Android Share Sheet) → Sends via WhatsApp
    ↓
17. Taps "Done" → Returns to Vouchers list
    ✅ Shows voucher card: "Happy Birthday! - 1000 sat - Issued"
```

**Time to First Voucher**: <3 minutes

---

### Flow 2: Redeem Voucher (Recipient)

```
1. Recipient receives WhatsApp message with link:
   "Redeem this voucher: https://wallet.imani.cash/redeem?token=cashuAbc..."
   ↓
2. Taps link → Opens in Imani Wallet (deep link)
   OR installs app first, then opens link
   ↓
3. If app not installed:
   - Opens Play Store → Install
   - Launch app → Deep link triggers redeem flow
   ↓
4. Redeem screen opens with token pre-filled
   ↓
5. Taps "Redeem" → Loading "Verifying voucher..."
   ↓
6. Bottom sheet appears:
   ┌─────────────────────────────────────────┐
   │ Redeem Voucher?                         │
   │                                         │
   │ Amount: 1000 sat                        │
   │ Memo: Happy Birthday!                   │
   │ From: npub1abc...xyz                    │
   │                                         │
   │ [Cancel]           [Redeem]             │
   └─────────────────────────────────────────┘
   ↓
7. Taps "Redeem" → Imports proofs to wallet
   ↓
8. Success dialog:
   "✅ Redeemed 1000 sat"
   "Happy Birthday!"
   ↓
9. Navigates to Vouchers tab
   Shows voucher in "Received" section
```

**Time to Redeem**: <30 seconds (after install)

---

### Flow 3: Scan QR Code to Redeem

```
1. User at physical location (e.g., gift card store)
   ↓
2. Opens Imani Wallet → Vouchers tab
   ↓
3. Taps "Scan" FAB → QR Scanner opens
   ↓
4. Grants camera permission (first time)
   ↓
5. Points camera at QR code on paper
   ↓
6. QR detected → Vibrates → Beep sound
   ↓
7. Bottom sheet: "Redeem 1000 sat voucher?"
   ↓
8. Taps "Redeem" → Success
   ↓
9. Returns to Vouchers list with new voucher
```

**Time to Scan & Redeem**: <10 seconds

---

## Android-Specific Features

### 1. Biometric Authentication

**Use Cases**:
- Unlock app on launch (if enabled)
- Confirm voucher issuance (for large amounts)
- Export identity mnemonic

**Implementation** (BiometricPrompt):
```kotlin
private fun authenticateUser(onSuccess: () -> Unit) {
    val biometricPrompt = BiometricPrompt(
        this,
        ContextCompat.getMainExecutor(this),
        object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: AuthenticationResult) {
                onSuccess()
            }
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                Toast.makeText(context, "Authentication error: $errString", LENGTH_SHORT).show()
            }
        }
    )

    val promptInfo = BiometricPrompt.PromptInfo.Builder()
        .setTitle("Unlock Imani Wallet")
        .setSubtitle("Authenticate to continue")
        .setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL)
        .build()

    biometricPrompt.authenticate(promptInfo)
}
```

---

### 2. QR Code Scanning (CameraX + ML Kit)

**Implementation**:
```kotlin
@Composable
fun QRScannerScreen(onQRDetected: (String) -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val cameraProviderFuture = remember { ProcessCameraProvider.getInstance(context) }

    AndroidView(
        factory = { ctx ->
            PreviewView(ctx).apply {
                implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            }
        },
        modifier = Modifier.fillMaxSize()
    ) { previewView ->
        val cameraProvider = cameraProviderFuture.get()
        val preview = Preview.Builder().build().apply {
            setSurfaceProvider(previewView.surfaceProvider)
        }

        val imageAnalyzer = ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
            .apply {
                setAnalyzer(
                    ContextCompat.getMainExecutor(context),
                    QRCodeAnalyzer { qrCode ->
                        onQRDetected(qrCode)
                    }
                )
            }

        val cameraSelector = CameraSelector.DEFAULT_BACK_CAMERA

        try {
            cameraProvider.unbindAll()
            cameraProvider.bindToLifecycle(
                lifecycleOwner,
                cameraSelector,
                preview,
                imageAnalyzer
            )
        } catch (e: Exception) {
            Log.e("CameraX", "Use case binding failed", e)
        }
    }
}
```

---

### 3. Android Share Sheet

**Share Voucher**:
```kotlin
fun shareVoucher(context: Context, token: String, amount: Long, memo: String?) {
    val shareText = buildString {
        append("Redeem this Imani Wallet voucher:\n\n")
        append("Amount: $amount sat\n")
        if (memo != null) {
            append("Memo: $memo\n\n")
        }
        append("Token: $token\n\n")
        append("Install Imani Wallet to redeem:\n")
        append("https://wallet.imani.cash/redeem?token=$token")
    }

    val sendIntent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_SUBJECT, "Imani Voucher - $amount sat")
        putExtra(Intent.EXTRA_TEXT, shareText)
    }

    val shareIntent = Intent.createChooser(sendIntent, "Share voucher via")
    context.startActivity(shareIntent)
}
```

---

### 4. Deep Linking

**AndroidManifest.xml**:
```xml
<activity android:name=".MainActivity">
    <intent-filter android:autoVerify="true">
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />

        <!-- HTTPS deep links -->
        <data android:scheme="https"
              android:host="wallet.imani.cash"
              android:pathPrefix="/redeem" />

        <!-- Custom scheme -->
        <data android:scheme="imani"
              android:host="voucher" />
    </intent-filter>
</activity>
```

**Handle Deep Link**:
```kotlin
override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    intent?.data?.let { uri ->
        when {
            uri.pathSegments.contains("redeem") -> {
                val token = uri.getQueryParameter("token")
                if (token != null) {
                    navController.navigate("vouchers/redeem?token=$token")
                }
            }
        }
    }
}
```

**Deep Link Examples**:
- `https://wallet.imani.cash/redeem?token=cashuAbc...`
- `imani://voucher/redeem?token=cashuAbc...`

---

### 5. Android Keystore Encryption

**Encrypt Private Keys**:
```kotlin
class AndroidIdentityManager(private val keystoreManager: KeystoreManager) {
    fun prepareForStorage(identity: Identity): Pair<Identity, ByteArray> {
        // Encrypt private key using Android Keystore
        val privateKeyBytes = identity.privateKey.hexToByteArray()
        val encryptedPrivateKey = keystoreManager.encryptPrivateKey(
            privateKeyBytes,
            "identity_${identity.id}"
        )

        // Return identity without private key + encrypted bytes
        return identity.copy(privateKey = "") to encryptedPrivateKey
    }

    fun decryptPrivateKey(identityId: String, encryptedPrivateKey: ByteArray): String {
        val decryptedBytes = keystoreManager.decryptPrivateKey(
            encryptedPrivateKey,
            "identity_$identityId"
        )
        return decryptedBytes.toHex()
    }
}
```

---

### 6. Notifications

**Voucher Redeemed Notification**:
```kotlin
fun showVoucherRedeemedNotification(amount: Long, memo: String?) {
    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_voucher)
        .setContentTitle("Voucher Redeemed")
        .setContentText("You redeemed $amount sat" + (memo?.let { ": $it" } ?: ""))
        .setPriority(NotificationCompat.PRIORITY_DEFAULT)
        .setAutoCancel(true)
        .setContentIntent(
            PendingIntent.getActivity(
                context,
                0,
                Intent(context, MainActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE
            )
        )
        .build()

    NotificationManagerCompat.from(context).notify(VOUCHER_NOTIFICATION_ID, notification)
}
```

---

## Component Library

### 1. **ImaniScaffold**

```kotlin
@Composable
fun ImaniScaffold(
    title: String,
    navigationIcon: @Composable (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
    floatingActionButton: @Composable () -> Unit = {},
    bottomBar: @Composable () -> Unit = {},
    content: @Composable (PaddingValues) -> Unit
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = navigationIcon,
                actions = actions,
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = ImaniColors.Surface,
                    titleContentColor = ImaniColors.OnSurface
                )
            )
        },
        floatingActionButton = floatingActionButton,
        bottomBar = bottomBar,
        content = content
    )
}
```

---

### 2. **VoucherCard**

```kotlin
@Composable
fun VoucherCard(
    voucher: StoredVoucher,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = voucher.memo ?: "Voucher ${voucher.voucherId.take(8)}",
                    style = MaterialTheme.typography.titleMedium
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "${voucher.faceValue} ${voucher.unit}",
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Bold
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "Issued ${voucher.issuedAt.format()}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            StatusBadge(status = voucher.status)
        }
    }
}
```

---

### 3. **StatusBadge**

```kotlin
@Composable
fun StatusBadge(status: VoucherStatus) {
    val (color, icon, text) = when (status) {
        VoucherStatus.ISSUED -> Triple(ImaniColors.Primary, Icons.Default.CheckCircle, "Issued")
        VoucherStatus.DELIVERED -> Triple(Color(0xFF06B6D4), Icons.Default.Send, "Delivered")
        VoucherStatus.REDEEMED -> Triple(ImaniColors.Success, Icons.Default.Check, "Redeemed")
        VoucherStatus.REVOKED -> Triple(ImaniColors.Error, Icons.Default.Cancel, "Revoked")
        VoucherStatus.EXPIRED -> Triple(Color.Gray, Icons.Default.Schedule, "Expired")
    }

    Surface(
        color = color.copy(alpha = 0.1f),
        shape = RoundedCornerShape(12.dp)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = color,
                modifier = Modifier.size(16.dp)
            )
            Spacer(Modifier.width(4.dp))
            Text(
                text = text,
                style = MaterialTheme.typography.labelSmall,
                color = color
            )
        }
    }
}
```

---

## Responsive Design

### Screen Size Breakpoints

| Class | Width (dp) | Layout Strategy |
|-------|-----------|-----------------|
| **Compact** | <600 | Phone portrait, single column |
| **Medium** | 600-839 | Phone landscape, tablet portrait, 2 columns |
| **Expanded** | ≥840 | Tablet landscape, foldable unfolded, 3 columns |

### Adaptive Layouts

**Identity List** (WindowSizeClass):
```kotlin
@Composable
fun IdentityListScreen() {
    val windowSizeClass = calculateWindowSizeClass(activity)

    when (windowSizeClass.widthSizeClass) {
        WindowWidthSizeClass.Compact -> {
            // Single column
            LazyColumn { ... }
        }
        WindowWidthSizeClass.Medium -> {
            // Two columns
            LazyVerticalGrid(columns = GridCells.Fixed(2)) { ... }
        }
        WindowWidthSizeClass.Expanded -> {
            // Navigation rail + content
            Row {
                NavigationRail { ... }
                LazyVerticalGrid(columns = GridCells.Fixed(3)) { ... }
            }
        }
    }
}
```

### Foldable Support

**Detect Fold**:
```kotlin
val windowLayoutInfo = rememberWindowLayoutInfo()
val displayFeatures = windowLayoutInfo.displayFeatures

val isFolded = displayFeatures.any {
    it is FoldingFeature && it.state == FoldingFeature.State.HALF_OPENED
}

if (isFolded) {
    // Two-pane layout
    TwoPane(
        first = { IdentityListPane() },
        second = { IdentityDetailsPane() }
    )
} else {
    // Standard layout
    IdentityListScreen()
}
```

---

## Accessibility

### TalkBack Support

**Content Descriptions**:
```kotlin
IconButton(
    onClick = { /* create identity */ },
    modifier = Modifier.semantics {
        contentDescription = "Create new identity"
        role = Role.Button
    }
) {
    Icon(Icons.Default.Add, contentDescription = null)
}
```

**Semantic Properties**:
```kotlin
VoucherCard(
    voucher = voucher,
    modifier = Modifier.semantics(mergeDescendants = true) {
        contentDescription = "${voucher.memo}, ${voucher.faceValue} sat, ${voucher.status}"
        role = Role.Button
    }
)
```

### Contrast & Touch Targets

- **Contrast Ratio**: ≥4.5:1 for text, ≥3:1 for UI components
- **Touch Targets**: Minimum 48x48dp for all interactive elements
- **Focus Indicators**: 2dp border with Primary color

### Dynamic Type

**Support Text Scaling**:
```kotlin
Text(
    text = "Voucher amount",
    style = MaterialTheme.typography.bodyLarge.copy(
        fontSize = MaterialTheme.typography.bodyLarge.fontSize * textScaleFactor
    )
)
```

---

## Performance Targets

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Cold Start** | <2s | App startup to first frame |
| **Warm Start** | <500ms | Resume from background |
| **Frame Rate** | 60fps | Janky frames <1% |
| **Identity Creation** | <1s | Key generation + storage |
| **Voucher Issuance** | <2s | Issue + backup to Nostr |
| **QR Scan** | <500ms | Detection to vibration |
| **Database Query** | <100ms | List 100 vouchers |
| **APK Size** | <15MB | Release APK |

---

## Related Documentation

- [Web Client UI Design](web-client-ui-design.md) - Web app design reference
- [cashu-client Integration Master Plan](cashu-client-integration-master-plan.md) - Implementation roadmap
- [Android Port Roadmap](android-port-roadmap.md) - Android-specific tasks
- [Reuse cashu-client on Android](../docs/how-to/reuse-cashu-client-on-android.md) - Technical integration guide

---

## Change Log

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2025-11-20 | Initial Android client UI/UX specification |
