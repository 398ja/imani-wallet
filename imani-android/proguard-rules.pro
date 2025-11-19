# imani-android/proguard-rules.pro

# Keep Kotlin serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# Keep domain models
-keep class cash.imani.identity.domain.** { *; }
-keep class cash.imani.voucher.domain.** { *; }

# Keep Ktor
-keep class io.ktor.** { *; }
-dontwarn io.ktor.**

# Keep SQLDelight
-keep class app.cash.sqldelight.** { *; }

# Keep Compose
-keep class androidx.compose.** { *; }
-dontwarn androidx.compose.**

# Keep Koin
-keep class org.koin.** { *; }
-dontwarn org.koin.**

# Keep Voyager
-keep class cafe.adriel.voyager.** { *; }
-dontwarn cafe.adriel.voyager.**

# Keep Android Security
-keep class androidx.security.crypto.** { *; }

# Keep ZXing
-keep class com.google.zxing.** { *; }
-dontwarn com.google.zxing.**

# ML Kit Barcode Scanning
-keep class com.google.mlkit.vision.** { *; }
-dontwarn com.google.mlkit.vision.**

# CameraX
-keep class androidx.camera.** { *; }

# Biometric
-keep class androidx.biometric.** { *; }

# Coroutines
-keepclassmembers class kotlinx.coroutines.** {
    volatile <fields>;
}
-dontwarn kotlinx.coroutines.**

# Keep @Composable functions
-keep @androidx.compose.runtime.Composable class * { *; }
-keepclassmembers class * {
    @androidx.compose.runtime.Composable *;
}

# Keep line numbers for crash reports
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# Keep custom exceptions
-keep public class * extends java.lang.Exception

# Keep enums
-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

# Remove logging in release builds
-assumenosideeffects class android.util.Log {
    public static *** d(...);
    public static *** v(...);
    public static *** i(...);
}

# Optimize
-optimizations !code/simplification/arithmetic,!code/simplification/cast,!field/*,!class/merging/*
-optimizationpasses 5
-allowaccessmodification
