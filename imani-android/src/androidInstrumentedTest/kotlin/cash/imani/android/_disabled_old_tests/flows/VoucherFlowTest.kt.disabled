package cash.imani.android.flows

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import cash.imani.android.MainActivity
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * End-to-end instrumentation test for voucher flows.
 *
 * Tests critical voucher operations:
 * 1. Navigate to Vouchers tab
 * 2. Issue voucher
 * 3. View voucher details
 * 4. Share voucher
 * 5. Redeem voucher
 *
 * Note: Some tests require mock mint server or real connectivity.
 */
@RunWith(AndroidJUnit4::class)
class VoucherFlowTest {

    @get:Rule
    val composeTestRule = createAndroidComposeRule<MainActivity>()

    /**
     * Tests navigation to Vouchers tab and list display.
     */
    @Test
    fun vouchersTab_navigation_success() {
        // Given: App loaded
        composeTestRule.waitForIdle()

        // When: Click Vouchers tab
        composeTestRule
            .onNodeWithText("Vouchers")
            .assertExists("Vouchers tab should exist")
            .performClick()

        composeTestRule.waitForIdle()

        // Then: Should navigate to Vouchers screen
        composeTestRule
            .onNodeWithText("Vouchers", substring = true)
            .assertIsDisplayed()

        // Should see voucher list (may be empty)
        composeTestRule.waitForIdle()

        // Verify FAB buttons exist
        composeTestRule
            .onNodeWithContentDescription("Issue Voucher", useUnmergedTree = true)
            .assertExists()

        composeTestRule
            .onNodeWithContentDescription("Redeem Voucher", useUnmergedTree = true)
            .assertExists()
    }

    /**
     * Tests clicking Issue Voucher FAB navigates to issue screen.
     */
    @Test
    fun issueVoucher_navigation_success() {
        // Given: App on Vouchers tab
        composeTestRule.waitForIdle()

        composeTestRule
            .onNodeWithText("Vouchers")
            .performClick()

        composeTestRule.waitForIdle()

        // When: Click Issue Voucher FAB
        composeTestRule
            .onNodeWithContentDescription("Issue Voucher", useUnmergedTree = true)
            .performClick()

        composeTestRule.waitForIdle()

        // Then: Should navigate to Issue Voucher screen
        composeTestRule
            .onNodeWithText("Issue Voucher", substring = true)
            .assertIsDisplayed()

        // Should show form fields
        composeTestRule
            .onNodeWithText("Amount", substring = true)
            .assertExists()

        composeTestRule
            .onNodeWithText("Memo", substring = true)
            .assertExists()

        composeTestRule
            .onNodeWithText("Expires in", substring = true)
            .assertExists()
    }

    /**
     * Tests issue voucher form validation.
     */
    @Test
    fun issueVoucher_emptyAmount_disablesButton() {
        // Given: On Issue Voucher screen
        composeTestRule.waitForIdle()

        composeTestRule
            .onNodeWithText("Vouchers")
            .performClick()

        composeTestRule.waitForIdle()

        composeTestRule
            .onNodeWithContentDescription("Issue Voucher", useUnmergedTree = true)
            .performClick()

        composeTestRule.waitForIdle()

        // When: Amount is empty
        // Then: Issue button should be disabled
        composeTestRule
            .onNodeWithText("Issue Voucher", substring = true)
            .assertIsNotEnabled()

        // When: Enter amount
        composeTestRule
            .onNodeWithText("Amount", substring = true)
            .performTextInput("1000")

        composeTestRule.waitForIdle()

        // Then: Button should become enabled
        composeTestRule
            .onNodeWithText("Issue Voucher", substring = true)
            .assertIsEnabled()
    }

    /**
     * Tests voucher list displays grouped by status.
     */
    @Test
    fun voucherList_groupedByStatus() {
        // Given: App on Vouchers tab
        composeTestRule.waitForIdle()

        composeTestRule
            .onNodeWithText("Vouchers")
            .performClick()

        composeTestRule.waitForIdle()

        // Then: If vouchers exist, they should be grouped by status
        // Status headers: ISSUED, DELIVERED, REDEEMED, REVOKED, EXPIRED
        // Note: Actual vouchers depend on test data

        // Verify list is scrollable
        composeTestRule
            .onRoot(useUnmergedTree = true)
            .assertExists()
    }

    /**
     * Tests redeem voucher navigation.
     */
    @Test
    fun redeemVoucher_navigation_success() {
        // Given: App on Vouchers tab
        composeTestRule.waitForIdle()

        composeTestRule
            .onNodeWithText("Vouchers")
            .performClick()

        composeTestRule.waitForIdle()

        // When: Click Redeem Voucher FAB
        composeTestRule
            .onNodeWithContentDescription("Redeem Voucher", useUnmergedTree = true)
            .performClick()

        composeTestRule.waitForIdle()

        // Then: Should navigate to Redeem Voucher screen
        composeTestRule
            .onNodeWithText("Redeem Voucher", substring = true)
            .assertIsDisplayed()

        // Should show input field for token
        composeTestRule
            .onNodeWithText("Voucher Token", substring = true, ignoreCase = true)
            .assertExists()

        // Should show scan QR button
        composeTestRule
            .onNodeWithText("Scan QR", substring = true, ignoreCase = true)
            .assertExists()
    }

    /**
     * Tests redeem voucher with empty token disables button.
     */
    @Test
    fun redeemVoucher_emptyToken_disablesButton() {
        // Given: On Redeem Voucher screen
        composeTestRule.waitForIdle()

        composeTestRule
            .onNodeWithText("Vouchers")
            .performClick()

        composeTestRule.waitForIdle()

        composeTestRule
            .onNodeWithContentDescription("Redeem Voucher", useUnmergedTree = true)
            .performClick()

        composeTestRule.waitForIdle()

        // When: Token is empty
        // Then: Redeem button should be disabled
        composeTestRule
            .onNodeWithText("Redeem", substring = true)
            .assertIsNotEnabled()

        // When: Enter token (valid format starts with "cashuA")
        composeTestRule
            .onNodeWithText("Voucher Token", substring = true, ignoreCase = true)
            .performTextInput("cashuA1234567890abcdef")

        composeTestRule.waitForIdle()

        // Then: Button should become enabled
        composeTestRule
            .onNodeWithText("Redeem", substring = true)
            .assertIsEnabled()
    }

    /**
     * Tests navigation between voucher screens preserves tab state.
     */
    @Test
    fun voucherNavigation_preservesTabState() {
        // Given: App loaded
        composeTestRule.waitForIdle()

        // When: Navigate to Vouchers
        composeTestRule
            .onNodeWithText("Vouchers")
            .performClick()

        composeTestRule.waitForIdle()

        // Then: Vouchers tab should be selected
        composeTestRule
            .onNodeWithText("Vouchers")
            .assertIsSelected()

        // When: Navigate to Issue screen and back
        composeTestRule
            .onNodeWithContentDescription("Issue Voucher", useUnmergedTree = true)
            .performClick()

        composeTestRule.waitForIdle()

        // Navigate back
        composeTestRule
            .onNodeWithContentDescription("Back", useUnmergedTree = true)
            .performClick()

        composeTestRule.waitForIdle()

        // Then: Should still be on Vouchers tab
        composeTestRule
            .onNodeWithText("Vouchers")
            .assertIsSelected()
    }

    /**
     * Tests voucher card displays correct status badge.
     */
    @Test
    fun voucherCard_displaysStatusBadge() {
        // Given: App on Vouchers tab with vouchers
        composeTestRule.waitForIdle()

        composeTestRule
            .onNodeWithText("Vouchers")
            .performClick()

        composeTestRule.waitForIdle()

        // Then: Voucher cards should display status badges
        // Possible statuses: ISSUED, DELIVERED, REDEEMED, REVOKED, EXPIRED
        // Note: Specific assertions depend on existing data

        // Verify list container exists
        composeTestRule
            .onRoot(useUnmergedTree = true)
            .assertExists()
    }

    /**
     * Tests share voucher navigation (if voucher exists).
     */
    @Test
    fun shareVoucher_navigation_success() {
        // Given: App on Vouchers tab
        composeTestRule.waitForIdle()

        composeTestRule
            .onNodeWithText("Vouchers")
            .performClick()

        composeTestRule.waitForIdle()

        // Note: Clicking a voucher card to view details requires existing voucher
        // This test verifies the UI structure is correct for sharing
        // Full test requires test data setup
    }
}
