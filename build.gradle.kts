plugins {
    kotlin("multiplatform") version "1.9.22" apply false
    kotlin("plugin.serialization") version "1.9.22" apply false
    id("org.jetbrains.compose") version "1.6.0" apply false
    id("com.android.application") version "8.2.2" apply false
    id("com.android.library") version "8.2.2" apply false
    alias(libs.plugins.kover)
    alias(libs.plugins.ktlint)
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

// Apply ktlint to all subprojects
subprojects {
    apply(plugin = "org.jlleitschuh.gradle.ktlint")

    configure<org.jlleitschuh.gradle.ktlint.KtlintExtension> {
        version.set("1.0.1")
        android.set(false)
        outputColorName.set("RED")
        ignoreFailures.set(false)
        reporters {
            reporter(org.jlleitschuh.gradle.ktlint.reporter.ReporterType.CHECKSTYLE)
            reporter(org.jlleitschuh.gradle.ktlint.reporter.ReporterType.HTML)
        }
        filter {
            exclude("**/generated/**")
            exclude("**/build/**")
        }
    }
}

tasks.register("clean", Delete::class) {
    delete(rootProject.layout.buildDirectory)
}
