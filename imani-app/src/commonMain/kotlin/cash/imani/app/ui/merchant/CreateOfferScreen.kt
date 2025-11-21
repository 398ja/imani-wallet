package cash.imani.app.ui.merchant

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/**
 * Create voucher offer screen - merchant creates new offer template.
 *
 * Features:
 * - Voucher name (required)
 * - Description (optional)
 * - Price in sats (required, >0)
 * - Validity period selection (7/30/90 days)
 * - Partial redemption checkbox
 * - Real-time preview card
 *
 * Phase 3.3 COMPLETE:
 * - Form validation
 * - Create + publish to Nostr flow
 * - Preview updates in real-time
 * - Success/error states
 *
 * See: project/web-marketplace-ui-implementation.md Phase 3, Task 3.3
 * See: project/web-client-ui-design.md lines 652-714
 *
 * @param viewModel Create offer ViewModel
 * @param onCreated Callback when offer created successfully (navigate back)
 * @param onCancel Callback to cancel creation (navigate back)
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CreateOfferScreen(
    viewModel: CreateOfferViewModel,
    onCreated: () -> Unit,
    onCancel: () -> Unit,
) {
    val createState by viewModel.createState.collectAsState()
    val validationErrors by viewModel.validationErrors.collectAsState()

    // Form state
    var voucherName by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var price by remember { mutableStateOf("") }
    var validityDays by remember { mutableStateOf(30) }
    var allowPartialRedemption by remember { mutableStateOf(true) }

    // Handle success
    LaunchedEffect(createState) {
        if (createState is CreateOfferState.Success) {
            viewModel.clearState()
            onCreated()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Create Voucher Offer") },
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
        Column(
            modifier =
                Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .verticalScroll(rememberScrollState())
                    .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // Voucher name
            OutlinedTextField(
                value = voucherName,
                onValueChange = { voucherName = it },
                label = { Text("Voucher Name *") },
                supportingText = {
                    Text(
                        validationErrors.nameError
                            ?: "${voucherName.length}/100 characters",
                    )
                },
                isError = validationErrors.nameError != null,
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )

            // Description
            OutlinedTextField(
                value = description,
                onValueChange = { description = it },
                label = { Text("Description (optional)") },
                modifier = Modifier.fillMaxWidth(),
                minLines = 2,
                maxLines = 3,
            )

            // Price
            OutlinedTextField(
                value = price,
                onValueChange = { price = it.filter { c -> c.isDigit() } },
                label = { Text("Price (sat) *") },
                supportingText = {
                    Text(
                        validationErrors.priceError ?: "Amount customer will pay",
                    )
                },
                isError = validationErrors.priceError != null,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )

            // Validity period
            Text(
                text = "Validity Period",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                listOf(7, 30, 90).forEach { days ->
                    FilterChip(
                        selected = validityDays == days,
                        onClick = { validityDays = days },
                        label = { Text("$days days") },
                    )
                }
            }

            // Partial redemption
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Checkbox(
                    checked = allowPartialRedemption,
                    onCheckedChange = { allowPartialRedemption = it },
                )
                Spacer(Modifier.width(8.dp))
                Text("Allow partial redemption")
            }

            Spacer(Modifier.height(8.dp))

            // Preview card
            Text(
                text = "Preview",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
            )

            OfferPreviewCard(
                name = voucherName.ifBlank { "Voucher Name" },
                description = description.ifBlank { "Description" },
                price = price.toIntOrNull() ?: 0,
                validityDays = validityDays,
            )

            Spacer(Modifier.weight(1f))

            // Error message
            if (createState is CreateOfferState.Error) {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors =
                        CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.errorContainer,
                        ),
                ) {
                    Text(
                        text = (createState as CreateOfferState.Error).message,
                        modifier = Modifier.padding(16.dp),
                        color = MaterialTheme.colorScheme.onErrorContainer,
                        textAlign = TextAlign.Center,
                    )
                }
            }

            // Create button
            Button(
                onClick = {
                    viewModel.createOffer(
                        name = voucherName,
                        description = description,
                        price = price.toIntOrNull() ?: 0,
                        validityDays = validityDays,
                        allowPartialRedemption = allowPartialRedemption,
                    )
                },
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .height(56.dp),
                enabled =
                    createState != CreateOfferState.Creating &&
                        createState != CreateOfferState.Publishing &&
                        voucherName.isNotBlank() &&
                        (price.toIntOrNull() ?: 0) > 0,
            ) {
                when (createState) {
                    CreateOfferState.Creating -> {
                        CircularProgressIndicator(
                            modifier = Modifier.height(24.dp),
                            color = MaterialTheme.colorScheme.onPrimary,
                        )
                        Spacer(Modifier.width(8.dp))
                        Text("Creating...")
                    }
                    CreateOfferState.Publishing -> {
                        CircularProgressIndicator(
                            modifier = Modifier.height(24.dp),
                            color = MaterialTheme.colorScheme.onPrimary,
                        )
                        Spacer(Modifier.width(8.dp))
                        Text("Publishing to Nostr...")
                    }
                    else -> {
                        Text("Create Offer")
                    }
                }
            }
        }
    }
}

/**
 * Offer preview card - shows how the offer will appear.
 */
@Composable
fun OfferPreviewCard(
    name: String,
    description: String,
    price: Int,
    validityDays: Int,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = name,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )

            Spacer(Modifier.height(4.dp))

            Text(
                text = "$price sat • Valid $validityDays days",
                style = MaterialTheme.typography.bodyMedium,
                color = Color(0xFFF59E0B), // Imani Gold
            )

            Spacer(Modifier.height(8.dp))

            Text(
                text = description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
