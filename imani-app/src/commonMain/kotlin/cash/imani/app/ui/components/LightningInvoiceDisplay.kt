package cash.imani.app.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

/**
 * Payment status for Lightning invoices.
 *
 * States:
 * - PENDING: Waiting for payment
 * - PAID: Payment received and confirmed
 * - EXPIRED: Invoice expired before payment
 */
enum class PaymentStatus {
    PENDING,
    PAID,
    EXPIRED,
}

/**
 * Lightning invoice display component.
 *
 * Displays a Lightning invoice with:
 * - QR code for scanning
 * - Amount in sats
 * - Quick links to open in popular wallets
 * - Real-time payment status polling
 *
 * Automatically polls for payment confirmation every 2 seconds
 * until payment is received or invoice expires.
 *
 * TODO Phase 2.4: Integrate with CheckInvoicePaidUseCase
 *   Currently uses mock polling logic.
 *   Need to wire up actual NUT-04 invoice checking.
 *
 * See: project/web-marketplace-ui-implementation.md Phase 1, Task 1.2
 * See: project/web-client-ui-design.md lines 1324-1442
 *
 * @param invoice Lightning invoice (lnbc...)
 * @param amount Invoice amount in sats
 * @param onPaymentReceived Callback when payment is confirmed
 * @param modifier Modifier for styling
 */
@Composable
fun LightningInvoiceDisplay(
    invoice: String,
    amount: Int,
    onPaymentReceived: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var paymentStatus by remember { mutableStateOf(PaymentStatus.PENDING) }

    // Poll for payment confirmation
    LaunchedEffect(invoice) {
        while (paymentStatus == PaymentStatus.PENDING) {
            delay(2000) // Poll every 2 seconds

            // TODO Phase 2.4: Replace with actual CheckInvoicePaidUseCase call
            val isPaid = checkInvoicePaid(invoice)

            if (isPaid) {
                paymentStatus = PaymentStatus.PAID
                onPaymentReceived()
            }

            // TODO Phase 2.4: Add timeout logic (e.g., 15 minutes)
            // if (System.currentTimeMillis() > invoiceExpiryTime) {
            //     paymentStatus = PaymentStatus.EXPIRED
            // }
        }
    }

    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = modifier.fillMaxWidth(),
    ) {
        Text(
            text = "Scan with your Lightning wallet",
            style = MaterialTheme.typography.titleMedium,
        )

        Spacer(modifier = Modifier.height(16.dp))

        // QR Code
        QRCodeDisplay(data = invoice, size = 250.dp)

        Spacer(modifier = Modifier.height(16.dp))

        // Amount
        Text(
            text = "$amount sat",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            color = Color(0xFFF59E0B), // Imani Gold
        )

        Spacer(modifier = Modifier.height(24.dp))

        // Quick links to open in wallets
        Text(
            text = "Or open in:",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(modifier = Modifier.height(8.dp))

        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedButton(onClick = { openInWallet("alby", invoice) }) {
                Text("Alby")
            }
            OutlinedButton(onClick = { openInWallet("zeus", invoice) }) {
                Text("Zeus")
            }
            OutlinedButton(onClick = { openInWallet("phoenix", invoice) }) {
                Text("Phoenix")
            }
        }

        Spacer(modifier = Modifier.height(24.dp))

        // Payment status indicator
        when (paymentStatus) {
            PaymentStatus.PENDING -> {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp))
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = "Waiting for payment...",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }

            PaymentStatus.PAID -> {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        imageVector = Icons.Default.CheckCircle,
                        contentDescription = null,
                        tint = Color(0xFF10B981), // Green
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = "Payment received!",
                        style = MaterialTheme.typography.bodyMedium,
                        color = Color(0xFF10B981),
                    )
                }
            }

            PaymentStatus.EXPIRED -> {
                Text(
                    text = "Invoice expired. Please try again.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

/**
 * Check if Lightning invoice has been paid.
 *
 * TODO Phase 2.4: Replace with actual implementation.
 * This should call CheckInvoicePaidUseCase which queries the mint API (NUT-04).
 *
 * @param invoice Lightning invoice to check
 * @return true if paid, false otherwise
 */
@Suppress("UNUSED_PARAMETER")
private suspend fun checkInvoicePaid(invoice: String): Boolean {
    // Mock implementation - always returns false for now
    // In Phase 2.4, this will call:
    // return checkInvoicePaidUseCase(invoice).getOrDefault(false)
    return false
}

/**
 * Open Lightning invoice in external wallet app.
 *
 * Uses deep links to open invoice in popular Lightning wallets:
 * - Alby: alby://pay?invoice=lnbc...
 * - Zeus: zeus://pay?invoice=lnbc...
 * - Phoenix: phoenix://pay?invoice=lnbc...
 *
 * TODO Phase 2.4: Implement platform-specific deep link handling.
 * For web: window.location.href = deepLink
 * For Android: Intent with ACTION_VIEW
 *
 * @param wallet Wallet identifier (alby, zeus, phoenix)
 * @param invoice Lightning invoice
 */
private fun openInWallet(
    wallet: String,
    invoice: String,
) {
    val deepLink =
        when (wallet) {
            "alby" -> "alby://pay?invoice=$invoice"
            "zeus" -> "zeus://pay?invoice=$invoice"
            "phoenix" -> "phoenix://pay?invoice=$invoice"
            else -> "lightning:$invoice" // Generic Lightning URI
        }

    // TODO Phase 2.4: Implement actual deep link opening
    println("[LightningInvoiceDisplay] Open in $wallet: $deepLink")

    // For web:
    // window.location.href = deepLink
    //
    // For Android:
    // val intent = Intent(Intent.ACTION_VIEW, Uri.parse(deepLink))
    // context.startActivity(intent)
}
