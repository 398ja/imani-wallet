package cash.imani.android.repository

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cash.sqldelight.driver.android.AndroidSqliteDriver
import cash.imani.android.db.ImaniDatabase
import cash.imani.voucher.domain.Proof
import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherStatus
import cash.imani.voucher.exception.InsufficientBalanceException
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Clock
import kotlinx.datetime.Instant
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.days

/**
 * Unit tests for AndroidVoucherRepository.
 *
 * Tests voucher operations, proof management, and FIFO coin selection.
 * Uses AndroidJUnit4 with real SQLDelight database.
 */
@RunWith(AndroidJUnit4::class)
class AndroidVoucherRepositoryTest {

    private lateinit var context: Context
    private lateinit var database: ImaniDatabase
    private lateinit var repository: AndroidVoucherRepository

    @Before
    fun setup() {
        context = ApplicationProvider.getApplicationContext()

        // Create in-memory database for testing
        val driver = AndroidSqliteDriver(
            schema = ImaniDatabase.Schema,
            context = context,
            name = null // null = in-memory
        )
        database = ImaniDatabase(driver)
        repository = AndroidVoucherRepository(database)
    }

    @After
    fun teardown() {
        database.close()
    }

    // Voucher tests

    /**
     * Tests that saveVoucher stores voucher in database.
     */
    @Test
    fun saveVoucher_storesVoucher() = runTest {
        // Given: A sample voucher
        val voucher = createSampleVoucher("voucher-1", 1000)

        // When: Saving the voucher
        val result = repository.saveVoucher(voucher)

        // Then: Should succeed
        assertTrue(result.isSuccess)

        // Verify stored
        val stored = database.voucherQueries.selectById("voucher-1").executeAsOne()
        assertEquals("voucher-1", stored.voucherId)
        assertEquals(1000L, stored.faceValue)
    }

    /**
     * Tests that listVouchers returns all vouchers sorted by issuedAt descending.
     */
    @Test
    fun listVouchers_returnsAllVouchersSortedByIssuedAt() = runTest {
        // Given: Multiple vouchers with different issuedAt
        val now = Clock.System.now()
        val voucher1 = createSampleVoucher("v1", 1000).copy(issuedAt = now.minus(2.days))
        val voucher2 = createSampleVoucher("v2", 2000).copy(issuedAt = now.minus(1.days))
        val voucher3 = createSampleVoucher("v3", 3000).copy(issuedAt = now)

        repository.saveVoucher(voucher1)
        repository.saveVoucher(voucher2)
        repository.saveVoucher(voucher3)

        // When: Listing vouchers
        val result = repository.listVouchers()

        // Then: Should return all vouchers sorted by issuedAt DESC
        assertTrue(result.isSuccess)
        val vouchers = result.getOrThrow()
        assertEquals(3, vouchers.size)
        assertEquals("v3", vouchers[0].voucherId) // Most recent
        assertEquals("v2", vouchers[1].voucherId)
        assertEquals("v1", vouchers[2].voucherId)
    }

    /**
     * Tests that getVoucher retrieves specific voucher by ID.
     */
    @Test
    fun getVoucher_retrievesVoucherById() = runTest {
        // Given: Multiple vouchers saved
        repository.saveVoucher(createSampleVoucher("v1", 1000))
        repository.saveVoucher(createSampleVoucher("v2", 2000))

        // When: Getting specific voucher
        val result = repository.getVoucher("v1")

        // Then: Should return correct voucher
        assertTrue(result.isSuccess)
        val voucher = result.getOrThrow()
        assertEquals("v1", voucher.voucherId)
        assertEquals(1000L, voucher.faceValue)
    }

    /**
     * Tests that updateVoucherStatus updates voucher status.
     */
    @Test
    fun updateVoucherStatus_updatesStatus() = runTest {
        // Given: A voucher saved
        val voucher = createSampleVoucher("v1", 1000)
        repository.saveVoucher(voucher)

        // When: Updating status to REDEEMED
        val result = repository.updateVoucherStatus("v1", VoucherStatus.REDEEMED)

        // Then: Should succeed
        assertTrue(result.isSuccess)

        // Verify updated
        val retrieved = repository.getVoucher("v1").getOrThrow()
        assertEquals(VoucherStatus.REDEEMED, retrieved.status)
    }

    /**
     * Tests that deleteVoucher removes voucher from database.
     */
    @Test
    fun deleteVoucher_removesVoucher() = runTest {
        // Given: A voucher saved
        repository.saveVoucher(createSampleVoucher("v1", 1000))

        // When: Deleting the voucher
        val result = repository.deleteVoucher("v1")

        // Then: Should succeed
        assertTrue(result.isSuccess)

        // Verify removed
        val list = repository.listVouchers().getOrThrow()
        assertTrue(list.none { it.voucherId == "v1" })
    }

    /**
     * Tests that listVouchersByStatus filters by status.
     */
    @Test
    fun listVouchersByStatus_filtersCorrectly() = runTest {
        // Given: Vouchers with different statuses
        repository.saveVoucher(createSampleVoucher("v1", 1000).copy(status = VoucherStatus.ISSUED))
        repository.saveVoucher(createSampleVoucher("v2", 2000).copy(status = VoucherStatus.REDEEMED))
        repository.saveVoucher(createSampleVoucher("v3", 3000).copy(status = VoucherStatus.ISSUED))

        // When: Listing only ISSUED vouchers
        val result = repository.listVouchersByStatus(VoucherStatus.ISSUED)

        // Then: Should return only ISSUED vouchers
        assertTrue(result.isSuccess)
        val vouchers = result.getOrThrow()
        assertEquals(2, vouchers.size)
        assertTrue(vouchers.all { it.status == VoucherStatus.ISSUED })
    }

    // Proof tests

    /**
     * Tests that saveProofs stores proofs in database.
     */
    @Test
    fun saveProofs_storesProofs() = runTest {
        // Given: Sample proofs
        val proofs = listOf(
            Proof(amount = 100, secret = "secret1", C = "C1", id = "keyset1"),
            Proof(amount = 200, secret = "secret2", C = "C2", id = "keyset1")
        )

        // When: Saving proofs
        val result = repository.saveProofs(proofs, "https://mint.test")

        // Then: Should succeed
        assertTrue(result.isSuccess)

        // Verify stored
        val stored = database.voucherQueries.selectAllProofs().executeAsList()
        assertEquals(2, stored.size)
    }

    /**
     * Tests that listProofs returns all proofs for mint and unit.
     */
    @Test
    fun listProofs_returnsProofsForMintAndUnit() = runTest {
        // Given: Proofs for different mints
        val proofs1 = listOf(Proof(100, "s1", "C1", "k1"))
        val proofs2 = listOf(Proof(200, "s2", "C2", "k1"))

        repository.saveProofs(proofs1, "https://mint1.test")
        repository.saveProofs(proofs2, "https://mint2.test")

        // When: Listing proofs for mint1
        val result = repository.listProofs("https://mint1.test", "sat")

        // Then: Should return only mint1 proofs
        assertTrue(result.isSuccess)
        val proofs = result.getOrThrow()
        assertEquals(1, proofs.size)
        assertEquals("s1", proofs[0].secret)
    }

    /**
     * Tests that selectProofsForAmount uses FIFO selection.
     */
    @Test
    fun selectProofsForAmount_usesFIFOSelection() = runTest {
        // Given: Multiple proofs with different amounts
        val proofs = listOf(
            Proof(amount = 100, secret = "s1", C = "C1", id = "k1"),
            Proof(amount = 200, secret = "s2", C = "C2", id = "k1"),
            Proof(amount = 500, secret = "s3", C = "C3", id = "k1"),
            Proof(amount = 50, secret = "s4", C = "C4", id = "k1")
        )
        repository.saveProofs(proofs, "https://mint.test")

        // When: Selecting proofs for 250 sats
        val result = repository.selectProofsForAmount(250, "https://mint.test", "sat")

        // Then: Should select smallest proofs that sum to >= 250
        assertTrue(result.isSuccess)
        val selected = result.getOrThrow()
        assertEquals(3, selected.size) // 50 + 100 + 200 = 350
        assertTrue(selected.sumOf { it.amount } >= 250)
    }

    /**
     * Tests that selectProofsForAmount throws InsufficientBalanceException when not enough funds.
     */
    @Test
    fun selectProofsForAmount_throwsInsufficientBalanceExceptionWhenNotEnoughFunds() = runTest {
        // Given: Proofs totaling 300 sats
        val proofs = listOf(
            Proof(amount = 100, secret = "s1", C = "C1", id = "k1"),
            Proof(amount = 200, secret = "s2", C = "C2", id = "k1")
        )
        repository.saveProofs(proofs, "https://mint.test")

        // When: Trying to select 500 sats
        val result = repository.selectProofsForAmount(500, "https://mint.test", "sat")

        // Then: Should fail with InsufficientBalanceException
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is InsufficientBalanceException)
    }

    /**
     * Tests that deleteProofs removes proofs by secrets.
     */
    @Test
    fun deleteProofs_removesProofsBySecrets() = runTest {
        // Given: Multiple proofs saved
        val proofs = listOf(
            Proof(100, "s1", "C1", "k1"),
            Proof(200, "s2", "C2", "k1"),
            Proof(300, "s3", "C3", "k1")
        )
        repository.saveProofs(proofs, "https://mint.test")

        // When: Deleting specific proofs
        val result = repository.deleteProofs(listOf("s1", "s3"))

        // Then: Should succeed
        assertTrue(result.isSuccess)

        // Verify only s2 remains
        val remaining = repository.listProofs("https://mint.test", "sat").getOrThrow()
        assertEquals(1, remaining.size)
        assertEquals("s2", remaining[0].secret)
    }

    /**
     * Tests that markProofsAsSpent updates spentAt timestamp.
     */
    @Test
    fun markProofsAsSpent_updatesSpentAtTimestamp() = runTest {
        // Given: Unspent proofs
        val proofs = listOf(Proof(100, "s1", "C1", "k1"))
        repository.saveProofs(proofs, "https://mint.test")

        // When: Marking as spent
        val result = repository.markProofsAsSpent(listOf("s1"))

        // Then: Should succeed
        assertTrue(result.isSuccess)

        // Verify spentAt is set
        val stored = database.voucherQueries.selectAllProofs().executeAsOne()
        assertNotNull(stored.spentAt)
    }

    /**
     * Tests that getTotalBalance calculates total unspent balance.
     */
    @Test
    fun getTotalBalance_calculatesTotalUnspentBalance() = runTest {
        // Given: Mix of spent and unspent proofs
        val proofs = listOf(
            Proof(100, "s1", "C1", "k1"),
            Proof(200, "s2", "C2", "k1"),
            Proof(300, "s3", "C3", "k1")
        )
        repository.saveProofs(proofs, "https://mint.test")
        repository.markProofsAsSpent(listOf("s2")) // Mark 200 as spent

        // When: Getting total balance
        val result = repository.getTotalBalance("https://mint.test", "sat")

        // Then: Should return 400 (100 + 300, excluding spent 200)
        assertTrue(result.isSuccess)
        assertEquals(400L, result.getOrThrow())
    }

    /**
     * Tests that observeVouchers returns reactive Flow.
     */
    @Test
    fun observeVouchers_returnsReactiveFlow() = runTest {
        // Given: Initial voucher saved
        repository.saveVoucher(createSampleVoucher("v1", 1000))

        // When: Observing vouchers
        val flow = repository.observeVouchers()

        // Then: Flow should emit current list
        flow.collect { vouchers ->
            assertEquals(1, vouchers.size)
            assertEquals("v1", vouchers[0].voucherId)
            return@collect // Exit after first emission
        }
    }

    /**
     * Tests that saveVoucher with same ID replaces existing (INSERT OR REPLACE).
     */
    @Test
    fun saveVoucher_replacesExistingVoucherWithSameId() = runTest {
        // Given: A voucher saved
        val voucher1 = createSampleVoucher("v1", 1000)
        repository.saveVoucher(voucher1)

        // When: Saving another voucher with same ID but different memo
        val voucher2 = voucher1.copy(memo = "Updated memo")
        val result = repository.saveVoucher(voucher2)

        // Then: Should succeed and replace
        assertTrue(result.isSuccess)

        val vouchers = repository.listVouchers().getOrThrow()
        assertEquals(1, vouchers.size)
        assertEquals("Updated memo", vouchers[0].memo)
    }

    /**
     * Tests that proof foreign key constraint works (voucher deletion sets voucherId to NULL).
     */
    @Test
    fun deleteVoucher_setsProofVoucherIdToNull() = runTest {
        // Given: A voucher with associated proofs
        val voucher = createSampleVoucher("v1", 1000)
        repository.saveVoucher(voucher)

        val proofs = listOf(Proof(100, "s1", "C1", "k1"))
        repository.saveProofs(proofs, "https://mint.test")

        // Associate proof with voucher (manual update for testing)
        database.voucherQueries.updateProofVoucherId("s1", "v1")

        // When: Deleting the voucher
        repository.deleteVoucher("v1")

        // Then: Proof should have voucherId set to NULL (ON DELETE SET NULL)
        val proof = database.voucherQueries.selectProofBySecret("s1").executeAsOne()
        assertEquals(null, proof.voucherId)
    }

    // Helper functions

    private fun createSampleVoucher(
        voucherId: String,
        faceValue: Long,
        status: VoucherStatus = VoucherStatus.ISSUED
    ): StoredVoucher {
        return StoredVoucher(
            voucherId = voucherId,
            issuerId = "issuer-1",
            unit = "sat",
            faceValue = faceValue,
            expiresAt = null,
            memo = "Test voucher",
            issuerSignature = "signature",
            issuerPublicKey = "0".repeat(64),
            issuedAt = Clock.System.now(),
            status = status,
            token = null,
            deliveryMetadata = null,
            redemptionMetadata = null
        )
    }
}
