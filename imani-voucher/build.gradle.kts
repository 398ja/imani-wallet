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

        val jvmMain by getting {
            dependencies {
                // cashu-client wallet-core-app dependency (VoucherService, SendService, TokenCodec)
                // Version 1.2.0 includes:
                // - VoucherServiceImpl: Issue, redeem, revoke, verify vouchers
                // - SendService: Nostr backup/restore (NIP-17 + NIP-44)
                // - TokenCodec: Cashu token encoding/decoding
                // - NostrGatewayService: Nostr relay integration
                //
                // Exclusions for Android compatibility:
                // - Jakarta EE (jakarta.el.*): Android doesn't support Jakarta EE
                // - Tomcat (tomcat-embed-*): Server-side dependency not needed on Android
                // - BouncyCastle provider conflicts: Android has its own BouncyCastle version
                // - Spring Framework: Server-side dependency not needed on Android
                implementation("xyz.tcheeric:wallet-core-app:1.2.0") {
                    exclude(group = "jakarta.el", module = "jakarta.el-api")
                    exclude(group = "org.apache.tomcat.embed", module = "tomcat-embed-el")
                    exclude(group = "org.bouncycastle", module = "bcprov-jdk15to18")
                    exclude(group = "org.bouncycastle", module = "bcprov-jdk18on")
                    // Exclude all Spring Framework dependencies (server-side only)
                    exclude(group = "org.springframework")
                    exclude(group = "org.springframework.boot")
                    exclude(group = "org.springframework.data")
                    exclude(group = "org.springframework.hateoas")
                }
            }
        }
    }
}
