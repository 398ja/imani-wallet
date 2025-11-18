plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    js(IR) {
        browser {
            commonWebpackConfig {
                cssSupport {
                    enabled.set(true)
                }
            }
            testTask {
                enabled = false // Disable JS tests in Phase 0 (JVM-focused)
            }
        }
        binaries.executable()
    }

    jvm()

    sourceSets {
        val commonMain by getting {
            dependencies {
                implementation(libs.kotlinx.coroutines.core)
                implementation(libs.kotlinx.serialization.json)
                implementation(libs.kotlinx.datetime)
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
                // Noble crypto libraries for secp256k1 and hashing
                implementation(npm("@noble/secp256k1", "2.0.0"))
                implementation(npm("@noble/hashes", "1.3.3"))
                implementation(npm("@scure/bip39", "1.2.1"))
            }
        }
    }
}
