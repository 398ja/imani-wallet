package cash.imani.app.ui.merchant

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import cash.imani.app.di.koinInject

/**
 * Merchant tab screen - Business features.
 *
 * Phase 3.1: Sales Dashboard (IMPLEMENTED)
 * - Shows merchant profile, today's metrics, active offers, recent redemptions
 *
 * TODO Phase 3 Next Tasks:
 * - Edit Merchant Profile (Task 3.2)
 * - Create Voucher Offer (Task 3.3)
 * - POS Redemption (Task 3.4)
 * - Sales Reports (Task 3.5)
 *
 * See: project/web-marketplace-ui-implementation.md Phase 3
 */
@Composable
fun MerchantTabScreen() {
    val viewModel: MerchantDashboardViewModel = koinInject()

    // Load dashboard data on first composition
    LaunchedEffect(Unit) {
        viewModel.loadDashboard()
    }

    SalesDashboardScreen(
        viewModel = viewModel,
        onEditProfile = {
            // TODO Phase 3.2: Navigate to edit profile
            println("[MerchantTabScreen] Edit profile clicked (TODO)")
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
