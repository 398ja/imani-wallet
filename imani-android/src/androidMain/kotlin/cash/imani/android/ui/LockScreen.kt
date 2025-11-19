package cash.imani.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/**
 * Lock screen displayed when app requires biometric authentication.
 *
 * Shows:
 * - Lock icon
 * - App name
 * - Instructions
 * - Retry button (if authentication failed)
 * - Loading spinner (while authenticating)
 *
 * Code Reuse:
 * - Uses Compose Material 3 (≥95% framework reuse)
 * - Reuses ImaniTheme from imani-app module
 */
@Composable
fun LockScreen(
    state: LockScreenState,
    onUnlockClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Scaffold(
        modifier = modifier.fillMaxSize(),
    ) { padding ->
        Box(
            modifier =
                Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(32.dp),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                // Lock Icon
                Icon(
                    imageVector = Icons.Default.Lock,
                    contentDescription = "Locked",
                    modifier = Modifier.size(80.dp),
                    tint = MaterialTheme.colorScheme.primary,
                )

                Spacer(modifier = Modifier.height(16.dp))

                // App Name
                Text(
                    text = "Imani Wallet",
                    style = MaterialTheme.typography.headlineLarge,
                    color = MaterialTheme.colorScheme.onSurface,
                )

                // State-specific content
                when (state) {
                    is LockScreenState.Locked -> {
                        Text(
                            text = "Unlock to continue",
                            style = MaterialTheme.typography.bodyLarge,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            textAlign = TextAlign.Center,
                        )

                        Button(onClick = onUnlockClick) {
                            Text("Unlock with Biometric")
                        }
                    }

                    is LockScreenState.Authenticating -> {
                        Text(
                            text = "Authenticating...",
                            style = MaterialTheme.typography.bodyLarge,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )

                        CircularProgressIndicator(
                            modifier = Modifier.size(48.dp),
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }

                    is LockScreenState.Failed -> {
                        Text(
                            text = "Authentication Failed",
                            style = MaterialTheme.typography.titleMedium,
                            color = MaterialTheme.colorScheme.error,
                            textAlign = TextAlign.Center,
                        )

                        Text(
                            text = state.reason,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            textAlign = TextAlign.Center,
                        )

                        Button(onClick = onUnlockClick) {
                            Text("Try Again")
                        }
                    }

                    is LockScreenState.NotAvailable -> {
                        Text(
                            text = "Biometric Not Available",
                            style = MaterialTheme.typography.titleMedium,
                            color = MaterialTheme.colorScheme.error,
                            textAlign = TextAlign.Center,
                        )

                        Text(
                            text = state.reason,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            textAlign = TextAlign.Center,
                        )

                        Button(onClick = onUnlockClick) {
                            Text("Continue Without Biometric")
                        }
                    }
                }
            }
        }
    }
}

/**
 * State of the lock screen.
 */
sealed class LockScreenState {
    object Locked : LockScreenState()

    object Authenticating : LockScreenState()

    data class Failed(val reason: String) : LockScreenState()

    data class NotAvailable(val reason: String) : LockScreenState()
}
