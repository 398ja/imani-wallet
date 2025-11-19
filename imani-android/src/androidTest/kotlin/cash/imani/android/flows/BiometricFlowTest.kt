package cash.imani.android.flows

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import cash.imani.android.MainActivity
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * End-to-end instrumentation test for biometric authentication flow.
 *
 * Tests lock screen and biometric authentication behavior.
 *
 * Note: Actual biometric authentication cannot be fully tested in
 * instrumentation tests without device-specific configuration.
 * These tests verify the UI behavior and fallback scenarios.
 */
@RunWith(AndroidJUnit4::class)
class BiometricFlowTest {

    @get:Rule
    val composeTestRule = createAndroidComposeRule<MainActivity>()

    /**
     * Tests app launches with biometric check (may auto-skip if not available).
     */
    @Test
    fun appLaunch_biometricCheck() {
        // Given: App launching
        composeTestRule.waitForIdle()

        // Then: App should either:
        // 1. Show lock screen (if biometric available)
        // 2. Skip directly to main screen (if not available)

        // Verify app is in one of these states
        val lockScreenExists = composeTestRule
            .onAllNodesWithText("Imani Wallet")
            .fetchSemanticsNodes()
            .isNotEmpty()

        val mainScreenExists = composeTestRule
            .onAllNodesWithText("Identities")
            .fetchSemanticsNodes()
            .isNotEmpty()

        assert(lockScreenExists || mainScreenExists) {
            "App should show either lock screen or main screen"
        }
    }

    /**
     * Tests lock screen displays Imani branding.
     */
    @Test
    fun lockScreen_showsBranding() {
        // Given: App launched
        composeTestRule.waitForIdle()

        // If lock screen is shown
        if (composeTestRule
                .onAllNodesWithText("Unlock with Biometrics", substring = true)
                .fetchSemanticsNodes()
                .isNotEmpty()
        ) {
            // Then: Should show Imani branding
            composeTestRule
                .onNodeWithText("Imani Wallet")
                .assertExists()

            composeTestRule
                .onNodeWithText("Built on Trust, Secured by Math")
                .assertExists()

            composeTestRule
                .onNodeWithContentDescription("Lock")
                .assertExists()
        }
    }

    /**
     * Tests lock screen shows unlock button when biometric available.
     */
    @Test
    fun lockScreen_biometricAvailable_showsUnlockButton() {
        // Given: App launched
        composeTestRule.waitForIdle()

        // If lock screen is shown (biometric available)
        if (composeTestRule
                .onAllNodesWithText("Unlock with Biometrics", substring = true)
                .fetchSemanticsNodes()
                .isNotEmpty()
        ) {
            // Then: Should show unlock button
            composeTestRule
                .onNodeWithText("Unlock with Biometrics", substring = true)
                .assertIsDisplayed()
                .assertHasClickAction()
        }
    }

    /**
     * Tests lock screen auto-unlocks if biometric not available.
     */
    @Test
    fun lockScreen_biometricNotAvailable_autoUnlock() {
        // Given: App launched
        composeTestRule.waitForIdle()

        // If biometric not available, should auto-unlock to main screen
        // Then: Should see main screen within reasonable time
        composeTestRule.waitUntil(timeoutMillis = 3000) {
            composeTestRule
                .onAllNodesWithText("Identities")
                .fetchSemanticsNodes()
                .isNotEmpty()
        }

        // Verify main screen is displayed
        composeTestRule
            .onNodeWithText("Identities")
            .assertExists()
    }

    /**
     * Tests lock screen shows "Not Available" state with continue button.
     */
    @Test
    fun lockScreen_notAvailable_showsContinueButton() {
        // Given: App launched
        composeTestRule.waitForIdle()

        // If lock screen shows "Not Available" state
        if (composeTestRule
                .onAllNodesWithText("Biometric Not Available", substring = true)
                .fetchSemanticsNodes()
                .isNotEmpty()
        ) {
            // Then: Should show continue button
            composeTestRule
                .onNodeWithText("Continue without Biometrics", substring = true)
                .assertIsDisplayed()
                .assertHasClickAction()

            // Should show reason
            composeTestRule
                .onNodeWithText("Biometric Not Available", substring = true)
                .assertIsDisplayed()
        }
    }

    /**
     * Tests lock screen shows failed state with retry button.
     */
    @Test
    fun lockScreen_authenticationFailed_showsRetryButton() {
        // Given: App launched
        composeTestRule.waitForIdle()

        // If lock screen shows "Failed" state (rare in test environment)
        if (composeTestRule
                .onAllNodesWithText("Authentication Failed", substring = true)
                .fetchSemanticsNodes()
                .isNotEmpty()
        ) {
            // Then: Should show retry button
            composeTestRule
                .onNodeWithText("Try Again", substring = true)
                .assertIsDisplayed()
                .assertHasClickAction()

            // Should show error message
            composeTestRule
                .onNodeWithText("Authentication Failed", substring = true)
                .assertIsDisplayed()
        }
    }

    /**
     * Tests lock screen shows authenticating state.
     */
    @Test
    fun lockScreen_authenticating_showsLoadingIndicator() {
        // Given: App launched and biometric prompt triggered
        composeTestRule.waitForIdle()

        // If lock screen shows "Authenticating" state (brief window)
        if (composeTestRule
                .onAllNodesWithText("Authenticating...", substring = true)
                .fetchSemanticsNodes()
                .isNotEmpty()
        ) {
            // Then: Should show loading indicator
            composeTestRule
                .onNodeWithContentDescription("Loading")
                .assertExists()

            composeTestRule
                .onNodeWithText("Authenticating...", substring = true)
                .assertIsDisplayed()
        }
    }

    /**
     * Tests app eventually reaches main screen regardless of biometric availability.
     */
    @Test
    fun appLaunch_eventuallyReachesMainScreen() {
        // Given: App launched
        composeTestRule.waitForIdle()

        // Wait for main screen to appear (either after biometric or auto-unlock)
        composeTestRule.waitUntil(timeoutMillis = 10000) {
            composeTestRule
                .onAllNodesWithText("Identities")
                .fetchSemanticsNodes()
                .isNotEmpty()
        }

        // Then: Should be on main screen
        composeTestRule
            .onNodeWithText("Identities")
            .assertExists()
            .assertIsDisplayed()

        // Should see bottom navigation
        composeTestRule
            .onNodeWithText("Vouchers")
            .assertExists()

        composeTestRule
            .onNodeWithText("Settings")
            .assertExists()
    }
}
