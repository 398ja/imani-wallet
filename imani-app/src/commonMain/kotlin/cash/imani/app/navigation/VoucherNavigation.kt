package cash.imani.app.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import cafe.adriel.voyager.core.screen.Screen
import cafe.adriel.voyager.navigator.Navigator
import cafe.adriel.voyager.transitions.SlideTransition
import cash.imani.app.ui.voucher.IssueVoucherScreen
import cash.imani.app.ui.voucher.RedeemVoucherScreen
import cash.imani.app.ui.voucher.ShareVoucherScreen
import cash.imani.app.ui.voucher.VoucherListScreen
import cash.imani.app.ui.voucher.VoucherViewModel

/**
 * Navigation host for voucher screens.
 *
 * Provides navigation between:
 * - Voucher list (main screen)
 * - Issue voucher
 * - Redeem voucher
 * - Share voucher
 *
 * Phase 2: Basic navigation implementation
 * Phase 3: Integration with main app navigation
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
                // Phase 2: Simple click handler
                // Phase 3: Navigate to voucher detail screen
                voucher.token?.let { token ->
                    navigator.push(ShareVoucherScreenNav(token))
                }
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
