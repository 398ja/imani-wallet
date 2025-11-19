package cash.imani.android

import android.app.Application
import cash.imani.android.di.androidModule
import cash.imani.app.di.appModule
import org.koin.android.ext.koin.androidContext
import org.koin.android.ext.koin.androidLogger
import org.koin.core.context.startKoin
import org.koin.core.logger.Level

/**
 * Imani Wallet Android Application class.
 *
 * Initializes Koin dependency injection for the Android app.
 * Combines shared modules (appModule) with Android-specific modules (androidModule).
 */
class ImaniApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        initKoin()
    }

    private fun initKoin() {
        startKoin {
            androidLogger(Level.ERROR)
            androidContext(this@ImaniApplication)
            modules(
                appModule,      // Shared UI and domain logic
                androidModule   // Android-specific implementations (Keystore, SQLDelight)
            )
        }
    }
}
