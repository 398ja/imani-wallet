package cash.imani.android

import android.app.Application
import cash.imani.app.di.appModule
import org.koin.android.ext.koin.androidContext
import org.koin.android.ext.koin.androidLogger
import org.koin.core.context.startKoin
import org.koin.core.logger.Level

/**
 * Imani Wallet Android Application class.
 *
 * Initializes Koin dependency injection for the Android app.
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
                appModule
                // TODO: Add androidModule when platform-specific implementations are ready
            )
        }
    }
}
