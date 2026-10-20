#!/usr/bin/env python3
"""Generate Kuling's PNG icons: sun and wind streaks on a blue rounded square.

Pure stdlib (zlib + struct) so there is no Pillow dependency.
"""
import math
import os
import struct
import zlib

BG = (27, 110, 194)
SUN = (255, 210, 63)
WIND = (241, 245, 249)

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "app", "icons")


def _rounded_square_alpha(x, y, size):
    """Anti-aliased mask for a rounded square covering the whole canvas."""
    radius = size * 0.22
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    dist = math.hypot(x - cx, y - cy)
    return max(0.0, min(1.0, radius - dist + 0.5))


def _blend(base, top, alpha):
    return tuple(round(b + (t - b) * alpha) for b, t in zip(base, top))


def _pixel(x, y, size):
    """Colour for one pixel: blue tile, sun top-right, three wind streaks of different lengths."""
    colour = BG
    sx, sy, sun_r = size * 0.66, size * 0.34, size * 0.17
    dist = math.hypot(x - sx, y - sy)
    if dist < sun_r + 0.5:
        colour = _blend(colour, SUN, max(0.0, min(1.0, sun_r - dist + 0.5)))

    half = size * 0.035
    for start, stop, row in ((0.16, 0.70, 0.56), (0.26, 0.84, 0.68), (0.16, 0.58, 0.80)):
        cy = size * row
        cx = min(max(x, size * start), size * stop)
        edge = half - math.hypot(x - cx, y - cy)
        if edge > -0.5:
            colour = _blend(colour, WIND, max(0.0, min(1.0, edge + 0.5)))
    return colour


def render(size):
    rows = []
    for y in range(size):
        row = bytearray([0])  # PNG filter type 0 per scanline
        for x in range(size):
            r, g, b = _pixel(x + 0.5, y + 0.5, size)
            a = round(255 * _rounded_square_alpha(x + 0.5, y + 0.5, size))
            row += bytes((r, g, b, a))
        rows.append(bytes(row))
    return b"".join(rows)


def write_png(path, size):
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">2I5B", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(render(size), 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(png)
    return len(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (56, 112):
        path = os.path.join(OUT_DIR, "icon%dx%d.png" % (size, size))
        written = write_png(path, size)
        print("%s (%d bytes)" % (os.path.normpath(path), written))


if __name__ == "__main__":
    main()
