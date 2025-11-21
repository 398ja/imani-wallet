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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
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
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import cash.imani.app.ui.components.LightningInvoiceDisplay
import cash.imani.voucher.domain.LightningInvoice
import cash.imani.voucher.domain.MerchantOffer

/**
 * Purchase voucher screen - complete Lightning payment flow.
 *
 * Flow:
 * 1. Loading → Load offer details
 * 2. Confirm → Show offer details, [Confirm Purchase] button
 * 3. PaymentPending → Display Lightning invoice QR, poll for payment
 * 4. Success → Show voucher issued confirmation
 * 5. Error → Show error message with retry
 *
 * Phase 2.4 COMPLETE:
 * - Offer confirmation screen
 * - Lightning invoice display with QR code
 * - Payment polling (2s interval, 5min timeout)
 * - Voucher issuance after payment
 * - Success screen with voucher details
 * - Error handling with retry
 *
 * See: project/web-marketplace-ui-implementation.md Phase 2, Task 2.4
 * See: project/web-client-ui-design.md lines 419-517
 *
 * @param offerId Offer ID to purchase
 * @param viewModel Purchase ViewModel
 * @param onSuccess Callback when voucher purchased successfully (navigate back to vouchers)
 * @param onCancel Callback to cancel purchase (navigate back)
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PurchaseVoucherScreen(
    offerId: String,
    viewModel: PurchaseViewModel,
    onSuccess: () -> Unit,
    onCancel: () -> Unit,
) {
    val purchaseState by viewModel.purchaseState.collectAsState()

    // Load offer on first composition
    LaunchedEffect(offerId) {
        viewModel.loadOffer(offerId)
    }

    // Clean up on dispose
    DisposableEffect(Unit) {
        onDispose {
            viewModel.cancel()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Purchase Voucher") },
                navigationIcon = {
                    IconButton(onClick = onCancel) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "Back",
                        )
                    }
                },
            )
        },
    ) { padding ->
        when (val state = purchaseState) {
            is PurchaseState.Loading -> {
                LoadingView(modifier = Modifier.padding(padding))
            }

            is PurchaseState.Confirm -> {
                ConfirmPurchaseView(
                    offer = state.offer,
                    onConfirm = { viewModel.generateInvoice() },
                    onCancel = onCancel,
                    modifier = Modifier.padding(padding),
                )
            }

            is PurchaseState.PaymentPending -> {
                PaymentPendingView(
                    invoice = state.invoice,
                    onPaymentReceived = { viewModel.handlePaymentConfirmed() },
                    modifier = Modifier.padding(padding),
                )
            }

            is PurchaseState.Success -> {
                PurchaseSuccessView(
                    voucher = state.voucher,
                    token = state.token,
                    onDone = onSuccess,
                    modifier = Modifier.padding(padding),
                )
            }

            is PurchaseState.Error -> {
                ErrorView(
                    message = state.message,
                    onRetry = { viewModel.retry() },
                    onCancel = onCancel,
                    modifier = Modifier.padding(padding),
                )
            }
        }
    }
}

/**
 * Loading view - shown while fetching offer or generating invoice.
 */
@Composable
private fun LoadingView(modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        CircularProgressIndicator()
        Spacer(Modifier.height(16.dp))
        Text("Loading...")
    }
}

/**
 * Confirm purchase view - shows offer details and confirm button.
 *
 * @param offer Merchant offer to purchase
 * @param onConfirm Callback when user confirms purchase
 * @param onCancel Callback when user cancels
 * @param modifier Modifier for styling
 */
@Composable
private fun ConfirmPurchaseView(
    offer: MerchantOffer,
    onConfirm: () -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier =
            modifier
                .fillMaxSize()
                .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            text = "Confirm Purchase",
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold,
        )

        Spacer(Modifier.height(8.dp))

        // Offer details card
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

                // Description
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text("Description:", style = MaterialTheme.typography.bodyMedium)
                    Text(
                        text = offer.description,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Bold,
                    )
                }

                Spacer(Modifier.height(8.dp))

                // Value
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text("Value:", style = MaterialTheme.typography.bodyMedium)
                    Text(
                        text = "${offer.amount} ${offer.unit}",
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Bold,
                    )
                }

                Spacer(Modifier.height(8.dp))

                HorizontalDivider()

                Spacer(Modifier.height(8.dp))

                // Price
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("You pay:", style = MaterialTheme.typography.titleMedium)
                    Text(
                        text = "${offer.price} ${offer.unit}",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        color = Color(0xFFF59E0B), // Imani Gold
                    )
                }

                // Show discount if applicable
                val discount = offer.discountPercentage()
                if (discount > 0) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = "You save $discount%!",
                        style = MaterialTheme.typography.bodySmall,
                        color = Color(0xFF10B981), // Green
                    )
                }
            }
        }

        Spacer(Modifier.weight(1f))

        // Action buttons
        Button(
            onClick = onConfirm,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Confirm Purchase")
        }

        OutlinedButton(
            onClick = onCancel,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Cancel")
        }
    }
}

/**
 * Payment pending view - displays Lightning invoice and waits for payment.
 *
 * Uses LightningInvoiceDisplay component from Phase 1.2.
 *
 * @param invoice Lightning invoice to display
 * @param onPaymentReceived Callback when payment is confirmed
 * @param modifier Modifier for styling
 */
@Composable
private fun PaymentPendingView(
    invoice: LightningInvoice,
    onPaymentReceived: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier =
            modifier
                .fillMaxSize()
                .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "Pay Lightning Invoice",
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold,
        )

        Spacer(Modifier.height(24.dp))

        // Use LightningInvoiceDisplay component
        LightningInvoiceDisplay(
            invoice = invoice.paymentRequest,
            amount = invoice.amount,
            onPaymentReceived = onPaymentReceived,
        )
    }
}

/**
 * Purchase success view - shows voucher issued confirmation.
 *
 * @param voucher Issued voucher
 * @param token Cashu token string
 * @param onDone Callback when user dismisses success screen
 * @param modifier Modifier for styling
 */
@Composable
private fun PurchaseSuccessView(
    voucher: cash.imani.voucher.domain.StoredVoucher,
    @Suppress("UNUSED_PARAMETER") token: String,
    onDone: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier =
            modifier
                .fillMaxSize()
                .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        // Success icon
        Icon(
            imageVector = Icons.Default.CheckCircle,
            contentDescription = null,
            tint = Color(0xFF10B981), // Green
            modifier = Modifier.size(80.dp),
        )

        Spacer(Modifier.height(24.dp))

        Text(
            text = "Voucher Purchased!",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            color = Color(0xFF10B981),
        )

        Spacer(Modifier.height(16.dp))

        Text(
            text = "Your voucher has been added to your wallet.",
            style = MaterialTheme.typography.bodyLarge,
            textAlign = TextAlign.Center,
        )

        Spacer(Modifier.height(32.dp))

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
                    Text("Value:", style = MaterialTheme.typography.bodyMedium)
                    Text(
                        text = "${voucher.faceValue} ${voucher.unit}",
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Bold,
                    )
                }

                voucher.memo?.let { memo ->
                    Spacer(Modifier.height(8.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text("Memo:", style = MaterialTheme.typography.bodyMedium)
                        Text(
                            text = memo,
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                }
            }
        }

        Spacer(Modifier.height(32.dp))

        Button(
            onClick = onDone,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("View My Vouchers")
        }
    }
}

/**
 * Error view - shows error message with retry option.
 *
 * @param message Error message to display
 * @param onRetry Callback to retry purchase
 * @param onCancel Callback to cancel and go back
 * @param modifier Modifier for styling
 */
@Composable
private fun ErrorView(
    message: String,
    onRetry: () -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier =
            modifier
                .fillMaxSize()
                .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = "Purchase Failed",
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

        Button(
            onClick = onRetry,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Try Again")
        }

        Spacer(Modifier.height(8.dp))

        OutlinedButton(
            onClick = onCancel,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Cancel")
        }
    }
}
