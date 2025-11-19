package cash.imani.android.security

import android.content.Context
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * Wrapper for Android Biometric API to provide fingerprint/face authentication.
 *
 * This class provides a Kotlin-friendly API for biometric authentication using
 * AndroidX Biometric library. It supports both fingerprint and face unlock.
 *
 * Code Reuse:
 * - Uses AndroidX Biometric library (≥90% framework reuse)
 * - Thin wrapper pattern for Kotlin coroutines integration
 *
 * Usage:
 * ```kotlin
 * val authenticator = BiometricAuthenticator(activity)
 * if (authenticator.canAuthenticate()) {
 *     val result = authenticator.authenticate()
 *     if (result.isSuccess) {
 *         // Unlock app
 *     }
 * }
 * ```
 *
 * Security Notes:
 * - Uses BIOMETRIC_STRONG authenticators only (Class 3 biometrics)
 * - Does NOT handle crypto operations (uses KeystoreManager for encryption)
 * - Only provides authentication gate, not data decryption
 */
class BiometricAuthenticator(
    private val context: Context
) {

    /**
     * Check if biometric authentication is available on this device.
     *
     * @return true if device supports Class 3 biometrics (fingerprint or face),
     *         false otherwise
     */
    fun canAuthenticate(): BiometricAvailability {
        val biometricManager = BiometricManager.from(context)
        return when (biometricManager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)) {
            BiometricManager.BIOMETRIC_SUCCESS ->
                BiometricAvailability.Available

            BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE ->
                BiometricAvailability.NotAvailable("No biometric hardware found")

            BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE ->
                BiometricAvailability.NotAvailable("Biometric hardware unavailable")

            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED ->
                BiometricAvailability.NotEnrolled("No biometrics enrolled. Please set up fingerprint or face unlock in Settings.")

            BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED ->
                BiometricAvailability.NotAvailable("Security update required")

            BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED ->
                BiometricAvailability.NotAvailable("Biometric authentication not supported")

            BiometricManager.BIOMETRIC_STATUS_UNKNOWN ->
                BiometricAvailability.NotAvailable("Biometric status unknown")

            else ->
                BiometricAvailability.NotAvailable("Unknown error")
        }
    }

    /**
     * Show biometric prompt and authenticate user.
     *
     * @param activity FragmentActivity required for showing biometric prompt
     * @param title Title displayed on the biometric prompt
     * @param subtitle Subtitle displayed on the biometric prompt
     * @param description Description displayed on the biometric prompt
     * @return Result.success(Unit) if authentication succeeded,
     *         Result.failure(Exception) if authentication failed or was cancelled
     */
    suspend fun authenticate(
        activity: FragmentActivity,
        title: String = "Authenticate",
        subtitle: String = "Verify your identity to continue",
        description: String = "Use your fingerprint or face to unlock Imani Wallet"
    ): Result<Unit> = suspendCancellableCoroutine { continuation ->

        val executor = ContextCompat.getMainExecutor(context)

        val biometricPrompt = BiometricPrompt(
            activity,
            executor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    if (continuation.isActive) {
                        continuation.resume(Result.success(Unit))
                    }
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    if (continuation.isActive) {
                        continuation.resume(
                            Result.failure(
                                BiometricAuthenticationException(
                                    "Authentication error (code $errorCode): $errString"
                                )
                            )
                        )
                    }
                }

                override fun onAuthenticationFailed() {
                    // Note: onAuthenticationFailed is called for each failed attempt,
                    // but the prompt remains open. We don't resume here.
                    // The final failure will trigger onAuthenticationError.
                }
            }
        )

        val promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setSubtitle(subtitle)
            .setDescription(description)
            .setNegativeButtonText("Cancel")
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .build()

        continuation.invokeOnCancellation {
            biometricPrompt.cancelAuthentication()
        }

        biometricPrompt.authenticate(promptInfo)
    }
}

/**
 * Result of checking biometric availability.
 */
sealed class BiometricAvailability {
    object Available : BiometricAvailability()
    data class NotAvailable(val reason: String) : BiometricAvailability()
    data class NotEnrolled(val message: String) : BiometricAvailability()
}

/**
 * Exception thrown when biometric authentication fails.
 */
class BiometricAuthenticationException(message: String) : Exception(message)
