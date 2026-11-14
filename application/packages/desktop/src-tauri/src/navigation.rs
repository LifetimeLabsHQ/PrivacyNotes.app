//! Every window of the app stays on the app's own pages (beta issue 85).
//!
//! Tauri allows any navigation unless a handler refuses it, so a link the web
//! view follows in place (an image map or an svg link in formatted text, which
//! the HTML cleaner now removes) put another site in the app window, with no
//! address bar, where it could pass for the lock or sign-in screen. Links the
//! app means to open go to the system browser through the opener plugin
//! (`App.tsx`, `openExternal.ts`), which is not a navigation of the web view.
//!
//! Allowed: the app's own origin as each platform serves it (`tauri://localhost`
//! on macOS, iOS and Linux, `http://tauri.localhost` on Windows and Android,
//! `https://tauri.localhost` when a build sets `useHttpsScheme`), the configured
//! dev server in a debug build, and `about:blank` / `about:srcdoc` and the
//! app's own `blob:` addresses, which WKWebView also passes here for frames.
//! Never `asset.localhost`: an asset address serves a file from disk with no
//! CSP, so a page there must not become the window (beta issue 86).

use tauri::{Manager, Runtime, Url};

/// True when `url` is one of the app's own pages (see the module comment).
/// `dev_url` is the dev server, given only in a debug build.
pub(crate) fn is_app_url(url: &Url, dev_url: Option<&Url>) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost") && url.port().is_none(),
        "http" | "https" => {
            if url.host_str() == Some("tauri.localhost") && url.port().is_none() {
                return true;
            }
            dev_url.is_some_and(|dev| url.origin() == dev.origin())
        }
        "about" => matches!(url.path(), "blank" | "srcdoc"),
        // A blob: address carries the origin that made it.
        "blob" => Url::parse(url.path()).is_ok_and(|inner| inner.scheme() != "blob" && is_app_url(&inner, dev_url)),
        _ => false,
    }
}

/// The dev server the debug build loads, none in a release build.
pub(crate) fn dev_url<R: Runtime, M: Manager<R>>(manager: &M) -> Option<Url> {
    #[cfg(debug_assertions)]
    {
        manager.config().build.dev_url.clone()
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = manager;
        None
    }
}

/// The handler every window builder takes with `.on_navigation(...)`.
pub(crate) fn guard<R: Runtime, M: Manager<R>>(manager: &M) -> impl Fn(&Url) -> bool + Send + 'static {
    let dev = dev_url(manager);
    move |url| {
        let allowed = is_app_url(url, dev.as_ref());
        if !allowed {
            eprintln!("navigation refused: {}", url.scheme());
        }
        allowed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(s: &str, dev: Option<&str>) -> bool {
        let dev = dev.map(|d| Url::parse(d).unwrap());
        is_app_url(&Url::parse(s).unwrap(), dev.as_ref())
    }

    #[test]
    fn allows_the_app_origin_of_every_platform() {
        assert!(ok("tauri://localhost/", None));
        assert!(ok("tauri://localhost/index.html?about-window=1", None));
        assert!(ok("http://tauri.localhost/", None));
        assert!(ok("https://tauri.localhost/index.html?ninja-window=1", None));
        assert!(ok("about:blank", None));
        assert!(ok("about:srcdoc", None));
        assert!(ok("blob:tauri://localhost/7f1c", None));
        assert!(ok("blob:http://tauri.localhost/7f1c", None));
    }

    #[test]
    fn refuses_other_sites_and_the_asset_origin() {
        assert!(!ok("https://evil.example/", None));
        assert!(!ok("http://asset.localhost/C%3A%5CWindows%5Cwin.ini", None));
        assert!(!ok("https://asset.localhost/x.html", None));
        assert!(!ok("asset://localhost/%2Fetc%2Fpasswd", None));
        assert!(!ok("http://tauri.localhost:8080/", None));
        assert!(!ok("tauri://localhost:1/", None));
        assert!(!ok("tauri://evil/", None));
        assert!(!ok("http://tauri.localhost.evil.example/", None));
        assert!(!ok("file:///etc/passwd", None));
        assert!(!ok("data:text/html,<p>x</p>", None));
        assert!(!ok("javascript:alert(1)", None));
        assert!(!ok("blob:https://evil.example/7f1c", None));
        assert!(!ok("blob:http://asset.localhost/7f1c", None));
        assert!(!ok("about:config", None));
    }

    #[test]
    fn the_dev_server_only_when_given() {
        assert!(ok("http://localhost:5173/", Some("http://localhost:5173")));
        assert!(ok("blob:http://localhost:5173/7f1c", Some("http://localhost:5173")));
        assert!(!ok("http://localhost:5173/", None));
        assert!(!ok("http://localhost:5174/", Some("http://localhost:5173")));
    }
}
