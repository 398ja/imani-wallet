package cash.imani.app.ui.settings

import androidx.compose.foundation.background
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.unit.dp
import cash.imani.app.di.koinInject
import cash.imani.app.ui.identity.IdentityUiState
import cash.imani.app.ui.identity.IdentityViewModel
import cash.imani.identity.domain.Identity

/**
 * Settings screen - Single-identity account management.
 *
 * Implements the single-identity model as per marketplace design:
 * - Identity section: Shows npub/nsec, logout
 * - Payment section: Lightning wallet connection (placeholder)
 * - Backup & Security: Encrypted Nostr backups (placeholder)
 * - App Settings: Currency, language, etc. (placeholder)
 * - About: Version, privacy policy, etc.
 *
 * TODO Phase 1.3 Enhancements:
 * - Implement actual clipboard copy
 * - Implement logout functionality (clear storage)
 * - Wire up Lightning wallet connection
 * - Wire up Nostr backup/restore
 *
 * See: project/web-marketplace-ui-implementation.md Phase 1, Task 1.3
 * See: project/web-client-ui-design.md lines 850-905
 *
 * @param modifier Modifier for styling
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(modifier: Modifier = Modifier) {
    // Inject ViewModel
    val identityViewModel: IdentityViewModel = koinInject()
    val uiState by identityViewModel.uiState.collectAsState()

    var showNsecDialog by remember { mutableStateOf(false) }
    var showLogoutDialog by remember { mutableStateOf(false) }

    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
            )
        },
    ) { padding ->
        when (val state = uiState) {
            is IdentityUiState.Loading -> {
                // Loading state
                Column(
                    modifier =
                        Modifier
                            .fillMaxSize()
                            .padding(padding)
                            .padding(16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text("Loading identity...")
                }
            }

            is IdentityUiState.Success -> {
                val activeIdentity = state.identities.firstOrNull()

                if (activeIdentity == null) {
                    // No identity - should navigate to create identity
                    Column(
                        modifier =
                            Modifier
                                .fillMaxSize()
                                .padding(padding)
                                .padding(16.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center,
                    ) {
                        Text("No identity found")
                        Spacer(modifier = Modifier.height(16.dp))
                        Text("Please create or import an identity first")
                    }
                } else {
                    // Show settings with active identity
                    SettingsContent(
                        identity = activeIdentity,
                        onCopyNpub = {
                            // TODO: Implement clipboard copy
                            println("[Settings] Copy npub: ${activeIdentity.toNpub()}")
                        },
                        onViewNsec = {
                            showNsecDialog = true
                        },
                        onLogout = {
                            showLogoutDialog = true
                        },
                        modifier = Modifier.padding(padding),
                    )

                    // Nsec dialog
                    if (showNsecDialog) {
                        ViewNsecDialog(
                            identity = activeIdentity,
                            onDismiss = { showNsecDialog = false },
                        )
                    }

                    // Logout confirmation dialog
                    if (showLogoutDialog) {
                        LogoutConfirmationDialog(
                            onConfirm = {
                                // TODO: Implement logout (clear storage, navigate to create identity)
                                println("[Settings] Logout confirmed")
                                showLogoutDialog = false
                            },
                            onDismiss = { showLogoutDialog = false },
                        )
                    }
                }
            }

            is IdentityUiState.Error -> {
                // Error state
                Column(
                    modifier =
                        Modifier
                            .fillMaxSize()
                            .padding(padding)
                            .padding(16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text("Error: ${state.message}")
                    Spacer(modifier = Modifier.height(16.dp))
                    Button(onClick = { identityViewModel.loadIdentities() }) {
                        Text("Retry")
                    }
                }
            }
        }
    }
}

@Composable
private fun SettingsContent(
    identity: Identity,
    onCopyNpub: () -> Unit,
    onViewNsec: () -> Unit,
    onLogout: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier =
            modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {
        // Identity Section
        SettingsSection(title = "Identity (Single Account)") {
            Card(
                modifier = Modifier.fillMaxWidth(),
                elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            imageVector = Icons.Default.Person,
                            contentDescription = null,
                            modifier = Modifier.size(24.dp),
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = "My Identity",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                        )
                    }

                    Spacer(modifier = Modifier.height(12.dp))

                    // npub display
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = identity.toNpub().take(24) + "...",
                            style = MaterialTheme.typography.bodyMedium,
                            fontFamily = FontFamily.Monospace,
                            modifier = Modifier.weight(1f),
                        )

                        OutlinedButton(onClick = onCopyNpub) {
                            Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("Copy npub")
                        }
                    }

                    Spacer(modifier = Modifier.height(8.dp))

                    // View nsec button
                    OutlinedButton(
                        onClick = onViewNsec,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("View Private Key (nsec)")
                    }

                    Spacer(modifier = Modifier.height(8.dp))

                    // Warning
                    Row(
                        modifier =
                            Modifier
                                .fillMaxWidth()
                                .background(
                                    Color(0xFFFFF3CD),
                                    RoundedCornerShape(4.dp),
                                ).padding(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            imageVector = Icons.Default.Warning,
                            contentDescription = null,
                            tint = Color(0xFFFF9800),
                            modifier = Modifier.size(20.dp),
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = "Never share your nsec (private key)",
                            style = MaterialTheme.typography.bodySmall,
                            color = Color(0xFF856404),
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            // Logout button
            OutlinedButton(
                onClick = onLogout,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Logout")
            }
        }

        // Payment Section (Placeholder)
        SettingsSection(title = "Payment") {
            Card(
                modifier = Modifier.fillMaxWidth(),
                elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "⚡ Lightning Wallet",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                    )

                    Spacer(modifier = Modifier.height(8.dp))

                    Text(
                        text = "Not connected",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )

                    Spacer(modifier = Modifier.height(12.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        OutlinedButton(
                            onClick = { println("[Settings] Add payment method") },
                            modifier = Modifier.weight(1f),
                        ) {
                            Text("+ Add Wallet")
                        }
                    }
                }
            }
        }

        // Backup & Security Section (Placeholder)
        SettingsSection(title = "Backup & Security") {
            Card(
                modifier = Modifier.fillMaxWidth(),
                elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "🔐 Encrypted Nostr Backup",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                    )

                    Spacer(modifier = Modifier.height(8.dp))

                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            imageVector = Icons.Default.CheckCircle,
                            contentDescription = null,
                            tint = Color(0xFF10B981),
                            modifier = Modifier.size(20.dp),
                        )
                        Spacer(modifier = Modifier.width(4.dp))
                        Text(
                            text = "Status: Synced",
                            style = MaterialTheme.typography.bodySmall,
                            color = Color(0xFF10B981),
                        )
                    }

                    Spacer(modifier = Modifier.height(4.dp))

                    Text(
                        text = "Last backup: Never",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )

                    Spacer(modifier = Modifier.height(12.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        OutlinedButton(
                            onClick = { println("[Settings] Backup now") },
                            modifier = Modifier.weight(1f),
                        ) {
                            Text("Backup Now")
                        }

                        OutlinedButton(
                            onClick = { println("[Settings] Restore") },
                            modifier = Modifier.weight(1f),
                        ) {
                            Text("Restore")
                        }
                    }
                }
            }
        }

        // App Settings Section (Placeholder)
        SettingsSection(title = "App Settings") {
            Card(
                modifier = Modifier.fillMaxWidth(),
                elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    SettingRow(label = "Currency Display", value = "USD")
                    SettingRow(label = "Language", value = "English")
                    SettingRow(label = "Notifications", value = "Enabled")
                    SettingRow(label = "Auto-backup", value = "Enabled")
                }
            }
        }

        // About Section
        SettingsSection(title = "About") {
            Column {
                Text(
                    text = "Imani Wallet v1.0.0",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Spacer(modifier = Modifier.height(8.dp))

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    TextButton(onClick = { println("[Settings] Privacy Policy") }) {
                        Text("Privacy Policy")
                    }

                    TextButton(onClick = { println("[Settings] Terms of Service") }) {
                        Text("Terms")
                    }

                    TextButton(onClick = { println("[Settings] Help & Support") }) {
                        Text("Help")
                    }
                }
            }
        }
    }
}

@Composable
private fun SettingsSection(
    title: String,
    content: @Composable () -> Unit,
) {
    Column {
        Text(
            text = title,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.primary,
        )

        Spacer(modifier = Modifier.height(8.dp))

        content()
    }
}

@Composable
private fun SettingRow(
    label: String,
    value: String,
) {
    Row(
        modifier =
            Modifier
                .fillMaxWidth()
                .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = "• $label:",
            style = MaterialTheme.typography.bodyMedium,
        )

        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ViewNsecDialog(
    identity: Identity,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        icon = {
            Icon(
                imageVector = Icons.Default.Warning,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.error,
                modifier = Modifier.size(48.dp),
            )
        },
        title = {
            Text("Private Key (nsec)")
        },
        text = {
            Column {
                Text(
                    text = "⚠️ WARNING: Never share this key!",
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.error,
                    fontWeight = FontWeight.Bold,
                )

                Spacer(modifier = Modifier.height(8.dp))

                Text(
                    text = "Anyone with access to this key can control your identity and funds.",
                    style = MaterialTheme.typography.bodySmall,
                )

                Spacer(modifier = Modifier.height(16.dp))

                // nsec display
                Text(
                    text = identity.toNsec(),
                    style = MaterialTheme.typography.bodyMedium,
                    fontFamily = FontFamily.Monospace,
                    modifier =
                        Modifier
                            .fillMaxWidth()
                            .background(
                                MaterialTheme.colorScheme.surfaceVariant,
                                RoundedCornerShape(4.dp),
                            ).padding(12.dp),
                )
            }
        },
        confirmButton = {
            Button(onClick = onDismiss) {
                Text("Close")
            }
        },
    )
}

@Composable
private fun LogoutConfirmationDialog(
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        icon = {
            Icon(
                imageVector = Icons.Default.Warning,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.error,
            )
        },
        title = {
            Text("Confirm Logout")
        },
        text = {
            Text("Are you sure you want to logout? Make sure you have backed up your private key (nsec) before logging out.")
        },
        confirmButton = {
            Button(onClick = onConfirm) {
                Text("Logout")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel")
            }
        },
    )
}

/**
 * Helper function to convert Identity to npub format.
 *
 * TODO: Move to Identity domain model extension function.
 */
private fun Identity.toNpub(): String {
    // For now, return placeholder
    // In actual implementation, use Bech32 encoding
    return "npub1" + publicKey.take(58)
}

/**
 * Helper function to convert Identity to nsec format.
 *
 * TODO: Move to Identity domain model extension function.
 */
private fun Identity.toNsec(): String {
    // For now, return placeholder
    // In actual implementation, use Bech32 encoding of private key
    return "nsec1" + privateKey.take(58)
}
