"""生成应用图标（纯标准库，无第三方依赖）。

图形：金色渐变圆角方块 + 深色「中心枢纽 + 三个卫星节点」图案，
寓意「把散落在各处的免费模型聚合成一个入口」。
"""

import math
import os
import struct
import zlib

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
FNOS_DIR = os.path.join(os.path.dirname(OUT_DIR), "fnos")

GOLD_TOP = (246, 202, 34)
GOLD_BOTTOM = (214, 150, 8)
GLYPH = (23, 20, 11)


# ---------------------------------------------------------------- 基础绘制
def clamp(v, lo=0.0, hi=1.0):
    return lo if v < lo else hi if v > hi else v


def sdf_rounded_rect(px, py, cx, cy, hw, hh, r):
    qx = abs(px - cx) - (hw - r)
    qy = abs(py - cy) - (hh - r)
    ax, ay = max(qx, 0.0), max(qy, 0.0)
    return math.hypot(ax, ay) + min(max(qx, qy), 0.0) - r


def sdf_circle(px, py, cx, cy, r):
    return math.hypot(px - cx, py - cy) - r


def sdf_segment(px, py, ax, ay, bx, by, half):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    denom = vx * vx + vy * vy
    if denom == 0:
        return math.hypot(wx, wy) - half
    t = clamp((wx * vx + wy * vy) / denom)
    return math.hypot(wx - t * vx, wy - t * vy) - half


def coverage(d):
    """把有符号距离场转成 1px 抗锯齿覆盖率。"""
    return clamp(0.5 - d)


# ---------------------------------------------------------------- 主绘制
def render(size):
    n = float(size)
    cx, cy = n * 0.5, n * 0.5
    radius = n * 0.225
    hub_r = n * 0.135
    node_r = n * 0.072
    orbit = n * 0.285
    spoke = n * 0.040

    nodes = []
    for deg in (-90.0, 30.0, 150.0):
        rad = math.radians(deg)
        nodes.append((cx + orbit * math.cos(rad), cy + orbit * math.sin(rad)))

    rows = []
    for y in range(size):
        row = []
        fy = y + 0.5
        # 背景竖向渐变
        t = y / max(1, size - 1)
        bg = tuple(GOLD_TOP[i] + (GOLD_BOTTOM[i] - GOLD_TOP[i]) * t for i in range(3))
        for x in range(size):
            fx = x + 0.5
            bg_cov = coverage(sdf_rounded_rect(fx, fy, cx, cy, n / 2, n / 2, radius))
            if bg_cov <= 0.0:
                row.append((0, 0, 0, 0))
                continue
            d = sdf_circle(fx, fy, cx, cy, hub_r)
            for nx, ny in nodes:
                d = min(d, sdf_circle(fx, fy, nx, ny, node_r))
                d = min(d, sdf_segment(fx, fy, cx, cy, nx, ny, spoke))
            g_cov = coverage(d) * bg_cov
            if g_cov <= 0.0:
                rgb = bg
            else:
                rgb = tuple(
                    (bg[i] * (bg_cov - g_cov) + GLYPH[i] * g_cov) / bg_cov for i in range(3)
                )
            row.append((int(round(rgb[0])), int(round(rgb[1])), int(round(rgb[2])), int(round(bg_cov * 255))))
        rows.append(row)
    return rows


def write_png(path, rows, size):
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for px in rows[y]:
            raw.extend(px)
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(png)
    return len(png)


def main():
    targets = [
        (os.path.join(FNOS_DIR, "ui", "images", "icon-64.png"), 64),
        (os.path.join(FNOS_DIR, "ui", "images", "icon-256.png"), 256),
        (os.path.join(FNOS_DIR, "ICON.PNG"), 256),
        (os.path.join(FNOS_DIR, "ICON_256.PNG"), 256),
    ]
    cache = {}
    for path, size in targets:
        if size not in cache:
            cache[size] = render(size)
        written = write_png(path, cache[size], size)
        print(f"  已生成 {path}  ({size}x{size}, {written} 字节)")


if __name__ == "__main__":
    main()
