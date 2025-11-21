package cash.imani.app.ui.merchant

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
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Refresh
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
import cash.imani.app.ui.components.MerchantProfileCard
import cash.imani.voucher.domain.MerchantOffer
import cash.imani.voucher.domain.SalesMetrics
import cash.imani.voucher.domain.StoredVoucher

/**
 * Sales dashboard screen - merchant homepage with business metrics.
 *
 * Features:
 * - Merchant profile header (name, npub, QR)
 * - Today's sales metrics (vouchers sold, revenue, redemptions)
 * - Active offers list with [Edit] buttons
 * - [+ Create Offer] button
 * - [Scan Voucher to Redeem] POS button
 * - Recent redemptions feed (last 10)
 *
 * Phase 3.1 COMPLETE:
 * - Sales metrics display
 * - Active offers list
 * - Recent redemptions
 * - Navigation placeholders for edit/create/POS
 *
 * Phase 3.2 TODO:
 * - Real merchant profile editing
 * - Logo display
 *
 * Phase 3.3 TODO:
 * - Create offer navigation
 * - Edit offer navigation
 *
 * Phase 3.4 TODO:
 * - POS redemption screen navigation
 *
 * See: project/web-marketplace-ui-implementation.md Phase 3, Task 3.1
 * See: project/web-client-ui-design.md lines 590-649
 *
 * @param viewModel Merchant dashboard ViewModel
 * @param onEditProfile Callback to navigate to edit profile screen
 * @param onCreateOffer Callback to navigate to create offer screen
 * @param onEditOffer Callback to navigate to edit offer screen (offerId)
 * @param onPOSRedeem Callback to navigate to POS redemption screen
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SalesDashboardScreen(
    viewModel: MerchantDashboardViewModel,
    onEditProfile: () -> Unit,
    onCreateOffer: () -> Unit,
    onEditOffer: (String) -> Unit,
    onPOSRedeem: () -> Unit,
) {
    val merchantProfile by viewModel.merchantProfile.collectAsState()
    val todayMetrics by viewModel.todayMetrics.collectAsState()
    val activeOffers by viewModel.activeOffers.collectAsState()
    val recentRedemptions by viewModel.recentRedemptions.collectAsState()
    val loading by viewModel.loading.collectAsState()
    val error by viewModel.error.collectAsState()

    // Load dashboard on first composition
    LaunchedEffect(Unit) {
        viewModel.loadDashboard()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Merchant Dashboard") },
                actions = {
                    IconButton(onClick = { viewModel.refresh() }) {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                    }
                    IconButton(onClick = onEditProfile) {
                        Icon(Icons.Default.Edit, contentDescription = "Edit Profile")
                    }
                },
            )
        },
    ) { padding ->
        if (loading && merchantProfile == null) {
            // Initial loading
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
                Text("Loading dashboard...")
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
                    text = "Error loading dashboard",
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
                    viewModel.loadDashboard()
                }) {
                    Text("Retry")
                }
            }
        } else {
            // Success - show dashboard
            LazyColumn(
                modifier =
                    Modifier
                        .fillMaxSize()
                        .padding(padding),
            ) {
                // Merchant profile header
                item {
                    merchantProfile?.let { profile ->
                        MerchantProfileCard(
                            name = profile.name,
                            description = profile.description,
                            npub = profile.npub,
                            logo = profile.logo,
                            isFavorite = false,
                            onFavoriteClick = {
                                // TODO Phase 3: Implement favorite
                                println("[SalesDashboardScreen] Toggle favorite")
                            },
                            onViewProfile = {
                                // Already on profile page
                                println("[SalesDashboardScreen] View profile (already here)")
                            },
                            modifier = Modifier.padding(16.dp),
                        )
                    }
                }

                // Sales metrics card
                item {
                    todayMetrics?.let { metrics ->
                        SalesMetricsCard(
                            metrics = metrics,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                        )
                    }
                }

                item {
                    HorizontalDivider(modifier = Modifier.padding(vertical = 16.dp))
                }

                // Active offers section
                item {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = "Active Offers (${activeOffers.size})",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                        )
                        Button(onClick = onCreateOffer) {
                            Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(4.dp))
                            Text("Create")
                        }
                    }
                }

                if (activeOffers.isEmpty()) {
                    item {
                        EmptyOffersState(modifier = Modifier.padding(16.dp))
                    }
                } else {
                    items(activeOffers) { offer ->
                        ActiveOfferCard(
                            offer = offer,
                            onEdit = { onEditOffer(offer.offerId) },
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                        )
                    }
                }

                // POS button
                item {
                    Button(
                        onClick = onPOSRedeem,
                        modifier =
                            Modifier
                                .fillMaxWidth()
                                .padding(16.dp)
                                .height(56.dp),
                    ) {
                        Icon(Icons.Default.Add, contentDescription = null) // TODO: Use QrCodeScanner icon
                        Spacer(Modifier.width(8.dp))
                        Text("Scan Voucher to Redeem (POS)")
                    }
                }

                item {
                    HorizontalDivider(modifier = Modifier.padding(vertical = 16.dp))
                }

                // Recent redemptions section
                item {
                    Text(
                        text = "Recent Redemptions (${recentRedemptions.size})",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                }

                if (recentRedemptions.isEmpty()) {
                    item {
                        EmptyRedemptionsState(modifier = Modifier.padding(16.dp))
                    }
                } else {
                    items(recentRedemptions) { voucher ->
                        RedemptionListItem(
                            voucher = voucher,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                        )
                    }
                }
            }
        }
    }
}

/**
 * Sales metrics card - displays today's sales statistics.
 *
 * @param metrics Sales metrics for today
 * @param modifier Modifier for styling
 */
@Composable
fun SalesMetricsCard(
    metrics: SalesMetrics,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = "Today's Performance",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )

            Spacer(Modifier.height(16.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly,
            ) {
                MetricBox(
                    value = "${metrics.totalVouchersIssued}",
                    label = "Sold",
                    modifier = Modifier.weight(1f),
                )
                MetricBox(
                    value = "${metrics.totalRevenue} sat",
                    label = "Revenue",
                    modifier = Modifier.weight(1f),
                )
                MetricBox(
                    value = "${metrics.totalVouchersRedeemed}",
                    label = "Redeemed",
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

/**
 * Metric box - displays a single metric value and label.
 *
 * @param value Metric value to display
 * @param label Metric label
 * @param modifier Modifier for styling
 */
@Composable
fun MetricBox(
    value: String,
    label: String,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = value,
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold,
            color = Color(0xFFF59E0B), // Imani Gold
        )
        Spacer(Modifier.height(4.dp))
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * Active offer card - displays an offer with edit button.
 *
 * @param offer Merchant offer to display
 * @param onEdit Callback when edit button clicked
 * @param modifier Modifier for styling
 */
@Composable
fun ActiveOfferCard(
    offer: MerchantOffer,
    onEdit: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = offer.description,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "${offer.price} ${offer.unit}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color(0xFFF59E0B), // Imani Gold
                )
            }

            OutlinedButton(onClick = onEdit) {
                Text("Edit")
            }
        }
    }
}

/**
 * Redemption list item - displays a single redemption in the feed.
 *
 * @param voucher Redeemed voucher
 * @param modifier Modifier for styling
 */
@Composable
fun RedemptionListItem(
    voucher: StoredVoucher,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = voucher.memo ?: "Voucher ${voucher.voucherId.take(8)}",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "Redeemed", // TODO: Show timestamp
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Text(
                text = "${voucher.faceValue} ${voucher.unit}",
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Bold,
                color = Color(0xFF10B981), // Green
            )
        }
    }
}

/**
 * Empty state when merchant has no active offers.
 *
 * @param modifier Modifier for styling
 */
@Composable
fun EmptyOffersState(modifier: Modifier = Modifier) {
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
            text = "Create your first voucher offer to start selling",
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * Empty state when merchant has no recent redemptions.
 *
 * @param modifier Modifier for styling
 */
@Composable
fun EmptyRedemptionsState(modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "No recent redemptions",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = "Redeemed vouchers will appear here",
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
