package cash.imani.android.ui

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import cash.imani.android.ui.theme.ImaniTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.test.assertEquals

/**
 * Unit tests for LockScreen Composable.
 *
 * Tests all 4 lock screen states and user interactions.
 * Uses Compose Testing API.
 */
@RunWith(AndroidJUnit4::class)
class LockScreenTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    /**
     * Tests that Locked state shows unlock button.
     */
    @Test
    fun lockedState_showsUnlockButton() {
        // Given: Locked state
        var unlockClicked = false

        // When: Setting content with Locked state
        composeTestRule.setContent {
            ImaniTheme {
                LockScreen(
                    state = LockScreenState.Locked,
                    onUnlockClick = { unlockClicked = true }
                )
            }
        }

        // Then: Should show unlock button
        composeTestRule
            .onNodeWithText("Unlock with Biometrics")
            .assertIsDisplayed()
            .assertHasClickAction()

        // When: Clicking unlock button
        composeTestRule
            .onNodeWithText("Unlock with Biometrics")
            .performClick()

        // Then: Callback should be invoked
        assertEquals(true, unlockClicked)
    }

    /**
     * Tests that Authenticating state shows loading indicator.
     */
    @Test
    fun authenticatingState_showsLoadingIndicator() {
        // When: Setting content with Authenticating state
        composeTestRule.setContent {
            ImaniTheme {
                LockScreen(
                    state = LockScreenState.Authenticating,
                    onUnlockClick = {}
                )
            }
        }

        // Then: Should show "Authenticating..." text
        composeTestRule
            .onNodeWithText("Authenticating...")
            .assertIsDisplayed()

        // Should show progress indicator
        composeTestRule
            .onNodeWithContentDescription("Loading")
            .assertExists()
    }

    /**
     * Tests that Failed state shows error message and retry button.
     */
    @Test
    fun failedState_showsErrorMessageAndRetryButton() {
        // Given: Failed state with reason
        var retryClicked = false

        // When: Setting content with Failed state
        composeTestRule.setContent {
            ImaniTheme {
                LockScreen(
                    state = LockScreenState.Failed("Fingerprint not recognized"),
                    onUnlockClick = { retryClicked = true }
                )
            }
        }

        // Then: Should show error message
        composeTestRule
            .onNodeWithText("Authentication Failed")
            .assertIsDisplayed()

        composeTestRule
            .onNodeWithText("Fingerprint not recognized")
            .assertIsDisplayed()

        // Should show retry button
        composeTestRule
            .onNodeWithText("Try Again")
            .assertIsDisplayed()
            .assertHasClickAction()

        // When: Clicking retry
        composeTestRule
            .onNodeWithText("Try Again")
            .performClick()

        // Then: Callback should be invoked
        assertEquals(true, retryClicked)
    }

    /**
     * Tests that NotAvailable state shows fallback message and continue button.
     */
    @Test
    fun notAvailableState_showsFallbackMessage() {
        // Given: NotAvailable state
        var continueClicked = false

        // When: Setting content with NotAvailable state
        composeTestRule.setContent {
            ImaniTheme {
                LockScreen(
                    state = LockScreenState.NotAvailable("No biometric hardware"),
                    onUnlockClick = { continueClicked = true }
                )
            }
        }

        // Then: Should show not available message
        composeTestRule
            .onNodeWithText("Biometric Not Available")
            .assertIsDisplayed()

        composeTestRule
            .onNodeWithText("No biometric hardware")
            .assertIsDisplayed()

        // Should show continue button
        composeTestRule
            .onNodeWithText("Continue without Biometrics")
            .assertIsDisplayed()
            .assertHasClickAction()

        // When: Clicking continue
        composeTestRule
            .onNodeWithText("Continue without Biometrics")
            .performClick()

        // Then: Callback should be invoked
        assertEquals(true, continueClicked)
    }

    /**
     * Tests that lock screen shows Imani branding.
     */
    @Test
    fun lockScreen_showsImaniBranding() {
        // When: Setting content with any state
        composeTestRule.setContent {
            ImaniTheme {
                LockScreen(
                    state = LockScreenState.Locked,
                    onUnlockClick = {}
                )
            }
        }

        // Then: Should show Imani Wallet title
        composeTestRule
            .onNodeWithText("Imani Wallet")
            .assertIsDisplayed()

        // Should show lock icon
        composeTestRule
            .onNodeWithContentDescription("Lock")
            .assertExists()
    }

    /**
     * Tests that lock screen shows tagline.
     */
    @Test
    fun lockScreen_showsTagline() {
        // When: Setting content
        composeTestRule.setContent {
            ImaniTheme {
                LockScreen(
                    state = LockScreenState.Locked,
                    onUnlockClick = {}
                )
            }
        }

        // Then: Should show tagline
        composeTestRule
            .onNodeWithText("Built on Trust, Secured by Math")
            .assertIsDisplayed()
    }

    /**
     * Tests that different states preserve branding.
     */
    @Test
    fun allStates_preserveBranding() {
        val states = listOf(
            LockScreenState.Locked,
            LockScreenState.Authenticating,
            LockScreenState.Failed("Test error"),
            LockScreenState.NotAvailable("Test reason")
        )

        states.forEach { state ->
            // When: Setting content with each state
            composeTestRule.setContent {
                ImaniTheme {
                    LockScreen(state = state, onUnlockClick = {})
                }
            }

            // Then: Should always show Imani Wallet
            composeTestRule
                .onNodeWithText("Imani Wallet")
                .assertIsDisplayed()
        }
    }
}
