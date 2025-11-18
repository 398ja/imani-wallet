plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.compose)
}

kotlin {
    js(IR) {
        browser()
        binaries.executable()
    }

    jvm()

    sourceSets {
        val commonMain by getting {
            dependencies {
                implementation(project(":imani-identity"))
                implementation(project(":imani-voucher"))
                implementation(compose.runtime)
                implementation(compose.foundation)
                implementation(compose.material3)
                implementation(compose.ui)
                // Commented out for Phase 1 - will add back in Phase 2 when needed
                // implementation(compose.components.resources)
                implementation(libs.voyager.navigator)
                implementation(libs.voyager.transitions)
                implementation(libs.koin.core)
                implementation(libs.kotlinx.datetime)
                implementation(libs.ktor.client.core)
            }
        }

        val commonTest by getting {
            dependencies {
                implementation(libs.kotlin.test)
            }
        }

        val jsMain by getting {
            dependencies {
                implementation(compose.html.core)
            }
        }
    }
}

compose.experimental {
    web.application {}
}
