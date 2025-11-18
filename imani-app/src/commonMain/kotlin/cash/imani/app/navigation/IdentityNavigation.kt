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
 * Navigation host for identity management screens.
 *
 * Manages navigation state and screen transitions.
 */
@Composable
fun IdentityNavHost(viewModel: IdentityViewModel) {
    var currentRoute by remember { mutableStateOf<IdentityRoute>(IdentityRoute.List) }

    when (val route = currentRoute) {
        is IdentityRoute.List -> {
            IdentityListScreen(
                viewModel = viewModel,
                onCreateClick = {
                    currentRoute = IdentityRoute.Create
                },
                onImportClick = {
                    currentRoute = IdentityRoute.Import
                },
                onIdentityClick = { identity ->
                    currentRoute = IdentityRoute.Detail(identity)
                },
            )
        }

        is IdentityRoute.Create -> {
            CreateIdentityScreen(
                viewModel = viewModel,
                onSuccess = {
                    currentRoute = IdentityRoute.List
                },
                onCancel = {
                    currentRoute = IdentityRoute.List
                },
            )
        }

        is IdentityRoute.Import -> {
            ImportIdentityScreen(
                viewModel = viewModel,
                onSuccess = {
                    currentRoute = IdentityRoute.List
                },
                onCancel = {
                    currentRoute = IdentityRoute.List
                },
            )
        }

        is IdentityRoute.Detail -> {
            // TODO: Implement identity detail screen in Phase 2
            // For now, navigate back to list
            currentRoute = IdentityRoute.List
        }
    }
}
