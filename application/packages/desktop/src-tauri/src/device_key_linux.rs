//! Linux: the device key in the Secret Service (GNOME Keyring, KDE Wallet),
//! the system keyring that the login unlocks. It wraps the stored phrase while
//! the app lock is off, as the Secure Enclave, the Android Keystore and DPAPI
//! do on the other platforms (src/biometric.rs), so a copy of the app's data
//! folder holds only ciphertext.
//!
//! One keyring item per account holds a random 32-byte master. Each create
//! draws a fresh 32-byte nonce, and the secret is HMAC-SHA256 over it with the
//! master, so every handle has its own secret while the keyring gains one item,
//! not one per write. The handle is `ss1.<item id>.<nonce>`; only the nonce and
//! the item's random id leave the keyring.
//!
//! No prompt on create: a locked keyring (an automatic login, say) answers
//! `unsupported`, and the web side keeps its own key. An open that the boot
//! marks `interactive` shows the system's unlock dialog for a locked keyring,
//! the one every app that keeps a password there shows, because the
//! alternative is the sign-in screen; it waits at most `PROMPT_WAIT`, and a
//! dismissed or unanswered dialog is `cancelled`, which the web side does not
//! ask again. Every other open answers `failed` for a locked keyring. A
//! desktop with no Secret Service answers `unsupported`.
//!
//! D-Bus through `zbus`, which the notification and opener plugins already
//! bring in, with the "plain" session: the secret crosses the session bus only
//! to this process, and code that runs as this user could ask the keyring for
//! it anyway (out of scope in THREAT_MODEL.md).
//! Spec: docs/internal/plans/device-bound-phrase-key.md (section 3)

use ring::hmac;
use ring::rand::{SecureRandom, SystemRandom};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

const SERVICE: &str = "org.freedesktop.secrets";
const SERVICE_PATH: &str = "/org/freedesktop/secrets";
const SERVICE_IFACE: &str = "org.freedesktop.Secret.Service";
const COLLECTION_IFACE: &str = "org.freedesktop.Secret.Collection";
const ITEM_IFACE: &str = "org.freedesktop.Secret.Item";
const PROMPT_IFACE: &str = "org.freedesktop.Secret.Prompt";
/// The object path that means "none" (no prompt, no alias).
const NO_PATH: &str = "/";

const APPLICATION: &str = "app.privacynotes";
const PURPOSE: &str = "device-wrap-v1";
const LABEL: &str = "PrivacyNotes device key";
const HANDLE_PREFIX: &str = "ss1.";
const MASTER_BYTES: usize = 32;
const NONCE_BYTES: usize = 32;
const ID_BYTES: usize = 16;
/// The HMAC message starts with this, so the master keys nothing else.
const HMAC_INFO: &[u8] = b"privacynotes-device-wrap-v1";

pub const UNSUPPORTED: &str = "unsupported";
pub const CANCELLED: &str = "cancelled";
pub const FAILED: &str = "failed";

/// How long an unlock dialog may stay up before the open gives up on it.
const PROMPT_WAIT: Duration = Duration::from_secs(60);

/// One create at a time in this process, so two writes racing on a fresh
/// install make one master item, not two.
static CREATE: Mutex<()> = Mutex::new(());

/// (session, parameters, value, content type), the Secret Service's Secret.
type Secret = (OwnedObjectPath, Vec<u8>, Vec<u8>, String);

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str, len: usize) -> Option<Vec<u8>> {
    if text.len() != len * 2 || !text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return None;
    }
    text.as_bytes().chunks(2).map(|pair| std::str::from_utf8(pair).ok().and_then(|pair| u8::from_str_radix(pair, 16).ok())).collect()
}

fn random(len: usize) -> Option<Vec<u8>> {
    let mut out = vec![0u8; len];
    SystemRandom::new().fill(&mut out).ok()?;
    Some(out)
}

fn derive(master: &[u8], nonce: &[u8]) -> Vec<u8> {
    let key = hmac::Key::new(hmac::HMAC_SHA256, master);
    let mut message = HMAC_INFO.to_vec();
    message.extend_from_slice(nonce);
    hmac::sign(&key, &message).as_ref().to_vec()
}

/// `ss1.<32 hex id>.<64 hex nonce>`; anything else is no handle.
fn parse_handle(handle: &str) -> Option<(String, Vec<u8>)> {
    let (id, nonce) = handle.strip_prefix(HANDLE_PREFIX)?.split_once('.')?;
    unhex(id, ID_BYTES)?;
    Some((id.to_owned(), unhex(nonce, NONCE_BYTES)?))
}

struct Keyring {
    conn: Connection,
    session: OwnedObjectPath,
}

impl Keyring {
    /// The session bus and a plain session, or None without a Secret Service.
    fn connect() -> Option<Self> {
        let conn = Connection::session().ok()?;
        let service = Proxy::new(&conn, SERVICE, SERVICE_PATH, SERVICE_IFACE).ok()?;
        let (_, session): (OwnedValue, OwnedObjectPath) =
            service.call("OpenSession", &("plain", Value::from(""))).ok()?;
        Some(Self { conn, session })
    }

    fn service(&self) -> Option<Proxy<'_>> {
        Proxy::new(&self.conn, SERVICE, SERVICE_PATH, SERVICE_IFACE).ok()
    }

    fn attributes(id: Option<&str>) -> HashMap<&'static str, String> {
        let mut out = HashMap::from([("application", APPLICATION.to_owned()), ("purpose", PURPOSE.to_owned())]);
        if let Some(id) = id {
            out.insert("id", id.to_owned());
        }
        out
    }

    /// (unlocked, locked) items that carry our attributes, sorted, so every
    /// call that finds more than one picks the same.
    fn search(&self, id: Option<&str>) -> Option<(Vec<OwnedObjectPath>, Vec<OwnedObjectPath>)> {
        let (mut unlocked, mut locked): (Vec<OwnedObjectPath>, Vec<OwnedObjectPath>) =
            self.service()?.call("SearchItems", &(Self::attributes(id),)).ok()?;
        unlocked.sort_by(|a, b| a.as_str().cmp(b.as_str()));
        locked.sort_by(|a, b| a.as_str().cmp(b.as_str()));
        Some((unlocked, locked))
    }

    /// Unlocks one object, through the system dialog when it asks for one.
    fn unlock(&self, path: &OwnedObjectPath) -> Result<(), &'static str> {
        let service = self.service().ok_or(FAILED)?;
        let (unlocked, prompt): (Vec<OwnedObjectPath>, OwnedObjectPath) =
            service.call("Unlock", &(vec![path.clone()],)).map_err(|_| FAILED)?;
        if prompt.as_str() == NO_PATH {
            return if unlocked.contains(path) { Ok(()) } else { Err(FAILED) };
        }
        self.run_prompt(&prompt)
    }

    /// Shows a Secret Service prompt and waits for its answer, at most
    /// `PROMPT_WAIT`. Dismissed or unanswered is `cancelled`; an unanswered
    /// dialog is dismissed, so it does not stay on screen.
    fn run_prompt(&self, prompt: &OwnedObjectPath) -> Result<(), &'static str> {
        let proxy = Proxy::new(&self.conn, SERVICE, prompt.as_str(), PROMPT_IFACE).map_err(|_| FAILED)?;
        let completed = proxy.receive_signal("Completed").map_err(|_| FAILED)?;
        proxy.call::<_, _, ()>("Prompt", &("",)).map_err(|_| FAILED)?;
        // The signal iterator has no time limit, so it waits on its own thread.
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut completed = completed;
            let answer = completed
                .next()
                .and_then(|message| message.body().deserialize::<(bool, OwnedValue)>().ok())
                .map(|(dismissed, _)| !dismissed);
            let _ = tx.send(answer);
        });
        match rx.recv_timeout(PROMPT_WAIT) {
            Ok(Some(true)) => Ok(()),
            Ok(_) => Err(CANCELLED),
            Err(_) => {
                let _ = proxy.call::<_, _, ()>("Dismiss", &());
                Err(CANCELLED)
            }
        }
    }

    fn secret_of(&self, item: &OwnedObjectPath) -> Option<Vec<u8>> {
        let secrets: HashMap<OwnedObjectPath, Secret> =
            self.service()?.call("GetSecrets", &(vec![item.clone()], &self.session)).ok()?;
        let value = secrets.into_values().next()?.2;
        (value.len() == MASTER_BYTES).then_some(value)
    }

    fn id_of(&self, item: &OwnedObjectPath) -> Option<String> {
        let proxy = Proxy::new(&self.conn, SERVICE, item.as_str(), ITEM_IFACE).ok()?;
        let attributes: HashMap<String, String> = proxy.get_property("Attributes").ok()?;
        let id = attributes.get("id")?;
        unhex(id, ID_BYTES).map(|_| id.clone())
    }

    /// A fresh master item in the default collection, never through a
    /// prompt: a locked or missing collection is None.
    fn create_master(&self) -> Option<OwnedObjectPath> {
        let (collection,): (OwnedObjectPath,) = self.service()?.call("ReadAlias", &("default",)).ok()?;
        if collection.as_str() == NO_PATH {
            return None;
        }
        let proxy = Proxy::new(&self.conn, SERVICE, collection.as_str(), COLLECTION_IFACE).ok()?;
        if proxy.get_property::<bool>("Locked").ok()? {
            return None;
        }
        let id = hex(&random(ID_BYTES)?);
        let master = random(MASTER_BYTES)?;
        let properties = HashMap::from([
            ("org.freedesktop.Secret.Item.Label", Value::from(LABEL)),
            ("org.freedesktop.Secret.Item.Attributes", Value::from(Self::attributes(Some(&id)))),
        ]);
        let secret = (&self.session, Vec::<u8>::new(), master, "application/octet-stream");
        let (item, prompt): (OwnedObjectPath, OwnedObjectPath) =
            proxy.call("CreateItem", &(properties, secret, false)).ok()?;
        (prompt.as_str() == NO_PATH && item.as_str() != NO_PATH).then_some(item)
    }
}

/// A fresh secret and its handle, with no prompt.
pub fn create() -> Result<(String, String), &'static str> {
    let _one = CREATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let keyring = Keyring::connect().ok_or(UNSUPPORTED)?;
    let (unlocked, locked) = keyring.search(None).ok_or(UNSUPPORTED)?;
    let item = match unlocked.into_iter().next() {
        Some(item) => item,
        // A locked master is never replaced by a second one: a handle that
        // names it opens again once the keyring is unlocked.
        None if !locked.is_empty() => return Err(UNSUPPORTED),
        None => keyring.create_master().ok_or(UNSUPPORTED)?,
    };
    let id = keyring.id_of(&item).ok_or(UNSUPPORTED)?;
    let master = keyring.secret_of(&item).ok_or(UNSUPPORTED)?;
    let nonce = random(NONCE_BYTES).ok_or(UNSUPPORTED)?;
    let secret = hex(&derive(&master, &nonce));
    let handle = format!("{HANDLE_PREFIX}{id}.{}", hex(&nonce));
    // The read-back: a handle that does not open again is no key.
    match open(&handle, false) {
        Ok(again) if again == secret => Ok((handle, secret)),
        _ => Err(UNSUPPORTED),
    }
}

/// The secret of a handle. A locked keyring shows the system's unlock dialog
/// only when `interactive`; otherwise it is `failed`.
pub fn open(handle: &str, interactive: bool) -> Result<String, &'static str> {
    let (id, nonce) = parse_handle(handle).ok_or(FAILED)?;
    let keyring = Keyring::connect().ok_or(FAILED)?;
    let (unlocked, locked) = keyring.search(Some(&id)).ok_or(FAILED)?;
    let item = match unlocked.into_iter().next() {
        Some(item) => item,
        None => {
            let item = locked.into_iter().next().ok_or(FAILED)?;
            if !interactive {
                return Err(FAILED);
            }
            keyring.unlock(&item)?;
            item
        }
    };
    let master = keyring.secret_of(&item).ok_or(FAILED)?;
    Ok(hex(&derive(&master, &nonce)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unhex_reads_back_what_hex_writes() {
        let every: Vec<u8> = (0..=255).collect();
        assert_eq!(unhex(&hex(&every), every.len()), Some(every));
        for bad in ["0A", "0g", "0", "000", "\u{e9}"] {
            assert_eq!(unhex(bad, 1), None, "{bad:?} read");
        }
    }

    #[test]
    fn a_malformed_handle_opens_nothing() {
        let id = "0".repeat(32);
        let nonce = "a".repeat(64);
        assert!(parse_handle(&format!("ss1.{id}.{nonce}")).is_some());
        for bad in [
            String::new(),
            format!("ss2.{id}.{nonce}"),
            format!("ss1.{id}"),
            format!("ss1.{}.{nonce}", "0".repeat(31)),
            format!("ss1.{id}.{}", "A".repeat(64)),
            format!("ss1.{id}.{nonce}.00"),
            format!("sd1.{id}.{nonce}"),
        ] {
            assert!(parse_handle(&bad).is_none(), "{bad:?} parsed");
        }
    }

    #[test]
    fn each_nonce_gives_its_own_secret() {
        let master = [7u8; MASTER_BYTES];
        let a = derive(&master, &[1u8; NONCE_BYTES]);
        assert_eq!(a.len(), 32);
        assert_ne!(a, derive(&master, &[2u8; NONCE_BYTES]));
        assert_ne!(a, derive(&[8u8; MASTER_BYTES], &[1u8; NONCE_BYTES]));
        assert_eq!(a, derive(&master, &[1u8; NONCE_BYTES]));
    }

    // Needs a logged-in desktop session with an unlocked keyring.
    #[test]
    #[ignore = "needs a Secret Service on the session bus"]
    fn the_keyring_key_round_trips() {
        let (handle, secret) = create().expect("a Secret Service is running");
        assert!(handle.starts_with(HANDLE_PREFIX));
        assert!(!handle.contains(&secret));
        assert_eq!(open(&handle, false), Ok(secret.clone()));
        let (other_handle, other) = create().unwrap();
        assert_ne!(secret, other, "every create gives a fresh secret");
        let (id_a, _) = parse_handle(&handle).unwrap();
        let (id_b, _) = parse_handle(&other_handle).unwrap();
        assert_eq!(id_a, id_b, "one master item, not one per write");
    }

    // Needs a Secret Service whose prompter cannot show (a private session
    // with no display), so the dialog is never answered. Runs after the
    // round trip (`--test-threads=1`), because it leaves the keyring locked.
    #[test]
    #[ignore = "needs a Secret Service on the session bus and no display"]
    fn the_locked_keyring_prompts_only_when_asked_and_gives_up() {
        let (handle, secret) = create().expect("a Secret Service is running");
        let keyring = Keyring::connect().unwrap();
        let (collection,): (OwnedObjectPath,) =
            keyring.service().unwrap().call("ReadAlias", &("default",)).unwrap();
        let _: (Vec<OwnedObjectPath>, OwnedObjectPath) =
            keyring.service().unwrap().call("Lock", &(vec![collection],)).unwrap();
        assert_eq!(open(&handle, false), Err(FAILED), "no dialog unless asked");
        assert_eq!(create().map(|_| ()), Err(UNSUPPORTED), "a locked keyring never gets a second master");
        let started = std::time::Instant::now();
        let answer = open(&handle, true);
        assert!(started.elapsed() < PROMPT_WAIT + Duration::from_secs(5));
        assert!(answer == Err(CANCELLED) || answer == Err(FAILED) || answer == Ok(secret), "{answer:?}");
    }
}
