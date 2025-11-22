# Imani Wallet - Web Marketplace UI Implementation Plan

> **Document Type**: How-To Guide (Diátaxis)
> **Purpose**: Phased implementation roadmap for web marketplace UI (v2.0.0 design)
> **Platform**: Web (Kotlin/JS + Compose Multiplatform)
> **Version**: 1.0.0
> **Created**: 2025-11-21
> **Related Documents**:
> - [Web Client UI/UX Design](web-client-ui-design.md) - Complete design specification
> - [Kotlin Voucher Client Roadmap](kotlin-voucher-client-roadmap.md) - Main project roadmap
> - [cashu-client Integration Master Plan](cashu-client-integration-master-plan.md) - Backend integration (100% complete)

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current State Assessment](#current-state-assessment)
3. [Implementation Strategy](#implementation-strategy)
4. [Phase 1: Navigation & Foundation](#phase-1-navigation--foundation)
5. [Phase 2: Shop Tab (Customer Features)](#phase-2-shop-tab-customer-features)
6. [Phase 3: Merchant Tab (Business Features)](#phase-3-merchant-tab-business-features)
7. [Phase 4: Enhanced Features](#phase-4-enhanced-features)
8. [Phase 5: Polish & Production](#phase-5-polish--production)
9. [Timeline & Resources](#timeline--resources)
10. [Success Metrics](#success-metrics)

---

## Executive Summary

### Mission

Transform Imani Wallet web client from a basic voucher app to a **complete merchant-customer marketplace** with dual-role support (any user can be both customer AND merchant).

### Scope

**What We're Building**:
- ✅ **Backend**: cashu-client integration (100% complete - Phase 1 & 2)
- 🔄 **Frontend**: New marketplace UI/UX (v2.0.0 design) - **THIS PLAN**

**Key Changes from Current Design**:
1. **Navigation**: Single identity list → Three tabs (Shop, Merchant, Settings)
2. **Business Model**: P2P vouchers → Merchant-customer marketplace + P2P
3. **Discovery**: Manual token entry → Nostr npub-based merchant discovery
4. **Payments**: Pre-funded → Lightning invoice payments (NUT-04)
5. **Roles**: Customer-only → Dual roles (customer + merchant in one app)

### Timeline

| Phase | Duration | Deliverables | Status |
|-------|----------|--------------|--------|
| **Phase 1** | 1 week | Navigation, component library, settings refactor | 📋 TODO |
| **Phase 2** | 2 weeks | Shop tab (customer features) | 📋 TODO |
| **Phase 3** | 2 weeks | Merchant tab (business features) | 📋 TODO |
| **Phase 4** | 1 week | P2P transfers, advanced features | 📋 TODO |
| **Phase 5** | 1 week | Polish, testing, deployment | 📋 TODO |

**Total Duration**: 7 weeks (~35 days)

---

## Current State Assessment

### ✅ What's Complete (Phases 0-3)

| Component | Status | Notes |
|-----------|--------|-------|
| **Identity Module** | ✅ 100% | Single identity, create/import, sign events |
| **Voucher Module** | ✅ 100% | Issue, redeem, Nostr storage, Lightning integration |
| **cashu-client Integration** | ✅ 100% | JVM + JS adapters, 31/31 tasks complete |
| **Basic UI** | ✅ 80% | Identity list, voucher list, issue/redeem screens |
| **Crypto** | ✅ 100% | Web Crypto API, secp256k1, Schnorr, NIP-44 |
| **Storage** | ✅ 100% | IndexedDB (vouchers), Nostr relays (backup) |
| **Lightning** | ✅ 100% | Invoice generation, payment checking (NUT-04) |
| **Offer Management** | ✅ 100% | Create offers, publish to Nostr (Phase 2 simplified) |
| **Sales Tracking** | ✅ 100% | GetSalesMetricsUseCase, aggregate by offer |

### 🔄 What Needs Work

| Component | Current State | Target State |
|-----------|---------------|--------------|
| **Navigation** | Single screen app | Bottom tabs (Shop, Merchant, Settings) |
| **Identity UI** | Multi-identity list | Single identity in Settings tab |
| **Voucher UI** | Simple list | Grouped by merchant, status badges |
| **Discovery** | None | Search by Nostr npub, scan QR |
| **Purchase Flow** | Token import only | Lightning invoice payment |
| **Merchant Dashboard** | None | Sales metrics, active offers, POS |
| **QR Codes** | Placeholder | Real QR generation + scanning |
| **Responsive Design** | Desktop-focused | Mobile/Tablet/Desktop breakpoints |

---

## Implementation Strategy

### Principles

1. **Incremental**: Build on existing code, don't rewrite from scratch
2. **Vertical Slices**: Each phase delivers working end-to-end features
3. **Mobile-First**: Design for mobile, enhance for desktop
4. **Code Reuse**: Maximize use of existing use cases and repositories
5. **Testing**: Write tests alongside features (not after)

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   NEW UI LAYER (This Plan)                   │
├─────────────────────────────────────────────────────────────┤
│  Navigation (Voyager)                                        │
│    ├── ShopTab (Customer Mode)                              │
│    ├── MerchantTab (Business Mode)                          │
│    └── SettingsTab                                          │
│                                                              │
│  Screens (Compose)                                          │
│    ├── MyVouchersScreen                                     │
│    ├── DiscoverMerchantsScreen                             │
│    ├── PurchaseVoucherScreen (Lightning)                   │
│    ├── SalesDashboardScreen                                │
│    ├── CreateOfferScreen                                   │
│    └── POSRedemptionScreen                                 │
│                                                              │
│  Components (Reusable)                                      │
│    ├── VoucherCard                                         │
│    ├── StatusBadge                                         │
│    ├── QRCodeDisplay                                       │
│    ├── LightningInvoiceDisplay                             │
│    └── MerchantProfileCard                                 │
├═════════════════════════════════════════════════════════════┤
│              EXISTING BACKEND (100% Complete)                │
├─────────────────────────────────────────────────────────────┤
│  Use Cases (Already Implemented)                            │
│    ├── CreateLightningInvoiceUseCase ✅                    │
│    ├── CheckInvoicePaidUseCase ✅                          │
│    ├── CreateOfferUseCase ✅                               │
│    ├── PublishOfferToNostrUseCase ✅                       │
│    ├── DiscoverMerchantOffersUseCase ✅                    │
│    ├── GetSalesMetricsUseCase ✅                           │
│    ├── IssueVoucherUseCase ✅                              │
│    └── RedeemVoucherUseCase ✅                             │
│                                                              │
│  Repositories (Already Implemented)                         │
│    ├── VoucherRepository (Nostr + IndexedDB) ✅            │
│    ├── IdentityRepository (localStorage) ✅               │
│    └── MintApiClient (NUT-04) ✅                           │
└─────────────────────────────────────────────────────────────┘
```

**Key Insight**: Backend is done. We only need to build the UI layer.

---

## Phase 1: Navigation & Foundation

**Goal**: Implement new navigation structure and reusable components

**Duration**: 1 week (5 days)

### Tasks

#### 1.1. Bottom Tab Navigation (2 days)

**Implement three-tab navigation using Voyager**

**Files to Create**:
```kotlin
// imani-app/src/commonMain/kotlin/cash/imani/app/navigation/BottomNavigation.kt
@Composable
fun BottomNavigation(
    selectedTab: AppTab,
    onTabSelected: (AppTab) -> Unit
) {
    NavigationBar {
        AppTab.values().forEach { tab ->
            NavigationBarItem(
                selected = selectedTab == tab,
                onClick = { onTabSelected(tab) },
                icon = { Icon(tab.icon, contentDescription = tab.label) },
                label = { Text(tab.label) }
            )
        }
    }
}

enum class AppTab(val label: String, val icon: ImageVector) {
    SHOP("Shop", Icons.Default.ShoppingCart),
    MERCHANT("Merchant", Icons.Default.Business),
    SETTINGS("Settings", Icons.Default.Settings)
}

// imani-app/src/commonMain/kotlin/cash/imani/app/navigation/MainScreen.kt
@Composable
fun MainScreen() {
    var selectedTab by remember { mutableStateOf(AppTab.SHOP) }

    Scaffold(
        bottomBar = {
            BottomNavigation(
                selectedTab = selectedTab,
                onTabSelected = { selectedTab = it }
            )
        }
    ) { padding ->
        when (selectedTab) {
            AppTab.SHOP -> ShopTabScreen(Modifier.padding(padding))
            AppTab.MERCHANT -> MerchantTabScreen(Modifier.padding(padding))
            AppTab.SETTINGS -> SettingsTabScreen(Modifier.padding(padding))
        }
    }
}
```

**Acceptance Criteria**:
- ✅ Bottom navigation visible on mobile (<640px)
- ✅ Side navigation rail on tablet/desktop (>640px)
- ✅ Tab state persists on navigation
- ✅ Deep linking works (e.g., `/shop/merchants/npub123`)

**Effort**: 2 days

---

#### 1.2. Component Library (2 days)

**Create reusable components from design spec**

**Components to Build**:

1. **VoucherCard** (from design spec lines 1103-1196)
   ```kotlin
   @Composable
   fun VoucherCard(
       merchantName: String,
       merchantLogo: String? = null,
       voucherName: String,
       balance: Int,
       originalAmount: Int,
       expiresAt: Long,
       status: VoucherStatus,
       onClick: () -> Unit
   )
   ```

2. **StatusBadge** (lines 1200-1256)
   ```kotlin
   @Composable
   fun StatusBadge(status: VoucherStatus)

   enum class VoucherStatus {
       ACTIVE, EXPIRING_SOON, EXPIRED, REDEEMED
   }
   ```

3. **QRCodeDisplay** (lines 1260-1320)
   ```kotlin
   @Composable
   fun QRCodeDisplay(
       data: String,
       size: Dp = 250.dp,
       label: String? = null
   )
   ```

4. **LightningInvoiceDisplay** (lines 1324-1442)
   ```kotlin
   @Composable
   fun LightningInvoiceDisplay(
       invoice: String,
       amount: Int,
       onPaymentReceived: () -> Unit
   )
   ```

5. **MerchantProfileCard** (lines 1446-1544)
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
   )
   ```

**File Structure**:
```
imani-app/src/commonMain/kotlin/cash/imani/app/ui/components/
├── VoucherCard.kt
├── StatusBadge.kt
├── QRCodeDisplay.kt
├── LightningInvoiceDisplay.kt
└── MerchantProfileCard.kt
```

**QR Code Implementation**:
```kotlin
// Use kotlinx-qrcode or qrcode.js via JS interop
// imani-app/src/jsMain/kotlin/cash/imani/app/ui/components/QRCodeDisplay.js.kt
@Composable
actual fun QRCodeDisplay(data: String, size: Dp, label: String?) {
    var qrCodeDataUrl by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(data) {
        val QRCode = js("require('qrcode')")
        QRCode.toDataURL(data) { error, url ->
            if (error == null) qrCodeDataUrl = url as String
        }
    }

    qrCodeDataUrl?.let { url ->
        Image(
            painter = rememberImagePainter(url),
            contentDescription = "QR Code",
            modifier = Modifier.size(size)
        )
    }
}
```

**Acceptance Criteria**:
- ✅ All 5 components render correctly
- ✅ QR codes generate from strings (voucher tokens, npubs)
- ✅ Status badges show correct colors (green/orange/red/gray)
- ✅ Components match design spec pixel-perfectly
- ✅ Responsive (adapt to mobile/tablet/desktop)

**Effort**: 2 days

---

#### 1.3. Settings Tab Refactor (1 day)

**Convert multi-identity UI to single-identity settings**

**Current**:
```
┌─────────────────────────┐
│  Identities              │
├─────────────────────────┤
│  [Identity 1]            │
│  [Identity 2]            │
│  [+ Create]  [Import]    │
└─────────────────────────┘
```

**New** (from design spec lines 850-905):
```
┌─────────────────────────────────────┐
│  ⚙️ Settings                         │
├─────────────────────────────────────┤
│  Identity (Single Account)          │
│  ┌──────────────────────────────┐  │
│  │ 👤 My Identity                │  │
│  │ npub1abc...xyz  [Copy npub]  │  │
│  │ [View Private Key (nsec)]    │  │
│  └──────────────────────────────┘  │
│  [Logout]                           │
│                                     │
│  Payment                            │
│  ┌──────────────────────────────┐  │
│  │ ⚡ Lightning Wallet           │  │
│  │ Connected: Alby  [Change]    │  │
│  └──────────────────────────────┘  │
│                                     │
│  Backup & Security                  │
│  [Backup Now] [Restore]            │
└─────────────────────────────────────┘
```

**Changes**:
1. Remove identity list screen
2. Move to Settings tab
3. Show only active identity (npub/nsec)
4. Add Lightning wallet integration placeholder
5. Add Backup/Restore buttons (reuse existing functionality)

**Files to Modify**:
- `imani-app/src/commonMain/kotlin/cash/imani/app/ui/settings/SettingsScreen.kt` (refactor)

**Acceptance Criteria**:
- ✅ Settings tab shows single identity
- ✅ Copy npub button works
- ✅ View nsec shows private key with warning
- ✅ Logout clears identity from storage
- ✅ Backup/Restore buttons functional

**Effort**: 1 day

---

### Phase 1 Deliverables

- ✅ Bottom tab navigation (Shop, Merchant, Settings)
- ✅ Component library (5 reusable components)
- ✅ Settings tab (single identity model)
- ✅ Navigation tests (tab switching, deep linking)
- ✅ Component tests (visual regression, interaction)

**Total Effort**: 5 days (1 week)

---

## Phase 2: Shop Tab (Customer Features)

**Goal**: Build complete customer experience (discover, purchase, redeem)

**Duration**: 2 weeks (10 days)

### Tasks

#### 2.1. My Vouchers Screen (2 days)

**Implement voucher list with merchant grouping**

**Design Spec**: Lines 257-308

**Features**:
- Group vouchers by merchant
- Show balance (70/100 sat)
- Show expiry with status badge
- Sort by expiry (default), merchant, balance
- Empty state with "Discover Merchants" CTA

**Implementation**:
```kotlin
// imani-app/src/commonMain/kotlin/cash/imani/app/ui/shop/MyVouchersScreen.kt
@Composable
fun MyVouchersScreen(
    viewModel: VoucherViewModel,
    onDiscoverClick: () -> Unit,
    onVoucherClick: (StoredVoucher) -> Unit
) {
    val vouchers by viewModel.vouchers.collectAsState()
    val sortBy by viewModel.sortBy.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("My Vouchers") },
                actions = {
                    IconButton(onClick = onDiscoverClick) {
                        Icon(Icons.Default.Add, "Add Merchant")
                    }
                    SortMenu(
                        currentSort = sortBy,
                        onSortChange = { viewModel.setSortBy(it) }
                    )
                }
            )
        }
    ) { padding ->
        when {
            vouchers.isEmpty() -> EmptyVouchersState(onDiscoverClick)
            else -> VoucherList(
                vouchers = vouchers.groupByMerchant(),
                onVoucherClick = onVoucherClick
            )
        }
    }
}

fun List<StoredVoucher>.groupByMerchant(): Map<String, List<StoredVoucher>> {
    return groupBy { it.issuerId } // Merchant npub
}
```

**VoucherCard Integration**:
- Use `VoucherCard` component from Phase 1.2
- Map `StoredVoucher` to component props
- Calculate status: ACTIVE (<7 days left), EXPIRING_SOON (7-1 days), EXPIRED (past), REDEEMED

**Acceptance Criteria**:
- ✅ Vouchers grouped by merchant
- ✅ Status badges correct (green/orange/red/gray)
- ✅ Sort options work (expiry, merchant, balance)
- ✅ Empty state shows CTA
- ✅ Tap voucher → Voucher Details Screen

**Effort**: 2 days

---

#### 2.2. Discover Merchants Screen (2 days)

**Implement Nostr npub search and merchant discovery**

**Design Spec**: Lines 311-354

**Features**:
- Text input for Nostr npub (npub1...)
- QR code scanner button
- Validate npub format
- Query Nostr for merchant profile
- Show recent merchants (localStorage)

**Implementation**:
```kotlin
// imani-app/src/commonMain/kotlin/cash/imani/app/ui/shop/DiscoverMerchantsScreen.kt
@Composable
fun DiscoverMerchantsScreen(
    viewModel: MerchantDiscoveryViewModel,
    onMerchantFound: (String) -> Unit, // Navigate to merchant detail
    onBack: () -> Unit
) {
    var npubInput by remember { mutableStateOf("") }
    val recentMerchants by viewModel.recentMerchants.collectAsState()
    val searchState by viewModel.searchState.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Discover Merchants") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                    }
                }
            )
        }
    ) { padding ->
        Column(Modifier.padding(padding).padding(16.dp)) {
            Text("Find a merchant by their Nostr public key")

            Spacer(Modifier.height(16.dp))

            Row {
                OutlinedTextField(
                    value = npubInput,
                    onValueChange = { npubInput = it },
                    label = { Text("npub1...") },
                    modifier = Modifier.weight(1f),
                    isError = searchState is SearchState.Error
                )

                IconButton(onClick = { /* TODO: Open camera QR scanner */ }) {
                    Icon(Icons.Default.QrCodeScanner, "Scan QR")
                }
            }

            Button(
                onClick = { viewModel.searchMerchant(npubInput) },
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("Search")
            }

            when (val state = searchState) {
                is SearchState.Loading -> CircularProgressIndicator()
                is SearchState.Success -> {
                    LaunchedEffect(state.npub) {
                        onMerchantFound(state.npub)
                    }
                }
                is SearchState.Error -> Text(state.message, color = Color.Red)
                else -> {}
            }

            Spacer(Modifier.height(24.dp))

            Text("Recent Merchants", style = MaterialTheme.typography.titleMedium)

            recentMerchants.forEach { merchant ->
                MerchantProfileCard(
                    name = merchant.name,
                    description = merchant.description,
                    npub = merchant.npub,
                    onViewProfile = { onMerchantFound(merchant.npub) }
                )
            }
        }
    }
}
```

**Npub Validation**:
```kotlin
fun validateNpub(input: String): Result<String> {
    if (!input.startsWith("npub1")) {
        return Result.failure(Exception("Invalid npub format (must start with npub1)"))
    }
    // Decode bech32
    val decoded = Bech32.decode(input)
    if (decoded.data.size != 32) {
        return Result.failure(Exception("Invalid npub length"))
    }
    return Result.success(input)
}
```

**Acceptance Criteria**:
- ✅ Npub validation works
- ✅ Search queries Nostr for merchant profile
- ✅ Recent merchants list persists (localStorage)
- ✅ QR scanner opens camera (placeholder in Phase 2, real in Phase 4)
- ✅ Invalid npub shows error message

**Effort**: 2 days

---

#### 2.3. Merchant Detail Screen (2 days)

**Show merchant profile and available voucher offers**

**Design Spec**: Lines 357-416

**Features**:
- Merchant profile (name, logo, description, npub)
- List of active offers (from Nostr)
- [Buy for X sat] buttons
- Copy npub, show QR, favorite merchant

**Implementation**:
```kotlin
// imani-app/src/commonMain/kotlin/cash/imani/app/ui/shop/MerchantDetailScreen.kt
@Composable
fun MerchantDetailScreen(
    merchantNpub: String,
    viewModel: MerchantDetailViewModel,
    onPurchaseOffer: (String) -> Unit, // Navigate to purchase screen
    onBack: () -> Unit
) {
    val merchantProfile by viewModel.merchantProfile.collectAsState()
    val offers by viewModel.offers.collectAsState()

    LaunchedEffect(merchantNpub) {
        viewModel.loadMerchant(merchantNpub)
        viewModel.loadOffers(merchantNpub)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(merchantProfile?.name ?: "Merchant") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                    }
                }
            )
        }
    ) { padding ->
        LazyColumn(Modifier.padding(padding)) {
            item {
                MerchantHeader(
                    profile = merchantProfile,
                    onCopyNpub = { copyToClipboard(merchantNpub) },
                    onShowQR = { /* Show QR dialog */ },
                    onFavorite = { viewModel.toggleFavorite() }
                )
            }

            item {
                Text(
                    "Available Vouchers (${offers.size})",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(16.dp)
                )
            }

            items(offers) { offer ->
                OfferCard(
                    offer = offer,
                    onBuyClick = { onPurchaseOffer(offer.offerId) }
                )
            }
        }
    }
}

@Composable
fun OfferCard(
    offer: MerchantOffer,
    onBuyClick: () -> Unit
) {
    Card(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        Column(Modifier.padding(16.dp)) {
            Text(offer.name, style = MaterialTheme.typography.titleMedium)
            Text("${offer.price} sat • Valid ${offer.validityDays} days")
            Text(offer.description, style = MaterialTheme.typography.bodySmall)

            Spacer(Modifier.height(8.dp))

            Button(
                onClick = onBuyClick,
                modifier = Modifier.align(Alignment.End)
            ) {
                Text("Buy for ${offer.price}")
            }
        }
    }
}
```

**Use Cases**:
- Reuse `DiscoverMerchantOffersUseCase` (already implemented)
- Query Nostr for merchant profile (NIP-01 kind 0 event)
- Filter offers by status (ACTIVE only)

**Acceptance Criteria**:
- ✅ Merchant profile loads from Nostr
- ✅ Offers list shows active offers only
- ✅ [Buy] button navigates to purchase screen
- ✅ Copy npub, QR, favorite actions work
- ✅ Empty state if no offers

**Effort**: 2 days

---

#### 2.4. Purchase Voucher Screen (Lightning Payment) (3 days)

**Implement Lightning invoice payment flow**

**Design Spec**: Lines 419-517

**Features**:
- Confirm purchase details
- Generate Lightning invoice
- Display QR code + invoice string
- Poll for payment confirmation
- Success screen with voucher

**Implementation**:
```kotlin
// imani-app/src/commonMain/kotlin/cash/imani/app/ui/shop/PurchaseVoucherScreen.kt
@Composable
fun PurchaseVoucherScreen(
    offerId: String,
    viewModel: PurchaseViewModel,
    onSuccess: () -> Unit,
    onCancel: () -> Unit
) {
    val purchaseState by viewModel.purchaseState.collectAsState()

    LaunchedEffect(offerId) {
        viewModel.loadOffer(offerId)
    }

    when (val state = purchaseState) {
        is PurchaseState.Confirm -> {
            ConfirmPurchaseView(
                offer = state.offer,
                onConfirm = { viewModel.generateInvoice() },
                onCancel = onCancel
            )
        }
        is PurchaseState.PaymentPending -> {
            LightningInvoiceDisplay(
                invoice = state.invoice.paymentRequest,
                amount = state.invoice.amount,
                onPaymentReceived = { viewModel.handlePaymentConfirmed() }
            )
        }
        is PurchaseState.Success -> {
            PurchaseSuccessView(
                voucher = state.voucher,
                onDone = onSuccess
            )
        }
        is PurchaseState.Error -> {
            ErrorView(state.message, onRetry = { viewModel.retry() })
        }
    }
}
```

**Flow**:
1. User taps [Buy for X sat]
2. Confirm purchase screen → [Confirm Purchase]
3. `CreateLightningInvoiceUseCase(amount, mintUrl)` → Generate invoice
4. Display QR code + invoice string
5. `CheckInvoicePaidUseCase(quoteId, mintUrl)` → Poll for payment (2s interval)
6. Payment confirmed → Mint Cashu tokens → Issue voucher
7. Success screen → Voucher added to wallet

**Use Cases** (already implemented):
- `CreateLightningInvoiceUseCase` ✅
- `CheckInvoicePaidUseCase` ✅
- `IssueVoucherUseCase` ✅

**Acceptance Criteria**:
- ✅ Invoice generated correctly (NUT-04)
- ✅ QR code displays invoice
- ✅ Payment polling works (stops when paid or expired)
- ✅ Voucher added to wallet on success
- ✅ Error handling (expired, failed, offline)

**Effort**: 3 days

---

#### 2.5. Redeem Voucher Screen (1 day)

**Show voucher QR code for merchant to scan**

**Design Spec**: Lines 520-587

**Features**:
- Display voucher QR code (Cashu token)
- Show voucher details (balance, expiry)
- Manual redemption amount input
- Wait for merchant to scan

**Implementation**:
```kotlin
// imani-app/src/commonMain/kotlin/cash/imani/app/ui/shop/RedeemVoucherScreen.kt
@Composable
fun RedeemVoucherScreen(
    voucherId: String,
    viewModel: VoucherViewModel,
    onRedeemed: () -> Unit,
    onBack: () -> Unit
) {
    val voucher by viewModel.getVoucher(voucherId).collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Redeem Voucher") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                    }
                }
            )
        }
    ) { padding ->
        Column(
            Modifier.padding(padding).padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text("Show this to the merchant:")

            Spacer(Modifier.height(16.dp))

            // Display QR code with Cashu token
            voucher?.token?.let { token ->
                QRCodeDisplay(
                    data = token,
                    size = 250.dp,
                    label = "Cashu Token"
                )
            }

            Spacer(Modifier.height(16.dp))

            // Voucher details
            VoucherCard(
                merchantName = voucher?.merchantName ?: "",
                voucherName = voucher?.memo ?: "",
                balance = voucher?.balance ?: 0,
                originalAmount = voucher?.faceValue?.toInt() ?: 0,
                expiresAt = voucher?.expiresAt ?: 0,
                status = VoucherStatus.ACTIVE,
                onClick = {}
            )

            Text("⏳ Waiting for merchant to scan...")
        }
    }
}
```

**Acceptance Criteria**:
- ✅ QR code displays Cashu token
- ✅ Voucher details shown
- ✅ Token copyable
- ✅ Redemption updates wallet in real-time

**Effort**: 1 day

---

### Phase 2 Deliverables

- ✅ My Vouchers screen (grouped, sorted, status badges)
- ✅ Discover Merchants screen (npub search, recent)
- ✅ Merchant Detail screen (profile, offers)
- ✅ Purchase Voucher screen (Lightning payment flow)
- ✅ Redeem Voucher screen (show QR)
- ✅ Complete customer journey tests

**Total Effort**: 10 days (2 weeks)

---

## Phase 3: Merchant Tab (Business Features)

**Goal**: Build merchant dashboard, offer management, and POS

**Duration**: 2 weeks (10 days)

### Tasks

#### 3.1. Sales Dashboard Screen (2 days)

**Merchant homepage with sales metrics and active offers**

**Design Spec**: Lines 590-649

**Features**:
- Merchant profile header (name, npub, QR)
- Today's sales metrics (vouchers sold, revenue, redemptions)
- Active offers list
- [Scan Voucher to Redeem] POS button
- Recent redemptions feed

**Implementation**:
```kotlin
// imani-app/src/commonMain/kotlin/cash/imani/app/ui/merchant/SalesDashboardScreen.kt
@Composable
fun SalesDashboardScreen(
    viewModel: MerchantDashboardViewModel,
    onEditProfile: () -> Unit,
    onCreateOffer: () -> Unit,
    onEditOffer: (String) -> Unit,
    onPOSRedeem: () -> Unit
) {
    val merchantProfile by viewModel.merchantProfile.collectAsState()
    val todayMetrics by viewModel.todayMetrics.collectAsState()
    val activeOffers by viewModel.activeOffers.collectAsState()
    val recentRedemptions by viewModel.recentRedemptions.collectAsState()

    LaunchedEffect(Unit) {
        viewModel.loadDashboard()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Merchant Dashboard") },
                actions = {
                    IconButton(onClick = onEditProfile) {
                        Icon(Icons.Default.Edit, "Edit Profile")
                    }
                }
            )
        }
    ) { padding ->
        LazyColumn(Modifier.padding(padding)) {
            item {
                MerchantProfileHeader(
                    profile = merchantProfile,
                    onCopyNpub = { /* Copy */ },
                    onShowQR = { /* Show QR */ }
                )
            }

            item {
                SalesMetricsCard(metrics = todayMetrics)
            }

            item {
                Row(
                    Modifier.fillMaxWidth().padding(16.dp),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text("Active Offers (${activeOffers.size})")
                    Button(onClick = onCreateOffer) {
                        Text("+ Create Offer")
                    }
                }
            }

            items(activeOffers) { offer ->
                ActiveOfferCard(
                    offer = offer,
                    onEdit = { onEditOffer(offer.offerId) }
                )
            }

            item {
                Button(
                    onClick = onPOSRedeem,
                    modifier = Modifier.fillMaxWidth().padding(16.dp).height(56.dp)
                ) {
                    Icon(Icons.Default.QrCodeScanner, null)
                    Spacer(Modifier.width(8.dp))
                    Text("Scan Voucher to Redeem (POS)")
                }
            }

            item {
                Text(
                    "Recent Redemptions",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(16.dp)
                )
            }

            items(recentRedemptions) { redemption ->
                RedemptionListItem(redemption)
            }
        }
    }
}

@Composable
fun SalesMetricsCard(metrics: SalesMetrics) {
    Card(Modifier.fillMaxWidth().padding(16.dp)) {
        Row(Modifier.padding(16.dp)) {
            MetricBox("${metrics.totalVouchersIssued} vouchers\nsold", Modifier.weight(1f))
            MetricBox("${metrics.totalRevenue} sat\nrevenue", Modifier.weight(1f))
            MetricBox("${metrics.totalVouchersRedeemed} redeemed\ntoday", Modifier.weight(1f))
        }
    }
}
```

**Use Cases**:
- Reuse `GetSalesMetricsUseCase(startDate, endDate)` ✅
- Query vouchers issued/redeemed today
- Calculate outstanding balance

**Acceptance Criteria**:
- ✅ Sales metrics accurate (today's data)
- ✅ Active offers list populated
- ✅ Recent redemptions in real-time
- ✅ QR code shows merchant npub

**Effort**: 2 days

---

#### 3.2. Edit Merchant Profile Screen (1 day) - ✅ COMPLETE

**Allow merchant to edit business name, description, logo**

**Status**: ✅ COMPLETE (2025-11-22)
**Commits**:
- `32d360d` - Infrastructure (repository, use case, DI)
- `41a7270` - Navigation wiring (Merchant tab)

**Design Spec**: Lines 807-846

**Features**:
- Upload logo (image picker) - TODO: Phase 3.2+
- Edit business name (1-100 chars) ✅
- Edit description (1-500 chars) ✅
- Contact info (email, phone, website) ✅
- Nostr npub (read-only) ✅

**Implementation**:
```kotlin
// imani-app/src/commonMain/kotlin/cash/imani/app/ui/merchant/EditProfileScreen.kt
@Composable
fun EditMerchantProfileScreen(
    viewModel: MerchantProfileViewModel,
    onSaved: () -> Unit,
    onBack: () -> Unit
) {
    var businessName by remember { mutableStateOf(viewModel.profile.businessName) }
    var description by remember { mutableStateOf(viewModel.profile.description) }
    var email by remember { mutableStateOf(viewModel.profile.contactEmail ?: "") }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Edit Merchant Profile") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                    }
                }
            )
        }
    ) { padding ->
        Column(Modifier.padding(padding).padding(16.dp)) {
            OutlinedTextField(
                value = businessName,
                onValueChange = { businessName = it },
                label = { Text("Business Name") },
                modifier = Modifier.fillMaxWidth()
            )

            OutlinedTextField(
                value = description,
                onValueChange = { description = it },
                label = { Text("Description") },
                modifier = Modifier.fillMaxWidth(),
                minLines = 3
            )

            OutlinedTextField(
                value = email,
                onValueChange = { email = it },
                label = { Text("Email (optional)") },
                modifier = Modifier.fillMaxWidth()
            )

            Spacer(Modifier.weight(1f))

            Button(
                onClick = {
                    viewModel.updateProfile(businessName, description, email)
                    onSaved()
                },
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("Save Changes")
            }
        }
    }
}
```

**Acceptance Criteria**:
- ✅ Fields validate (name 1-100, desc 1-500)
- ✅ Profile saved to Nostr (NIP-01 kind 0 event)
- ✅ Logo upload works (optional)

**Effort**: 1 day

---

#### 3.3. Create Voucher Offer Screen (2 days) - ✅ COMPLETE

**Merchant creates new voucher offer template**

**Status**: ✅ COMPLETE (2025-11-22)
**Commits**:
- Infrastructure already existed (CreateOfferScreen, CreateOfferViewModel, use cases)
- `6287189` - Navigation wiring (Merchant tab)

**Design Spec**: Lines 652-714

**Features**:
- Voucher name (required) ✅
- Description (optional) ✅
- Price in sats (required, >0) ✅
- Validity period (7/30/90 days or custom) ✅
- Partial redemption checkbox ✅
- Preview card ✅

**Implementation**:
```kotlin
// imani-app/src/commonMain/kotlin/cash/imani/app/ui/merchant/CreateOfferScreen.kt
@Composable
fun CreateOfferScreen(
    viewModel: OfferViewModel,
    onCreated: () -> Unit,
    onCancel: () -> Unit
) {
    var voucherName by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var price by remember { mutableStateOf("") }
    var validityDays by remember { mutableStateOf(30) }
    var allowPartialRedemption by remember { mutableStateOf(true) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Create Voucher Offer") },
                navigationIcon = {
                    IconButton(onClick = onCancel) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                    }
                }
            )
        }
    ) { padding ->
        Column(Modifier.padding(padding).padding(16.dp)) {
            OutlinedTextField(
                value = voucherName,
                onValueChange = { voucherName = it },
                label = { Text("Voucher Name") },
                modifier = Modifier.fillMaxWidth()
            )

            OutlinedTextField(
                value = description,
                onValueChange = { description = it },
                label = { Text("Description (optional)") },
                modifier = Modifier.fillMaxWidth(),
                minLines = 2
            )

            OutlinedTextField(
                value = price,
                onValueChange = { price = it.filter { c -> c.isDigit() } },
                label = { Text("Price (sat)") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth()
            )

            Text("Validity Period")
            Row {
                listOf(7, 30, 90).forEach { days ->
                    FilterChip(
                        selected = validityDays == days,
                        onClick = { validityDays = days },
                        label = { Text("$days days") }
                    )
                }
            }

            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(
                    checked = allowPartialRedemption,
                    onCheckedChange = { allowPartialRedemption = it }
                )
                Text("Allow partial redemption")
            }

            Spacer(Modifier.height(16.dp))

            Text("Preview", style = MaterialTheme.typography.titleMedium)
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    Text(voucherName.ifBlank { "Voucher Name" })
                    Text("${price.ifBlank { "0" }} sat • Valid $validityDays days")
                    Text(description.ifBlank { "Description" })
                }
            }

            Spacer(Modifier.weight(1f))

            Button(
                onClick = {
                    viewModel.createOffer(
                        name = voucherName,
                        description = description,
                        price = price.toIntOrNull() ?: 0,
                        validityDays = validityDays,
                        allowPartialRedemption = allowPartialRedemption
                    )
                    onCreated()
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = voucherName.isNotBlank() && price.toIntOrNull() ?: 0 > 0
            ) {
                Text("Create Offer")
            }
        }
    }
}
```

**Use Cases**:
- Reuse `CreateOfferUseCase` ✅
- Reuse `PublishOfferToNostrUseCase` ✅

**Acceptance Criteria**:
- ✅ Validation works (price >0, name not empty)
- ✅ Offer published to Nostr (NIP-33)
- ✅ Preview updates in real-time

**Effort**: 2 days

---

#### 3.4. POS Redemption Screen (3 days) - ✅ COMPLETE

**Merchant scans customer QR code and redeems voucher**

**Status**: ✅ COMPLETE (2025-11-22)
**Commits**:
- Infrastructure already existed (POSRedemptionScreen, POSViewModel, RedeemVoucherUseCase)
- `09a844b` - Navigation wiring (Merchant tab)

**Design Spec**: Lines 717-804

**Features**:
- Camera QR scanner - TODO: Phase 3.4+ (manual entry working)
- Manual token entry ✅
- Show voucher details ✅
- Enter redemption amount ✅
- Quick fill buttons (10, 25, 50, Full) ✅
- Confirm redemption ✅

**Implementation**:
```kotlin
// imani-app/src/commonMain/kotlin/cash/imani/app/ui/merchant/POSRedemptionScreen.kt
@Composable
fun POSRedemptionScreen(
    viewModel: POSViewModel,
    onRedeemed: () -> Unit,
    onBack: () -> Unit
) {
    val redemptionState by viewModel.redemptionState.collectAsState()

    when (val state = redemptionState) {
        is RedemptionState.Scanning -> {
            QRScannerView(
                onQRScanned = { token -> viewModel.decodeVoucher(token) },
                onManualEntry = { token -> viewModel.decodeVoucher(token) },
                onBack = onBack
            )
        }
        is RedemptionState.VoucherLoaded -> {
            ConfirmRedemptionView(
                voucher = state.voucher,
                onConfirm = { amount -> viewModel.redeemVoucher(amount) },
                onCancel = { viewModel.resetToScanning() }
            )
        }
        is RedemptionState.Success -> {
            RedemptionSuccessView(
                amountRedeemed = state.amount,
                remainingBalance = state.remainingBalance,
                onScanAnother = { viewModel.resetToScanning() },
                onDone = onRedeemed
            )
        }
        is RedemptionState.Error -> {
            ErrorView(state.message, onRetry = { viewModel.resetToScanning() })
        }
    }
}

@Composable
fun ConfirmRedemptionView(
    voucher: StoredVoucher,
    onConfirm: (Int) -> Unit,
    onCancel: () -> Unit
) {
    var amount by remember { mutableStateOf("") }
    val maxAmount = voucher.balance

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Confirm Redemption") },
                navigationIcon = {
                    IconButton(onClick = onCancel) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                    }
                }
            )
        }
    ) { padding ->
        Column(Modifier.padding(padding).padding(16.dp)) {
            VoucherCard(/* voucher details */)

            Spacer(Modifier.height(16.dp))

            OutlinedTextField(
                value = amount,
                onValueChange = { amount = it.filter { c -> c.isDigit() } },
                label = { Text("Amount (sat)") },
                suffix = { Text("(max $maxAmount sat)") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth()
            )

            Row {
                listOf(10, 25, 50, maxAmount).forEach { preset ->
                    FilterChip(
                        selected = amount == preset.toString(),
                        onClick = { amount = preset.toString() },
                        label = { Text(if (preset == maxAmount) "Full" else "$preset") }
                    )
                }
            }

            Spacer(Modifier.weight(1f))

            Button(
                onClick = { onConfirm(amount.toIntOrNull() ?: 0) },
                modifier = Modifier.fillMaxWidth(),
                enabled = (amount.toIntOrNull() ?: 0) in 1..maxAmount
            ) {
                Text("Confirm Redeem")
            }
        }
    }
}
```

**QR Scanner** (Phase 3 implementation):
```kotlin
// Use HTML5 getUserMedia API via JS interop
// Or use a library like zxing-kotlin
@Composable
actual fun QRScannerView(
    onQRScanned: (String) -> Unit,
    onManualEntry: (String) -> Unit,
    onBack: () -> Unit
) {
    // TODO: Implement camera access and QR detection
    // For Phase 3: Use jsQR library or zxing
}
```

**Use Cases**:
- Reuse `RedeemVoucherUseCase` ✅
- Decode Cashu token
- Check proof states
- Update voucher balance

**Acceptance Criteria**:
- ✅ QR scanner detects voucher tokens
- ✅ Manual entry works
- ✅ Redemption amount validates (≤ balance)
- ✅ Voucher balance updates correctly
- ✅ Partial redemption works

**Effort**: 3 days

---

#### 3.5. Sales Reports Screen (2 days)

**Show sales metrics by day/week/month**

**Features**:
- Daily, weekly, monthly tabs
- Chart visualization (vouchers sold, revenue)
- Export to CSV
- Filter by offer

**Implementation**:
```kotlin
// imani-app/src/commonMain/kotlin/cash/imani/app/ui/merchant/SalesReportsScreen.kt
@Composable
fun SalesReportsScreen(
    viewModel: SalesReportsViewModel,
    onBack: () -> Unit
) {
    var period by remember { mutableStateOf(ReportPeriod.DAILY) }
    val metrics by viewModel.getMetrics(period).collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Sales Reports") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                    }
                },
                actions = {
                    IconButton(onClick = { viewModel.exportCSV() }) {
                        Icon(Icons.Default.Download, "Export")
                    }
                }
            )
        }
    ) { padding ->
        Column(Modifier.padding(padding)) {
            TabRow(selectedTabIndex = period.ordinal) {
                ReportPeriod.values().forEach { p ->
                    Tab(
                        selected = period == p,
                        onClick = { period = p },
                        text = { Text(p.label) }
                    )
                }
            }

            SalesChart(metrics = metrics)

            SalesMetricsList(metrics = metrics)
        }
    }
}

enum class ReportPeriod(val label: String) {
    DAILY("Daily"),
    WEEKLY("Weekly"),
    MONTHLY("Monthly")
}
```

**Use Cases**:
- Reuse `GetSalesMetricsUseCase(startDate, endDate)` ✅
- Calculate aggregates for periods

**Acceptance Criteria**:
- ✅ Metrics calculated correctly for each period
- ✅ Chart shows trends
- ✅ CSV export works

**Effort**: 2 days

---

### Phase 3 Deliverables

- ✅ Sales Dashboard (metrics, offers, recent redemptions)
- ✅ Edit Merchant Profile (name, description, logo)
- ✅ Create Voucher Offer (with preview)
- ✅ POS Redemption (QR scanner, partial redemption)
- ✅ Sales Reports (daily/weekly/monthly)
- ✅ Complete merchant journey tests

**Total Effort**: 10 days (2 weeks)

---

## Phase 4: Enhanced Features

**Goal**: P2P transfers, favorites, advanced features

**Duration**: 1 week (5 days)

### Tasks

#### 4.1. P2P Voucher Transfers (2 days)

**Allow customers to send vouchers to each other**

**Design Spec**: Lines 1035-1064

**Features**:
- [Send to Friend] button on voucher details
- Display QR code with token
- Copy token button
- Share via... (platform share sheet)
- Redeem received token

**Implementation**:
```kotlin
// imani-app/src/commonMain/kotlin/cash/imani/app/ui/shop/VoucherDetailScreen.kt
@Composable
fun VoucherDetailScreen(
    voucherId: String,
    viewModel: VoucherViewModel,
    onSendToFriend: () -> Unit,
    onRedeem: () -> Unit,
    onBack: () -> Unit
) {
    val voucher by viewModel.getVoucher(voucherId).collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Voucher Details") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                    }
                }
            )
        }
    ) { padding ->
        Column(Modifier.padding(padding).padding(16.dp)) {
            VoucherCard(/* voucher details */)

            Button(
                onClick = onRedeem,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("Redeem at Merchant")
            }

            OutlinedButton(
                onClick = onSendToFriend,
                modifier = Modifier.fillMaxWidth()
            ) {
                Icon(Icons.Default.Send, null)
                Spacer(Modifier.width(8.dp))
                Text("Send to Friend")
            }
        }
    }
}

// Send Voucher Dialog
@Composable
fun SendVoucherDialog(
    voucher: StoredVoucher,
    onDismiss: () -> Unit
) {
    Dialog(onDismissRequest = onDismiss) {
        Card {
            Column(Modifier.padding(16.dp)) {
                Text("Share this voucher", style = MaterialTheme.typography.titleMedium)

                Spacer(Modifier.height(16.dp))

                voucher.token?.let { token ->
                    QRCodeDisplay(data = token, size = 200.dp)

                    OutlinedButton(
                        onClick = { copyToClipboard(token) },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Icon(Icons.Default.ContentCopy, null)
                        Text("Copy Token")
                    }

                    OutlinedButton(
                        onClick = { shareViaSystem(token) },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Icon(Icons.Default.Share, null)
                        Text("Share via...")
                    }
                }
            }
        }
    }
}
```

**Acceptance Criteria**:
- ✅ QR code displays voucher token
- ✅ Copy token works
- ✅ Share sheet opens (platform-specific)
- ✅ Recipient can redeem token
- ✅ Sender's voucher marked as transferred

**Effort**: 2 days

---

#### 4.2. Favorite Merchants (1 day)

**Save favorite merchants for quick access**

**Features**:
- Star icon on merchant detail
- Favorites section in Shop tab
- Persist to localStorage

**Implementation**:
```kotlin
// imani-app/src/commonMain/kotlin/cash/imani/app/repository/FavoritesRepository.kt
class FavoritesRepository {
    private val storage = window.localStorage

    fun addFavorite(npub: String) {
        val favorites = getFavorites().toMutableList()
        if (!favorites.contains(npub)) {
            favorites.add(npub)
            storage.setItem("favorites", Json.encodeToString(favorites))
        }
    }

    fun getFavorites(): List<String> {
        val json = storage.getItem("favorites") ?: "[]"
        return Json.decodeFromString(json)
    }
}
```

**Acceptance Criteria**:
- ✅ Star button toggles favorite status
- ✅ Favorites persist across sessions
- ✅ Favorites section shows starred merchants

**Effort**: 1 day

---

#### 4.3. Camera QR Scanner (1 day)

**Real QR code scanning using device camera**

**Libraries**:
- Web: `jsQR` library via JS interop
- Or: `zxing-kotlin` (KMP-compatible)

**Implementation**:
```kotlin
// imani-app/src/jsMain/kotlin/cash/imani/app/ui/components/QRScanner.js.kt
@Composable
actual fun QRScannerView(
    onQRScanned: (String) -> Unit,
    onBack: () -> Unit
) {
    var videoElement by remember { mutableStateOf<HTMLVideoElement?>(null) }

    LaunchedEffect(Unit) {
        // Request camera permission
        val stream = window.navigator.mediaDevices.getUserMedia(
            MediaStreamConstraints(video = true)
        )

        videoElement?.srcObject = stream

        // Start QR detection loop
        while (true) {
            delay(100) // Scan every 100ms
            val canvas = document.createElement("canvas") as HTMLCanvasElement
            val context = canvas.getContext("2d")
            context.drawImage(videoElement, 0.0, 0.0)
            val imageData = context.getImageData(0.0, 0.0, canvas.width, canvas.height)

            val code = jsQR(imageData.data, imageData.width, imageData.height)
            if (code != null) {
                onQRScanned(code.data)
                stream.getTracks().forEach { it.stop() }
                break
            }
        }
    }

    Box(Modifier.fillMaxSize()) {
        // Video preview
        HtmlView(
            factory = {
                document.createElement("video").apply {
                    this as HTMLVideoElement
                    autoplay = true
                    videoElement = this
                }
            }
        )

        IconButton(onClick = onBack) {
            Icon(Icons.Default.Close, "Close")
        }
    }
}
```

**Acceptance Criteria**:
- ✅ Camera permission requested
- ✅ Video preview shown
- ✅ QR codes detected and decoded
- ✅ Works on mobile and desktop

**Effort**: 1 day

---

#### 4.4. Responsive Design Refinement (1 day)

**Optimize layouts for mobile/tablet/desktop**

**Breakpoints** (from design spec lines 1550-1628):
- Mobile: <640px → Bottom tabs, single column
- Tablet: 640-1024px → Side nav rail, two columns
- Desktop: >1024px → Three columns, persistent rail

**Implementation**:
```kotlin
// imani-app/src/commonMain/kotlin/cash/imani/app/ui/theme/Responsive.kt
@Composable
fun ResponsiveLayout(
    content: @Composable (ScreenSize) -> Unit
) {
    val screenWidth = LocalConfiguration.current.screenWidthDp

    val screenSize = when {
        screenWidth < 640 -> ScreenSize.MOBILE
        screenWidth < 1024 -> ScreenSize.TABLET
        else -> ScreenSize.DESKTOP
    }

    content(screenSize)
}

enum class ScreenSize {
    MOBILE, TABLET, DESKTOP
}

// Usage in MainScreen
@Composable
fun MainScreen() {
    ResponsiveLayout { screenSize ->
        when (screenSize) {
            ScreenSize.MOBILE -> MobileLayout()
            ScreenSize.TABLET -> TabletLayout()
            ScreenSize.DESKTOP -> DesktopLayout()
        }
    }
}
```

**Acceptance Criteria**:
- ✅ Layouts adapt to screen size
- ✅ Bottom tabs on mobile
- ✅ Side nav on tablet/desktop
- ✅ Grid layouts use correct columns

**Effort**: 1 day

---

### Phase 4 Deliverables

- ✅ P2P voucher transfers (QR, copy, share)
- ✅ Favorite merchants (star, list)
- ✅ Camera QR scanner (real-time detection)
- ✅ Responsive design (mobile/tablet/desktop)

**Total Effort**: 5 days (1 week)

---

## Phase 5: Polish & Production

**Goal**: Final polish, testing, deployment

**Duration**: 1 week (5 days)

### Tasks

#### 5.1. Accessibility (WCAG 2.1 AA) (1 day)

**Design Spec**: Lines 1631-1665

**Requirements**:
- Text contrast ≥ 4.5:1
- Keyboard navigation (Tab, Enter, Esc)
- Screen reader support (ARIA labels)
- Touch targets ≥ 48x48dp
- Focus indicators (2px solid)
- Color blindness (icons + text)

**Implementation**:
```kotlin
// Add semantic labels
Icon(
    Icons.Default.Add,
    contentDescription = "Add merchant" // Screen reader
)

// Focus indicators
Button(
    onClick = {},
    modifier = Modifier.focusable().onFocusChanged {
        // Show focus ring
    }
)
```

**Acceptance Criteria**:
- ✅ Lighthouse accessibility score ≥90
- ✅ Screen reader announces correctly
- ✅ Keyboard navigation works

**Effort**: 1 day

---

#### 5.2. End-to-End Testing (2 days)

**Write Playwright E2E tests for critical flows**

**Test Scenarios**:
1. **First-Time Merchant Setup** (<3 min)
   - Register → Set profile → Create offer → Share npub

2. **Customer Purchase & Redeem** (<2 min)
   - Discover merchant → Buy voucher → Pay Lightning → Redeem at POS

3. **Partial Redemption**
   - Use 100 sat voucher for 30 sat purchase → Check balance

4. **P2P Transfer**
   - CustA sends voucher to CustB → CustB redeems

**Implementation**:
```typescript
// e2e/tests/marketplace-flow.spec.ts
test('merchant creates offer and customer purchases', async ({ page }) => {
  // Step 1: Merchant creates offer
  await page.goto('/merchant')
  await page.click('text=Create Offer')
  await page.fill('input[name=voucherName]', 'Coffee Voucher')
  await page.fill('input[name=price]', '100')
  await page.click('text=Create Offer')

  // Step 2: Customer discovers merchant
  await page.goto('/shop/discover')
  await page.fill('input[name=npub]', merchantNpub)
  await page.click('text=Search')

  // Step 3: Customer purchases
  await page.click('text=Buy for 100')
  await page.click('text=Confirm Purchase')

  // Wait for Lightning invoice
  await expect(page.locator('canvas')).toBeVisible() // QR code

  // Simulate payment (mock)
  await mockLightningPayment(page)

  // Step 4: Verify voucher added
  await page.goto('/shop')
  await expect(page.locator('text=Coffee Voucher')).toBeVisible()
})
```

**Acceptance Criteria**:
- ✅ All critical flows covered
- ✅ Tests pass on Chrome, Firefox, Safari
- ✅ Mobile responsive tests

**Effort**: 2 days

---

#### 5.3. Performance Optimization (1 day)

**Optimize bundle size, lazy loading, caching**

**Targets** (from design spec):
- Bundle size: <500KB gzipped
- Initial load: <3s
- Lighthouse performance: ≥90

**Optimizations**:
1. **Code Splitting**:
   ```kotlin
   // Lazy load screens
   val ShopTabScreen by lazy { loadScreen("ShopTab") }
   ```

2. **Image Optimization**:
   - Compress QR codes
   - Lazy load merchant logos

3. **Caching**:
   - Cache Nostr queries (15 min)
   - Cache merchant profiles

**Acceptance Criteria**:
- ✅ Bundle <500KB gzipped
- ✅ Lighthouse score ≥90
- ✅ Offline support (PWA)

**Effort**: 1 day

---

#### 5.4. Production Deployment (1 day)

**Deploy to Vercel/Netlify with monitoring**

**Steps**:
1. Configure deployment (use existing from Phase 3)
2. Set up error tracking (Sentry)
3. Configure analytics (Plausible)
4. Test production build
5. Deploy to production

**Acceptance Criteria**:
- ✅ Production URL live
- ✅ Error tracking configured
- ✅ Analytics tracking
- ✅ SSL certificate valid

**Effort**: 1 day

---

### Phase 5 Deliverables

- ✅ Accessibility (WCAG 2.1 AA compliant)
- ✅ E2E tests (critical flows covered)
- ✅ Performance optimization (bundle <500KB)
- ✅ Production deployment (live URL)

**Total Effort**: 5 days (1 week)

---

## Timeline & Resources

### Overall Timeline

| Phase | Duration | Start | End | Deliverables |
|-------|----------|-------|-----|--------------|
| **Phase 1** | 1 week | Week 1 | Week 1 | Navigation, components, settings |
| **Phase 2** | 2 weeks | Week 2 | Week 3 | Shop tab (customer features) |
| **Phase 3** | 2 weeks | Week 4 | Week 5 | Merchant tab (business features) |
| **Phase 4** | 1 week | Week 6 | Week 6 | P2P transfers, advanced features |
| **Phase 5** | 1 week | Week 7 | Week 7 | Polish, testing, deployment |

**Total Duration**: 7 weeks (~35 days, ~1.75 months)

---

### Resource Requirements

| Role | Allocation | Responsibilities |
|------|------------|------------------|
| **Frontend Developer** | 100% | Compose UI, navigation, components |
| **UX Designer** | 25% | Design review, component feedback |
| **QA Engineer** | 50% | E2E testing, accessibility testing |
| **Backend Developer** | 0% | Backend complete (cashu-client integration) |

**Team Size**: 2.75 FTE

---

### Dependencies

| Dependency | Status | Notes |
|------------|--------|-------|
| **cashu-client Integration** | ✅ 100% | All use cases implemented |
| **Identity Module** | ✅ 100% | Single identity model ready |
| **Voucher Module** | ✅ 100% | Lightning, offers, sales tracking done |
| **Nostr Integration** | ✅ 100% | Voucher storage, backup, events |
| **Design Spec** | ✅ 100% | web-client-ui-design.md complete |

**No blockers** - All backend work is complete.

---

## Success Metrics

### Functional Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Merchant Onboarding** | <3 minutes | Time to create first offer |
| **Customer Purchase** | <2 minutes | Time from discovery to voucher |
| **Voucher Redemption** | <30 seconds | Time to scan and confirm |
| **P2P Transfer** | <30 seconds | Time to share voucher |

---

### Technical Metrics

| Metric | Target | Tool |
|--------|--------|------|
| **Bundle Size** | <500KB gzipped | Webpack analyzer |
| **Lighthouse Performance** | ≥90 | Lighthouse CI |
| **Lighthouse Accessibility** | ≥90 | Lighthouse CI |
| **E2E Test Coverage** | 100% critical paths | Playwright |
| **Mobile Responsive** | 100% screens | Manual testing |

---

### Business Metrics

| Metric | Target (3 months) | Measurement |
|--------|-------------------|-------------|
| **Active Merchants** | 50 | Merchants with ≥1 offer |
| **Active Customers** | 500 | Users with ≥1 voucher |
| **Vouchers Issued** | 2,000 | Total vouchers sold |
| **Lightning Payments** | 1,500 | Successful payments |
| **Redemption Rate** | ≥60% | Vouchers redeemed / issued |

---

## Change Log

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2025-11-21 | Initial implementation plan for web marketplace UI v2.0.0 |

---

**Related Documents**:
- [Web Client UI/UX Design](web-client-ui-design.md) - Complete design specification
- [Kotlin Voucher Client Roadmap](kotlin-voucher-client-roadmap.md) - Main project roadmap
- [cashu-client Integration Master Plan](cashu-client-integration-master-plan.md) - Backend integration (100% complete)
- [Android Port Roadmap](android-port-roadmap.md) - Android client roadmap
