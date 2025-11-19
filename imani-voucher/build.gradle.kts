plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    js(IR) {
        browser {
            testTask {
                // Skip browser tests if Chrome is not available
                // Browser testing will be addressed in Phase 4/5 with E2E tests
                enabled = System.getenv("CHROME_BIN") != null || System.getenv("CI") == "true"

                // Configure test runner to handle backtick test names
                useKarma {
                    useChromeHeadless()
                }
            }
        }
        binaries.executable()
        compilations.all {
            kotlinOptions {
                // Generate more lenient JS code for tests
                moduleKind = "umd"
            }
        }
    }

    jvm()

    sourceSets {
        val commonMain by getting {
            dependencies {
                implementation(project(":imani-identity"))
                implementation(libs.kotlinx.coroutines.core)
                implementation(libs.kotlinx.serialization.json)
                implementation(libs.kotlinx.serialization.cbor)
                implementation(libs.kotlinx.datetime)
                implementation(libs.ktor.client.core)
                implementation(libs.ktor.client.content.negotiation)
                implementation(libs.ktor.serialization.json)
                implementation(libs.ktor.client.logging)
            }
        }

        val commonTest by getting {
            dependencies {
                implementation(libs.kotlin.test)
                implementation(libs.kotlinx.coroutines.test)
            }
        }

        val jsMain by getting {
            dependencies {
                implementation(libs.ktor.client.js)
                implementation(npm("nostr-tools", "2.1.0"))
            }
        }
    }
}
