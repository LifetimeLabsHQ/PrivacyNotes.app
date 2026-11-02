import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Direct-APK builds (VITE_ANDROID_DIST=direct) sign with the dedicated direct-channel
// keystore; Play builds (flag unset) sign with the Play upload keystore. One env var
// drives BOTH the JS build flavor and the signing key, so they can never mismatch.
// The direct channel has no Play App Signing safety net: its key must stay the same
// forever or sideloaded users cannot update in place.
// Spec: docs/internal/android-setup.md (dual keystore: Play upload vs direct channel)
val isDirectBuild = System.getenv("VITE_ANDROID_DIST") == "direct"
val keystoreProperties = Properties().apply {
    val propFile = rootProject.file(if (isDirectBuild) "keystore.direct.properties" else "keystore.properties")
    if (isDirectBuild && !propFile.exists()) {
        throw GradleException("keystore.direct.properties missing - refusing to sign a direct-channel APK with the Play upload key")
    }
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    // Android 17 is API 37.1: a minor SDK level, platform folder android-37.1.
    // targetSdk stays 36 until Android 17's behavior changes are tested on a phone.
    // Spec: docs/internal/android-setup.md (toolchain versions)
    compileSdk = 37
    compileSdkMinor = 1
    // AGP 9.5 defaults to Build-Tools 36.0.0 and downloads it when it is missing.
    buildToolsVersion = "37.0.0"
    namespace = "app.privacynotes"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "app.privacynotes"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        create("release") {
            keyAlias = keystoreProperties["keyAlias"] as String?
            keyPassword = keystoreProperties["password"] as String?
            storeFile = keystoreProperties["storeFile"]?.let { file(it) }
            storePassword = keystoreProperties["password"] as String?
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    // AGP 9 compiles Java for 11 by default; Kotlin below targets 1.8, and the two must match.
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

// The compilerOptions form, which Kotlin 2 requires.
kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_1_8)
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")