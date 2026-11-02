//! Tap the status bar to go to the top (GitHub #617).
//!
//! UIKit hands the tap to the one scroll view that has `scrollsToTop` and
//! can scroll up, and asks its delegate `scrollViewShouldScrollToTop:` first.
//! The app never scrolls the page, only the columns inside it, so the web
//! view's own scroll view cannot scroll and UIKit passes it over. A scroll
//! view one point tall at the top of the web view takes its place: it can
//! scroll by one point, it is the only one with `scrollsToTop`, and its
//! delegate answers NO and tells the page, which takes the column under the
//! middle of the screen to its top (`statusBarTap.ts`).
//!
//! Bound with raw `msg_send!` like `keyboard_accessory.rs`. A load keeps the
//! web view, so the tag finds a sentinel already in place.

use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
use objc2::sel;
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};

const DELEGATE: &std::ffi::CStr = c"PNStatusBarTapDelegate";

/// Marks the sentinel among the web view's subviews.
const TAG: isize = 0x504e_5354;

/// The event `statusBarTap.ts` listens for.
const SCRIPT: &str = "window.dispatchEvent(new Event('pn-status-bar-tap'))";

extern "C" fn should_scroll_to_top(_this: *mut AnyObject, _cmd: Sel, scroll: *mut AnyObject) -> Bool {
    unsafe {
        let webview: *mut AnyObject = msg_send![scroll, superview];
        if !webview.is_null() {
            let script = NSString::from_str(SCRIPT);
            let _: () = msg_send![webview, evaluateJavaScript: &*script, completionHandler: std::ptr::null::<AnyObject>()];
        }
    }
    Bool::NO
}

/// The delegate class, made once.
unsafe fn delegate_class() -> Option<&'static AnyClass> {
    if let Some(existing) = AnyClass::get(DELEGATE) {
        return Some(existing);
    }
    let mut builder = ClassBuilder::new(DELEGATE, AnyClass::get(c"NSObject")?)?;
    builder.add_method(
        sel!(scrollViewShouldScrollToTop:),
        should_scroll_to_top as extern "C" fn(*mut AnyObject, Sel, *mut AnyObject) -> Bool,
    );
    Some(builder.register())
}

/// Puts the sentinel on `webview`, the WKWebView the window renders in.
pub unsafe fn listen(webview: *mut AnyObject) {
    if webview.is_null() {
        return;
    }
    let existing: *mut AnyObject = msg_send![webview, viewWithTag: TAG];
    if !existing.is_null() {
        return;
    }
    let (Some(scroll_class), Some(delegate_class)) = (AnyClass::get(c"UIScrollView"), delegate_class()) else {
        return;
    };
    let web_scroll: *mut AnyObject = msg_send![webview, scrollView];
    if !web_scroll.is_null() {
        let _: () = msg_send![web_scroll, setScrollsToTop: false];
    }
    let bounds: NSRect = msg_send![webview, bounds];
    let width = bounds.size.width;
    let sentinel: *mut AnyObject = msg_send![scroll_class, alloc];
    let sentinel: *mut AnyObject = msg_send![sentinel, initWithFrame: NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, 1.0))];
    // A delegate is held weakly; this one lives as long as the app.
    let delegate: *mut AnyObject = msg_send![delegate_class, new];
    let _: () = msg_send![sentinel, setTag: TAG];
    let _: () = msg_send![sentinel, setContentSize: NSSize::new(width, 2.0)];
    let _: () = msg_send![sentinel, setContentOffset: NSPoint::new(0.0, 1.0)];
    let _: () = msg_send![sentinel, setScrollsToTop: true];
    let _: () = msg_send![sentinel, setShowsVerticalScrollIndicator: false];
    // UIViewAutoresizingFlexibleWidth: it follows a rotation.
    let _: () = msg_send![sentinel, setAutoresizingMask: 2usize];
    let _: () = msg_send![sentinel, setDelegate: delegate];
    let _: () = msg_send![webview, addSubview: sentinel];
    let _: () = msg_send![sentinel, release];
}

/// Runs `listen` on a web view of the app.
pub fn listen_in<R: tauri::Runtime>(view: &tauri::Webview<R>) {
    let _ = view.with_webview(|webview| unsafe {
        listen(webview.inner() as *mut AnyObject);
    });
}

