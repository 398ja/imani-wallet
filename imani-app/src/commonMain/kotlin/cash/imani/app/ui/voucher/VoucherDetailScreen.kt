package cash.imani.app.ui.voucher

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherStatus
import kotlinx.datetime.Instant

/**
 * Voucher detail screen with P2P transfer capability.
 *
 * Features:
 * - Full voucher details display
 * - Send to Friend (P2P transfer)
 * - Redeem at Merchant
 * - QR code display
 * - Token copy functionality
 *
 * Phase 4.1: P2P Voucher Transfers
 * See: project/web-marketplace-ui-implementation.md Phase 4, Task 4.1
 *
 * @param voucherId ID of the voucher to display
 * @param viewModel Voucher ViewModel
 * @param onSendToFriend Callback to send voucher to friend
 * @param onRedeem Callback to redeem voucher at merchant
 * @param onBack Callback to navigate back
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VoucherDetailScreen(
    voucherId: String,
    viewModel: VoucherViewModel,
    onSendToFriend: (StoredVoucher) -> Unit,
    onRedeem: (StoredVoucher) -> Unit,
    onBack: () -> Unit,
) {
    val uiState by viewModel.uiState.collectAsState()
    var showSendDialog by remember { mutableStateOf(false) }

    val voucher = when (val state = uiState) {
        is VoucherUiState.Success -> state.vouchers.find { it.voucherId == voucherId }
        else -> null
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Voucher Details") },
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
        if (voucher == null) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "Voucher not found",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        } else {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .verticalScroll(rememberScrollState())
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                // Voucher amount card
                VoucherAmountCard(voucher = voucher)

                // Voucher details
                VoucherDetailsCard(voucher = voucher)

                // Token preview (if available)
                voucher.token?.let { token ->
                    TokenPreviewCard(token = token)
                }

                Spacer(Modifier.height(8.dp))

                // Action buttons
                if (voucher.status == VoucherStatus.ISSUED) {
                    Button(
                        onClick = { onRedeem(voucher) },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Icon(Icons.Default.Add, contentDescription = null) // TODO: Use QrCode icon
                        Spacer(Modifier.width(8.dp))
                        Text("Redeem at Merchant")
                    }

                    OutlinedButton(
                        onClick = { showSendDialog = true },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = null)
                        Spacer(Modifier.width(8.dp))
                        Text("Send to Friend")
                    }
                } else {
                    // Show status message for non-issued vouchers
                    Card(
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.surfaceVariant,
                        ),
                    ) {
                        Text(
                            text = getStatusMessage(voucher.status),
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.padding(16.dp),
                            textAlign = TextAlign.Center,
                        )
                    }
                }
            }

            // Send voucher dialog
            if (showSendDialog && voucher.token != null) {
                SendVoucherDialog(
                    voucher = voucher,
                    onDismiss = { showSendDialog = false },
                    onSent = {
                        showSendDialog = false
                        onSendToFriend(voucher)
                    },
                )
            }
        }
    }
}

/**
 * Card showing voucher amount prominently.
 */
@Composable
private fun VoucherAmountCard(voucher: StoredVoucher) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = Color(0xFF6B46C1), // Imani Purple
        ),
    ) {
        Column(
            modifier = Modifier.padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = "${voucher.faceValue}",
                style = MaterialTheme.typography.displayLarge,
                fontWeight = FontWeight.Bold,
                color = Color.White,
            )
            Text(
                text = voucher.unit.uppercase(),
                style = MaterialTheme.typography.titleMedium,
                color = Color.White.copy(alpha = 0.8f),
            )
            Spacer(Modifier.height(8.dp))
            StatusBadge(status = voucher.status)
        }
    }
}

/**
 * Card showing voucher details.
 */
@Composable
private fun VoucherDetailsCard(voucher: StoredVoucher) {
    Card(
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = "Details",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )

            DetailRow(label = "ID", value = voucher.voucherId.take(16) + "...")

            voucher.memo?.let { memo ->
                DetailRow(label = "Memo", value = memo)
            }

            DetailRow(
                label = "Issued",
                value = formatInstant(voucher.issuedAt),
            )

            voucher.expiresAt?.let { expiresAt ->
                DetailRow(
                    label = "Expires",
                    value = formatEpochSeconds(expiresAt),
                    valueColor = if (voucher.isExpired()) {
                        MaterialTheme.colorScheme.error
                    } else {
                        null
                    },
                )
            }
        }
    }
}

/**
 * Card showing token preview.
 */
@Composable
private fun TokenPreviewCard(token: String) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
        ) {
            Text(
                text = "Token",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                text = token.take(50) + "...",
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/**
 * Row displaying a label-value pair.
 */
@Composable
private fun DetailRow(
    label: String,
    value: String,
    valueColor: Color? = null,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
            color = valueColor ?: MaterialTheme.colorScheme.onSurface,
        )
    }
}

/**
 * Dialog for sending voucher to a friend.
 *
 * Displays QR code, copy button, and share button.
 */
@Composable
fun SendVoucherDialog(
    voucher: StoredVoucher,
    onDismiss: () -> Unit,
    onSent: () -> Unit,
) {
    Dialog(onDismissRequest = onDismiss) {
        Card(
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(
                modifier = Modifier.padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Text(
                    text = "Share this voucher",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                )

                Text(
                    text = "${voucher.faceValue} ${voucher.unit}",
                    style = MaterialTheme.typography.headlineMedium,
                    color = Color(0xFFF59E0B), // Imani Gold
                    fontWeight = FontWeight.Bold,
                )

                voucher.token?.let { token ->
                    // QR Code placeholder
                    Box(
                        modifier = Modifier
                            .size(200.dp)
                            .background(
                                Color.White,
                                RoundedCornerShape(8.dp),
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        // TODO Phase 4.3: Real QR code with jsQR
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            Icon(
                                Icons.Default.Add, // TODO: Use QrCode icon
                                contentDescription = null,
                                modifier = Modifier.size(80.dp),
                                tint = Color.Black,
                            )
                            Text(
                                text = "QR Code",
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }

                    Spacer(Modifier.height(8.dp))

                    // Token display
                    Card(
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.surfaceVariant,
                        ),
                    ) {
                        Text(
                            text = token.take(40) + "...",
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                            modifier = Modifier.padding(12.dp),
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        OutlinedButton(
                            onClick = {
                                copyToClipboard(token)
                            },
                            modifier = Modifier.weight(1f),
                        ) {
                            Icon(
                                Icons.Default.Add, // TODO: Use ContentCopy icon
                                contentDescription = null,
                                modifier = Modifier.size(18.dp),
                            )
                            Spacer(Modifier.width(4.dp))
                            Text("Copy")
                        }

                        OutlinedButton(
                            onClick = {
                                shareViaSystem(token)
                            },
                            modifier = Modifier.weight(1f),
                        ) {
                            Icon(
                                Icons.Default.Share,
                                contentDescription = null,
                                modifier = Modifier.size(18.dp),
                            )
                            Spacer(Modifier.width(4.dp))
                            Text("Share")
                        }
                    }

                    Button(
                        onClick = onSent,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("Done")
                    }
                }
            }
        }
    }
}

/**
 * Returns a message describing the voucher status.
 */
private fun getStatusMessage(status: VoucherStatus): String = when (status) {
    VoucherStatus.ISSUED -> "This voucher is ready to use"
    VoucherStatus.DELIVERED -> "This voucher has been sent to someone"
    VoucherStatus.REDEEMED -> "This voucher has been redeemed"
    VoucherStatus.REVOKED -> "This voucher has been revoked"
    VoucherStatus.EXPIRED -> "This voucher has expired"
}

/**
 * Formats Instant to readable date string.
 */
private fun formatInstant(instant: Instant): String {
    return instant.toString().substring(0, 10)
}

/**
 * Formats epoch seconds to readable date string.
 */
private fun formatEpochSeconds(epochSeconds: Long): String {
    val instant = Instant.fromEpochSeconds(epochSeconds)
    return formatInstant(instant)
}

/**
 * Copies text to clipboard.
 * Platform-specific implementation.
 */
expect fun copyToClipboard(text: String)

/**
 * Shares text via system share sheet.
 * Platform-specific implementation.
 */
expect fun shareViaSystem(text: String)
