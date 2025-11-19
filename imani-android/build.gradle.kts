plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.android.application)
    alias(libs.plugins.compose)
    alias(libs.plugins.sqldelight)
}

kotlin {
    androidTarget {
        compilations.all {
            kotlinOptions {
                jvmTarget = "17"
            }
        }
    }

    sourceSets {
        val androidMain by getting {
            dependencies {
                // Imani modules (reuse existing KMP code)
                implementation(project(":imani-identity"))
                implementation(project(":imani-voucher"))
                implementation(project(":imani-app"))

                // Kotlin libraries
                implementation(libs.kotlinx.coroutines.core)
                implementation(libs.kotlinx.datetime)
                implementation(libs.kotlinx.serialization.json)

                // Android Core
                implementation(libs.androidx.core.ktx)
                implementation(libs.androidx.lifecycle.runtime.ktx)
                implementation(libs.androidx.activity.compose)

                // Security
                implementation(libs.androidx.biometric)
                implementation(libs.androidx.security.crypto)

                // Compose
                implementation(compose.runtime)
                implementation(compose.foundation)
                implementation(compose.material3)
                implementation(compose.ui)
                implementation(compose.components.resources)

                // Compose Android-specific
                implementation("androidx.compose.ui:ui-tooling-preview:1.6.0")
                implementation("androidx.compose.material:material-icons-extended:1.6.0")
                implementation("androidx.compose.ui:ui-tooling:1.6.0")

                // Camera
                implementation(libs.androidx.camera.camera2)
                implementation(libs.androidx.camera.lifecycle)
                implementation(libs.androidx.camera.view)

                // QR Code
                implementation(libs.zxing.core)

                // ML Kit
                implementation(libs.mlkit.barcode.scanning)

                // Accompanist
                implementation(libs.accompanist.permissions)

                // SQLDelight
                implementation(libs.sqldelight.android.driver)
                implementation(libs.sqldelight.coroutines)

                // Ktor
                implementation(libs.ktor.client.okhttp)

                // Koin
                implementation(libs.koin.android)
                implementation(libs.koin.androidx.compose)

                // Navigation
                implementation(libs.voyager.navigator)
                implementation(libs.voyager.transitions)
            }
        }

        val androidUnitTest by getting {
            dependencies {
                implementation(libs.kotlin.test)
                implementation(libs.kotlinx.coroutines.test)
                implementation(libs.robolectric)
                implementation(libs.mockk.android)
                implementation(libs.androidx.test.core)
            }
        }
    }
}

android {
    namespace = "cash.imani.android"
    compileSdk = 34

    defaultConfig {
        applicationId = "cash.imani.wallet"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        vectorDrawables {
            useSupportLibrary = true
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            isDebuggable = true
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.10"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

sqldelight {
    databases {
        create("ImaniDatabase") {
            packageName.set("cash.imani.android.db")
            srcDirs.setFrom("src/commonMain/sqldelight")
        }
    }
}
