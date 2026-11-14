//! The iOS page never moves when the keyboard opens (GitHub #767).
//!
//! When a field takes focus, WKWebView scrolls its own scroll view to show the
//! field above the keyboard. The app never scrolls the page, only the columns
//! inside it, and `useKeyboardOpen.ts` puts the page back at the top on each
//! viewport scroll. In a short note the editor fills the screen, so WebKit
//! moves the page while the keyboard rises and the page script moves it back:
//! the whole view jumps. In a long note the column scrolls instead.
//!
//! The web view's scroll view is moved to a subclass made at run time whose
//! `setContentOffset:`, `setContentOffset:animated:` and `setBounds:` keep the
//! offset at its rest position (the top-left of the adjusted insets). The page
//! then has nothing to undo, and `keepCaretVisible` scrolls the note's column.
//! A zoomed page keeps its offset, so it can still pan.
//!
//! Bound with raw `msg_send!` like `keyboard_accessory.rs`. Runs from
//! `on_page_load` with it; a view already moved is left alone.

use objc2::encode::{Encode, Encoding};
use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
use objc2::sel;
use objc2_foundation::{NSPoint, NSRect};

const SUBCLASS: &std::ffi::CStr = c"PNPinnedScrollView";

#[repr(C)]
#[derive(Clone, Copy)]
struct EdgeInsets {
    top: f64,
    left: f64,
    bottom: f64,
    right: f64,
}

unsafe impl Encode for EdgeInsets {
    const ENCODING: Encoding = Encoding::Struct("UIEdgeInsets", &[f64::ENCODING; 4]);
}

unsafe fn superclass() -> &'static AnyClass {
    AnyClass::get(SUBCLASS)
        .and_then(|c| c.superclass())
        .expect("PNPinnedScrollView has a superclass")
}

/// The offset the page rests at, or None when the page is zoomed and may pan.
unsafe fn rest(this: &AnyObject) -> Option<NSPoint> {
    let zoom: f64 = msg_send![this, zoomScale];
    let min: f64 = msg_send![this, minimumZoomScale];
    if zoom > min + 0.001 {
        return None;
    }
    let inset: EdgeInsets = msg_send![this, adjustedContentInset];
    Some(NSPoint::new(-inset.left, -inset.top))
}

extern "C" fn set_offset(this: &AnyObject, _cmd: Sel, offset: NSPoint) {
    unsafe {
        let offset = rest(this).unwrap_or(offset);
        let _: () = msg_send![super(this, superclass()), setContentOffset: offset];
    }
}

extern "C" fn set_offset_animated(this: &AnyObject, _cmd: Sel, offset: NSPoint, animated: Bool) {
    unsafe {
        let offset = rest(this).unwrap_or(offset);
        let _: () = msg_send![super(this, superclass()), setContentOffset: offset, animated: animated];
    }
}

extern "C" fn set_bounds(this: &AnyObject, _cmd: Sel, bounds: NSRect) {
    unsafe {
        let mut bounds = bounds;
        if let Some(origin) = rest(this) {
            bounds.origin = origin;
        }
        let _: () = msg_send![super(this, superclass()), setBounds: bounds];
    }
}

/// The pinned subclass of `base`, made once.
unsafe fn subclass_of(base: &AnyClass) -> Option<&'static AnyClass> {
    if let Some(existing) = AnyClass::get(SUBCLASS) {
        return Some(existing);
    }
    let mut builder = ClassBuilder::new(SUBCLASS, base)?;
    builder.add_method(sel!(setContentOffset:), set_offset as extern "C" fn(_, _, _));
    builder.add_method(
        sel!(setContentOffset:animated:),
        set_offset_animated as extern "C" fn(_, _, _, _),
    );
    builder.add_method(sel!(setBounds:), set_bounds as extern "C" fn(_, _, _));
    Some(builder.register())
}

/// Moves the scroll view of `webview`, the WKWebView the window renders in,
/// to the pinned subclass.
pub unsafe fn pin(webview: *mut AnyObject) {
    if webview.is_null() {
        return;
    }
    let scroll: *mut AnyObject = msg_send![webview, scrollView];
    let Some(scroll) = scroll.as_ref() else { return };
    let class = scroll.class();
    if class.name() == SUBCLASS {
        return;
    }
    if let Some(sub) = subclass_of(class) {
        // A subclass made from another base would call the wrong superclass.
        if sub.superclass().map(|s| s.name()) != Some(class.name()) {
            return;
        }
        AnyObject::set_class(scroll, sub);
        if let Some(origin) = rest(scroll) {
            let _: () = msg_send![scroll, setContentOffset: origin];
        }
    }
}

/// Runs `pin` on a web view of the app.
pub fn pin_in<R: tauri::Runtime>(view: &tauri::Webview<R>) {
    let _ = view.with_webview(|webview| unsafe {
        pin(webview.inner() as *mut AnyObject);
    });
}
