plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.compose)
}

kotlin {
    js(IR) {
        browser {
            commonWebpackConfig {
                outputFileName = "imani-wallet.js"
                devServer = devServer?.copy(port = 8181)
            }
        }
        binaries.executable()
    }

    sourceSets {
        val jsMain by getting {
            dependencies {
                implementation(project(":imani-app"))
                implementation(compose.ui)
                implementation(compose.runtime)
                implementation(libs.koin.core)
            }
        }
    }
}

compose.experimental {
    web.application {}
}
