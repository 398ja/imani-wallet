package cash.imani.app.ui.identity

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cash.imani.identity.domain.Identity
import cash.imani.identity.domain.toShortNpub

/**
 * Main screen for displaying list of identities.
 *
 * Features:
 * - LazyColumn with identity cards
 * - FloatingActionButton for creating new identity
 * - Loading/Error/Success states
 * - Active/Inactive status indicators
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun IdentityListScreen(
    viewModel: IdentityViewModel,
    onCreateClick: () -> Unit,
    onImportClick: () -> Unit,
    onIdentityClick: (Identity) -> Unit,
) {
    val uiState by viewModel.uiState.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Identities") },
            )
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick = onCreateClick,
                modifier =
                    Modifier.semantics {
                        contentDescription = "Create Identity"
                    },
            ) {
                Icon(Icons.Default.Add, contentDescription = null)
            }
        },
    ) { padding ->
        when (val state = uiState) {
            is IdentityUiState.Loading -> {
                Box(
                    modifier = Modifier.fillMaxSize().padding(padding),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator()
                }
            }

            is IdentityUiState.Success -> {
                if (state.identities.isEmpty()) {
                    EmptyIdentitiesView(
                        modifier = Modifier.fillMaxSize().padding(padding),
                        onCreateClick = onCreateClick,
                        onImportClick = onImportClick,
                    )
                } else {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize().padding(padding),
                        contentPadding = PaddingValues(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        items(state.identities) { identity ->
                            IdentityCard(
                                identity = identity,
                                onClick = { onIdentityClick(identity) },
                            )
                        }
                    }
                }
            }

            is IdentityUiState.Error -> {
                ErrorView(
                    modifier = Modifier.fillMaxSize().padding(padding),
                    message = state.message,
                    onRetry = { viewModel.loadIdentities() },
                )
            }
        }
    }
}

/**
 * Card displaying identity information.
 */
@Composable
fun IdentityCard(
    identity: Identity,
    onClick: () -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
        ) {
            // Label
            Text(
                text = identity.label,
                style = MaterialTheme.typography.titleMedium,
            )

            Spacer(Modifier.height(8.dp))

            // Public key (npub)
            Text(
                text = identity.toShortNpub(),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )

            Spacer(Modifier.height(12.dp))

            // Status indicator
            Row(
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = Icons.Default.CheckCircle,
                    contentDescription = null,
                    tint =
                        if (identity.isActive()) {
                            Color(0xFF4CAF50)
                        } else {
                            Color.Gray
                        },
                    modifier = Modifier.size(16.dp),
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    text = if (identity.isActive()) "Active" else "Inactive",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/**
 * View shown when no identities exist.
 */
@Composable
fun EmptyIdentitiesView(
    modifier: Modifier = Modifier,
    onCreateClick: () -> Unit,
    onImportClick: () -> Unit,
) {
    Box(
        modifier = modifier,
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = "No identities yet",
                style = MaterialTheme.typography.titleLarge,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                text = "Create or import an identity to get started",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(24.dp))
            Row(
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                TextButton(onClick = onCreateClick) {
                    Text("Create New")
                }
                TextButton(
                    onClick = onImportClick,
                    modifier = Modifier.semantics {
                        contentDescription = "Import Identity"
                    },
                ) {
                    Text("Import Existing")
                }
            }
        }
    }
}

/**
 * Error view with retry button.
 */
@Composable
fun ErrorView(
    modifier: Modifier = Modifier,
    message: String,
    onRetry: () -> Unit,
) {
    Box(
        modifier = modifier,
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = "Error",
                style = MaterialTheme.typography.titleLarge,
                color = MaterialTheme.colorScheme.error,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(16.dp))
            TextButton(onClick = onRetry) {
                Text("Retry")
            }
        }
    }
}
