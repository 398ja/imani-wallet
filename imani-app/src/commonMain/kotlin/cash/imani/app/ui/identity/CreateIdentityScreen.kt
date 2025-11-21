package cash.imani.app.ui.identity

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cash.imani.app.util.InputValidator
import cash.imani.app.util.ValidationResult

/**
 * Screen for creating a new identity.
 *
 * Flow:
 * 1. User enters a label
 * 2. Click Create button
 * 3. Mnemonic phrase is displayed
 * 4. User must confirm they've backed up the mnemonic
 * 5. Navigate back to list
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CreateIdentityScreen(
    viewModel: IdentityViewModel,
    onSuccess: () -> Unit,
    onCancel: () -> Unit,
) {
    val createState by viewModel.createState.collectAsState()
    var label by remember { mutableStateOf("") }
    var labelError by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        viewModel.resetCreateState()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Create Identity") },
                navigationIcon = {
                    IconButton(onClick = onCancel) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "Back",
                        )
                    }
                },
            )
        },
    ) { padding ->
        Box(
            modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp),
        ) {
            when (val state = createState) {
                is CreateIdentityState.Idle -> {
                    CreateIdentityForm(
                        label = label,
                        onLabelChange = {
                            label = it
                            labelError = null
                        },
                        labelError = labelError,
                        onCreateClick = {
                            when (val result = InputValidator.validateLabel(label)) {
                                is ValidationResult.Success -> {
                                    viewModel.createIdentity(result.value)
                                }
                                is ValidationResult.Error -> {
                                    labelError = result.message
                                }
                            }
                        },
                        onCancelClick = onCancel,
                    )
                }

                is CreateIdentityState.Creating -> {
                    Box(
                        modifier = Modifier.fillMaxSize(),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator()
                    }
                }

                is CreateIdentityState.Success -> {
                    MnemonicBackupView(
                        mnemonic = state.mnemonic,
                        onConfirm = {
                            viewModel.resetCreateState()
                            onSuccess()
                        },
                    )
                }

                is CreateIdentityState.Error -> {
                    Column(
                        modifier = Modifier.fillMaxSize(),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center,
                    ) {
                        Text(
                            text = "Error",
                            style = MaterialTheme.typography.titleLarge,
                            color = MaterialTheme.colorScheme.error,
                        )
                        Spacer(Modifier.height(8.dp))
                        Text(
                            text = state.message,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Spacer(Modifier.height(16.dp))
                        Button(onClick = { viewModel.resetCreateState() }) {
                            Text("Try Again")
                        }
                    }
                }
            }
        }
    }
}

/**
 * Form for entering identity label.
 */
@Composable
fun CreateIdentityForm(
    label: String,
    onLabelChange: (String) -> Unit,
    labelError: String?,
    onCreateClick: () -> Unit,
    onCancelClick: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            text = "Enter a label for your new identity",
            style = MaterialTheme.typography.titleMedium,
        )

        OutlinedTextField(
            value = label,
            onValueChange = onLabelChange,
            label = { Text("Label") },
            placeholder = { Text("e.g., My Nostr Identity") },
            isError = labelError != null,
            supportingText = {
                if (labelError != null) {
                    Text(labelError)
                } else {
                    Text("1-100 characters")
                }
            },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )

        Spacer(Modifier.height(8.dp))

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedButton(
                onClick = onCancelClick,
                modifier = Modifier.weight(1f),
            ) {
                Text("Cancel")
            }
            Button(
                onClick = onCreateClick,
                modifier = Modifier.weight(1f),
            ) {
                Text("Create")
            }
        }
    }
}

/**
 * View for displaying and backing up the mnemonic phrase.
 */
@Composable
fun MnemonicBackupView(
    mnemonic: String,
    onConfirm: () -> Unit,
) {
    var hasBackedUp by remember { mutableStateOf(false) }
    val words = remember { mnemonic.split(" ") }

    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        // Warning banner
        Card(
            colors =
                CardDefaults.cardColors(
                    containerColor = Color(0xFFFFF8E1),
                ),
        ) {
            Row(
                modifier = Modifier.padding(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = Icons.Default.Warning,
                    contentDescription = null,
                    tint = Color(0xFFF57C00),
                )
                Spacer(Modifier.width(12.dp))
                Text(
                    text = "Save this mnemonic phrase! You'll need it to recover your identity.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Color(0xFFE65100),
                )
            }
        }

        Text(
            text = "Your Recovery Phrase",
            style = MaterialTheme.typography.titleMedium,
        )

        // Mnemonic words grid
        Card(
            colors =
                CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant,
                ),
        ) {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                words.chunked(3).forEach { row ->
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        row.forEach { word ->
                            Text(
                                text = word,
                                style = MaterialTheme.typography.bodyLarge,
                                fontFamily = FontFamily.Monospace,
                                fontWeight = FontWeight.Medium,
                                modifier = Modifier.weight(1f),
                            )
                        }
                        // Fill remaining space if row is incomplete
                        repeat(3 - row.size) {
                            Spacer(Modifier.weight(1f))
                        }
                    }
                }
            }
        }

        // Copy button
        OutlinedButton(
            onClick = {
                // TODO: Implement clipboard copy
                // On web, use: window.navigator.clipboard.writeText(mnemonic)
            },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Copy to Clipboard")
        }

        Spacer(Modifier.height(8.dp))

        // Backup confirmation checkbox
        Row(
            modifier =
                Modifier
                    .fillMaxWidth()
                    .clickable(
                        role = Role.Checkbox,
                        onClick = { hasBackedUp = !hasBackedUp },
                    ),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Checkbox(
                checked = hasBackedUp,
                onCheckedChange = null, // Let the Row handle clicks
            )
            Spacer(Modifier.width(8.dp))
            Text(
                text = "I have securely backed up my recovery phrase",
                style = MaterialTheme.typography.bodyMedium,
            )
        }

        Spacer(Modifier.height(8.dp))

        // Confirm button
        Button(
            onClick = onConfirm,
            enabled = hasBackedUp,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Done")
        }
    }
}
