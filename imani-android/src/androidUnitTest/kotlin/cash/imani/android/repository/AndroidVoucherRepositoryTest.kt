package cash.imani.android.repository

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import cash.imani.android.db.ImaniDatabase
import cash.imani.voucher.domain.Proof
import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherStatus
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Clock
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Unit tests for AndroidVoucherRepository.
 *
 * Tests:
 * - Voucher CRUD operations
 * - Voucher status updates
 * - Proof management (save, retrieve, select for amount)
 * - Balance calculations
 * - Reactive Flow queries
 * - Error handling (not found, insufficient balance)
 */
@RunWith(RobolectricTestRunner::class)
class AndroidVoucherRepositoryTest {

    private lateinit var database: ImaniDatabase
    private lateinit var repository: AndroidVoucherRepository

    @Before
    fun setup() {
        // Use in-memory SQLite database for tests
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        ImaniDatabase.Schema.create(driver)
        database = ImaniDatabase(driver)

        repository = AndroidVoucherRepository(database)
    }

    @After
    fun teardown() {
        database.close()
    }

    /**
     * Tests that saveVoucher stores a voucher in the database.
     */
    @Test
    fun `saveVoucher stores voucher in database`() = runTest {
        // Given
        val voucher = createTestVoucher("voucher-1")

        // When
        val result = repository.saveVoucher(voucher)

        // Then
        assertTrue(result.isSuccess)

        // Verify stored
        val retrieved = repository.getVoucher(voucher.voucherId)
        assertTrue(retrieved.isSuccess)
        assertEquals(voucher.voucherId, retrieved.getOrThrow().voucherId)
    }

    /**
     * Tests that listVouchers returns all vouchers ordered by issuedAt descending.
     */
    @Test
    fun `listVouchers returns all vouchers ordered by issuedAt`() = runTest {
        // Given
        repository.saveVoucher(createTestVoucher("voucher-1"))
        repository.saveVoucher(createTestVoucher("voucher-2"))
        repository.saveVoucher(createTestVoucher("voucher-3"))

        // When
        val result = repository.listVouchers()

        // Then
        assertTrue(result.isSuccess)
        val vouchers = result.getOrThrow()
        assertEquals(3, vouchers.size)
        // Most recent first
        assertEquals("voucher-3", vouchers[0].voucherId)
    }

    /**
     * Tests that getVoucher retrieves correct voucher by ID.
     */
    @Test
    fun `getVoucher retrieves correct voucher by ID`() = runTest {
        // Given
        val voucher = createTestVoucher("voucher-1")
        repository.saveVoucher(voucher)

        // When
        val result = repository.getVoucher("voucher-1")

        // Then
        assertTrue(result.isSuccess)
        assertEquals("voucher-1", result.getOrThrow().voucherId)
    }

    /**
     * Tests that getVoucher returns failure when voucher not found.
     */
    @Test
    fun `getVoucher returns failure when voucher not found`() = runTest {
        // When
        val result = repository.getVoucher("non-existent-id")

        // Then
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is VoucherNotFoundException)
    }

    /**
     * Tests that updateVoucherStatus updates the voucher status.
     */
    @Test
    fun `updateVoucherStatus updates voucher status successfully`() = runTest {
        // Given
        val voucher = createTestVoucher("voucher-1", VoucherStatus.ISSUED)
        repository.saveVoucher(voucher)

        // When
        val updateResult = repository.updateVoucherStatus("voucher-1", VoucherStatus.REDEEMED)

        // Then
        assertTrue(updateResult.isSuccess)

        // Verify status updated
        val updated = repository.getVoucher("voucher-1").getOrThrow()
        assertEquals(VoucherStatus.REDEEMED, updated.status)
    }

    /**
     * Tests that deleteVoucher removes voucher and associated proofs.
     */
    @Test
    fun `deleteVoucher removes voucher and associated proofs from database`() = runTest {
        // Given
        val voucher = createTestVoucher("voucher-1")
        repository.saveVoucher(voucher)

        val proofs = listOf(
            Proof(amount = 100, secret = "secret-1", C = "C1", id = "keyset-1"),
            Proof(amount = 200, secret = "secret-2", C = "C2", id = "keyset-1")
        )
        repository.saveProofs(proofs, voucherId = "voucher-1")

        // When
        val deleteResult = repository.deleteVoucher("voucher-1")

        // Then
        assertTrue(deleteResult.isSuccess)

        // Verify voucher is gone
        val getResult = repository.getVoucher("voucher-1")
        assertTrue(getResult.isFailure)

        // Verify proofs are gone
        val proofsResult = repository.getProofsByVoucher("voucher-1")
        assertTrue(proofsResult.isSuccess)
        assertEquals(0, proofsResult.getOrThrow().size)
    }

    /**
     * Tests that getVouchersByStatus filters vouchers by status.
     */
    @Test
    fun `getVouchersByStatus filters vouchers by status`() = runTest {
        // Given
        repository.saveVoucher(createTestVoucher("voucher-1", VoucherStatus.ISSUED))
        repository.saveVoucher(createTestVoucher("voucher-2", VoucherStatus.REDEEMED))
        repository.saveVoucher(createTestVoucher("voucher-3", VoucherStatus.ISSUED))

        // When
        val result = repository.getVouchersByStatus(VoucherStatus.ISSUED)

        // Then
        assertTrue(result.isSuccess)
        val vouchers = result.getOrThrow()
        assertEquals(2, vouchers.size)
        assertTrue(vouchers.all { it.status == VoucherStatus.ISSUED })
    }

    /**
     * Tests that saveProofs stores proofs in the database.
     */
    @Test
    fun `saveProofs stores proofs in database`() = runTest {
        // Given
        val proofs = listOf(
            Proof(amount = 100, secret = "secret-1", C = "C1", id = "keyset-1"),
            Proof(amount = 200, secret = "secret-2", C = "C2", id = "keyset-1")
        )

        // When
        val result = repository.saveProofs(proofs, voucherId = null)

        // Then
        assertTrue(result.isSuccess)

        // Verify stored
        val retrieved = repository.getUnspentProofs()
        assertTrue(retrieved.isSuccess)
        assertEquals(2, retrieved.getOrThrow().size)
    }

    /**
     * Tests that getProofsByVoucher retrieves proofs associated with a voucher.
     */
    @Test
    fun `getProofsByVoucher retrieves proofs associated with voucher`() = runTest {
        // Given
        val voucher = createTestVoucher("voucher-1")
        repository.saveVoucher(voucher)

        val proofs = listOf(
            Proof(amount = 100, secret = "secret-1", C = "C1", id = "keyset-1"),
            Proof(amount = 200, secret = "secret-2", C = "C2", id = "keyset-1")
        )
        repository.saveProofs(proofs, voucherId = "voucher-1")

        // When
        val result = repository.getProofsByVoucher("voucher-1")

        // Then
        assertTrue(result.isSuccess)
        assertEquals(2, result.getOrThrow().size)
    }

    /**
     * Tests that selectProofsForAmount selects proofs using FIFO strategy.
     */
    @Test
    fun `selectProofsForAmount selects proofs using FIFO strategy`() = runTest {
        // Given
        val proofs = listOf(
            Proof(amount = 100, secret = "secret-1", C = "C1", id = "keyset-1"),
            Proof(amount = 200, secret = "secret-2", C = "C2", id = "keyset-1"),
            Proof(amount = 500, secret = "secret-3", C = "C3", id = "keyset-1")
        )
        repository.saveProofs(proofs, voucherId = null)

        // When: Need 250 sats
        val result = repository.selectProofsForAmount(250, mintUrl = "", unit = "sat")

        // Then: Should select 100 + 200 = 300 (FIFO)
        assertTrue(result.isSuccess)
        val selected = result.getOrThrow()
        assertEquals(2, selected.size)
        assertEquals(100, selected[0].amount)
        assertEquals(200, selected[1].amount)
    }

    /**
     * Tests that selectProofsForAmount throws when insufficient balance.
     */
    @Test
    fun `selectProofsForAmount throws when insufficient balance`() = runTest {
        // Given
        val proofs = listOf(
            Proof(amount = 100, secret = "secret-1", C = "C1", id = "keyset-1")
        )
        repository.saveProofs(proofs, voucherId = null)

        // When: Need 500 sats (only have 100)
        val result = repository.selectProofsForAmount(500, mintUrl = "", unit = "sat")

        // Then
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is InsufficientBalanceException)
    }

    /**
     * Tests that markProofAsSpent updates the spentAt timestamp.
     */
    @Test
    fun `markProofAsSpent updates spentAt timestamp`() = runTest {
        // Given
        val proof = Proof(amount = 100, secret = "secret-1", C = "C1", id = "keyset-1")
        repository.saveProofs(listOf(proof), voucherId = null)

        // When
        val result = repository.markProofAsSpent("secret-1")

        // Then
        assertTrue(result.isSuccess)

        // Verify proof is marked as spent (won't appear in unspent list)
        val unspent = repository.getUnspentProofs().getOrThrow()
        assertEquals(0, unspent.size)
    }

    /**
     * Tests that getUnspentBalance calculates total unspent balance.
     */
    @Test
    fun `getUnspentBalance calculates total unspent balance correctly`() = runTest {
        // Given
        val proofs = listOf(
            Proof(amount = 100, secret = "secret-1", C = "C1", id = "keyset-1"),
            Proof(amount = 200, secret = "secret-2", C = "C2", id = "keyset-1"),
            Proof(amount = 300, secret = "secret-3", C = "C3", id = "keyset-1")
        )
        repository.saveProofs(proofs, voucherId = null)

        // When
        val balance = repository.getUnspentBalance(mintUrl = "", unit = "sat")

        // Then
        assertTrue(balance.isSuccess)
        assertEquals(600L, balance.getOrThrow())
    }

    /**
     * Tests that observeVouchers returns a Flow of all vouchers.
     */
    @Test
    fun `observeVouchers returns Flow of all vouchers`() = runTest {
        // Given
        repository.saveVoucher(createTestVoucher("voucher-1"))
        repository.saveVoucher(createTestVoucher("voucher-2"))

        // When
        val vouchers = mutableListOf<List<StoredVoucher>>()
        repository.observeVouchers().collect { vouchers.add(it) }

        // Then
        assertEquals(2, vouchers.last().size)
    }

    /**
     * Tests that observeVouchersByStatus returns Flow filtered by status.
     */
    @Test
    fun `observeVouchersByStatus returns Flow filtered by status`() = runTest {
        // Given
        repository.saveVoucher(createTestVoucher("voucher-1", VoucherStatus.ISSUED))
        repository.saveVoucher(createTestVoucher("voucher-2", VoucherStatus.REDEEMED))

        // When
        val vouchers = mutableListOf<List<StoredVoucher>>()
        repository.observeVouchersByStatus(VoucherStatus.ISSUED).collect { vouchers.add(it) }

        // Then
        assertEquals(1, vouchers.last().size)
        assertEquals(VoucherStatus.ISSUED, vouchers.last()[0].status)
    }

    // ==================== Helper Methods ====================

    private fun createTestVoucher(
        voucherId: String,
        status: VoucherStatus = VoucherStatus.ISSUED
    ): StoredVoucher {
        return StoredVoucher(
            voucherId = voucherId,
            issuerId = "issuer-1",
            unit = "sat",
            faceValue = 1000,
            expiresAt = null,
            memo = "Test voucher",
            issuerSignature = "0".repeat(128),
            issuerPublicKey = "0".repeat(64),
            issuedAt = Clock.System.now(),
            status = status,
            token = null
        )
    }
}
