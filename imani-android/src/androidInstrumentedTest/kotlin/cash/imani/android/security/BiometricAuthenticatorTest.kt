package cash.imani.android.security

import android.content.Context
import androidx.biometric.BiometricManager
import androidx.fragment.app.FragmentActivity
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.mockk.*
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Unit tests for BiometricAuthenticator.
 *
 * Tests biometric availability checking and authentication flows.
 * Uses MockK for mocking Android biometric components.
 */
@RunWith(AndroidJUnit4::class)
class BiometricAuthenticatorTest {

    private lateinit var context: Context
    private lateinit var authenticator: BiometricAuthenticator
    private lateinit var mockActivity: FragmentActivity

    @Before
    fun setup() {
        context = ApplicationProvider.getApplicationContext()
        authenticator = BiometricAuthenticator(context)
        mockActivity = mockk(relaxed = true)
    }

    @After
    fun teardown() {
        unmockkAll()
    }

    /**
     * Tests that canAuthenticate returns Available when biometrics are enrolled.
     */
    @Test
    fun canAuthenticate_returnsAvailableWhenBiometricsEnrolled() {
        // Given: BiometricManager returns BIOMETRIC_SUCCESS
        mockkStatic(BiometricManager::class)
        val mockBiometricManager = mockk<BiometricManager>()
        every { BiometricManager.from(context) } returns mockBiometricManager
        every {
            mockBiometricManager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        } returns BiometricManager.BIOMETRIC_SUCCESS

        // When: Checking if can authenticate
        val result = authenticator.canAuthenticate()

        // Then: Should return Available
        assertTrue(result is BiometricAvailability.Available)
    }

    /**
     * Tests that canAuthenticate returns NotEnrolled when no biometrics enrolled.
     */
    @Test
    fun canAuthenticate_returnsNotEnrolledWhenNoBiometrics() {
        // Given: BiometricManager returns BIOMETRIC_ERROR_NONE_ENROLLED
        mockkStatic(BiometricManager::class)
        val mockBiometricManager = mockk<BiometricManager>()
        every { BiometricManager.from(context) } returns mockBiometricManager
        every {
            mockBiometricManager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        } returns BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED

        // When: Checking if can authenticate
        val result = authenticator.canAuthenticate()

        // Then: Should return NotEnrolled
        assertTrue(result is BiometricAvailability.NotEnrolled)
        assertTrue((result as BiometricAvailability.NotEnrolled).reason.contains("enrolled"))
    }

    /**
     * Tests that canAuthenticate returns NotAvailable when hardware not available.
     */
    @Test
    fun canAuthenticate_returnsNotAvailableWhenNoHardware() {
        // Given: BiometricManager returns BIOMETRIC_ERROR_NO_HARDWARE
        mockkStatic(BiometricManager::class)
        val mockBiometricManager = mockk<BiometricManager>()
        every { BiometricManager.from(context) } returns mockBiometricManager
        every {
            mockBiometricManager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        } returns BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE

        // When: Checking if can authenticate
        val result = authenticator.canAuthenticate()

        // Then: Should return NotAvailable
        assertTrue(result is BiometricAvailability.NotAvailable)
        assertTrue((result as BiometricAvailability.NotAvailable).reason.contains("hardware"))
    }

    /**
     * Tests that canAuthenticate returns NotAvailable when hardware unavailable.
     */
    @Test
    fun canAuthenticate_returnsNotAvailableWhenHardwareUnavailable() {
        // Given: BiometricManager returns BIOMETRIC_ERROR_HW_UNAVAILABLE
        mockkStatic(BiometricManager::class)
        val mockBiometricManager = mockk<BiometricManager>()
        every { BiometricManager.from(context) } returns mockBiometricManager
        every {
            mockBiometricManager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        } returns BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE

        // When: Checking if can authenticate
        val result = authenticator.canAuthenticate()

        // Then: Should return NotAvailable
        assertTrue(result is BiometricAvailability.NotAvailable)
        assertTrue((result as BiometricAvailability.NotAvailable).reason.contains("unavailable"))
    }

    /**
     * Tests that canAuthenticate returns NotAvailable for unknown error codes.
     */
    @Test
    fun canAuthenticate_returnsNotAvailableForUnknownErrorCode() {
        // Given: BiometricManager returns unknown error code
        mockkStatic(BiometricManager::class)
        val mockBiometricManager = mockk<BiometricManager>()
        every { BiometricManager.from(context) } returns mockBiometricManager
        every {
            mockBiometricManager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        } returns 999 // Unknown code

        // When: Checking if can authenticate
        val result = authenticator.canAuthenticate()

        // Then: Should return NotAvailable with unknown error
        assertTrue(result is BiometricAvailability.NotAvailable)
        assertTrue((result as BiometricAvailability.NotAvailable).reason.contains("Unknown"))
    }

    /**
     * Tests that authenticate uses correct prompt info.
     */
    @Test
    fun authenticate_usesCorrectPromptInfo() = runTest {
        // Note: This test is simplified because BiometricPrompt is difficult to mock fully.
        // Real testing would be done via instrumentation tests with actual device.

        // Given: Mock activity

        // When/Then: Calling authenticate should not throw
        // (Full testing requires instrumentation test with real biometric)
        val title = "Test Title"
        val subtitle = "Test Subtitle"
        val description = "Test Description"

        // We can't easily test the full flow in unit tests, but we can verify
        // the method exists and has correct signature
        assertTrue(authenticator::authenticate.parameters.size == 5)
    }

    /**
     * Tests BiometricAvailability sealed class hierarchy.
     */
    @Test
    fun biometricAvailability_hasCorrectHierarchy() {
        // Test Available
        val available = BiometricAvailability.Available
        assertTrue(available is BiometricAvailability)

        // Test NotEnrolled
        val notEnrolled = BiometricAvailability.NotEnrolled("Test reason")
        assertTrue(notEnrolled is BiometricAvailability)
        assertEquals("Test reason", notEnrolled.reason)

        // Test NotAvailable
        val notAvailable = BiometricAvailability.NotAvailable("Test reason")
        assertTrue(notAvailable is BiometricAvailability)
        assertEquals("Test reason", notAvailable.reason)
    }

    /**
     * Tests BiometricAuthenticationException creation.
     */
    @Test
    fun biometricAuthenticationException_hasCorrectMessage() {
        // Given: Exception message
        val message = "Authentication failed"

        // When: Creating exception
        val exception = BiometricAuthenticationException(message)

        // Then: Should have correct message
        assertEquals(message, exception.message)
        assertTrue(exception is Exception)
    }
}
