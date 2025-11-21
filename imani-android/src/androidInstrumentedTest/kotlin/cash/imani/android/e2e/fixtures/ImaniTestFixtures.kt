package cash.imani.android.e2e.fixtures

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.delay

/**
 * Test fixtures for Imani Wallet E2E tests.
 *
 * Provides reusable helper functions that mirror the Playwright fixtures
 * from e2e/tests/fixtures.ts.
 *
 * Usage:
 * ```kotlin
 * @get:Rule
 * val composeTestRule = createAndroidComposeRule<MainActivity>()
 *
 * @Test
 * fun myTest() = runTest {
 *     val fixtures = ImaniTestFixtures(composeTestRule)
 *     fixtures.createNewIdentity("Test Identity")
 *     fixtures.issueVoucher(100, "Test voucher")
 * }
 * ```
 */
class ImaniTestFixtures(private val composeTestRule: ComposeTestRule) {
    // ==================== Navigation Helpers ====================

    /**
     * Waits for the app to fully load.
     */
    suspend fun waitForAppLoad(timeoutMillis: Long = 10000) {
        composeTestRule.waitUntil(timeoutMillis) {
            composeTestRule.onAllNodes(hasTestTag("app-loaded") or hasText("Identities"))
                .fetchSemanticsNodes().isNotEmpty()
        }
        delay(500) // Small delay for stability
    }

    /**
     * Navigates to Settings tab.
     */
    fun gotoSettings() {
        // Use onAllNodesWithText()[0] to handle multiple matches (nav tab + screen title)
        composeTestRule.onAllNodesWithText("Settings")[0].performClick()
        composeTestRule.waitForIdle()
    }

    /**
     * Navigates to Identities tab.
     */
    fun gotoIdentities() {
        // Use onAllNodesWithText()[0] to handle multiple matches (nav tab + screen title)
        composeTestRule.onAllNodesWithText("Identities")[0].performClick()
        composeTestRule.waitForIdle()
    }

    /**
     * Navigates to Vouchers tab.
     */
    fun gotoVouchers() {
        // Use onAllNodesWithText()[0] to handle multiple matches (nav tab + screen title)
        composeTestRule.onAllNodesWithText("Vouchers")[0].performClick()
        composeTestRule.waitForIdle()
    }

    // ==================== Identity Helpers ====================

    /**
     * Creates a new identity with the given label.
     *
     * Equivalent to Playwright: `imaniPage.createNewIdentity(label)`
     */
    suspend fun createNewIdentity(label: String) {
        // Wait for app to load
        waitForAppLoad()

        // Navigate to Identities tab if not already there
        composeTestRule.onAllNodesWithText("Identities")[0]
            .performClick()

        composeTestRule.waitForIdle()
        delay(1000)

        // Click "Create Identity" FAB
        composeTestRule.onNodeWithContentDescription("Create Identity")
            .assertIsDisplayed()
            .performClick()

        composeTestRule.waitForIdle()
        delay(1000)

        // Fill in identity label (UI uses "Label" not "Identity Label")
        composeTestRule.onNode(
            hasSetTextAction() and hasText("Label", substring = true),
        ).performTextInput(label)

        composeTestRule.waitForIdle()
        delay(500)

        // Click "Create" button
        composeTestRule.onNodeWithText("Create")
            .performClick()

        // Wait for mnemonic screen - this can take time for key generation
        composeTestRule.waitForIdle()
        delay(2000)

        // Wait for mnemonic screen with backup checkbox (longer timeout for key generation)
        val mnemonicVisible =
            waitForNodeWithText(
                text = "I have securely backed up my recovery phrase",
                timeoutMillis = 30_000,
            )
        if (!mnemonicVisible) {
            // Try alternative text that might be displayed
            val altVisible = waitForNodeWithText(
                text = "Recovery Phrase",
                timeoutMillis = 5_000,
            )
            if (!altVisible) {
                throw AssertionError(
                    "Mnemonic confirmation not visible after creating identity.\n${dumpSemanticsTree()}",
                )
            }
        }

        composeTestRule.waitForIdle()
        delay(1000)

        // The checkbox and text are in a Row - click anywhere in that row to toggle
        composeTestRule.onNodeWithText("I have securely backed up my recovery phrase")
            .performClick()

        composeTestRule.waitForIdle()
        delay(500)

        // Click "Done" button
        composeTestRule.onNodeWithText("Done")
            .performClick()

        composeTestRule.waitForIdle()
        delay(1000)
    }

    /**
     * Imports an identity from mnemonic.
     *
     * Equivalent to Playwright: `imaniPage.importIdentity(mnemonic, label)`
     */
    suspend fun importIdentity(
        mnemonic: String,
        label: String,
    ) {
        waitForAppLoad()

        gotoIdentities()

        // Click "Import Identity" button (may be in menu or FAB)
        composeTestRule.onNodeWithContentDescription("Import Identity")
            .performClick()

        composeTestRule.waitForIdle()

        // Fill mnemonic
        composeTestRule.onNode(
            hasSetTextAction() and hasText("Mnemonic", substring = true),
        ).performTextInput(mnemonic)

        // Fill label
        composeTestRule.onNode(
            hasSetTextAction() and hasText("Label", substring = true),
        ).performTextInput(label)

        composeTestRule.waitForIdle()

        // Click "Import" button
        composeTestRule.onNodeWithText("Import")
            .performClick()

        composeTestRule.waitForIdle()
        delay(500)
    }

    // ==================== Voucher Helpers ====================

    /**
     * Issues a new voucher with the given amount and optional memo.
     *
     * Equivalent to Playwright: `imaniPage.issueVoucher(amount, memo)`
     */
    suspend fun issueVoucher(
        amount: Int,
        memo: String? = null,
    ) {
        gotoVouchers()
        delay(500)

        // Click "Issue Voucher" FAB
        composeTestRule.onNodeWithContentDescription("Issue Voucher")
            .assertIsDisplayed()
            .performClick()

        composeTestRule.waitForIdle()
        delay(500)

        // Fill amount
        composeTestRule.onNode(
            hasSetTextAction() and hasText("Amount", substring = true),
        ).performTextInput(amount.toString())

        // Fill memo if provided
        if (memo != null) {
            composeTestRule.onNode(
                hasSetTextAction() and hasText("Memo", substring = true),
            ).performTextInput(memo)
        }

        composeTestRule.waitForIdle()

        // Click "Issue Voucher" button
        composeTestRule.onNodeWithText("Issue Voucher")
            .performClick()

        // Wait for success (share screen or voucher list)
        composeTestRule.waitUntil(15000) {
            composeTestRule.onAllNodesWithText("Share Voucher")
                .fetchSemanticsNodes().isNotEmpty() ||
                composeTestRule.onAllNodes(hasContentDescription("Voucher item"))
                    .fetchSemanticsNodes().isNotEmpty()
        }

        composeTestRule.waitForIdle()
        delay(500)
    }

    /**
     * Gets the voucher token from the share screen.
     *
     * Equivalent to Playwright: `imaniPage.shareVoucher()`
     *
     * @return The voucher token string
     */
    suspend fun shareVoucher(): String {
        // Assume we're on the share screen after issuing
        // Find the token text
        val tokenNode =
            composeTestRule.onNode(
                hasTestTag("voucher-token") or
                    hasContentDescription("Voucher token"),
            )

        // Get token text
        var token = ""
        tokenNode.fetchSemanticsNode().config.forEach { (key, value) ->
            if (key.name == "Text") {
                token = value.toString()
            }
        }

        return token
    }

    /**
     * Redeems a voucher from a token.
     *
     * Equivalent to Playwright: `imaniPage.redeemVoucher(token)`
     */
    suspend fun redeemVoucher(token: String) {
        gotoVouchers()
        delay(500)

        // Click "Redeem Voucher" button
        composeTestRule.onNodeWithContentDescription("Redeem Voucher")
            .performClick()

        composeTestRule.waitForIdle()
        delay(500)

        // Fill token
        composeTestRule.onNode(
            hasSetTextAction() and hasText("Token", substring = true),
        ).performTextInput(token)

        composeTestRule.waitForIdle()

        // Click "Redeem" button
        composeTestRule.onNodeWithText("Redeem")
            .performClick()

        // Wait for success
        composeTestRule.waitUntil(15000) {
            composeTestRule.onAllNodes(hasText("success", substring = true, ignoreCase = true))
                .fetchSemanticsNodes().isNotEmpty()
        }

        composeTestRule.waitForIdle()
        delay(500)
    }

    // ==================== Assertion Helpers ====================

    /**
     * Asserts that an identity with the given label exists.
     */
    fun expectIdentityExists(label: String) {
        gotoIdentities()
        composeTestRule.onNodeWithText(label).assertIsDisplayed()
    }

    /**
     * Asserts that a voucher with the given amount is in the list.
     */
    fun expectVoucherInList(amount: Int) {
        gotoVouchers()
        composeTestRule.onNode(
            hasText("$amount", substring = true),
        ).assertIsDisplayed()
    }

    /**
     * Asserts that the balance matches the expected amount.
     */
    fun expectBalance(amount: Int) {
        composeTestRule.onNode(
            hasTestTag("balance-display") or
                hasContentDescription("Balance"),
        ).assertTextContains(amount.toString())
    }

    /**
     * Asserts that an error toast with the given message is displayed.
     */
    fun expectErrorToast(message: String) {
        composeTestRule.onNode(
            hasText(message, substring = true, ignoreCase = true),
        ).assertIsDisplayed()
    }

    /**
     * Asserts that a success toast with the given message is displayed.
     */
    fun expectSuccessToast(message: String) {
        composeTestRule.onNode(
            hasText(message, substring = true, ignoreCase = true),
        ).assertIsDisplayed()
    }

    // ==================== Storage Helpers ====================

    /**
     * Clears all app data (similar to clearing localStorage/IndexedDB in web).
     */
    fun clearAppData() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext

        // Clear all SharedPreferences that the app uses
        context.getSharedPreferences("imani_prefs", android.content.Context.MODE_PRIVATE)
            .edit().clear().commit()

        // Clear identity mnemonics (used by AndroidIdentityRepository)
        context.getSharedPreferences("imani_identity", android.content.Context.MODE_PRIVATE)
            .edit().clear().commit()

        // Clear database
        context.deleteDatabase("imani.db")

        composeTestRule.waitForIdle()
    }

    private fun waitForNodeWithText(
        text: String,
        timeoutMillis: Long,
        substring: Boolean = false,
    ): Boolean =
        try {
            composeTestRule.waitUntil(timeoutMillis) {
                composeTestRule.onAllNodesWithText(text, substring = substring)
                    .fetchSemanticsNodes().isNotEmpty()
            }
            true
        } catch (_: Throwable) {
            false
        }

    private fun dumpSemanticsTree(): String =
        composeTestRule.onRoot(useUnmergedTree = true).printToString()

    // ==================== Helper Extensions ====================

    private fun SemanticsNodeInteraction.catch(block: () -> Unit): SemanticsNodeInteraction {
        return try {
            this
        } catch (e: Exception) {
            block()
            this
        }
    }
}
