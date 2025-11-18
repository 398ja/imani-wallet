plugins {
    kotlin("multiplatform") version "1.9.22" apply false
    kotlin("plugin.serialization") version "1.9.22" apply false
    id("org.jetbrains.compose") version "1.6.0" apply false
    id("com.android.application") version "8.2.2" apply false
    id("com.android.library") version "8.2.2" apply false
    alias(libs.plugins.kover)
}

allprojects {
    group = "cash.imani"
    version = "1.0.0-SNAPSHOT"
}

// Kover configuration for code coverage
dependencies {
    kover(project(":imani-identity"))
    kover(project(":imani-voucher"))
}

kover {
    reports {
        filters {
            excludes {
                // Exclude generated code
                classes("*.BuildConfig")
                // Exclude platform-specific implementations (will be tested separately)
                packages("cash.imani.*.platform")
            }
        }
    }
}

tasks.register("clean", Delete::class) {
    delete(rootProject.layout.buildDirectory)
}
