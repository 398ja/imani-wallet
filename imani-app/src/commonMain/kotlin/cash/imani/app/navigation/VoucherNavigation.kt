package cash.imani.app.navigation

import androidx.compose.runtime.Composable
import cafe.adriel.voyager.core.screen.Screen
import cafe.adriel.voyager.navigator.Navigator
import cafe.adriel.voyager.transitions.SlideTransition
import cash.imani.app.ui.voucher.IssueVoucherScreen
import cash.imani.app.ui.voucher.RedeemVoucherScreen
import cash.imani.app.ui.voucher.ShareVoucherScreen
import cash.imani.app.ui.voucher.VoucherDetailScreen
import cash.imani.app.ui.voucher.VoucherListScreen
import cash.imani.app.ui.voucher.VoucherViewModel

/**
 * Navigation host for voucher screens.
 *
 * Provides navigation between:
 * - Voucher list (main screen)
 * - Voucher detail (Phase 4.1: P2P transfers)
 * - Issue voucher
 * - Redeem voucher
 * - Share voucher
 *
 * Phase 2: Basic navigation implementation
 * Phase 3: Integration with main app navigation
 * Phase 4.1: P2P voucher transfers with VoucherDetailScreen
 */
@Composable
fun VoucherNavHost(viewModel: VoucherViewModel) {
    Navigator(VoucherListScreenNav(viewModel)) { navigator ->
        SlideTransition(navigator)
    }
}

/**
 * Voucher list screen (main voucher screen).
 */
class VoucherListScreenNav(
    private val viewModel: VoucherViewModel,
) : Screen {
    @Composable
    override fun Content() {
        val navigator = cafe.adriel.voyager.navigator.LocalNavigator.current ?: return

        VoucherListScreen(
            viewModel = viewModel,
            onIssueClick = {
                navigator.push(IssueVoucherScreenNav(viewModel))
            },
            onRedeemClick = {
                navigator.push(RedeemVoucherScreenNav(viewModel))
            },
            onVoucherClick = { voucher ->
                // Phase 4.1: Navigate to voucher detail screen
                navigator.push(VoucherDetailScreenNav(voucher.voucherId, viewModel))
            },
        )
    }
}

/**
 * Issue voucher screen.
 */
class IssueVoucherScreenNav(
    private val viewModel: VoucherViewModel,
) : Screen {
    @Composable
    override fun Content() {
        val navigator = cafe.adriel.voyager.navigator.LocalNavigator.current ?: return

        IssueVoucherScreen(
            viewModel = viewModel,
            onSuccess = { token ->
                // Navigate to share screen
                navigator.replace(ShareVoucherScreenNav(token))
            },
            onCancel = {
                navigator.pop()
            },
        )
    }
}

/**
 * Redeem voucher screen.
 */
class RedeemVoucherScreenNav(
    private val viewModel: VoucherViewModel,
) : Screen {
    @Composable
    override fun Content() {
        val navigator = cafe.adriel.voyager.navigator.LocalNavigator.current ?: return

        RedeemVoucherScreen(
            viewModel = viewModel,
            onSuccess = {
                // Navigate back to list
                navigator.pop()
            },
            onCancel = {
                navigator.pop()
            },
        )
    }
}

/**
 * Share voucher screen.
 */
class ShareVoucherScreenNav(
    private val token: String,
) : Screen {
    @Composable
    override fun Content() {
        val navigator = cafe.adriel.voyager.navigator.LocalNavigator.current ?: return

        ShareVoucherScreen(
            token = token,
            onDone = {
                // Navigate back to list
                navigator.popUntil { screen -> screen is VoucherListScreenNav }
            },
        )
    }
}

/**
 * Voucher detail screen with P2P transfer capability.
 *
 * Phase 4.1: P2P Voucher Transfers
 */
class VoucherDetailScreenNav(
    private val voucherId: String,
    private val viewModel: VoucherViewModel,
) : Screen {
    @Composable
    override fun Content() {
        val navigator = cafe.adriel.voyager.navigator.LocalNavigator.current ?: return

        VoucherDetailScreen(
            voucherId = voucherId,
            viewModel = viewModel,
            onSendToFriend = { voucher ->
                // Mark voucher as delivered/sent
                println("[VoucherDetailScreen] Voucher sent to friend: ${voucher.voucherId}")
                // TODO Phase 4.1+: Update voucher status to DELIVERED
            },
            onRedeem = { voucher ->
                // Navigate to redeem screen (merchant POS)
                println("[VoucherDetailScreen] Redeem voucher: ${voucher.voucherId}")
                // TODO Phase 4.1+: Navigate to merchant POS for redemption
            },
            onBack = {
                navigator.pop()
            },
        )
    }
}
