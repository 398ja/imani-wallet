package cash.imani.app.di

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import org.koin.core.parameter.ParametersDefinition
import org.koin.core.qualifier.Qualifier
import org.koin.mp.KoinPlatformTools

/**
 * Simple Koin helper for Compose Multiplatform.
 *
 * Provides a composable function to inject dependencies from Koin.
 * This is a lightweight alternative to koin-compose library which doesn't
 * fully support Kotlin Multiplatform yet.
 *
 * Phase 1: Simple helper using GlobalContext
 * Phase 2+: Consider migrating to official koin-compose when KMP support improves
 */
@Composable
inline fun <reified T : Any> koinInject(
    qualifier: Qualifier? = null,
    noinline parameters: ParametersDefinition? = null,
): T {
    return remember(qualifier, parameters) {
        KoinPlatformTools.defaultContext().get().get<T>(qualifier, parameters)
    }
}
