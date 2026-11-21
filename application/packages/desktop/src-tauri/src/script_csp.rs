//! A content security policy on every script the app serves, so that a worker
//! started from one runs under a policy too.
//!
//! Tauri puts the `csp` of `tauri.conf.json` only on `.html` responses
//! (`tauri-2.12.1/src/manager/mod.rs`, `is_html`). A worker takes its policy
//! from its own script's response, not from the page that starts it, so
//! before this hook every worker script from `tauri://localhost` ran with no
//! policy at all: it could run `eval` and fetch any host. The pdf.js worker,
//! which reads strangers' PDFs, was one of them. On the web the `/*` rule of
//! `packages/web/public/_headers` covers `/assets/*` already.
//!
//! The header has no effect on a script the page loads with `<script>` or
//! `import`: a browser applies a policy only to a document or a worker. HTML
//! responses keep the policy Tauri sets, and a blob: or data: worker keeps the
//! policy of the page that made it.
//!
//! The hook is attached per window (main, About, Ninja box): Tauri registers
//! the `tauri` protocol once for each web view. `pnpm desktop:dev` loads the
//! Vite server, so check this in a release build (`custom-protocol`).
//!
//! Spec: docs/internal/specs/plugins-research.md (section 2.1)

use std::borrow::Cow;
use tauri::http::{header, HeaderValue, Request, Response};
use tauri::{Manager, Runtime};

/// A response of the `tauri` protocol, as the hook receives it.
type Asset = Response<Cow<'static, [u8]>>;

/// The pdf.js worker fetches nothing: the app hands it the bytes, and its
/// image decoders come in as modules (`useWasm: false` in `PdfPages.tsx`).
/// It starts no worker of its own: without `worker-src` a nested worker would
/// fall under `script-src 'self'` and run under the default policy below,
/// with the page's `connect-src` (beta #218).
const PDF_WORKER: &str = "default-src 'none'; script-src 'self'; worker-src 'none'";

/// The plugin worker (Settings > Plugins) is the one script that may compile
/// WebAssembly. It has no network at all: the app fetches and checks every
/// plugin file and hands the worker the bytes. `worker-src 'none'` keeps it
/// from starting a worker of its own, which would run under the default policy
/// below and so with the page's `connect-src`. The same policy as its rule in
/// `packages/web/public/_headers`.
/// Spec: docs/internal/plans/plugins.md (section 4, Tauri header)
const PLUGIN_WORKER: &str = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'none'; worker-src 'none'";

/// Workers that get a narrower policy than the default, by the start of the
/// file name Vite gives their script. The first match wins.
const NAMED: &[(&str, &str)] = &[("pdf.worker.", PDF_WORKER), ("pluginWorker-", PLUGIN_WORKER)];

/// The policy of every other script: its own scripts only, no `eval`, no
/// WebAssembly, the page's `connect-src`, because the MapLibre worker fetches
/// map data from the map host, and no nested worker (`worker-src 'none'`;
/// no worker of the app starts one). The web gives its workers the same
/// `worker-src` through the `/assets/*` rule of `packages/web/public/_headers`.
fn default_policy(page_csp: &str) -> String {
    let connect = page_csp
        .split(';')
        .map(str::trim)
        .find(|d| d.starts_with("connect-src "))
        .unwrap_or("connect-src 'none'");
    format!("default-src 'none'; script-src 'self'; {connect}; worker-src 'none'")
}

/// The policy for a script at `path`.
fn policy_for<'a>(path: &str, default: &'a str) -> &'a str {
    let file = path.rsplit('/').next().unwrap_or(path);
    NAMED
        .iter()
        .find(|(prefix, _)| file.starts_with(prefix))
        .map_or(default, |(_, policy)| policy)
}

fn is_script(response: &Asset) -> bool {
    response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| {
            let t = t.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
            t == "text/javascript" || t == "application/javascript"
        })
}

fn apply(request: &Request<Vec<u8>>, response: &mut Asset, default: &str) {
    if !is_script(response) || response.headers().contains_key(header::CONTENT_SECURITY_POLICY) {
        return;
    }
    let policy = policy_for(request.uri().path(), default);
    if let Ok(value) = HeaderValue::from_str(policy) {
        response.headers_mut().insert(header::CONTENT_SECURITY_POLICY, value);
    }
}

/// The `on_web_resource_request` handler for a window.
pub(crate) fn hook<R: Runtime, M: Manager<R>>(
    manager: &M,
) -> impl Fn(Request<Vec<u8>>, &mut Asset) + Send + Sync + 'static {
    let page = manager.config().app.security.csp.as_ref().map(ToString::to_string).unwrap_or_default();
    let default = default_policy(&page);
    move |request, response| apply(&request, response, &default)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page_csp() -> String {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        conf["app"]["security"]["csp"].as_str().unwrap().to_string()
    }

    fn directive<'a>(csp: &'a str, name: &str) -> Option<&'a str> {
        csp.split(';').map(str::trim).find(|d| d.split(' ').next() == Some(name))
    }

    fn served(path: &str, content_type: &str) -> Asset {
        let request = Request::builder().uri(format!("tauri://localhost{path}")).body(Vec::new()).unwrap();
        let mut response = Response::builder()
            .header(header::CONTENT_TYPE, content_type)
            .body(Cow::Borrowed(&b""[..]))
            .unwrap();
        apply(&request, &mut response, &default_policy(&page_csp()));
        response
    }

    fn csp_of(r: &Asset) -> Option<String> {
        r.headers().get(header::CONTENT_SECURITY_POLICY).map(|v| v.to_str().unwrap().to_string())
    }

    #[test]
    fn no_script_policy_allows_eval_or_webassembly() {
        let default = default_policy(&page_csp());
        // The plugin worker alone may compile WebAssembly; its own test below.
        let others = NAMED.iter().filter(|(prefix, _)| *prefix != "pluginWorker-").map(|(_, p)| *p);
        for policy in others.chain([default.as_str()]) {
            assert!(!policy.contains("unsafe-eval"), "{policy}");
            assert!(!policy.contains("unsafe-inline"), "{policy}");
            assert!(directive(policy, "default-src") == Some("default-src 'none'"), "{policy}");
        }
    }

    #[test]
    fn the_default_keeps_the_page_connect_src_and_pdf_js_gets_none() {
        let page = page_csp();
        let default = default_policy(&page);
        assert_eq!(directive(&default, "connect-src"), directive(&page, "connect-src"));
        assert!(directive(&default, "connect-src").is_some());
        assert_eq!(directive(PDF_WORKER, "connect-src"), None);
    }

    #[test]
    fn every_script_gets_a_policy_and_pdf_js_the_narrow_one() {
        let default = default_policy(&page_csp());
        assert_eq!(csp_of(&served("/assets/pdf.worker.min-B5Yc7dP4.mjs", "text/javascript")), Some(PDF_WORKER.to_string()));
        assert_eq!(csp_of(&served("/assets/maplibre-gl-worker-Boc9pDRP.mjs", "text/javascript")), Some(default.clone()));
        assert_eq!(csp_of(&served("/pdfjs/6.5.438/openjpeg_nowasm_fallback.js", "application/javascript; charset=utf-8")), Some(default.clone()));
    }

    #[test]
    fn the_plugin_worker_gets_webassembly_and_no_network() {
        assert_eq!(
            csp_of(&served("/assets/pluginWorker-Ab12Cd34.js", "text/javascript")),
            Some("default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'none'; worker-src 'none'".to_string())
        );
        // No other script, and no page, gets WebAssembly.
        assert!(!default_policy(&page_csp()).contains("wasm-unsafe-eval"));
        assert!(!page_csp().contains("wasm-unsafe-eval"));
        assert!(!csp_of(&served("/assets/index-Ab12Cd34.js", "text/javascript")).unwrap().contains("wasm-unsafe-eval"));
    }

    #[test]
    fn no_worker_script_may_start_a_worker_of_its_own() {
        let default = default_policy(&page_csp());
        for policy in NAMED.iter().map(|(_, p)| *p).chain([default.as_str()]) {
            assert_eq!(directive(policy, "worker-src"), Some("worker-src 'none'"), "{policy}");
        }
    }

    #[test]
    fn html_and_other_files_are_left_as_tauri_serves_them() {
        assert_eq!(csp_of(&served("/index.html", "text/html")), None);
        assert_eq!(csp_of(&served("/assets/index-x.css", "text/css")), None);
        assert_eq!(csp_of(&served("/assets/model.wasm", "application/wasm")), None);
        // A policy already on the response (Tauri's, on an HTML page) stays.
        let request = Request::builder().uri("tauri://localhost/a.js").body(Vec::new()).unwrap();
        let mut response = Response::builder()
            .header(header::CONTENT_TYPE, "text/javascript")
            .header(header::CONTENT_SECURITY_POLICY, "default-src 'self'")
            .body(Cow::Borrowed(&b""[..]))
            .unwrap();
        apply(&request, &mut response, "x");
        assert_eq!(csp_of(&response), Some("default-src 'self'".to_string()));
    }
}
