# Imani Wallet - Android Client UI/UX Design

> **Document Type**: Reference (Diátaxis)
> **Purpose**: Complete UI/UX specification for Imani Wallet Android application
> **Platform**: Android (Kotlin + Jetpack Compose)
> **Design System**: Material 3 (Imani Brand Theme)
> **Version**: 2.0.0
> **Last Updated**: 2025-11-20

---

## Table of Contents

1. [Overview](#overview)
2. [Android-Specific Features](#android-specific-features)
3. [Navigation Structure](#navigation-structure)
4. [Screen Specifications](#screen-specifications)
5. [User Flows](#user-flows)
6. [Component Library](#component-library)
7. [Responsive Design](#responsive-design)
8. [Accessibility](#accessibility)
9. [Performance & Security](#performance--security)

---

## Overview

### Application Purpose

**Imani Wallet** for Android is a native mobile app that enables the same merchant-customer voucher marketplace as the web version, with additional Android-native features:

**For Merchants**:
- Create voucher offers with biometric authentication
- In-store POS redemption with camera QR scanning
- Push notifications for sales and redemptions
- Share merchant profile via Android Share Sheet
- Deep linking support for customer discovery

**For Customers**:
- Fast QR scanning with CameraX + ML Kit
- Biometric-protected wallet access
- Home screen widgets for quick voucher access
- Deep link support (tap merchant links to open app)
- Offline-first with automatic sync

**Key Innovation**: **One app, dual roles** - same as web, with native Android UX patterns.

---

### Business Model

Same as web version:
1. Merchant creates voucher offer
2. Merchant shares Nostr npub (QR code, NFC, deep link)
3. Customer discovers merchant, buys voucher (Lightning payment)
4. Customer redeems voucher (scan QR or manual)
5. Partial redemption supported (balance tracking)

**Payment Flow**: Lightning (external wallet) → Cashu token → Redemption

---

## Android-Specific Features

### 1. Biometric Authentication

**Use Cases**:
- Unlock wallet on app launch
- Confirm voucher redemption (merchant)
- Export private keys
- Delete identity

**Implementation** (BiometricPrompt):
```kotlin
val biometricPrompt = BiometricPrompt(
    activity,
    executor,
    object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: AuthenticationResult) {
            // Unlock wallet, proceed with sensitive operation
            viewModel.unlockWallet()
        }
        override fun onAuthenticationFailed() {
            showError("Biometric authentication failed")
        }
    }
)

val promptInfo = BiometricPrompt.PromptInfo.Builder()
    .setTitle("Unlock Imani Wallet")
    .setSubtitle("Use fingerprint or face unlock")
    .setNegativeButtonText("Use PIN")
    .build()

biometricPrompt.authenticate(promptInfo)
```

---

### 2. QR Code Scanning (CameraX + ML Kit)

**Use Cases**:
- Scan merchant npub QR code (customer discovery)
- Scan voucher QR code (merchant POS redemption)
- Scan Lightning invoice QR code (payment)

**Implementation**:
```kotlin
@Composable
fun QRScannerScreen(
    onQRDetected: (String) -> Unit,
    onCancel: () -> Unit
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val cameraProviderFuture = remember { ProcessCameraProvider.getInstance(context) }

    AndroidView(
        factory = { ctx ->
            val previewView = PreviewView(ctx)
            val cameraProvider = cameraProviderFuture.get()

            // ML Kit QR code scanner
            val scanner = BarcodeScanning.getClient(
                BarcodeScannerOptions.Builder()
                    .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                    .build()
            )

            val preview = Preview.Builder().build().also {
                it.setSurfaceProvider(previewView.surfaceProvider)
            }

            val imageAnalysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
                .also {
                    it.setAnalyzer(executor) { imageProxy ->
                        scanQRCode(imageProxy, scanner) { qrData ->
                            onQRDetected(qrData)
                        }
                    }
                }

            cameraProvider.bindToLifecycle(
                lifecycleOwner,
                CameraSelector.DEFAULT_BACK_CAMERA,
                preview,
                imageAnalysis
            )

            previewView
        },
        modifier = Modifier.fillMaxSize()
    )

    // Overlay with scanning frame
    Box(modifier = Modifier.fillMaxSize()) {
        // Scanning frame UI
        ScanningFrame()

        // Cancel button
        IconButton(
            onClick = onCancel,
            modifier = Modifier.align(Alignment.TopEnd).padding(16.dp)
        ) {
            Icon(Icons.Default.Close, "Cancel")
        }
    }
}
```

---

### 3. Android Share Sheet

**Use Cases**:
- Share merchant profile (npub)
- Share voucher token (customer gifting)
- Share sales report (merchant)

**Implementation**:
```kotlin
fun shareVoucher(context: Context, token: String, amount: Int, merchantName: String) {
    val sendIntent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_SUBJECT, "Imani Voucher - $amount sat from $merchantName")
        putExtra(Intent.EXTRA_TEXT, """
            Redeem this voucher at $merchantName:

            $token

            Or tap: https://wallet.imani.cash/redeem?token=$token
        """.trimIndent())
    }

    val shareIntent = Intent.createChooser(sendIntent, "Share voucher via")
    context.startActivity(shareIntent)
}
```

---

### 4. Deep Linking

**Supported Links**:
- `https://wallet.imani.cash/merchant/:npub` - Open merchant profile
- `https://wallet.imani.cash/redeem?token=cashuA...` - Redeem voucher
- `imani://merchant/:npub` - Custom scheme

**AndroidManifest.xml**:
```xml
<activity android:name=".MainActivity">
    <intent-filter android:autoVerify="true">
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />

        <!-- Web links -->
        <data android:scheme="https"
              android:host="wallet.imani.cash"
              android:pathPrefix="/merchant" />
        <data android:scheme="https"
              android:host="wallet.imani.cash"
              android:pathPrefix="/redeem" />

        <!-- Custom scheme -->
        <data android:scheme="imani" />
    </intent-filter>
</activity>
```

---

### 5. Push Notifications

**Use Cases**:
- Merchant: "New voucher sold - 100 sat"
- Merchant: "Voucher redeemed - 30 sat"
- Customer: "Voucher expiring in 3 days"
- Customer: "Payment confirmed, voucher received"

---

## Navigation Structure

### Bottom Navigation Bar (Material 3)

```
┌────────────────────────────────────────────────────────────┐
│  [←]  Imani Wallet                              [⋮ Menu]   │ TopAppBar
├────────────────────────────────────────────────────────────┤
│                     Content Area                            │
│                                                             │
│                                                             │
│                                                             │
├────────────────────────────────────────────────────────────┤
│  [🛒 Shop]       [💼 Merchant]       [⚙️ Settings]         │ BottomNav
└────────────────────────────────────────────────────────────┘
```

**Implementation**:
```kotlin
@Composable
fun MainScreen() {
    var selectedTab by remember { mutableStateOf(Tab.SHOP) }

    Scaffold(
        bottomBar = {
            NavigationBar {
                NavigationBarItem(
                    icon = { Icon(Icons.Default.ShoppingCart, "Shop") },
                    label = { Text("Shop") },
                    selected = selectedTab == Tab.SHOP,
                    onClick = { selectedTab = Tab.SHOP }
                )
                NavigationBarItem(
                    icon = { Icon(Icons.Default.StoreMallDirectory, "Merchant") },
                    label = { Text("Merchant") },
                    selected = selectedTab == Tab.MERCHANT,
                    onClick = { selectedTab = Tab.MERCHANT }
                )
                NavigationBarItem(
                    icon = { Icon(Icons.Default.Settings, "Settings") },
                    label = { Text("Settings") },
                    selected = selectedTab == Tab.SETTINGS,
                    onClick = { selectedTab = Tab.SETTINGS }
                )
            }
        }
    ) { paddingValues ->
        Box(Modifier.padding(paddingValues)) {
            when (selectedTab) {
                Tab.SHOP -> ShopScreen()
                Tab.MERCHANT -> MerchantScreen()
                Tab.SETTINGS -> SettingsScreen()
            }
        }
    }
}
```

---

## Screen Specifications

> **Note**: Most screen layouts are identical to the web version. See [Web Client UI/UX Design](web-client-ui-design.md) for detailed specifications. Below are Android-specific screens and modifications.

### Android-Specific Screens

#### 1. QR Scanner Screen (Android-only)

**Purpose**: Scan QR codes with camera (merchant npub, voucher token, Lightning invoice)

**Layout**:
```
┌────────────────────────────────────────────────────────────┐
│  [×] Scan QR Code                                           │
├────────────────────────────────────────────────────────────┤
│                                                             │
│              [Camera View]                                  │
│                                                             │
│         ┌─────────────────────┐                            │
│         │                     │                            │
│         │  Scanning Frame     │                            │
│         │                     │                            │
│         └─────────────────────┘                            │
│                                                             │
│         Point camera at QR code                            │
│                                                             │
│                                                             │
│  [💡 Turn on Flash]        [🖼️ From Gallery]               │
└────────────────────────────────────────────────────────────┘
```

**Features**:
- Real-time QR detection (ML Kit)
- Haptic feedback on successful scan (vibration)
- Beep sound on detection
- Flashlight toggle for low-light conditions
- Pick image from gallery (fallback)

---

#### 2. Biometric Unlock Screen (Android-only)

**Purpose**: Unlock wallet with fingerprint/face

**Layout**:
```
┌────────────────────────────────────────────────────────────┐
│                                                             │
│                                                             │
│                     🔐                                      │
│                                                             │
│                 Unlock Wallet                               │
│                                                             │
│         Use your fingerprint or face                        │
│            to access Imani Wallet                           │
│                                                             │
│                                                             │
│                  [👆 Scan now]                              │
│                                                             │
│                                                             │
│                   [Use PIN]                                 │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

**Trigger Points**:
- App launch (after 5 min background)
- Export private key
- Delete identity
- Confirm large voucher redemption (>10,000 sat)

---

## User Flows

### Flow 1: First-Time User (Customer) - Scan & Buy (<1 minute)

```
1. User opens Imani Wallet (fresh install)
   ↓
2. Biometric setup (optional): "Use fingerprint to unlock?"
   ↓
3. Create identity (auto-generated, background)
   ↓
4. User at coffee shop → Sees QR code poster
   ↓
5. Tap [Scan QR] FAB → Camera opens (CameraX)
   ↓
6. Scan merchant QR code → Vibrate + beep → Merchant Detail Screen
   ↓
7. "Coffee Voucher - 100 sat" → [Buy for 100]
   ↓
8. Lightning invoice displayed → [Open in Alby]
   ↓
9. Alby opens → Confirm payment → Return to Imani
   ↓
10. "Payment confirmed! Voucher added" → Navigate to My Vouchers
    ✅ Complete (<1 minute from scan to purchase)
```

---

### Flow 2: Redeem Voucher at POS (<10 seconds)

```
1. Customer orders coffee at counter
   ↓
2. Open Imani → /shop → My Vouchers → Tap "Coffee Voucher"
   ↓
3. [Redeem] → Display QR code (full screen)
   ↓
4. Merchant scans QR with their phone (Android camera)
   ↓
5. Merchant sees voucher details → Enter amount: 100 sat
   ↓
6. [Confirm Redeem] → Vibrate + success animation
   ↓
7. Customer sees "Redeemed!" → Voucher marked as used
   ✅ Complete (<10 seconds from open to redeemed)
```

---

### Flow 3: Merchant Creates First Offer (<2 minutes)

```
1. Open Imani → /merchant (first time)
   ↓
2. "Set up your merchant profile" → [Get Started]
   ↓
3. Biometric prompt: "Secure your merchant identity"
   ↓
4. Business name: "Coffee Shop Downtown" → [Next]
   ↓
5. Upload logo (optional) → [Skip]
   ↓
6. [+ Create Offer]
   • Name: "Coffee Voucher"
   • Price: 100 sat
   • Validity: 30 days
   • ✓ Partial redemption
   • [Create]
   ↓
7. Success! → "Share your profile"
   • QR code displayed (npub)
   • [Share via WhatsApp] → Send to customers
   • [Print QR] → Print for in-store display
   ✅ Merchant ready to accept payments (<2 minutes)
```

---

## Component Library

> **Note**: Most components are identical to web version. See [Web Client UI/UX Design - Component Library](web-client-ui-design.md#component-library). Below are Android-specific components.

### Android-Specific Components

#### 1. BiometricPromptButton

```kotlin
@Composable
fun BiometricPromptButton(
    text: String,
    onAuthSuccess: () -> Unit,
    onAuthFailed: () -> Unit
) {
    val context = LocalContext.current
    val activity = context as? FragmentActivity

    Button(
        onClick = {
            activity?.let {
                showBiometricPrompt(it, onAuthSuccess, onAuthFailed)
            }
        }
    ) {
        Icon(Icons.Default.Fingerprint, contentDescription = null)
        Spacer(Modifier.width(8.dp))
        Text(text)
    }
}
```

---

#### 2. ShareButton (Android Share Sheet)

```kotlin
@Composable
fun ShareButton(
    text: String,
    shareContent: String,
    shareTitle: String
) {
    val context = LocalContext.current

    OutlinedButton(
        onClick = {
            val sendIntent = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, shareContent)
                putExtra(Intent.EXTRA_SUBJECT, shareTitle)
            }
            val shareIntent = Intent.createChooser(sendIntent, null)
            context.startActivity(shareIntent)
        }
    ) {
        Icon(Icons.Default.Share, contentDescription = null)
        Spacer(Modifier.width(4.dp))
        Text(text)
    }
}
```

---

## Responsive Design

### WindowSizeClass (Jetpack Compose Material 3)

```kotlin
@Composable
fun AdaptiveLayout() {
    val windowSizeClass = calculateWindowSizeClass(LocalContext.current as Activity)

    when (windowSizeClass.widthSizeClass) {
        WindowWidthSizeClass.Compact -> {
            // Phone portrait: Bottom Navigation + Single Column
            CompactLayout()
        }
        WindowWidthSizeClass.Medium -> {
            // Phone landscape / Tablet portrait: Bottom Navigation + Two Columns
            MediumLayout()
        }
        WindowWidthSizeClass.Expanded -> {
            // Tablet landscape / Foldable: Navigation Rail + Three Columns
            ExpandedLayout()
        }
    }
}
```

---

### Compact (Phone Portrait) - <600dp width

**Layout**:
- Bottom Navigation Bar
- Single-column content
- Full-width cards
- FAB for primary actions

---

### Medium (Tablet Portrait / Phone Landscape) - 600-840dp

**Layout**:
- Bottom Navigation Bar (or Side Navigation Rail)
- Two-column grid for voucher lists
- Side-by-side forms

---

### Expanded (Tablet Landscape / Foldable) - >840dp

**Layout**:
- Permanent Navigation Rail (left)
- Three-column content (list + details + actions)
- Multi-pane layouts

---

## Accessibility

### TalkBack Support (Screen Reader)

**Implementation**:
```kotlin
@Composable
fun VoucherCard(voucher: StoredVoucher) {
    Card(
        modifier = Modifier.semantics {
            contentDescription = """
                ${voucher.merchantName} voucher.
                Balance: ${voucher.balance} out of ${voucher.originalAmount} satoshis.
                Expires in ${voucher.daysUntilExpiry} days.
                Status: ${voucher.status}.
                Double tap to redeem.
            """.trimIndent()
        }
    ) {
        // Card content
    }
}
```

---

### Minimum Touch Target Size

**Material 3 Guideline**: 48x48dp minimum

---

## Performance & Security

### Performance Targets

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Cold Start** | < 2 seconds | App startup to first screen |
| **QR Scan Latency** | < 500ms | Camera open to QR detection |
| **Frame Rate** | 60fps | Scrolling voucher lists |
| **APK Size** | < 15MB | Release APK (uncompressed) |
| **Memory Usage** | < 150MB | Peak memory (typical session) |

---

### Android Keystore

**Use Cases**:
- Encrypt identity private keys
- Secure voucher tokens at rest
- Protect sensitive merchant data

---

## Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **UI Framework** | Jetpack Compose | Declarative UI, Material 3 |
| **Navigation** | Voyager Navigator | Type-safe navigation |
| **State Management** | StateFlow + ViewModel | Reactive state |
| **Database** | SQLDelight | Type-safe SQL (local storage) |
| **Crypto** | BouncyCastle + Android Keystore | secp256k1, Schnorr |
| **QR Scanning** | CameraX + ML Kit | Real-time QR detection |
| **Biometrics** | BiometricPrompt API | Fingerprint/face unlock |
| **HTTP Client** | Ktor Client (Android) | Lightning invoice fetching |
| **DI** | Koin | Dependency injection |

---

## Change Log

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2025-11-20 | Initial P2P voucher design (deprecated) |
| 2.0.0 | 2025-11-20 | **Complete redesign for merchant-customer marketplace**. Android-native features: BiometricPrompt, CameraX + ML Kit QR scanning, Share Sheet, Deep Links, Push Notifications. Same dual-role UX as web (Shop/Merchant/Settings tabs). |

---

**Related Documents**:
- [Web Client UI/UX Design](web-client-ui-design.md) - Shared screen specifications and flows
- [Cashu Client Integration Master Plan](cashu-client-integration-master-plan.md)
- [Kotlin Voucher Client Roadmap](kotlin-voucher-client-roadmap.md)
