'use strict';
/**
 * 认证与会话。
 *
 * 设计要点：
 *  - 密码用 scrypt + 随机盐哈希，永不存明文；校验用恒定时间比较。
 *  - 会话 token 是 32 字节随机值，**只放在 httpOnly Cookie 里**，前端拿不到，天然防 XSS 窃取。
 *  - 有效期默认 24 小时且**滑动续期**：每次请求自动延长。
 *    效果就是「登录一次后，1 天内再次打开无需登录」；闲置超过 24 小时才需要重新登录。
 *  - 第一个注册的用户自动成为管理员，可在「我的」页为家人重置密码。
 */
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const config = require('./config');
const { db } = require('./db');

const COOKIE_NAME = 'fh_session';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/* ── 密码 ───────────────────────────────────────────────── */

/**
 * ★ v4.20.0（审查 S-2）：scrypt 改**异步**。
 *
 * 原来是 `crypto.scryptSync` —— 一次要 40~80ms 且吃 16MB 内存，而它是**同步**的，
 * 会占满唯一的事件循环线程。后果不是「登录慢一点」而是「全站停摆」：
 * 并发 20 个登录请求，就能让提醒扫描、轮询接口、静态资源全部卡住 1 秒以上。
 * 而登录属 PUBLIC_API —— 攻击者不需要任何凭据就能触发。
 *
 * scrypt 本身的工作量（N=16384）不变：抗爆破强度没有降低，只是把这段计算
 * 从事件循环挪到 libuv 线程池。异步版签名相同，调用方只需 await。
 */
const scryptAsync = promisify(crypto.scrypt);

/** 生成哈希（异步）。返回 `scrypt$N$r$p$salt$hash`，格式与旧版完全一致 —— 老库可直接复用。 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(String(password), salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('hex'), hash.toString('hex')].join('$');
}

/** 校验哈希（异步）。任何异常一律当「不匹配」，不向外抛。 */
async function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[4], 'hex');
    const expected = Buffer.from(parts[5], 'hex');
    /* ★ 参数从哈希串里读，而不是用当前默认值 —— 这样将来调大 N 时，
       老用户（用旧 N 存的哈希）依然能登录。 */
    const actual = await scryptAsync(String(password), salt, expected.length, {
      N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]),
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ── 会话 ───────────────────────────────────────────────── */

const ttlMs = () => config.sessionTtlHours * 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();

/**
 * 滑动续期的**最小写库间隔**（v4.3.2 需求 3）。
 *
 * 原来是「每个请求都 UPDATE 一次 sessions」。这在 Docker（镜像层在本地磁盘）里
 * 感觉不出来，但打包成 fpk 原生形态后，数据目录落在 NAS 的共享目录上 ——
 * 那里可能是 mergerfs / FUSE 存储池，单次 fsync 是几十毫秒级；
 * 而前端每 12 秒轮询一次、一次轮询要打四五个接口，于是**每秒都在落盘**，
 * 表现就是「点一下要等一下」的界面卡顿。
 *
 * 60 秒的节流对功能没有任何影响：会话有效期是 24 小时（默认），
 * 续期只是把「到期时间」往后推 —— 晚推 60 秒在 24 小时的尺度上完全无感，
 * 而写库次数直接降到原来的 1/10 以下（一个正在使用的页面每分钟最多写 1 次）。
 */
const RENEW_MIN_MS = 60 * 1000;

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expires = iso(now + ttlMs());
  db.run(
    'INSERT INTO sessions (token, user_id, created_at, last_seen_at, expires_at) VALUES (?,?,?,?,?)',
    [token, userId, iso(now), iso(now), expires],
  );
  // 同一用户保留最近 N 台设备，超出踢掉最久未用的
  const keep = db.all('SELECT token FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC', [userId]);
  for (const row of keep.slice(config.maxSessionsPerUser)) {
    db.run('DELETE FROM sessions WHERE token = ?', [row.token]);
  }
  return { token, expiresAt: expires };
}

/** 校验 token 并滑动续期；无效/过期返回 null */
function resolveSession(token) {
  if (!token) return null;
  const row = db.get(
    `SELECT s.expires_at, s.last_seen_at, s.records_unlocked_key,
            u.id, u.username, u.display_name, u.is_admin, u.record_lock_enabled,
            u.record_lock_hash, u.notify_email, u.push_channel,
            u.avatar, u.theme, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`,
    [token],
  );
  if (!row) return null;
  const now = Date.now();
  if (new Date(row.expires_at).getTime() <= now) {
    db.run('DELETE FROM sessions WHERE token = ?', [token]);
    return null;
  }
  /* v4.3.2 需求 3：续期按 60 秒节流（详见 RENEW_MIN_MS 注释）。
     rows.last_seen_at 可能是 ''（老库/异常写入）→ Date.parse 得 NaN，
     用 `|| 0` 兜成 0 表示「从没记过」，于是会照常续期一次，不会卡死不续。
     读仍是一次 SELECT：**读不走 fsync，可以每请求都做**；
     贵的是写。节流只作用于写。 */
  const seenMs = Date.parse(row.last_seen_at || '') || 0;
  if (now - seenMs >= RENEW_MIN_MS) {
    db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token = ?',
      [iso(now), iso(now + ttlMs()), token]);
  }
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    is_admin: !!row.is_admin,
    notify_email: String(row.notify_email || ''),
    // v4.7.0：主动提醒走哪条通道；v4.8.0 默认值改为 auto（优先企业微信、邮件兜底）
    push_channel: String(row.push_channel || 'auto'),
    avatar: String(row.avatar || ''),
    /* ★ v4.11.0：resolveSession 是「第二个」构造 user 的地方（第一个是 publicUser）。
       往用户对象加字段时必须两处都加，否则登录后第一次 /api/me 会缺字段 ——
       和 push_channel 当年漏加是同一类 bug。 */
    theme: THEMES.includes(String(row.theme || '')) ? String(row.theme) : '',
    created_at: row.created_at,
    record_lock_enabled: !!row.record_lock_enabled,
    // 只回布尔：是「自定义访问密码」还是「复用登录密码」。哈希绝不下发。
    record_lock_custom: !!(row.record_lock_enabled && row.record_lock_hash),
    records_unlocked_key: String(row.records_unlocked_key || ''),
  };
}

function destroySession(token) {
  if (token) db.run('DELETE FROM sessions WHERE token = ?', [token]);
}

function pruneExpiredSessions() {
  return db.run('DELETE FROM sessions WHERE expires_at <= ?', [iso(Date.now())]).changes;
}

/* ── 账号 ───────────────────────────────────────────────── */

const USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{2,20}$/;

function assertCredentials({ username, password, display_name }, { needDisplayName }) {
  if (!USERNAME_RE.test(String(username || ''))) {
    throw Object.assign(new Error('用户名需为 2-20 位中英文、数字或下划线'), { status: 400 });
  }
  if (String(password || '').length < 6) {
    throw Object.assign(new Error('密码至少 6 位'), { status: 400 });
  }
  if (needDisplayName) {
    const name = String(display_name || '').trim();
    if (name.length < 1 || name.length > 20) {
      throw Object.assign(new Error('昵称需为 1-20 个字符'), { status: 400 });
    }
  }
}

function userCount() {
  return db.get('SELECT COUNT(*) AS n FROM users').n;
}

/* v4.11.0：界面主题。主题只是一组 CSS 变量的名字，
   服务端只负责「记住这个人选了哪套」，不关心它长什么样 ——
   这样以后加主题只要改前端两处（色板 + 选择卡片），不用动数据库。
   ★ 白名单校验：脏值一律拒（400），免得前端拿到一个没有对应色板的类名、
     整页退化成无色可用的默认样式。 */
const THEMES = ['forest', 'paper', 'ocean'];
const DEFAULT_THEME = 'paper';

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    is_admin: !!row.is_admin,
    notify_email: String(row.notify_email || ''),
    push_channel: String(row.push_channel || 'auto'),
    avatar: String(row.avatar || ''),
    /* 空串 = 还没选过。前端见到空串就用默认主题，
       这样「老用户第一次登录」和「用户主动选了默认主题」在前端表现一致。 */
    theme: THEMES.includes(String(row.theme || '')) ? String(row.theme) : '',
    created_at: row.created_at,
  };
}

async function register({ username, display_name, password }) {
  assertCredentials({ username, display_name, password }, { needDisplayName: true });
  const isFirst = userCount() === 0;
  if (!isFirst && !config.allowRegister) {
    throw Object.assign(new Error('本空间已关闭自助注册，请联系管理员'), { status: 403 });
  }
  const exists = db.get('SELECT id FROM users WHERE username = ?', [String(username).trim()]);
  if (exists) {
    throw Object.assign(new Error('该用户名已被使用'), { status: 409 });
  }
  const now = iso(Date.now());
  const res = db.run(
    'INSERT INTO users (username, display_name, password_hash, is_admin, created_at) VALUES (?,?,?,?,?)',
    [String(username).trim(), String(display_name).trim(), await hashPassword(password), isFirst ? 1 : 0, now],
  );
  /* ★ v4.20.0（审查 W-6）：创建**第一个**管理员后自动关闭自助注册。
     原来默认是开的：家里第一个人建完管理员，任何知道地址的访客都能注册进来，
     而待办/动态/记录本/账单默认 visibility='family' —— 「家庭隐私」这个产品承诺
     的默认状态其实是「对陌生人开放」。叠加当时的备份越权（C-1），
     一条 GET 就能把全库拿走。
     现在：首个人进来即关门，管理员想加人就去「家庭设置 → 允许自助注册」重新打开
     （或直接由管理员给家人建账号）。**已存在成员的老库不受影响** —— 这段只在
     isFirst 为真时执行，不会把别人已经打开的开关注销掉。 */
  if (isFirst) {
    db.run("INSERT INTO settings (key, value) VALUES ('allow_register','0') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    config.allowRegister = false;
  }
  const user = db.get('SELECT * FROM users WHERE id = ?', [res.lastInsertRowid]);
  return publicUser(user);
}

/* ── 登录失败退避（v4.20.0，审查 S-2）──────────────────────
 *
 * 为什么要它：scrypt 单次 40~80ms，本身就有速率上限，但没有**失败计数**，
 * 攻击者可以长期低速跑字典（家庭密码多为 123456 / 生日 / 手机号尾号），
 * 每小时几千次、跑一个月也撞不到任何阻碍。
 *
 * 设计取舍（家庭场景，故意保守）：
 *   · key = 用户名 + IP。只按用户名会被「故意输错 5 次」把家人锁在门外（家庭内网，
 *     谁都知道谁的账号），只按 IP 又挡不住换 IP。两者组合最贴近真实威胁。
 *   · 连续 5 次失败 → 该组合锁 10 分钟；期间即使密码正确也拒绝（否则退避没有意义）。
 *   · 成功登录即清零。**不锁账号**、不写库（重启即清空）—— 与企微 MsgId 去重
 *     同一档的「够用就好」设计，不为了一个家庭应用引入持久化风控。
 *   · 表有上限：超过 5000 条就清掉已过期的条目，防止被随机用户名撑爆内存。
 */
const LOGIN_FAIL = new Map();          // key → { n, until }
const LOGIN_FAIL_MAX = 5;
const LOGIN_LOCK_MS = 10 * 60 * 1000;
const LOGIN_MAP_SOFT_CAP = 5000;

const loginKey = (username, ip) => `${String(username || '').trim().toLowerCase()}|${String(ip || '')}`;

/** 测试用：清空失败计数（生产代码不要调用） */
function resetLoginFail() { LOGIN_FAIL.clear(); }

function pruneLoginFail(now) {
  if (LOGIN_FAIL.size <= LOGIN_MAP_SOFT_CAP) return;
  for (const [k, v] of LOGIN_FAIL) {
    if (!v.until || v.until <= now) LOGIN_FAIL.delete(k);
  }
}

/**
 * 登录。第二个参数是来源 IP（server.js 传入；测试可不传 → 用 ''）。
 * 失败时抛 401（不区分「用户不存在」与「密码错误」，防枚举）；
 * 被退避挡住时抛 429 并给出还要等几分钟。
 */
async function login({ username, password }, ip) {
  const key = loginKey(username, ip);
  const now = Date.now();
  const rec = LOGIN_FAIL.get(key);
  if (rec && rec.until && rec.until > now) {
    const mins = Math.max(1, Math.ceil((rec.until - now) / 60000));
    throw Object.assign(
      new Error(`密码错误次数过多，请 ${mins} 分钟后再试`),
      { status: 429, code: 'LOGIN_LOCKED' },
    );
  }
  const row = db.get('SELECT * FROM users WHERE username = ?', [String(username || '').trim()]);
  // 不区分「用户不存在」与「密码错误」，避免账号枚举
  const ok = !!row && await verifyPassword(password, row.password_hash);
  if (!ok) {
    const n = (rec && !rec.until ? rec.n : 0) + 1;
    if (n >= LOGIN_FAIL_MAX) {
      LOGIN_FAIL.set(key, { n, until: now + LOGIN_LOCK_MS });
      pruneLoginFail(now);
    } else {
      LOGIN_FAIL.set(key, { n, until: 0 });
    }
    throw Object.assign(new Error('用户名或密码不正确'), { status: 401 });
  }
  LOGIN_FAIL.delete(key);   // 成功即清零，别让一次手抖影响下一次
  return publicUser(row);
}

async function changeOwnPassword(userId, { old_password, new_password }) {
  const row = db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!row || !await verifyPassword(old_password, row.password_hash)) {
    throw Object.assign(new Error('当前密码不正确'), { status: 401 });
  }
  if (String(new_password || '').length < 6) {
    throw Object.assign(new Error('新密码至少 6 位'), { status: 400 });
  }
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(new_password), userId]);
  // 改密后清掉其它设备的会话，只保留当前这台（由调用方决定是否保留）
  db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

/** 管理员为家庭成员重置密码（家庭场景没有邮件服务，这是最实用的找回方式） */
async function adminResetPassword(actor, targetUserId, newPassword) {
  if (!actor.is_admin) {
    throw Object.assign(new Error('只有管理员可以重置他人密码'), { status: 403 });
  }
  const target = db.get('SELECT * FROM users WHERE id = ?', [targetUserId]);
  if (!target) throw Object.assign(new Error('成员不存在'), { status: 404 });
  if (String(newPassword || '').length < 6) {
    throw Object.assign(new Error('新密码至少 6 位'), { status: 400 });
  }
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(newPassword), targetUserId]);
  db.run('DELETE FROM sessions WHERE user_id = ?', [targetUserId]);
  return publicUser(target);
}

/**
 * v4.10.0：管理员删除成员（前端有二次确认弹窗，这里做服务端兜底）。
 * · 不能删自己（否则「最后一个管理员把自己删了」这类事故没有任何回旋余地）；
 * · 不能删最后一个管理员（删完家庭就没人管了）；
 * · 该成员的数据随外键 ON DELETE CASCADE 一并清除（待办/动态/记录/账单/会话/偏好…），
 *   ai_logs.user_id 无外键，行保留但不再指向任何人 —— 审计日志不随人消失是有意的。
 */
function deleteMember(actor, targetUserId) {
  if (!actor.is_admin) {
    throw Object.assign(new Error('只有管理员可以删除成员'), { status: 403 });
  }
  const target = db.get('SELECT * FROM users WHERE id = ?', [targetUserId]);
  if (!target) throw Object.assign(new Error('成员不存在'), { status: 404 });
  if (target.id === actor.id) {
    throw Object.assign(new Error('不能删除自己的账号'), { status: 400 });
  }
  if (target.is_admin) {
    const admins = db.get('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').n;
    if (Number(admins) <= 1) {
      throw Object.assign(new Error('这是最后一个管理员，不能删除'), { status: 400 });
    }
  }
  db.run('DELETE FROM users WHERE id = ?', [targetUserId]);
  return { id: target.id, username: target.username, displayName: target.display_name };
}

function updateProfile(userId, { display_name }) {
  const name = String(display_name || '').trim();
  if (name.length < 1 || name.length > 20) {
    throw Object.assign(new Error('昵称需为 1-20 个字符'), { status: 400 });
  }
  db.run('UPDATE users SET display_name = ? WHERE id = ?', [name, userId]);
  return publicUser(db.get('SELECT * FROM users WHERE id = ?', [userId]));
}

/**
 * 修改自己的登录账号（v1.9.0）。
 *
 * ★ 用户名**不参与会话**（会话表只存 user_id），所以改名后当前登录态不受影响，
 *   其它设备也不需要重新登录 —— 这一点与改密码不同，这里刻意不踢会话。
 * ★ 但仍然要求验证当前密码：用户名是登录凭据的一半，被同一屋檐下的人顺手改掉就等于锁死账号。
 * ★ 与注册共用同一条 USERNAME_RE 与唯一性检查，不允许两处规则不同。
 */
async function changeUsername(userId, { username, password }) {
  const next = String(username == null ? '' : username).trim();
  const row = db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!row) throw Object.assign(new Error('用户不存在'), { status: 404 });
  if (next === row.username) return publicUser(row);   // 没变就是成功，别报「已被使用」这种假错
  if (!USERNAME_RE.test(next)) {
    throw Object.assign(new Error('用户名需为 2-20 位中英文、数字或下划线'), { status: 400 });
  }
  if (!await verifyPassword(password, row.password_hash)) {
    throw Object.assign(new Error('当前密码不正确'), { status: 401 });
  }
  const exists = db.get('SELECT id FROM users WHERE username = ? AND id != ?', [next, userId]);
  if (exists) throw Object.assign(new Error('该用户名已被使用'), { status: 409 });
  db.run('UPDATE users SET username = ? WHERE id = ?', [next, userId]);
  return publicUser(db.get('SELECT * FROM users WHERE id = ?', [userId]));
}

/** 设置本人的提醒收件邮箱；传空即取消 */
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
function setNotifyEmail(userId, email) {
  const addr = String(email || '').trim();
  if (addr && (!EMAIL_RE.test(addr) || addr.length > 254)) {
    throw Object.assign(new Error('邮箱格式不正确'), { status: 400 });
  }
  db.run('UPDATE users SET notify_email = ? WHERE id = ?', [addr, userId]);
  return publicUser(db.get('SELECT * FROM users WHERE id = ?', [userId]));
}

/**
 * 设置本人的「主动提醒通道」（v4.7.0 需求 2，v4.8.0 需求 4 调整默认）。
 *   auto  **默认**：优先企业微信，发不出去（没绑定 / 应用没启用 / 发送失败）回退邮件
 *   mail  只发邮件（明确不想要企业微信消息的人）
 *   both  两条都发
 * 非法值一律拒绝，而不是悄悄改成默认 —— 用户以为改了、实际没改是最难查的问题。
 * ★ v4.13.0：'wecom' 变成正式取值 = **仅企业微信**（失败不回退邮件）。
 *   以前它是 v4.7.0 的旧值、被折成 'auto'；现在直接落库。
 */
const PUSH_CHANNELS = ['auto', 'wecom', 'mail', 'both', 'feishu', 'dingtalk'];
function setPushChannel(userId, channel) {
  const ch = String(channel == null ? '' : channel).trim().toLowerCase();
  if (!PUSH_CHANNELS.includes(ch)) {
    throw Object.assign(new Error('推送方式只能是 auto / wecom / feishu / dingtalk / mail / both'), { status: 400 });
  }
  db.run('UPDATE users SET push_channel = ? WHERE id = ?', [ch, userId]);
  return publicUser(db.get('SELECT * FROM users WHERE id = ?', [userId]));
}

/**
 * 设置本人的界面主题（v4.11.0）。
 * 只接受 THEMES 里的三个值；返回更新后的公开用户对象，
 * 前端据此刷新头像/昵称/主题三处状态，不需要再拉一次 /api/me。
 */
function setTheme(userId, theme) {
  const t = String(theme == null ? '' : theme).trim().toLowerCase();
  if (!THEMES.includes(t)) {
    throw Object.assign(new Error(`主题只能是 ${THEMES.join(' / ')}`), { status: 400 });
  }
  db.run('UPDATE users SET theme = ? WHERE id = ?', [t, userId]);
  return publicUser(db.get('SELECT * FROM users WHERE id = ?', [userId]));
}

/**
 * 设置本人的头像。
 * path 必须是本站上传目录里的图片路径（/api/media/xxx），传空串表示恢复为默认的
 * 「昵称首字色块」。这里只接受服务端自己签发的路径形状，避免把任意外链写进库里。
 */
const AVATAR_PATH_RE = /^\/api\/media\/[A-Za-z0-9._-]{1,120}$/;
function setAvatar(userId, path) {
  const p = String(path == null ? '' : path).trim();
  if (p && !AVATAR_PATH_RE.test(p)) {
    throw Object.assign(new Error('头像地址不合法'), { status: 400 });
  }
  db.run('UPDATE users SET avatar = ? WHERE id = ?', [p, userId]);
  return publicUser(db.get('SELECT * FROM users WHERE id = ?', [userId]));
}

/* ── 记录本访问密码 ─────────────────────────────────────── */
/**
 * 记录本可单独上锁：复用登录密码，或设置一个自定义访问密码。
 * 开/关之后该用户所有会话的解锁状态归零，需要重新输入密码。
 */

const err400 = (msg) => Object.assign(new Error(msg), { status: 400 });
const err401 = (msg) => Object.assign(new Error(msg), { status: 401 });

/** 当前会话用户形状（供 /api/me 与设置接口返回，含锁状态；解锁态由前端 sessionStorage 持有） */
function sessionUser(row) {
  return {
    ...publicUser(row),
    record_lock_enabled: !!row.record_lock_enabled,
    // 当前是「自定义访问密码」还是「复用登录密码」——只回布尔，不回哈希
    record_lock_custom: !!(row.record_lock_enabled && row.record_lock_hash),
  };
}

/**
 * 校验「记录本访问密码」。
 * v1.7.0：**自定义访问密码与登录密码任一匹配即通过**。
 * 以前是「设了自定义密码就只认自定义密码」，家人忘了自定义密码就被自己的记录本挡在门外
 * （明明人已经登录进来了）；现在登录密码始终是一把备用钥匙。
 */
async function verifyRecordPassword(row, password) {
  const pw = String(password || '');
  if (!pw) return false;
  if (row.record_lock_hash && await verifyPassword(pw, row.record_lock_hash)) return true;
  return verifyPassword(pw, row.password_hash);
}

/**
 * 开启 / 修改 / 关闭记录本访问密码。
 *  未开启时 enabled=true → 首次开启：mode 'login' 需输入登录密码确认；mode 'custom' 直接设至少 4 位新密码。
 *  已开启时 enabled=true → **修改**：必须先通过 currentPassword（原访问密码 **或** 登录密码），
 *                          再按 mode 决定改成自定义密码还是回头复用登录密码。
 *  enabled=false         → 关闭：同样验证原访问密码或登录密码。
 */
async function setRecordLock(userId, { enabled, mode, password, currentPassword }) {
  const row = db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!row) throw Object.assign(new Error('用户不存在'), { status: 404 });

  if (enabled) {
    const changing = !!row.record_lock_enabled;
    // 已上锁时再点「保存」= 修改访问密码，必须先证明你进得来
    if (changing && !await verifyRecordPassword(row, currentPassword)) {
      throw err401('原访问密码或登录密码不正确，无法修改');
    }
    if (mode === 'custom') {
      if (String(password || '').length < 4) throw err400('自定义访问密码至少 4 位');
      db.run('UPDATE users SET record_lock_enabled = 1, record_lock_hash = ? WHERE id = ?',
        [await hashPassword(String(password)), userId]);
    } else {
      // 复用登录密码：首次开启要验证登录密码；修改时上面已经验证过（原访问密码或登录密码）
      if (!changing && !await verifyPassword(String(password || ''), row.password_hash)) {
        throw err401('登录密码不正确，无法开启');
      }
      db.run("UPDATE users SET record_lock_enabled = 1, record_lock_hash = '' WHERE id = ?", [userId]);
    }
  } else {
    if (!await verifyRecordPassword(row, currentPassword)) throw err401('密码不正确，无法关闭');
    db.run("UPDATE users SET record_lock_enabled = 0, record_lock_hash = '' WHERE id = ?", [userId]);
  }
  db.run("UPDATE sessions SET records_unlocked_key = '' WHERE user_id = ?", [userId]);
  return db.get('SELECT * FROM users WHERE id = ?', [userId]);
}

/**
 * 校验解锁密码；通过则给当前会话签发一把「页面会话级」解锁 key。
 * 客户端把它存在 sessionStorage（关页面即清空），之后每个请求带 x-records-key 头。
 * key 已存在则复用，避免同一会话多开标签页时互相把对方的凭证作废。
 */
async function unlockRecords(token, userId, password) {
  const row = db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!row) throw Object.assign(new Error('用户不存在'), { status: 404 });
  if (!await verifyRecordPassword(row, password)) throw err401('密码不正确');
  const sess = db.get('SELECT records_unlocked_key FROM sessions WHERE token = ?', [token]);
  const existing = sess && String(sess.records_unlocked_key || '');
  const key = existing || crypto.randomBytes(16).toString('hex');
  if (!existing) db.run('UPDATE sessions SET records_unlocked_key = ? WHERE token = ?', [key, token]);
  return key;
}

function listMembers() {
  return db.all('SELECT * FROM users ORDER BY id')
    .map((row) => ({ ...publicUser(row), record_lock_enabled: !!row.record_lock_enabled }));
}

/**
 * 管理员处理家庭成员的「记录本访问密码」——成员把自定义密码忘了时的兜底。
 *  - action 'reset'：清掉自定义访问密码，改为复用登录密码（原本没开启则一并开启）
 *  - action 'off'  ：直接关闭记录本访问密码
 * 两种操作都会让该成员所有会话已持有的解锁凭证失效，需要重新输入密码。
 */
function adminSetRecordLock(actor, targetUserId, action) {
  if (!actor.is_admin) {
    throw Object.assign(new Error('只有管理员可以管理他人的访问密码'), { status: 403 });
  }
  const target = db.get('SELECT * FROM users WHERE id = ?', [targetUserId]);
  if (!target) throw Object.assign(new Error('成员不存在'), { status: 404 });
  if (action === 'reset') {
    db.run("UPDATE users SET record_lock_enabled = 1, record_lock_hash = '' WHERE id = ?", [targetUserId]);
  } else if (action === 'off') {
    db.run("UPDATE users SET record_lock_enabled = 0, record_lock_hash = '' WHERE id = ?", [targetUserId]);
  } else {
    throw Object.assign(new Error('未知操作'), { status: 400 });
  }
  db.run("UPDATE sessions SET records_unlocked_key = '' WHERE user_id = ?", [targetUserId]);
  const row = db.get('SELECT * FROM users WHERE id = ?', [targetUserId]);
  return { ...publicUser(row), record_lock_enabled: !!row.record_lock_enabled };
}

/* ── Cookie ─────────────────────────────────────────────── */

function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key) out[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function isSecureRequest(req) {
  if (req.socket && req.socket.encrypted) return true;
  if (!config.trustProxy) return false;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https';
}

function cookieValue(req) {
  return parseCookies(req.headers.cookie)[COOKIE_NAME] || '';
}

function buildCookie(value, maxAgeSeconds, secure) {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

const setSessionCookie = (res, req, token) =>
  res.setHeader('Set-Cookie', buildCookie(token, config.sessionTtlHours * 3600, isSecureRequest(req)));

const clearSessionCookie = (res, req) =>
  res.setHeader('Set-Cookie', buildCookie('', 0, isSecureRequest(req)));

module.exports = {
  COOKIE_NAME,
  // v4.3.2 需求 3：滑动续期的写库节流窗口（测试据此断言「不是每请求都写」）
  RENEW_MIN_MS,
  // v4.20.0：登录失败退避的阈值（测试据此断言第 N 次被锁）
  LOGIN_FAIL_MAX,
  LOGIN_LOCK_MS,
  resetLoginFail,
  hashPassword,
  verifyPassword,
  createSession,
  resolveSession,
  destroySession,
  pruneExpiredSessions,
  register,
  login,
  changeOwnPassword,
  adminResetPassword,
  adminSetRecordLock,
  deleteMember,
  updateProfile,
  changeUsername,
  setPushChannel,
  PUSH_CHANNELS,
  setTheme,
  THEMES,
  DEFAULT_THEME,
  setNotifyEmail,
  setAvatar,
  listMembers,
  sessionUser,
  setRecordLock,
  unlockRecords,
  publicUser,
  userCount,
  cookieValue,
  setSessionCookie,
  clearSessionCookie,
  parseCookies,
  isSecureRequest,
};
