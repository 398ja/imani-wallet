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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import cash.imani.voucher.domain.StoredVoucher

/**
 * POS Redemption screen - merchant scans and redeems customer vouchers.
 *
 * Flow:
 * 1. Scanning → QR scanner or manual token entry
 * 2. VoucherLoaded → Show voucher details, enter redemption amount
 * 3. Redeeming → Processing redemption
 * 4. Success → Show confirmation, option to scan another
 * 5. Error → Show error with retry
 *
 * Phase 3.4 COMPLETE:
 * - Manual token entry (QR scanner placeholder for future)
 * - Voucher details display
 * - Quick fill buttons (10, 25, 50, Full)
 * - Confirm redemption
 * - Success/error states
 *
 * Phase 3.4+ TODO:
 * - Camera QR scanner using HTML5 getUserMedia
 * - Partial redemption with change calculation
 *
 * See: project/web-marketplace-ui-implementation.md Phase 3, Task 3.4
 * See: project/web-client-ui-design.md lines 717-804
 *
 * @param viewModel POS ViewModel
 * @param onRedeemed Callback when redemption complete (navigate back)
 * @param onBack Callback to cancel (navigate back)
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun POSRedemptionScreen(
    viewModel: POSViewModel,
    onRedeemed: () -> Unit,
    onBack: () -> Unit,
) {
    val redemptionState by viewModel.redemptionState.collectAsState()

    when (val state = redemptionState) {
        is RedemptionState.Scanning -> {
            ScannerView(
                onTokenEntered = { token -> viewModel.decodeVoucher(token) },
                onBack = onBack,
            )
        }

        is RedemptionState.Loading -> {
            LoadingView(message = "Decoding voucher...")
        }

        is RedemptionState.VoucherLoaded -> {
            ConfirmRedemptionView(
                voucher = state.voucher,
                onConfirm = { amount -> viewModel.redeemVoucher(amount) },
                onCancel = { viewModel.resetToScanning() },
            )
        }

        is RedemptionState.Redeeming -> {
            LoadingView(message = "Redeeming voucher...")
        }

        is RedemptionState.Success -> {
            RedemptionSuccessView(
                amountRedeemed = state.amount,
                remainingBalance = state.remainingBalance,
                onScanAnother = { viewModel.resetToScanning() },
                onDone = onRedeemed,
            )
        }

        is RedemptionState.Error -> {
            ErrorView(
                message = state.message,
                onRetry = { viewModel.resetToScanning() },
                onBack = onBack,
            )
        }
    }
}

/**
 * Scanner view with manual token entry.
 *
 * TODO Phase 3.4+: Add camera QR scanner using HTML5 getUserMedia
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ScannerView(
    onTokenEntered: (String) -> Unit,
    onBack: () -> Unit,
) {
    var token by remember { mutableStateOf("") }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Scan Voucher") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // QR Scanner placeholder
            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(250.dp),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant,
                ),
            ) {
                Column(
                    modifier = Modifier.fillMaxSize(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Icon(
                        Icons.Default.Add, // TODO: Use QrCodeScanner icon
                        contentDescription = null,
                        modifier = Modifier.size(64.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(16.dp))
                    Text(
                        text = "QR Scanner",
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        text = "Coming in Phase 3.4+",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            Text(
                text = "Or enter token manually",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
            )

            OutlinedTextField(
                value = token,
                onValueChange = { token = it },
                label = { Text("Cashu Token") },
                placeholder = { Text("cashuA...") },
                modifier = Modifier.fillMaxWidth(),
                minLines = 3,
                maxLines = 5,
            )

            Button(
                onClick = { onTokenEntered(token) },
                modifier = Modifier.fillMaxWidth(),
                enabled = token.isNotBlank(),
            ) {
                Text("Verify Token")
            }
        }
    }
}

/**
 * Confirm redemption view with amount selection.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ConfirmRedemptionView(
    voucher: StoredVoucher,
    onConfirm: (Int) -> Unit,
    onCancel: () -> Unit,
) {
    var amount by remember { mutableStateOf("") }
    val maxAmount = voucher.faceValue.toInt()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Confirm Redemption") },
                navigationIcon = {
                    IconButton(onClick = onCancel) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // Voucher details card
            Card(
                modifier = Modifier.fillMaxWidth(),
                elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "Voucher Details",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                    )

                    Spacer(Modifier.height(12.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text("Balance:", style = MaterialTheme.typography.bodyMedium)
                        Text(
                            text = "$maxAmount sat",
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold,
                            color = Color(0xFFF59E0B), // Imani Gold
                        )
                    }

                    voucher.memo?.let { memo ->
                        Spacer(Modifier.height(8.dp))
                        Text(
                            text = memo,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            Spacer(Modifier.height(8.dp))

            // Amount input
            OutlinedTextField(
                value = amount,
                onValueChange = { amount = it.filter { c -> c.isDigit() } },
                label = { Text("Redemption Amount (sat)") },
                supportingText = { Text("Maximum: $maxAmount sat") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )

            // Quick fill buttons
            Text(
                text = "Quick Select",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                val presets = listOf(10, 25, 50, maxAmount)
                presets.forEach { preset ->
                    FilterChip(
                        selected = amount == preset.toString(),
                        onClick = { amount = preset.toString() },
                        label = {
                            Text(if (preset == maxAmount) "Full" else "$preset")
                        },
                        modifier = Modifier.weight(1f),
                    )
                }
            }

            Spacer(Modifier.weight(1f))

            // Confirm button
            Button(
                onClick = { onConfirm(amount.toIntOrNull() ?: 0) },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp),
                enabled = (amount.toIntOrNull() ?: 0) in 1..maxAmount,
            ) {
                Text("Confirm Redeem")
            }
        }
    }
}

/**
 * Redemption success view.
 */
@Composable
private fun RedemptionSuccessView(
    amountRedeemed: Int,
    remainingBalance: Int,
    onScanAnother: () -> Unit,
    onDone: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(
            imageVector = Icons.Default.CheckCircle,
            contentDescription = null,
            tint = Color(0xFF10B981), // Green
            modifier = Modifier.size(80.dp),
        )

        Spacer(Modifier.height(24.dp))

        Text(
            text = "Redemption Successful!",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            color = Color(0xFF10B981),
        )

        Spacer(Modifier.height(16.dp))

        Text(
            text = "Redeemed: $amountRedeemed sat",
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Bold,
        )

        if (remainingBalance > 0) {
            Spacer(Modifier.height(8.dp))
            Text(
                text = "Remaining balance: $remainingBalance sat",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Spacer(Modifier.height(32.dp))

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedButton(
                onClick = onScanAnother,
                modifier = Modifier.weight(1f),
            ) {
                Text("Scan Another")
            }

            Button(
                onClick = onDone,
                modifier = Modifier.weight(1f),
            ) {
                Text("Done")
            }
        }
    }
}

/**
 * Loading view.
 */
@Composable
private fun LoadingView(message: String) {
    Column(
        modifier = Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        CircularProgressIndicator()
        Spacer(Modifier.height(16.dp))
        Text(message)
    }
}

/**
 * Error view.
 */
@Composable
private fun ErrorView(
    message: String,
    onRetry: () -> Unit,
    onBack: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = "Redemption Failed",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.error,
        )

        Spacer(Modifier.height(16.dp))

        Text(
            text = message,
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(Modifier.height(32.dp))

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedButton(
                onClick = onBack,
                modifier = Modifier.weight(1f),
            ) {
                Text("Cancel")
            }

            Button(
                onClick = onRetry,
                modifier = Modifier.weight(1f),
            ) {
                Text("Try Again")
            }
        }
    }
}
