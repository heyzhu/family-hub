'use strict';
/**
 * 我们一家 · HTTP 服务入口
 *
 * 零第三方运行时依赖：只用 Node 内置的 http / fs / path / crypto。
 * 职责：静态资源分发、请求体解析、会话中间件、把 /api/* 交给 src/api.js。
 *
 *   node server.js          # 直接启动
 *   PORT=8080 node server.js
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Node 22 会把内置 SQLite 标记为实验特性并打印警告，这里静音掉，保持启动日志干净
const originalEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  if (/SQLite is an experimental feature/i.test(text)) return;
  return originalEmitWarning.call(process, warning, ...rest);
};

const config = require('./src/config');
const { db } = require('./src/db');
const auth = require('./src/auth');
const api = require('./src/api');
const reminders = require('./src/reminders');
const notify = require('./src/notify');
const bills = require('./src/bills');   // v2.0.0 家庭记账（日报/月报定时推送）
const wecom = require('./src/wecom');   // v4.5.0 企业微信自建应用（需求 5）
const urge = require('./src/urge');     // v4.6.0 待办「催促完成」（需求 3）

/* ── 静态资源 ───────────────────────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.pdf': 'application/pdf',
  /* v1.5.0 记录本附件：下载时给出真实类型，比一律 application/octet-stream 更好 ——
     部分客户端会据此选择合适的「打开方式」，也让浏览器下载列表看起来正常。
     注意：这些类型只用于「下载响应」，附件一律带 Content-Disposition: attachment，
     不会在页面里内联渲染，所以没有 XSS 顾虑（SVG 也照此处理）。 */
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.ics': 'text/calendar; charset=utf-8',
  '.vcf': 'text/vcard; charset=utf-8',
  '.rtf': 'application/rtf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.epub': 'application/epub+zip',
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.bz2': 'application/x-bzip2',
  '.xz': 'application/x-xz',
  '.sqlite': 'application/vnd.sqlite3',
  '.db': 'application/vnd.sqlite3',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.amr': 'audio/amr',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.3gp': 'video/3gpp',
};

/**
 * frame-ancestors 的取值（v4.20.0，审查 W-3）。
 *
 * 历史：v4.3.2 为了「从飞牛桌面点图标打开」，把这里放宽成 `'self' http: https:`
 * —— 后者是**任意** http/https 页面，等于允许互联网上任何站点把本应用放进
 * iframe 做点击劫持（诱导家人点「删除」「恢复备份」这类没有二次确认的操作）。
 *
 * 现在改成可配置：默认为空 → 沿用历史值（老部署行为一字不变，不会「一升级就打不开」）；
 * 部署者可以用环境变量收敛到网关的具体源，例如：
 *   FRAME_ANCESTORS="'self' https://nas.example.cn:5666"
 * 一旦显式配置，就完全按配置来（配置者自己承担拼错的后果，日志会打出来）。
 */
const FRAME_ANCESTORS = String(process.env.FRAME_ANCESTORS || '').trim() || "'self' http: https:";

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    /* ★ v4.26.0：必须显式放行 media-src 的 blob:。
       客户端「从视频里抽第一帧当封面」用的是 URL.createObjectURL(file) 出来的 blob: 地址，
       而 media-src 会回落到 default-src 'self'（'self' **不包含** blob:）——
       于是 <video src="blob:…"> 在 CSP 层就被拒，loadedmetadata 永远不触发，
       抽帧超时后静默返回空串：表现就是「上传完没有缩略图」，而且控制台里只有一条
       容易被忽略的 CSP 违规，业务代码看起来毫无问题（这个坑踩了三个版本）。
       img-src 早就带了 data: blob:，唯独媒体漏了 —— 两者不是一回事。 */
    "media-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    // ★ v4.20.0：取值见上面的 FRAME_ANCESTORS 注释。
    //   注意这段是**逗号无关**的 CSP 源列表，多个源用空格分隔。
    `frame-ancestors ${FRAME_ANCESTORS}`,
  ].join('; '),
};

/**
 * index.html 的改写缓存（v4.3.2，只在配了 BASE_PATH 时用到）
 */
let indexCache = { key: '', html: '' };

/** HTML 属性值转义（前缀是部署者填的，仍按不可信处理，避免引号拼出属性截断） */
function escAttr(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 读 index.html 并做「路径前缀适配」（v4.3.2，仅当配了 BASE_PATH 时生效）。
 *
 * 为什么必须做这一步：飞牛统一网关把应用挂在 /app/<appname> 下，
 * 页面地址因此变成 https://域名:5666/app/familyhub。这时页面里写的
 * `href="styles.css"`、`src="app.js"` 这类**相对路径**会被浏览器解析成
 * /app/styles.css、/app/app.js —— 全都取不到，表现为「白屏 / 没样式」。
 * 前端要调接口的 /api/* 是绝对路径，不带前缀同样打不到应用。
 *
 * 所以这里一次做两件事（无前缀时**原样返回**，旧行为一字不变）：
 *   ① 把所有相对资源引用改写成带前缀的绝对路径；
 *   ② 注入 `<meta name="fh-base">`，供 public/app.js 拼接口地址时使用。
 *
 * ★ v4.20.0（审查 S-1a）：这里原本注入的是
 *     `<script>window.__FH_BASE__=...</script>`
 *   而本服务自己发的 CSP 是 `script-src 'self'` —— 内联脚本**一律被浏览器拒绝执行**
 *   （index.html 的注释里自己就写着这条规则）。于是 `window.__FH_BASE__` 永远是
 *   undefined，改写成 meta 标签后不触发任何脚本执行策略，也不需要 nonce/hash。
 */
function renderIndexHtml(filePath) {
  const base = config.basePath;
  if (!base) return fs.readFileSync(filePath, 'utf8');

  /* v4.3.2 需求 3：改写结果按「文件 mtime + 前缀」缓存。
     改写本身只是一次正则替换，但 index.html 是**每次打开页面都要走**的热路径；
     在 NAS 上每次读盘 + 建 Buffer 也是实打实的开销。
     mtime 变了自然失效，改完源码刷新即生效，不会看到旧页面。 */
  const st = fs.statSync(filePath);
  const key = `${st.mtimeMs}|${st.size}|${base}`;
  if (indexCache.key === key) return indexCache.html;

  let html = fs.readFileSync(filePath, 'utf8');
  // 先注入 base —— 此时 <script src="app.js"> 还是原样，最容易定位
  const inject = `<meta name="fh-base" content="${escAttr(base)}">`;
  if (html.includes('<script src="app.js"></script>')) {
    html = html.replace('<script src="app.js"></script>', inject + '\n<script src="app.js"></script>');
  } else {
    html = html.replace(/<head([^>]*)>/i, (m, attrs) => `<head${attrs}>\n${inject}`);
  }

  // 再把相对引用改成绝对：排掉已经是绝对的（/ 开头）、外链、data:、锚点
  html = html.replace(
    /\b(src|href)="(?!https?:|\/|data:|#)([^"]*)"/g,
    (m, attr, rel) => `${attr}="${base}/${rel.replace(/^\.\//, '')}"`,
  );
  indexCache = { key, html };
  return html;
}

/**
 * v4.26.0（P0）：带 HTTP Range 的文件输出 —— 200 / 206 / 416 / HEAD。
 *
 * ★ 为什么这不是「优化」而是「修复」：
 *   1. iOS Safari 与它衍生出来的 WebView（微信内置、企业微信内置）对 `<video>`
 *      **强制走字节范围请求**。服务端只会回 200 + 整段时，典型表现是：
 *      点开一直转圈、拖进度条直接回到 0、弱网下必须先把整个文件下完才出第一帧。
 *   2. 手机拍的 MP4 大量把 `moov`（索引）放在文件尾部。没有 Range 就没法「先取尾部
 *      再取头部」，浏览器只能从头顺序读 —— 30 秒的片子要下完才肯播。
 *   3. 缩略图兜底路径 `#t=0.1` 依赖 seek，seek 又依赖 Range —— 少了 Range，
 *      这条兜底在手机上本来就是坏的。
 *
 * 语义按 RFC 9110：`bytes=a-b` / `bytes=a-` / `bytes=-n`（尾部 n 字节）；
 * 越界返回 416 + `Content-Range: bytes * /total`；带 `If-Range` 且不匹配时按整段 200 处理。
 */
function sendFileRange(req, res, filePath, headers) {
  const stat = fs.statSync(filePath);
  const total = stat.size;
  const etag = `"${total.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const base = { ...headers, 'Accept-Ranges': 'bytes', ETag: etag };
  const isHead = req && req.method === 'HEAD';
  const raw = req && req.headers ? req.headers.range : '';
  /* If-Range：客户端带着「上次那份文件」的条件来了，但文件已经变了 → 按整段重发，
     否则会拼出一段错位的内容（视频表现为花屏 / 播到一半卡死）。 */
  const ifRange = req && req.headers ? String(req.headers['if-range'] || '') : '';
  const rangeOk = !!raw && (!ifRange || ifRange === etag || ifRange === stat.mtime.toUTCString());

  let start = 0;
  let end = total - 1;
  if (rangeOk) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(raw).trim());
    const a = m ? m[1] : '';
    const b = m ? m[2] : '';
    if (!m) {
      // 语法不认识（含多段 range）→ 忽略 Range，按整段处理，这是规范允许的
      res.writeHead(200, { ...base, 'Content-Length': total });
      if (isHead) { res.end(); return; }
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    if (a === '') {
      const n = Number(b);
      if (!n) {
        res.writeHead(416, { ...base, 'Content-Range': `bytes */${total}` }).end();
        return;
      }
      start = Math.max(0, total - n);
      end = total - 1;
    } else {
      start = Number(a);
      end = b === '' ? total - 1 : Math.min(Number(b), total - 1);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${total}` }).end();
      return;
    }
    const len = end - start + 1;
    res.writeHead(206, {
      ...base,
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': len,
    });
    if (isHead) { res.end(); return; }
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...base, 'Content-Length': total });
  if (isHead) { res.end(); return; }
  fs.createReadStream(filePath).pipe(res);
}

function sendFile(req, res, filePath, { download } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  /* v4.27.0：.webmanifest 也要 no-cache。它是「安装清单」——浏览器在**安装那一刻**
     才去读它，缓存 600s 会让「刚改的图标 / 刚换的名字」装到主屏还是旧的样子；
     而它本身只有 700 字节，配合 ETag 每次 304 几乎没有成本。
     .html 同理由（改完刷新即生效）。 */
  const revalidate = ext === '.html' || ext === '.webmanifest';
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': revalidate ? 'no-cache' : 'public, max-age=600',
  };
  if (download) headers['Content-Disposition'] = `attachment; filename="${download}"`;

  // HTML 且配了前缀 → 走内存改写（改动后长度会变，Content-Length 必须按实际算）
  if (ext === '.html' && config.basePath) {
    const body = Buffer.from(renderIndexHtml(filePath), 'utf8');
    res.writeHead(200, { ...headers, 'Content-Length': body.length });
    res.end(body);
    return;
  }

  sendFileRange(req, res, filePath, headers);
}

function serveStatic(req, res, pathname) {
  /* v4.20.0（审查 W-4）：`GET /%E0%A4%A` 这类非法百分号编码会让 decodeURIComponent
     抛 URIError，原来被 wrapHandler 兜成 500 并在日志里打一整段栈 —— 任何扫描器
     扫一遍就能刷满日志。畸形 URL 是**客户端错误**，回 400 才是对的语义。 */
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }).end('Bad Request');
    return;
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  // 归一化后校验前缀，杜绝 ../ 目录穿越
  const full = path.resolve(config.publicDir, '.' + path.posix.normalize(rel));
  if (!full.startsWith(config.publicDir + path.sep) && full !== config.publicDir) {
    res.writeHead(403, SECURITY_HEADERS).end('Forbidden');
    return;
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    return;
  }
  sendFile(req, res, full);
}

/* ── 请求体 ─────────────────────────────────────────────── */

/**
 * 请求体上限。
 * 图片、附件、视频都是「base64 塞进 JSON」传上来的，base64 有 4/3 的膨胀，
 * 所以上限必须按【较大的那个限制】再乘 1.4 留余量，否则会出现
 * 「附件明明没超上限，却被 413 请求体过大挡在门外」这种极难排查的问题。
 * v1.9.0 起把视频上限（maxVideoMb，默认 50MB）也算进来 —— 它是三者中最大的那个。
 * v4.10.0：视频上限改为后台可配（config.videoMaxMb 运行时字段），这里**每次请求现算** ——
 *   否则管理员在后台把上限调大后，请求体还按启动时的旧值拦 413，出现「设置成功了却不生效」。
 */
function bodyHeadroomMb() {
  // v4.12.0：图片 / 附件上限也改成后台可配（config.imageMaxMb / fileMaxMb），同样每次现算
  return Math.ceil(Math.max(config.imageMaxMb, config.fileMaxMb, config.videoMaxMb) * 1.4) + 4;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const BODY_LIMIT = bodyHeadroomMb() * 1024 * 1024;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        // 明确告诉用户「多大算太大」，而不是笼统的「请求体过大」
        reject(Object.assign(
          new Error(`上传内容过大（超过约 ${bodyHeadroomMb()}MB），请压缩后再试`),
          { status: 413 },
        ));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ── 公开接口（无需登录） ───────────────────────────────── */

/* ★ v4.26.0：忘记密码的两个接口必须在公开名单里 —— 它们的前提就是「登录不进去」。
   漏了这里会出现最荒诞的故障：用户点「忘记密码」，接口回「需要登录」。 */
const PUBLIC_API = new Set(['/api/config', '/api/register', '/api/login', '/api/forgot-password', '/api/reset-password']);

function sendJson(res, status, payload, extraHeaders = {}) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...extraHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/* ── v4.5.0 需求 5：企业微信回调（唯一不走 api.handle 的 /api 路由） ──
   为什么必须单独一条：企业微信的请求体是 **XML**，且必须免登录访问。
   通用流程会先把 body 当 JSON 解析（XML 必然 400）、再要求登录态，
   两个前提都不成立。这里只负责「读原始报文 → 交给 src/wecom.js 验签解密
   → 把业务结果加密后原样回一段 XML」，业务编排在 api.wecomHandleMessage。 */
async function handleWecomCallback(req, res, url, method) {
  const cfg = wecom.loadConfig();
  const plain = (status, text) => {
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(String(text || '')),
      'Cache-Control': 'no-store',
    });
    res.end(String(text || ''));
  };
  if (!wecom.isReady(cfg)) {
    // 明确回 503 而不是 404：管理员在后台点「保存」时能区分「地址填错了」和「功能没开」
    plain(503, '企业微信接入未启用或配置不完整');
    return;
  }
  const params = Object.fromEntries(url.searchParams);

  if (method === 'GET') {
    const r = wecom.verifyCallback(cfg, params);
    if (!r.ok) {
      console.warn('[wecom] 回调地址验证失败：', r.error);
      plain(403, '验证失败');
      return;
    }
    // 企业微信要求原样返回解密后的 echostr（纯文本）
    plain(200, r.echo);
    return;
  }
  if (method !== 'POST') {
    plain(405, 'Method Not Allowed');
    return;
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    plain(err.status || 400, err.message || '读取请求体失败');
    return;
  }

  const parsed = wecom.readMessage(cfg, params, raw.toString('utf8'));
  if (!parsed.ok) {
    console.warn('[wecom] 消息验签/解密失败：', parsed.error);
    plain(403, '验签失败');
    return;
  }

  let text = '';
  /* ★ v4.7.0 需求 1：企业微信「被动回复」必须 5 秒内应答，否则连接被断开、回复被丢弃
     （用户那边完全没有反应，而 AI 已经扣过 token 了 —— 这正是「发图没回复但后台有
     用量记录」的根因）。业务层已经把发图识别改成「先应答、再异步主动推送」，
     这里再加一道 4.5 秒兜底：将来若有人又写出一个慢分支，宁可先回一句话，
     等它跑完用主动发消息补上，也不能让这条回复凭空消失。 */
  const WECOM_REPLY_BUDGET = 4500;
  const TIMEOUT = Symbol('wecom-timeout');
  const task = api.wecomHandleMessage(parsed.msg);
  let raced;
  try {
    raced = await Promise.race([
      task,
      new Promise((resolve) => {
        const t = setTimeout(() => resolve(TIMEOUT), WECOM_REPLY_BUDGET);
        if (t && typeof t.unref === 'function') t.unref();
      }),
    ]);
  } catch (err) {
    console.error('[wecom] 处理消息失败', err);
    // 出错也要回一句人话：静默 200 会让用户以为「发了没反应」
    text = '处理这条消息时出错了，请稍后再试。';
    raced = null;
  }
  if (raced === TIMEOUT) {
    text = '这条消息处理得有点久，我先回你一句 —— 结果出来我直接发给你，不用重发。';
    // 兜底不等于放弃：慢任务跑完后，把它的结果用主动发消息补回去
    task.then((out) => {
      const late = out && out.text;
      if (!late) return;
      api.wecomSendTo(parsed.msg.fromUser, late).catch((err) => {
        console.error('[wecom] 补发超时结果失败', err && err.message);
      });
    }).catch((err) => console.error('[wecom] 超时任务最终失败', err && err.message));
  } else if (raced) {
    text = raced.text ? raced.text : '';
  }

  // 空串 = 不回复（比如重复投递的消息、非本应用的事件）
  if (!text) {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Length': 0, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  const body = Buffer.from(wecom.buildReply(cfg, wecom.textXml(parsed.msg, text)), 'utf8');
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/xml; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/* ── 主处理 ─────────────────────────────────────────────── */

/**
 * 请求来源 IP（v4.20.0，审查 S-2：登录失败退避的分组键之一）。
 * 只在 TRUST_PROXY 打开时才信 X-Forwarded-For —— 否则客户端随手伪造一个头
 * 就能把「按 IP 退避」绕过去。取第一段（最靠近客户端的那个）。
 */
function clientIp(req) {
  if (config.trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff.slice(0, 64);
  }
  return String((req.socket && req.socket.remoteAddress) || '').slice(0, 64);
}

/** 「不带前缀的请求」只警告一次，避免刷屏（诊断用，不影响功能） */
let prefixWarned = false;

/**
 * 唯一的请求处理函数：TCP 端口与 Unix Socket 两个入口共用它（v4.3.2）。
 * 抽成具名函数而不是两个内联箭头函数，是为了保证「从端口进来的请求」和
 * 「从网关进来的请求」走**完全同一条**代码路径 —— 否则很容易出现
 * 「网页能开、但某个接口只在网关下 404」这类只有真机能发现的分裂。
 */
async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400, SECURITY_HEADERS).end('Bad Request');
    return;
  }
  const method = (req.method || 'GET').toUpperCase();

  // ★ v4.3.2：剥离飞牛统一网关的路径前缀。
  //   网关把应用挂在 /app/<appname> 下并**保留**前缀转发（官方文档与
  //   社区实现都如此），所以必须在这里剥掉再路由，否则全部 404。
  //   没配 BASE_PATH 时这一段是彻底的空操作，旧部署行为一字不变。
  let pathname = url.pathname;
  if (config.basePath) {
    if (pathname === config.basePath) {
      // 入口地址没带尾斜杠时补一个跳转，让浏览器以「目录」为基址解析相对资源
      res.writeHead(302, { ...SECURITY_HEADERS, Location: config.basePath + '/' + url.search });
      res.end();
      return;
    }
    if (pathname.startsWith(config.basePath + '/')) {
      pathname = pathname.slice(config.basePath.length);
    }
    // 前缀之外的请求**故意照常处理**（不返回 404）：
    // 飞牛系统可能用不带前缀的地址做探测，把它打成 404 会有「应用明明是好的、
    // 却被判定异常」的风险。宽进严出，代价只是前缀配错时不容易被发现 ——
    // 下面这行日志就是为了补上这一点可观测性。
    else if (!prefixWarned) {
      prefixWarned = true;
      console.warn(`[gateway] 收到不带前缀的请求 ${pathname}（已配置 BASE_PATH=${config.basePath}），按原路径处理`);
    }
  }
  const searchParams = url.searchParams;

  if (!pathname.startsWith('/api/')) {
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, SECURITY_HEADERS).end('Method Not Allowed');
      return;
    }
    serveStatic(req, res, pathname);
    return;
  }

  /* v4.5.0 需求 5：企业微信回调。★ 必须放在会话中间件**之前** ——
     企业微信服务器不带 Cookie，走通用流程会被 401 挡掉；
     而且它的 body 是 XML，下面那段 JSON 解析会直接 400。 */
  if (pathname === '/api/wecom/callback') {
    await handleWecomCallback(req, res, url, method);
    return;
  }

  // —— 会话中间件：解析 Cookie → 得到当前用户 ——
  const token = auth.cookieValue(req);
  const me = auth.resolveSession(token);

  if (!me && !PUBLIC_API.has(pathname)) {
    sendJson(res, 401, { error: '需要登录' });
    return;
  }

  let body = null;
  if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
    try {
      const raw = await readBody(req);
      if (raw.length) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 });
        }
      }
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message || '请求体解析失败' });
      return;
    }
  }

  let result;
  try {
    result = await api.handle({
      method, pathname, query: searchParams, body, me, token,
      recordsKey: String(req.headers['x-records-key'] || '').slice(0, 64),
      ip: clientIp(req),
    });
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    /* 已知的「业务性 5xx」（带 code，例如 503 MAIL_NOT_READY）只记一行，
       不打整段栈 —— 否则一次「没配发件邮箱」就能在日志里刷出几十行，
       真正需要排查的崩溃反而被埋掉。 */
    if (status >= 500) {
      if (err && err.code) console.error('[api]', method, pathname, status, err.code, err.message);
      else console.error('[api]', method, pathname, err);
    }
    const payload = { error: (err && err.message) || '服务器内部错误' };
    if (err && err.code) payload.code = err.code;
    sendJson(res, status, payload);
    return;
  }

  if (!result) {
    sendJson(res, 404, { error: '接口不存在' });
    return;
  }

  // —— 会话指令：注册/登录签发 Cookie，退出/改密/恢复时清除 ——
  const headers = {};
  if (result.session) {
    if (result.session.action === 'create') {
      const s = auth.createSession(result.session.userId);
      auth.setSessionCookie(res, req, s.token);
    } else if (result.session.action === 'destroy') {
      auth.destroySession(token);
      auth.clearSessionCookie(res, req);
    }
  }
  const cookieHeader = res.getHeader('Set-Cookie');
  if (cookieHeader) headers['Set-Cookie'] = cookieHeader;

  /* v2.0.0：直接回一段文本（目前只有账单 CSV 导出用）。
     以前只有 file / json 两种，CSV 若走 json 会被包成 JSON 字符串、
     Content-Type 也变成 application/json —— 用户下下来的 .csv 双击打不开。 */
  if (result.text != null) {
    const body = Buffer.from(String(result.text), 'utf8');
    const textHeaders = {
      ...SECURITY_HEADERS,
      ...headers,
      'Content-Type': result.type || 'text/plain; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'private, no-store',
    };
    if (result.download) {
      textHeaders['Content-Disposition'] =
        `attachment; filename="${encodeURIComponent(result.download)}"; filename*=UTF-8''${encodeURIComponent(result.download)}`;
    }
    res.writeHead(result.status || 200, textHeaders);
    res.end(body);
    return;
  }

  if (result.file) {
    const ext = path.extname(result.file).toLowerCase();
    /* v4.26.0（P0）：媒体也走 Range —— 视频/音频从 /api/media/ 出去，
       这条分支原来固定 200 + 整段，正是「手机上播不动、拖不动」的直接原因。
       sendFileRange 会自己加 Accept-Ranges / Content-Length / ETag 并处理 206/416。 */
    const fileHeaders = {
      ...SECURITY_HEADERS,
      ...headers,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'private, max-age=86400',
    };
    // 附件走下载（带上原始文件名）；图片走内联预览。
    // 附件一律 attachment，避免浏览器把它当页面渲染 —— 这是防存储型 XSS 的关键一步。
    if (result.download) {
      fileHeaders['Content-Disposition'] =
        `attachment; filename="${encodeURIComponent(result.download)}"; filename*=UTF-8''${encodeURIComponent(result.download)}`;
      fileHeaders['Cache-Control'] = 'private, no-store';
    }
    sendFileRange(req, res, result.file, fileHeaders);
    return;
  }

  sendJson(res, result.status || 200, result.json, result.download
    ? { ...headers, 'Content-Disposition': `attachment; filename="${result.download}"` }
    : headers);
}

/* ★ v4.3.2 需求 3：慢请求打点。
   用户反馈的「界面卡顿」在浏览器里表现为「点了没反应」，但真正的原因可能在服务端。
   这里给每个请求记时，超过阈值就落一行日志 —— 有了它，「卡顿」就从主观感受
   变成「哪条接口、多少毫秒」的事实，不用再靠猜。
   阈值取 300ms：局域网里正常的接口都是个位数毫秒，能到 300ms 就已经异常了。 */
const SLOW_REQUEST_MS = 300;

/** 给请求处理函数套上「计时 + 兜底 500」——两个监听入口共用，保证口径一致 */
function wrapHandler(handler, label) {
  return (req, res) => {
    const t0 = Date.now();
    res.on('finish', () => {
      const cost = Date.now() - t0;
      if (cost >= SLOW_REQUEST_MS) {
        console.warn(`[slow] ${label} ${req.method} ${req.url} ${cost}ms`);
      }
    });
    Promise.resolve(handler(req, res)).catch((err) => {
      console.error('[server]', req.method, req.url, err);
      try {
        if (!res.headersSent) res.writeHead(500, SECURITY_HEADERS).end('服务器内部错误');
        else res.end();
      } catch { /* 响应已经不可写了，忽略 */ }
    });
  };
}

/** TCP 入口：局域网直连（手机 / 浏览器 / 旧书签都靠它） */
const server = http.createServer(wrapHandler(handleRequest, 'tcp'));
/** Unix Socket 入口：飞牛统一网关（v4.3.2，未配 SOCKET_PATH 时为 null） */
const socketServer = config.socketPath ? http.createServer(wrapHandler(handleRequest, 'sock')) : null;

/* ── 启动 ───────────────────────────────────────────────── */

auth.pruneExpiredSessions();
reminders.start();          // 待办邮件提醒：每分钟扫描一次到点事项
/* v1.9.0：内容变更通知的「到点冲刷」。
   管理员设了汇总时间或深夜免打扰后，变更事件会先攒在内存队列里，
   由这个心跳每分钟检查一次该不该发。放在这里而不是 notify.js 内部，
   是为了避免 notify ↔ reminders 互相 require 造成的循环依赖。 */
const notifyTimer = setInterval(() => {
  try {
    const r = notify.flushDue();
    if (r.sent) console.log(`[notify] 汇总通知已发出（${r.sent} 条，队列还剩 ${r.pending} 条）`);
  } catch (err) {
    console.error('[notify] 汇总发送失败：', err && err.message);
  }
}, 60 * 1000);
notifyTimer.unref();
/* v2.0.0：家庭记账的日报 / 月报推送。
   ★ 独立定时器，与 reminders / notify 互不影响 —— 需求文档明确要求
     「定时任务独立新增，不影响原有定时服务」。bills 内部自己带幂等标记
     （bill_report_last_day / bill_report_last_month），重启后不会重复发。 */
bills.start();
/* v4.6.0 需求 3：待办「催促完成」的企业微信催办。
   ★ 独立定时器（第 4 个），与邮件提醒 / 内容通知 / 记账报表互不干扰。
     每分钟扫一次，靠每条待办自己的 urge_last_at + urge_minutes 决定这一轮该不该催，
     所以重启后不会补发一串消息，也不会漏掉「刚好到点」的那一次。
   ★ 只在企业微信配置完整时才真的发消息；没配就整段空转（不会污染日志）。 */
const urgeTimer = setInterval(() => {
  Promise.resolve()
    .then(() => urge.tickUrge())
    .then((r) => {
      if (!r) return;
      if (r.sent) console.log(`[urge] 已通过企业微信催促 ${r.sent} 条待办`);
      if (r.errors.length) console.error('[urge] 催促失败：', r.errors.join('；'));
    })
    .catch((err) => console.error('[urge] 扫描异常：', err && err.message));
}, 60 * 1000);
urgeTimer.unref();
const pruneTimer = setInterval(() => {
  try { auth.pruneExpiredSessions(); } catch (err) { console.error('[session] 清理失败', err.message); }
}, 60 * 60 * 1000);
pruneTimer.unref();

server.listen(config.port, config.host, () => {
  const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  console.log('');
  console.log(`  🏠  ${config.siteName} 已启动`);
  console.log(`      访问地址   ${url}`);
  console.log(`      数据库     ${db.file}  (${db.kind})`);
  console.log(`      日志模式   ${db.journalMode || '(未知)'}`);
  console.log(`      图片目录   ${config.uploadDir}`);
  console.log(`      登录有效期 ${config.sessionTtlHours} 小时（滑动续期）`);
  if (!auth.userCount()) {
    console.log('      首次使用  请打开页面注册第一个账号，它将自动成为管理员');
  }
  console.log('');
});

/* ── Unix Socket 入口（v4.3.2 需求：走飞牛统一网关）─────────────
   只在配了 SOCKET_PATH 时才启用；没配就一个字节都不多做 —— 旧部署完全无感。
   两件事容易踩坑，都写在这里：
     ① 监听前要先删掉上次留下的 socket 文件，否则 bind 会报 EADDRINUSE，
        应用「重启后起不来」；
     ② 文件权限必须是 0666。网关是以**另一个用户**的身份来连这个 socket 的，
        默认 0700 会让它连不上（表现为「网页能开、但网关下 404」这类怪现象）。 */
if (socketServer) {
  try { fs.unlinkSync(config.socketPath); } catch { /* 文件不存在就是好事 */ }
  socketServer.on('error', (err) => {
    console.error(`[gateway] Unix Socket 监听失败（${config.socketPath}）：`, err && err.message);
  });
  socketServer.listen(config.socketPath, () => {
    try { fs.chmodSync(config.socketPath, 0o666); } catch (err) {
      console.error('[gateway] socket 权限设置失败：', err && err.message);
    }
    console.log(`      网关入口   ${config.socketPath}`);
    console.log('');
  });
}

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭…`);
  // socket 文件是「文件系统里的桩」，进程走了它就变成死文件 —— 顺手清掉，
  // 否则下次启动虽然会先 unlink，但中间那段时间它一直挂在那儿容易让人误判。
  const cleanupSocket = () => {
    if (!socketServer) return;
    try { socketServer.close(); } catch { /* 忽略 */ }
    try { fs.unlinkSync(config.socketPath); } catch { /* 忽略 */ }
  };
  server.close(() => {
    cleanupSocket();
    try { db.close(); } catch { /* 忽略 */ }
    process.exit(0);
  });
  setTimeout(() => { cleanupSocket(); process.exit(0); }, 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
