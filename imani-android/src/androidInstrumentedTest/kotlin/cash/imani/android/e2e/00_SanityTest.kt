package cash.imani.android.e2e

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import cash.imani.android.MainActivity
import cash.imani.android.e2e.fixtures.ImaniTestFixtures
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Rule
import org.junit.Test

/**
 * Sanity E2E test: Application loads and basic UI is visible.
 *
 * Mirrors: e2e/tests/00-sanity.spec.ts
 */
private const val DEFAULT_TEST_TIMEOUT_MS = 30_000L

private fun runE2ETest(block: suspend CoroutineScope.() -> Unit) {
    runBlocking {
        withTimeout(DEFAULT_TEST_TIMEOUT_MS) {
            block()
        }
    }
}

class SanityTest {
    @get:Rule
    val composeTestRule = createAndroidComposeRule<MainActivity>()

    /**
     * Tests that the application loads without crashing.
     */
    @Test
    fun should_load_the_application() =
        runE2ETest {
            val fixtures = ImaniTestFixtures(composeTestRule)

            // Wait for app to load
            fixtures.waitForAppLoad()

            // Should see bottom navigation (may have duplicates: nav tab + screen title)
            // Use assertAny to check at least one node exists with the text
            composeTestRule.onAllNodesWithText("Identities").assertAny(hasText("Identities"))
            composeTestRule.onAllNodesWithText("Vouchers").assertAny(hasText("Vouchers"))
            composeTestRule.onAllNodesWithText("Settings").assertAny(hasText("Settings"))
        }

    /**
     * Tests that the app shows initial screen (either onboarding or home).
     */
    @Test
    fun should_show_initial_screen() =
        runE2ETest {
            val fixtures = ImaniTestFixtures(composeTestRule)
            fixtures.waitForAppLoad()

            // Should show either:
            // - Empty state with "Create Identity" button, OR
            // - Identity list screen

            val hasCreateButton =
                composeTestRule.onAllNodesWithContentDescription("Create Identity")
                    .fetchSemanticsNodes().isNotEmpty()

            val hasIdentityList =
                composeTestRule.onAllNodesWithText("Identities")
                    .fetchSemanticsNodes().isNotEmpty()

            assert(hasCreateButton || hasIdentityList) {
                "Expected either Create Identity button or Identity list to be visible"
            }
        }

    /**
     * Tests that bottom navigation works.
     */
    @Test
    fun should_navigate_between_tabs() =
        runE2ETest {
            val fixtures = ImaniTestFixtures(composeTestRule)
            fixtures.waitForAppLoad()

            // Navigate to each tab
            fixtures.gotoVouchers()
            composeTestRule.onAllNodesWithText("Vouchers").assertAny(hasText("Vouchers"))

            fixtures.gotoSettings()
            composeTestRule.onAllNodesWithText("Settings").assertAny(hasText("Settings"))

            fixtures.gotoIdentities()
            composeTestRule.onAllNodesWithText("Identities").assertAny(hasText("Identities"))
        }
}
