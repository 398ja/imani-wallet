package cash.imani.android

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import cash.imani.android.security.BiometricAuthenticator
import cash.imani.android.security.BiometricAvailability
import cash.imani.android.ui.LockScreen
import cash.imani.android.ui.LockScreenState
import cash.imani.android.ui.navigation.MainScreen
import cash.imani.android.ui.theme.ImaniTheme
import kotlinx.coroutines.launch

/**
 * Main Activity for Imani Wallet Android.
 *
 * Features:
 * - Biometric authentication on app launch (Phase 4.2.3)
 * - Lock screen with fingerprint/face unlock
 * - Graceful fallback if biometric not available
 *
 * TODO: Implement full UI navigation in Phase 4.3
 */
class MainActivity : FragmentActivity() {
    private lateinit var biometricAuthenticator: BiometricAuthenticator
    private var isUnlocked = mutableStateOf(false)
    private var lockScreenState = mutableStateOf<LockScreenState>(LockScreenState.Locked)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        biometricAuthenticator = BiometricAuthenticator(this)

        // Check biometric availability on launch
        when (val availability = biometricAuthenticator.canAuthenticate()) {
            is BiometricAvailability.Available -> {
                // Biometric available, show lock screen and authenticate
                lockScreenState.value = LockScreenState.Locked
                authenticateUser()
            }

            is BiometricAvailability.NotEnrolled -> {
                // No biometric enrolled, skip authentication
                lockScreenState.value = LockScreenState.NotAvailable(availability.message)
                isUnlocked.value = true
            }

            is BiometricAvailability.NotAvailable -> {
                // Biometric not available, skip authentication
                lockScreenState.value = LockScreenState.NotAvailable(availability.reason)
                isUnlocked.value = true
            }
        }

        setContent {
            ImaniTheme {
                Surface(color = MaterialTheme.colorScheme.background) {
                    if (isUnlocked.value) {
                        // Main app content with bottom navigation
                        MainScreen()
                    } else {
                        // Lock screen
                        LockScreen(
                            state = lockScreenState.value,
                            onUnlockClick = {
                                when (lockScreenState.value) {
                                    is LockScreenState.NotAvailable -> {
                                        // Skip biometric, continue to app
                                        isUnlocked.value = true
                                    }

                                    else -> {
                                        // Retry authentication
                                        authenticateUser()
                                    }
                                }
                            },
                        )
                    }
                }
            }
        }
    }

    private fun authenticateUser() {
        lockScreenState.value = LockScreenState.Authenticating

        lifecycleScope.launch {
            val result =
                biometricAuthenticator.authenticate(
                    activity = this@MainActivity,
                    title = "Unlock Imani Wallet",
                    subtitle = "Verify your identity to continue",
                    description = "Use your fingerprint or face to unlock",
                )

            if (result.isSuccess) {
                // Authentication successful
                isUnlocked.value = true
            } else {
                // Authentication failed
                lockScreenState.value =
                    LockScreenState.Failed(
                        result.exceptionOrNull()?.message ?: "Authentication failed",
                    )
            }
        }
    }
}
