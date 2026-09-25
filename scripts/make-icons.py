#!/usr/bin/env python3
"""Иконки PSBees из фирменного логотипа assets/logo.png (оса с молнией).

Генерирует всё, что нужно программам в разных средах:

  build/icon.png        512×512 — окно Electron (Windows)
  build/icon-256.png    256×256 — промежуточный кадр
  build/icon.ico        мультиразмерный ICO (256…16) для Windows
  public/logo.png       исходный логотип — шапка и диалог «О программе»
  public/favicon.png    64×64 — вкладка браузера
  scripts/icon.svg      SVG с вложенным PNG — .desktop / notify-send на Linux

Только стандартная библиотека Python (честный PNG-кодек), поэтому скрипт
работает на любом Ubuntu без Pillow. Запуск: python3 scripts/make-icons.py
"""
from __future__ import annotations

import base64
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "assets" / "logo.png"
OUT_BUILD = ROOT / "build"
OUT_PUBLIC = ROOT / "public"


# ---------------------------------------------------------------- PNG decode

def read_png(path: Path) -> tuple[list[list[list[float]]], int, int]:
    """Возвращает (буфер premultiplied RGBA, ширина, высота) для 8-bit RGB/RGBA."""
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"{path}: не PNG")
    pos = 8
    w = h = None
    bitdepth = colortype = None
    idat = b""
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        tag = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        if tag == b"IHDR":
            w, h, bitdepth, colortype = struct.unpack(">IIBB", chunk[:10])
        elif tag == b"IDAT":
            idat += chunk
        elif tag == b"IEND":
            break
        pos += 12 + length
    if w is None or h is None:
        raise SystemExit(f"{path}: нет IHDR")
    if bitdepth != 8 or colortype not in (2, 6):
        raise SystemExit(f"{path}: поддерживаются только 8-bit RGB/RGBA (got {bitdepth}/{colortype})")
    channels = 4 if colortype == 6 else 3
    raw = zlib.decompress(idat)
    stride = w * channels
    buf = [[0.0, 0.0, 0.0, 1.0] for _ in range(w * h)]
    prev = bytearray(stride)
    for y in range(h):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        if f == 1:  # sub
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif f == 2:  # up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:  # average
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif f == 4:  # paeth
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        for x in range(w):
            r, g, b = (line[x * channels + i] / 255.0 for i in range(3))
            a = line[x * channels + 3] / 255.0 if channels == 4 else 1.0
            buf[y * w + x] = [r * a, g * a, b * a, a]
        prev = line
    return buf, w, h


# ------------------------------------------------------------- PNG/ICO write

def premul_to_rgba(buf: list[list[float]], w: int, h: int) -> bytearray:
    out = bytearray(w * h * 4)
    for y in range(h):
        for x in range(w):
            r, g, b, a = buf[y * w + x]
            if a <= 0:
                continue
            out[(y * w + x) * 4] = int(round(min(1.0, r / a) * 255))
            out[(y * w + x) * 4 + 1] = int(round(min(1.0, g / a) * 255))
            out[(y * w + x) * 4 + 2] = int(round(min(1.0, b / a) * 255))
            out[(y * w + x) * 4 + 3] = int(round(a * 255))
    return out


def png_chunk(tag: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)


def encode_png(rgba: bytearray, w: int, h: int) -> bytes:
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)
        raw.extend(rgba[y * stride:(y + 1) * stride])
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", ihdr)
            + png_chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + png_chunk(b"IEND", b""))


def resize(buf: list[list[float]], sw: int, sh: int, dw: int, dh: int) -> list[list[float]]:
    """Bilinear в premultiplied-пространстве (без ореолов на прозрачных краях)."""
    out = [[0.0, 0.0, 0.0, 0.0] for _ in range(dw * dh)]
    fx, fy = sw / dw, sh / dh
    for y in range(dh):
        py = (y + 0.5) * fy - 0.5
        y0 = max(0, min(sh - 1, int(py)))
        y1 = max(0, min(sh - 1, y0 + 1))
        ty = min(max(py - y0, 0.0), 1.0)
        for x in range(dw):
            px = (x + 0.5) * fx - 0.5
            x0 = max(0, min(sw - 1, int(px)))
            x1 = max(0, min(sw - 1, x0 + 1))
            tx = min(max(px - x0, 0.0), 1.0)
            p00, p10 = buf[y0 * sw + x0], buf[y0 * sw + x1]
            p01, p11 = buf[y1 * sw + x0], buf[y1 * sw + x1]
            for c in range(4):
                top = p00[c] + (p10[c] - p00[c]) * tx
                bot = p01[c] + (p11[c] - p01[c]) * tx
                out[y * dw + x][c] = top + (bot - top) * ty
    return out


def write_ico(path: Path, frames: list[tuple[int, bytes]]) -> None:
    """ICO с PNG-кадрами (Vista+)."""
    count = len(frames)
    offset = 6 + 16 * count
    entries, payload = b"", b""
    for size, png in frames:
        wh = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", wh, wh, 0, 0, 1, 32, len(png), offset)
        payload += png
        offset += len(png)
    path.write_bytes(struct.pack("<HHH", 0, 1, count) + entries + payload)


# ----------------------------------------------------------------------- main

def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"нет исходного логотипа: {SRC}")
    buf, sw, sh = read_png(SRC)
    OUT_BUILD.mkdir(parents=True, exist_ok=True)
    OUT_PUBLIC.mkdir(parents=True, exist_ok=True)

    print(f"логотип: {SRC.name} {sw}×{sh}")

    # исходник — в public (шапка, «О программе»)
    src_rgba = premul_to_rgba(buf, sw, sh)
    (OUT_PUBLIC / "logo.png").write_bytes(encode_png(src_rgba, sw, sh))

    # 512 — Electron/Windows; 256 — кадр ICO и SVG
    big = resize(buf, sw, sh, 512, 512)
    (OUT_BUILD / "icon.png").write_bytes(encode_png(premul_to_rgba(big, 512, 512), 512, 512))
    mid = resize(buf, sw, sh, 256, 256)
    mid_png = encode_png(premul_to_rgba(mid, 256, 256), 256, 256)
    (OUT_BUILD / "icon-256.png").write_bytes(mid_png)

    # favicon 64
    fav = resize(buf, sw, sh, 64, 64)
    (OUT_PUBLIC / "favicon.png").write_bytes(encode_png(premul_to_rgba(fav, 64, 64), 64, 64))

    # ICO: 256, 128, 64, 48, 32, 16
    frames: list[tuple[int, bytes]] = [(256, mid_png)]
    for size in (128, 64, 48, 32, 16):
        s = resize(buf, sw, sh, size, size)
        frames.append((size, encode_png(premul_to_rgba(s, size, size), size, size)))
    write_ico(OUT_BUILD / "icon.ico", frames)

    # SVG для Linux (.desktop, notify-send): вложенное PNG
    b64 = base64.b64encode(mid_png).decode("ascii")
    href = f"data:image/png;base64,{b64}"
    svg = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<!-- Логотип PSBees (оса с молнией). Генерируется scripts/make-icons.py из assets/logo.png — "
        "не править вручную. -->\n"
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        'width="128" height="128" viewBox="0 0 128 128">\n'
        f'  <image width="128" height="128" href="{href}" xlink:href="{href}"></image>\n'
        "</svg>\n"
    )
    (ROOT / "scripts" / "icon.svg").write_text(svg, encoding="utf-8")

    print("готово:")
    for p in ("build/icon.png", "build/icon-256.png", "build/icon.ico",
              "public/logo.png", "public/favicon.png", "scripts/icon.svg"):
        f = ROOT / p
        print(f"  {p} ({f.stat().st_size // 1024} КБ)")


if __name__ == "__main__":
    main()
