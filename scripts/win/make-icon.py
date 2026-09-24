#!/usr/bin/env python3
"""Растровая иконка ЛайАут (PNG + ICO) из той же геометрии, что scripts/icon.svg."""
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


def raster() -> bytearray:
    pix = bytearray(SIZE * SIZE * 4)
    s = SIZE / 128.0  # svg units → px

    bg = hex_rgb("#141a24")
    st = hex_rgb("#2a3a52")
    blue = hex_rgb("#3d8bfd")
    red = hex_rgb("#e5484d")
    gold = hex_rgb("#ffb648")
    green = hex_rgb("#41d98d")

    for y in range(SIZE):
        for x in range(SIZE):
            px, py = (x + 0.5) / s, (y + 0.5) / s

            drr = dist_round_rect(px, py, 4, 4, 120, 120, 18)
            fill_a = cover(drr, 0)
            if fill_a:
                blend(pix, x, y, *bg, fill_a)
            stroke_a = cover(abs(drr) - 0, 2.0)  # stroke-width 4 → half=2
            # только кольцо обводки, не заливка
            ring = cover(abs(drr), 2.0)
            if ring:
                blend(pix, x, y, *st, ring)

            # синяя трасса M24 96 L56 64 L56 40 H72
            d1 = dist_seg(px, py, 24, 96, 56, 64)
            d2 = dist_seg(px, py, 56, 64, 56, 40)
            d3 = dist_seg(px, py, 56, 40, 72, 40)
            a = max(cover(d1, 4), cover(d2, 4), cover(d3, 4))
            if a:
                blend(pix, x, y, *blue, a)

            # красная M48 104 L88 64
            a = cover(dist_seg(px, py, 48, 104, 88, 64), 4)
            if a:
                blend(pix, x, y, *red, a)

            # кольца площадок
            for cx, cy in ((24, 96), (104, 40)):
                dc = abs(math.hypot(px - cx, py - cy) - 10)
                a = cover(dc, 3)
                if a:
                    blend(pix, x, y, *gold, a)

            # зелёная залитая площадка
            dc = math.hypot(px - 104, py - 104) - 7
            a = cover(dc, 0)
            if a:
                blend(pix, x, y, *green, a)

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
