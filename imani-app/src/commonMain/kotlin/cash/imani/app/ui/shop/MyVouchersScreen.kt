package cash.imani.app.ui.shop

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import cash.imani.app.ui.components.VoucherCard
import cash.imani.app.ui.voucher.VoucherUiState
import cash.imani.app.ui.voucher.VoucherViewModel
import cash.imani.voucher.domain.StoredVoucher

/**
 * My Vouchers screen - displays user's vouchers grouped by merchant.
 *
 * Features:
 * - Voucher list grouped by merchant (issuerId)
 * - Sort options: expiry (default), merchant, balance
 * - Empty state with CTA to discover merchants
 * - Click voucher → navigate to voucher details
 *
 * Phase 2.1 COMPLETE:
 * - Merchant grouping implemented
 * - Sort menu with 3 options
 * - Empty state with CTA
 * - VoucherCard integration from Phase 1.2
 *
 * See: project/web-marketplace-ui-implementation.md Phase 2, Task 2.1
 * See: project/web-client-ui-design.md lines 257-308
 *
 * @param viewModel Voucher management ViewModel
 * @param onDiscoverClick Callback to navigate to merchant discovery
 * @param onVoucherClick Callback when voucher is clicked (navigate to details)
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MyVouchersScreen(
    viewModel: VoucherViewModel,
    onDiscoverClick: () -> Unit,
    onVoucherClick: (StoredVoucher) -> Unit,
) {
    val uiState by viewModel.uiState.collectAsState()
    var sortBy by remember { mutableStateOf(VoucherSortOption.EXPIRY) }
    var showSortMenu by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("My Vouchers") },
                actions = {
                    // Add Merchant button
                    IconButton(onClick = onDiscoverClick) {
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
        when (val state = uiState) {
            is VoucherUiState.Loading -> {
                Box(
                    modifier = Modifier.fillMaxSize().padding(padding),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator()
                }
            }

            is VoucherUiState.Success -> {
                if (state.vouchers.isEmpty()) {
                    EmptyVouchersState(
                        onDiscoverClick = onDiscoverClick,
                        modifier = Modifier.padding(padding),
                    )
                } else {
                    VoucherList(
                        vouchers = state.vouchers,
                        sortBy = sortBy,
                        onVoucherClick = onVoucherClick,
                        modifier = Modifier.padding(padding),
                    )
                }
            }

            is VoucherUiState.Error -> {
                Box(
                    modifier = Modifier.fillMaxSize().padding(padding),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            text = "Failed to load vouchers",
                            style = MaterialTheme.typography.titleMedium,
                            color = MaterialTheme.colorScheme.error,
                        )
                        Spacer(Modifier.height(8.dp))
                        Text(
                            text = state.message,
                            style = MaterialTheme.typography.bodyMedium,
                            textAlign = TextAlign.Center,
                        )
                        Spacer(Modifier.height(16.dp))
                        Button(onClick = { viewModel.loadVouchers() }) {
                            Text("Retry")
                        }
                    }
                }
            }
        }
    }
}

/**
 * Voucher list with merchant grouping and sorting.
 *
 * Groups vouchers by merchant (issuerId) and displays them in sections.
 * Sorts vouchers according to selected option.
 *
 * @param vouchers List of all vouchers
 * @param sortBy Current sort option
 * @param onVoucherClick Callback when voucher is clicked
 * @param modifier Modifier for styling
 */
@Composable
private fun VoucherList(
    vouchers: List<StoredVoucher>,
    sortBy: VoucherSortOption,
    onVoucherClick: (StoredVoucher) -> Unit,
    modifier: Modifier = Modifier,
) {
    // Sort vouchers
    val sortedVouchers = vouchers.sortedWith(sortBy.comparator)

    // Group by merchant
    val groupedVouchers = sortedVouchers.groupBy { it.issuerId }

    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        groupedVouchers.forEach { (merchantId, merchantVouchers) ->
            // Merchant header
            item(key = "header_$merchantId") {
                Text(
                    text = "Merchant: ${merchantId.take(8)}...",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(vertical = 8.dp),
                )
            }

            // Vouchers for this merchant
            items(
                items = merchantVouchers,
                key = { voucher -> voucher.voucherId },
            ) { voucher ->
                VoucherCard(
                    merchantName = "Merchant ${voucher.issuerId.take(8)}",
                    merchantLogo = null, // TODO Phase 4: Merchant logo from Nostr profile
                    voucherName = voucher.memo ?: "Voucher",
                    balance = voucher.faceValue.toInt(), // TODO: Calculate actual balance from proofs
                    originalAmount = voucher.faceValue.toInt(),
                    expiresAt = voucher.expiresAt,
                    status = voucher.status,
                    onClick = { onVoucherClick(voucher) },
                )
            }
        }
    }
}

/**
 * Empty state when no vouchers exist.
 *
 * Shows helpful message and CTA to discover merchants.
 *
 * @param onDiscoverClick Callback to navigate to merchant discovery
 * @param modifier Modifier for styling
 */
@Composable
private fun EmptyVouchersState(
    onDiscoverClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(32.dp),
        ) {
            Text(
                text = "No vouchers yet",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
            )

            Spacer(Modifier.height(16.dp))

            Text(
                text = "Discover merchants and purchase vouchers to get started",
                style = MaterialTheme.typography.bodyMedium,
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(Modifier.height(24.dp))

            Button(
                onClick = onDiscoverClick,
                modifier = Modifier.fillMaxWidth(0.6f),
            ) {
                Icon(Icons.Default.Add, contentDescription = null)
                Spacer(Modifier.padding(4.dp))
                Text("Discover Merchants")
            }
        }
    }
}

/**
 * Sort options for voucher list.
 *
 * Options:
 * - EXPIRY: Sort by expiration date (soonest first)
 * - MERCHANT: Sort by merchant name alphabetically
 * - BALANCE: Sort by current balance (highest first)
 */
enum class VoucherSortOption(
    val label: String,
    val comparator: Comparator<StoredVoucher>,
) {
    EXPIRY(
        label = "Sort by Expiry",
        comparator =
            compareBy(
                nullsLast(),
                { it.expiresAt },
            ),
    ),
    MERCHANT(
        label = "Sort by Merchant",
        comparator = compareBy { it.issuerId },
    ),
    BALANCE(
        label = "Sort by Balance",
        comparator = compareByDescending { it.faceValue },
    ),
}
