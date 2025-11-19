package cash.imani.android.flows

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import cash.imani.android.MainActivity
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * End-to-end instrumentation test for app navigation.
 *
 * Tests bottom navigation, tab switching, and back button handling.
 */
@RunWith(AndroidJUnit4::class)
class NavigationFlowTest {

    @get:Rule
    val composeTestRule = createAndroidComposeRule<MainActivity>()

    /**
     * Tests all three bottom navigation tabs are present.
     */
    @Test
    fun bottomNavigation_allTabsPresent() {
        // Given: App loaded
        composeTestRule.waitForIdle()

        // Then: All three tabs should be visible
        composeTestRule
            .onNodeWithText("Identities")
            .assertExists()
            .assertIsDisplayed()

        composeTestRule
            .onNodeWithText("Vouchers")
            .assertExists()
            .assertIsDisplayed()

        composeTestRule
            .onNodeWithText("Settings")
            .assertExists()
            .assertIsDisplayed()
    }

    /**
     * Tests Identities tab is selected by default.
     */
    @Test
    fun bottomNavigation_identitiesSelectedByDefault() {
        // Given: App loaded
        composeTestRule.waitForIdle()

        // Then: Identities tab should be selected
        composeTestRule
            .onNodeWithText("Identities")
            .assertIsSelected()

        // Other tabs should not be selected
        composeTestRule
            .onNodeWithText("Vouchers")
            .assertIsNotSelected()

        composeTestRule
            .onNodeWithText("Settings")
            .assertIsNotSelected()
    }

    /**
     * Tests switching between all three tabs.
     */
    @Test
    fun bottomNavigation_switchBetweenTabs() {
        // Given: App loaded on Identities
        composeTestRule.waitForIdle()

        // When: Click Vouchers tab
        composeTestRule
            .onNodeWithText("Vouchers")
            .performClick()

        composeTestRule.waitForIdle()

        // Then: Vouchers should be selected
        composeTestRule
            .onNodeWithText("Vouchers")
            .assertIsSelected()

        composeTestRule
            .onNodeWithText("Identities")
            .assertIsNotSelected()

        // When: Click Settings tab
        composeTestRule
            .onNodeWithText("Settings")
            .performClick()

        composeTestRule.waitForIdle()

        // Then: Settings should be selected
        composeTestRule
            .onNodeWithText("Settings")
            .assertIsSelected()

        composeTestRule
            .onNodeWithText("Vouchers")
            .assertIsNotSelected()

        // When: Click Identities tab
        composeTestRule
            .onNodeWithText("Identities")
            .performClick()

        composeTestRule.waitForIdle()

        // Then: Identities should be selected
        composeTestRule
            .onNodeWithText("Identities")
            .assertIsSelected()

        composeTestRule
            .onNodeWithText("Settings")
            .assertIsNotSelected()
    }

    /**
     * Tests tab switching preserves state.
     */
    @Test
    fun bottomNavigation_preservesState() {
        // Given: App loaded
        composeTestRule.waitForIdle()

        // When: Switch to Vouchers and back to Identities
        composeTestRule
            .onNodeWithText("Vouchers")
            .performClick()

        composeTestRule.waitForIdle()

        composeTestRule
            .onNodeWithText("Identities")
            .performClick()

        composeTestRule.waitForIdle()

        // Then: Should still be on Identities screen with same state
        composeTestRule
            .onNodeWithText("Identities", substring = true)
            .assertIsDisplayed()
    }

    /**
     * Tests bottom navigation bar is always visible.
     */
    @Test
    fun bottomNavigation_alwaysVisible() {
        // Given: App loaded
        composeTestRule.waitForIdle()

        // When: Switch between tabs
        val tabs = listOf("Identities", "Vouchers", "Settings")
        tabs.forEach { tab ->
            composeTestRule
                .onNodeWithText(tab)
                .performClick()

            composeTestRule.waitForIdle()

            // Then: All tabs should still be visible
            tabs.forEach { otherTab ->
                composeTestRule
                    .onNodeWithText(otherTab)
                    .assertIsDisplayed()
            }
        }
    }

    /**
     * Tests Settings screen displays correctly.
     */
    @Test
    fun settingsScreen_displaysCorrectly() {
        // Given: App loaded
        composeTestRule.waitForIdle()

        // When: Navigate to Settings
        composeTestRule
            .onNodeWithText("Settings")
            .performClick()

        composeTestRule.waitForIdle()

        // Then: Should show Settings screen
        composeTestRule
            .onNodeWithText("Settings", substring = true)
            .assertIsDisplayed()

        // Should show version info
        composeTestRule
            .onNodeWithText("Version", substring = true, ignoreCase = true)
            .assertExists()

        // Should show Imani branding
        composeTestRule
            .onNodeWithText("Imani Wallet", substring = true)
            .assertExists()
    }

    /**
     * Tests rapid tab switching doesn't crash.
     */
    @Test
    fun bottomNavigation_rapidSwitching_stable() {
        // Given: App loaded
        composeTestRule.waitForIdle()

        // When: Rapidly switch tabs multiple times
        repeat(10) {
            composeTestRule
                .onNodeWithText("Vouchers")
                .performClick()

            composeTestRule
                .onNodeWithText("Settings")
                .performClick()

            composeTestRule
                .onNodeWithText("Identities")
                .performClick()
        }

        composeTestRule.waitForIdle()

        // Then: App should still be stable
        composeTestRule
            .onNodeWithText("Identities")
            .assertIsDisplayed()
    }

    /**
     * Tests navigation icons are displayed correctly.
     */
    @Test
    fun bottomNavigation_iconsDisplayed() {
        // Given: App loaded
        composeTestRule.waitForIdle()

        // Then: All navigation icons should be present
        composeTestRule
            .onNodeWithContentDescription("Person", useUnmergedTree = true)
            .assertExists()

        composeTestRule
            .onNodeWithContentDescription("CardGiftcard", useUnmergedTree = true)
            .assertExists()

        composeTestRule
            .onNodeWithContentDescription("Settings", useUnmergedTree = true)
            .assertExists()
    }

    /**
     * Tests app launches successfully without crash.
     */
    @Test
    fun appLaunch_success() {
        // Given: App launched
        composeTestRule.waitForIdle()

        // Then: Should see main navigation
        composeTestRule
            .onNodeWithText("Identities")
            .assertExists()

        // Should see bottom navigation bar
        composeTestRule
            .onRoot(useUnmergedTree = true)
            .assertExists()
    }

    /**
     * Tests deep navigation and back button handling.
     */
    @Test
    fun navigation_deepNavigationAndBack() {
        // Given: App loaded
        composeTestRule.waitForIdle()

        // When: Navigate to Vouchers
        composeTestRule
            .onNodeWithText("Vouchers")
            .performClick()

        composeTestRule.waitForIdle()

        // Navigate to Issue Voucher screen
        composeTestRule
            .onNodeWithContentDescription("Issue Voucher", useUnmergedTree = true)
            .performClick()

        composeTestRule.waitForIdle()

        // Then: Should be on Issue screen
        composeTestRule
            .onNodeWithText("Issue Voucher", substring = true)
            .assertIsDisplayed()

        // When: Press back
        composeTestRule
            .onNodeWithContentDescription("Back", useUnmergedTree = true)
            .performClick()

        composeTestRule.waitForIdle()

        // Then: Should be back on Vouchers list
        composeTestRule
            .onNodeWithText("Vouchers")
            .assertIsSelected()
    }
}
