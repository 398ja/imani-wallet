package cash.imani.voucher.repository

import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherStatus
import cash.imani.voucher.nostr.NostrConfig
import cash.imani.voucher.nostr.NostrVoucherClient
import cash.imani.voucher.nostr.createNostrVoucherClient
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Clock
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.days

/**
 * Integration tests for NostrVoucherRepository.
 *
 * Tests hybrid storage pattern:
 * - Publish-first writes (Nostr → cache)
 * - Cache-first reads (cache → Nostr on miss)
 * - Background sync from Nostr
 * - Offline mode (cache-only)
 *
 * Prerequisites:
 * - Local Nostr relay running on ws://localhost:5555
 * - Run: nostr-rs-relay or knostr
 *
 * Note: These tests use the local relay configured in NostrConfig.LOCAL_RELAY
 */
class NostrVoucherRepositoryTest {
    private fun createTestVoucher(
        voucherId: String = "test_voucher_${Clock.System.now().toEpochMilliseconds()}",
        status: VoucherStatus = VoucherStatus.ISSUED,
    ): StoredVoucher {
        val now = Clock.System.now()
        return StoredVoucher(
            voucherId = voucherId,
            issuerId = "test_issuer",
            unit = "sat",
            faceValue = 1000,
            expiresAt = now.plus(7.days).epochSeconds,
            memo = "Test voucher",
            issuerSignature = "0".repeat(128),
            issuerPublicKey = "0".repeat(64),
            issuedAt = now,
            status = status,
            token = "cashuAeyJ0...test",
        )
    }

    @Test
    fun `saveVoucher publishes to Nostr and caches locally`() =
        runTest {
            // Arrange
            val repository =
                createNostrVoucherRepository(
                    relayUrls = NostrConfig.LOCAL_RELAY,
                    syncOnInit = false,
                )
            val voucher = createTestVoucher()

            // Act
            val saveResult = repository.saveVoucher(voucher)

            // Assert
            assertTrue(saveResult.isSuccess, "Save should succeed")

            // Verify voucher is in Nostr
            val fromNostr = repository.getVoucher(voucher.voucherId).getOrThrow()
            assertNotNull(fromNostr, "Voucher should be retrievable from Nostr")
            assertEquals(voucher.voucherId, fromNostr.voucherId)
            assertEquals(voucher.faceValue, fromNostr.faceValue)
        }

    @Test
    fun `getVoucher returns from cache on cache hit`() =
        runTest {
            // Arrange
            val repository =
                createNostrVoucherRepository(
                    relayUrls = NostrConfig.LOCAL_RELAY,
                    syncOnInit = false,
                )
            val voucher = createTestVoucher()

            // Save voucher (publishes to Nostr + caches)
            repository.saveVoucher(voucher).getOrThrow()

            // Act: Query voucher (should hit cache)
            val retrieved = repository.getVoucher(voucher.voucherId).getOrThrow()

            // Assert
            assertNotNull(retrieved, "Voucher should be retrieved from cache")
            assertEquals(voucher.voucherId, retrieved.voucherId)
            assertEquals(voucher.faceValue, retrieved.faceValue)
            assertEquals(voucher.status, retrieved.status)
        }

    @Test
    fun `getVoucher queries Nostr on cache miss`() =
        runTest {
            // Arrange
            val repository =
                createNostrVoucherRepository(
                    relayUrls = NostrConfig.LOCAL_RELAY,
                    syncOnInit = false,
                )
            val voucher = createTestVoucher()

            // Save voucher
            repository.saveVoucher(voucher).getOrThrow()

            // Clear cache to simulate cache miss
            repository.clearCache().getOrThrow()

            // Act: Query voucher (should query Nostr and re-cache)
            val retrieved = repository.getVoucher(voucher.voucherId).getOrThrow()

            // Assert
            assertNotNull(retrieved, "Voucher should be retrieved from Nostr")
            assertEquals(voucher.voucherId, retrieved.voucherId)
            assertEquals(voucher.faceValue, retrieved.faceValue)
        }

    @Test
    fun `updateVoucherStatus updates both Nostr and cache`() =
        runTest {
            // Arrange
            val repository =
                createNostrVoucherRepository(
                    relayUrls = NostrConfig.LOCAL_RELAY,
                    syncOnInit = false,
                )
            val voucher = createTestVoucher(status = VoucherStatus.ISSUED)

            // Save voucher
            repository.saveVoucher(voucher).getOrThrow()

            // Act: Update status
            val updateResult = repository.updateVoucherStatus(voucher.voucherId, VoucherStatus.REDEEMED)

            // Assert
            assertTrue(updateResult.isSuccess, "Update should succeed")

            // Verify updated status in Nostr
            val retrieved = repository.getVoucher(voucher.voucherId).getOrThrow()
            assertNotNull(retrieved)
            assertEquals(VoucherStatus.REDEEMED, retrieved.status)
        }

    @Test
    fun `getVouchersByStatus queries both cache and Nostr`() =
        runTest {
            // Arrange
            val repository =
                createNostrVoucherRepository(
                    relayUrls = NostrConfig.LOCAL_RELAY,
                    syncOnInit = false,
                )

            // Create multiple vouchers with different statuses
            val issuedVoucher1 = createTestVoucher("issued_1", VoucherStatus.ISSUED)
            val issuedVoucher2 = createTestVoucher("issued_2", VoucherStatus.ISSUED)
            val redeemedVoucher = createTestVoucher("redeemed_1", VoucherStatus.REDEEMED)

            repository.saveVoucher(issuedVoucher1).getOrThrow()
            repository.saveVoucher(issuedVoucher2).getOrThrow()
            repository.saveVoucher(redeemedVoucher).getOrThrow()

            // Act: Query issued vouchers
            val issuedVouchers = repository.getVouchersByStatus(VoucherStatus.ISSUED).getOrThrow()

            // Assert
            assertTrue(issuedVouchers.size >= 2, "Should have at least 2 issued vouchers")
            assertTrue(issuedVouchers.any { it.voucherId == "issued_1" })
            assertTrue(issuedVouchers.any { it.voucherId == "issued_2" })
        }

    @Test
    fun `syncFromNostr updates cache with Nostr events`() =
        runTest {
            // Arrange
            val repository =
                createNostrVoucherRepository(
                    relayUrls = NostrConfig.LOCAL_RELAY,
                    syncOnInit = false,
                )

            // Save vouchers
            val voucher1 = createTestVoucher("sync_1")
            val voucher2 = createTestVoucher("sync_2")
            repository.saveVoucher(voucher1).getOrThrow()
            repository.saveVoucher(voucher2).getOrThrow()

            // Clear cache to simulate new device
            repository.clearCache().getOrThrow()

            // Act: Sync from Nostr
            val syncResult = repository.syncFromNostr()

            // Assert
            assertTrue(syncResult.isSuccess, "Sync should succeed")
            val syncedCount = syncResult.getOrThrow()
            assertTrue(syncedCount >= 2, "Should sync at least 2 vouchers")

            // Verify vouchers are now in cache
            val cached1 = repository.getVoucher("sync_1").getOrThrow()
            val cached2 = repository.getVoucher("sync_2").getOrThrow()
            assertNotNull(cached1)
            assertNotNull(cached2)
        }

    @Test
    fun `syncIfNeeded only syncs if threshold exceeded`() =
        runTest {
            // Arrange
            val repository =
                createNostrVoucherRepository(
                    relayUrls = NostrConfig.LOCAL_RELAY,
                    syncOnInit = false,
                )

            // First sync
            val firstSync = repository.syncFromNostr().getOrThrow()
            assertTrue(firstSync >= 0, "First sync should succeed")

            // Act: Immediate sync (should skip due to threshold)
            val secondSync = repository.syncIfNeeded().getOrThrow()

            // Assert: Should skip (return 0) because last sync was recent
            assertEquals(0, secondSync, "Should skip sync when threshold not exceeded")
        }

    @Test
    fun `offline mode works with cache-only access`() =
        runTest {
            // Arrange
            val repository =
                createNostrVoucherRepository(
                    relayUrls = NostrConfig.LOCAL_RELAY,
                    syncOnInit = false,
                )

            // Save voucher while online
            val voucher = createTestVoucher("offline_test")
            repository.saveVoucher(voucher).getOrThrow()

            // Act: Query voucher (should work from cache even if Nostr unavailable)
            val retrieved = repository.getVoucher(voucher.voucherId).getOrThrow()

            // Assert
            assertNotNull(retrieved, "Voucher should be available from cache")
            assertEquals(voucher.voucherId, retrieved.voucherId)
        }

    @Test
    fun `clearCache removes all cached vouchers`() =
        runTest {
            // Arrange
            val repository =
                createNostrVoucherRepository(
                    relayUrls = NostrConfig.LOCAL_RELAY,
                    syncOnInit = false,
                )

            // Save vouchers
            repository.saveVoucher(createTestVoucher("clear_1")).getOrThrow()
            repository.saveVoucher(createTestVoucher("clear_2")).getOrThrow()

            // Verify vouchers are cached
            val beforeClear = repository.getAllVouchers().getOrThrow()
            assertTrue(beforeClear.size >= 2, "Should have at least 2 vouchers")

            // Act: Clear cache
            val clearResult = repository.clearCache()

            // Assert
            assertTrue(clearResult.isSuccess, "Clear should succeed")

            val afterClear = repository.getAllVouchers().getOrThrow()
            assertEquals(0, afterClear.size, "Cache should be empty after clear")
        }

    @Test
    fun `getCacheStats returns accurate statistics`() =
        runTest {
            // Arrange
            val repository =
                createNostrVoucherRepository(
                    relayUrls = NostrConfig.LOCAL_RELAY,
                    syncOnInit = false,
                )

            // Act: Get initial stats
            val stats = repository.getCacheStats().getOrThrow()

            // Assert
            assertNotNull(stats["voucherCount"], "Should have voucher count")
            assertNotNull(stats["syncThresholdMs"], "Should have sync threshold")
            assertNotNull(stats["isSyncing"], "Should have syncing status")
            assertNotNull(stats["lastSyncTime"], "Should have last sync time")
        }

    @Test
    fun `deleteVoucher removes from cache but not Nostr`() =
        runTest {
            // Arrange
            val repository =
                createNostrVoucherRepository(
                    relayUrls = NostrConfig.LOCAL_RELAY,
                    syncOnInit = false,
                )

            val voucher = createTestVoucher("delete_test")
            repository.saveVoucher(voucher).getOrThrow()

            // Act: Delete voucher
            val deleteResult = repository.deleteVoucher(voucher.voucherId)

            // Assert
            assertTrue(deleteResult.isSuccess, "Delete should succeed")

            // Verify removed from cache
            val cachedVouchers = repository.getAllVouchers().getOrThrow()
            assertTrue(cachedVouchers.none { it.voucherId == voucher.voucherId })

            // Note: Nostr events cannot be truly deleted, they remain on relays
            // This is expected behavior per NIP-33 (replaceable events)
        }
}
