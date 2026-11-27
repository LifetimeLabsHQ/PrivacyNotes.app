#!/usr/bin/env python3
"""Build the alternative desktop app icon assets for Settings > System (#977).

Generates three target-shaped assets per non-default preset under
`packages/desktop/src-tauri/icons/alt/`:
  mac/<id>.png   512x512 pre-rounded macOS squircle on Apple's 824px grid
                 with soft drop shadow (for NSApplication + NSWorkspace).
  tile/<id>.png  256x256 rounded tile matching the Windows/Linux default icon
                 (for window icons, tray icons, and Linux .desktop files).
  win/<id>.ico   Multi-size Windows ICO (16..256) for Start Menu and Desktop
                 shortcut icons.

The default preset is not generated here because selecting "default" restores
the bundle's own icon (Assets.car / icon.icns / exe,0 / privacynotes).
"""
import math
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent.parent
ICONS = HERE / "src-tauri" / "icons"
ALT = ICONS / "alt"
GLYPH_SVG = HERE.parent / "web" / "icon" / "app-icon-glyph.svg"

# Shared geometry from make-app-icons.py so every preset aligns with the
# default icon in the Dock, taskbar, and app launcher.
DARK_GROUND = (0x18, 0x18, 0x1A)
DARK_FOLD = (0x2E, 0x2E, 0x33)
FOLD_START = 0.5
TILE_INSET = 16
TILE_RADIUS = 0.22
MAC_BODY = (100, 824)
MAC_RADIUS = 185
SS = 2


def rasterize_glyph(tmp: Path) -> Image.Image:
    out = tmp / "raster"
    subprocess.run(
        ["npx", "tauri", "icon", str(GLYPH_SVG), "--png", "1024", "-o", str(out)],
        cwd=HERE,
        check=True,
        stdout=subprocess.DEVNULL,
    )
    return Image.open(out / "1024x1024.png").convert("RGBA")


def rounded_mask(box: tuple[int, int, int, int], radius: int, size: int = 1024) -> Image.Image:
    big = Image.new("L", (size * SS, size * SS), 0)
    ImageDraw.Draw(big).rounded_rectangle([v * SS for v in box], radius=radius * SS, fill=255)
    return big.resize((size, size), Image.LANCZOS)


def fold_polygon(side: int, color: tuple[int, int, int, int]) -> Image.Image:
    c = side * SS
    k = int(round(side * FOLD_START * SS))
    big = Image.new("RGBA", (c, c), (0, 0, 0, 0))
    ImageDraw.Draw(big).polygon([(k, 0), (c, 0), (c, c - k)], fill=color)
    return big.resize((side, side), Image.LANCZOS)


def vertical_gradient(side: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    im = Image.new("RGBA", (1, side))
    px = im.load()
    for y in range(side):
        t = y / max(side - 1, 1)
        px[0, y] = (
            int(round(top[0] + (bottom[0] - top[0]) * t)),
            int(round(top[1] + (bottom[1] - top[1]) * t)),
            int(round(top[2] + (bottom[2] - top[2]) * t)),
            255,
        )
    return im.resize((side, side), Image.BILINEAR)


def diagonal_gradient(side: int, c0: tuple[int, int, int], c1: tuple[int, int, int], c2: tuple[int, int, int]) -> Image.Image:
    small = 128
    im = Image.new("RGBA", (small, small))
    px = im.load()
    for y in range(small):
        for x in range(small):
            t = (x + y) / (2 * (small - 1))
            if t <= 0.5:
                u = t * 2
                a, b = c0, c1
            else:
                u = (t - 0.5) * 2
                a, b = c1, c2
            px[x, y] = (
                int(round(a[0] + (b[0] - a[0]) * u)),
                int(round(a[1] + (b[1] - a[1]) * u)),
                int(round(a[2] + (b[2] - a[2]) * u)),
                255,
            )
    return im.resize((side, side), Image.BICUBIC)


def draw_padlock(
    im: Image.Image,
    lock_fill: tuple[int, int, int, int],
    badge_fill: tuple[int, int, int, int],
    check_stroke: tuple[int, int, int, int],
) -> None:
    """Draw the brand padlock + check mark cleanly on a 1024x1024 square canvas."""
    s = im.size[0]
    scale = s / 100.0
    # Matches privacynotes-avatar.svg transform: translate(-4.9419 -27.7035) scale(1.56975)
    tx, ty, sc = -4.9419, -27.7035, 1.56975

    def pt(x: float, y: float) -> tuple[float, float]:
        return ((x * sc + tx) * scale * SS, (y * sc + ty) * scale * SS)

    big = Image.new("RGBA", (s * SS, s * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)

    # Shackle: outer arch from x=26..44, y=28..44, inner cutout x=31..39, y=33..44
    # Build via two rounded rectangles + cut so curves stay smooth.
    shackle = Image.new("L", (s * SS, s * SS), 0)
    sd = ImageDraw.Draw(shackle)
    x0, y0 = pt(26, 28)
    x1, y1 = pt(44, 48)
    sd.rounded_rectangle([x0, y0, x1, y1], radius=(x1 - x0) / 2, fill=255)
    ix0, iy0 = pt(31, 33)
    ix1, iy1 = pt(39, 48)
    sd.rounded_rectangle([ix0, iy0, ix1, iy1], radius=(ix1 - ix0) / 2, fill=0)
    _, cut_y = pt(0, 44.5)
    sd.rectangle([0, cut_y, s * SS, s * SS], fill=0)
    big.paste(lock_fill, (0, 0), shackle)

    # Lock body
    bx0, by0 = pt(20, 44)
    bx1, by1 = pt(50, 64)
    d.rounded_rectangle([bx0, by0, bx1, by1], radius=2.0 * sc * scale * SS, fill=lock_fill)

    # Check badge
    cx, cy = pt(48, 60)
    r = 11.0 * sc * scale * SS
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=badge_fill)

    # Check mark stroke
    p1, p2, p3 = pt(42, 61), pt(46, 64), pt(54, 56)
    w = max(2, int(round(3.0 * sc * scale * SS)))
    d.line([p1, p2, p3], fill=check_stroke, width=w, joint="curve")
    # Rounded end caps
    cap_r = w / 2.0
    for px, py in (p1, p2, p3):
        d.ellipse([px - cap_r, py - cap_r, px + cap_r, py + cap_r], fill=check_stroke)

    im.alpha_composite(big.resize((s, s), Image.LANCZOS))


def make_dark(glyph: Image.Image) -> Image.Image:
    im = Image.new("RGBA", (1024, 1024), DARK_GROUND + (255,))
    im.alpha_composite(fold_polygon(1024, DARK_FOLD + (255,)))
    im.alpha_composite(glyph)
    return im


def make_tinted() -> Image.Image:
    im = vertical_gradient(1024, (0x33, 0x36, 0x3D), (0x1E, 0x20, 0x25))
    im.alpha_composite(fold_polygon(1024, (0x4B, 0x50, 0x5A, 255)))
    draw_padlock(
        im,
        lock_fill=(0xC7, 0xCC, 0xD6, 255),
        badge_fill=(0x8C, 0x93, 0xA0, 255),
        check_stroke=(0x1E, 0x20, 0x25, 255),
    )
    return im


def make_liquid() -> Image.Image:
    im = diagonal_gradient(1024, (0xE8, 0xEE, 0xF8), (0xCB, 0xD6, 0xE8), (0xA8, 0xB8, 0xD4))
    im.alpha_composite(fold_polygon(1024, (0xFF, 0xFF, 0xFF, 107)))
    # Top glass highlight band
    shine = Image.new("RGBA", (1, 1024))
    spx = shine.load()
    for y in range(1024):
        t = y / 1023.0
        if t < 0.45:
            a = int(round((0.72 + (0.08 - 0.72) * (t / 0.45)) * 255))
        else:
            a = int(round((0.08 + (0.32 - 0.08) * ((t - 0.45) / 0.55)) * 255))
        spx[0, y] = (255, 255, 255, a)
    im.alpha_composite(shine.resize((1024, 1024), Image.BILINEAR))
    draw_padlock(
        im,
        lock_fill=(0xFF, 0xFF, 0xFF, 236),
        badge_fill=(0x64, 0x74, 0x8B, 148),
        check_stroke=(0xFF, 0xFF, 0xFF, 255),
    )
    return im


def make_plain_page() -> Image.Image:
    s = 1024 * SS
    big = Image.new("RGBA", (s, s), (0xF4, 0xF1, 0xE8, 255))
    d = ImageDraw.Draw(big)
    k = s / 100.0
    d.rectangle([0, 0, s, 20 * k], fill=(0xE3, 0xDE, 0xC9, 255))
    lines = [
        (36, 70, 5.5, (0x8F, 0x8A, 0x7C, 255)),
        (52, 82, 5.0, (0xB6, 0xB1, 0xA2, 255)),
        (67, 76, 5.0, (0xB6, 0xB1, 0xA2, 255)),
        (82, 54, 5.0, (0xC7, 0xC2, 0xB4, 255)),
    ]
    for y, x2, h, color in lines:
        r = (h * k) / 2.0
        d.rounded_rectangle([18 * k, y * k - r, x2 * k, y * k + r], radius=r, fill=color)
    return big.resize((1024, 1024), Image.LANCZOS)


def make_calculator() -> Image.Image:
    s = 1024 * SS
    big = Image.new("RGBA", (s, s), (0x2A, 0x2C, 0x32, 255))
    d = ImageDraw.Draw(big)
    k = s / 100.0
    d.rounded_rectangle([14 * k, 14 * k, 86 * k, 36 * k], radius=6 * k, fill=(0x3D, 0x41, 0x4A, 255))
    for cy in (52, 76):
        for cx, color in (
            (25, (0x4B, 0x50, 0x5B, 255)),
            (50, (0x4B, 0x50, 0x5B, 255)),
            (75, (0xD9, 0x77, 0x06, 255)),
        ):
            r = 9.5 * k
            d.ellipse([(cx - 9.5) * k, (cy - 9.5) * k, (cx + 9.5) * k, (cy + 9.5) * k], fill=color)
    return big.resize((1024, 1024), Image.LANCZOS)


def make_journal() -> Image.Image:
    s = 1024 * SS
    big = Image.new("RGBA", (s, s), (0x4B, 0x6B, 0x5C, 255))
    d = ImageDraw.Draw(big)
    k = s / 100.0
    d.rectangle([0, 0, 22 * k, s], fill=(0x36, 0x50, 0x44, 255))
    d.rounded_rectangle([34 * k, 28 * k, 78 * k, 42 * k], radius=4 * k, fill=(0xE6, 0xEF, 0xEA, 232))
    d.rounded_rectangle([34 * k, 50 * k, 62 * k, 56 * k], radius=3 * k, fill=(0xE6, 0xEF, 0xEA, 118))
    return big.resize((1024, 1024), Image.LANCZOS)


def make_archive() -> Image.Image:
    s = 1024 * SS
    big = Image.new("RGBA", (s, s), (0xE7, 0xE5, 0xE0, 255))
    d = ImageDraw.Draw(big)
    k = s / 100.0
    # Folder back tab
    d.rounded_rectangle([18 * k, 26 * k, 52 * k, 52 * k], radius=7 * k, fill=(0x78, 0x71, 0x6C, 255))
    d.rounded_rectangle([18 * k, 34 * k, 82 * k, 78 * k], radius=7 * k, fill=(0x78, 0x71, 0x6C, 255))
    # Front flap
    d.rounded_rectangle([18 * k, 40 * k, 82 * k, 78 * k], radius=7 * k, fill=(0x57, 0x53, 0x4E, 255))
    return big.resize((1024, 1024), Image.LANCZOS)


def make_minimal_fold() -> Image.Image:
    im = Image.new("RGBA", (1024, 1024), (0x33, 0x41, 0x55, 255))
    im.alpha_composite(fold_polygon(1024, (0x64, 0x74, 0x8B, 255)))
    return im


NOTE_BOY_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="1024" height="1024">
<defs>
  <linearGradient id="body" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#F2F0E9"/>
    <stop offset="55%" stop-color="#DDD9D0"/>
    <stop offset="100%" stop-color="#B9B4A8"/>
  </linearGradient>
  <linearGradient id="bezel" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#7D8088"/>
    <stop offset="100%" stop-color="#585B63"/>
  </linearGradient>
  <linearGradient id="lcd" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#89A22E"/>
    <stop offset="55%" stop-color="#9CB43E"/>
    <stop offset="100%" stop-color="#849C2B"/>
  </linearGradient>
  <radialGradient id="btn" cx="35%" cy="30%" r="70%">
    <stop offset="0%" stop-color="#DC337D"/>
    <stop offset="55%" stop-color="#A81B5A"/>
    <stop offset="100%" stop-color="#6E0F3A"/>
  </radialGradient>
  <linearGradient id="dpad" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#3C3F47"/>
    <stop offset="50%" stop-color="#222429"/>
    <stop offset="100%" stop-color="#111215"/>
  </linearGradient>
</defs>
<rect width="100" height="100" fill="url(#body)"/>
<path d="M93 0 H100 V100 H0 V93 H87 Q93 93 93 87 Z" fill="#9E998D" fill-opacity="0.65"/>
<path d="M0 0 H100 V5 H8 Q5 5 5 8 V100 H0 Z" fill="#FFFFFF" fill-opacity="0.62"/>
<rect x="11" y="10" width="76" height="46" rx="6" fill="url(#bezel)"/>
<rect x="11" y="10" width="76" height="46" rx="6" fill="none" stroke="#45474F" stroke-width="1.5"/>
<line x1="16" y1="14" x2="82" y2="14" stroke="#A61D5C" stroke-width="2"/>
<line x1="16" y1="16.8" x2="82" y2="16.8" stroke="#2B3472" stroke-width="1.8"/>
<circle cx="17" cy="33" r="3" fill="#EF4444" fill-opacity="0.35"/>
<circle cx="17" cy="33" r="2.1" fill="#F43F5E"/>
<rect x="23" y="19.5" width="54" height="31.5" rx="2.5" fill="url(#lcd)"/>
<path d="M23 22 H77 M24.5 19.5 V51" stroke="#5D7319" stroke-width="2.6" fill="none"/>
<polygon points="23,19.5 48,19.5 32,51 23,51" fill="#FFFFFF" fill-opacity="0.09"/>
<rect x="30" y="27" width="25" height="3.4" rx="1" fill="#253D11"/>
<rect x="30" y="33.8" width="36" height="3.4" rx="1" fill="#35531A"/>
<rect x="30" y="40.6" width="29" height="3.4" rx="1" fill="#35531A"/>
<g transform="translate(1.8 2.2)" opacity="0.32">
  <rect x="20" y="61.5" width="9" height="24.5" rx="2.2" fill="#000000"/>
  <rect x="12" y="69.5" width="25" height="9" rx="2.2" fill="#000000"/>
</g>
<rect x="20" y="61.5" width="9" height="24.5" rx="2.2" fill="url(#dpad)"/>
<rect x="12" y="69.5" width="25" height="9" rx="2.2" fill="url(#dpad)"/>
<circle cx="24.5" cy="74" r="2.7" fill="#18191D"/>
<circle cx="62" cy="80.8" r="7.8" fill="#000000" fill-opacity="0.28"/>
<circle cx="79" cy="71.8" r="7.8" fill="#000000" fill-opacity="0.28"/>
<circle cx="60.5" cy="79" r="7.8" fill="url(#btn)"/>
<circle cx="77.5" cy="70" r="7.8" fill="url(#btn)"/>
<ellipse cx="58.2" cy="76.2" rx="2.4" ry="1.4" transform="rotate(-30 58.2 76.2)" fill="#FFFFFF" fill-opacity="0.35"/>
<ellipse cx="75.2" cy="67.2" rx="2.4" ry="1.4" transform="rotate(-30 75.2 67.2)" fill="#FFFFFF" fill-opacity="0.35"/>
</svg>"""


def make_note_boy(tmp: Path) -> Image.Image:
    """Rasterize the 3D molded DMG-01 SVG via Tauri CLI so gradients and shading match LogoIcon."""
    svg_path = tmp / "note-boy.svg"
    svg_path.write_text(NOTE_BOY_SVG)
    out = tmp / "raster-note-boy"
    subprocess.run(
        ["npx", "tauri", "icon", str(svg_path), "--png", "1024", "-o", str(out)],
        cwd=HERE,
        check=True,
        stdout=subprocess.DEVNULL,
    )
    return Image.open(out / "1024x1024.png").convert("RGBA")


def add_rim(im: Image.Image, box: tuple[int, int, int, int], radius: int, color: tuple[int, int, int, int], width: int) -> None:
    s = im.size[0]
    big = Image.new("RGBA", (s * SS, s * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    d.rounded_rectangle(
        [box[0] * SS + width * SS // 2, box[1] * SS + width * SS // 2, box[2] * SS - width * SS // 2, box[3] * SS - width * SS // 2],
        radius=max(1, radius * SS - width * SS // 2),
        outline=color,
        width=width * SS,
    )
    im.alpha_composite(big.resize((s, s), Image.LANCZOS))


def fit_rounded(square: Image.Image, box: tuple[int, int, int, int], radius: int, rim: tuple[tuple[int, int, int, int], int] | None = None) -> Image.Image:
    w = box[2] - box[0]
    resized = square.resize((w, w), Image.LANCZOS)
    out = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    out.alpha_composite(resized, (box[0], box[1]))
    if rim is not None:
        add_rim(out, box, radius, rim[0], rim[1])
    out.putalpha(rounded_mask(box, radius))
    return out


def make_mac_icon(square: Image.Image, rim: tuple[tuple[int, int, int, int], int] | None = None) -> Image.Image:
    o, s = MAC_BODY
    box = (o, o, o + s, o + s)
    shadow_a = rounded_mask(box, MAC_RADIUS).filter(ImageFilter.GaussianBlur(24))
    shadow_a = ImageChops.offset(shadow_a, 0, 10).point(lambda v: v * 30 // 100)
    mac = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    mac.putalpha(shadow_a)
    mac.alpha_composite(fit_rounded(square, box, MAC_RADIUS, rim=rim))
    return mac.resize((512, 512), Image.LANCZOS)


def make_tile_icon(square: Image.Image, rim: tuple[tuple[int, int, int, int], int] | None = None) -> Image.Image:
    side = 1024 - 2 * TILE_INSET
    box = (TILE_INSET, TILE_INSET, 1024 - TILE_INSET, 1024 - TILE_INSET)
    radius = round(side * TILE_RADIUS)
    return fit_rounded(square, box, radius, rim=rim)


def main() -> None:
    if not GLYPH_SVG.exists():
        sys.exit(f"missing {GLYPH_SVG}")
    for sub in ("mac", "tile", "win"):
        (ALT / sub).mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        glyph = rasterize_glyph(tmp)
        presets: list[tuple[str, Image.Image, tuple[tuple[int, int, int, int], int] | None]] = [
            ("dark", make_dark(glyph), None),
            ("tinted", make_tinted(), None),
            ("liquid", make_liquid(), ((255, 255, 255, 215), 24)),
            ("note-boy", make_note_boy(tmp), ((0x85, 0x80, 0x75, 166), 16)),
            ("plain-page", make_plain_page(), ((0xD5, 0xD0, 0xC1, 255), 14)),
            ("calculator", make_calculator(), None),
            ("journal", make_journal(), None),
            ("archive", make_archive(), None),
            ("minimal-fold", make_minimal_fold(), None),
        ]

        for preset_id, square, rim in presets:
            mac = make_mac_icon(square, rim=rim)
            mac.save(ALT / "mac" / f"{preset_id}.png", optimize=True)

            tile_1024 = make_tile_icon(square, rim=rim)
            tile_1024.resize((256, 256), Image.LANCZOS).save(ALT / "tile" / f"{preset_id}.png", optimize=True)
            tile_1024.save(
                ALT / "win" / f"{preset_id}.ico",
                format="ICO",
                sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
            )

    total = sum(p.stat().st_size for p in ALT.rglob("*") if p.is_file())
    print(f"Built {len(presets)} alternative icon sets in {ALT} ({total / 1024:.1f} KB total)")


if __name__ == "__main__":
    main()
