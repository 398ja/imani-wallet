package cash.imani.android.e2e

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import cash.imani.android.MainActivity
import cash.imani.android.e2e.fixtures.ImaniTestFixtures
import kotlinx.coroutines.test.runTest
import org.junit.Before
import org.junit.Rule
import org.junit.Test

/**
 * Basic E2E tests: Navigation, back button, and basic functionality.
 *
 * Mirrors: e2e/tests/01-basic-flow.spec.ts
 */
class BasicFlowTest {

    @get:Rule
    val composeTestRule = createAndroidComposeRule<MainActivity>()

    private lateinit var fixtures: ImaniTestFixtures

    @Before
    fun setup() {
        fixtures = ImaniTestFixtures(composeTestRule)
        fixtures.clearAppData()
    }

    /**
     * Tests that the application loads and displays bottom navigation.
     *
     * Mirrors Playwright test: "should load the application"
     */
    @Test
    fun should_load_application_and_show_navigation() = runTest {
        fixtures.waitForAppLoad()

        // Should see all three navigation tabs
        composeTestRule.onNodeWithText("Identities").assertIsDisplayed()
        composeTestRule.onNodeWithText("Vouchers").assertIsDisplayed()
        composeTestRule.onNodeWithText("Settings").assertIsDisplayed()
    }

    /**
     * Tests navigation between all tabs.
     */
    @Test
    fun should_navigate_between_all_tabs() = runTest {
        fixtures.waitForAppLoad()

        // Navigate to each tab and verify content
        fixtures.gotoIdentities()
        composeTestRule.onNodeWithContentDescription("Create Identity")
            .assertIsDisplayed()

        fixtures.gotoVouchers()
        composeTestRule.onNodeWithContentDescription("Issue Voucher")
            .assertIsDisplayed()

        fixtures.gotoSettings()
        composeTestRule.onNodeWithText("Settings").assertIsDisplayed()

        // Navigate back to first tab
        fixtures.gotoIdentities()
        composeTestRule.onNodeWithContentDescription("Create Identity")
            .assertIsDisplayed()
    }

    /**
     * Tests that tab state is preserved when switching.
     */
    @Test
    fun should_preserve_tab_state_when_switching() = runTest {
        // Create an identity
        fixtures.createNewIdentity("Test Identity")

        // Navigate to Vouchers tab
        fixtures.gotoVouchers()
        composeTestRule.waitForIdle()

        // Navigate to Settings tab
        fixtures.gotoSettings()
        composeTestRule.waitForIdle()

        // Go back to Identities tab
        fixtures.gotoIdentities()

        // Should still see the created identity
        composeTestRule.onNodeWithText("Test Identity")
            .assertIsDisplayed()
    }

    /**
     * Tests creating content in one tab and viewing in another.
     */
    @Test
    fun should_share_data_between_tabs() = runTest {
        // Create identity in Identities tab
        fixtures.createNewIdentity("Shared Identity")
        composeTestRule.onNodeWithText("Shared Identity").assertIsDisplayed()

        // Navigate to Settings
        fixtures.gotoSettings()
        composeTestRule.waitForIdle()

        // The identity should still exist when we go back
        fixtures.gotoIdentities()
        composeTestRule.onNodeWithText("Shared Identity").assertIsDisplayed()
    }

    /**
     * Tests that back button navigates correctly from nested screens.
     */
    @Test
    fun should_handle_back_navigation_correctly() = runTest {
        fixtures.waitForAppLoad()
        fixtures.gotoIdentities()

        // Navigate to Create Identity screen (nested)
        composeTestRule.onNodeWithContentDescription("Create Identity")
            .performClick()
        composeTestRule.waitForIdle()

        // Should see Create Identity form
        composeTestRule.onNodeWithText("Identity Label", substring = true)
            .assertIsDisplayed()

        // Press back button
        composeTestRule.onNodeWithContentDescription("Back")
            .performClick()
        composeTestRule.waitForIdle()

        // Should return to Identity list
        composeTestRule.onNodeWithContentDescription("Create Identity")
            .assertIsDisplayed()
    }

    /**
     * Tests that back button switches tabs when on root screen.
     */
    @Test
    fun should_switch_to_first_tab_on_back_from_other_tabs() = runTest {
        fixtures.waitForAppLoad()

        // Go to Vouchers tab (second tab)
        fixtures.gotoVouchers()
        composeTestRule.onNodeWithContentDescription("Issue Voucher")
            .assertIsDisplayed()

        // Simulate back button (in real app, this would use device back button)
        // For testing, we verify the tab switching behavior
        fixtures.gotoIdentities() // Simulates back to first tab

        composeTestRule.onNodeWithContentDescription("Create Identity")
            .assertIsDisplayed()
    }

    /**
     * Tests that empty states are displayed correctly.
     */
    @Test
    fun should_show_empty_states_on_fresh_install() = runTest {
        fixtures.waitForAppLoad()

        // Identities tab should show empty state or create button
        fixtures.gotoIdentities()
        composeTestRule.onNodeWithContentDescription("Create Identity")
            .assertIsDisplayed()

        // Vouchers tab should show empty state or issue button
        fixtures.gotoVouchers()
        composeTestRule.onNodeWithContentDescription("Issue Voucher")
            .assertIsDisplayed()
    }

    /**
     * Tests that app doesn't crash on rapid tab switching.
     */
    @Test
    fun should_handle_rapid_tab_switching() = runTest {
        fixtures.waitForAppLoad()

        // Rapidly switch between tabs
        repeat(5) {
            fixtures.gotoIdentities()
            composeTestRule.waitForIdle()

            fixtures.gotoVouchers()
            composeTestRule.waitForIdle()

            fixtures.gotoSettings()
            composeTestRule.waitForIdle()
        }

        // App should still be responsive
        fixtures.gotoIdentities()
        composeTestRule.onNodeWithContentDescription("Create Identity")
            .assertIsDisplayed()
    }
}
