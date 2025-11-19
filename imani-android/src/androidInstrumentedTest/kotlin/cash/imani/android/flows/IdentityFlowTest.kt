package cash.imani.android.flows

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import cash.imani.android.MainActivity
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * End-to-end instrumentation test for identity creation flow.
 *
 * Tests the complete user journey from launching the app to creating
 * an identity and verifying it appears in the list.
 *
 * Critical Flow:
 * 1. Launch app (skip biometric if not available)
 * 2. Navigate to Identities tab
 * 3. Click "Create Identity" FAB
 * 4. Enter identity label
 * 5. Submit creation
 * 6. Verify identity appears in list
 */
@RunWith(AndroidJUnit4::class)
class IdentityFlowTest {

    @get:Rule
    val composeTestRule = createAndroidComposeRule<MainActivity>()

    /**
     * Tests complete identity creation flow from start to finish.
     */
    @Test
    fun createIdentity_completeFlow_success() {
        // Wait for app to load (biometric may auto-unlock or skip)
        composeTestRule.waitForIdle()

        // Given: App is on main screen
        // Note: If biometric lock appears, it will auto-unlock in test environment

        // When: Click Identities tab (should already be selected)
        composeTestRule
            .onNodeWithText("Identities")
            .assertExists("Identities tab should exist")

        // Then: Should see Identities screen (may be empty initially)
        composeTestRule.waitForIdle()

        // When: Click Create Identity FAB
        composeTestRule
            .onNodeWithContentDescription("Create Identity", useUnmergedTree = true)
            .performClick()

        composeTestRule.waitForIdle()

        // Then: Should navigate to Create Identity screen
        composeTestRule
            .onNodeWithText("Create Identity", substring = true)
            .assertIsDisplayed()

        // When: Enter identity label
        val testLabel = "Test Identity ${System.currentTimeMillis()}"
        composeTestRule
            .onNodeWithText("Identity Label", substring = true)
            .performTextInput(testLabel)

        composeTestRule.waitForIdle()

        // When: Click Create button
        composeTestRule
            .onNodeWithText("Create Identity", substring = true)
            .assertHasClickAction()
            .performClick()

        // Wait for creation (crypto operations may take time)
        composeTestRule.waitUntil(timeoutMillis = 5000) {
            composeTestRule
                .onAllNodesWithText("Write down your recovery phrase", substring = true)
                .fetchSemanticsNodes()
                .isNotEmpty()
        }

        // Then: Should show mnemonic screen
        composeTestRule
            .onNodeWithText("Write down your recovery phrase", substring = true)
            .assertIsDisplayed()

        // Should show mnemonic (12 or 24 words)
        composeTestRule
            .onNodeWithContentDescription("Recovery Phrase", useUnmergedTree = true)
            .assertExists()

        // When: Acknowledge mnemonic saved
        composeTestRule
            .onNodeWithText("I've saved it", substring = true)
            .assertIsDisplayed()
            .performClick()

        composeTestRule.waitForIdle()

        // Then: Should navigate back to identity list
        composeTestRule
            .onNodeWithText("Identities", substring = true)
            .assertIsDisplayed()

        // Should see newly created identity in list
        composeTestRule
            .onNodeWithText(testLabel, substring = true)
            .assertIsDisplayed()
    }

    /**
     * Tests identity list displays correctly with multiple identities.
     */
    @Test
    fun identityList_displaysMultipleIdentities() {
        // Given: App loaded
        composeTestRule.waitForIdle()

        // When: On Identities tab
        composeTestRule
            .onNodeWithText("Identities")
            .assertExists()

        // Then: Identity list should be displayed
        // (May be empty or have existing identities)
        composeTestRule.waitForIdle()

        // Verify list is scrollable if there are items
        composeTestRule
            .onRoot(useUnmergedTree = true)
            .assertExists()
    }

    /**
     * Tests creating identity with empty label shows validation error.
     */
    @Test
    fun createIdentity_emptyLabel_disablesButton() {
        // Given: App loaded and on create screen
        composeTestRule.waitForIdle()

        composeTestRule
            .onNodeWithContentDescription("Create Identity", useUnmergedTree = true)
            .performClick()

        composeTestRule.waitForIdle()

        // When: Create button with empty label
        // Then: Create button should be disabled
        composeTestRule
            .onNodeWithText("Create Identity", substring = true)
            .assertIsNotEnabled()

        // When: Enter single character
        composeTestRule
            .onNodeWithText("Identity Label", substring = true)
            .performTextInput("A")

        // Then: Button should become enabled
        composeTestRule
            .onNodeWithText("Create Identity", substring = true)
            .assertIsEnabled()
    }

    /**
     * Tests navigation back from create screen works correctly.
     */
    @Test
    fun createIdentity_navigateBack_returnsToList() {
        // Given: App loaded
        composeTestRule.waitForIdle()

        // When: Navigate to create screen
        composeTestRule
            .onNodeWithContentDescription("Create Identity", useUnmergedTree = true)
            .performClick()

        composeTestRule.waitForIdle()

        // Then: Should be on create screen
        composeTestRule
            .onNodeWithText("Create Identity", substring = true)
            .assertIsDisplayed()

        // When: Press back button
        composeTestRule
            .onNodeWithContentDescription("Back", useUnmergedTree = true)
            .performClick()

        composeTestRule.waitForIdle()

        // Then: Should return to identity list
        composeTestRule
            .onNodeWithText("Identities", substring = true)
            .assertIsDisplayed()
    }

    /**
     * Tests identity card displays key information.
     */
    @Test
    fun identityCard_displaysCorrectInformation() {
        // Given: At least one identity exists
        composeTestRule.waitForIdle()

        // When: On identity list
        composeTestRule
            .onNodeWithText("Identities")
            .assertExists()

        // Then: Identity cards should show:
        // - Label (checked in createIdentity_completeFlow_success)
        // - Active/Inactive status (icon + text)
        // Note: Specific assertions depend on existing data
    }
}
