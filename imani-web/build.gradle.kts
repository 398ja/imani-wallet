plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.compose)
}

kotlin {
    js(IR) {
        browser {
            commonWebpackConfig {
                outputFileName = "imani-wallet.js"
            }
        }
        binaries.executable()
    }

    sourceSets {
        val jsMain by getting {
            dependencies {
                implementation(project(":imani-app"))
                implementation(compose.html.core)
            }
        }
    }
}

compose.experimental {
    web.application {}
}
