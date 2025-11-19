package cash.imani.app.ui.identity

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
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
import androidx.compose.ui.unit.dp
import cash.imani.app.util.InputValidator
import cash.imani.app.util.ValidationResult

/**
 * Screen for importing an existing identity.
 *
 * Features:
 * - Tab selection between Mnemonic and Nsec import
 * - Form validation
 * - Loading and error states
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ImportIdentityScreen(
    viewModel: IdentityViewModel,
    onSuccess: () -> Unit,
    onCancel: () -> Unit,
) {
    val importState by viewModel.importState.collectAsState()
    var selectedTab by remember { mutableStateOf(0) }

    LaunchedEffect(Unit) {
        viewModel.resetImportState()
    }

    // Handle success
    LaunchedEffect(importState) {
        if (importState is ImportIdentityState.Success) {
            viewModel.resetImportState()
            onSuccess()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Import Identity") },
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
        Column(
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            // Tab row
            TabRow(selectedTabIndex = selectedTab) {
                Tab(
                    selected = selectedTab == 0,
                    onClick = { selectedTab = 0 },
                    text = { Text("Mnemonic") },
                )
                Tab(
                    selected = selectedTab == 1,
                    onClick = { selectedTab = 1 },
                    text = { Text("Nsec") },
                )
            }

            Box(
                modifier = Modifier.fillMaxSize().padding(16.dp),
            ) {
                when (val state = importState) {
                    is ImportIdentityState.Idle -> {
                        when (selectedTab) {
                            0 -> {
                                ImportFromMnemonicForm(
                                    onImport = { mnemonic, label ->
                                        viewModel.importFromMnemonic(mnemonic, label)
                                    },
                                    onCancel = onCancel,
                                )
                            }

                            1 -> {
                                ImportFromNsecForm(
                                    onImport = { nsec, label ->
                                        viewModel.importFromNsec(nsec, label)
                                    },
                                    onCancel = onCancel,
                                )
                            }
                        }
                    }

                    is ImportIdentityState.Importing -> {
                        Box(
                            modifier = Modifier.fillMaxSize(),
                            contentAlignment = Alignment.Center,
                        ) {
                            CircularProgressIndicator()
                        }
                    }

                    is ImportIdentityState.Success -> {
                        // Handled by LaunchedEffect
                    }

                    is ImportIdentityState.Error -> {
                        Column(
                            modifier = Modifier.fillMaxSize(),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.Center,
                        ) {
                            Text(
                                text = "Import Failed",
                                style = MaterialTheme.typography.titleLarge,
                                color = MaterialTheme.colorScheme.error,
                            )
                            Spacer(Modifier.height(8.dp))
                            Text(
                                text = state.message,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            Spacer(Modifier.height(16.dp))
                            Button(onClick = { viewModel.resetImportState() }) {
                                Text("Try Again")
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * Form for importing from BIP39 mnemonic phrase.
 */
@Composable
fun ImportFromMnemonicForm(
    onImport: (mnemonic: String, label: String) -> Unit,
    onCancel: () -> Unit,
) {
    var mnemonic by remember { mutableStateOf("") }
    var label by remember { mutableStateOf("") }
    var mnemonicError by remember { mutableStateOf<String?>(null) }
    var labelError by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            text = "Import from Recovery Phrase",
            style = MaterialTheme.typography.titleMedium,
        )

        Text(
            text = "Enter your 12 or 24 word recovery phrase",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        OutlinedTextField(
            value = mnemonic,
            onValueChange = {
                mnemonic = it
                mnemonicError = null
            },
            label = { Text("Recovery Phrase") },
            placeholder = { Text("word1 word2 word3 ...") },
            isError = mnemonicError != null,
            supportingText = {
                if (mnemonicError != null) {
                    Text(mnemonicError!!)
                } else {
                    Text("12 or 24 words separated by spaces")
                }
            },
            modifier = Modifier.fillMaxWidth().height(120.dp),
            maxLines = 4,
        )

        OutlinedTextField(
            value = label,
            onValueChange = {
                label = it
                labelError = null
            },
            label = { Text("Label") },
            placeholder = { Text("e.g., Imported Identity") },
            isError = labelError != null,
            supportingText = {
                if (labelError != null) {
                    Text(labelError!!)
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
                onClick = onCancel,
                modifier = Modifier.weight(1f),
            ) {
                Text("Cancel")
            }
            Button(
                onClick = {
                    val mnemonicResult = InputValidator.validateMnemonicFormat(mnemonic)
                    val labelResult = InputValidator.validateLabel(label)

                    mnemonicError = mnemonicResult.getErrorOrNull()
                    labelError = labelResult.getErrorOrNull()

                    if (mnemonicResult.isSuccess() && labelResult.isSuccess()) {
                        onImport(mnemonicResult.getOrNull()!!, labelResult.getOrNull()!!)
                    }
                },
                modifier = Modifier.weight(1f),
            ) {
                Text("Import")
            }
        }
    }
}

/**
 * Form for importing from nsec (Nostr private key).
 */
@Composable
fun ImportFromNsecForm(
    onImport: (nsec: String, label: String) -> Unit,
    onCancel: () -> Unit,
) {
    var nsec by remember { mutableStateOf("") }
    var label by remember { mutableStateOf("") }
    var nsecError by remember { mutableStateOf<String?>(null) }
    var labelError by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            text = "Import from Nsec",
            style = MaterialTheme.typography.titleMedium,
        )

        Text(
            text = "Enter your Nostr private key (nsec1...)",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        OutlinedTextField(
            value = nsec,
            onValueChange = {
                nsec = it
                nsecError = null
            },
            label = { Text("Private Key (nsec)") },
            placeholder = { Text("nsec1...") },
            isError = nsecError != null,
            supportingText = {
                if (nsecError != null) {
                    Text(nsecError!!)
                } else {
                    Text("Bech32-encoded key starting with nsec1")
                }
            },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )

        OutlinedTextField(
            value = label,
            onValueChange = {
                label = it
                labelError = null
            },
            label = { Text("Label") },
            placeholder = { Text("e.g., Imported Identity") },
            isError = labelError != null,
            supportingText = {
                if (labelError != null) {
                    Text(labelError!!)
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
                onClick = onCancel,
                modifier = Modifier.weight(1f),
            ) {
                Text("Cancel")
            }
            Button(
                onClick = {
                    val nsecResult = InputValidator.validateNsecFormat(nsec)
                    val labelResult = InputValidator.validateLabel(label)

                    nsecError = nsecResult.getErrorOrNull()
                    labelError = labelResult.getErrorOrNull()

                    if (nsecResult.isSuccess() && labelResult.isSuccess()) {
                        onImport(nsecResult.getOrNull()!!, labelResult.getOrNull()!!)
                    }
                },
                modifier = Modifier.weight(1f),
            ) {
                Text("Import")
            }
        }
    }
}
