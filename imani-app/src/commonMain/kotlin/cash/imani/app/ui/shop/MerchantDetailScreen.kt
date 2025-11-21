package cash.imani.app.ui.shop

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import cash.imani.voucher.domain.MerchantOffer

/**
 * Merchant detail screen - shows merchant profile and available offers.
 *
 * Features:
 * - Merchant profile header (name, description, npub, logo)
 * - Favorite toggle button
 * - Copy npub button
 * - Show QR code button (placeholder)
 * - List of active offers
 * - [Buy] button for each offer → navigate to purchase screen
 * - Empty state if no offers
 *
 * Phase 2.3 COMPLETE:
 * - Merchant profile display (placeholder data)
 * - Offers list using DiscoverMerchantOffersUseCase
 * - Favorite toggle (in-memory)
 * - Copy npub action (placeholder)
 * - Show QR action (placeholder)
 * - Navigation to purchase screen
 *
 * TODO Phase 3:
 * - Load actual merchant profile from Nostr (NIP-01 kind:0)
 * - Implement clipboard copy
 * - Implement QR code dialog
 * - Persist favorites to localStorage
 *
 * See: project/web-marketplace-ui-implementation.md Phase 2, Task 2.3
 * See: project/web-client-ui-design.md lines 357-416
 *
 * @param merchantNpub Merchant's Nostr public key (npub format)
 * @param viewModel Merchant detail ViewModel
 * @param onPurchaseOffer Callback when [Buy] button is clicked (navigate to purchase screen)
 * @param onBack Callback to navigate back
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MerchantDetailScreen(
    merchantNpub: String,
    viewModel: MerchantDetailViewModel,
    onPurchaseOffer: (String) -> Unit,
    onBack: () -> Unit,
) {
    val merchantProfile by viewModel.merchantProfile.collectAsState()
    val offers by viewModel.offers.collectAsState()
    val isFavorite by viewModel.isFavorite.collectAsState()
    val loading by viewModel.loading.collectAsState()
    val error by viewModel.error.collectAsState()

    // Load merchant data on first composition
    LaunchedEffect(merchantNpub) {
        viewModel.loadMerchant(merchantNpub)
        viewModel.loadOffers(merchantNpub)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(merchantProfile?.name ?: "Merchant") },
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
        if (loading && merchantProfile == null) {
            // Initial loading state
            Column(
                modifier =
                    Modifier
                        .fillMaxSize()
                        .padding(padding),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                CircularProgressIndicator()
                Spacer(Modifier.height(16.dp))
                Text("Loading merchant...")
            }
        } else if (error != null && merchantProfile == null) {
            // Error state
            Column(
                modifier =
                    Modifier
                        .fillMaxSize()
                        .padding(padding)
                        .padding(16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text(
                    text = "Error loading merchant",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.error,
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    text = error ?: "Unknown error",
                    style = MaterialTheme.typography.bodyMedium,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(16.dp))
                Button(onClick = {
                    viewModel.clearError()
                    viewModel.loadMerchant(merchantNpub)
                    viewModel.loadOffers(merchantNpub)
                }) {
                    Text("Retry")
                }
            }
        } else {
            // Success state
            LazyColumn(
                modifier =
                    Modifier
                        .fillMaxSize()
                        .padding(padding),
            ) {
                // Merchant header
                item {
                    MerchantHeader(
                        profile = merchantProfile,
                        isFavorite = isFavorite,
                        onCopyNpub = {
                            // TODO Phase 3: Implement clipboard copy
                            println("[MerchantDetailScreen] Copy npub: $merchantNpub")
                        },
                        onShowQR = {
                            // TODO Phase 3: Show QR code dialog
                            println("[MerchantDetailScreen] Show QR for npub: $merchantNpub")
                        },
                        onFavorite = { viewModel.toggleFavorite() },
                    )
                }

                item {
                    HorizontalDivider(modifier = Modifier.padding(vertical = 16.dp))
                }

                // Offers section header
                item {
                    Text(
                        text = "Available Vouchers (${offers.size})",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                }

                // Offers list or empty state
                if (offers.isEmpty()) {
                    item {
                        EmptyOffersState(
                            modifier = Modifier.padding(16.dp),
                        )
                    }
                } else {
                    items(offers) { offer ->
                        OfferCard(
                            offer = offer,
                            onBuyClick = { onPurchaseOffer(offer.offerId) },
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                        )
                    }
                }
            }
        }
    }
}

/**
 * Merchant profile header component.
 *
 * Displays:
 * - Merchant logo (placeholder for Phase 2)
 * - Name and description
 * - Truncated npub
 * - Action buttons: Copy npub, Show QR, Favorite
 *
 * @param profile Merchant profile (nullable during loading)
 * @param isFavorite Whether merchant is favorited
 * @param onCopyNpub Callback to copy npub to clipboard
 * @param onShowQR Callback to show QR code
 * @param onFavorite Callback to toggle favorite
 */
@Composable
private fun MerchantHeader(
    profile: MerchantProfile?,
    isFavorite: Boolean,
    onCopyNpub: () -> Unit,
    onShowQR: () -> Unit,
    onFavorite: () -> Unit,
) {
    Card(
        modifier =
            Modifier
                .fillMaxWidth()
                .padding(16.dp),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            // Name and favorite button
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = profile?.name ?: "Loading...",
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.weight(1f),
                )

                IconButton(onClick = onFavorite) {
                    Icon(
                        imageVector = Icons.Default.Star,
                        contentDescription = if (isFavorite) "Unfavorite" else "Favorite",
                        tint =
                            if (isFavorite) {
                                Color(0xFFF59E0B) // Imani Gold
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            },
                    )
                }
            }

            Spacer(Modifier.height(8.dp))

            // Description
            Text(
                text = profile?.description ?: "",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(Modifier.height(12.dp))

            // Npub display
            Text(
                text = "Merchant ID",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text = profile?.npub?.let { if (it.length > 20) it.take(20) + "..." else it } ?: "",
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.Medium,
            )

            Spacer(Modifier.height(16.dp))

            // Action buttons
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedButton(
                    onClick = onCopyNpub,
                    modifier = Modifier.weight(1f),
                ) {
                    Icon(
                        Icons.Default.Add,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(Modifier.width(4.dp))
                    Text("Copy ID")
                }

                OutlinedButton(
                    onClick = onShowQR,
                    modifier = Modifier.weight(1f),
                ) {
                    Icon(
                        Icons.Default.Add,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(Modifier.width(4.dp))
                    Text("Show QR")
                }
            }
        }
    }
}

/**
 * Offer card component.
 *
 * Displays single merchant offer with:
 * - Offer description
 * - Price (with discount badge if applicable)
 * - [Buy for X sat] button
 *
 * @param offer Merchant offer to display
 * @param onBuyClick Callback when [Buy] button is clicked
 * @param modifier Modifier for styling
 */
@Composable
private fun OfferCard(
    offer: MerchantOffer,
    onBuyClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            // Offer description
            Text(
                text = offer.description,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )

            Spacer(Modifier.height(8.dp))

            // Price and discount
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = "${offer.price} ${offer.unit}",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                    color = Color(0xFFF59E0B), // Imani Gold
                )

                // Show discount badge if applicable
                val discount = offer.discountPercentage()
                if (discount > 0) {
                    Card(
                        colors =
                            CardDefaults.cardColors(
                                containerColor = Color(0xFF10B981), // Green
                            ),
                    ) {
                        Text(
                            text = "-$discount%",
                            style = MaterialTheme.typography.labelSmall,
                            color = Color.White,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                        )
                    }
                }
            }

            // Original amount if different from price
            if (offer.amount != offer.price) {
                Text(
                    text = "Value: ${offer.amount} ${offer.unit}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Spacer(Modifier.height(16.dp))

            // Buy button
            Button(
                onClick = onBuyClick,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Buy for ${offer.price} ${offer.unit}")
            }
        }
    }
}

/**
 * Empty state when merchant has no active offers.
 *
 * @param modifier Modifier for styling
 */
@Composable
private fun EmptyOffersState(modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "No active offers",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
        )

        Spacer(Modifier.height(8.dp))

        Text(
            text = "This merchant doesn't have any vouchers for sale right now.",
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
