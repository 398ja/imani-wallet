package cash.imani.android.ui.navigation

import androidx.compose.runtime.saveable.Saver
import cash.imani.app.navigation.IdentityNavState
import cash.imani.app.navigation.IdentityRoute

/**
 * Android-specific utilities for Identity navigation state persistence.
 *
 * IdentityNavState is defined in commonMain (imani-app) for cross-platform use.
 * This file provides Android-specific Saver implementation for rememberSaveable.
 *
 * Usage:
 * ```kotlin
 * val navState = rememberSaveable(saver = IdentityNavStateSaver) {
 *     IdentityNavState()
 * }
 *
 * BackHandler(enabled = navState.canNavigateBack) {
 *     navState.navigateBack()
 * }
 *
 * IdentityNavHost(viewModel = viewModel, navState = navState)
 * ```
 */

/**
 * Custom Saver for IdentityNavState to preserve across configuration changes.
 *
 * Serialization format:
 * - "list" → IdentityRoute.List
 * - "create" → IdentityRoute.Create
 * - "import" → IdentityRoute.Import
 * - "detail:{id}" → IdentityRoute.Detail (falls back to List if identity not found)
 *
 * Note: Detail route restoration requires fetching the identity by ID,
 * which is deferred to Phase 4.3 when IdentityDetailScreen is implemented.
 */
val IdentityNavStateSaver = Saver<IdentityNavState, String>(
    save = { state ->
        when (val route = state.currentRoute) {
            is IdentityRoute.List -> "list"
            is IdentityRoute.Create -> "create"
            is IdentityRoute.Import -> "import"
            is IdentityRoute.Detail -> "detail:${route.identity.id}"
        }
    },
    restore = { saved ->
        IdentityNavState().apply {
            currentRoute = when {
                saved == "list" -> IdentityRoute.List
                saved == "create" -> IdentityRoute.Create
                saved == "import" -> IdentityRoute.Import
                saved.startsWith("detail:") -> {
                    // TODO Phase 4.3: Restore identity from saved ID
                    // For now, fallback to list (Detail screen not implemented yet)
                    // val identityId = saved.removePrefix("detail:")
                    // IdentityRoute.Detail(fetchIdentityById(identityId))
                    IdentityRoute.List
                }
                else -> IdentityRoute.List
            }
        }
    }
)
