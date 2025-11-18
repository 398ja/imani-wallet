package cash.imani.app.ui.voucher

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import cash.imani.voucher.usecases.IssueVoucherRequest

/**
 * Screen for issuing new vouchers.
 *
 * Allows users to specify amount, memo, and expiration for a new voucher.
 * Navigates to share screen on successful issuance.
 */
@Composable
fun IssueVoucherScreen(
    viewModel: VoucherViewModel,
    mintUrl: String = "https://testnut.cashu.space", // Default test mint for Phase 2
    onSuccess: (String) -> Unit, // Navigate to share screen with token
    onCancel: () -> Unit,
) {
    val issueState by viewModel.issueState.collectAsState()

    var amount by remember { mutableStateOf("") }
    var memo by remember { mutableStateOf("") }
    var expiryDays by remember { mutableStateOf("7") }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    // Handle success state
    LaunchedEffect(issueState) {
        when (val state = issueState) {
            is IssueVoucherState.Success -> {
                onSuccess(state.result.token)
                viewModel.resetIssueState()
            }
            is IssueVoucherState.Error -> {
                errorMessage = state.message
            }
            else -> {
                // No action needed for Idle or Issuing states
            }
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        // Header
        Text(
            text = "Issue Voucher",
            style = MaterialTheme.typography.headlineMedium,
        )

        Text(
            text = "Create a new voucher to share",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(Modifier.height(8.dp))

        // Amount field
        OutlinedTextField(
            value = amount,
            onValueChange = { amount = it.filter { c -> c.isDigit() } },
            label = { Text("Amount (sats)") },
            placeholder = { Text("Enter amount in satoshis") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth(),
            isError = amount.isNotBlank() && (amount.toLongOrNull() ?: 0) <= 0,
            supportingText = {
                if (amount.isNotBlank() && (amount.toLongOrNull() ?: 0) <= 0) {
                    Text("Amount must be greater than 0")
                }
            },
        )

        // Memo field
        OutlinedTextField(
            value = memo,
            onValueChange = { memo = it.take(200) }, // Limit to 200 chars
            label = { Text("Memo (optional)") },
            placeholder = { Text("Add a message or description") },
            modifier = Modifier.fillMaxWidth(),
            maxLines = 3,
            supportingText = {
                Text("${memo.length}/200")
            },
        )

        // Expiry field
        OutlinedTextField(
            value = expiryDays,
            onValueChange = { expiryDays = it.filter { c -> c.isDigit() } },
            label = { Text("Expires in (days)") },
            placeholder = { Text("Number of days until expiration") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth(),
            supportingText = {
                val days = expiryDays.toIntOrNull() ?: 0
                when {
                    days == 0 -> Text("Leave empty for no expiration")
                    days == 1 -> Text("Expires in 1 day")
                    else -> Text("Expires in $days days")
                }
            },
        )

        // Mint URL display (read-only for Phase 2)
        OutlinedTextField(
            value = mintUrl,
            onValueChange = { /* read-only */ },
            label = { Text("Mint URL") },
            modifier = Modifier.fillMaxWidth(),
            enabled = false,
            supportingText = {
                Text("Using default test mint for Phase 2")
            },
        )

        // Error message
        errorMessage?.let { error ->
            Text(
                text = error,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
            )
        }

        Spacer(Modifier.weight(1f))

        // Action buttons
        Button(
            onClick = {
                errorMessage = null
                val amountValue = amount.toLongOrNull()
                if (amountValue == null || amountValue <= 0) {
                    errorMessage = "Please enter a valid amount"
                    return@Button
                }

                val request =
                    IssueVoucherRequest(
                        amount = amountValue,
                        unit = "sat",
                        mintUrl = mintUrl,
                        expiresInDays = expiryDays.toIntOrNull()?.takeIf { it > 0 },
                        memo = memo.ifBlank { null },
                        lockToPubkey = null, // Phase 2: No P2PK support in UI yet
                    )

                viewModel.issueVoucher(request)
            },
            modifier = Modifier.fillMaxWidth(),
            enabled = issueState !is IssueVoucherState.Issuing && amount.isNotBlank(),
        ) {
            if (issueState is IssueVoucherState.Issuing) {
                CircularProgressIndicator(
                    modifier = Modifier.size(24.dp),
                    color = MaterialTheme.colorScheme.onPrimary,
                )
            } else {
                Text("Issue Voucher")
            }
        }

        OutlinedButton(
            onClick = onCancel,
            modifier = Modifier.fillMaxWidth(),
            enabled = issueState !is IssueVoucherState.Issuing,
        ) {
            Text("Cancel")
        }
    }
}
