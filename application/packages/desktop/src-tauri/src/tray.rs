//! Keep running in the tray (GitHub #667). With the Settings switch on, the
//! close button and minimize put the main window away instead of quitting or
//! sitting on the taskbar, and an icon in the notification area brings it
//! back: a left click (Windows; Linux delivers no tray clicks) or Open in its
//! menu. Settings in the menu brings it back with Settings open (`pn-tray-settings`).
//! Quit in the menu ends the app.
//!
//! Every show of the main window goes through `show` here: the first show at
//! start (page load, the 5 s fallback, the answer for a start at sign-in) and
//! each reveal. One pure `decide` says what to do, and `apply` puts the
//! capture block on first, on every path (privacy_screen.rs). Both run on
//! the main thread (`show_via`).
//!
//! The web view keeps running while the window is away, so desktop reminders
//! still ring. `pn-tray` tells it when the window goes and comes back: the
//! idle re-lock in `appReLock.ts` does not count time spent in the tray, so an
//! app in the tray stays unlocked (the owner's choice, 2026-11-03).
//! Spec: docs/internal/specs/calendar-pillar-spec.md (section 8); docs/contrib/biometric-unlock.md (section 3.3)

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};
use tauri::menu::{Menu, MenuEvent, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow, Window, WindowEvent};

const TRAY_ID: &str = "main";
const OPEN_ID: &str = "tray-open";
const SETTINGS_ID: &str = "tray-settings";
const QUIT_ID: &str = "tray-quit";

/// The Settings switch, as the web view last pushed it.
static ON: AtomicBool = AtomicBool::new(false);

/// Turn tray mode on or off. The menu labels come from the web view, which
/// holds the translations. Pushed at start and on every change of the switch.
#[tauri::command]
pub fn set_tray_mode<R: Runtime>(app: AppHandle<R>, enabled: bool, open: String, settings: String, quit: String) -> Result<(), String> {
    // On only once the icon exists: a step below that fails would otherwise
    // leave close and minimize hiding the window with no icon to bring it
    // back (beta issue 174).
    ON.store(false, Ordering::SeqCst);
    let _ = app.remove_tray_by_id(TRAY_ID);
    if !enabled {
        // Switched off while the window was away: bring it back, or nothing would.
        reveal(&app);
        return Ok(());
    }
    // No icon: tray mode stays off, and a window that went away (a start at
    // sign-in into the tray) comes back, since no icon could bring it. The
    // page sets the switch back on the error (beta issue 200, item 6).
    build_tray(&app, open, settings, quit).inspect_err(|_| reveal(&app))?;
    ON.store(true, Ordering::SeqCst);
    Ok(())
}

fn build_tray<R: Runtime>(app: &AppHandle<R>, open: String, settings: String, quit: String) -> Result<(), String> {
    let open = MenuItem::with_id(app, OPEN_ID, open, true, None::<&str>).map_err(|e| e.to_string())?;
    let settings = MenuItem::with_id(app, SETTINGS_ID, settings, true, None::<&str>).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, QUIT_ID, quit, true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&open, &settings, &quit]).map_err(|e| e.to_string())?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("PrivacyNotes")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu)
        .on_tray_icon_event(on_click);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app).map_err(|e| e.to_string())?;
    Ok(())
}

fn on_menu<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id.as_ref() {
        OPEN_ID => reveal(app),
        SETTINGS_ID => {
            reveal(app);
            let _ = app.emit("pn-tray-settings", ());
        }
        QUIT_ID => app.exit(0),
        _ => {}
    }
}

fn on_click<R: Runtime>(tray: &TrayIcon<R>, event: TrayIconEvent) {
    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
        reveal(tray.app_handle());
    }
}

/// The main window's close and minimize, while tray mode is on.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() != "main" || !ON.load(Ordering::SeqCst) {
        return;
    }
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            put_away(window);
        }
        // Tao has no minimize event: a resize that leaves the window
        // minimized is one. On Windows that resize is to 0 x 0, and
        // `is_minimized` inside this handler still answers false.
        WindowEvent::Resized(size) if (size.width == 0 && size.height == 0) || window.is_minimized().unwrap_or(false) => {
            put_away(window)
        }
        _ => {}
    }
}

fn put_away<R: Runtime>(window: &Window<R>) {
    let _ = window.hide();
    let _ = window.emit("pn-tray", true);
}

/// What asks the main window to show. Every show of the main window goes
/// through `show` with one of these, so the capture block is applied first
/// on each path (`apply`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ask {
    /// The main page finished a load (`on_page_load` in lib.rs).
    PageLoaded,
    /// The 5 s fallback in `setup`: a page that never finishes loading must
    /// still leave a window to look at.
    Timer,
    /// The web view's answer for a start at sign-in (`finish_login_start`):
    /// the Start minimized switch, and the tray switch with it.
    LoginChoice { minimized: bool, tray: bool },
    /// Back from the tray, or to the front: the tray icon and its menu, a
    /// second launch, tray mode switched off or with no icon.
    Reveal,
}

/// What the window does for one ask.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Show {
    Nothing,
    /// The first show of this run: show and focus.
    First,
    /// Start minimized with no tray: into the taskbar, minimized.
    Minimized,
    /// Unminimize, show, focus, and tell the page (`pn-tray`).
    Reveal,
}

/// What this run has done so far.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Started {
    /// The first show happened. A later reload must not show a window the
    /// person has hidden since.
    shown: bool,
    /// A start at sign-in got the web view's answer.
    login_decided: bool,
}

/// The one rule for when the main window shows. A start at sign-in
/// (`--autostart`) shows nothing on its page load and waits for the web view;
/// the 5 s fallback skips a start at sign-in the web view already placed.
fn decide(at_login: bool, now: Started, ask: Ask) -> (Show, Started) {
    match ask {
        Ask::Reveal => (Show::Reveal, now),
        Ask::PageLoaded if at_login => (Show::Nothing, now),
        Ask::Timer if at_login && now.login_decided => (Show::Nothing, now),
        Ask::PageLoaded | Ask::Timer => first(now),
        // Any other start, and a second answer, change nothing.
        Ask::LoginChoice { .. } if !at_login || now.login_decided => (Show::Nothing, now),
        Ask::LoginChoice { minimized, tray } => {
            let now = Started { login_decided: true, ..now };
            match (minimized, tray) {
                (false, _) => first(now),
                (true, false) => (Show::Minimized, now),
                // Into the tray: the window stays hidden until the icon brings it.
                (true, true) => (Show::Nothing, now),
            }
        }
    }
}

/// The first show of the run, once: a later ask shows nothing.
fn first(now: Started) -> (Show, Started) {
    if now.shown {
        (Show::Nothing, now)
    } else {
        (Show::First, Started { shown: true, ..now })
    }
}

/// The calls `apply` makes on the main window: the real window, and a
/// recording one in the tests.
trait MainWindow {
    fn flush(&self);
    fn show(&self);
    fn minimize(&self);
    fn unminimize(&self);
    fn focus(&self);
    fn back_from_tray(&self);
}

impl<R: Runtime> MainWindow for WebviewWindow<R> {
    fn flush(&self) {
        crate::privacy_screen::flush(self);
    }
    fn show(&self) {
        let _ = WebviewWindow::show(self);
    }
    fn minimize(&self) {
        let _ = WebviewWindow::minimize(self);
    }
    fn unminimize(&self) {
        let _ = WebviewWindow::unminimize(self);
    }
    fn focus(&self) {
        let _ = self.set_focus();
    }
    fn back_from_tray(&self) {
        let _ = self.emit("pn-tray", false);
    }
}

/// Carry out one decision. The capture block a hidden main window was given
/// goes on before the window shows, on every path, so its first frame is
/// already covered (privacy_screen.rs).
fn apply(window: &impl MainWindow, show: Show) {
    if show == Show::Nothing {
        return;
    }
    window.flush();
    match show {
        Show::Nothing => {}
        Show::First => {
            window.show();
            window.focus();
        }
        Show::Minimized => {
            window.minimize();
            window.show();
        }
        Show::Reveal => {
            window.unminimize();
            window.show();
            window.focus();
            window.back_from_tray();
        }
    }
}

static STARTED: Mutex<Started> = Mutex::new(Started { shown: false, login_decided: false });

/// Show the main window for `ask`, or not, as `decide` says.
pub fn show<R: Runtime>(app: &AppHandle<R>, ask: Ask) {
    let at_login = crate::autostart::started_at_login();
    let window = app.get_webview_window("main");
    show_via(
        |task| {
            let _ = app.run_on_main_thread(task);
        },
        &STARTED,
        at_login,
        ask,
        window,
    );
}

/// The decision and the calls on the window for one ask, all on the main
/// thread. `run_on_main` runs the task at once when it is called there, and
/// queues it when it is called from another thread (the 5 s timer). A window
/// call from another thread is queued too, so the timer's flush and show used
/// to wait in the queue while a show on the main thread (a second launch, a
/// late Start minimized answer) ran first, after `privacy_screen::flush` had
/// already given the pending block to the timer: that window showed with no
/// capture block. On the main thread, each ask's flush and show run together,
/// in the order the asks reach it.
fn show_via<W: MainWindow + Send + 'static>(
    run_on_main: impl FnOnce(Box<dyn FnOnce() + Send>),
    started: &'static Mutex<Started>,
    at_login: bool,
    ask: Ask,
    window: Option<W>,
) {
    run_on_main(Box::new(move || {
        let show = {
            let mut now = started.lock().unwrap_or_else(PoisonError::into_inner);
            let (show, next) = decide(at_login, *now, ask);
            *now = next;
            show
        };
        if let Some(window) = window {
            apply(&window, show);
        }
    }));
}

/// Bring the main window back from the tray, or to the front. Also the second
/// launch of the app (single-instance), which must not leave it hidden.
pub fn reveal<R: Runtime>(app: &AppHandle<R>) {
    show(app, Ask::Reveal);
}

#[cfg(test)]
mod tests {
    use super::{apply, decide, show_via, Ask, MainWindow, Show, Started};
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};
    use std::thread::{self, ThreadId};

    /// Today's starts, recorded from the code before `decide` existed: each
    /// ask in the order a run sends it, and what the window did for each.
    fn run(at_login: bool, asks: &[Ask]) -> Vec<Show> {
        let mut now = Started::default();
        asks.iter()
            .map(|ask| {
                let (show, next) = decide(at_login, now, *ask);
                now = next;
                show
            })
            .collect()
    }

    const ANSWER_SHOW: Ask = Ask::LoginChoice { minimized: false, tray: false };
    const ANSWER_TASKBAR: Ask = Ask::LoginChoice { minimized: true, tray: false };
    const ANSWER_TRAY: Ask = Ask::LoginChoice { minimized: true, tray: true };

    #[test]
    fn a_plain_start_shows_once_on_its_first_load() {
        use Ask::{PageLoaded, Timer};
        use Show::{First, Nothing};
        assert_eq!(run(false, &[PageLoaded, PageLoaded, Timer]), [First, Nothing, Nothing]);
        // A page that never finishes: the timer shows it, a late load does not again.
        assert_eq!(run(false, &[Timer, PageLoaded]), [First, Nothing]);
        // `finish_login_start` on a start that was not at sign-in changes nothing.
        assert_eq!(run(false, &[ANSWER_TASKBAR, ANSWER_TRAY, PageLoaded]), [Nothing, Nothing, First]);
        // The window the person hid since is not shown by a reload.
        assert_eq!(run(false, &[PageLoaded, Ask::Reveal, PageLoaded]), [First, Show::Reveal, Nothing]);
    }

    #[test]
    fn a_start_at_sign_in_waits_for_the_web_view() {
        use Ask::{PageLoaded, Timer};
        use Show::{First, Minimized, Nothing};
        // Start minimized off: the answer shows the window, the timer then does nothing.
        assert_eq!(run(true, &[PageLoaded, ANSWER_SHOW, Timer]), [Nothing, First, Nothing]);
        // Start minimized on, no tray: minimized in the taskbar, once.
        assert_eq!(run(true, &[PageLoaded, ANSWER_TASKBAR, Timer, ANSWER_SHOW]), [Nothing, Minimized, Nothing, Nothing]);
        // Start minimized on, tray on: hidden until the tray icon brings it.
        assert_eq!(run(true, &[PageLoaded, ANSWER_TRAY, Timer, PageLoaded, Ask::Reveal]), [Nothing, Nothing, Nothing, Nothing, Show::Reveal]);
    }

    #[test]
    fn a_start_at_sign_in_with_no_answer_shows_after_the_timer() {
        use Ask::{PageLoaded, Timer};
        use Show::{First, Minimized, Nothing};
        assert_eq!(run(true, &[PageLoaded, Timer]), [Nothing, First]);
        // An answer after the timer: shown already stays shown; Start
        // minimized with no tray still minimizes it, as before.
        assert_eq!(run(true, &[Timer, ANSWER_SHOW]), [First, Nothing]);
        assert_eq!(run(true, &[Timer, ANSWER_TRAY]), [First, Nothing]);
        assert_eq!(run(true, &[Timer, ANSWER_TASKBAR]), [First, Minimized]);
    }

    #[test]
    fn a_reveal_always_shows_and_does_not_count_as_the_first_show() {
        use Ask::PageLoaded;
        use Show::First;
        // A second launch in the first seconds, before the page loaded.
        assert_eq!(run(false, &[Ask::Reveal, PageLoaded, Ask::Reveal]), [Show::Reveal, First, Show::Reveal]);
        assert_eq!(run(true, &[Ask::Reveal, ANSWER_SHOW]), [Show::Reveal, First]);
    }

    #[derive(Default)]
    struct Recorded(RefCell<Vec<&'static str>>);

    impl MainWindow for Recorded {
        fn flush(&self) {
            self.0.borrow_mut().push("flush");
        }
        fn show(&self) {
            self.0.borrow_mut().push("show");
        }
        fn minimize(&self) {
            self.0.borrow_mut().push("minimize");
        }
        fn unminimize(&self) {
            self.0.borrow_mut().push("unminimize");
        }
        fn focus(&self) {
            self.0.borrow_mut().push("focus");
        }
        fn back_from_tray(&self) {
            self.0.borrow_mut().push("pn-tray false");
        }
    }

    fn calls(show: Show) -> Vec<&'static str> {
        let window = Recorded::default();
        apply(&window, show);
        window.0.into_inner()
    }

    /// The app-switcher privacy screen (privacy_screen.rs): a capture block
    /// pushed to the hidden main window goes on before every show, so the
    /// first frame is covered. Each path makes the calls it made before.
    #[test]
    fn every_show_path_flushes_the_capture_block_first() {
        for show in [Show::Nothing, Show::First, Show::Minimized, Show::Reveal] {
            // A new `Show` fails to compile here: add it to the list above.
            let expected: &[&str] = match show {
                Show::Nothing => &[],
                Show::First => &["flush", "show", "focus"],
                Show::Minimized => &["flush", "minimize", "show"],
                Show::Reveal => &["flush", "unminimize", "show", "focus", "pn-tray false"],
            };
            assert_eq!(calls(show), expected, "{show:?}");
        }
    }

    /// Tauri's main-thread queue (`send_user_message` in tauri-runtime-wry):
    /// a call on the main thread runs at once, a call from another thread
    /// waits in the queue until the main thread takes it. Window calls go
    /// the same way.
    struct Queue {
        main: ThreadId,
        tasks: Mutex<VecDeque<Box<dyn FnOnce() + Send>>>,
    }

    impl Queue {
        fn send(&self, task: Box<dyn FnOnce() + Send>) {
            if thread::current().id() == self.main {
                task();
            } else {
                self.tasks.lock().unwrap().push_back(task);
            }
        }
        fn drain(&self) {
            loop {
                let next = self.tasks.lock().unwrap().pop_front();
                match next {
                    Some(task) => task(),
                    None => break,
                }
            }
        }
    }

    /// The main window as Tauri and privacy_screen.rs give it: the capture
    /// block the page pushed while it was hidden waits in `pending`, `flush`
    /// takes it once, and every call goes through the queue.
    #[derive(Clone)]
    struct Queued {
        queue: Arc<Queue>,
        pending: Arc<Mutex<Option<bool>>>,
        blocked: Arc<Mutex<bool>>,
        /// For each show: was the capture block on at that moment.
        shows: Arc<Mutex<Vec<bool>>>,
    }

    impl Queued {
        fn call(&self, f: impl FnOnce(&Queued) + Send + 'static) {
            let me = self.clone();
            self.queue.send(Box::new(move || f(&me)));
        }
    }

    impl MainWindow for Queued {
        fn flush(&self) {
            if let Some(on) = self.pending.lock().unwrap().take() {
                self.call(move |w| *w.blocked.lock().unwrap() = on);
            }
        }
        fn show(&self) {
            self.call(|w| {
                let on = *w.blocked.lock().unwrap();
                w.shows.lock().unwrap().push(on);
            });
        }
        fn minimize(&self) {}
        fn unminimize(&self) {}
        fn focus(&self) {}
        fn back_from_tray(&self) {}
    }

    /// The 5 s timer asks on its own thread, then the main thread asks
    /// before it takes the queue: the order that showed the window with no
    /// capture block when the timer ran the flush and the show itself.
    fn timer_then(at_login: bool, then: Ask) -> Vec<bool> {
        let queue = Arc::new(Queue { main: thread::current().id(), tasks: Mutex::new(VecDeque::new()) });
        let window = Queued {
            queue: queue.clone(),
            pending: Arc::new(Mutex::new(Some(true))),
            blocked: Arc::new(Mutex::new(false)),
            shows: Arc::new(Mutex::new(Vec::new())),
        };
        let started: &'static Mutex<Started> = Box::leak(Box::new(Mutex::new(Started::default())));
        let (q, w) = (queue.clone(), window.clone());
        thread::spawn(move || show_via(|task| q.send(task), started, at_login, Ask::Timer, Some(w))).join().unwrap();
        let q = queue.clone();
        show_via(|task| q.send(task), started, at_login, then, Some(window.clone()));
        queue.drain();
        let shows = window.shows.lock().unwrap().clone();
        shows
    }

    #[test]
    fn the_capture_block_is_on_before_every_show_when_the_timer_shows_first() {
        // A second launch while the timer's show waits for the main thread.
        assert_eq!(timer_then(false, Ask::Reveal), [true, true]);
        // A start at sign-in: Start minimized with no tray, answered while
        // the timer's ask waits. The answer reaches the main thread first,
        // so the window shows once, minimized, and the timer shows nothing.
        assert_eq!(timer_then(true, Ask::LoginChoice { minimized: true, tray: false }), [true]);
    }

    /// No top-level `src/*.rs` file other than this one and ninja.rs (the
    /// box applies its own block, `protect`) calls `.show()` or
    /// `privacy_screen::flush`, so a new show path written that way goes
    /// through `show` and its flush. A text check: a show spelled another way,
    /// or in a subfolder, is not caught.
    #[test]
    fn no_other_top_level_file_calls_show_or_the_flush() {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        for entry in std::fs::read_dir(src).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if !name.ends_with(".rs") || name == "tray.rs" || name == "ninja.rs" {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap();
            assert!(!text.contains(".show()") && !text.contains("privacy_screen::flush"), "{name} shows a window: go through tray::show");
        }
    }
}
