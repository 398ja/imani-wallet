package cash.imani.app.ui.shop

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import cash.imani.app.di.koinInject
import cash.imani.app.ui.voucher.VoucherViewModel

/**
 * Shop tab screen - Customer features.
 *
 * Wrapper for MyVouchersScreen to match tab interface.
 *
 * Phase 2.1 COMPLETE:
 * - My Vouchers screen with merchant grouping
 * - Sort options (expiry, merchant, balance)
 * - Empty state with CTA
 *
 * TODO Phase 2 remaining:
 * - Discover Merchants (Task 2.2)
 * - Merchant Detail (Task 2.3)
 * - Purchase Voucher (Task 2.4)
 * - Redeem Voucher (Task 2.5)
 *
 * See: project/web-marketplace-ui-implementation.md Phase 2
 *
 * @param modifier Modifier for styling
 */
@Composable
fun ShopTabScreen(modifier: Modifier = Modifier) {
    val viewModel: VoucherViewModel = koinInject()

    MyVouchersScreen(
        viewModel = viewModel,
        onDiscoverClick = {
            // TODO Phase 2.2: Navigate to Discover Merchants screen
            println("[ShopTabScreen] Navigate to Discover Merchants")
        },
        onVoucherClick = { voucher ->
            // TODO Phase 2: Navigate to Voucher Details screen
            println("[ShopTabScreen] Navigate to voucher details: ${voucher.voucherId}")
        },
    )
}
