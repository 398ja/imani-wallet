package cash.imani.app.navigation

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * Side navigation rail for tablet/desktop view.
 *
 * Displays three tabs vertically: Shop, Merchant, Settings.
 * Used on tablet (640-1024px) and desktop (>1024px) screens.
 * On mobile (<640px), use BottomNavigation instead.
 *
 * Phase 4.4: Responsive Design Refinement
 * See: project/web-marketplace-ui-implementation.md Phase 4, Task 4.4
 *
 * @param selectedTab Currently selected tab
 * @param onTabSelected Callback when a tab is clicked
 * @param modifier Modifier for styling
 */
@Composable
fun SideNavigation(
    selectedTab: AppTab,
    onTabSelected: (AppTab) -> Unit,
    modifier: Modifier = Modifier,
) {
    NavigationRail(
        modifier = modifier.fillMaxHeight(),
    ) {
        // Top spacer for better visual balance
        Spacer(Modifier.height(16.dp))

        AppTab.entries.forEach { tab ->
            NavigationRailItem(
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
                modifier = Modifier.padding(vertical = 4.dp),
            )
        }

        // Bottom spacer
        Spacer(Modifier.weight(1f))
    }
}
