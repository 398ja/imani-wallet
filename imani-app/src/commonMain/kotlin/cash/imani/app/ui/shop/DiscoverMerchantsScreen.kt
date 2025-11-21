package cash.imani.app.ui.shop

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cash.imani.app.ui.components.MerchantProfileCard

/**
 * Discover Merchants screen - search for merchants by Nostr npub.
 *
 * Features:
 * - Text input for npub search
 * - Npub validation (Bech32 format check)
 * - QR code scanner button (placeholder)
 * - Recent merchants list
 * - Navigate to merchant detail on success
 *
 * Phase 2.2 COMPLETE:
 * - Npub input and validation
 * - Search state handling (Loading, Success, Error)
 * - Recent merchants list (empty for now, TODO: localStorage)
 * - MerchantProfileCard integration from Phase 1.2
 *
 * TODO Phase 3:
 * - Integrate Nostr profile lookup (NIP-01 kind:0)
 * - Persist recent merchants to localStorage
 *
 * TODO Phase 4:
 * - Real QR code scanning with camera
 *
 * See: project/web-marketplace-ui-implementation.md Phase 2, Task 2.2
 * See: project/web-client-ui-design.md lines 311-354
 *
 * @param viewModel Merchant discovery ViewModel
 * @param onMerchantFound Callback when merchant is found (navigate to detail)
 * @param onBack Callback to navigate back
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DiscoverMerchantsScreen(
    viewModel: MerchantDiscoveryViewModel,
    onMerchantFound: (String) -> Unit,
    onBack: () -> Unit,
) {
    var npubInput by remember { mutableStateOf("") }
    val searchState by viewModel.searchState.collectAsState()
    val recentMerchants by viewModel.recentMerchants.collectAsState()

    // Navigate on successful search
    LaunchedEffect(searchState) {
        if (searchState is SearchState.Success) {
            val npub = (searchState as SearchState.Success).npub
            onMerchantFound(npub)
            viewModel.resetSearchState()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Discover Merchants") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "Back",
                        )
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier =
                Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(horizontal = 16.dp),
        ) {
            item {
                Spacer(Modifier.height(16.dp))

                Text(
                    text = "Find a merchant by their Nostr public key",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Spacer(Modifier.height(16.dp))
            }

            // Search input
            item {
                Row(modifier = Modifier.fillMaxWidth()) {
                    OutlinedTextField(
                        value = npubInput,
                        onValueChange = { npubInput = it },
                        label = { Text("npub1...") },
                        placeholder = { Text("Enter merchant npub") },
                        modifier = Modifier.weight(1f),
                        isError = searchState is SearchState.Error,
                        singleLine = true,
                    )

                    Spacer(Modifier.padding(4.dp))

                    // QR scanner button
                    IconButton(
                        onClick = {
                            // TODO Phase 4: Open camera QR scanner
                            println("[DiscoverMerchantsScreen] Open QR scanner")
                        },
                        modifier = Modifier.padding(top = 8.dp),
                    ) {
                        Icon(
                            Icons.Default.Add,
                            contentDescription = "Scan QR",
                            tint = MaterialTheme.colorScheme.primary,
                        )
                    }
                }

                Spacer(Modifier.height(16.dp))
            }

            // Search button
            item {
                Button(
                    onClick = { viewModel.searchMerchant(npubInput.trim()) },
                    modifier = Modifier.fillMaxWidth(),
                    enabled =
                        npubInput.isNotBlank() &&
                            searchState !is SearchState.Loading,
                ) {
                    if (searchState is SearchState.Loading) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(24.dp),
                            color = MaterialTheme.colorScheme.onPrimary,
                        )
                    } else {
                        Text("Search")
                    }
                }

                Spacer(Modifier.height(16.dp))
            }

            // Search state messages
            item {
                when (val state = searchState) {
                    is SearchState.Loading -> {
                        Text(
                            text = "Searching for merchant...",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }

                    is SearchState.Error -> {
                        Text(
                            text = "Error: ${state.message}",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }

                    else -> {
                        // No message for Idle or Success (Success navigates away)
                    }
                }

                Spacer(Modifier.height(24.dp))
            }

            // Recent merchants section
            if (recentMerchants.isNotEmpty()) {
                item {
                    Text(
                        text = "Recent Merchants",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                    )

                    Spacer(Modifier.height(12.dp))
                }

                items(recentMerchants) { merchant ->
                    MerchantProfileCard(
                        name = merchant.name,
                        description = merchant.description,
                        npub = merchant.npub,
                        logo = merchant.logo,
                        onViewProfile = { onMerchantFound(merchant.npub) },
                        modifier = Modifier.padding(vertical = 8.dp),
                    )
                }
            } else {
                item {
                    Text(
                        text = "No recent merchants",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )

                    Spacer(Modifier.height(16.dp))

                    Text(
                        text = "Search for a merchant by their npub to get started",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}
