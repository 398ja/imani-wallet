package cash.imani.app.ui.merchant

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
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
 * Merchant tab screen - Business features.
 *
 * TODO Phase 3: Implement merchant features:
 * - Sales Dashboard (Task 3.1)
 * - Edit Merchant Profile (Task 3.2)
 * - Create Voucher Offer (Task 3.3)
 * - POS Redemption (Task 3.4)
 * - Sales Reports (Task 3.5)
 *
 * See: project/web-marketplace-ui-implementation.md Phase 3
 *
 * @param modifier Modifier for styling
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MerchantTabScreen(modifier: Modifier = Modifier) {
    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text("Merchant") },
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
                imageVector = Icons.Default.Person,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(32.dp),
            )

            Text(
                text = "Merchant",
                style = MaterialTheme.typography.headlineMedium,
            )

            Text(
                text = "Business features coming in Phase 3",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Text(
                text =
                    "• Sales Dashboard\n" +
                        "• Edit Merchant Profile\n" +
                        "• Create Voucher Offers\n" +
                        "• POS Redemption\n" +
                        "• Sales Reports",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
