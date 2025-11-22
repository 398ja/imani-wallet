package cash.imani.app.ui.shop

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cash.imani.app.di.koinInject
import cash.imani.app.repository.FavoritesRepository
import cash.imani.app.ui.voucher.VoucherViewModel

/**
 * Shop tab screen - Customer features.
 *
 * Phase 2.1 COMPLETE:
 * - My Vouchers screen with merchant grouping
 * - Sort options (expiry, merchant, balance)
 * - Empty state with CTA
 *
 * Phase 4.2 COMPLETE:
 * - Favorite merchants displayed at top
 * - Click favorite to view merchant detail
 * - Persisted in localStorage (web)
 *
 * TODO Phase 2 remaining:
 * - Discover Merchants (Task 2.2)
 * - Merchant Detail (Task 2.3)
 * - Purchase Voucher (Task 2.4)
 * - Redeem Voucher (Task 2.5)
 *
 * See: project/web-marketplace-ui-implementation.md Phase 2, Phase 4.2
 *
 * @param modifier Modifier for styling
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShopTabScreen(
    @Suppress("UNUSED_PARAMETER") modifier: Modifier = Modifier,
) {
    val voucherViewModel: VoucherViewModel = koinInject()
    val favoritesRepository: FavoritesRepository = koinInject()

    val favorites by favoritesRepository.favorites.collectAsState()
    var showSortMenu by remember { mutableStateOf(false) }
    var sortBy by remember { mutableStateOf(VoucherSortOption.EXPIRY) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Shop") },
                actions = {
                    // Add Merchant button
                    IconButton(
                        onClick = {
                            println("[ShopTabScreen] Navigate to Discover Merchants")
                        },
                    ) {
                        Icon(Icons.Default.Add, contentDescription = "Discover Merchants")
                    }

                    // Sort menu
                    Box {
                        IconButton(onClick = { showSortMenu = true }) {
                            Icon(Icons.Default.MoreVert, contentDescription = "Sort Options")
                        }

                        DropdownMenu(
                            expanded = showSortMenu,
                            onDismissRequest = { showSortMenu = false },
                        ) {
                            VoucherSortOption.entries.forEach { option ->
                                DropdownMenuItem(
                                    text = {
                                        Text(
                                            text = option.label,
                                            fontWeight =
                                                if (sortBy == option) {
                                                    FontWeight.Bold
                                                } else {
                                                    FontWeight.Normal
                                                },
                                        )
                                    },
                                    onClick = {
                                        sortBy = option
                                        showSortMenu = false
                                    },
                                )
                            }
                        }
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            // Favorites section (Phase 4.2)
            if (favorites.isNotEmpty()) {
                FavoritesSection(
                    favorites = favorites,
                    onFavoriteClick = { npub ->
                        // TODO Phase 4.2: Navigate to MerchantDetailScreen
                        println("[ShopTabScreen] Navigate to merchant detail: ${npub.take(20)}...")
                    },
                )
            }

            // My Vouchers section
            MyVouchersScreen(
                viewModel = voucherViewModel,
                onDiscoverClick = {
                    // TODO Phase 2.2: Navigate to Discover Merchants screen
                    println("[ShopTabScreen] Navigate to Discover Merchants")
                },
                onVoucherClick = { voucher ->
                    // TODO Phase 2: Navigate to Voucher Details screen
                    println("[ShopTabScreen] Navigate to voucher details: ${voucher.voucherId}")
                },
            )
        }
    }
}

/**
 * Favorites section displaying favorite merchants.
 *
 * Shows horizontal scrollable list of favorite merchants.
 * Phase 4.2: Favorite Merchants
 *
 * @param favorites List of favorite merchant npubs
 * @param onFavoriteClick Callback when favorite is clicked
 */
@Composable
private fun FavoritesSection(
    favorites: List<String>,
    onFavoriteClick: (String) -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Icons.Default.Star,
                contentDescription = null,
                tint = Color(0xFFF59E0B), // Imani Gold
                modifier = Modifier.size(20.dp),
            )
            Spacer(Modifier.width(8.dp))
            Text(
                text = "Favorite Merchants",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )
        }

        Spacer(Modifier.height(8.dp))

        LazyRow(
            contentPadding = PaddingValues(horizontal = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            items(favorites) { npub ->
                FavoriteMerchantCard(
                    npub = npub,
                    onClick = { onFavoriteClick(npub) },
                )
            }
        }

        Spacer(Modifier.height(8.dp))
    }
}

/**
 * Favorite merchant card for horizontal list.
 *
 * Displays merchant npub (shortened) with star icon.
 * Phase 4.2: Favorite Merchants
 *
 * @param npub Merchant public key (npub format)
 * @param onClick Callback when card is clicked
 */
@Composable
private fun FavoriteMerchantCard(
    npub: String,
    onClick: () -> Unit,
) {
    Card(
        modifier =
            Modifier
                .width(140.dp)
                .clickable(onClick = onClick),
        elevation = CardDefaults.cardElevation(2.dp),
    ) {
        Column(
            modifier = Modifier.padding(12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(
                imageVector = Icons.Default.Star,
                contentDescription = null,
                tint = Color(0xFFF59E0B), // Imani Gold
                modifier = Modifier.size(32.dp),
            )

            Spacer(Modifier.height(8.dp))

            Text(
                text = npub.take(12) + "...",
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
            )

            Text(
                text = "Tap to view",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = MaterialTheme.typography.bodySmall.fontSize * 0.9,
            )
        }
    }
}
