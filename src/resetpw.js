'use strict';
/**
 * 忘记密码：邮箱验证码重置登录密码（v4.26.0）
 *
 * 场景是「家里人忘记登录密码，又不方便让管理员改」——所以走「用户名 + 绑定邮箱」：
 *   1. 登录页点「忘记密码」，填用户名；
 *   2. 服务端按 users.notify_email 发一封 6 位验证码邮件；
 *   3. 用户填验证码 + 新密码 → 重置成功，旧会话全部失效。
 *
 * 安全取舍（家庭应用，但该有的都不能省）：
 *   · **对外响应一律一致** —— 绝不回答「这个用户名存在不存在 / 有没有绑邮箱」，
 *     否则登录页就成了用户名探测器。所以 request() 在「查不到用户」和「没绑邮箱」时
 *     都返回 sent:false，接口层统一回 { ok: true }。
 *   · 唯一例外是「服务器根本没配发件邮箱」：那是**配置问题**，与账号无关，
 *     而且必须让家里人看得懂（否则会以为邮件在路上），所以回 503 + 明确文案。
 *   · 验证码 6 位数字、15 分钟、单次、错 5 次作废、10 分钟内最多发 3 次；
 *   · 只存 sha256(salt + code)，不存明文；
 *   · 重置成功即清掉该用户所有会话 —— 密码变了，旧设备的 Cookie 必须立刻失效。
 *
 * 依赖方向：resetpw → config / db / auth / reminders / mailer。
 * 它**不** require api.js，也不被 auth.js require（无环）。
 */
const crypto = require('node:crypto');
const config = require('./config');
const { db } = require('./db');
const auth = require('./auth');
const reminders = require('./reminders');
const mailer = require('./mailer');

const CODE_TTL_MS = 15 * 60 * 1000;      // 验证码有效期
const MAX_TRIES = 5;                     // 一条验证码最多试几次
const SEND_WINDOW_MS = 10 * 60 * 1000;   // 发码频率窗口
const SEND_MAX = 3;                      // 窗口内最多发几次
const SEND_TRACK = new Map();            // key → [时间戳...]（进程内，重启即清空）
const TRACK_SOFT_CAP = 2000;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const nowIso = () => new Date().toISOString();

/** 统一抛错口径：带上 status，server.js 会把状态码原样透传 */
const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

const trackKey = (username, ip) =>
  `${String(username || '').trim().toLowerCase()}|${String(ip || '')}`;

/**
 * 发码节流：同「用户名 + IP」在 10 分钟内最多 3 次。
 * 用滑动窗口（存时间戳数组）而不是「一次就锁 10 分钟」——
 * 家里人常见的动作是「没收到 → 再点一次 → 还是没收到 → 换个邮箱」，锁死会把人挡在门外。
 */
function checkThrottle(username, ip) {
  const key = trackKey(username, ip);
  const now = Date.now();
  const arr = (SEND_TRACK.get(key) || []).filter((t) => now - t < SEND_WINDOW_MS);
  SEND_TRACK.set(key, arr);
  if (arr.length >= SEND_MAX) {
    const mins = Math.max(1, Math.ceil((SEND_WINDOW_MS - (now - arr[0])) / 60000));
    throw fail(`发送太频繁，请 ${mins} 分钟后再试`, 429, 'RESET_THROTTLED');
  }
  return key;
}

function markSent(key) {
  const arr = SEND_TRACK.get(key) || [];
  arr.push(Date.now());
  SEND_TRACK.set(key, arr);
  if (SEND_TRACK.size > TRACK_SOFT_CAP) {
    for (const [k, v] of SEND_TRACK) if (!v.length) SEND_TRACK.delete(k);
  }
}

/** 测试用：清空节流计数（生产代码不要调用） */
function resetThrottle() { SEND_TRACK.clear(); }

/** 邮件正文：纯文本 + 与提醒同一套 HTML 版式（reminders.mailLayout），观感统一 */
function buildMail({ displayName, username, code, minutes }) {
  const who = String(displayName || username || '');
  const site = String(config.siteName || '我们一家');
  const text = [
    `${who}，你好：`,
    '',
    `你在「${site}」申请了重置登录密码。`,
    `账号：${username}`,
    '',
    '验证码：',
    '',
    `    ${code}`,
    '',
    `${minutes} 分钟内有效，只能使用一次。`,
    '如果不是你本人操作，忽略这封邮件即可 —— 你的登录密码不会被修改。',
    '',
    '—— 本邮件由系统自动发送，请勿回复',
  ].join('\n');
  const html = reminders.mailLayout({
    heading: '重置登录密码',
    badge: '🔑 密码找回',
    intro: `${who}，你在「${site}」申请了重置登录密码，请在 ${minutes} 分钟内完成。`,
    rows: [
      { label: '账号', value: username },
      { label: '验证码', value: code },
      { label: '有效期', value: `${minutes} 分钟（仅可使用一次）` },
    ],
    kind: 'todo',
    footnote: '如果不是你本人操作，请忽略本邮件，你的登录密码不会被修改。',
  });
  return { text, html };
}

/** 默认发信：用「家庭设置」里那套 SMTP（与提醒、报表完全一致，管理员只配一次） */
async function defaultSend({ to, subject, text, html }) {
  const cfg = reminders.loadRemindSettings();
  return mailer.sendMail({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    user: cfg.smtpUser,
    pass: cfg.smtpPass,
    fromName: config.siteName,
    to,
    subject,
    text,
    html,
  });
}

/**
 * 申请验证码。
 * @param {{username:string, ip?:string, sendMail?:Function}} o
 *   sendMail 可注入（测试用）：收 { to, subject, text, html, code }。
 * @returns {Promise<{ok:true, sent:boolean}>}
 */
async function request({ username, ip, sendMail } = {}) {
  const name = String(username || '').trim();
  if (!name) throw fail('请填写用户名', 400, 'BAD_USERNAME');
  if (name.length > 64) throw fail('用户名不正确', 400, 'BAD_USERNAME');

  /* ① 先看服务器有没有发信能力 —— 这是配置问题，与账号是否存在无关 */
  const cfg = reminders.loadRemindSettings();
  if (!cfg.smtpUser || !cfg.smtpPass) {
    throw fail('管理员还没有配置发件邮箱，暂时无法通过邮箱找回密码。请联系家里的管理员，或在「家庭设置」里填好发件邮箱。',
      503, 'MAIL_NOT_READY');
  }

  const key = checkThrottle(name, ip);

  /* ② 查人：查不到 / 没绑邮箱都走「静默成功」，响应与真实发送完全一致 */
  const row = db.get('SELECT id, username, display_name, notify_email FROM users WHERE username = ?', [name]);
  const email = row ? String(row.notify_email || '').trim() : '';
  if (!row || !reminders.EMAIL_RE.test(email)) {
    markSent(key);           // 也占一次配额：否则可以用 429 的时机反推账号是否存在
    return { ok: true, sent: false };
  }

  /* ③ 生成验证码：单人同一时刻只留一条有效记录 */
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const salt = crypto.randomBytes(12).toString('hex');
  db.run('DELETE FROM password_resets WHERE user_id = ?', [row.id]);
  db.run(
    `INSERT INTO password_resets (user_id, code_hash, salt, tries, used, created_at, expires_at)
     VALUES (?,?,?,0,0,?,?)`,
    [row.id, sha256(`${salt}:${code}`), salt, nowIso(), new Date(Date.now() + CODE_TTL_MS).toISOString()],
  );

  const minutes = Math.round(CODE_TTL_MS / 60000);
  const mail = buildMail({ displayName: row.display_name, username: row.username, code, minutes });
  const subject = `【${config.siteName || '我们一家'}】重置登录密码的验证码`;
  try {
    await (typeof sendMail === 'function' ? sendMail : defaultSend)({
      to: email, subject, ...mail, code,
    });
  } catch (err) {
    // 发不出去 → 验证码也不该留着（否则用户收到的是「上一封邮件里的码」）
    db.run('DELETE FROM password_resets WHERE user_id = ?', [row.id]);
    console.error('[resetpw] 发送验证码失败：', err && err.message);
    /* 仍然回「已发送」：不同响应会暴露「这个账号确实存在且配了邮箱」。
       管理员要靠服务端日志定位 SMTP 问题，不能靠登录页。 */
    return { ok: true, sent: false };
  }
  markSent(key);
  return { ok: true, sent: true };
}

/** 等长 hex 的常量时间比较（避免用 === 泄露前缀匹配长度） */
function sameHash(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * 校验验证码并重置密码。
 * 失败一律 400「验证码不正确或已过期」——不区分「没有这个人 / 码不对 / 码过期」，
 * 只把「过期」和「错太多次」在**提示语义**上区分开（这两种对用户是可行动的）。
 */
async function confirm({ username, code, password } = {}) {
  const name = String(username || '').trim();
  const pin = String(code == null ? '' : code).trim();
  const pw = String(password == null ? '' : password);

  if (!name) throw fail('请填写用户名', 400, 'BAD_USERNAME');
  if (!/^\d{6}$/.test(pin)) throw fail('请输入 6 位数字验证码', 400, 'BAD_CODE');
  if (pw.length < 6) throw fail('新密码至少 6 位', 400, 'BAD_PASSWORD');

  const row = db.get('SELECT id, username FROM users WHERE username = ?', [name]);
  if (!row) throw fail('验证码不正确或已过期', 400, 'BAD_CODE');

  const rec = db.get(
    'SELECT * FROM password_resets WHERE user_id = ? AND used = 0 ORDER BY id DESC LIMIT 1', [row.id]);
  if (!rec) throw fail('验证码不正确或已过期，请重新获取', 400, 'BAD_CODE');

  if (String(rec.expires_at) <= nowIso()) {
    db.run('DELETE FROM password_resets WHERE id = ?', [rec.id]);
    throw fail('验证码已过期，请重新获取', 400, 'CODE_EXPIRED');
  }
  if (Number(rec.tries) >= MAX_TRIES) {
    db.run('DELETE FROM password_resets WHERE id = ?', [rec.id]);
    throw fail('验证码错误次数过多，请重新获取', 400, 'CODE_LOCKED');
  }
  if (!sameHash(sha256(`${rec.salt}:${pin}`), rec.code_hash)) {
    db.run('UPDATE password_resets SET tries = tries + 1 WHERE id = ?', [rec.id]);
    throw fail('验证码不正确或已过期，请重新获取', 400, 'BAD_CODE');
  }

  db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await auth.hashPassword(pw), row.id]);
  // 用完即删：一个验证码只能重置一次，重放直接被上一条 rec 判空挡掉
  db.run('DELETE FROM password_resets WHERE user_id = ?', [row.id]);
  // 密码变了 → 所有旧会话失效（换设备重新登录，符合直觉也更安全）
  db.run('DELETE FROM sessions WHERE user_id = ?', [row.id]);
  if (typeof auth.resetLoginFail === 'function') auth.resetLoginFail();   // 顺手解开「密码错太多次」的锁
  return { ok: true, username: row.username };
}

module.exports = {
  request, confirm, buildMail, resetThrottle,
  CODE_TTL_MS, MAX_TRIES, SEND_MAX, SEND_WINDOW_MS,
};
