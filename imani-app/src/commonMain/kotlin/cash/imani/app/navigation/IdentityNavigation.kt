package cash.imani.app.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import cash.imani.app.ui.identity.CreateIdentityScreen
import cash.imani.app.ui.identity.IdentityListScreen
import cash.imani.app.ui.identity.IdentityViewModel
import cash.imani.app.ui.identity.ImportIdentityScreen
import cash.imani.identity.domain.Identity

/**
 * Navigation routes for identity management.
 */
sealed class IdentityRoute {
    data object List : IdentityRoute()

    data object Create : IdentityRoute()

    data object Import : IdentityRoute()

    data class Detail(val identity: Identity) : IdentityRoute()
}

/**
 * Navigation state holder for Identity screens.
 * Manages current route and provides navigation methods.
 *
 * This class is defined in commonMain to enable sharing between platforms:
 * - Web: Uses this directly with remember { IdentityNavState() }
 * - Android: Wraps with rememberSaveable for state persistence
 *
 * Platform-specific savers (like IdentityNavStateSaver) are defined in platform code.
 */
class IdentityNavState {
    var currentRoute by mutableStateOf<IdentityRoute>(IdentityRoute.List)

    val canNavigateBack: Boolean
        get() = currentRoute != IdentityRoute.List

    fun navigateBack() {
        currentRoute = IdentityRoute.List
    }

    fun navigateTo(route: IdentityRoute) {
        currentRoute = route
    }
}

/**
 * Navigation host for identity management screens.
 *
 * Manages navigation state and screen transitions between:
 * - List: Main identity list screen
 * - Create: Create new identity with mnemonic backup
 * - Import: Import identity from mnemonic or nsec
 * - Detail: Identity details (TODO: Phase 4.3)
 *
 * @param viewModel IdentityViewModel for managing identity operations
 * @param navState Optional external navigation state holder.
 *                 If not provided, creates internal state with remember {}.
 *                 Android uses this to inject rememberSaveable-wrapped state.
 *                 Web uses default internal state.
 */
@Composable
fun IdentityNavHost(
    viewModel: IdentityViewModel,
    navState: IdentityNavState = remember { IdentityNavState() },
) {
    when (val route = navState.currentRoute) {
        is IdentityRoute.List -> {
            IdentityListScreen(
                viewModel = viewModel,
                onCreateClick = {
                    navState.navigateTo(IdentityRoute.Create)
                },
                onImportClick = {
                    navState.navigateTo(IdentityRoute.Import)
                },
                onIdentityClick = { identity ->
                    navState.navigateTo(IdentityRoute.Detail(identity))
                },
            )
        }

        is IdentityRoute.Create -> {
            CreateIdentityScreen(
                viewModel = viewModel,
                onSuccess = {
                    navState.navigateBack()
                },
                onCancel = {
                    navState.navigateBack()
                },
            )
        }

        is IdentityRoute.Import -> {
            ImportIdentityScreen(
                viewModel = viewModel,
                onSuccess = {
                    navState.navigateBack()
                },
                onCancel = {
                    navState.navigateBack()
                },
            )
        }

        is IdentityRoute.Detail -> {
            // TODO: Implement identity detail screen in Phase 4.3
            // For now, navigate back to list
            navState.navigateBack()
        }
    }
}
