package cash.imani.app.ui.merchant

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/**
 * Edit merchant profile screen - allows merchant to update business info.
 *
 * Features:
 * - Edit business name (1-100 chars)
 * - Edit description (1-500 chars)
 * - Contact info (email, phone, website) - optional
 * - Nostr npub display (read-only)
 * - Logo upload placeholder (TODO Phase 3.2+)
 *
 * Phase 3.2 COMPLETE:
 * - Form validation (name 1-100, desc 1-500)
 * - Field error display
 * - Save with success/error feedback
 *
 * Phase 3.2+ TODO:
 * - Logo upload
 * - Publish to Nostr (NIP-01 kind:0 event)
 *
 * See: project/web-marketplace-ui-implementation.md Phase 3, Task 3.2
 * See: project/web-client-ui-design.md lines 807-846
 *
 * @param viewModel Merchant profile ViewModel
 * @param onSaved Callback when profile saved successfully (navigate back)
 * @param onBack Callback to cancel editing (navigate back)
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EditMerchantProfileScreen(
    viewModel: MerchantProfileViewModel,
    onSaved: () -> Unit,
    onBack: () -> Unit,
) {
    val profile by viewModel.profile.collectAsState()
    val saveState by viewModel.saveState.collectAsState()
    val validationErrors by viewModel.validationErrors.collectAsState()

    // Local form state
    var businessName by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var website by remember { mutableStateOf("") }

    // Load profile on first composition
    LaunchedEffect(Unit) {
        viewModel.loadProfile()
    }

    // Initialize form state from profile
    LaunchedEffect(profile) {
        profile?.let { p ->
            businessName = p.name
            description = p.description
            email = p.email ?: ""
            phone = p.phone ?: ""
            website = p.website ?: ""
        }
    }

    // Handle save success
    LaunchedEffect(saveState) {
        if (saveState == SaveState.Success) {
            viewModel.clearSaveState()
            onSaved()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Edit Merchant Profile") },
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
        if (profile == null) {
            // Loading state
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                CircularProgressIndicator()
                Spacer(Modifier.height(16.dp))
                Text("Loading profile...")
            }
        } else {
            // Edit form
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .verticalScroll(rememberScrollState())
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                // Npub display (read-only)
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant,
                    ),
                ) {
                    Column(modifier = Modifier.padding(16.dp)) {
                        Text(
                            text = "Nostr Public Key",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text = profile?.npub ?: "",
                            style = MaterialTheme.typography.bodySmall,
                            fontWeight = FontWeight.Medium,
                        )
                    }
                }

                Spacer(Modifier.height(8.dp))

                // Business name
                OutlinedTextField(
                    value = businessName,
                    onValueChange = { businessName = it },
                    label = { Text("Business Name *") },
                    supportingText = {
                        Text(
                            validationErrors.nameError
                                ?: "${businessName.length}/100 characters",
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
                    label = { Text("Description *") },
                    supportingText = {
                        Text(
                            validationErrors.descriptionError
                                ?: "${description.length}/500 characters",
                        )
                    },
                    isError = validationErrors.descriptionError != null,
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 3,
                    maxLines = 5,
                )

                Spacer(Modifier.height(8.dp))

                Text(
                    text = "Contact Information (optional)",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                )

                // Email
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it },
                    label = { Text("Email") },
                    supportingText = {
                        validationErrors.emailError?.let { Text(it) }
                    },
                    isError = validationErrors.emailError != null,
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )

                // Phone
                OutlinedTextField(
                    value = phone,
                    onValueChange = { phone = it },
                    label = { Text("Phone") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )

                // Website
                OutlinedTextField(
                    value = website,
                    onValueChange = { website = it },
                    label = { Text("Website") },
                    supportingText = {
                        validationErrors.websiteError?.let { Text(it) }
                            ?: Text("e.g., https://example.com")
                    },
                    isError = validationErrors.websiteError != null,
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )

                Spacer(Modifier.weight(1f))

                // Error message
                if (saveState is SaveState.Error) {
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.errorContainer,
                        ),
                    ) {
                        Text(
                            text = (saveState as SaveState.Error).message,
                            modifier = Modifier.padding(16.dp),
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            textAlign = TextAlign.Center,
                        )
                    }
                }

                // Save button
                Button(
                    onClick = {
                        viewModel.saveProfile(
                            name = businessName,
                            description = description,
                            email = email.ifBlank { null },
                            phone = phone.ifBlank { null },
                            website = website.ifBlank { null },
                        )
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp),
                    enabled = saveState != SaveState.Saving,
                ) {
                    if (saveState == SaveState.Saving) {
                        CircularProgressIndicator(
                            modifier = Modifier.height(24.dp),
                            color = MaterialTheme.colorScheme.onPrimary,
                        )
                    } else {
                        Text("Save Changes")
                    }
                }
            }
        }
    }
}
