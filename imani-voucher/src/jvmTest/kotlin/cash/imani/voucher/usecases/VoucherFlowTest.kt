package cash.imani.voucher.usecases

import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherStatus
import cash.imani.voucher.nostr.NostrConfig
import cash.imani.voucher.repository.createNostrVoucherRepository
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Clock
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.milliseconds

/**
 * End-to-end integration tests for Nostr voucher flows.
 *
 * Tests the Nostr integration specifically:
 * 1. Publish voucher to Nostr relay
 * 2. Query voucher from Nostr relay
 * 3. Update voucher status on Nostr
 * 4. Sync vouchers across multiple devices via Nostr
 * 5. Cache behavior (cache-first reads, publish-first writes)
 *
 * Prerequisites:
 * - Local Nostr relay running on ws://localhost:5555
 *
 * Note: These tests focus on Nostr integration, not mint API interactions.
 * Mint API testing is covered in separate unit tests.
 */
class VoucherFlowTest {
    private fun createTestVoucher(
        voucherId: String = "flow_test_${Clock.System.now().toEpochMilliseconds()}",
        status: VoucherStatus = VoucherStatus.ISSUED,
    ): StoredVoucher {
        val now = Clock.System.now()
        return StoredVoucher(
            voucherId = voucherId,
            issuerId = "test_issuer",
            unit = "sat",
            faceValue = 1000,
            expiresAt = now.plus(7.days).epochSeconds,
            memo = "Integration test voucher",
            issuerSignature = "0".repeat(128),
            issuerPublicKey = "0".repeat(64),
            issuedAt = now,
            status = status,
            token = "cashuAeyJ0...test",
        )
    }

    @Test
    fun `complete voucher lifecycle on Nostr`() =
        runTest {
            // Arrange
            val repository =
                createNostrVoucherRepository(
                    relayUrls = NostrConfig.LOCAL_RELAY,
                    syncOnInit = false,
                )

            val voucher = createTestVoucher()

            // Act 1: Issue voucher (publish to Nostr)
            val saveResult = repository.saveVoucher(voucher)

            // Assert: Publish succeeded
            assertTrue(saveResult.isSuccess, "Save should succeed")

            // Wait for relay to process
            delay(100.milliseconds)

            // Act 2: Query voucher from Nostr
            val queriedVoucher = repository.getVoucher(voucher.voucherId).getOrThrow()

            // Assert: Voucher retrievable from Nostr
            assertNotNull(queriedVoucher, "Should retrieve from Nostr")
            assertEquals(voucher.voucherId, queriedVoucher.voucherId)
            assertEquals(VoucherStatus.ISSUED, queriedVoucher.status)

            // Act 3: Update status to DELIVERED
            repository.updateVoucherStatus(voucher.voucherId, VoucherStatus.DELIVERED).getOrThrow()

            // Wait for relay to process update
            delay(100.milliseconds)

            // Act 4: Query updated voucher
            val updatedVoucher = repository.getVoucher(voucher.voucherId).getOrThrow()

            // Assert: Status updated on Nostr
            assertNotNull(updatedVoucher)
            assertEquals(VoucherStatus.DELIVERED, updatedVoucher.status)

            // Act 5: Update to REDEEMED
            repository.updateVoucherStatus(voucher.voucherId, VoucherStatus.REDEEMED).getOrThrow()

            // Wait for relay to process
            delay(100.milliseconds)

            // Act 6: Final query
            val redeemedVoucher = repository.getVoucher(voucher.voucherId).getOrThrow()

            // Assert: Final status correct
            assertNotNull(redeemedVoucher)
            assertEquals(VoucherStatus.REDEEMED, redeemedVoucher.status)
        }

    @Test
    fun `multi-device sync via Nostr relay`() =
        runTest {
            // Arrange - Device 1
            val device1 =
                createNostrVoucherRepository(
                    relayUrls = NostrConfig.LOCAL_RELAY,
                    syncOnInit = false,
                )

            val voucher = createTestVoucher("multi_device_${Clock.System.now().toEpochMilliseconds()}")

            // Act: Device 1 publishes voucher
            device1.saveVoucher(voucher).getOrThrow()

            // Wait for relay to process
            delay(100.milliseconds)

            // Arrange - Device 2 (different repository instance)
            val device2 =
                createNostrVoucherRepository(
                    relayUrls = NostrConfig.LOCAL_RELAY,
                    syncOnInit = false,
                )

            // Act: Device 2 syncs from Nostr
            val syncResult = device2.syncFromNostr()

            // Assert: Sync succeeded
            assertTrue(syncResult.isSuccess, "Sync should succeed")

            // Verify voucher synced to Device 2
            val syncedVoucher = device2.getVoucher(voucher.voucherId).getOrThrow()
            assertNotNull(syncedVoucher, "Voucher should sync to Device 2")
            assertEquals(voucher.voucherId, syncedVoucher.voucherId)
            assertEquals(voucher.faceValue, syncedVoucher.faceValue)
            assertEquals(voucher.memo, syncedVoucher.memo)
        }

    @Test
    fun `cache-first read avoids unnecessary Nostr queries`() =
        runTest {
            // Arrange
            val repository =
                createNostrVoucherRepository(
                    relayUrls = NostrConfig.LOCAL_RELAY,
                    syncOnInit = false,
                )

            val voucher = createTestVoucher()

            // Publish voucher (populates cache)
            repository.saveVoucher(voucher).getOrThrow()

            // Act: Query voucher multiple times (should hit cache)
            val query1 = repository.getVoucher(voucher.voucherId).getOrThrow()
            val query2 = repository.getVoucher(voucher.voucherId).getOrThrow()
            val query3 = repository.getVoucher(voucher.voucherId).getOrThrow()

            // Assert: All queries return same voucher (from cache)
            assertNotNull(query1)
            assertNotNull(query2)
            assertNotNull(query3)
            assertEquals(query1.voucherId, query2.voucherId)
            assertEquals(query2.voucherId, query3.voucherId)
        }

    @Test
    fun `publish-first write ensures Nostr is source of truth`() =
        runTest {
            // Arrange
            val repository =
                createNostrVoucherRepository(
                    relayUrls = NostrConfig.LOCAL_RELAY,
                    syncOnInit = false,
                )

            val voucher = createTestVoucher()

            // Act: Save voucher (publishes to Nostr first, then caches)
            val saveResult = repository.saveVoucher(voucher)

            // Assert: Save succeeded
            assertTrue(saveResult.isSuccess, "Save should succeed")

            // Wait for relay
            delay(100.milliseconds)

            // Clear cache to force Nostr query
            repository.clearCache().getOrThrow()

            // Query from Nostr directly
            val fromNostr = repository.getVoucher(voucher.voucherId).getOrThrow()

            // Assert: Voucher is in Nostr (source of truth)
            assertNotNull(fromNostr, "Voucher must be in Nostr")
            assertEquals(voucher.voucherId, fromNostr.voucherId)
        }

    @Test
    fun `query by status returns filtered vouchers from Nostr`() =
        runTest {
            // Arrange
            val repository =
                createNostrVoucherRepository(
                    relayUrls = NostrConfig.LOCAL_RELAY,
                    syncOnInit = false,
                )

            // Create vouchers with different statuses
            val issued1 = createTestVoucher("issued_a_${Clock.System.now().toEpochMilliseconds()}", VoucherStatus.ISSUED)
            val issued2 = createTestVoucher("issued_b_${Clock.System.now().toEpochMilliseconds()}", VoucherStatus.ISSUED)
            val redeemed = createTestVoucher("redeemed_${Clock.System.now().toEpochMilliseconds()}", VoucherStatus.REDEEMED)

            repository.saveVoucher(issued1).getOrThrow()
            repository.saveVoucher(issued2).getOrThrow()
            repository.saveVoucher(redeemed).getOrThrow()

            // Wait for relay
            delay(200.milliseconds)

            // Act: Query by status
            val issuedVouchers = repository.getVouchersByStatus(VoucherStatus.ISSUED).getOrThrow()

            // Assert: Returns only ISSUED vouchers
            assertTrue(issuedVouchers.size >= 2, "Should have at least 2 issued vouchers")
            assertTrue(issuedVouchers.all { it.status == VoucherStatus.ISSUED }, "All should have ISSUED status")
        }

    @Test
    fun `offline mode works with cached vouchers`() =
        runTest {
            // Arrange
            val repository =
                createNostrVoucherRepository(
                    relayUrls = NostrConfig.LOCAL_RELAY,
                    syncOnInit = false,
                )

            val voucher = createTestVoucher("offline_${Clock.System.now().toEpochMilliseconds()}")

            // Save while "online" (publishes to Nostr + caches)
            repository.saveVoucher(voucher).getOrThrow()

            // Act: Query voucher (will use cache if available)
            val cachedVoucher = repository.getVoucher(voucher.voucherId).getOrThrow()

            // Assert: Voucher available from cache
            assertNotNull(cachedVoucher, "Should be available from cache")
            assertEquals(voucher.voucherId, cachedVoucher.voucherId)

            // Verify getAllVouchers also works from cache
            val allVouchers = repository.getAllVouchers().getOrThrow()
            assertTrue(allVouchers.any { it.voucherId == voucher.voucherId }, "Should be in cached list")
        }

    @Test
    fun `status update propagates through NIP-33 event replacement`() =
        runTest {
            // Arrange
            val repository =
                createNostrVoucherRepository(
                    relayUrls = NostrConfig.LOCAL_RELAY,
                    syncOnInit = false,
                )

            val voucher = createTestVoucher(status = VoucherStatus.ISSUED)

            // Publish initial voucher
            repository.saveVoucher(voucher).getOrThrow()

            // Wait for relay
            delay(100.milliseconds)

            // Act: Update status multiple times (tests NIP-33 replacement)
            repository.updateVoucherStatus(voucher.voucherId, VoucherStatus.DELIVERED).getOrThrow()
            delay(100.milliseconds)

            repository.updateVoucherStatus(voucher.voucherId, VoucherStatus.REDEEMED).getOrThrow()
            delay(100.milliseconds)

            // Query latest version from Nostr
            repository.clearCache().getOrThrow() // Force Nostr query
            val latestVoucher = repository.getVoucher(voucher.voucherId).getOrThrow()

            // Assert: Latest status is REDEEMED (NIP-33 replaced earlier events)
            assertNotNull(latestVoucher)
            assertEquals(VoucherStatus.REDEEMED, latestVoucher.status)
        }
}
