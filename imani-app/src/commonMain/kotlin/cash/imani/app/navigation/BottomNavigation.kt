package cash.imani.app.navigation

import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

/**
 * Bottom navigation bar for mobile view.
 *
 * Displays three tabs: Shop, Merchant, Settings.
 * Used on mobile devices (<640px width).
 * On tablet/desktop (>640px), use NavigationRail instead.
 *
 * See: project/web-marketplace-ui-implementation.md Phase 1, Task 1.1
 *
 * @param selectedTab Currently selected tab
 * @param onTabSelected Callback when a tab is clicked
 * @param modifier Modifier for styling
 */
@Composable
fun BottomNavigation(
    selectedTab: AppTab,
    onTabSelected: (AppTab) -> Unit,
    modifier: Modifier = Modifier,
) {
    NavigationBar(
        modifier = modifier,
        windowInsets = WindowInsets.navigationBars,
    ) {
        AppTab.entries.forEach { tab ->
            NavigationBarItem(
                selected = selectedTab == tab,
                onClick = { onTabSelected(tab) },
                icon = {
                    Icon(
                        imageVector = tab.icon,
                        contentDescription = tab.label,
                    )
                },
                label = { Text(tab.label) },
                alwaysShowLabel = true,
            )
        }
    }
}
