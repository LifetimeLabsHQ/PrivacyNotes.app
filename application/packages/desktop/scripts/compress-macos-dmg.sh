#!/usr/bin/env bash
#
# compress-macos-dmg.sh - re-compress the built macOS DMG with LZMA (ULMO) instead of
# the zlib (UDZO) that tauri-bundler's vendored bundle_dmg.sh hard-codes.
#
# Why: the DMG is the whole macOS download, and Tauri exposes no setting for the image
# format (bundle_dmg.sh sets FORMAT="UDZO" itself). Measured at 0.737.1: the universal
# DMG goes from 27,656,667 to 25,999,972 bytes, 1.58 MB less, with the identical app
# inside (sha256 of the binary matched) and the same window layout. ULMO needs macOS
# 10.15 and our floor is 13.0, so no Mac that can open the app loses the ability to
# open the disk image. A person mounts the image once, so the slower LZMA decode is
# paid once at install and never again.
#
# This runs between the build and notarization, which is why `build:mac` calls it: the
# notarization ticket is stapled INTO the image, so converting afterwards would throw
# the ticket away. The script refuses to touch an image that is already stapled.
#
# The convert also drops the image's own code signature: with APPLE_SIGNING_IDENTITY
# set, tauri-bundler Developer ID-signs the DMG as well as the app, and `hdiutil convert`
# writes a new, unsigned file. So when the input carries a signature, the output is
# signed again with the same identity and a secure timestamp, as tauri-bundler did, and
# the notarize step gets the same kind of image it always got. An unsigned input (a
# local build with no identity) stays unsigned.
#
# Spec: docs/contrib/bundle-size.md (section 12, the macOS DMG image format)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DESKTOP/../.." && pwd)"

if [ "$#" -ge 1 ]; then
  DMG="$1"
else
  VER="$(grep -oE '[0-9]+\.[0-9]+\.[0-9]+' "$REPO_ROOT/packages/web/src/version.ts" | head -1 || true)"
  [ -n "$VER" ] || { echo "FATAL: could not read a version from packages/web/src/version.ts" >&2; exit 1; }
  DMG="$DESKTOP/src-tauri/target/universal-apple-darwin/release/bundle/dmg/PrivacyNotes_${VER}_universal.dmg"
fi

[ -f "$DMG" ] || { echo "FATAL: no DMG at $DMG" >&2; exit 1; }

FORMAT="$(hdiutil imageinfo "$DMG" -format 2>/dev/null || true)"
if [ "$FORMAT" = "ULMO" ]; then
  echo "==> $(basename "$DMG") is already ULMO, nothing to do"
  exit 0
fi

# A stapled ticket lives inside the image, so a convert would silently drop it.
if xcrun stapler validate "$DMG" >/dev/null 2>&1; then
  echo "FATAL: $DMG is already notarized and stapled." >&2
  echo "Convert before notarizing, or rebuild. See docs/internal/macos-ios-setup.md step 1c." >&2
  exit 1
fi

BEFORE="$(stat -f %z "$DMG")"
# The leaf certificate's name, empty for an unsigned image. Read before the convert,
# because the convert is what loses it.
SIGNER="$(codesign -dvv "$DMG" 2>&1 | sed -n 's/^Authority=//p' | head -1 || true)"
OUT="$(mktemp -d)/$(basename "$DMG")"

echo "==> Re-compressing $(basename "$DMG") from ${FORMAT:-unknown} to ULMO"
hdiutil convert "$DMG" -format ULMO -o "$OUT" -quiet
hdiutil verify "$OUT" >/dev/null 2>&1 || { echo "FATAL: the converted image does not verify" >&2; exit 1; }

AFTER="$(stat -f %z "$OUT")"
if [ "$AFTER" -ge "$BEFORE" ]; then
  echo "FATAL: ULMO came out no smaller ($AFTER vs $BEFORE bytes); keeping the original" >&2
  exit 1
fi

# Signed in the temporary folder under the final file name, because codesign takes the
# image's identifier from the name, and so a failure leaves the original in place.
if [ -n "$SIGNER" ]; then
  echo "==> Signing the converted image again as $SIGNER"
  codesign --force --sign "$SIGNER" --timestamp "$OUT"
  codesign --verify --strict "$OUT" || { echo "FATAL: the re-signed image does not verify; keeping the original" >&2; exit 1; }
else
  echo "    The input image is unsigned, so the converted one stays unsigned"
fi

mv "$OUT" "$DMG"
rmdir "$(dirname "$OUT")" 2>/dev/null || true

awk -v b="$BEFORE" -v a="$AFTER" 'BEGIN {
  printf "    %d -> %d bytes (%.2f MB -> %.2f MB, %.2f MB less)\n",
    b, a, b / 1048576, a / 1048576, (b - a) / 1048576
}'
