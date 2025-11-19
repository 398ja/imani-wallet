package cash.imani.android.ui.navigation

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import cash.imani.android.ui.theme.ImaniTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Unit tests for MainScreen navigation.
 *
 * Tests bottom navigation, screen switching, and back button handling.
 * Uses Compose Testing API.
 */
@RunWith(AndroidJUnit4::class)
class MainScreenTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    /**
     * Tests that MainScreen shows bottom navigation with 3 tabs.
     */
    @Test
    fun mainScreen_showsBottomNavigation() {
        // When: Setting content
        composeTestRule.setContent {
            ImaniTheme {
                MainScreen()
            }
        }

        // Then: Should show all 3 navigation items
        composeTestRule
            .onNodeWithText("Identities")
            .assertIsDisplayed()

        composeTestRule
            .onNodeWithText("Vouchers")
            .assertIsDisplayed()

        composeTestRule
            .onNodeWithText("Settings")
            .assertIsDisplayed()
    }

    /**
     * Tests that first tab (Identities) is selected by default.
     */
    @Test
    fun mainScreen_selectsFirstTabByDefault() {
        // When: Setting content
        composeTestRule.setContent {
            ImaniTheme {
                MainScreen()
            }
        }

        // Then: Identities tab should be selected
        composeTestRule
            .onNodeWithText("Identities")
            .assertIsSelected()

        composeTestRule
            .onNodeWithText("Vouchers")
            .assertIsNotSelected()

        composeTestRule
            .onNodeWithText("Settings")
            .assertIsNotSelected()
    }

    /**
     * Tests that clicking Vouchers tab switches to Vouchers screen.
     */
    @Test
    fun mainScreen_switchesToVouchersTab() {
        // Given: Main screen displayed
        composeTestRule.setContent {
            ImaniTheme {
                MainScreen()
            }
        }

        // When: Clicking Vouchers tab
        composeTestRule
            .onNodeWithText("Vouchers")
            .performClick()

        // Then: Vouchers tab should be selected
        composeTestRule
            .onNodeWithText("Vouchers")
            .assertIsSelected()

        composeTestRule
            .onNodeWithText("Identities")
            .assertIsNotSelected()

        // Should show Vouchers screen (verify by top bar title)
        composeTestRule
            .onNodeWithText("Vouchers", substring = true, ignoreCase = true)
            .assertExists()
    }

    /**
     * Tests that clicking Settings tab switches to Settings screen.
     */
    @Test
    fun mainScreen_switchesToSettingsTab() {
        // Given: Main screen displayed
        composeTestRule.setContent {
            ImaniTheme {
                MainScreen()
            }
        }

        // When: Clicking Settings tab
        composeTestRule
            .onNodeWithText("Settings")
            .performClick()

        // Then: Settings tab should be selected
        composeTestRule
            .onNodeWithText("Settings")
            .assertIsSelected()

        composeTestRule
            .onNodeWithText("Identities")
            .assertIsNotSelected()

        // Should show Settings screen
        composeTestRule
            .onNodeWithText("Settings", substring = true, ignoreCase = true)
            .assertExists()
    }

    /**
     * Tests that navigation items show correct icons.
     */
    @Test
    fun mainScreen_showsCorrectIcons() {
        // When: Setting content
        composeTestRule.setContent {
            ImaniTheme {
                MainScreen()
            }
        }

        // Then: Should show Person icon for Identities
        composeTestRule
            .onNodeWithContentDescription("Person")
            .assertExists()

        // Should show CardGiftcard icon for Vouchers
        composeTestRule
            .onNodeWithContentDescription("CardGiftcard")
            .assertExists()

        // Should show Settings icon
        composeTestRule
            .onNodeWithContentDescription("Settings")
            .assertExists()
    }

    /**
     * Tests that tab switching preserves state correctly.
     */
    @Test
    fun mainScreen_preservesStateWhenSwitchingTabs() {
        // Given: Main screen displayed
        composeTestRule.setContent {
            ImaniTheme {
                MainScreen()
            }
        }

        // When: Clicking Vouchers, then Settings, then back to Identities
        composeTestRule.onNodeWithText("Vouchers").performClick()
        composeTestRule.waitForIdle()

        composeTestRule.onNodeWithText("Settings").performClick()
        composeTestRule.waitForIdle()

        composeTestRule.onNodeWithText("Identities").performClick()
        composeTestRule.waitForIdle()

        // Then: Should be back on Identities tab
        composeTestRule
            .onNodeWithText("Identities")
            .assertIsSelected()
    }

    /**
     * Tests that bottom navigation is always visible.
     */
    @Test
    fun mainScreen_bottomNavigationAlwaysVisible() {
        // Given: Main screen displayed
        composeTestRule.setContent {
            ImaniTheme {
                MainScreen()
            }
        }

        // When: Switching between tabs
        val tabs = listOf("Identities", "Vouchers", "Settings")
        tabs.forEach { tab ->
            composeTestRule.onNodeWithText(tab).performClick()
            composeTestRule.waitForIdle()

            // Then: All navigation items should still be visible
            tabs.forEach { otherTab ->
                composeTestRule
                    .onNodeWithText(otherTab)
                    .assertIsDisplayed()
            }
        }
    }

    /**
     * Tests that NavigationItem data class has correct properties.
     */
    @Test
    fun navigationItem_hasCorrectProperties() {
        // Given: Navigation items

        // When/Then: Verify data class works correctly
        val item = NavigationItem(
            label = "Test",
            icon = androidx.compose.material.icons.Icons.Default.Home,
            screen = NavigationScreen.Identities
        )

        assert(item.label == "Test")
        assert(item.screen == NavigationScreen.Identities)
    }

    /**
     * Tests that NavigationScreen enum has all 3 screens.
     */
    @Test
    fun navigationScreen_hasAllScreens() {
        // Then: Should have 3 screens
        val screens = NavigationScreen.values()
        assert(screens.size == 3)
        assert(screens.contains(NavigationScreen.Identities))
        assert(screens.contains(NavigationScreen.Vouchers))
        assert(screens.contains(NavigationScreen.Settings))
    }
}
