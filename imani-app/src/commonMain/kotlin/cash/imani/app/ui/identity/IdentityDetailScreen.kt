package cash.imani.app.ui.identity

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import cash.imani.app.ui.utils.copyToClipboard
import cash.imani.identity.domain.Identity
import cash.imani.identity.domain.toNpub
import cash.imani.identity.domain.toNsec
import kotlinx.coroutines.launch

/**
 * Screen displaying identity details with npub and nsec keys.
 *
 * Features:
 * - Shows full npub with copy button
 * - Shows nsec with warning and copy button (behind "Show Secret Key" button)
 * - Copy to clipboard functionality
 * - Snackbar feedback for copy actions
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun IdentityDetailScreen(
    identity: Identity,
    onNavigateBack: () -> Unit,
) {
    val snackbarHostState = remember { SnackbarHostState() }
    val coroutineScope = rememberCoroutineScope()
    var showSecretKey by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(identity.label) },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "Back",
                        )
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        Column(
            modifier =
                Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // Public Key (npub) Section
            KeySection(
                title = "Public Key (npub)",
                value = identity.toNpub(),
                onCopy = {
                    coroutineScope.launch {
                        if (copyToClipboard(identity.toNpub())) {
                            snackbarHostState.showSnackbar("Npub copied to clipboard")
                        } else {
                            snackbarHostState.showSnackbar("Failed to copy npub")
                        }
                    }
                },
            )

            // Secret Key (nsec) Section
            if (!showSecretKey) {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors =
                        CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.errorContainer,
                        ),
                ) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                Icons.Default.Warning,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.error,
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                text = "Secret Key",
                                style = MaterialTheme.typography.titleMedium,
                                color = MaterialTheme.colorScheme.onErrorContainer,
                            )
                        }

                        Spacer(Modifier.height(8.dp))

                        Text(
                            text = "Your secret key (nsec) gives full access to your identity. Never share it with anyone.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                        )

                        Spacer(Modifier.height(12.dp))

                        TextButton(
                            onClick = { showSecretKey = true },
                        ) {
                            Text("Show Secret Key")
                        }
                    }
                }
            } else {
                KeySection(
                    title = "Secret Key (nsec)",
                    value = identity.toNsec(),
                    onCopy = {
                        coroutineScope.launch {
                            if (copyToClipboard(identity.toNsec())) {
                                snackbarHostState.showSnackbar("Nsec copied to clipboard")
                            } else {
                                snackbarHostState.showSnackbar("Failed to copy nsec")
                            }
                        }
                    },
                    isSecret = true,
                )

                TextButton(
                    onClick = { showSecretKey = false },
                ) {
                    Text("Hide Secret Key")
                }
            }
        }
    }
}

/**
 * Reusable component for displaying a key with copy button.
 */
@Composable
private fun KeySection(
    title: String,
    value: String,
    onCopy: () -> Unit,
    isSecret: Boolean = false,
) {
    Column {
        Text(
            text = title,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(Modifier.height(8.dp))

        Card(
            modifier = Modifier.fillMaxWidth(),
            colors =
                CardDefaults.cardColors(
                    containerColor =
                        if (isSecret) {
                            MaterialTheme.colorScheme.errorContainer
                        } else {
                            MaterialTheme.colorScheme.surfaceVariant
                        },
                ),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(12.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = value,
                    style = MaterialTheme.typography.bodyMedium,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.weight(1f),
                    color =
                        if (isSecret) {
                            MaterialTheme.colorScheme.onErrorContainer
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                )

                Spacer(Modifier.width(8.dp))

                TextButton(onClick = onCopy) {
                    Text("Copy")
                }
            }
        }
    }
}
