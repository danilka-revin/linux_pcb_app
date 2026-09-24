#!/usr/bin/env python3
"""Растровая иконка PSBees (PNG + ICO) из той же геометрии, что scripts/icon.svg (оса)."""
from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "build"
SIZE = 256


def hex_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def blend(dst: list[int], x: int, y: int, r: int, g: int, b: int, a: float) -> None:
    if a <= 0 or x < 0 or y < 0 or x >= SIZE or y >= SIZE:
        return
    i = (y * SIZE + x) * 4
    da = dst[i + 3] / 255.0
    na = a + da * (1 - a)
    if na <= 0:
        return
    dst[i] = int(round((r * a + dst[i] * da * (1 - a)) / na))
    dst[i + 1] = int(round((g * a + dst[i + 1] * da * (1 - a)) / na))
    dst[i + 2] = int(round((b * a + dst[i + 2] * da * (1 - a)) / na))
    dst[i + 3] = int(round(na * 255))


def dist_round_rect(px: float, py: float, x: float, y: float, w: float, h: float, rad: float) -> float:
    cx = x + w / 2
    cy = y + h / 2
    dx = abs(px - cx) - (w / 2 - rad)
    dy = abs(py - cy) - (h / 2 - rad)
    ox, oy = max(dx, 0.0), max(dy, 0.0)
    return math.hypot(ox, oy) + min(max(dx, dy), 0.0) - rad


def dist_seg(px: float, py: float, x1: float, y1: float, x2: float, y2: float) -> float:
    vx, vy = x2 - x1, y2 - y1
    l2 = vx * vx + vy * vy
    if l2 == 0:
        return math.hypot(px - x1, py - y1)
    t = max(0.0, min(1.0, ((px - x1) * vx + (py - y1) * vy) / l2))
    return math.hypot(px - (x1 + t * vx), py - (y1 + t * vy))


def cover(d: float, half: float) -> float:
    # антиалиас ~1px
    return max(0.0, min(1.0, half + 0.55 - d))


def in_triangle(px: float, py: float, x1: float, y1: float, x2: float, y2: float, x3: float, y3: float) -> bool:
    def sign(a: float, b: float, c: float, d: float, e: float, f: float) -> float:
        return (a - e) * (d - f) - (c - e) * (b - f)
    s1 = sign(px, py, x1, y1, x2, y2)
    s2 = sign(px, py, x2, y2, x3, y3)
    s3 = sign(px, py, x3, y3, x1, y1)
    neg = (s1 < 0) or (s2 < 0) or (s3 < 0)
    pos = (s1 > 0) or (s2 > 0) or (s3 > 0)
    return not (neg and pos)


def in_convex(
    px: float, py: float,
    x1: float, y1: float, x2: float, y2: float,
    x3: float, y3: float, x4: float, y4: float,
) -> bool:
    def cross(ax: float, ay: float, bx: float, by: float) -> float:
        return ax * by - ay * bx
    s1 = cross(x2 - x1, y2 - y1, px - x1, py - y1)
    s2 = cross(x3 - x2, y3 - y2, px - x2, py - y2)
    s3 = cross(x4 - x3, y4 - y3, px - x3, py - y3)
    s4 = cross(x1 - x4, y1 - y4, px - x4, py - y4)
    neg = (s1 < 0) or (s2 < 0) or (s3 < 0) or (s4 < 0)
    pos = (s1 > 0) or (s2 > 0) or (s3 > 0) or (s4 > 0)
    return not (neg and pos)


def raster() -> bytearray:
    pix = bytearray(SIZE * SIZE * 4)
    s = SIZE / 128.0  # svg units → px

    bg = hex_rgb("#141a24")
    st = hex_rgb("#2a3a52")
    wing = hex_rgb("#a7d3ff")
    wing2 = hex_rgb("#8fc3f0")
    leg = hex_rgb("#e6b93e")
    yellow = hex_rgb("#ffd53f")
    dark = hex_rgb("#1b2230")
    thorax = hex_rgb("#232c3d")

    for y in range(SIZE):
        for x in range(SIZE):
            px, py = (x + 0.5) / s, (y + 0.5) / s

            # карточка 8,8 → 120,120, радиус 20
            drr = dist_round_rect(px, py, 8, 8, 112, 112, 20)
            fill_a = cover(drr, 0)
            if fill_a:
                blend(pix, x, y, *bg, fill_a)
            ring = cover(abs(drr), 2.0)
            if ring:
                blend(pix, x, y, *st, ring)

            # усики
            for (ax1, ay1, ax2, ay2) in ((61, 34, 55, 21), (67, 34, 73, 21)):
                a = cover(dist_seg(px, py, ax1, ay1, ax2, ay2), 1.3)
                if a:
                    blend(pix, x, y, *yellow, a)

            # крылья — выпуклые четырёхугольники (расстояние до рёбер)
            wings = [
                ((58, 50), (26, 24), (14, 32), (50, 58), wing),
                ((70, 50), (102, 24), (114, 32), (78, 58), wing),
                ((54, 60), (30, 57), (24, 66), (50, 68), wing2),
                ((74, 60), (98, 57), (104, 66), (78, 68), wing2),
            ]
            for quad in wings:
                (x1, y1), (x2, y2), (x3, y3), (x4, y4), col = quad
                # внутри выпуклого четырёхугольника? (знаки векторных произведений одного знака)
                if in_convex(px, py, x1, y1, x2, y2, x3, y3, x4, y4):
                    blend(pix, x, y, *col, 0.9)

            # лапки
            for (lx1, ly1, lx2, ly2) in (
                (54, 56, 40, 62), (74, 56, 88, 62),
                (50, 64, 37, 72), (78, 64, 91, 72),
                (54, 78, 42, 88), (74, 78, 86, 88),
            ):
                a = cover(dist_seg(px, py, lx1, ly1, lx2, ly2), 1.1)
                if a:
                    blend(pix, x, y, *leg, a)

            # брюшко — эллипс 64,84 rx13 ry16
            de = ((px - 64) / 13) ** 2 + ((py - 84) / 16) ** 2
            if de <= 1:
                inside_belly = de <= 1
                # полосы
                stripe = False
                if 75 <= py <= 80:
                    stripe = 53 <= px <= 75
                elif 85 <= py <= 90:
                    stripe = 51 <= px <= 77
                elif 94 <= py <= 98:
                    stripe = 54 <= px <= 74
                if stripe:
                    blend(pix, x, y, *dark, 1.0)
                else:
                    a = cover(math.sqrt(de) - 1, 0)  # антиалиас края
                    if a:
                        blend(pix, x, y, *yellow, a)
                    else:
                        blend(pix, x, y, *yellow, 1.0)

            # жало — треугольник 62.5,99 65.5,99 64,107
            if in_triangle(px, py, 62.5, 99, 65.5, 99, 64, 107):
                blend(pix, x, y, *thorax, 1.0)

            # грудь — эллипс 64,58 rx11 ry9 (тёмный с жёлтой обводкой)
            dt = ((px - 64) / 11) ** 2 + ((py - 58) / 9) ** 2
            if dt <= 1:
                blend(pix, x, y, *thorax, 1.0)
            ring_t = abs(math.sqrt(dt) - 1)
            if ring_t < 0.06:
                blend(pix, x, y, *yellow, 0.6)

            # голова — круг 64,43 r9
            dh = math.hypot(px - 64, py - 43)
            if dh <= 9:
                blend(pix, x, y, *yellow, 1.0)
            # глаза
            for (ex, ey) in ((60.5, 40.5), (67.5, 40.5)):
                if math.hypot(px - ex, py - ey) <= 1.8:
                    blend(pix, x, y, *bg, 1.0)

    return pix


def png_chunk(tag: bytes, data: bytes) -> bytes:
    crc = zlib.crc32(tag + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)


def encode_png(rgba: bytearray, w: int, h: int) -> bytes:
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)
        raw.extend(rgba[y * stride : (y + 1) * stride])
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", ihdr) + png_chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + png_chunk(b"IEND", b"")


def write_png(path: Path, rgba: bytearray, w: int, h: int) -> bytes:
    data = encode_png(rgba, w, h)
    path.write_bytes(data)
    return data


def downscale(rgba: bytearray, src: int, dst: int) -> bytearray:
    out = bytearray(dst * dst * 4)
    f = src / dst
    for y in range(dst):
        for x in range(dst):
            r = g = b = a = 0.0
            x0, y0 = int(x * f), int(y * f)
            x1, y1 = int((x + 1) * f), int((y + 1) * f)
            n = max(1, (x1 - x0) * (y1 - y0))
            for yy in range(y0, y1):
                for xx in range(x0, x1):
                    i = (yy * src + xx) * 4
                    r += rgba[i]
                    g += rgba[i + 1]
                    b += rgba[i + 2]
                    a += rgba[i + 3]
            j = (y * dst + x) * 4
            out[j] = int(r / n)
            out[j + 1] = int(g / n)
            out[j + 2] = int(b / n)
            out[j + 3] = int(a / n)
    return out


def write_ico(path: Path, images: list[tuple[int, bytes]]) -> None:
    # ICO с PNG-кадрами (Vista+)
    count = len(images)
    offset = 6 + 16 * count
    entries = b""
    payload = b""
    for size, png in images:
        w = 0 if size >= 256 else size
        h = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(png), offset)
        payload += png
        offset += len(png)
    path.write_bytes(struct.pack("<HHH", 0, 1, count) + entries + payload)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    print("растеризация 256×256…")
    rgba = raster()
    png256 = write_png(OUT / "icon-256.png", rgba, 256, 256)
    # 512 — повторное ближайшее масштабирование с того же кадра (для electron)
    rgba512 = bytearray(512 * 512 * 4)
    for y in range(512):
        for x in range(512):
            i = ((y // 2) * 256 + (x // 2)) * 4
            j = (y * 512 + x) * 4
            rgba512[j : j + 4] = rgba[i : i + 4]
    write_png(OUT / "icon.png", rgba512, 512, 512)

    frames: list[tuple[int, bytes]] = []
    for sz in (256, 128, 64, 48, 32, 16):
        if sz == 256:
            png = png256
        else:
            small = downscale(rgba, 256, sz)
            png = write_png(OUT / f"icon-{sz}.png", small, sz, sz)
        frames.append((sz, png))
    write_ico(OUT / "icon.ico", frames)
    print("готово:", OUT / "icon.ico", OUT / "icon.png")


if __name__ == "__main__":
    main()
