rootProject.name = "imani-wallet"

enableFeaturePreview("TYPESAFE_PROJECT_ACCESSORS")

pluginManagement {
    repositories {
        google()
        gradlePluginPortal()
        mavenCentral()
        maven("https://maven.pkg.jetbrains.space/public/p/compose/dev")
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        mavenLocal() // For cashu-client dependencies (xyz.tcheeric:wallet-core-app:1.2.0)
        maven("https://maven.pkg.jetbrains.space/public/p/compose/dev")
    }
}

include(":imani-identity")
include(":imani-voucher")
include(":imani-app")
include(":imani-web")
include(":imani-android")
