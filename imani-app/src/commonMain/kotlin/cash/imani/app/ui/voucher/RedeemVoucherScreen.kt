package cash.imani.app.ui.voucher

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp

/**
 * Screen for redeeming vouchers from tokens.
 *
 * Allows users to paste a Cashu token to redeem a voucher.
 * Shows success message with amount received on successful redemption.
 */
@Composable
fun RedeemVoucherScreen(
    viewModel: VoucherViewModel,
    // Navigate back to list
    onSuccess: () -> Unit,
    onCancel: () -> Unit,
) {
    val redeemState by viewModel.redeemState.collectAsState()

    var token by remember { mutableStateOf("") }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var showSuccess by remember { mutableStateOf(false) }

    // Handle success state
    LaunchedEffect(redeemState) {
        when (val state = redeemState) {
            is RedeemVoucherState.Success -> {
                showSuccess = true
            }
            is RedeemVoucherState.Error -> {
                errorMessage = state.message
            }
            else -> {
                // No action needed for Idle or Redeeming states
            }
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        // Header
        Text(
            text = "Redeem Voucher",
            style = MaterialTheme.typography.headlineMedium,
        )

        Text(
            text = "Paste a Cashu token to redeem a voucher",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(Modifier.height(8.dp))

        // Success message
        if (showSuccess && redeemState is RedeemVoucherState.Success) {
            val result = (redeemState as RedeemVoucherState.Success).result
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors =
                    CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.primaryContainer,
                    ),
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        text = "✓ Voucher Redeemed Successfully!",
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                    Text(
                        text = "Amount received: ${result.amountReceived} ${result.unit}",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                    result.memo?.let { memo ->
                        Text(
                            text = "Memo: $memo",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onPrimaryContainer,
                        )
                    }
                }
            }

            Spacer(Modifier.weight(1f))

            Button(
                onClick = {
                    viewModel.resetRedeemState()
                    onSuccess()
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Done")
            }
        } else {
            // Token input field
            OutlinedTextField(
                value = token,
                onValueChange = {
                    token = it
                    errorMessage = null
                },
                label = { Text("Cashu Token") },
                placeholder = { Text("cashuA...") },
                modifier = Modifier.fillMaxWidth().height(200.dp),
                maxLines = 8,
                textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                supportingText = {
                    Text("Paste the token received from the sender")
                },
            )

            // Error message
            errorMessage?.let { error ->
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors =
                        CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.errorContainer,
                        ),
                ) {
                    Text(
                        text = error,
                        modifier = Modifier.padding(16.dp),
                        color = MaterialTheme.colorScheme.onErrorContainer,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }

            Spacer(Modifier.weight(1f))

            // Help text
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors =
                    CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant,
                    ),
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(
                        text = "How to redeem:",
                        style = MaterialTheme.typography.titleSmall,
                    )
                    Text(
                        text = "1. Copy the Cashu token from the sender",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        text = "2. Paste it in the field above",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        text = "3. Click 'Redeem' to import the proofs",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            Spacer(Modifier.height(8.dp))

            // Action buttons
            Button(
                onClick = {
                    errorMessage = null
                    if (token.isBlank()) {
                        errorMessage = "Please paste a token"
                        return@Button
                    }
                    if (!token.startsWith("cashuA")) {
                        errorMessage = "Invalid token format. Token must start with 'cashuA'"
                        return@Button
                    }

                    viewModel.redeemVoucher(token)
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = redeemState !is RedeemVoucherState.Redeeming && token.isNotBlank(),
            ) {
                if (redeemState is RedeemVoucherState.Redeeming) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(24.dp),
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                } else {
                    Text("Redeem Voucher")
                }
            }

            OutlinedButton(
                onClick = onCancel,
                modifier = Modifier.fillMaxWidth(),
                enabled = redeemState !is RedeemVoucherState.Redeeming,
            ) {
                Text("Cancel")
            }
        }
    }
}
