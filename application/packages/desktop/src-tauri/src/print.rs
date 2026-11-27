//! Native print for the Apple webviews: macOS and iOS.
//!
//! WKWebView does not implement JavaScript's `window.print()`. The call returns
//! without opening anything and without an error, so the hidden-iframe print
//! path in `packages/web/src/export.ts` silently does nothing in the macOS and
//! iOS apps - while working in every browser and in the Windows build, whose
//! WebView2 does implement it.
//!
//! A webview also cannot print a frame inside itself, so the note document is
//! loaded into a throwaway WKWebView of our own and handed to the OS print UI:
//! `NSPrintOperation` on macOS, `UIPrintInteractionController` on iOS. Both take
//! the document exactly as `export.ts` built it - same markup, same `@media
//! print` CSS, same inlined images - so a printed note looks the same on every
//! platform.
//!
//! Bound with raw `msg_send!` like `biometric.rs`, so no new package enters
//! Cargo.lock: WebKit, AppKit and UIKit are all linked already by tao/wry.
//!
//! The throwaway webview is parented at the bottom of the app's own view
//! hierarchy rather than left detached. WebKit throttles a web view that belongs
//! to no window, and the print path needs a laid-out document; the app's opaque
//! root view covers it, so it is never visible. It is torn down as soon as the
//! print UI is finished with it, which on both platforms means a completion
//! callback: `printOperationDidRun:success:contextInfo:` on macOS, the print
//! controller's completion block on iOS.
//!
//! Both platforms therefore run the print UI asynchronously, and on macOS that
//! is a correctness requirement rather than a style. A WKWebView draws its pages
//! from replies sent by the web content process, so a call that blocks the main
//! thread until the user is done never receives them and every page comes out
//! empty - while the panel's own preview, drawn before the thread is blocked,
//! shows the document in full. `runOperationModalForWindow:` keeps the main
//! thread running, which is what puts ink on the page.

use crate::PrintPageNumbers;
use block2::RcBlock;
use objc2::encode::{Encode, Encoding};
use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
use objc2::sel;
#[cfg(target_os = "macos")]
use objc2::{AnyThread, DefinedClass};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
use std::cell::{Cell, RefCell};

const FOOTER_INSET_X: f64 = 56.7; // 20mm in points, matching export.ts @page margins
const FOOTER_FONT_SIZE: f64 = 9.0;
const FOOTER_GRAY: f64 = 0.42; // #6a6a6a, matching export.ts

thread_local! {
    static ACTIVE_PAGE_NUMBERS: RefCell<Option<PrintPageNumbers>> = const { RefCell::new(None) };
}

fn format_page_label(pn: &PrintPageNumbers, page: isize, total: isize) -> String {
    if pn.format == "number" || total <= 0 {
        page.to_string()
    } else {
        format!("{page} / {total}")
    }
}

fn alignment_for(pn: &PrintPageNumbers) -> isize {
    match pn.placement.as_str() {
        "left" => 0,  // NSTextAlignmentLeft
        "right" => 2, // NSTextAlignmentRight
        _ => 1,       // NSTextAlignmentCenter
    }
}

/// Build the `{ NSFont, NSColor, NSParagraphStyle }` dictionary for drawing
/// the page-number footer string on AppKit (macOS) or UIKit (iOS).
unsafe fn footer_attributes(pn: &PrintPageNumbers) -> Option<Retained<AnyObject>> {
    #[cfg(target_os = "macos")]
    let font_class = AnyClass::get(c"NSFont")?;
    #[cfg(target_os = "ios")]
    let font_class = AnyClass::get(c"UIFont")?;

    #[cfg(target_os = "macos")]
    let color_class = AnyClass::get(c"NSColor")?;
    #[cfg(target_os = "ios")]
    let color_class = AnyClass::get(c"UIColor")?;

    let style_class = AnyClass::get(c"NSMutableParagraphStyle")?;
    let dict_class = AnyClass::get(c"NSMutableDictionary")?;

    let font: Retained<AnyObject> = msg_send![font_class, systemFontOfSize: FOOTER_FONT_SIZE];
    #[cfg(target_os = "macos")]
    let color: Retained<AnyObject> = msg_send![
        color_class,
        colorWithCalibratedWhite: FOOTER_GRAY,
        alpha: 1.0f64
    ];
    #[cfg(target_os = "ios")]
    let color: Retained<AnyObject> = msg_send![
        color_class,
        colorWithWhite: FOOTER_GRAY,
        alpha: 1.0f64
    ];
    let style: Retained<AnyObject> = msg_send![style_class, new];
    let _: () = msg_send![&*style, setAlignment: alignment_for(pn)];

    let dict: Retained<AnyObject> = msg_send![dict_class, dictionaryWithCapacity: 3usize];
    let k_font = NSString::from_str("NSFont");
    let k_color = NSString::from_str("NSColor");
    let k_para = NSString::from_str("NSParagraphStyle");
    let _: () = msg_send![&*dict, setObject: &*font, forKey: &*k_font];
    let _: () = msg_send![&*dict, setObject: &*color, forKey: &*k_color];
    let _: () = msg_send![&*dict, setObject: &*style, forKey: &*k_para];
    Some(dict)
}

/// A4 at 96dpi. Only the initial layout: both print paths re-lay the document
/// out for whatever paper the user picks in the print UI.
const PAGE_WIDTH: f64 = 794.0;
const PAGE_HEIGHT: f64 = 1123.0;

/// How long to let the document settle before printing. Every image is already
/// inlined as a data URI by the caller, so this normally passes on the first
/// tick; the ceiling is only there so a document that never finishes loading
/// still reaches the print UI instead of hanging silently.
const POLL_SECONDS: f64 = 0.1;
const POLL_TICKS: u32 = 50;

/// Loads `html` into a throwaway webview and presents the OS print UI for it.
///
/// Returns as soon as the work is queued on the main thread - the print UI
/// outlives the call, and the user's choices inside it are their own business.
/// Every UI step below has to be on the main thread: AppKit and UIKit both
/// require it, and WKWebView is main-thread-only in the first place.
pub fn print(
    app: &tauri::AppHandle,
    html: String,
    job_name: String,
    page_numbers: Option<PrintPageNumbers>,
) -> Result<(), String> {
    app.run_on_main_thread(move || {
        let Some(webview) = build_webview() else {
            eprintln!("print: WKWebView is unavailable");
            return;
        };
        attach(&webview);

        let html = NSString::from_str(&html);
        unsafe {
            let _: () = msg_send![
                &*webview,
                loadHTMLString: &*html,
                baseURL: std::ptr::null_mut::<AnyObject>(),
            ];
        }
        print_when_loaded(webview, job_name, page_numbers);
    })
    .map_err(|e| e.to_string())
}

/// `[[WKWebView alloc] init]`, then a frame: the zero frame a bare `init` leaves
/// behind lays nothing out, and an unlaid document prints blank pages.
fn build_webview() -> Option<Retained<AnyObject>> {
    let class = AnyClass::get(c"WKWebView")?;
    unsafe {
        let webview: Retained<AnyObject> = msg_send![class, new];
        let frame = NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(PAGE_WIDTH, PAGE_HEIGHT),
        );
        let _: () = msg_send![&*webview, setFrame: frame];
        Some(webview)
    }
}

/// Polls `isLoading` until the document settles, then prints. A repeating
/// `NSTimer` rather than a navigation delegate: the block-based timer keeps
/// every reference on the main thread, where they all have to live anyway, and
/// a block carries the captured webview that a delegate class would need an
/// ivar for.
fn print_when_loaded(
    webview: Retained<AnyObject>,
    job_name: String,
    page_numbers: Option<PrintPageNumbers>,
) {
    let Some(class) = AnyClass::get(c"NSTimer") else {
        return;
    };
    let ticks_left = Cell::new(POLL_TICKS);

    let tick = RcBlock::new(move |timer: *mut AnyObject| {
        let loading: Bool = unsafe { msg_send![&*webview, isLoading] };
        if loading.as_bool() && ticks_left.get() > 0 {
            ticks_left.set(ticks_left.get() - 1);
            return;
        }

        // Take owned copies onto the stack BEFORE invalidating: invalidating
        // releases the timer's copy of this very block, which is the only one
        // left, so everything the closure captured is freed mid-call.
        let webview = webview.clone();
        let job_name = job_name.clone();
        let page_numbers = page_numbers.clone();
        unsafe {
            let _: () = msg_send![timer, invalidate];
        }
        present(webview, &job_name, page_numbers);
    });

    unsafe {
        let _: Retained<AnyObject> = msg_send![
            class,
            scheduledTimerWithTimeInterval: POLL_SECONDS,
            repeats: Bool::YES,
            block: &*tick,
        ];
    }
}

/// Parents the webview under the app's own root view, at the bottom of the
/// z-order so the opaque UI hides it.
fn attach(webview: &AnyObject) {
    let Some(host) = host_view() else {
        return;
    };
    unsafe {
        #[cfg(target_os = "macos")]
        {
            // NSWindowBelow: under every sibling, i.e. behind the whole app.
            let _: () = msg_send![
                &*host,
                addSubview: webview,
                positioned: -1isize,
                relativeTo: std::ptr::null_mut::<AnyObject>(),
            ];
        }
        #[cfg(target_os = "ios")]
        {
            let _: () = msg_send![&*host, insertSubview: webview, atIndex: 0isize];
        }
    }
}

/// The app's root view: the key window's content view on macOS, the key window
/// itself on iOS. `keyWindow` is null while the app is in the background or
/// (on iOS) under some scene setups, hence the fallbacks.
#[cfg(target_os = "macos")]
fn host_view() -> Option<Retained<AnyObject>> {
    let window = host_window()?;
    unsafe {
        let view: *mut AnyObject = msg_send![&*window, contentView];
        Retained::retain(view)
    }
}

/// The window the print sheet hangs off.
#[cfg(target_os = "macos")]
fn host_window() -> Option<Retained<AnyObject>> {
    let class = AnyClass::get(c"NSApplication")?;
    unsafe {
        let app: Retained<AnyObject> = msg_send![class, sharedApplication];
        let mut window: *mut AnyObject = msg_send![&*app, keyWindow];
        if window.is_null() {
            window = msg_send![&*app, mainWindow];
        }
        Retained::retain(window)
    }
}

#[cfg(target_os = "ios")]
fn host_view() -> Option<Retained<AnyObject>> {
    let class = AnyClass::get(c"UIApplication")?;
    unsafe {
        let app: Retained<AnyObject> = msg_send![class, sharedApplication];
        let mut window: *mut AnyObject = msg_send![&*app, keyWindow];
        if window.is_null() {
            let windows: *mut AnyObject = msg_send![&*app, windows];
            if !windows.is_null() {
                window = msg_send![windows, firstObject];
            }
        }
        Retained::retain(window)
    }
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct PrintRange {
    location: usize,
    length: usize,
}

#[cfg(target_os = "macos")]
unsafe impl Encode for PrintRange {
    const ENCODING: Encoding = Encoding::Struct("_NSRange", &[usize::ENCODING, usize::ENCODING]);
}

#[cfg(target_os = "macos")]
const BORDER_SUBCLASS: &std::ffi::CStr = c"PNPrintBorderView";

#[cfg(target_os = "macos")]
extern "C" fn draw_page_border(_this: &AnyObject, _cmd: Sel, border_size: NSSize) {
    let pn = ACTIVE_PAGE_NUMBERS.with(|cell| cell.borrow().clone());
    let Some(pn) = pn else {
        return;
    };
    unsafe {
        let Some(op_class) = AnyClass::get(c"NSPrintOperation") else {
            return;
        };
        let cur: *mut AnyObject = msg_send![op_class, currentOperation];
        if cur.is_null() {
            return;
        }
        let page: isize = msg_send![cur, currentPage];
        let range: PrintRange = msg_send![cur, pageRange];
        let total = range.length as isize;
        let label = NSString::from_str(&format_page_label(&pn, page, total));
        let Some(attrs) = footer_attributes(&pn) else {
            return;
        };
        // AppKit invokes drawPageBorderWithSize: in unflipped page coordinates
        // (origin at bottom-left), so y = 24 pt places the footer cleanly
        // inside the 20mm bottom page margin.
        let rect = NSRect::new(
            NSPoint::new(FOOTER_INSET_X, 24.0),
            NSSize::new((border_size.width - FOOTER_INSET_X * 2.0).max(40.0), 16.0),
        );
        let _: () = msg_send![&*label, drawInRect: rect, withAttributes: &*attrs];
    }
}

#[cfg(target_os = "macos")]
unsafe fn attach_border_footer(view: *mut AnyObject) {
    if view.is_null() {
        return;
    }
    let subclass = if let Some(existing) = AnyClass::get(BORDER_SUBCLASS) {
        existing
    } else {
        let base: &AnyClass = (*view).class();
        let Some(mut builder) = ClassBuilder::new(BORDER_SUBCLASS, base) else {
            return;
        };
        builder.add_method(
            sel!(drawPageBorderWithSize:),
            draw_page_border as extern "C" fn(_, _, _),
        );
        builder.register()
    };
    let _: *const AnyClass = objc2::ffi::object_setClass(view, subclass);
}

/// macOS: the standard print panel, as a sheet on the app's window. Its "PDF"
/// menu is the "Save as PDF" half of what the menu item promises, so one panel
/// covers both.
#[cfg(target_os = "macos")]
fn present(webview: Retained<AnyObject>, job_name: &str, page_numbers: Option<PrintPageNumbers>) {
    let Some(window) = print_window(&webview) else {
        eprintln!("print: the app has no window to hang the print sheet on");
        return;
    };
    unsafe {
        // printOperationWithPrintInfo: is macOS 11+. Below that there is no
        // supported way to print a WKWebView, and nothing to fall back to.
        let responds: Bool = msg_send![&*webview, respondsToSelector: sel!(printOperationWithPrintInfo:)];
        if !responds.as_bool() {
            eprintln!("print: this macOS is too old to print a webview");
            return;
        }
        let Some(class) = AnyClass::get(c"NSPrintInfo") else {
            return;
        };
        let shared: Retained<AnyObject> = msg_send![class, sharedPrintInfo];
        let info: Retained<AnyObject> = msg_send![&*shared, copy];
        // The document draws its own 20mm page padding (or @page margins when
        // page numbers are on), so AppKit's one-inch default margins would
        // stack on top of it and crush the text into the middle of the page.
        let _: () = msg_send![&*info, setTopMargin: 0.0f64];
        let _: () = msg_send![&*info, setRightMargin: 0.0f64];
        let _: () = msg_send![&*info, setBottomMargin: 0.0f64];
        let _: () = msg_send![&*info, setLeftMargin: 0.0f64];

        if let Some(num_class) = AnyClass::get(c"NSNumber") {
            let dict: Retained<AnyObject> = msg_send![&*info, dictionary];
            let key = NSString::from_str("NSPrintHeaderAndFooter");
            let flag: Retained<AnyObject> = msg_send![num_class, numberWithBool: Bool::new(page_numbers.is_some())];
            let _: () = msg_send![&*dict, setObject: &*flag, forKey: &*key];
        }

        let operation: Retained<AnyObject> = msg_send![&*webview, printOperationWithPrintInfo: &*info];
        let title = NSString::from_str(job_name);
        let _: () = msg_send![&*operation, setJobTitle: &*title];

        ACTIVE_PAGE_NUMBERS.with(|cell| {
            *cell.borrow_mut() = page_numbers.clone();
        });
        if page_numbers.is_some() {
            let print_view: *mut AnyObject = msg_send![&*operation, view];
            attach_border_footer(print_view);
        }

        let done = PrintDone::new(webview);
        remember(&done);
        let _: () = msg_send![
            &*operation,
            runOperationModalForWindow: &*window,
            delegate: &*done,
            didRunSelector: sel!(printOperationDidRun:success:contextInfo:),
            contextInfo: std::ptr::null_mut::<std::ffi::c_void>(),
        ];
    }
}

/// The window to attach the sheet to: the one the webview was parented into,
/// and the app's own if parenting found nowhere to put it.
#[cfg(target_os = "macos")]
fn print_window(webview: &AnyObject) -> Option<Retained<AnyObject>> {
    let attached: *mut AnyObject = unsafe { msg_send![webview, window] };
    unsafe { Retained::retain(attached) }.or_else(host_window)
}

#[cfg(target_os = "macos")]
objc2::define_class!(
    // SAFETY: NSObject has no subclassing requirements, and PrintDone
    // implements no Drop of its own.
    #[unsafe(super(objc2_foundation::NSObject))]
    #[ivars = RefCell<Option<Retained<AnyObject>>>]
    /// Unparents the throwaway webview once the print UI is finished with it.
    ///
    /// AppKit does not retain a `didRunSelector` target, so every instance is
    /// held in `PENDING` until its callback has run. It is not dropped inside
    /// its own callback: that would free the object mid-method. The next print
    /// sweeps the finished ones instead, so at most one spent instance is alive
    /// at a time, and it holds nothing but itself - the note's rendered copy is
    /// released the moment the callback takes it out.
    struct PrintDone;

    impl PrintDone {
        #[unsafe(method(printOperationDidRun:success:contextInfo:))]
        fn did_run(
            &self,
            _operation: *mut AnyObject,
            _success: Bool,
            _context: *mut std::ffi::c_void,
        ) {
            ACTIVE_PAGE_NUMBERS.with(|cell| {
                *cell.borrow_mut() = None;
            });
            if let Some(webview) = self.ivars().borrow_mut().take() {
                unsafe {
                    let _: () = msg_send![&*webview, removeFromSuperview];
                }
            }
        }
    }
);

#[cfg(target_os = "macos")]
impl PrintDone {
    fn new(webview: Retained<AnyObject>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(RefCell::new(Some(webview)));
        unsafe { msg_send![super(this), init] }
    }

    /// True while this instance still owns a webview, i.e. before its callback.
    fn pending(&self) -> bool {
        self.ivars().borrow().is_some()
    }
}

#[cfg(target_os = "macos")]
thread_local! {
    static PENDING: RefCell<Vec<Retained<PrintDone>>> = const { RefCell::new(Vec::new()) };
}

#[cfg(target_os = "macos")]
fn remember(done: &Retained<PrintDone>) {
    PENDING.with(|pending| {
        let mut pending = pending.borrow_mut();
        pending.retain(|d| d.pending());
        pending.push(done.clone());
    });
}

#[cfg(target_os = "ios")]
#[repr(C)]
#[derive(Clone, Copy)]
struct IosEdgeInsets {
    top: f64,
    left: f64,
    bottom: f64,
    right: f64,
}

#[cfg(target_os = "ios")]
unsafe impl Encode for IosEdgeInsets {
    const ENCODING: Encoding = Encoding::Struct("UIEdgeInsets", &[f64::ENCODING; 4]);
}

#[cfg(target_os = "ios")]
const IOS_RENDERER_CLASS: &std::ffi::CStr = c"PNPageNumberRenderer";

#[cfg(target_os = "ios")]
extern "C" fn draw_ios_footer(this: &AnyObject, _cmd: Sel, page_index: isize, footer_rect: NSRect) {
    let pn = ACTIVE_PAGE_NUMBERS.with(|cell| cell.borrow().clone());
    let Some(pn) = pn else {
        return;
    };
    unsafe {
        let total: isize = msg_send![this, numberOfPages];
        let label = NSString::from_str(&format_page_label(&pn, page_index + 1, total));
        let Some(attrs) = footer_attributes(&pn) else {
            return;
        };
        let rect = NSRect::new(
            NSPoint::new(footer_rect.origin.x + FOOTER_INSET_X, footer_rect.origin.y + 8.0),
            NSSize::new((footer_rect.size.width - FOOTER_INSET_X * 2.0).max(40.0), 18.0),
        );
        let _: () = msg_send![&*label, drawInRect: rect, withAttributes: &*attrs];
    }
}

#[cfg(target_os = "ios")]
unsafe fn build_ios_renderer(formatter: &AnyObject) -> Option<Retained<AnyObject>> {
    let cls = if let Some(existing) = AnyClass::get(IOS_RENDERER_CLASS) {
        existing
    } else {
        let base = AnyClass::get(c"UIPrintPageRenderer")?;
        let mut builder = ClassBuilder::new(IOS_RENDERER_CLASS, base)?;
        builder.add_method(
            sel!(drawFooterForPageAtIndex:inRect:),
            draw_ios_footer as extern "C" fn(_, _, _, _),
        );
        builder.register()
    };
    // iOS UIViewPrintFormatter ignores CSS @page margins, so when page numbers
    // move the 20mm margin off .page onto @page we supply the matching insets
    // natively here (18mm top, 20mm sides, plus 44pt footer band).
    let insets = IosEdgeInsets {
        top: 51.0,
        left: FOOTER_INSET_X,
        bottom: 12.0,
        right: FOOTER_INSET_X,
    };
    let _: () = msg_send![formatter, setPerPageContentInsets: insets];
    let renderer: Retained<AnyObject> = msg_send![cls, new];
    let _: () = msg_send![&*renderer, setHeaderHeight: 0.0f64];
    let _: () = msg_send![&*renderer, setFooterHeight: 44.0f64];
    let _: () = msg_send![
        &*renderer,
        addPrintFormatter: formatter,
        startingAtPageAtIndex: 0isize
    ];
    Some(renderer)
}

/// iOS: the system print sheet. Presentation is asynchronous, so the webview has
/// to stay alive and parented until the completion block says otherwise - it is
/// what the print formatter renders from.
#[cfg(target_os = "ios")]
fn present(webview: Retained<AnyObject>, job_name: &str, page_numbers: Option<PrintPageNumbers>) {
    unsafe {
        let Some(class) = AnyClass::get(c"UIPrintInteractionController") else {
            return;
        };
        let available: Bool = msg_send![class, isPrintingAvailable];
        if !available.as_bool() {
            eprintln!("print: printing is unavailable on this device");
            let _: () = msg_send![&*webview, removeFromSuperview];
            return;
        }
        let controller: Retained<AnyObject> = msg_send![class, sharedPrintController];

        if let Some(info_class) = AnyClass::get(c"UIPrintInfo") {
            let info: Retained<AnyObject> = msg_send![info_class, printInfo];
            let name = NSString::from_str(job_name);
            let _: () = msg_send![&*info, setJobName: &*name];
            let _: () = msg_send![&*controller, setPrintInfo: &*info];
        }

        let formatter: Retained<AnyObject> = msg_send![&*webview, viewPrintFormatter];
        ACTIVE_PAGE_NUMBERS.with(|cell| {
            *cell.borrow_mut() = page_numbers.clone();
        });
        if page_numbers.is_some() {
            if let Some(renderer) = build_ios_renderer(&formatter) {
                let _: () = msg_send![&*controller, setPrintPageRenderer: &*renderer];
            } else {
                let _: () = msg_send![&*controller, setPrintFormatter: &*formatter];
            }
        } else {
            let _: () = msg_send![&*controller, setPrintFormatter: &*formatter];
        }

        // Resolved before the block below takes ownership of the webview: the
        // iPad popover hangs off the same view the webview was parented to.
        let host: *mut AnyObject = msg_send![&*webview, superview];

        // Owns the webview until the sheet is gone, then unparents it. Dropping
        // the block drops the last reference and deallocates it.
        let done = RcBlock::new(
            move |_controller: *mut AnyObject, _completed: Bool, _error: *mut AnyObject| {
                ACTIVE_PAGE_NUMBERS.with(|cell| {
                    *cell.borrow_mut() = None;
                });
                let _: () = msg_send![&*webview, removeFromSuperview];
            },
        );

        // iPad has no modal print sheet: presentAnimated: raises there, and the
        // popover variant is the only supported presentation.
        if is_pad() {
            if host.is_null() {
                return;
            }
            let bounds: NSRect = msg_send![host, bounds];
            let anchor = NSRect::new(
                NSPoint::new(bounds.size.width / 2.0, bounds.size.height / 2.0),
                NSSize::new(1.0, 1.0),
            );
            let _: Bool = msg_send![
                &*controller,
                presentFromRect: anchor,
                inView: host,
                animated: Bool::YES,
                completionHandler: &*done,
            ];
        } else {
            let _: Bool = msg_send![
                &*controller,
                presentAnimated: Bool::YES,
                completionHandler: &*done,
            ];
        }
    }
}

/// `UIUserInterfaceIdiomPad`.
#[cfg(target_os = "ios")]
fn is_pad() -> bool {
    let Some(class) = AnyClass::get(c"UIDevice") else {
        return false;
    };
    unsafe {
        let device: Retained<AnyObject> = msg_send![class, currentDevice];
        let idiom: isize = msg_send![&*device, userInterfaceIdiom];
        idiom == 1
    }
}
