#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════
   make-icons.js · 生成 PWA 图标（v4.27.0 P0）
   ---------------------------------------------------------------------
   为什么手写 PNG 编码器，而不是引 sharp / canvas / imagemagick：
     1. 本项目「零依赖、零构建」是一条硬约束（Dockerfile 只装 tzdata，
        镜像 ~50MB）。为了 4 张静态图拉一个 30MB 的原生库不划算，
        而且构建机（Windows / macOS / 群晖）装它经常失败。
     2. 图形是纯几何（圆角矩形 + 三角形屋顶 + 门），不需要字体渲染 ——
        原来用 emoji 🏠 做图标，正是因为它不需要字体；但 emoji 在不同
        系统渲染差异大，且 iOS 不认 SVG 的 apple-touch-icon。
     3. 生成物进仓库（public/icons/*.png），这个脚本只在**改设计时**跑一次，
        不参与启动、不参与 CI。node scripts/make-icons.js 即可重放。

   输出（4 份，各自用途不同，别合并）：
     icon-192.png           Android / 桌面 Chrome 安装图标（any）
     icon-512.png           同上，高清；应用商店 / 分享卡片
     icon-maskable-512.png  Android 自适应图标：满幅不透明 + 内容缩进安全区
     apple-touch-icon-180  iOS 主屏：**满幅直角且完全不透明**
                            （iOS 会把透明区域填成黑色，这是最经典的坑）

   用法：node scripts/make-icons.js [--quiet]
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

/* ── 1. PNG 编码（RGBA8 / 无隔行 / filter=0）─────────────────────────
   只实现「写」这一半：IHDR + 单个 IDAT + IEND。够用且可核对，
   不引 pngjs 之类的小依赖。 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: truecolor + alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── 2. 几何：全部在 0..1 归一化坐标系里算，与像素尺寸无关 ──────────
   有符号距离场（SDF）的好处：抗锯齿不用额外处理，超采样取覆盖率即可；
   圆角也不是「先画再磨」，而是把形状本身按半径膨胀。 */

function distSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  const dx = wx - vx * t;
  const dy = wy - vy * t;
  return Math.hypot(dx, dy);
}

/** 凸多边形 SDF：内部为负，外部为正（到最近边的距离） */
function polySDF(pts, x, y) {
  let d = Infinity;
  let inside = true;
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    d = Math.min(d, distSeg(x, y, a[0], a[1], b[0], b[1]));
    const cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    const s = cross >= 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) inside = false;
  }
  return inside ? -d : d;
}

/** 圆角矩形 SDF（x0,y0,x1,y1 为外框，r 为圆角半径） */
function roundRectSDF(x, y, x0, y0, x1, y1, r) {
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  const d = Math.hypot(x - cx, y - cy);
  // 核心矩形内部：d 为 0，需要再用到四边的距离给出负值，才能正确参与 union 取 min
  const inset = Math.min(x - x0, x1 - x, y - y0, y1 - y);
  if (inset >= r) return -Math.min(inset, r + 1);
  return d - r;
}

/* 房子的三个部件（归一化坐标，原点左上） */
const ROOF = [[0.500, 0.148], [0.892, 0.462], [0.108, 0.462]];
const ROOF_R = 0.028;   // 屋顶外扩 = 顺带把它圆角化
const BODY = [0.216, 0.436, 0.784, 0.822];
const BODY_R = 0.040;
/* 门是「拱形」：下半截直角贴地、上半截半圆 —— 圆角矩形做出来的门
   上下都圆，看着像一块漂浮的胶囊，不像门。半圆半径必须等于门宽的一半，
   否则拱顶会鼓出来或塌下去。 */
const DOOR = { x0: 0.428, x1: 0.572, top: 0.700, bottom: 0.822 };

function doorSDF(x, y) {
  const r = (DOOR.x1 - DOOR.x0) / 2;
  const rect = roundRectSDF(x, y, DOOR.x0, DOOR.top, DOOR.x1, DOOR.bottom, 0);
  const arc = Math.hypot(x - 0.5, y - DOOR.top) - r;
  return Math.min(rect, arc);
}

/** 是否落在房子里（门挖空 → 底色露出来，形成门洞） */
function inHouse(x, y) {
  const roof = polySDF(ROOF, x, y) - ROOF_R;
  const body = roundRectSDF(x, y, BODY[0], BODY[1], BODY[2], BODY[3], BODY_R);
  if (Math.min(roof, body) > 0) return false;
  return doorSDF(x, y) > 0;
}

/* 品牌色：取默认主题 paper 的 --primary: #8f6539（暖棕，纸质笔记本）。
   底用 --paper: #faf7f2，前景近白。三个值都在 styles.css 里有出处，
   要换主题色时改这里重新生成即可。 */
const BG = [0x8f, 0x65, 0x39];
const FG = [0xfd, 0xf9, 0xf2];

const SS = 4; // 每像素 4×4 = 16 个采样点，≈ 17 级抗锯齿

/**
 * @param {number} size      输出边长（像素）
 * @param {object} opt
 * @param {number} opt.scale 内容缩放（1 = 顶到 0.108..0.892 的外框）
 * @param {boolean} opt.round 背景是否自己画圆角（false = 满幅直角，iOS 用）
 * @param {boolean} opt.transparent 圆角外侧是否透明（maskable 不能透明）
 */
function render(size, { scale = 1, round = true, transparent = true } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const bgR = 0.22; // 圆角半径占边长比例
  const half = 0.5;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHit = 0;
      let fgHit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (px + (sx + 0.5) / SS) / size;
          const v = (py + (sy + 0.5) / SS) / size;
          if (round && roundRectSDF(u, v, 0, 0, 1, 1, bgR) > 0) continue;
          bgHit++;
          // 内容缩放：把采样点映射回「未缩小」的形状坐标
          const hx = half + (u - half) / scale;
          const hy = half + (v - half) / scale;
          if (inHouse(hx, hy)) fgHit++;
        }
      }
      const total = SS * SS;
      const i = (py * size + px) * 4;
      if (!bgHit) {
        // 圆角外：透明（maskable / apple-touch 会传 round=false，走不到这里）
        buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 0;
        continue;
      }
      const fgRatio = fgHit / bgHit;
      buf[i] = Math.round(BG[0] + (FG[0] - BG[0]) * fgRatio);
      buf[i + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * fgRatio);
      buf[i + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * fgRatio);
      buf[i + 3] = transparent
        ? Math.round((bgHit / total) * 255)
        : 255;
    }
  }
  return encodePNG(size, size, buf);
}

/* ── 3. 输出 ─────────────────────────────────────────────────────────
   四份尺寸/参数都不一样，是有意为之：
     · any 版自己带圆角 → 桌面 Chrome / 部分启动器直接显示好看
     · maskable 版满幅 + scale 0.72 → 落在 Android 安全区（直径 80%）内
     · apple-touch 满幅直角 + alpha=255 → iOS 不会把边角填黑 */
const TARGETS = [
  /* scale 0.88：图形四周留 6% 呼吸，避免屋顶尖/门槛顶到边线 */
  { file: 'icon-192.png', size: 192, opt: { round: true, transparent: true, scale: 0.88 } },
  { file: 'icon-512.png', size: 512, opt: { round: true, transparent: true, scale: 0.88 } },
  /* maskable：安全区是「直径 80% 的圆」（半径 0.4）。房子的最低两角是
     离圆心最远的点，scale=0.74 时距离 ≈ 0.375 < 0.4，留出遮罩余量；
     再大就会在圆形遮罩下被切掉门槛两角。 */
  { file: 'icon-maskable-512.png', size: 512, opt: { round: false, transparent: false, scale: 0.74 } },
  /* iOS 自己加圆角，这里必须满幅直角 + 不透明 */
  { file: 'apple-touch-icon-180.png', size: 180, opt: { round: false, transparent: false, scale: 0.86 } },
];

fs.mkdirSync(OUT_DIR, { recursive: true });
const quiet = process.argv.includes('--quiet');
for (const t of TARGETS) {
  const png = render(t.size, t.opt);
  fs.writeFileSync(path.join(OUT_DIR, t.file), png);
  if (!quiet) {
    console.log(`  ${t.file.padEnd(26)} ${String(t.size).padStart(3)}×${String(t.size).padEnd(3)}  ${(png.length / 1024).toFixed(1)} KB`);
  }
}
if (!quiet) console.log(`\n已写入 ${path.relative(process.cwd(), OUT_DIR)}/`);
