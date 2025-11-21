package cash.imani.app.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * Settings tab screen - Account management.
 *
 * TODO Phase 1.3: Convert multi-identity UI to single-identity settings:
 * - Remove identity list (Task 1.3)
 * - Show single identity npub/nsec
 * - Add payment settings (Lightning wallet)
 * - Add backup & security settings
 *
 * Current: Placeholder screen
 * After Task 1.3: Single-identity settings with sections for Identity, Payment, Backup
 *
 * See: project/web-marketplace-ui-implementation.md Phase 1, Task 1.3
 *
 * @param modifier Modifier for styling
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsTabScreen(modifier: Modifier = Modifier) {
    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
            )
        },
    ) { padding ->
        Column(
            modifier =
                Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        ) {
            Icon(
                imageVector = Icons.Default.Settings,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(32.dp),
            )

            Text(
                text = "Settings",
                style = MaterialTheme.typography.headlineMedium,
            )

            Text(
                text = "Single-identity settings coming in Task 1.3",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Text(
                text =
                    "• Identity (npub/nsec)\n" +
                        "• Payment (Lightning wallet)\n" +
                        "• Backup & Security (Nostr backups)\n" +
                        "• App Preferences",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
