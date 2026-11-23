#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make-icons-from-source.py · 由设计稿源图生成 PWA 图标（v4.28.12）

和 make-icons.js 的分工：
  · make-icons.js   —— v4.27.0 的手绘生成器（圆角矩形 + 三角形屋顶），
                       没有源图时的兜底，纯 Node 零依赖。
  · 本脚本          —— v4.28.12 换品牌图标后启用：从一张 1024×1024 的设计稿
                       裁出圆角方块，按四种用途分别输出。

为什么要裁、为什么不直接 resize：
  设计稿是「米色底 + 一块稍亮的圆角方块」，四周留了约 7% 的背景。
  直接 resize 会让图标里再套一个小方块（套娃感），而且 iOS 加圆角后
  边缘会出现两圈轮廓。裁到方块外接矩形 + 自己做圆角蒙版，才是干净的图标。

四种用途（不能合并）：
  icon-192.png            any，浏览器标签 / 桌面 Chrome 安装
  icon-512.png            any，高清 / 分享卡片
  apple-touch-icon-180    iOS 主屏：**满幅不透明**，iOS 自己加圆角，
                          预圆角会在四角留出白边，所以这一张四角填底色
  icon-maskable-512       Android 自适应：满幅不透明 + 内容缩进安全区
                          （系统会按 80% 安全圆裁剪，超出部分可能被切掉）

用法：
  python scripts/make-icons-from-source.py [源图路径]
  默认读 scripts/app-icon-source.jpg，输出到 public/icons/。
  依赖 Pillow（只在改图标时用一次，不参与运行时、不参与 CI）。
"""
import os
import struct
import sys
import zlib

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, 'public', 'icons')
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'app-icon-source.jpg')

# 源图里圆角方块的外接矩形（1024×1024 设计稿实测值）
CROP = (73, 74, 949, 950)
# 方块本身的圆角半径 / 边长，实测约 22%
RADIUS_RATIO = 0.225
SS = 4  # 圆角蒙版的超采样倍数，抗锯齿


def rounded_mask(size, radius_ratio=RADIUS_RATIO):
    """生成一张 size×size 的圆角蒙版（L 模式，内部 255 / 外部 0）。"""
    w, h = size
    big = Image.new('L', (w * SS, h * SS), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        [0, 0, w * SS - 1, h * SS - 1],
        radius=int(min(w, h) * SS * radius_ratio),
        fill=255,
    )
    return big.resize((w, h), Image.LANCZOS)


def corner_color(img):
    """取四角均值当底色 —— 用来填 apple-touch / maskable 的四角与边距。"""
    w, h = img.size
    pts = [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3)]
    px = img.load()
    r = sum(px[p][0] for p in pts) // 4
    g = sum(px[p][1] for p in pts) // 4
    b = sum(px[p][2] for p in pts) // 4
    return (r, g, b)


def png_bytes(im):
    """手写 PNG 编码（RGBA / 8bit / 每行 filter=0）。

    为什么不用 im.save('...png')：Pillow 会自适应挑 filter（Paeth / Sub 等），
    而 `_verify/docker.test.js` 里有一个零依赖的 PNG 校验器，它只认 filter 0
    （见「apple-touch-icon 满幅不透明」那条断言）。用默认编码会读不出像素，
    断言报「可能换了非 filter=0 的编码器」。这里自己拼 chunk，输出完全可预期。
    """
    im = im.convert('RGBA')
    w, h = im.size
    px = im.tobytes()
    stride = w * 4
    raw = b''.join(b'\x00' + px[y * stride:(y + 1) * stride] for y in range(h))

    def chunk(tag, data):
        body = tag + data
        return (struct.pack('>I', len(data)) + body
                + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF))

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)   # 6 = RGBA
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', zlib.compress(raw, 9))
            + chunk(b'IEND', b''))


def main():
    if not os.path.exists(SRC):
        sys.exit('找不到源图：%s' % SRC)

    src = Image.open(SRC).convert('RGB')
    if src.size != (1024, 1024):
        print('⚠ 源图不是 1024×1024（实际 %dx%d），裁剪框可能不匹配' % src.size)

    base = corner_color(src)
    square = src.crop(CROP)                       # 只剩圆角方块，876×876

    # ① any 图标：透明四角，铺满画布
    def any_icon(size):
        im = square.resize((size, size), Image.LANCZOS).convert('RGBA')
        im.putalpha(rounded_mask((size, size)))
        return im

    # ② 不透明图标：底色铺满 + 方块铺满（给 iOS / maskable 用）
    def opaque_icon(size, inner_ratio=1.0):
        im = Image.new('RGBA', (size, size), base + (255,))
        if inner_ratio == 1.0:
            art = square.resize((size, size), Image.LANCZOS)
            im.paste(art, (0, 0))
        else:
            inner = int(round(size * inner_ratio))
            art = square.resize((inner, inner), Image.LANCZOS).convert('RGBA')
            art.putalpha(rounded_mask((inner, inner)))
            off = (size - inner) // 2
            im.paste(art, (off, off), art)
        return im

    jobs = [
        ('icon-192.png', any_icon(192)),
        ('icon-512.png', any_icon(512)),
        ('apple-touch-icon-180.png', opaque_icon(180)),
        # 安全区：Android 按 80% 直径的圆裁剪，内容缩到 78% 最稳
        ('icon-maskable-512.png', opaque_icon(512, 0.78)),
    ]

    os.makedirs(OUT, exist_ok=True)
    for name, im in jobs:
        path = os.path.join(OUT, name)
        with open(path, 'wb') as fp:
            fp.write(png_bytes(im))
        print('✓ %-26s %dx%d  %.1f KB' % (name, im.size[0], im.size[1],
                                          os.path.getsize(path) / 1024))

    print('底色采样 %s（maskable / apple-touch 的边距用它铺满）' % (base,))


if __name__ == '__main__':
    main()
