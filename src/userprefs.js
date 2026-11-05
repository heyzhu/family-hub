'use strict';
/**
 * 个人通知偏好（v2.0.0）。
 *
 * 背景：v1.5.0～v1.9.0 的「待办提醒 / 内容通知」开关全都在**管理员**手上，
 * 非管理员只能被动接受。现实是每个人想被怎么打扰完全不一样：
 * 爸爸想每天收待办、不想看动态通知；妈妈相反。所以这一版把「收不收、收哪些、
 * 什么时间别吵我」下放给每个人自己设。
 *
 * ★ 关键约定：个人设置只能「收窄」，不能「放大」。
 *   管理员把某一类通知的总开关关掉之后，个人再打开也收不到 ——
 *   否则「管理员关掉了通知」这件事就形同虚设，出事时也说不清是谁的决定。
 *   所以调用方必须**两层都判**：先判全局（notify.isEnabled / cfg.remindEnabled），
 *   再用本模块判个人。
 *
 * ★ 存储：settings 表是全局的，不能拿来存个人偏好，所以单开一张
 *   `user_prefs(user_id, key, value)`（key/value 与 settings 同款思路：
 *   以后再加偏好项不用改表结构）。
 *
 * ★ 「跟随全局」的表示法：**这一行不存在**（或值写成空串）就表示没表过态、
 *   跟随管理员的设置。这样老库升级后所有人的行为与升级前完全一致 ——
 *   不会因为多了个默认值就把谁的通知悄悄关掉。
 */
const { db } = require('./db');

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/* 可被个人覆盖的键。前 4 个与 notify.js 的 ALL_KINDS / 后端设置键一一对应。 */
const KEYS = [
  'remind_enabled',        // '0' / '1'；不存在 = 跟随全局
  'remind_quiet_start',    // HH:MM；不存在/空 = 个人不额外免打扰
  'remind_quiet_end',
  /* v4.23.0 需求 1：个人默认提醒时间。
     ★ 它**只影响「新建待办」表单的预填**，不参与服务端调度 ——
       同一条待办对所有收件人仍然是同一个提醒时刻（理由见文件末尾那段注释）。
       个人留空 = 跟随管理员的 settings.remind_default_time。 */
  'remind_default_time',
  'notify_on_change',      // '0' / '1'；不存在 = 跟随全局
  'notify_kinds',          // 逗号分隔 todo,post,record,comment；不存在 = 跟随全局
  'notify_quiet_start',
  'notify_quiet_end',
  /* v4.25.0 需求 4：三类推送内容各自的**推送渠道**（待办 / 内容 / 记账）。
     值 = push.CHANNELS 里的一个；不存在或空串 = 沿用「我的推送方式」（push_channel）。
     ★ 这里不 require push：push → db 单向，反过来会成环（push 要在发消息时读它）。
       所以常量在本文件复制一份，`_verify/api.test.js` 有断言盯着两份不许分叉。 */
  'channel_todo',
  'channel_notify',
  'channel_bill',
];

/* 与 push.CHANNELS 必须一致（断言在同一条测试里）。'' = 继承全局推送方式。 */
const CHANNEL_VALUES = ['auto', 'wecom', 'mail', 'both', 'feishu', 'dingtalk'];
const CHANNEL_KEYS = ['channel_todo', 'channel_notify', 'channel_bill'];

/* 与 notify.ALL_KINDS 必须一致。
   这里刻意复制一份而不是 require('./notify')：notify → reminders → userprefs 已经是一条链，
   反过来 require 会形成循环依赖，在 Node 里表现为「某个模块拿到的是半成品 exports」。
   `_verify/api.test.js` 里有一条断言专门盯着这两个常量不许分叉。 */
const ALL_KINDS = ['todo', 'post', 'record', 'comment'];

/** 读取某人的全部个人偏好（只回带值的键；没有的键 = 跟随全局） */
function load(userId) {
  const out = {};
  const id = Number(userId);
  if (!Number.isFinite(id) || id <= 0) return out;
  for (const r of db.all('SELECT key, value FROM user_prefs WHERE user_id = ?', [id])) {
    if (KEYS.indexOf(r.key) < 0) continue;
    out[r.key] = String(r.value == null ? '' : r.value);
  }
  return out;
}

/**
 * 读取全家人的偏好，key 是 user_id。
 * 通知是「一次动作要算一串收件人」，逐个查库会让收件人一多就 N 次查询；
 * 这里一次全取回来，收件人判定全在内存里做。
 */
function loadAll() {
  const map = new Map();
  for (const r of db.all('SELECT user_id, key, value FROM user_prefs')) {
    if (KEYS.indexOf(r.key) < 0) continue;
    const id = Number(r.user_id);
    if (!map.has(id)) map.set(id, {});
    map.get(id)[r.key] = String(r.value == null ? '' : r.value);
  }
  return map;
}

const put = (userId, key, value) => db.run(
  'INSERT INTO user_prefs (user_id, key, value) VALUES (?,?,?) ' +
  'ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value',
  [userId, key, value],
);

const del = (userId, key) => db.run('DELETE FROM user_prefs WHERE user_id = ? AND key = ?', [userId, key]);

const fail = (msg) => Object.assign(new Error(msg), { status: 400 });

/**
 * 校验并归一化前端传来的 patch。
 * 不认识的值**直接报错**而不是静默忽略 —— 「保存成功了但没生效」是本项目最忌讳的事。
 * 同理，不在白名单里的**键**也报错：值忘了校验最多是没生效，键静默丢弃则会让
 * 前端以为自己写进去了（比如把 remind_advance_days 拼错成 remind_advance_day）。
 * @returns {object} 归一化后的 patch（值可能是 null = 删除该行）
 */
const BOOL_KEYS = { remind_enabled: '待办提醒开关', notify_on_change: '内容通知开关' };
const TIME_KEYS = ['remind_quiet_start', 'remind_quiet_end', 'notify_quiet_start', 'notify_quiet_end'];
/* v4.23.0：个人默认提醒时间（与免打扰分开校验，错误文案不同） */
const DEFAULT_TIME_KEY = 'remind_default_time';
const ALLOWED = new Set([...Object.keys(BOOL_KEYS), ...TIME_KEYS, DEFAULT_TIME_KEY, 'notify_kinds', ...CHANNEL_KEYS]);

function normalize(patch) {
  const p = patch || {};
  for (const k of Object.keys(p)) {
    if (!ALLOWED.has(k)) throw fail(`不认识的设置项：${k}`);
  }
  const out = {};
  const boolKey = (k, label) => {
    if (!(k in p)) return;
    const v = p[k];
    if (v === null || v === undefined || v === '') { out[k] = null; return; }
    if (v === true || v === '1' || v === 1) { out[k] = '1'; return; }
    if (v === false || v === '0' || v === 0) { out[k] = '0'; return; }
    throw fail(`${label}只能是「开」或「关」`);
  };
  for (const k of Object.keys(BOOL_KEYS)) boolKey(k, BOOL_KEYS[k]);

  if ('notify_kinds' in p) {
    const v = p.notify_kinds;
    if (v === null || v === undefined || v === '') { out.notify_kinds = null; }
    else {
      const arr = Array.isArray(v) ? v : String(v).split(',');
      const kinds = ALL_KINDS.filter((k) => arr.map((x) => String(x).trim()).includes(k));
      // ★ 一个都不选 = 明确「什么内容通知都不要」。这跟「没表过态」是两件事：
      //   前者要存一个非空值（'none'）把「全收」的默认顶掉，后者是这一行不存在。
      out.notify_kinds = kinds.length ? kinds.join(',') : 'none';
    }
  }

  for (const k of TIME_KEYS) {
    if (!(k in p)) continue;
    const raw = p[k];
    if (raw === null || raw === undefined) { out[k] = null; continue; }
    const v = String(raw).trim();
    if (!v) { out[k] = null; continue; }
    if (!TIME_RE.test(v)) throw fail('免打扰时间需要是 HH:MM 格式（例如 22:00），留空表示不启用');
    out[k] = v;
  }

  /* v4.23.0 需求 1：个人默认提醒时间。留空 = 跟随管理员（删掉这一行）。 */
  if (DEFAULT_TIME_KEY in p) {
    const raw = p[DEFAULT_TIME_KEY];
    if (raw === null || raw === undefined) { out[DEFAULT_TIME_KEY] = null; }
    else {
      const v = String(raw).trim();
      if (!v) out[DEFAULT_TIME_KEY] = null;
      else if (!TIME_RE.test(v)) throw fail('默认提醒时间需要是 HH:MM 格式（例如 08:00），留空表示跟随管理员');
      else out[DEFAULT_TIME_KEY] = v;
    }
  }

  /* v4.25.0 需求 4：三类内容各自的推送渠道。'' / 'inherit' = 删掉这一行（沿用全局推送方式）。 */
  for (const k of CHANNEL_KEYS) {
    if (!(k in p)) continue;
    const raw = p[k];
    if (raw === null || raw === undefined) { out[k] = null; continue; }
    const v = String(raw).trim().toLowerCase();
    if (!v || v === 'inherit') { out[k] = null; continue; }
    if (!CHANNEL_VALUES.includes(v)) throw fail('推送渠道只能是「沿用全局」或 ' + CHANNEL_VALUES.join(' / ') + ' 之一');
    out[k] = v;
  }

  return out;
}

/**
 * 保存个人偏好。
 * patch 里 **出现** 的键才会被写；值为 `null`/空串表示删除该行（回到跟随全局）。
 * @returns {object} 保存后的完整个人偏好
 */
function save(userId, patch) {
  const id = Number(userId);
  if (!Number.isFinite(id) || id <= 0) throw fail('用户不存在');
  const p = normalize(patch);
  for (const key of KEYS) {
    if (!(key in p)) continue;
    const v = p[key];
    if (v === null || v === undefined || v === '') { del(id, key); continue; }
    put(id, key, String(v).slice(0, 200));
  }
  return load(id);
}

/* ── 判定辅助：调用方拿 userId + 全局配置，得到「这个人到底收不收」 ── */

/** 三态布尔：true = 明确开；false = 明确关；null = 没表态（跟随全局） */
function tri(v) {
  if (v === '0') return false;
  if (v === '1') return true;
  return null;
}

/** 个人是否接收待办提醒。prefs 可传（省一次查询），也可传 null 直接查库 */
function wantsRemind(userId, prefs) {
  const p = prefs || load(userId);
  const t = tri(p.remind_enabled);
  return t === null ? true : t;           // 没表态 = 跟随全局，也就是收
}

/* ★ 刻意**不做**「个人提前天数」。
   v1.5.0 的「提前 N 天」是**每条待办**的属性来源（全局默认值 + 待办自己的 remind 字段），
   让它再被个人偏好覆盖，会出现「同一条待办对不同人不同时刻提醒」，
   排查「为什么我没收到」时几乎无法复现。这一版只下放「收不收 / 收哪些 / 何时别吵」三件事。
   ★ v4.23.0 的「个人默认提醒时间」不违反这条：它只用于**新建待办表单的预填**，
     服务端调度仍然只认全局值，同一条待办对所有收件人依旧是同一时刻。
   ★ 因此这里只**存**这个键（校验格式、落库、回读），不在服务端做「个人优先还是跟随管理员」
     的裁决 —— 那个裁决只发生在一个地方：前端 remindTimeInfo()，它同时给出标签要显示的来源。
     服务端多一份裁决就等于多一份可能与界面说不一致的口径。 */

/** 个人是否接收某一类内容变更通知 */
function wantsNotify(userId, kind, prefs) {
  const p = prefs || load(userId);
  const t = tri(p.notify_on_change);
  if (t === false) return false;
  if (p.notify_kinds === undefined || p.notify_kinds === '') return true;   // 未表态 = 全收
  return String(p.notify_kinds).split(',').map((s) => s.trim()).includes(kind);
}

/**
 * 个人免打扰时段。
 * @param {'remind'|'notify'} which
 * @returns {{start:string, end:string}} 空串表示未启用
 */
function quietOf(userId, which, prefs) {
  const p = prefs || load(userId);
  const prefix = which === 'remind' ? 'remind_quiet_' : 'notify_quiet_';
  const s = String(p[prefix + 'start'] || '');
  const e = String(p[prefix + 'end'] || '');
  return {
    start: TIME_RE.test(s) ? s : '',
    end: TIME_RE.test(e) ? e : '',
  };
}

module.exports = {
  KEYS, ALL_KINDS, TIME_RE,
  CHANNEL_KEYS, CHANNEL_VALUES,
  load, loadAll, save,
  wantsRemind, wantsNotify, quietOf,
};
