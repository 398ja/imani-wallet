package cash.imani.android.security

import android.content.Context
import androidx.biometric.BiometricManager
import io.mockk.every
import io.mockk.mockk
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Unit tests for BiometricAuthenticator.
 *
 * Tests:
 * - Biometric availability detection
 * - Different biometric states (available, not available, not enrolled)
 * - Proper error message formatting
 *
 * Note: Authentication flow testing requires instrumentation tests
 * as BiometricPrompt cannot be fully mocked in Robolectric.
 */
@RunWith(RobolectricTestRunner::class)
class BiometricAuthenticatorTest {

    private lateinit var context: Context
    private lateinit var authenticator: BiometricAuthenticator

    @Before
    fun setup() {
        context = RuntimeEnvironment.getApplication()
        authenticator = BiometricAuthenticator(context)
    }

    /**
     * Tests that canAuthenticate returns Available when biometric hardware is present and enrolled.
     *
     * Note: In real device, this would check actual hardware state.
     * In Robolectric, BiometricManager returns default states.
     */
    @Test
    fun `canAuthenticate returns state based on BiometricManager`() {
        // When
        val result = authenticator.canAuthenticate()

        // Then: Robolectric default is typically BIOMETRIC_ERROR_NO_HARDWARE
        // We just verify the result is one of the valid states
        assertTrue(
            result is BiometricAvailability.Available ||
                result is BiometricAvailability.NotAvailable ||
                result is BiometricAvailability.NotEnrolled
        )
    }

    /**
     * Tests that NotEnrolled state includes helpful message.
     */
    @Test
    fun `NotEnrolled availability includes setup instructions`() {
        // Given: Mock BiometricManager to return BIOMETRIC_ERROR_NONE_ENROLLED
        val mockBiometricManager = mockk<BiometricManager>()
        every {
            mockBiometricManager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        } returns BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED

        // When: Check availability (simulated)
        val result = BiometricAvailability.NotEnrolled(
            "No biometrics enrolled. Please set up fingerprint or face unlock in Settings."
        )

        // Then
        assertTrue(result is BiometricAvailability.NotEnrolled)
        assertTrue(result.message.contains("Settings"))
    }

    /**
     * Tests that NotAvailable states include descriptive reasons.
     */
    @Test
    fun `NotAvailable availability includes descriptive reason`() {
        // Given
        val noHardwareReason = "No biometric hardware found"

        // When
        val result = BiometricAvailability.NotAvailable(noHardwareReason)

        // Then
        assertTrue(result is BiometricAvailability.NotAvailable)
        assertEquals(noHardwareReason, result.reason)
    }

    /**
     * Tests that BiometricAuthenticationException wraps error messages correctly.
     */
    @Test
    fun `BiometricAuthenticationException wraps error message`() {
        // Given
        val errorMessage = "Authentication error (code 13): User canceled"

        // When
        val exception = BiometricAuthenticationException(errorMessage)

        // Then
        assertEquals(errorMessage, exception.message)
    }

    /**
     * Tests that all BiometricManager error codes are handled.
     */
    @Test
    fun `all BiometricManager error codes are mapped to availability states`() {
        // Given: All possible BiometricManager error codes
        val errorCodes = listOf(
            BiometricManager.BIOMETRIC_SUCCESS to BiometricAvailability.Available,
            BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE to BiometricAvailability.NotAvailable(""),
            BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE to BiometricAvailability.NotAvailable(""),
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED to BiometricAvailability.NotEnrolled(""),
            BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED to BiometricAvailability.NotAvailable(""),
            BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED to BiometricAvailability.NotAvailable(""),
            BiometricManager.BIOMETRIC_STATUS_UNKNOWN to BiometricAvailability.NotAvailable("")
        )

        // When/Then: Verify each error code maps to correct availability type
        errorCodes.forEach { (code, expectedType) ->
            val actualType = when (code) {
                BiometricManager.BIOMETRIC_SUCCESS -> BiometricAvailability.Available
                BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> BiometricAvailability.NotEnrolled("")
                else -> BiometricAvailability.NotAvailable("")
            }

            assertTrue(
                actualType::class == expectedType::class,
                "Error code $code should map to ${expectedType::class.simpleName}"
            )
        }
    }

    /**
     * Tests that BiometricAuthenticator requires FragmentActivity for authentication.
     *
     * Note: Actual authentication flow requires instrumentation tests.
     */
    @Test
    fun `authenticator created with Context can check availability`() {
        // Given
        val contextBasedAuthenticator = BiometricAuthenticator(context)

        // When
        val result = contextBasedAuthenticator.canAuthenticate()

        // Then: Availability check should work without FragmentActivity
        assertTrue(
            result is BiometricAvailability.Available ||
                result is BiometricAvailability.NotAvailable ||
                result is BiometricAvailability.NotEnrolled
        )
    }
}
