"""Apex Pulse icons: a small 4-colour indexed PNG, stdlib only.

    python3 tools/make-icons.py
"""
import math
import struct
import zlib

PALETTE = [(8, 10, 18), (15, 20, 36), (34, 211, 238), (52, 211, 153)]  # bg, card, line, dot
BG, CARD, LINE, DOT = 0, 1, 2, 3


def in_rounded(x, y, x0, y0, x1, y1, r):
    if not (x0 <= x < x1 and y0 <= y < y1):
        return False
    dx = min(x - x0, x1 - 1 - x)
    dy = min(y - y0, y1 - 1 - y)
    return not (dx < r and dy < r and math.hypot(r - dx, r - dy) > r)


def seg_dist(px, py, x0, y0, x1, y1):
    vx, vy = x1 - x0, y1 - y0
    length = vx * vx + vy * vy
    t = 0.0 if length == 0 else max(0.0, min(1.0, ((px - x0) * vx + (py - y0) * vy) / length))
    return math.hypot(px - (x0 + vx * t), py - (y0 + vy * t))


def build(size, maskable):
    px = bytearray(size * size)  # palette indices, 0 = bg everywhere

    if maskable:
        pad = size * 0.20
        radius = size * 0.10
        scale = 0.60
    else:
        pad = size * 0.06
        radius = size * 0.20
        scale = 0.66

    for y in range(size):
        for x in range(size):
            if in_rounded(x, y, pad, pad, size - pad, size - pad, radius):
                px[y * size + x] = CARD

    cx = cy = size / 2.0
    w = size * scale
    h = size * scale * 0.9
    wave = [
        (-0.50, 0.00), (-0.28, 0.00), (-0.20, -0.16), (-0.10, 0.30),
        (0.02, -0.42), (0.14, 0.36), (0.24, -0.10), (0.32, 0.00), (0.50, 0.00)
    ]
    pts = [(cx + dx * w, cy + dy * h) for dx, dy in wave]
    thickness = max(2.0, size * 0.055) / 2.0
    dot_r = max(2.5, size * 0.062)

    for i in range(len(pts) - 1):
        x0, y0 = pts[i]
        x1, y1 = pts[i + 1]
        lo_x = max(0, int(min(x0, x1) - thickness - 2))
        hi_x = min(size, int(max(x0, x1) + thickness + 3))
        lo_y = max(0, int(min(y0, y1) - thickness - 2))
        hi_y = min(size, int(max(y0, y1) + thickness + 3))
        for y in range(lo_y, hi_y):
            for x in range(lo_x, hi_x):
                if seg_dist(x + 0.5, y + 0.5, x0, y0, x1, y1) <= thickness:
                    px[y * size + x] = LINE

    pex, pey = pts[4]
    for y in range(max(0, int(pey - dot_r - 2)), min(size, int(pey + dot_r + 3))):
        for x in range(max(0, int(pex - dot_r - 2)), min(size, int(pex + dot_r + 3))):
            if math.hypot(x + 0.5 - pex, y + 0.5 - pey) <= dot_r:
                px[y * size + x] = DOT

    return px


def write_png(path, size, indices):
    """8-bit -> 2-bit packed rows, colour type 3 (4 entry palette)."""
    rows = bytearray()
    for y in range(size):
        rows.append(0)  # filter: none
        row = indices[y * size:(y + 1) * size]
        for x in range(0, size, 4):
            chunk = row[x:x + 4]
            value = 0
            for i, entry in enumerate(chunk):
                value |= (entry & 0x03) << (6 - 2 * i)
            rows.append(value)

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    plte = b''.join(bytes(colour) for colour in PALETTE)
    out = (b'\x89PNG\r\n\x1a\n' +
           chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 2, 3, 0, 0, 0)) +
           chunk(b'PLTE', plte) +
           chunk(b'IDAT', zlib.compress(bytes(rows), 9)) +
           chunk(b'IEND', b''))
    with open(path, 'wb') as fh:
        fh.write(out)
    return len(out)


for name, dim, mask in (
    ('icons/icon-192.png', 192, False),
    ('icons/icon-512.png', 512, False),
    ('icons/icon-maskable-512.png', 512, True),
):
    print(name, write_png(name, dim, build(dim, mask)), 'bytes')
