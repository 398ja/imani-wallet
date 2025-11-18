package cash.imani.identity.usecases

import cash.imani.identity.domain.Identity
import cash.imani.identity.repository.IdentityRepository

/**
 * Use case for listing all stored identities.
 *
 * Responsibilities:
 * - Retrieves all identities from repository
 * - Returns sorted by lastUsedAt (most recent first)
 * - Filters out inactive identities (optional)
 *
 * Business Rules:
 * - Private keys NOT included in results (security)
 * - Sorted by activity (lastUsedAt descending)
 * - Empty list if no identities exist
 *
 * Design: Query pattern with single responsibility
 */
class ListIdentitiesUseCase(
    private val identityRepository: IdentityRepository,
) {
    /**
     * Executes the use case to list all identities.
     *
     * @param includeInactive If false, filters out dormant identities (default: true)
     * @return Result containing list of identities
     */
    suspend operator fun invoke(includeInactive: Boolean = true): Result<List<Identity>> =
        runCatching {
            val allIdentities = identityRepository.listIdentities().getOrThrow()

            if (includeInactive) {
                allIdentities
            } else {
                // Filter to only active identities (used within 90 days)
                allIdentities.filter { it.isActive() }
            }
        }
}
