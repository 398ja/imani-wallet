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
 * Phase 3.3: Create Voucher Offer (IMPLEMENTED)
 * - Navigate to create offer screen
 * - Publish offer to Nostr
 *
 * Phase 3.4: POS Redemption (IMPLEMENTED)
 * - Navigate to POS redemption screen
 * - Scan/enter voucher token, redeem
 *
 * TODO Phase 3 Next Tasks:
 * - Sales Reports (Task 3.5)
 *
 * See: project/web-marketplace-ui-implementation.md Phase 3
 */
@Composable
fun MerchantTabScreen() {
    val dashboardViewModel: MerchantDashboardViewModel = koinInject()
    val profileViewModel: MerchantProfileViewModel = koinInject()
    val createOfferViewModel: CreateOfferViewModel = koinInject()
    val posViewModel: POSViewModel = koinInject()

    // Navigation state
    var showEditProfile by remember { mutableStateOf(false) }
    var showCreateOffer by remember { mutableStateOf(false) }
    var showPOSRedeem by remember { mutableStateOf(false) }

    // Load dashboard data on first composition
    LaunchedEffect(Unit) {
        dashboardViewModel.loadDashboard()
    }

    when {
        showEditProfile -> {
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
        }

        showCreateOffer -> {
            // Phase 3.3: Create Offer Screen
            CreateOfferScreen(
                viewModel = createOfferViewModel,
                onCreated = {
                    showCreateOffer = false
                    // Reload dashboard to show new offer
                    dashboardViewModel.loadDashboard()
                },
                onCancel = {
                    showCreateOffer = false
                },
            )
        }

        showPOSRedeem -> {
            // Phase 3.4: POS Redemption Screen
            POSRedemptionScreen(
                viewModel = posViewModel,
                onRedeemed = {
                    showPOSRedeem = false
                    // Reload dashboard to show updated redemptions
                    dashboardViewModel.loadDashboard()
                },
                onBack = {
                    showPOSRedeem = false
                },
            )
        }

        else -> {
            // Phase 3.1: Sales Dashboard (default view)
            SalesDashboardScreen(
                viewModel = dashboardViewModel,
                onEditProfile = {
                    showEditProfile = true
                },
                onCreateOffer = {
                    showCreateOffer = true
                },
                onEditOffer = { offerId ->
                    // TODO Phase 3.3+: Navigate to edit offer
                    println("[MerchantTabScreen] Edit offer clicked: $offerId (TODO)")
                },
                onPOSRedeem = {
                    showPOSRedeem = true
                },
            )
        }
    }
}
