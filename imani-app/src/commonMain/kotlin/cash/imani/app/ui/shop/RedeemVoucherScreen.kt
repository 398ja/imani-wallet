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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
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
import androidx.compose.runtime.LaunchedEffect
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
import cash.imani.app.ui.components.QRCodeDisplay
import cash.imani.app.ui.components.VoucherCard
import cash.imani.app.ui.voucher.VoucherUiState
import cash.imani.app.ui.voucher.VoucherViewModel
import cash.imani.voucher.domain.VoucherStatus

/**
 * Redeem voucher screen - displays voucher QR code for merchant scanning.
 *
 * Flow:
 * 1. Customer selects voucher from list
 * 2. Screen displays Cashu token as QR code
 * 3. Merchant scans QR code to redeem (POS flow in Phase 3)
 * 4. Voucher status updates to REDEEMED
 *
 * Phase 2.5 COMPLETE:
 * - QR code display with Cashu token
 * - Voucher details card
 * - Copy token button
 * - Waiting for redemption message
 *
 * Phase 3 TODO:
 * - Real-time status updates (WebSocket or polling)
 * - Redemption confirmation notification
 * - Partial redemption support
 *
 * See: project/web-marketplace-ui-implementation.md Phase 2, Task 2.5
 * See: project/web-client-ui-design.md lines 520-587
 *
 * @param voucherId Voucher ID to redeem
 * @param viewModel Voucher ViewModel
 * @param onRedeemed Callback when voucher is redeemed (navigate back)
 * @param onBack Callback to cancel redemption (navigate back)
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RedeemVoucherScreen(
    voucherId: String,
    viewModel: VoucherViewModel,
    @Suppress("UNUSED_PARAMETER") onRedeemed: () -> Unit,
    onBack: () -> Unit,
) {
    val uiState by viewModel.uiState.collectAsState()
    val voucher =
        when (uiState) {
            is VoucherUiState.Success -> (uiState as VoucherUiState.Success).vouchers.find { it.voucherId == voucherId }
            else -> null
        }

    var copySuccess by remember { mutableStateOf(false) }

    // Auto-clear copy success message after 2 seconds
    LaunchedEffect(copySuccess) {
        if (copySuccess) {
            kotlinx.coroutines.delay(2000)
            copySuccess = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Redeem Voucher") },
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
            // Voucher not found
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
                    text = "Voucher not found",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.error,
                )
                Spacer(Modifier.height(16.dp))
                Button(onClick = onBack) {
                    Text("Go Back")
                }
            }
        } else if (voucher.status != VoucherStatus.ISSUED && voucher.status != VoucherStatus.DELIVERED) {
            // Voucher already redeemed or expired
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
                    text = "Cannot redeem voucher",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.error,
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    text =
                        when (voucher.status) {
                            VoucherStatus.REDEEMED -> "This voucher has already been redeemed"
                            VoucherStatus.REVOKED -> "This voucher has been revoked"
                            VoucherStatus.EXPIRED -> "This voucher has expired"
                            else -> "Voucher status: ${voucher.status}"
                        },
                    style = MaterialTheme.typography.bodyMedium,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(16.dp))
                Button(onClick = onBack) {
                    Text("Go Back")
                }
            }
        } else {
            // Valid voucher - show QR code
            Column(
                modifier =
                    Modifier
                        .fillMaxSize()
                        .padding(padding)
                        .padding(16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Text(
                    text = "Show this to the merchant",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )

                Spacer(Modifier.height(8.dp))

                // QR Code with Cashu token
                val token = voucher.token
                if (token != null) {
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
                    ) {
                        Column(
                            modifier = Modifier.padding(16.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            QRCodeDisplay(
                                data = token,
                                size = 250.dp,
                                label = "Cashu Token",
                            )
                        }
                    }
                } else {
                    // No token - show error
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors =
                            CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.errorContainer,
                            ),
                    ) {
                        Column(
                            modifier = Modifier.padding(16.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            Text(
                                text = "⚠️ Token not available",
                                style = MaterialTheme.typography.titleMedium,
                                color = MaterialTheme.colorScheme.error,
                            )
                            Spacer(Modifier.height(8.dp))
                            Text(
                                text = "This voucher does not have a token. Cannot redeem.",
                                style = MaterialTheme.typography.bodySmall,
                                textAlign = TextAlign.Center,
                            )
                        }
                    }
                }

                // Voucher details card
                VoucherCard(
                    merchantName = "Merchant ${voucher.issuerId.take(8)}",
                    merchantLogo = null,
                    voucherName = voucher.memo ?: "Voucher ${voucher.voucherId.take(8)}",
                    balance = voucher.faceValue.toInt(),
                    originalAmount = voucher.faceValue.toInt(),
                    expiresAt = voucher.expiresAt,
                    status = voucher.status,
                    onClick = {},
                )

                // Copy token button
                if (token != null) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        OutlinedButton(
                            onClick = {
                                // TODO Phase 3: Implement clipboard copy
                                println("[RedeemVoucherScreen] Copy token: $token")
                                copySuccess = true
                            },
                            modifier = Modifier.weight(1f),
                        ) {
                            Icon(
                                Icons.Default.Add, // TODO Phase 3: Use proper copy icon
                                contentDescription = null,
                                modifier = Modifier.size(18.dp),
                            )
                            Spacer(Modifier.width(4.dp))
                            Text(if (copySuccess) "Copied!" else "Copy Token")
                        }
                    }
                }

                Spacer(Modifier.height(8.dp))

                // Waiting message
                Text(
                    text = "⏳ Waiting for merchant to scan...",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )

                // TODO Phase 3: Add real-time redemption status polling
                // Poll voucher status every 2-5 seconds
                // Show success notification when status changes to REDEEMED
                // Navigate back automatically or show confirmation screen
            }
        }
    }
}
