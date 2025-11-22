package cash.imani.app.ui.merchant

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import cash.imani.app.di.koinInject

/**
 * Merchant tab screen - Business features.
 *
 * Phase 3.1: Sales Dashboard (IMPLEMENTED)
 * - Shows merchant profile, today's metrics, active offers, recent redemptions
 *
 * Phase 3.2: Edit Merchant Profile (IMPLEMENTED)
 * - Navigate to edit profile screen
 * - Save changes to Nostr and IndexedDB
 *
 * TODO Phase 3 Next Tasks:
 * - Create Voucher Offer (Task 3.3)
 * - POS Redemption (Task 3.4)
 * - Sales Reports (Task 3.5)
 *
 * See: project/web-marketplace-ui-implementation.md Phase 3
 */
@Composable
fun MerchantTabScreen() {
    val dashboardViewModel: MerchantDashboardViewModel = koinInject()
    val profileViewModel: MerchantProfileViewModel = koinInject()

    // Navigation state
    var showEditProfile by remember { mutableStateOf(false) }

    // Load dashboard data on first composition
    LaunchedEffect(Unit) {
        dashboardViewModel.loadDashboard()
    }

    if (showEditProfile) {
        // Phase 3.2: Edit Profile Screen
        EditMerchantProfileScreen(
            viewModel = profileViewModel,
            onSaved = {
                showEditProfile = false
                // Reload dashboard to show updated profile
                dashboardViewModel.loadDashboard()
            },
            onBack = {
                showEditProfile = false
            },
        )
    } else {
        // Phase 3.1: Sales Dashboard (default view)
        SalesDashboardScreen(
            viewModel = dashboardViewModel,
            onEditProfile = {
                showEditProfile = true
            },
            onCreateOffer = {
                // TODO Phase 3.3: Navigate to create offer
                println("[MerchantTabScreen] Create offer clicked (TODO)")
            },
            onEditOffer = { offerId ->
                // TODO Phase 3.3: Navigate to edit offer
                println("[MerchantTabScreen] Edit offer clicked: $offerId (TODO)")
            },
            onPOSRedeem = {
                // TODO Phase 3.4: Navigate to POS redemption
                println("[MerchantTabScreen] Open POS clicked (TODO)")
            },
        )
    }
}
