#!/usr/bin/env python3
"""Regenerate the founder hero/portrait assets from the source photograph.

Usage:
    python3 scripts/build-founder-photo.py [SOURCE_IMAGE]

Default SOURCE is the approved App Store screenshot; pass a true high-resolution
original when available (a full-bleed portrait needs the crop box adjusted or
removed). Outputs AVIF/WebP/JPEG at 834/640/460 widths plus a lossless PNG.
See docs/FOUNDER_PHOTO_SOURCE.md.
"""
import sys
from PIL import Image, ImageFilter

DEFAULT_SRC = "/Volumes/Super Storage/AutoClarityContentFactory/01_built_by_a_real_mechanic_2.png"
OUTDIR = "assets/img"
# Interior of the blue portrait frame in the App Store screenshot (source px).
# If SOURCE is already a bare portrait, set CROP = None.
CROP = (226, 746, 1060, 1795)
WIDTHS = [834, 640, 460]


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    im = Image.open(src).convert("RGB")
    crop = im.crop(CROP) if CROP else im
    # Conservative sharpen only; no facial/skin modification.
    crop = crop.filter(ImageFilter.UnsharpMask(radius=1.4, percent=60, threshold=2))
    crop.save(f"{OUTDIR}/faheb-founder-original.png", optimize=True)
    nw, nh = crop.size
    for w in WIDTHS:
        img = crop if w >= nw else crop.resize((w, round(w * nh / nw)), Image.LANCZOS)
        img.save(f"{OUTDIR}/faheb-founder-{w}.jpg", quality=86, optimize=True, progressive=True)
        img.save(f"{OUTDIR}/faheb-founder-{w}.webp", quality=82, method=6)
        img.save(f"{OUTDIR}/faheb-founder-{w}.avif", quality=64)
    print(f"Regenerated founder assets from {src} (native {nw}x{nh}).")


if __name__ == "__main__":
    main()
