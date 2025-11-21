package cash.imani.app.ui.settings

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

/**
 * Settings tab screen - Account management.
 *
 * Wrapper for SettingsScreen to match tab interface.
 *
 * Phase 1.3 COMPLETE:
 * - Single-identity settings implemented
 * - Identity section with npub/nsec display
 * - Payment settings placeholder
 * - Backup & security placeholder
 * - App settings placeholder
 *
 * See: SettingsScreen.kt for full implementation
 * See: project/web-marketplace-ui-implementation.md Phase 1, Task 1.3
 *
 * @param modifier Modifier for styling
 */
@Composable
fun SettingsTabScreen(modifier: Modifier = Modifier) {
    SettingsScreen(modifier = modifier)
}
