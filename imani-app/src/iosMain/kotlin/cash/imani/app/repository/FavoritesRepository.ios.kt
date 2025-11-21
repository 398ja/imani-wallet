package cash.imani.app.repository

/**
 * iOS implementation uses in-memory storage.
 * TODO: Use NSUserDefaults for persistence.
 */
actual fun createFavoritesRepository(): FavoritesRepository = InMemoryFavoritesRepository()
