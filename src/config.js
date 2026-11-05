'use strict';
/**
 * 配置读取：优先环境变量，其次项目根目录的 .env 文件，最后内置默认值。
 * 不引入 dotenv，保持零依赖。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length > 1 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnvFile();

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const abs = (p) => (path.isAbsolute(p) ? p : path.resolve(ROOT, p));

/** 站点名称的出厂默认值。改这里就等于改「恢复默认」恢复到哪儿。 */
const DEFAULT_SITE_NAME = '我们一家';
/** 站点名称长度上限。顶栏是按「4 个字」的宽度排版算过预算的，放开了会撑破标题栏。 */
const SITE_NAME_MAX = 20;

/**
 * 清洗站点名称：去掉控制字符（换行/制表等会把页面标题和邮件标题撑成多行）、
 * 去掉首尾空白、按上限截断。返回空串表示「没有有效名称」，由调用方回落默认值。
 *
 * 做成纯函数并导出，是为了让「管理员在界面上存的值」和「启动时从库里读回来的值」
 * 走**同一套**校验 —— 否则会出现「保存时拦住了、重启后又生效了」这种诡异差异。
 */
function normalizeSiteName(v) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, SITE_NAME_MAX);
}

/**
 * 归一化「路径前缀」（v4.3.2，为飞牛统一网关而加）。
 *
 * 背景：飞牛 fnOS 的统一网关会把应用挂在系统域名下的 /app/<appname>，
 * 并把**带前缀**的请求原样转发给应用（例如 GET /app/familyhub/api/config）。
 * 应用必须自己把这个前缀剥掉再路由，否则每个接口都会 404。
 *
 * 归一化规则（宁可多花几行也不让奇怪的值进来）：
 *   '' 或 '/'      → ''（表示「没有前缀」，即今天的行为，一字不变）
 *   'app/x'        → '/app/x'（补前导斜杠）
 *   '/app/x/'      → '/app/x'（去掉尾部斜杠，避免拼出双斜杠）
 * 只做这些形状修正，不解析 .. 或百分号编码 —— 前缀是部署者填的，
 * 不是用户输入，真正的目录穿越防护在 serveStatic 里。
 */
function normalizeBasePath(v) {
  let s = String(v == null ? '' : v).trim();
  if (!s || s === '/') return '';
  if (!s.startsWith('/')) s = '/' + s;
  s = s.replace(/\/+$/, '');
  return s === '/' ? '' : s;
}

/** 版本号唯一来源：package.json */
function pkgVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch { return '0.0.0'; }
}

module.exports = {
  root: ROOT,
  publicDir: path.join(ROOT, 'public'),
  version: pkgVersion(),
  // v4.3.1 需求 7：默认端口 3000 → 3455（避开 NAS/软路由上最常被占用的 3000 段）
  port: num(process.env.PORT, 3455),
  host: process.env.HOST || '0.0.0.0',
  dbPath: abs(process.env.DB_PATH || 'data/family.db'),
  uploadDir: abs(process.env.UPLOAD_DIR || 'data/uploads'),
  sessionTtlHours: num(process.env.SESSION_TTL_HOURS, 24),
  maxSessionsPerUser: num(process.env.MAX_SESSIONS_PER_USER, 10),
  // 单张图片上限。v1.5.0 从 5MB 提到 10MB：
  // 前端虽然会压缩，但 GIF 要保留动画、以及浏览器解不开的照片（HEIC 等）只能走原图，
  // 5MB 对「手机直出照片」偏紧，用户会看到「图片不能超过 5MB」这种没头没尾的报错。
  maxUploadMb: num(process.env.MAX_UPLOAD_MB, 10),
  // 记录本附件上限（PDF / Office / 压缩包等）。与图片分开，附件通常更大。
  maxFileMb: num(process.env.MAX_FILE_MB, 20),
  /* v4.12.0 需求 2：图片 / 附件的上限也改成**后台可配**（settings.upload_image_max_mb /
     upload_file_max_mb），与视频上限同一套路数。
     `imageMaxMb` / `fileMaxMb` 是运行时可变字段（applyDbSettings 与 saveSettings 会改它），
     `maxUploadMb` / `maxFileMb` 只作为环境变量兜底默认值保留 —— 业务代码一律读前者。 */
  imageMaxMb: num(process.env.MAX_UPLOAD_MB, 10),
  fileMaxMb: num(process.env.MAX_FILE_MB, 20),
  /* v4.12.0：推送通道的家庭级总开关（「我的 → 推送配置」里的两个勾选框）。
     同样是运行时可变字段：saveSettings 保存后立即生效，applyDbSettings 启动时从库里读回。
     默认都开 —— 升级后行为与之前一致，不会「一升级就静默收不到提醒」。 */
  pushMailEnabled: process.env.PUSH_MAIL !== '0',
  pushWecomEnabled: process.env.PUSH_WECOM !== '0',
  /* v4.24.0 需求 2：飞书 / 钉钉群机器人的家庭级总开关（「我的 → 推送渠道设置」里的勾选框）。
     同样是运行时可变字段：saveSettings 保存后立即生效，applyDbSettings 启动时从库里读回。
     默认开 —— 「开」只是允许这个通道，没填 Webhook 之前它本来就发不出去。 */
  pushFeishuEnabled: process.env.PUSH_FEISHU !== '0',
  pushDingtalkEnabled: process.env.PUSH_DINGTALK !== '0',
  // 动态视频上限（v1.9.0）。视频比图片大一个量级，单独一条上限：
  // 默认 50MB ≈ 手机拍 30 秒 1080p。调大它同时会把请求体上限一起抬高（见 server.js
  // 的 BODY_HEADROOM_MB），所以别随手写成 500 —— 那等于让一个请求吃掉半个内存。
  // v4.10.0：这个值改为**后台可配**（settings.upload_video_max_mb，见 db.applyDbSettings /
  // api.saveSettings），`videoMaxMb` 是运行时可变字段，maxVideoMb 退化为环境变量兜底默认值。
  maxVideoMb: num(process.env.MAX_VIDEO_MB, 50),
  videoMaxMb: num(process.env.MAX_VIDEO_MB, 50),
  trustProxy: process.env.TRUST_PROXY !== '0',
  allowRegister: process.env.ALLOW_REGISTER !== '0',
  // 站点名称：v1.8.0 起**可以由管理员在「家庭设置」里自定义**。
  //   取值优先级：settings 表里的 site_name → 这里的默认值。
  //   （环境变量 FAMILY_NAME 从 v1.6.0 起已不再读取，也不要再加回来 ——
  //     两套改名入口会打架，出现「网页标题一个名、提醒邮件另一个名」。）
  //   `siteName` 是**运行时可变字段**：saveSettings() 保存后立即改它，改完即生效；
  //   db.js 的 applyDbSettings() 在启动时用库里的值覆盖它，所以重启后依然保留。
  //   各模块统一引用 config.siteName，不要再自己写字符串字面量。
  defaultSiteName: DEFAULT_SITE_NAME,
  siteName: DEFAULT_SITE_NAME,
  siteNameMax: SITE_NAME_MAX,
  normalizeSiteName,
  // v4.3.2：飞牛统一网关接入（**默认关闭，不影响任何既有部署**）。
  //   basePath   路径前缀。网关把应用挂在 /app/<appname>，转发时**保留**前缀，
  //              由应用自己剥离。为空串时行为与旧版完全一致。
  //   socketPath Unix Socket 路径。网关把请求转发到应用监听的 Socket。
  //              两个都留空 = 只监听 TCP 端口（今天的默认行为）。
  //              注意：即使配了 socket，TCP 端口也照常监听 —— 手机/浏览器
  //              直接访问 http://NAS:端口 的老路径不能断。
  basePath: normalizeBasePath(process.env.BASE_PATH),
  socketPath: process.env.SOCKET_PATH ? path.resolve(process.env.SOCKET_PATH) : '',
  normalizeBasePath,
  // 待办提醒按「墙上时间」计算，必须显式指定时区偏移，不能依赖进程本地时区：
  // 容器（node:22-alpine）默认是 UTC，而待办日期/时间是家里人按北京时间填的。
  // 单位分钟，默认 +480（东八区）。管理员可在「家庭设置」里改。
  tzOffsetMinutes: num(process.env.TZ_OFFSET_MINUTES, 480),
};
