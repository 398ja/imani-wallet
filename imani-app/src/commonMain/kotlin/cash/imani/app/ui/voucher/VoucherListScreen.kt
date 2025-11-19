package cash.imani.app.ui.voucher

import androidx.compose.foundation.background
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherStatus

/**
 * Voucher list screen displaying all issued and received vouchers.
 *
 * Shows vouchers grouped by status with options to issue new vouchers
 * or redeem received vouchers.
 */
@Composable
fun VoucherListScreen(
    viewModel: VoucherViewModel,
    onIssueClick: () -> Unit,
    onRedeemClick: () -> Unit,
    onVoucherClick: (StoredVoucher) -> Unit,
) {
    val uiState by viewModel.uiState.collectAsState()

    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
    ) {
        // Header
        Text(
            text = "Vouchers",
            style = MaterialTheme.typography.headlineMedium,
            modifier = Modifier.padding(bottom = 16.dp),
        )

        // Action buttons
        Row(
            modifier = Modifier.fillMaxWidth().padding(bottom = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Button(
                onClick = onIssueClick,
                modifier = Modifier.weight(1f),
            ) {
                Text("Issue Voucher")
            }

            OutlinedButton(
                onClick = onRedeemClick,
                modifier = Modifier.weight(1f),
            ) {
                Text("Redeem Voucher")
            }
        }

        // Content
        when (val state = uiState) {
            is VoucherUiState.Loading -> {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator()
                }
            }

            is VoucherUiState.Success -> {
                if (state.vouchers.isEmpty()) {
                    // Empty state
                    Box(
                        modifier = Modifier.fillMaxSize(),
                        contentAlignment = Alignment.Center,
                    ) {
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(
                                text = "No vouchers yet",
                                style = MaterialTheme.typography.titleMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(
                                text = "Issue or redeem a voucher to get started",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                } else {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(bottom = 16.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        // Group by status
                        val grouped = state.vouchers.groupBy { it.status }

                        grouped.forEach { (status, vouchers) ->
                            item {
                                Text(
                                    text = status.name.lowercase().replaceFirstChar { it.uppercase() },
                                    style = MaterialTheme.typography.titleMedium,
                                    modifier = Modifier.padding(vertical = 8.dp),
                                )
                            }

                            items(vouchers) { voucher ->
                                VoucherCard(
                                    voucher = voucher,
                                    onClick = { onVoucherClick(voucher) },
                                )
                            }
                        }
                    }
                }
            }

            is VoucherUiState.Error -> {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            text = "Error loading vouchers",
                            style = MaterialTheme.typography.titleMedium,
                            color = MaterialTheme.colorScheme.error,
                        )
                        Text(
                            text = state.message,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
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
 * Card displaying voucher summary information.
 */
@Composable
fun VoucherCard(
    voucher: StoredVoucher,
    onClick: () -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = voucher.memo ?: "Voucher ${voucher.voucherId.take(8)}...",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "${voucher.faceValue} ${voucher.unit}",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.primary,
                    fontWeight = FontWeight.SemiBold,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "Issued: ${formatInstant(voucher.issuedAt)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                voucher.expiresAt?.let { expiresAt ->
                    Text(
                        text = "Expires: ${formatEpochSeconds(expiresAt)}",
                        style = MaterialTheme.typography.bodySmall,
                        color =
                            if (voucher.isExpired()) {
                                MaterialTheme.colorScheme.error
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            },
                    )
                }
            }

            StatusBadge(status = voucher.status)
        }
    }
}

/**
 * Badge displaying voucher status with color coding.
 */
@Composable
fun StatusBadge(status: VoucherStatus) {
    val (color, text) =
        when (status) {
            VoucherStatus.ISSUED -> Color(0xFF2196F3) to "Issued"
            VoucherStatus.DELIVERED -> Color(0xFF00BCD4) to "Delivered"
            VoucherStatus.REDEEMED -> Color(0xFF4CAF50) to "Redeemed"
            VoucherStatus.REVOKED -> Color(0xFFF44336) to "Revoked"
            VoucherStatus.EXPIRED -> Color(0xFF9E9E9E) to "Expired"
        }

    Box(
        modifier =
            Modifier
                .background(color.copy(alpha = 0.1f), RoundedCornerShape(12.dp))
                .padding(horizontal = 12.dp, vertical = 6.dp),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelMedium,
            color = color,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

/**
 * Formats Instant to readable date string.
 */
private fun formatInstant(instant: kotlinx.datetime.Instant): String {
    // Simple formatting for Phase 2
    // Phase 3: Use proper date formatting library
    val date = instant.toString().substring(0, 10) // yyyy-MM-dd
    return date
}

/**
 * Formats epoch seconds to readable date string.
 */
private fun formatEpochSeconds(epochSeconds: Long): String {
    val instant = kotlinx.datetime.Instant.fromEpochSeconds(epochSeconds)
    return formatInstant(instant)
}
