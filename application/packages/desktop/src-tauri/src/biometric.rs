//! Native biometric gate for the platforms whose OS actually exposes one:
//! Touch ID / Face ID via LocalAuthentication on macOS + iOS, Windows Hello via
//! UserConsentVerifier on Windows, BiometricPrompt via androidx.biometric on
//! Android.
//!
//! Why this exists at all: the app renders in an embedded webview (WKWebView,
//! WebView2), and those expose no WebAuthn platform authenticator, so
//! `isUserVerifyingPlatformAuthenticatorAvailable()` resolves to false and the
//! web biometric path is dead in every native build. Security > Biometric Lock
//! claimed "not available on this device" on hardware that very much has it.
//! Spec: docs/contrib/biometric-unlock.md (section 3.2 native path), backlog #101.
//!
//! Two levels. Where the device can bind, the wrap key comes from a key held in
//! its secure hardware (the bound key, below). Where it cannot, biometrics are a
//! *presence gate*, not a key source: the phrase stays wrapped with a random
//! AES-GCM key held in the webview's localStorage (packages/web/src/biometric.ts),
//! and `authenticate` only decides whether that unwrap may proceed.
//!
//! build.rs sets the `native_biometric` cfg for exactly the targets below, so
//! lib.rs never repeats the target list and Linux keeps reporting "unavailable"
//! through the same commands. Each backend implements the same two functions,
//! and owns its own threading etiquette because the platforms want opposite
//! things (LAContext needs the main thread, Hello must not block it):
//!
//!   available(&AppHandle) -> bool                                     cheap, no UI
//!   authenticate(&AppHandle, String, String) -> Result<bool, String>  blocking
//!
//! Both strings are translated by the caller, because the OS renders them: the
//! reason for the prompt, then the label for its cancel button. Only Android
//! draws that button itself and so is the only backend that reads the second
//! string; macOS, iOS and Windows get one from the system, in the system's own
//! language.
//!
//! `authenticate` is always called from a blocking task, never the main thread.
//! `Ok(false)` is every flavour of "no" a user or the OS can produce (cancelled,
//! wrong finger, fell back, system interrupt); the caller only has to keep the
//! app locked. `Err` means no prompt could be shown at all.

#[cfg(target_os = "android")]
pub use android::{authenticate, available, device_create, device_open, key_create, key_delete, key_open};
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub use apple::{authenticate, available};
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub use apple_key::{device_create, device_open, key_create, key_delete, key_open};
#[cfg(target_os = "windows")]
pub use windows_hello::{
    authenticate, available, device_create, device_open, key_create, key_delete, key_open, tpm_missing,
};

// The device key: a key the OS keeps out of the app's own storage, opened
// with no prompt, that wraps the stored phrase while the app lock is off.
// Each backend implements:
//
//   device_create(&AppHandle) -> Result<(handle, secret), KeyFailure>
//   device_open(&AppHandle, handle) -> Result<secret, KeyFailure>
//
// The same handle and secret shape as the bound key below: the web side
// stores the handle in the envelope and derives the wrap key from the
// secret. `create` answers Unsupported where the device has no such store,
// and the web side keeps its own key.
// Spec: docs/internal/plans/device-bound-phrase-key.md (section 3)

// ---------------------------------------------------------------------------
// The bound key. The presence gate above only decides whether
// the web side may read a wrap key it stores itself; these three functions
// keep the key in the device's secure hardware instead, so a copy of the app's
// storage holds only ciphertext. Each backend implements:
//
//   key_create(&AppHandle, reason, cancel) -> Result<(handle, secret), KeyFailure>
//   key_open(&AppHandle, handle, reason, cancel) -> Result<secret, KeyFailure>
//   key_delete(&AppHandle, handle)
//
// `create` makes a fresh hardware key, seals a secret to it and opens it once
// behind the biometric prompt (the person's consent and the proof that the key
// opens). `handle` is opaque to the web side and is all it stores; the secret
// never touches storage: the web side derives the wrap key from it and drops
// it. `create` answers Unsupported before any prompt where the device cannot
// bind, and the web side then enrolls nothing (#842). `open` answers Gone only
// when the OS has destroyed the key for good, which the lock screen turns into
// "set up again" while the PIN and the phrase stay.
// Spec: docs/internal/plans/biometric-key-binding.md (section 8.2)
// ---------------------------------------------------------------------------

/// Why a key operation gave no secret. The string is what the web side reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyFailure {
    /// This device cannot hold a bound key; said before any prompt.
    Unsupported,
    /// The person or the system cancelled the prompt, or biometrics are locked out.
    Cancelled,
    /// The OS destroyed the key (the device passcode removed, the key invalidated).
    Gone,
    /// No biometric is enrolled now: the key cannot open, but may again once
    /// one is. Windows Hello has no such state: its PIN always opens the key.
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    Unenrolled,
    /// Anything else.
    Failed,
}

impl KeyFailure {
    pub fn code(self) -> &'static str {
        match self {
            KeyFailure::Unsupported => "unsupported",
            KeyFailure::Cancelled => "cancelled",
            KeyFailure::Gone => "gone",
            KeyFailure::Unenrolled => "unenrolled",
            KeyFailure::Failed => "failed",
        }
    }
}

/// Lower-case hex, the form every secret crosses to the web side in.
pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "windows"))]
fn from_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

/// macOS + iOS: `LAContext`, bound with raw `msg_send!` rather than the
/// `objc2-local-authentication` bindings so that no new package enters
/// Cargo.lock - objc2, block2 and objc2-foundation are already in the tree via
/// tao/wry on Apple targets.
#[cfg(any(target_os = "macos", target_os = "ios"))]
mod apple {
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2_foundation::{NSError, NSString};
    use std::sync::mpsc::Sender;
    use std::time::Duration;

    /// `LAPolicyDeviceOwnerAuthenticationWithBiometrics` - biometrics only, no
    /// device-passcode fallback. The app's own PIN / recovery-phrase fallback
    /// covers the "biometrics won't play" case, so offering the OS passcode here
    /// would only weaken the gate (any passerby who knows it could pass).
    /// Deliberately not `...WithBiometricsOrCompanion` (Apple Watch):
    /// availability would flap with whether a watch happens to be nearby.
    const LA_POLICY_BIOMETRICS: isize = 1;

    /// `LocalAuthentication.framework` is linked in build.rs. Safe to call off the
    /// main thread; only `evaluate` needs main-thread scheduling.
    fn new_context() -> Option<Retained<AnyObject>> {
        let class = AnyClass::get(c"LAContext")?;
        Some(unsafe { msg_send![class, new] })
    }

    /// Usable biometrics right now? False on hardware without a sensor, with
    /// nothing enrolled, when the user denied the app Face ID access, or while
    /// biometry is locked out after too many failed attempts (the OS then wants a
    /// passcode unlock first).
    pub fn available(_app: &tauri::AppHandle) -> bool {
        let Some(context) = new_context() else {
            return false;
        };
        let can: Result<(), Retained<NSError>> =
            unsafe { msg_send![&*context, canEvaluatePolicy: LA_POLICY_BIOMETRICS, error: _] };
        can.is_ok()
    }

    /// The cancel label is unused here: LocalAuthentication draws the button and
    /// localizes it itself.
    pub fn authenticate(
        app: &tauri::AppHandle,
        reason: String,
        _cancel_label: String,
    ) -> Result<bool, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || evaluate(&reason, tx))
            .map_err(|e| e.to_string())?;
        // Belt and braces: LocalAuthentication owns the prompt's lifetime, so a
        // reply that never arrives would otherwise park this thread forever.
        rx.recv_timeout(Duration::from_secs(180))
            .map_err(|_| "The biometric prompt closed unexpectedly.".to_owned())?
    }

    /// Presents the system biometric sheet and reports the outcome through `tx`.
    /// MUST run on the main thread: the sheet attaches to the app's key window.
    /// Returns as soon as the prompt is up; the reply block fires later, on an
    /// arbitrary queue.
    fn evaluate(reason: &str, tx: Sender<Result<bool, String>>) {
        let Some(context) = new_context() else {
            let _ = tx.send(Err("LocalAuthentication is unavailable.".to_owned()));
            return;
        };
        let reason = NSString::from_str(reason);

        // Take the pointer before the block swallows `context`: LAContext cancels a
        // pending evaluation when it is released, so the block has to own the only
        // strong reference and outlive the prompt. LocalAuthentication copies the
        // block and releases it after the reply, which frees the context with it.
        let context_ptr: *const AnyObject = &*context;
        let reply = RcBlock::new(move |success: Bool, _error: *mut NSError| {
            let _keep_context_alive = &context;
            let _ = tx.send(Ok(success.as_bool()));
        });

        unsafe {
            let _: () = msg_send![
                context_ptr,
                evaluatePolicy: LA_POLICY_BIOMETRICS,
                localizedReason: &*reason,
                reply: &*reply,
            ];
        }
    }
}

/// macOS + iOS: the bound key. A Secure Enclave P-256 key whose private half
/// is usable only after a biometric check by the fingers or faces enrolled
/// when it was made (`.biometryCurrentSet`: adding or removing one, or a Face
/// ID reset, makes it unusable for good), in the `WhenPasscodeSetThisDeviceOnly`
/// class, so removing the device passcode destroys it. The enclave gives no
/// documented error for a changed set, so the handle also carries the set's
/// hash (`evaluatedPolicyDomainState`, per app, no secret): when it differs,
/// a failed open answers Gone instead of a failure the lock screen retries.
/// The hash is only a hint; the enclave's rule is what refuses a new finger,
/// and a key that still opens under a changed hash opens. The key is never put in the keychain: the notarized macOS build
/// carries no keychain entitlement, and a permanent enclave key fails there
/// with -34018. The enclave hands back its own sealed copy of the key (the
/// `toid` attribute, the same bytes CryptoKit calls `dataRepresentation`),
/// which only this device's enclave can use and only under the biometric rule,
/// and the handle carries that copy with the ECIES-GCM ciphertext of a random
/// 32-byte secret. The iOS Simulator refuses a biometric enclave key (LAError
/// -1020), so it answers Unsupported there, and the web side enrolls nothing
/// (#842).
/// Raw `msg_send!` and Security calls, for the reason the presence gate gives:
/// no new package.
#[cfg(any(target_os = "macos", target_os = "ios"))]
mod apple_key {
    use super::{from_hex, to_hex, KeyFailure};
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2_foundation::{NSError, NSString};
    use std::ffi::c_void;

    type CFTypeRef = *const c_void;
    type CFErrorRef = *mut c_void;

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        static kSecAttrKeyType: CFTypeRef;
        static kSecAttrKeyTypeECSECPrimeRandom: CFTypeRef;
        static kSecAttrKeySizeInBits: CFTypeRef;
        static kSecAttrTokenID: CFTypeRef;
        static kSecAttrTokenIDSecureEnclave: CFTypeRef;
        static kSecPrivateKeyAttrs: CFTypeRef;
        static kSecAttrIsPermanent: CFTypeRef;
        static kSecAttrAccessControl: CFTypeRef;
        static kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly: CFTypeRef;
        static kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly: CFTypeRef;
        static kSecUseAuthenticationContext: CFTypeRef;
        static kSecKeyAlgorithmECIESEncryptionCofactorVariableIVX963SHA256AESGCM: CFTypeRef;
        fn SecAccessControlCreateWithFlags(
            allocator: CFTypeRef,
            protection: CFTypeRef,
            flags: usize,
            error: *mut CFErrorRef,
        ) -> CFTypeRef;
        fn SecKeyCreateRandomKey(parameters: CFTypeRef, error: *mut CFErrorRef) -> CFTypeRef;
        fn SecKeyCopyPublicKey(key: CFTypeRef) -> CFTypeRef;
        fn SecKeyCopyAttributes(key: CFTypeRef) -> CFTypeRef;
        fn SecKeyCreateEncryptedData(
            key: CFTypeRef,
            algorithm: CFTypeRef,
            plaintext: CFTypeRef,
            error: *mut CFErrorRef,
        ) -> CFTypeRef;
        fn SecKeyCreateDecryptedData(
            key: CFTypeRef,
            algorithm: CFTypeRef,
            ciphertext: CFTypeRef,
            error: *mut CFErrorRef,
        ) -> CFTypeRef;
        fn SecRandomCopyBytes(rnd: CFTypeRef, count: usize, bytes: *mut u8) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: CFTypeRef);
    }

    /// `kSecAccessControlPrivateKeyUsage`.
    const PRIVATE_KEY_USAGE: usize = 1 << 30;
    /// `kSecAccessControlBiometryCurrentSet | kSecAccessControlPrivateKeyUsage`.
    /// Spec: docs/internal/plans/biometric-new-finger.md (section 2.1)
    const ACCESS_FLAGS: usize = (1 << 3) | PRIVATE_KEY_USAGE;
    const LA_POLICY_BIOMETRICS: isize = 1;
    const SECRET_BYTES: usize = 32;
    /// The handle's version prefix: `se2.<sealed>.<ciphertext>.<set hash>`.
    /// A handle with neither prefix opens nothing.
    const HANDLE_PREFIX: &str = "se2.";
    /// A key made under `.biometryAny`, before the current-set rule. It still
    /// opens, and the web side replaces it at its next unlock.
    const ANY_SET_HANDLE_PREFIX: &str = "se1.";
    /// The device key's handle prefix (`device_create`), so neither kind of
    /// handle opens through the other kind's call.
    const DEVICE_HANDLE_PREFIX: &str = "sd1.";

    // LAError codes (LAError.h).
    const LA_AUTHENTICATION_FAILED: isize = -1;
    const LA_USER_CANCEL: isize = -2;
    const LA_USER_FALLBACK: isize = -3;
    const LA_SYSTEM_CANCEL: isize = -4;
    const LA_PASSCODE_NOT_SET: isize = -5;
    const LA_BIOMETRY_NOT_ENROLLED: isize = -7;
    const LA_BIOMETRY_LOCKOUT: isize = -8;
    const LA_APP_CANCEL: isize = -9;
    const LA_NOT_INTERACTIVE: isize = -1004;
    /// errSecUserCanceled
    const SEC_USER_CANCELED: isize = -128;

    /// A +1 Core Foundation reference, released on drop.
    struct Owned(CFTypeRef);
    impl Owned {
        fn new(ptr: CFTypeRef) -> Option<Self> {
            // Lazily: an `Owned(null)` built and dropped would call
            // CFRelease(NULL), which aborts the process.
            (!ptr.is_null()).then(|| Self(ptr))
        }
        fn obj(&self) -> &AnyObject {
            // Every CF type used here is toll-free bridged to its NS twin.
            unsafe { &*(self.0 as *const AnyObject) }
        }
    }
    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe { CFRelease(self.0) }
        }
    }

    /// The domain and code of a CFError the call handed back (+1), released here.
    fn take_error(err: CFErrorRef) -> Option<(String, isize)> {
        let err = Owned::new(err as CFTypeRef)?;
        let ns: &NSError = unsafe { &*(err.0 as *const NSError) };
        Some((ns.domain().to_string(), ns.code()))
    }

    fn obj(ptr: CFTypeRef) -> &'static AnyObject {
        unsafe { &*(ptr as *const AnyObject) }
    }

    fn dictionary() -> Retained<AnyObject> {
        let class = AnyClass::get(c"NSMutableDictionary").expect("Foundation is linked");
        unsafe { msg_send![class, dictionary] }
    }

    fn set(dict: &AnyObject, key: CFTypeRef, value: &AnyObject) {
        let _: () = unsafe { msg_send![dict, setObject: value, forKey: obj(key)] };
    }

    fn data(bytes: &[u8]) -> Retained<AnyObject> {
        let class = AnyClass::get(c"NSData").expect("Foundation is linked");
        unsafe { msg_send![class, dataWithBytes: bytes.as_ptr() as *const c_void, length: bytes.len()] }
    }

    fn bytes_of(data: &AnyObject) -> Vec<u8> {
        let len: usize = unsafe { msg_send![data, length] };
        let ptr: *const u8 = unsafe { msg_send![data, bytes] };
        if len == 0 || ptr.is_null() {
            return Vec::new();
        }
        unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec()
    }

    fn number_int(value: i32) -> Retained<AnyObject> {
        let class = AnyClass::get(c"NSNumber").expect("Foundation is linked");
        unsafe { msg_send![class, numberWithInt: value] }
    }

    fn number_bool(value: bool) -> Retained<AnyObject> {
        let class = AnyClass::get(c"NSNumber").expect("Foundation is linked");
        unsafe { msg_send![class, numberWithBool: Bool::new(value)] }
    }

    fn random_secret() -> Option<[u8; SECRET_BYTES]> {
        let mut out = [0u8; SECRET_BYTES];
        let status = unsafe { SecRandomCopyBytes(std::ptr::null(), SECRET_BYTES, out.as_mut_ptr()) };
        (status == 0).then_some(out)
    }

    fn new_context() -> Option<Retained<AnyObject>> {
        let class = AnyClass::get(c"LAContext")?;
        Some(unsafe { msg_send![class, new] })
    }

    /// The LAError code that keeps this device from a biometric check right
    /// now, or None when one can run.
    fn biometric_blocker(context: &AnyObject) -> Option<isize> {
        let can: Result<(), Retained<NSError>> =
            unsafe { msg_send![context, canEvaluatePolicy: LA_POLICY_BIOMETRICS, error: _] };
        can.err().map(|e| e.code())
    }

    /// The hash of the biometric set enrolled now, filled by a
    /// `canEvaluatePolicy` that passed (`biometric_blocker`), so it needs no
    /// prompt. Empty where the OS gives none.
    fn enrolled_set(context: &AnyObject) -> Vec<u8> {
        let state: Option<Retained<AnyObject>> = unsafe { msg_send![context, evaluatedPolicyDomainState] };
        state.map(|d| bytes_of(&d)).unwrap_or_default()
    }

    /// A sealed `se2.` handle with the set hash it was made under appended.
    fn with_set(handle: String, set: &[u8]) -> String {
        format!("{handle}.{}", to_hex(set))
    }

    /// What the set hashes say about a key before its prompt.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum SetCheck {
        /// An `se1.` key: any biometric opens it, there is no set to compare.
        AnySet,
        Same,
        Changed,
        /// A side without a hash: nothing is known.
        Unknown,
    }

    fn set_check(at_create: Option<&[u8]>, now: &[u8]) -> SetCheck {
        match at_create {
            None => SetCheck::AnySet,
            Some(made) if made.is_empty() || now.is_empty() => SetCheck::Unknown,
            Some(made) if made == now => SetCheck::Same,
            Some(_) => SetCheck::Changed,
        }
    }

    /// A current-set key that did not open. `Cancelled` is every prompt answer
    /// that says nothing about the key (a cancel, missed touches, a lockout, see
    /// `classify`) and stays one, because the hash can change with no set change
    /// (LAContext.h: "exceptionally between major OS versions"). Any other
    /// failure under a changed set is the enclave refusing a dead key: Gone.
    /// With no hash to compare it reads as Unenrolled (the lock screen's line,
    /// the record kept), so it never becomes a prompt the lock screen repeats.
    fn after_set_check(failure: KeyFailure, check: SetCheck) -> KeyFailure {
        match (check, failure) {
            (SetCheck::Changed, KeyFailure::Failed) => KeyFailure::Gone,
            (SetCheck::Unknown, KeyFailure::Failed) => KeyFailure::Unenrolled,
            _ => failure,
        }
    }

    /// The common part of the key attributes: an enclave P-256 key, never stored.
    fn key_attributes() -> Retained<AnyObject> {
        let attrs = dictionary();
        unsafe {
            set(&attrs, kSecAttrKeyType, obj(kSecAttrKeyTypeECSECPrimeRandom));
            set(&attrs, kSecAttrKeySizeInBits, &number_int(256));
            set(&attrs, kSecAttrTokenID, obj(kSecAttrTokenIDSecureEnclave));
        }
        attrs
    }

    pub fn key_create(
        _app: &tauri::AppHandle,
        reason: String,
        _cancel_label: String,
    ) -> Result<(String, String), KeyFailure> {
        let context = new_context().ok_or(KeyFailure::Unsupported)?;
        if biometric_blocker(&context).is_some() {
            return Err(KeyFailure::Unsupported);
        }
        let set = enrolled_set(&context);
        let (handle, secret) = seal_new_secret(
            unsafe { kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly },
            ACCESS_FLAGS,
            HANDLE_PREFIX,
        )?;
        let handle = with_set(handle, &set);
        // The read-back: the prompt the person answers, and the proof that the
        // enclave opens what was sealed to it.
        match open_secret(&handle, &reason) {
            Ok(opened) if opened == secret => Ok((handle, to_hex(&secret))),
            Ok(_) => Err(KeyFailure::Failed),
            Err(KeyFailure::Cancelled) => Err(KeyFailure::Cancelled),
            Err(_) => Err(KeyFailure::Failed),
        }
    }

    /// A fresh enclave key and a random secret sealed to its public half, as
    /// a handle under `prefix`. No prompt: only the private half carries the
    /// rule in `flags`.
    fn seal_new_secret(
        protection: CFTypeRef,
        flags: usize,
        prefix: &str,
    ) -> Result<(String, [u8; SECRET_BYTES]), KeyFailure> {
        let access = Owned::new(unsafe {
            SecAccessControlCreateWithFlags(std::ptr::null(), protection, flags, std::ptr::null_mut())
        })
        .ok_or(KeyFailure::Unsupported)?;

        let private = dictionary();
        unsafe {
            set(&private, kSecAttrIsPermanent, &number_bool(false));
            set(&private, kSecAttrAccessControl, access.obj());
        }
        let attrs = key_attributes();
        unsafe { set(&attrs, kSecPrivateKeyAttrs, &private) };
        let mut err: CFErrorRef = std::ptr::null_mut();
        let key = Owned::new(unsafe {
            SecKeyCreateRandomKey(&*attrs as *const AnyObject as CFTypeRef, &mut err)
        });
        let Some(key) = key else {
            take_error(err);
            return Err(KeyFailure::Unsupported);
        };

        let sealed = {
            let attributes =
                Owned::new(unsafe { SecKeyCopyAttributes(key.0) }).ok_or(KeyFailure::Unsupported)?;
            let toid: Option<Retained<AnyObject>> =
                unsafe { msg_send![attributes.obj(), objectForKey: &*NSString::from_str("toid")] };
            let toid = toid.map(|d| bytes_of(&d)).unwrap_or_default();
            if toid.is_empty() {
                return Err(KeyFailure::Unsupported);
            }
            toid
        };

        let secret = random_secret().ok_or(KeyFailure::Unsupported)?;
        let public = Owned::new(unsafe { SecKeyCopyPublicKey(key.0) }).ok_or(KeyFailure::Unsupported)?;
        let plaintext = data(&secret);
        let mut err: CFErrorRef = std::ptr::null_mut();
        let ciphertext = Owned::new(unsafe {
            SecKeyCreateEncryptedData(
                public.0,
                kSecKeyAlgorithmECIESEncryptionCofactorVariableIVX963SHA256AESGCM,
                &*plaintext as *const AnyObject as CFTypeRef,
                &mut err,
            )
        });
        let Some(ciphertext) = ciphertext else {
            take_error(err);
            return Err(KeyFailure::Unsupported);
        };
        let handle = format!("{prefix}{}.{}", to_hex(&sealed), to_hex(&bytes_of(ciphertext.obj())));
        Ok((handle, secret))
    }

    // The device key: the same enclave key without the biometric rule, in
    // the `AfterFirstUnlockThisDeviceOnly` class, so it opens with no prompt
    // from the first unlock after a restart on (a locked screen or a later
    // background start does not stop it) and never leaves this device's
    // enclave. Its open carries a context that may not interact, so it can
    // never show a prompt, whatever handle it is given.
    // It wraps the stored phrase while the app lock is off, so a copy of the
    // app's storage, or a backup restored on another device, holds only
    // ciphertext. A Mac without a Secure Enclave answers Unsupported, and
    // the web side keeps its own key.
    // Spec: docs/internal/plans/device-bound-phrase-key.md (section 3)

    pub fn device_create(_app: &tauri::AppHandle) -> Result<(String, String), KeyFailure> {
        create_device_key()
    }

    pub fn device_open(_app: &tauri::AppHandle, handle: String) -> Result<String, KeyFailure> {
        device_open_secret(&handle).map(|secret| to_hex(&secret))
    }

    fn create_device_key() -> Result<(String, String), KeyFailure> {
        let (handle, secret) = seal_new_secret(
            unsafe { kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly },
            PRIVATE_KEY_USAGE,
            DEVICE_HANDLE_PREFIX,
        )?;
        // The read-back: a key that cannot open what it sealed is no key.
        match device_open_secret(&handle) {
            Ok(opened) if opened == secret => Ok((handle, to_hex(&secret))),
            _ => Err(KeyFailure::Unsupported),
        }
    }

    /// Every failure is `Failed`: the device path has no prompt to cancel and
    /// no door to lose. A biometric key relabelled `sd1.` meets the context
    /// that may not interact and opens nothing.
    fn device_open_secret(handle: &str) -> Result<Vec<u8>, KeyFailure> {
        let (sealed, ciphertext) = parse_handle_with(handle, DEVICE_HANDLE_PREFIX).ok_or(KeyFailure::Failed)?;
        let context = new_context().ok_or(KeyFailure::Failed)?;
        let _: () = unsafe { msg_send![&*context, setInteractionNotAllowed: Bool::YES] };
        decrypt_with_sealed_key(&sealed, &ciphertext, Some(&*context)).map_err(|_| KeyFailure::Failed)
    }

    pub fn key_open(
        _app: &tauri::AppHandle,
        handle: String,
        reason: String,
        _cancel_label: String,
    ) -> Result<String, KeyFailure> {
        open_secret(&handle, &reason).map(|secret| to_hex(&secret))
    }

    /// Nothing to delete: the key lives only in the handle the web side drops.
    pub fn key_delete(_app: &tauri::AppHandle, _handle: String) {}

    /// A bound handle: the sealed key, the ciphertext, and the set hash of a
    /// current-set key (None for an `se1.` key, which has no set to compare).
    #[allow(clippy::type_complexity)]
    fn parse_handle(handle: &str) -> Option<(Vec<u8>, Vec<u8>, Option<Vec<u8>>)> {
        if let Some(rest) = handle.strip_prefix(HANDLE_PREFIX) {
            let (pair, set) = rest.rsplit_once('.')?;
            let (sealed, ciphertext) = parse_pair(pair)?;
            return Some((sealed, ciphertext, Some(from_hex(set)?)));
        }
        let (sealed, ciphertext) = parse_handle_with(handle, ANY_SET_HANDLE_PREFIX)?;
        Some((sealed, ciphertext, None))
    }

    fn parse_handle_with(handle: &str, prefix: &str) -> Option<(Vec<u8>, Vec<u8>)> {
        parse_pair(handle.strip_prefix(prefix)?)
    }

    fn parse_pair(pair: &str) -> Option<(Vec<u8>, Vec<u8>)> {
        let (sealed, ciphertext) = pair.split_once('.')?;
        let sealed = from_hex(sealed)?;
        let ciphertext = from_hex(ciphertext)?;
        (!sealed.is_empty() && !ciphertext.is_empty()).then_some((sealed, ciphertext))
    }

    /// Rebuild the enclave key from its sealed copy and decrypt the secret.
    /// Blocks while the biometric prompt is up, so never on the main thread.
    fn open_secret(handle: &str, reason: &str) -> Result<Vec<u8>, KeyFailure> {
        let (sealed, ciphertext, made_for) = parse_handle(handle).ok_or(KeyFailure::Failed)?;
        let context = new_context().ok_or(KeyFailure::Failed)?;
        // No passcode: its removal destroyed the key's protection class. No
        // finger or face enrolled: the key cannot open now; an `se1.` key
        // opens again once one is, a current-set key answers Gone below then.
        // Lockout is a wait, not a loss.
        match biometric_blocker(&context) {
            None => {}
            Some(LA_PASSCODE_NOT_SET) => return Err(KeyFailure::Gone),
            Some(LA_BIOMETRY_NOT_ENROLLED) => return Err(KeyFailure::Unenrolled),
            Some(LA_BIOMETRY_LOCKOUT) => return Err(KeyFailure::Cancelled),
            Some(_) => return Err(KeyFailure::Failed),
        }
        let check = set_check(made_for.as_deref(), &enrolled_set(&context));
        unsafe {
            let _: () = msg_send![&*context, setLocalizedReason: &*NSString::from_str(reason)];
            // An empty title hides the "Enter Password" button: the app's own
            // PIN and phrase are the fallback, and the rule refuses a password.
            let _: () = msg_send![&*context, setLocalizedFallbackTitle: &*NSString::from_str("")];
        }
        decrypt_with_sealed_key(&sealed, &ciphertext, Some(&*context)).map_err(|failure| after_set_check(failure, check))
    }

    /// Rebuild an enclave key from its sealed copy and decrypt `ciphertext`
    /// with it. `context` carries the biometric prompt for a bound key; the
    /// device key has no rule and takes none.
    fn decrypt_with_sealed_key(
        sealed: &[u8],
        ciphertext: &[u8],
        context: Option<&AnyObject>,
    ) -> Result<Vec<u8>, KeyFailure> {
        let attrs = key_attributes();
        let private = dictionary();
        unsafe {
            set(&private, kSecAttrIsPermanent, &number_bool(false));
            set(&attrs, kSecPrivateKeyAttrs, &private);
            if let Some(context) = context {
                set(&attrs, kSecUseAuthenticationContext, context);
            }
            let _: () = msg_send![&*attrs, setObject: &*data(sealed), forKey: &*NSString::from_str("toid")];
        }
        let mut err: CFErrorRef = std::ptr::null_mut();
        let key = Owned::new(unsafe {
            SecKeyCreateRandomKey(&*attrs as *const AnyObject as CFTypeRef, &mut err)
        });
        let Some(key) = key else {
            // The enclave would not take its sealed copy back. That alone does
            // not prove the key is destroyed, and `gone` removes a door, so
            // only the checks above (no biometric enrolled, no passcode) say
            // `gone`; this says `failed`, and the record stays.
            take_error(err);
            return Err(KeyFailure::Failed);
        };

        let input = data(ciphertext);
        let mut err: CFErrorRef = std::ptr::null_mut();
        let plaintext = Owned::new(unsafe {
            SecKeyCreateDecryptedData(
                key.0,
                kSecKeyAlgorithmECIESEncryptionCofactorVariableIVX963SHA256AESGCM,
                &*input as *const AnyObject as CFTypeRef,
                &mut err,
            )
        });
        match plaintext {
            Some(plaintext) => {
                let secret = bytes_of(plaintext.obj());
                if secret.len() == SECRET_BYTES {
                    Ok(secret)
                } else {
                    Err(KeyFailure::Failed)
                }
            }
            None => Err(classify(take_error(err))),
        }
    }

    fn classify(error: Option<(String, isize)>) -> KeyFailure {
        match error {
            Some((domain, code)) if domain == "com.apple.LocalAuthentication" => match code {
                LA_PASSCODE_NOT_SET => KeyFailure::Gone,
                LA_BIOMETRY_NOT_ENROLLED => KeyFailure::Unenrolled,
                LA_USER_CANCEL | LA_SYSTEM_CANCEL | LA_APP_CANCEL | LA_USER_FALLBACK
                | LA_AUTHENTICATION_FAILED | LA_BIOMETRY_LOCKOUT | LA_NOT_INTERACTIVE => {
                    KeyFailure::Cancelled
                }
                _ => KeyFailure::Failed,
            },
            Some((_, SEC_USER_CANCELED)) => KeyFailure::Cancelled,
            _ => KeyFailure::Failed,
        }
    }

    // Runs on a Mac with a Secure Enclave; nothing here shows a prompt.
    #[cfg(all(test, target_os = "macos"))]
    mod tests {
        use super::*;

        #[test]
        #[ignore = "needs a Secure Enclave; CI's macOS runners are VMs without one"]
        fn a_sealed_secret_round_trips_through_its_handle() {
            let bound = || unsafe {
                seal_new_secret(kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, ACCESS_FLAGS, HANDLE_PREFIX)
            };
            let (handle, secret) = bound().expect("this Mac has a Secure Enclave");
            let (sealed, ciphertext, _) = parse_handle(&with_set(handle.clone(), &[])).expect("the handle parses");
            assert!(sealed.len() > 100, "the enclave's sealed key is in the handle");
            assert!(ciphertext.len() > SECRET_BYTES);
            assert!(!handle.contains(&to_hex(&secret)), "the secret is not in the handle");
            let (_, other) = bound().unwrap();
            assert_ne!(secret, other, "every key seals a fresh secret");
        }

        #[test]
        #[ignore = "needs a Secure Enclave; CI's macOS runners are VMs without one"]
        fn the_device_key_opens_with_no_prompt() {
            let open = |h: &str| device_open_secret(h).map(|s| to_hex(&s));
            let (handle, secret) = create_device_key().expect("this Mac has a Secure Enclave");
            assert!(handle.starts_with(DEVICE_HANDLE_PREFIX));
            assert!(!handle.contains(&secret), "the secret is not in the handle");
            assert_eq!(open(&handle), Ok(secret.clone()));
            // A flipped byte of the sealed key or the ciphertext opens nothing.
            let mut flipped = handle.into_bytes();
            let last = flipped.len() - 1;
            flipped[last] = if flipped[last] == b'0' { b'1' } else { b'0' };
            assert!(open(&String::from_utf8(flipped).unwrap()).is_err());
            let (_, other) = create_device_key().unwrap();
            assert_ne!(secret, other, "every key seals a fresh secret");
        }

        #[test]
        #[ignore = "needs a Secure Enclave; CI's macOS runners are VMs without one"]
        fn a_relabelled_biometric_key_opens_nothing_and_never_prompts() {
            let (handle, _) = unsafe {
                seal_new_secret(kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, ACCESS_FLAGS, HANDLE_PREFIX)
            }
            .expect("this Mac has a Secure Enclave");
            let relabelled = handle.replacen(HANDLE_PREFIX, DEVICE_HANDLE_PREFIX, 1);
            // A prompt here would hang the test; the context forbids one.
            assert_eq!(device_open_secret(&relabelled), Err(KeyFailure::Failed));
        }

        #[test]
        fn the_two_kinds_of_handle_never_cross() {
            assert!(parse_handle("sd1.00.00").is_none());
            assert!(parse_handle_with("se1.00.00", DEVICE_HANDLE_PREFIX).is_none());
            assert_eq!(device_open_secret("se1.00.00"), Err(KeyFailure::Failed));
        }

        #[test]
        fn a_null_reference_is_never_released() {
            // Every failed Security call hands back NULL; releasing it aborts.
            assert!(Owned::new(std::ptr::null()).is_none());
            assert!(take_error(std::ptr::null_mut()).is_none());
        }

        #[test]
        fn a_malformed_handle_opens_nothing() {
            for bad in [
                "", "se1.", "se1.zz.00", "se1.00", "se1..00", "se1.0.00", "se1.00.00.00", "se3.00.00.00",
                "se2.", "se2.00.00", "se2.00.00.0", "se2.00.00.zz", "se2..00.00", "se2.00..00", "se2.00.00.00.00",
            ] {
                assert!(parse_handle(bad).is_none(), "{bad:?} parsed");
            }
            assert_eq!(open_secret("se1.zz.00", "reason"), Err(KeyFailure::Failed));
            assert_eq!(open_secret("se2.00.00.zz", "reason"), Err(KeyFailure::Failed));
        }

        #[test]
        fn a_current_set_handle_carries_its_set_and_an_older_one_has_none() {
            assert_eq!(parse_handle("se2.0a.0b.0c"), Some((vec![0x0a], vec![0x0b], Some(vec![0x0c]))));
            assert_eq!(parse_handle("se2.0a.0b."), Some((vec![0x0a], vec![0x0b], Some(vec![]))));
            assert_eq!(parse_handle("se1.0a.0b"), Some((vec![0x0a], vec![0x0b], None)));
            let made = with_set("se2.0a.0b".to_owned(), &[0xce, 0x84]);
            assert_eq!(parse_handle(&made), Some((vec![0x0a], vec![0x0b], Some(vec![0xce, 0x84]))));
        }

        #[test]
        fn new_keys_take_only_the_biometric_set_enrolled_now() {
            // kSecAccessControlBiometryAny and kSecAccessControlBiometryCurrentSet
            // (SecAccessControl.h), written out here so a change of
            // ACCESS_FLAGS cannot carry its test along.
            const BIOMETRY_ANY: usize = 1 << 1;
            const BIOMETRY_CURRENT_SET: usize = 1 << 3;
            assert_eq!(ACCESS_FLAGS & BIOMETRY_CURRENT_SET, BIOMETRY_CURRENT_SET);
            assert_eq!(ACCESS_FLAGS & BIOMETRY_ANY, 0);
            assert_eq!(ACCESS_FLAGS & PRIVATE_KEY_USAGE, PRIVATE_KEY_USAGE);
        }

        #[test]
        fn only_a_different_set_on_both_sides_reads_as_changed() {
            assert_eq!(set_check(Some(&[1, 2]), &[1, 3]), SetCheck::Changed);
            assert_eq!(set_check(Some(&[1, 2]), &[1, 2]), SetCheck::Same);
            assert_eq!(set_check(None, &[1, 2]), SetCheck::AnySet);
            assert_eq!(set_check(Some(&[]), &[1, 2]), SetCheck::Unknown);
            assert_eq!(set_check(Some(&[1, 2]), &[]), SetCheck::Unknown);
        }

        #[test]
        fn a_dead_current_set_key_never_reads_as_a_failure_to_retry() {
            use KeyFailure::*;
            let la = |code| Some(("com.apple.LocalAuthentication".to_owned(), code));
            let open = |error, check| after_set_check(classify(error), check);
            // A changed set: the enclave's refusal is the dead key.
            assert_eq!(open(Some(("CryptoTokenKit".to_owned(), -9)), SetCheck::Changed), Gone);
            assert_eq!(open(None, SetCheck::Changed), Gone);
            // A prompt answer that says nothing about the key stays a cancel,
            // also under a changed hash: the hash can drift with no set change.
            for code in [LA_USER_CANCEL, LA_SYSTEM_CANCEL, LA_APP_CANCEL, LA_USER_FALLBACK,
                LA_AUTHENTICATION_FAILED, LA_BIOMETRY_LOCKOUT, LA_NOT_INTERACTIVE]
            {
                assert_eq!(open(la(code), SetCheck::Changed), Cancelled, "LAError {code}");
            }
            // No hash to compare: the line, and the record stays.
            assert_eq!(open(None, SetCheck::Unknown), Unenrolled);
            assert_eq!(open(la(LA_USER_CANCEL), SetCheck::Unknown), Cancelled);
            // The same set, and an older key: as before.
            assert_eq!(open(None, SetCheck::Same), Failed);
            assert_eq!(open(None, SetCheck::AnySet), Failed);
            assert_eq!(open(la(LA_BIOMETRY_NOT_ENROLLED), SetCheck::Changed), Unenrolled);
            assert_eq!(open(la(LA_PASSCODE_NOT_SET), SetCheck::Same), Gone);
        }

        #[test]
        #[ignore = "needs Touch ID enrolled on this Mac"]
        fn the_enrolled_set_is_read_with_no_prompt_and_is_stable() {
            let read = || {
                let context = new_context().expect("LocalAuthentication is linked");
                assert_eq!(biometric_blocker(&context), None, "Touch ID is enrolled");
                enrolled_set(&context)
            };
            let first = read();
            assert!(!first.is_empty());
            assert_eq!(first, read());
        }

        #[test]
        fn only_a_destroyed_key_reads_as_gone() {
            let la = |code| Some(("com.apple.LocalAuthentication".to_owned(), code));
            assert_eq!(classify(la(LA_BIOMETRY_NOT_ENROLLED)), KeyFailure::Unenrolled);
            assert_eq!(classify(la(LA_PASSCODE_NOT_SET)), KeyFailure::Gone);
            assert_eq!(classify(la(LA_USER_CANCEL)), KeyFailure::Cancelled);
            assert_eq!(classify(la(LA_BIOMETRY_LOCKOUT)), KeyFailure::Cancelled);
            assert_eq!(classify(la(-6)), KeyFailure::Failed);
            assert_eq!(classify(Some(("NSOSStatusErrorDomain".to_owned(), -50))), KeyFailure::Failed);
            assert_eq!(classify(Some(("NSOSStatusErrorDomain".to_owned(), SEC_USER_CANCELED))), KeyFailure::Cancelled);
            assert_eq!(classify(None), KeyFailure::Failed);
        }
    }
}

/// Windows: `UserConsentVerifier` (Windows Hello). Both crates are already in the
/// tree via tauri/tao, so this adds features, not packages.
#[cfg(target_os = "windows")]
mod windows_hello {
    use tauri::Manager;
    use windows::core::{factory, HSTRING};
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::Win32::System::WinRT::IUserConsentVerifierInterop;
    use windows_future::IAsyncOperation;

    /// `Available` means Hello is set up with enrolled biometrics. Every other
    /// value (no sensor, not configured, disabled by policy, device busy) is a
    /// no, and correctly leaves the toggle hidden.
    pub fn available(_app: &tauri::AppHandle) -> bool {
        init_apartment();
        UserConsentVerifier::CheckAvailabilityAsync()
            .and_then(|op| op.join())
            .map(|availability| availability == UserConsentVerifierAvailability::Available)
            .unwrap_or(false)
    }

    /// The cancel label is unused here: Hello draws the button and localizes it
    /// itself.
    pub fn authenticate(
        app: &tauri::AppHandle,
        reason: String,
        _cancel_label: String,
    ) -> Result<bool, String> {
        let hwnd = app
            .get_webview_window("main")
            .ok_or_else(|| "No main window to attach the Windows Hello prompt to.".to_owned())?
            .hwnd()
            .map_err(|e| e.to_string())?;

        init_apartment();
        let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>()
            .map_err(|e| e.to_string())?;

        // A Win32 process MUST go through the interop: the plain
        // UserConsentVerifier::RequestVerificationAsync expects a CoreWindow and
        // fails outside a UWP app. The HWND is what parents the dialog, which is
        // also why this does not have to run on the UI thread - and must not,
        // since awaiting the operation blocks the calling thread.
        let operation: IAsyncOperation<UserConsentVerificationResult> =
            unsafe { interop.RequestVerificationForWindowAsync(hwnd, &HSTRING::from(reason)) }
                .map_err(|e| e.to_string())?;

        let result = operation.join().map_err(|e| e.to_string())?;
        Ok(result == UserConsentVerificationResult::Verified)
    }

    // The bound key: a Windows Hello key credential (KeyCredentialManager)
    // under a fresh name per enrollment. Hello gives a signing key, not a wrap
    // key, so the secret is the RSA PKCS#1 v1.5 signature (deterministic) over a
    // random 32-byte challenge the handle carries; the web side runs HKDF over
    // it. Hello accepts its own PIN as well as a biometric, as the presence gate
    // above does. Removing Windows Hello deletes every key credential, which
    // `OpenAsync` reports as NotFound: Gone. Enrollment shows two prompts
    // (create, then sign). The windows crate has no window-parented entry
    // point for these calls (the `ForWindow` versions are Windows 11 24H2
    // only), so the dialog is the system's own and can open behind other
    // windows (#768); `in_front` brings it forward while the app has the focus.
    // Spec: docs/internal/plans/biometric-key-binding.md (section 8.2)
    use super::{from_hex, to_hex, KeyFailure};
    use windows::Security::Credentials::{
        KeyCredential, KeyCredentialCreationOption, KeyCredentialManager, KeyCredentialStatus,
    };
    use windows::Security::Cryptography::CryptographicBuffer;
    use windows::Storage::Streams::IBuffer;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowW, GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    const NAME_PREFIX: &str = "PrivacyNotes-bio-";
    /// The random part of a name: 16 bytes as lower-case hex.
    const NAME_SUFFIX_CHARS: usize = 32;
    const HANDLE_PREFIX: &str = "wh1.";
    const CHALLENGE_BYTES: u32 = 32;
    const MIN_SIGNATURE_BYTES: usize = 32;

    fn random(count: u32) -> Result<Vec<u8>, KeyFailure> {
        let buffer = CryptographicBuffer::GenerateRandom(count).map_err(|_| KeyFailure::Unsupported)?;
        bytes_of(&buffer).ok_or(KeyFailure::Unsupported)
    }

    fn bytes_of(buffer: &IBuffer) -> Option<Vec<u8>> {
        let mut out = windows::core::Array::<u8>::new();
        CryptographicBuffer::CopyToByteArray(buffer, &mut out).ok()?;
        Some(out.to_vec())
    }

    fn status_failure(status: KeyCredentialStatus) -> KeyFailure {
        match status {
            KeyCredentialStatus::NotFound => KeyFailure::Gone,
            KeyCredentialStatus::UserCanceled | KeyCredentialStatus::SecurityDeviceLocked => {
                KeyFailure::Cancelled
            }
            _ => KeyFailure::Failed,
        }
    }

    fn sign(app: &tauri::AppHandle, credential: &KeyCredential, challenge: &[u8]) -> Result<Vec<u8>, KeyFailure> {
        let data = CryptographicBuffer::CreateFromByteArray(challenge).map_err(|_| KeyFailure::Failed)?;
        let result = in_front(app, || credential.RequestSignAsync(&data).and_then(|op| op.join()))
            .map_err(|_| KeyFailure::Failed)?;
        let status = result.Status().map_err(|_| KeyFailure::Failed)?;
        if status != KeyCredentialStatus::Success {
            return Err(status_failure(status));
        }
        let signature = result.Result().ok().and_then(|b| bytes_of(&b)).ok_or(KeyFailure::Failed)?;
        if signature.len() < MIN_SIGNATURE_BYTES {
            return Err(KeyFailure::Failed);
        }
        Ok(signature)
    }

    /// The class of the Windows Hello dialog's window, from Chromium's
    /// workaround for the same bug (`crypto/user_verifying_key_win.cc`).
    const HELLO_DIALOG_CLASS: PCWSTR = w!("Credential Dialog Xaml Host");
    const DIALOG_POLL: Duration = Duration::from_millis(100);

    /// Runs a key credential call while a second thread waits for its dialog
    /// and brings it to the front once, at a moment when a window of this app
    /// is the foreground window. Windows refuses the move while another app
    /// has the focus, so then the dialog comes forward when the user returns
    /// to the app. Windows also refuses it from a thread that does not own the
    /// focused window, so the move itself runs on the main (UI) thread. The
    /// waiting thread stops when the call returns.
    fn in_front<T>(app: &tauri::AppHandle, call: impl FnOnce() -> T) -> T {
        let done = Arc::new(AtomicBool::new(false));
        let watcher = {
            let done = Arc::clone(&done);
            let app = app.clone();
            std::thread::spawn(move || {
                let own = std::process::id();
                while !done.load(Ordering::Relaxed) {
                    if let Ok(dialog) = unsafe { FindWindowW(HELLO_DIALOG_CLASS, PCWSTR::null()) } {
                        let front = unsafe { GetForegroundWindow() };
                        if front == dialog {
                            return;
                        }
                        let mut owner = 0u32;
                        unsafe { GetWindowThreadProcessId(front, Some(&mut owner)) };
                        if owner == own {
                            // HWND is not Send; the raw value crosses the thread.
                            let raw = dialog.0 as isize;
                            let _ = app.run_on_main_thread(move || unsafe {
                                let _ = SetForegroundWindow(HWND(raw as *mut _));
                            });
                        }
                    }
                    std::thread::sleep(DIALOG_POLL);
                }
            })
        };
        let result = call();
        done.store(true, Ordering::Relaxed);
        let _ = watcher.join();
        result
    }

    /// Only a name this app made can be deleted.
    fn delete_name(name: &str) {
        if name.starts_with(NAME_PREFIX) {
            let _ = KeyCredentialManager::DeleteAsync(&HSTRING::from(name)).and_then(|op| op.join());
        }
    }

    /// `wh1.<name>.<hex challenge>`; a name this code did not make, or a
    /// short challenge, is no handle.
    fn parse_handle(handle: &str) -> Option<(String, Vec<u8>)> {
        let (name, challenge) = handle.strip_prefix(HANDLE_PREFIX)?.rsplit_once('.')?;
        let suffix = name.strip_prefix(NAME_PREFIX)?;
        if suffix.len() != NAME_SUFFIX_CHARS || !suffix.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return None;
        }
        let challenge = from_hex(challenge)?;
        (challenge.len() == CHALLENGE_BYTES as usize).then(|| (name.to_owned(), challenge))
    }

    pub fn key_create(
        app: &tauri::AppHandle,
        _reason: String,
        _cancel_label: String,
    ) -> Result<(String, String), KeyFailure> {
        init_apartment();
        let supported = KeyCredentialManager::IsSupportedAsync()
            .and_then(|op| op.join())
            .unwrap_or(false);
        if !supported {
            return Err(KeyFailure::Unsupported);
        }
        let name = format!("{NAME_PREFIX}{}", to_hex(&random(16)?));
        let challenge = random(CHALLENGE_BYTES)?;
        let created = in_front(app, || {
            KeyCredentialManager::RequestCreateAsync(
                &HSTRING::from(&name),
                KeyCredentialCreationOption::FailIfExists,
            )
            .and_then(|op| op.join())
        })
        .map_err(|_| KeyFailure::Failed)?;
        let status = created.Status().map_err(|_| KeyFailure::Failed)?;
        if status != KeyCredentialStatus::Success {
            return Err(match status {
                KeyCredentialStatus::UserCanceled | KeyCredentialStatus::SecurityDeviceLocked => {
                    KeyFailure::Cancelled
                }
                _ => KeyFailure::Failed,
            });
        }
        let credential = created.Credential().map_err(|_| KeyFailure::Failed)?;
        match sign(app, &credential, &challenge) {
            Ok(signature) => Ok((
                format!("{HANDLE_PREFIX}{name}.{}", to_hex(&challenge)),
                to_hex(&signature),
            )),
            Err(failure) => {
                delete_name(&name);
                Err(if failure == KeyFailure::Cancelled {
                    KeyFailure::Cancelled
                } else {
                    KeyFailure::Failed
                })
            }
        }
    }

    pub fn key_open(
        app: &tauri::AppHandle,
        handle: String,
        _reason: String,
        _cancel_label: String,
    ) -> Result<String, KeyFailure> {
        let (name, challenge) = parse_handle(&handle).ok_or(KeyFailure::Failed)?;
        init_apartment();
        let opened = KeyCredentialManager::OpenAsync(&HSTRING::from(&name))
            .and_then(|op| op.join())
            .map_err(|_| KeyFailure::Failed)?;
        let status = opened.Status().map_err(|_| KeyFailure::Failed)?;
        if status != KeyCredentialStatus::Success {
            return Err(status_failure(status));
        }
        let credential = opened.Credential().map_err(|_| KeyFailure::Failed)?;
        sign(app, &credential, &challenge).map(|signature| to_hex(&signature))
    }

    pub fn key_delete(_app: &tauri::AppHandle, handle: String) {
        if let Some((name, _)) = parse_handle(&handle) {
            init_apartment();
            delete_name(&name);
        }
    }

    // The device key. First the PC's TPM: one RSA-2048 key per Windows
    // account under a fixed name in the Microsoft Platform Crypto Provider,
    // whose private half never leaves the chip, seals a random 32-byte secret
    // with RSA-OAEP (SHA-256). A copy of the disk or of the profile opens
    // nothing on another PC, even with the Windows password. A PC without a
    // usable TPM gets DPAPI in user scope instead, which ties the secret to
    // the Windows account: a copy opens nothing on another machine or under
    // another account, unless it comes with that account's password. No
    // prompt either way (NCRYPT_SILENT_FLAG, CRYPTPROTECT_UI_FORBIDDEN). Code
    // that runs as this user can use both, as it can use the app itself. A
    // cleared TPM loses the key: the open answers `failed`, and the app asks
    // for the phrase once.
    // Spec: docs/internal/plans/device-bound-phrase-key.md (section 3)
    use windows::Win32::Foundation::{LocalFree, HLOCAL, NTE_BAD_KEYSET, TBS_E_TPM_NOT_FOUND};
    use windows::Win32::System::TpmBaseServices::{Tbsi_GetDeviceInfo, TPM_DEVICE_INFO};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, NCryptCreatePersistedKey, NCryptDecrypt, NCryptDeleteKey,
        NCryptEncrypt, NCryptFinalizeKey, NCryptFreeObject, NCryptOpenKey, NCryptOpenStorageProvider,
        NCryptSetProperty, BCRYPT_OAEP_PADDING_INFO, BCRYPT_RSA_ALGORITHM, BCRYPT_SHA256_ALGORITHM, CERT_KEY_SPEC,
        CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB, MS_PLATFORM_CRYPTO_PROVIDER, NCRYPT_FLAGS, NCRYPT_HANDLE,
        NCRYPT_KEY_HANDLE, NCRYPT_LENGTH_PROPERTY, NCRYPT_PAD_OAEP_FLAG, NCRYPT_PROV_HANDLE, NCRYPT_SILENT_FLAG,
    };

    const TPM_HANDLE_PREFIX: &str = "tp1.";
    /// One key per Windows account (NCrypt keys are per user without
    /// NCRYPT_MACHINE_KEY_FLAG); every handle seals its own secret with it.
    const TPM_KEY_NAME: PCWSTR = w!("PrivacyNotes-device-1");
    const TPM_KEY_BITS: u32 = 2048;
    const DEVICE_HANDLE_PREFIX: &str = "dp1.";
    const DEVICE_SECRET_BYTES: usize = 32;
    /// DPAPI's optional entropy: another program that unseals the blob must
    /// also pass it.
    const DEVICE_ENTROPY: &[u8] = b"privacynotes-device-wrap-v1";

    fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 }
    }

    /// Copies a blob DPAPI allocated, then frees it.
    fn take_blob(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        if out.pbData.is_null() {
            return Vec::new();
        }
        let bytes = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
        unsafe {
            let _ = LocalFree(Some(HLOCAL(out.pbData as *mut _)));
        }
        bytes
    }

    fn unprotect(sealed: &[u8]) -> Option<Vec<u8>> {
        let input = blob(sealed);
        let entropy = blob(DEVICE_ENTROPY);
        let mut out = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptUnprotectData(&input, None, Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        }
        .ok()?;
        Some(take_blob(out))
    }

    pub fn device_create(_app: &tauri::AppHandle) -> Result<(String, String), KeyFailure> {
        tpm_create().or_else(|_| dpapi_create())
    }

    pub fn device_open(_app: &tauri::AppHandle, handle: String) -> Result<String, KeyFailure> {
        let secret = if let Some(sealed) = handle.strip_prefix(TPM_HANDLE_PREFIX) {
            tpm_open(&from_hex(sealed).filter(|s| !s.is_empty()).ok_or(KeyFailure::Failed)?)?
        } else {
            let sealed = handle
                .strip_prefix(DEVICE_HANDLE_PREFIX)
                .and_then(from_hex)
                .filter(|s| !s.is_empty())
                .ok_or(KeyFailure::Failed)?;
            unprotect(&sealed).ok_or(KeyFailure::Failed)?
        };
        if secret.len() != DEVICE_SECRET_BYTES {
            return Err(KeyFailure::Failed);
        }
        Ok(to_hex(&secret))
    }

    /// An NCrypt provider or key handle, freed on drop.
    struct NCrypt(usize);
    impl Drop for NCrypt {
        fn drop(&mut self) {
            if self.0 != 0 {
                let _ = unsafe { NCryptFreeObject(NCRYPT_HANDLE(self.0)) };
            }
        }
    }

    fn platform_provider() -> Option<NCrypt> {
        let mut provider = NCRYPT_PROV_HANDLE::default();
        unsafe { NCryptOpenStorageProvider(&mut provider, MS_PLATFORM_CRYPTO_PROVIDER, 0) }.ok()?;
        Some(NCrypt(provider.0))
    }

    /// Whether this PC offers Windows no TPM: the TPM service finds none, or
    /// the Microsoft Platform Crypto Provider, which the device key uses, does
    /// not open. Windows Hello then keeps its keys in software. The service is
    /// asked first because an open alone may succeed with no TPM (Chromium's
    /// `crypto/unexportable_key_win.cc` asks it first too). No prompt, nothing
    /// made or stored. Not `GetAttestationAsync`: a TPM without an attestation
    /// certificate (the Windows 11 test VM's) holds keys but cannot attest, so
    /// a failed attestation does not prove a software key.
    /// Spec: docs/internal/plans/hello-tpm-status.md (section 3.1)
    pub fn tpm_missing() -> bool {
        let mut info = TPM_DEVICE_INFO::default();
        let found = unsafe {
            Tbsi_GetDeviceInfo(size_of::<TPM_DEVICE_INFO>() as u32, (&mut info as *mut TPM_DEVICE_INFO).cast())
        };
        found == TBS_E_TPM_NOT_FOUND.0 as u32 || platform_provider().is_none()
    }

    /// The account's TPM key, made on first use. `made` says whether this
    /// call made it, so a key that fails its first read-back can go.
    fn tpm_key(provider: &NCrypt) -> Result<(NCrypt, bool), KeyFailure> {
        let prov = NCRYPT_PROV_HANDLE(provider.0);
        let mut key = NCRYPT_KEY_HANDLE::default();
        match unsafe { NCryptOpenKey(prov, &mut key, TPM_KEY_NAME, CERT_KEY_SPEC(0), NCRYPT_SILENT_FLAG) } {
            Ok(()) => return Ok((NCrypt(key.0), false)),
            Err(e) if e.code() == NTE_BAD_KEYSET => {}
            Err(_) => return Err(KeyFailure::Unsupported),
        }
        unsafe {
            NCryptCreatePersistedKey(prov, &mut key, BCRYPT_RSA_ALGORITHM, TPM_KEY_NAME, CERT_KEY_SPEC(0), NCRYPT_FLAGS(0))
        }
        .map_err(|_| KeyFailure::Unsupported)?;
        let key = NCrypt(key.0);
        let handle = NCRYPT_KEY_HANDLE(key.0);
        unsafe {
            NCryptSetProperty(NCRYPT_HANDLE(key.0), NCRYPT_LENGTH_PROPERTY, &TPM_KEY_BITS.to_le_bytes(), NCRYPT_FLAGS(0))
        }
        .map_err(|_| KeyFailure::Unsupported)?;
        unsafe { NCryptFinalizeKey(handle, NCRYPT_SILENT_FLAG) }.map_err(|_| KeyFailure::Unsupported)?;
        Ok((key, true))
    }

    fn oaep() -> BCRYPT_OAEP_PADDING_INFO {
        BCRYPT_OAEP_PADDING_INFO { pszAlgId: BCRYPT_SHA256_ALGORITHM, pbLabel: std::ptr::null_mut(), cbLabel: 0 }
    }

    /// RSA-OAEP through NCrypt, sized by a first call with no output buffer.
    fn rsa(key: &NCrypt, input: &[u8], decrypt: bool) -> Option<Vec<u8>> {
        let key = NCRYPT_KEY_HANDLE(key.0);
        let padding = oaep();
        let pad = Some(&padding as *const BCRYPT_OAEP_PADDING_INFO as *const core::ffi::c_void);
        let flags = NCRYPT_PAD_OAEP_FLAG | NCRYPT_SILENT_FLAG;
        let call = |out: Option<&mut [u8]>, len: &mut u32| unsafe {
            if decrypt {
                NCryptDecrypt(key, Some(input), pad, out, len, flags)
            } else {
                NCryptEncrypt(key, Some(input), pad, out, len, flags)
            }
        };
        let mut len = 0u32;
        call(None, &mut len).ok()?;
        let mut out = vec![0u8; len as usize];
        call(Some(&mut out), &mut len).ok()?;
        out.truncate(len as usize);
        Some(out)
    }

    fn tpm_create() -> Result<(String, String), KeyFailure> {
        let provider = platform_provider().ok_or(KeyFailure::Unsupported)?;
        let (key, made) = tpm_key(&provider)?;
        let secret = random(DEVICE_SECRET_BYTES as u32)?;
        let sealed = rsa(&key, &secret, false);
        // The read-back: a key that cannot open what it sealed is no key. A
        // key this call made and that fails here holds no envelope yet, so
        // it goes; an older key may, and stays.
        let opened = sealed.as_deref().and_then(|s| rsa(&key, s, true));
        match (sealed, opened) {
            (Some(sealed), Some(opened)) if opened == secret => {
                Ok((format!("{TPM_HANDLE_PREFIX}{}", to_hex(&sealed)), to_hex(&secret)))
            }
            _ => {
                if made {
                    let doomed = std::mem::ManuallyDrop::new(key);
                    // NCryptDeleteKey frees the handle itself.
                    let _ = unsafe { NCryptDeleteKey(NCRYPT_KEY_HANDLE(doomed.0), 0) };
                }
                Err(KeyFailure::Unsupported)
            }
        }
    }

    fn tpm_open(sealed: &[u8]) -> Result<Vec<u8>, KeyFailure> {
        let provider = platform_provider().ok_or(KeyFailure::Failed)?;
        let mut key = NCRYPT_KEY_HANDLE::default();
        unsafe { NCryptOpenKey(NCRYPT_PROV_HANDLE(provider.0), &mut key, TPM_KEY_NAME, CERT_KEY_SPEC(0), NCRYPT_SILENT_FLAG) }
            .map_err(|_| KeyFailure::Failed)?;
        let key = NCrypt(key.0);
        rsa(&key, sealed, true).ok_or(KeyFailure::Failed)
    }

    fn dpapi_create() -> Result<(String, String), KeyFailure> {
        let secret = random(DEVICE_SECRET_BYTES as u32)?;
        let input = blob(&secret);
        let entropy = blob(DEVICE_ENTROPY);
        let mut out = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptProtectData(&input, PCWSTR::null(), Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        }
        .map_err(|_| KeyFailure::Unsupported)?;
        let sealed = take_blob(out);
        // The read-back: a seal that does not open is no key.
        if unprotect(&sealed).as_deref() != Some(&secret[..]) {
            return Err(KeyFailure::Unsupported);
        }
        Ok((format!("{DEVICE_HANDLE_PREFIX}{}", to_hex(&sealed)), to_hex(&secret)))
    }

    /// WinRT activation needs an initialized apartment, and this runs on a pooled
    /// blocking thread that has none. MTA keeps the wait off any message loop;
    /// `RPC_E_CHANGED_MODE` only means the thread was already initialized, which
    /// is equally fine, so the HRESULT is deliberately ignored.
    fn init_apartment() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }
}

/// Android: `BiometricPrompt` through `androidx.biometric`, reached with the
/// official Tauri biometric plugin. The other two backends call the OS from Rust;
/// this one cannot, because the API is Kotlin and the prompt has to attach to an
/// Activity, so the plugin ships the native half and this module only maps its
/// result onto the shared contract. The plugin's own commands are never granted
/// to the webview - nothing but these two functions reaches it.
#[cfg(target_os = "android")]
mod android {
    use tauri_plugin_biometric::{AuthOptions, BiometricExt};

    /// Usable biometrics right now? False on hardware without a sensor, with no
    /// finger or face enrolled, while the sensor is locked out after too many
    /// failed attempts, or when a pending security update has disabled it. The
    /// question asks for the same class of biometric the prompt below requests,
    /// so this answer cannot promise a prompt that then refuses to appear.
    pub fn available(app: &tauri::AppHandle) -> bool {
        app.biometric()
            .status()
            .map(|status| status.is_available)
            .unwrap_or(false)
    }

    pub fn authenticate(
        app: &tauri::AppHandle,
        reason: String,
        cancel_label: String,
    ) -> Result<bool, String> {
        let options = AuthOptions {
            // The prompt puts its title in the one line the user actually reads,
            // and falls back to an untranslated English "Fingerprint
            // Authentication" when there is none - so the caller's translated
            // reason goes here, and the description below it stays empty rather
            // than repeating it.
            title: Some(reason),
            cancel_title: Some(cancel_label),
            // Biometrics only, the same policy as the Apple backend: the device
            // PIN or pattern is a weaker gate than the app's own, and the app
            // already offers its PIN and the recovery phrase when biometrics
            // will not play.
            allow_device_credential: false,
            ..Default::default()
        };
        // Every "no" arrives as a rejection - cancelled, wrong finger, locked
        // out, no prompt at all - with no way to tell a refusal from a fault.
        // The caller does the same thing for all of them, so they collapse into
        // one answer here and none of them is an Err.
        Ok(app.biometric().authenticate(String::new(), options).is_ok())
    }

    // The bound key: plugins/biometric-key (Kotlin) holds an RSA Keystore key
    // that a strong biometric releases through a CryptoObject. The plugin
    // rejects with the same codes KeyFailure carries.
    use tauri_plugin_biometric_key::BiometricKeyExt;

    fn failure(code: String) -> super::KeyFailure {
        match code.as_str() {
            "unsupported" => super::KeyFailure::Unsupported,
            "cancelled" => super::KeyFailure::Cancelled,
            "gone" => super::KeyFailure::Gone,
            "unenrolled" => super::KeyFailure::Unenrolled,
            _ => super::KeyFailure::Failed,
        }
    }

    pub fn key_create(
        app: &tauri::AppHandle,
        reason: String,
        cancel_label: String,
    ) -> Result<(String, String), super::KeyFailure> {
        app.biometric_key()
            .create(&reason, &cancel_label)
            .map(|created| (created.handle, created.secret))
            .map_err(failure)
    }

    pub fn key_open(
        app: &tauri::AppHandle,
        handle: String,
        reason: String,
        cancel_label: String,
    ) -> Result<String, super::KeyFailure> {
        app.biometric_key().open(&handle, &reason, &cancel_label).map_err(failure)
    }

    pub fn key_delete(app: &tauri::AppHandle, handle: String) {
        app.biometric_key().delete(&handle);
    }

    // The device key: a Keystore AES key that needs no user, in the same
    // plugin (`deviceCreate`, `deviceOpen`).
    pub fn device_create(app: &tauri::AppHandle) -> Result<(String, String), super::KeyFailure> {
        app.biometric_key()
            .device_create()
            .map(|created| (created.handle, created.secret))
            .map_err(failure)
    }

    pub fn device_open(app: &tauri::AppHandle, handle: String) -> Result<String, super::KeyFailure> {
        app.biometric_key().device_open(&handle).map_err(failure)
    }
}
