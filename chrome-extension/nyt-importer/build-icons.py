#!/usr/bin/env python3
"""
Generate the extension icons (16, 48, 128 px) and write them as PNGs into
this directory. Re-run any time the design changes — the manifest only
references the file paths, not the bytes.

Design: bold Times Roman "C" (for Cooking) reversed out of a near-black
rounded square. Reads as classical serif typography at every size; the
rounded corners keep it from looking institutional.
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
SIZES  = [16, 48, 128]
LETTER = "C"
BG     = (15, 15, 15, 255)        # near-black, slightly off pure 000
FG     = (252, 250, 246, 255)     # cream-white, matches app palette

# How big the corner radius should be relative to the icon size. 14% reads
# as "rounded square" without looking like a button at 128 or a circle at 16.
RADIUS_PCT = 0.14

# How tall the letter should be relative to the icon size. Higher = bolder
# presence, but at 16x16 too high crowds the corners.
LETTER_PCT = 0.74

FONT_PATH = "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf"

def render(size):
    # Render at 4x then downsample for crisper anti-aliasing. PIL's text
    # rasterizer at 16px alone produces a fuzzy serif; the supersample
    # makes the curves cleaner.
    SCALE = 4
    big = size * SCALE
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle([0, 0, big - 1, big - 1],
                           radius=int(big * RADIUS_PCT),
                           fill=BG)
    font_size = int(big * LETTER_PCT)
    font = ImageFont.truetype(FONT_PATH, font_size)
    bbox = draw.textbbox((0, 0), LETTER, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    # Anchor by the actual ink bbox, not the metrics box, so the letter
    # is optically centered instead of metrically centered.
    x = (big - w) / 2 - bbox[0]
    y = (big - h) / 2 - bbox[1]
    draw.text((x, y), LETTER, font=font, fill=FG)
    return img.resize((size, size), Image.LANCZOS)

def main():
    for s in SIZES:
        out = os.path.join(OUT_DIR, f"icon-{s}.png")
        render(s).save(out)
        print(f"wrote {out}")

if __name__ == "__main__":
    main()
