buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:9.5.0")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.21")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

// The Tauri crates' Android modules (and our two plugins) set their own compileSdk,
// today 36, and take AGP's default Build-Tools. finalizeDsl runs after their build
// scripts, so every library uses the app's platform and Build-Tools, and the SDK
// needs one of each, not one per crate.
// Spec: docs/internal/android-setup.md (toolchain versions)
subprojects {
    pluginManager.withPlugin("com.android.library") {
        extensions.configure<com.android.build.api.variant.LibraryAndroidComponentsExtension> {
            finalizeDsl {
                it.compileSdk = 37
                it.compileSdkMinor = 1
                it.buildToolsVersion = "37.0.0"
            }
        }
    }
}

tasks.register("clean").configure {
    delete("build")
}

