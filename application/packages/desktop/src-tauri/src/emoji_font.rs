//! The AppImage draws every color emoji with its own bitmap font (#863).
//!
//! The AppImage bundles a WebKitGTK built on Ubuntu 22.04, against the
//! FreeType 2.11 headers, but it loads the host's FreeType. FreeType 2.13
//! changed the layout of its COLRv1 structs (`FT_ColorStop::stop_offset`
//! grew from 2 to 8 bytes, `FT_ColorStopIterator` gained a field), so on a
//! host with 2.13 or newer, Skia's COLRv1 code in that WebKit gets more bytes
//! back than it made room for. Gradients come out wrong (Ubuntu 24.04), or the
//! overwritten stop index trips `Assertion '__n < this->size()' failed` in
//! `colrv1_configure_skpaint` and kills the web process (Fedora 43 and newer,
//! whose Noto Color Emoji is COLRv1 only). CBDT bitmap glyphs never touch
//! those structs. So the release repack puts the CBDT Noto Color Emoji in the
//! AppImage, and this module points fontconfig at a config that adds it and
//! hides every other color font, for every page, canvas and GTK widget.
//! The .deb uses the host's own WebKitGTK and needs none of this.
//! Spec: docs/contrib/gotchas.md (Color emoji crash the Linux AppImage)

use std::path::{Path, PathBuf};

/// Where the repack step in `release-linux.yml` puts the font, under `$APPDIR`.
const BUNDLED_FONT: &str = "usr/share/privacynotes/emoji/NotoColorEmoji.ttf";
const FONT_FILE: &str = "NotoColorEmoji.ttf";
const CONF_FILE: &str = "fonts.conf";

/// Sets `FONTCONFIG_FILE` to the bundled emoji config when this is an AppImage
/// that carries the font. Must run before any thread or GTK call. A
/// `FONTCONFIG_FILE` the user set always wins. Any failure leaves fontconfig
/// as it was, so the app still starts.
pub fn use_bundled_emoji_font(identifier: &str) {
    if std::env::var_os("FONTCONFIG_FILE").is_some() {
        return;
    }
    let Some(appdir) = std::env::var_os("APPDIR") else {
        return;
    };
    let font = Path::new(&appdir).join(BUNDLED_FONT);
    if !font.is_file() {
        return;
    }
    let Some(cache) = cache_home() else {
        return;
    };
    match install(&font, &cache.join(identifier).join("emoji")) {
        Ok(conf) => std::env::set_var("FONTCONFIG_FILE", conf),
        Err(err) => eprintln!("could not set up the bundled emoji font: {err}"),
    }
}

/// `$XDG_CACHE_HOME`, or `~/.cache`.
fn cache_home() -> Option<PathBuf> {
    std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
}

/// Copies the font out of the AppImage into `dir` and writes the config next
/// to it. The copy keeps one path for every launch: the AppImage mounts at a
/// new `/tmp/.mount_*` each time, and fontconfig would write a new cache file
/// for each of those folders. Returns the config's path.
fn install(font: &Path, dir: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let target = dir.join(FONT_FILE);
    let size = std::fs::metadata(font)?.len();
    if std::fs::metadata(&target).map(|m| m.len()).ok() != Some(size) {
        // Copy, then rename: a half-written font is never under the real name.
        let part = dir.join(format!("{FONT_FILE}.part"));
        std::fs::copy(font, &part)?;
        std::fs::rename(&part, &target)?;
    }
    let dir_str = dir.to_str().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "cache path is not UTF-8")
    })?;
    let conf = dir.join(CONF_FILE);
    let text = fonts_conf(dir_str);
    if std::fs::read_to_string(&conf).ok().as_deref() != Some(text.as_str()) {
        std::fs::write(&conf, text)?;
    }
    Ok(conf)
}

/// The host's own config, plus the bundled font, minus every other color
/// font. Fontconfig's `color` covers COLRv0, COLRv1, CBDT, sbix and SVG
/// fonts; the bundled one is accepted by its file name, and an accept beats
/// a reject.
fn fonts_conf(dir: &str) -> String {
    let dir = xml_escape(dir);
    format!(
        r#"<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<!-- Written by PrivacyNotes at every launch of the AppImage (GitHub #863). -->
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>{dir}</dir>
  <selectfont>
    <acceptfont>
      <pattern><patelt name="file"><string>{dir}/{FONT_FILE}</string></patelt></pattern>
    </acceptfont>
    <rejectfont>
      <pattern><patelt name="color"><bool>true</bool></patelt></pattern>
    </rejectfont>
  </selectfont>
</fontconfig>
"#
    )
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conf_names_the_font_and_rejects_other_color_fonts() {
        let conf = fonts_conf("/home/a&b/.cache/x/emoji");
        assert!(conf.contains("<include ignore_missing=\"yes\">/etc/fonts/fonts.conf</include>"));
        assert!(conf.contains("<dir>/home/a&amp;b/.cache/x/emoji</dir>"));
        assert!(conf.contains("<string>/home/a&amp;b/.cache/x/emoji/NotoColorEmoji.ttf</string>"));
        assert!(conf.contains("<patelt name=\"color\"><bool>true</bool></patelt>"));
    }

    #[test]
    fn install_copies_once_and_writes_the_conf() {
        let base = std::env::temp_dir().join(format!("pn-emoji-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("src.ttf");
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(&src, b"font bytes").unwrap();
        let dir = base.join("cache/emoji");

        let conf = install(&src, &dir).unwrap();
        assert_eq!(std::fs::read(dir.join(FONT_FILE)).unwrap(), b"font bytes");
        assert!(std::fs::read_to_string(&conf).unwrap().contains(dir.to_str().unwrap()));
        assert!(!dir.join(format!("{FONT_FILE}.part")).exists());

        // A new font of another size replaces the copy.
        std::fs::write(&src, b"a newer font").unwrap();
        install(&src, &dir).unwrap();
        assert_eq!(std::fs::read(dir.join(FONT_FILE)).unwrap(), b"a newer font");
        std::fs::remove_dir_all(&base).unwrap();
    }
}
