package cash.imani.app.navigation

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.ui.graphics.vector.ImageVector

/**
 * Application tab navigation destinations.
 *
 * Represents the three main tabs in the marketplace app:
 * - SHOP: Customer mode (browse merchants, buy vouchers, redeem)
 * - MERCHANT: Business mode (sales dashboard, create offers, POS)
 * - SETTINGS: Account settings (identity, payment, backup)
 *
 * See: project/web-marketplace-ui-implementation.md Phase 1, Task 1.1
 */
enum class AppTab(
    val label: String,
    val icon: ImageVector,
) {
    /**
     * Shop tab - Customer features.
     *
     * Screens:
     * - My Vouchers
     * - Discover Merchants
     * - Merchant Detail
     * - Purchase Voucher
     * - Redeem Voucher
     */
    SHOP("Shop", Icons.Default.ShoppingCart),

    /**
     * Merchant tab - Business features.
     *
     * Screens:
     * - Sales Dashboard
     * - Edit Merchant Profile
     * - Create Voucher Offer
     * - POS Redemption
     * - Sales Reports
     */
    MERCHANT("Merchant", Icons.Default.Person),

    /**
     * Settings tab - Account management.
     *
     * Screens:
     * - Identity (single account, npub/nsec)
     * - Payment (Lightning wallet integration)
     * - Backup & Security (Nostr backups)
     */
    SETTINGS("Settings", Icons.Default.Settings),
}
