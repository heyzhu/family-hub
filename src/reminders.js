'use strict';
/**
 * 待办邮件提醒。
 *
 * 规则：
 *  - 管理员全局开关（默认开）+ 发件邮箱（SMTP）配置，保存在 settings 表；
 *  - 提醒时间：待办设有开始时间 → 当天开始时间；否则 → 管理员设置的默认提醒时间点；
 *    没有日期的待办不提醒；
 *  - ★ 时区：待办的日期+时间是家里人按「墙上时间」填的，按 settings 里的
 *    tz_offset_minutes（默认 +480 东八区）换算成 UTC 瞬时来判断是否到点。
 *    绝不能改用进程本地时区：容器默认是 UTC，会让提醒整体晚 8 小时。
 *  - 提醒对象：该待办的参与人（按昵称/用户名匹配成员）中配置了收件邮箱的人；
 *    一轮里没有可发的收件人时【不】标记为已提醒，等参与人补上邮箱后还能补发；
 *  - 一次性待办只发一次；年度重复事项【每年都发】——按「今年的落点」判断，
 *    已提醒标记存的是落点日期（remind_key），所以跨年不会被旧标记吞掉；
 *  - 服务器停机错过超过 48 小时的不再补发，避免旧事轰炸（重复事项只看当天前后各一天）。
 *  - 每轮结果都写进 lastStatus 并在管理端展示：提醒失败必须能被看见。
 */
const { db } = require('./db');
const config = require('./config');
const mailer = require('./mailer');
/* v4.7.0 需求 2：提醒不再只有邮件一条路。通道由**收件人自己**选（邮件 / 企业微信 / 两者），
   push 只依赖 db/config/wecom，不反向 require 本模块 → 不成环。 */
const push = require('./push');
const Repeat = require('../public/repeat.js');
const userprefs = require('./userprefs');
/* 日期偏移与免打扰判定放在 quiet.js（那里不依赖任何模块），
   这样 reminders ↔ quiet 不会成环。这里沿用同一份实现，不再各写一套。
   ★ 必须整体 require（不能解构出 shiftDateKey 却又在下面再定义一遍同名函数）——
   下面用到 quiet.outOfQuiet，且本模块仍要对外导出 shiftDateKey（notify / 测试都在用）。 */
const quiet = require('./quiet');
const { shiftDateKey } = quiet;
/* v4.3.3 需求 2：免打扰期间的提醒先入发件箱，到点由 outbox 合并成一封。
   依赖方向：outbox 只依赖 db / config，不会反向 require 本模块 → 不成环。 */
const outbox = require('./outbox');
/* v4.21.0 需求 1：提醒文案改成家庭级可配置模板（待办提醒 / 记录本提醒）。
   msgTpl 只依赖 db / config，不反向 require 本模块 → 不成环。 */
const msgTpl = require('./msgTpl');

const SETTINGS_DEFAULTS = {
  remind_enabled: '1',
  remind_default_time: '08:00',
  // 提前几天提醒（0-5）。0 = 当天提醒；3 = 提前 3 天。
  remind_advance_days: '0',
  tz_offset_minutes: String(config.tzOffsetMinutes),
  smtp_host: 'smtp.qq.com',
  smtp_port: '465',
  smtp_user: '',
  smtp_pass: '',
  // v1.9.0：内容变更提醒的发送时机。空串是「合法取值」，表示立即发送 / 不启用免打扰，
  // 所以默认值就是空串，且不要用 `||` 把空串替换掉。
  // ★ v4.14.0 需求 4：「汇总时间」（notify_digest_time）已下线，只剩免打扰。
  //   老库里的这一行原样留着但不再读取 —— 不设免打扰 = 有变更即发，
  //   正是新口径；不写迁移也就不存在「升级时把谁的配置改坏」的风险。
  notify_quiet_start: '',
  notify_quiet_end: '',
  /* ★ v4.15.0 需求 8：防轰炸阈值从写死的 20 封/分改成可配（1–500）。
     空串/非法值一律按 20 处理 —— 这是「防轰炸」的最后一道闸，不能被脏配置关掉。 */
  notify_max_per_min: '20',
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/** 提前天数只允许 0-5，其它一律按 0 处理（不合法就当没设，避免提醒跑飞） */
function clampAdvanceDays(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= 5 ? n : 0;
}

/**
 * 一条待办**实际生效**的提前天数（v4.22.0 需求 1）。
 *
 * 优先级：待办自己的 0–5 > 家庭设置。
 * -1 / 空 / 脏值 = 跟随家庭设置（老数据全是 -1，升级后行为与升级前一致）。
 * ★ 这是「单条覆盖全局」的唯一判定点：界面上的「下次提醒」与扫描器真正发信
 *   必须都走它，否则会出现「列表写着提前 2 天、实际按全局 0 天发」。
 */
function advanceOf(todo, fallback) {
  const n = Number(todo && todo.remind_advance_days);
  return Number.isInteger(n) && n >= 0 && n <= 5 ? n : clampAdvanceDays(fallback);
}

/** 读取提醒相关配置（每次扫描都读，管理员改完立即生效） */
function loadRemindSettings() {
  const map = { ...SETTINGS_DEFAULTS };
  for (const r of db.all('SELECT key, value FROM settings')) {
    if (r.key in map) map[r.key] = String(r.value);
  }
  const off = Math.round(Number(map.tz_offset_minutes));
  return {
    remindEnabled: map.remind_enabled !== '0',
    remindDefaultTime: TIME_RE.test(map.remind_default_time) ? map.remind_default_time : '08:00',
    remindAdvanceDays: clampAdvanceDays(map.remind_advance_days),
    // 时区偏移（分钟）：待办上的「日期 + 时间」按这个偏移理解，与服务器所在时区无关
    tzOffsetMinutes: Number.isFinite(off) && off >= -720 && off <= 840 ? off : config.tzOffsetMinutes,
    smtpHost: map.smtp_host.trim() || 'smtp.qq.com',
    smtpPort: Math.min(Math.max(Number(map.smtp_port) || 465, 1), 65535),
    smtpUser: map.smtp_user.trim(),
    smtpPass: map.smtp_pass,
    // v1.9.0：内容变更提醒的时机。非法值一律当「没设」，绝不让脏配置把通知全吞掉。
    // v4.14.0：汇总时间已下线，这里只留免打扰（空 = 有变更就立刻发）。
    notifyQuietStart: TIME_RE.test(map.notify_quiet_start) ? map.notify_quiet_start : '',
    notifyQuietEnd: TIME_RE.test(map.notify_quiet_end) ? map.notify_quiet_end : '',
    // v4.15.0 需求 8：防轰炸阈值（每分钟最多几封），1–500，非法按 20
    notifyMaxPerMin: clampMaxPerMin(map.notify_max_per_min),
  };
}

/** 防轰炸阈值：只接受 1–500 的整数，其它一律回到默认 20（不能让脏配置把闸门关掉） */
function clampMaxPerMin(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 500 ? n : 20;
}

/**
 * 「提前 N 天」在墙上日期上的落点：把事项自己的日期往前挪 N 天，时刻不变。
 * 只做字符串/日历运算，和时区无关，所以前端也能安全复用它来显示「下次提醒」。
 */
function remindWallKey(dateKey, advanceDays) {
  const key = String(dateKey || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return '';
  return shiftDateKey(key, -clampAdvanceDays(advanceDays));
}

/**
 * 计算某条待办的提醒时点（UTC 瞬时）；无法确定返回 null。
 *
 * 待办上的 todo_date / start_time 是家里人填的「墙上时间」（默认北京时间），
 * 所以先把它们当成 UTC 拼出来，再减掉时区偏移，得到真正的 UTC 瞬时。
 * 这样容器是 UTC 还是别的时区都不影响提醒时刻。
 *
 * ★ advanceDays：「提前 N 天提醒」要把日期整体前移 N 天（时刻不变）。
 *   提醒时刻、邮件正文里显示的「事项时间」、以及调度判定是否到点，
 *   必须全部走这一个函数，否则会出现「设置里写了提前 3 天、实际还是当天才发」。
 */
function localRemindMoment(todo, defaultTime, tzOffsetMinutes = config.tzOffsetMinutes, advanceDays = 0) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(todo.todo_date || ''));
  if (!m) return null;
  const time = TIME_RE.test(String(todo.start_time || '')) ? todo.start_time : defaultTime;
  if (!TIME_RE.test(String(time || ''))) return null;
  const days = clampAdvanceDays(advanceDays);
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    - days * 86400000
    + Number(time.slice(0, 2)) * 3600000
    + Number(time.slice(3, 5)) * 60000;
  const d = new Date(wall - Number(tzOffsetMinutes || 0) * 60000);
  return Number.isNaN(d.getTime()) ? null : d;
}

const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * v4.12.0 需求（记录本模块）：记录本提醒的「下一次提醒时刻」。
 *
 * 记录本里的记录**没有到期日**（它是「长期保存的信息」），所以锚点只能是保存那一刻：
 *   · 保存当天的 remind_time 还没到 → 就今天那个时刻
 *   · 已经过了 → 顺延到次日同一时刻
 *   · 再按「提前 N 天」往前挪（想提前准备的人用），但绝不把时刻挪到过去
 *     —— 否则刚保存就会立刻弹一条提醒，比不提醒更烦。
 * 返回 UTC ISO 字符串；算不出来返回空串（调用方按「不提醒」处理）。
 */
function recordRemindMoment(timeIn, advanceIn, now = new Date()) {
  const cfg = loadRemindSettings();
  const tz = cfg.tzOffsetMinutes;
  const time = TIME_RE.test(String(timeIn || '')) ? String(timeIn) : cfg.remindDefaultTime;
  const n = Number(advanceIn);
  const adv = Number.isFinite(n) && n >= 0 && n <= 5 ? Math.round(n) : cfg.remindAdvanceDays;
  const today = wallDateKey(now, tz);
  const at = (key) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
    if (!m) return null;
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(time.slice(0, 2)), Number(time.slice(3, 5))) - tz * 60000);
  };
  const shifted = at(shiftDateKey(today, -adv));
  if (shifted && shifted.getTime() > now.getTime()) return shifted.toISOString();
  const next = at(shiftDateKey(today, 1));
  return next ? next.toISOString() : '';
}

/** 某个瞬时在指定时区下的「墙上日期」键（YYYY-MM-DD）——判断「今天」必须用它，
 *  绝不能用 new Date().toLocaleDateString()（那是服务器本地时区，容器里是 UTC）。 */
function wallDateKey(d = new Date(), tzOffsetMinutes = config.tzOffsetMinutes) {
  const t = new Date(d.getTime() + Number(tzOffsetMinutes || 0) * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}

/** 日期键偏移若干天 —— 实现在 quiet.js（见上方的依赖说明），这里保持同名导出。 */

/** 把 UTC 瞬时按指定偏移格式化成「北京时间」样式的文案 */
function humanDate(d, tzOffsetMinutes = config.tzOffsetMinutes) {
  const t = new Date(d.getTime() + Number(tzOffsetMinutes || 0) * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}年${t.getUTCMonth() + 1}月${t.getUTCDate()}日（星期${WEEK_CN[t.getUTCDay()]}）` +
    ` ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

/* ── 邮件模板 ───────────────────────────────────────────────
   纯文本版是「兜底」：任何客户端都能读，也是测试与排查看的正文。
   HTML 版是「好看」：不引外部图片、不用内联脚本（很多邮箱客户端会拦），
   只用表格 + 内联样式，字体与配色跟 App 主体一致（暖橙 + 米白）。
   两版一起发（multipart/alternative），收件端自己挑能显示的。
   ═══════════════════════════════════════════════════════════ */

const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const PRIO_CN = { high: '重要', normal: '普通', low: '稍后' };
const ACCENTS = {
  todo: { bar: '#d4653f', soft: '#fdeee8', text: '#b8502e' },
  post: { bar: '#3f8f74', soft: '#e8f4ef', text: '#2f7a62' },
  record: { bar: '#7a6bd4', soft: '#efecfb', text: '#5a4bb8' },
  comment: { bar: '#3f8f74', soft: '#e8f4ef', text: '#2f7a62' },
};

/**
 * 统一邮件版式。所有通知类邮件都走这里，改一次全站生效。
 * @param {{heading:string, badge?:string, intro?:string,
 *          rows?:Array<{label:string,value:string,strong?:boolean}>,
 *          quote?:{label:string,text:string},
 *          footnote?:string, kind?:string}} o
 */
function mailLayout(o) {
  const accent = ACCENTS[o.kind] || ACCENTS.todo;
  const family = escapeHtml(config.siteName);
  const rows = (o.rows || []).filter((r) => r && r.value != null && r.value !== '');
  const rowHtml = rows.map((r) => `
              <tr>
                <td style="padding:7px 0;width:88px;vertical-align:top;color:#9a9088;font-size:13px;white-space:nowrap">${escapeHtml(r.label)}</td>
                <td style="padding:7px 0;vertical-align:top;color:#322d29;font-size:14px;${r.strong ? 'font-weight:700;' : ''}">${escapeHtml(r.value)}</td>
              </tr>`).join('');
  const quote = o.quote
    ? `<div style="margin:14px 0 0;padding:11px 13px;background:#fbf9f7;border-left:3px solid ${accent.bar};border-radius:0 8px 8px 0;color:#4a443e;font-size:14px;white-space:pre-wrap;word-break:break-word">${escapeHtml(o.quote.text)}</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(o.heading)}</title></head>
<body style="margin:0;padding:0;background:#f7f4f0">
  <div style="padding:22px 14px;background:#f7f4f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 10px rgba(60,45,35,.08)">
      <div style="height:4px;background:${accent.bar}"></div>
      <div style="padding:18px 20px 0">
        <div style="font-size:12.5px;color:#9a9088;letter-spacing:.03em">🏠 ${family}</div>
        <h1 style="margin:6px 0 0;font-size:18px;line-height:1.45;color:#322d29;font-weight:700">${escapeHtml(o.heading)}</h1>
        ${o.badge ? `<div style="margin-top:9px"><span style="display:inline-block;padding:3px 9px;border-radius:999px;background:${accent.soft};color:${accent.text};font-size:12.5px">${escapeHtml(o.badge)}</span></div>` : ''}
      </div>
      <div style="padding:14px 20px 20px">
        ${o.intro ? `<p style="margin:0 0 6px;color:#6b625a;font-size:13.5px;line-height:1.65">${escapeHtml(o.intro)}</p>` : ''}
        ${rowHtml ? `<table style="width:100%;border-collapse:collapse;margin-top:6px">${rowHtml}</table>` : ''}
        ${quote}
      </div>
      <div style="padding:13px 20px;background:#fbf9f7;border-top:1px solid #e9e3db;color:#9a9088;font-size:12px;line-height:1.6">
        ${o.footnote ? `${escapeHtml(o.footnote)}<br>` : ''}本邮件由「${family}」自动发送，请勿回复。
      </div>
    </div>
  </div>
</body></html>`;
}

/**
 * 待办提醒的模板变量（v4.21.0 需求 1：文案改成可配置模板，这里是唯一取数口）。
 * ★ 时间一栏分两种情况：
 *   - 没设「提前提醒」：只显示事项本身的时间；
 *   - 设了提前 N 天：额外给一行「提醒」说明为什么今天收到（否则用户会以为发错了）。
 * ★ 重复规则统一走 db.getRepeatRule（repeat_rule 优先、旧 repeat 翻译回落）——
 *   只读 t.repeat 的话，「每天」这类只存在于新枚举的规则在邮件里会整行消失。
 */
function todoTemplateVars(t, occKey, cfg, advIn) {
  /* v4.22.0 需求 1：文案里的「提前 N 天」必须是这条待办**实际生效**的天数，
     不能继续读全局 cfg.remindAdvanceDays —— 否则单条设了提前 2 天、全局 0 天时，
     邮件里会写「到点提醒」，与实际发信时间自相矛盾。 */
  const adv = advIn == null ? cfg.remindAdvanceDays : clampAdvanceDays(advIn);
  const eventMoment = localRemindMoment(
    { todo_date: occKey, start_time: t.start_time }, cfg.remindDefaultTime, cfg.tzOffsetMinutes, 0);
  const remindMoment = localRemindMoment(
    { todo_date: occKey, start_time: t.start_time }, cfg.remindDefaultTime, cfg.tzOffsetMinutes, adv);
  let participants = [];
  try { participants = JSON.parse(t.participants || '[]'); } catch { /* 忽略 */ }
  const rule = db.getRepeatRule(t);
  const repeatLabel = rule ? (Repeat.label({ date: t.todo_date, repeat_rule: rule }) || '每年') : '';
  return {
    站名: config.siteName,
    标题: t.title,
    时间: eventMoment ? humanDate(eventMoment, cfg.tzOffsetMinutes) : occKey,
    提前提醒: (adv > 0 && remindMoment)
      ? `提醒：提前 ${adv} 天（${humanDate(remindMoment, cfg.tzOffsetMinutes)}）`
      : '',
    重复: repeatLabel,
    参与人: participants.join('、'),
    重要程度: PRIO_CN[t.priority] || '普通',
    备注: t.note || '',
  };
}

/** 默认模板的结构化 HTML 版式（自定义模板不走这里，改用 msgTpl 的品牌外壳） */
function todoMailLayoutHtml(t, occKey, cfg, advIn) {
  const adv = advIn == null ? cfg.remindAdvanceDays : clampAdvanceDays(advIn);
  const eventMoment = localRemindMoment(
    { todo_date: occKey, start_time: t.start_time }, cfg.remindDefaultTime, cfg.tzOffsetMinutes, 0);
  const remindMoment = localRemindMoment(
    { todo_date: occKey, start_time: t.start_time }, cfg.remindDefaultTime, cfg.tzOffsetMinutes, adv);
  let participants = [];
  try { participants = JSON.parse(t.participants || '[]'); } catch { /* 忽略 */ }
  const rows = [
    { label: '时间', value: eventMoment ? humanDate(eventMoment, cfg.tzOffsetMinutes) : occKey, strong: true },
    adv > 0 && remindMoment
      ? { label: '提醒', value: `提前 ${adv} 天发送（${humanDate(remindMoment, cfg.tzOffsetMinutes)}）` }
      : null,
    db.getRepeatRule(t) ? { label: '重复', value: Repeat.label({ date: t.todo_date, repeat_rule: db.getRepeatRule(t) }) || '每年' } : null,
    participants.length ? { label: '参与人', value: participants.join('、') } : null,
    { label: '重要程度', value: PRIO_CN[t.priority] || '普通' },
    t.note ? { label: '备注', value: t.note } : null,
  ].filter(Boolean);
  const badge = [
    db.getRepeatRule(t) ? '🔁 周期重复' : '',
    adv > 0 ? '⏰ 提前提醒' : '',
  ].filter(Boolean).join(' · ');
  return mailLayout({
    heading: t.title,
    badge,
    intro: '你参与的待办事项到时间了。',
    rows,
    kind: 'todo',
    footnote: '',
  });
}

/**
 * 一条待办提醒的完整消息（标题 / 纯文本 / HTML）。
 * ★ 标题与正文都来自可配置模板；默认模板渲染出来的字与 v4.20.0 完全一致。
 */
function buildMail(t, occKey, cfg, advIn) {
  const vars = todoTemplateVars(t, occKey, cfg, advIn);
  const r = msgTpl.render('todo_remind', vars);
  return {
    subject: r.subject,
    text: r.text,
    html: msgTpl.htmlFor('todo_remind', vars, { kind: 'todo' }) || todoMailLayoutHtml(t, occKey, cfg, advIn),
  };
}

/** 待办提醒的正文（纯文本）。保留旧导出，测试与其他调用方仍可用。 */
function buildMailText(t, occKey, cfg, advIn) {
  return buildMail(t, occKey, cfg, advIn).text;
}

/** 待办提醒的 HTML 版（内容与 buildMailText 一致，只是排版更好看） */
function buildMailHtml(t, occKey, cfg, advIn) {
  return buildMail(t, occKey, cfg, advIn).html;
}

/** 某个落点是否已被手动勾完（v4.21.0 需求 2；老库没有这张表时当作未完成） */
function occurrenceDone(todoId, dayKey) {
  try {
    const row = db.get(
      'SELECT 1 AS x FROM todo_done_marks WHERE todo_id = ? AND occ_date = ?',
      [Number(todoId), String(dayKey)],
    );
    return !!row;
  } catch { return false; }
}

/**
 * 最近一次扫描的结果，供管理端展示。
 * 提醒是个「到点才动」的后台行为，出了问题在界面上看不到，用户只会觉得「没发」，
 * 所以这里必须把每一轮的结果留下来。
 */
let lastStatus = {
  at: '',            // 最近一次扫描时间（ISO）
  state: 'idle',     // idle | ok | disabled | no-smtp
  checked: 0,
  sent: 0,
  recipients: 0,
  waiting: 0,        // 到点了但参与人没配收件邮箱，等待中（不会丢）
  expired: 0,        // 超过补发窗口，已放弃
  advanceDays: 0,    // 本轮生效的「提前几天」——设置有没有真正生效，看这里
  errors: [],
};

function getStatus() {
  return { ...lastStatus, errors: [...lastStatus.errors] };
}

function setStatus(patch) {
  lastStatus = { ...lastStatus, ...patch, at: new Date().toISOString() };
}

/**
 * 扫描一轮到点待办并发送提醒邮件。
 * 返回 {checked, sent, recipients, waiting, expired, skipped, errors}；
 * skipped === -1 表示全局关闭，-2 表示 SMTP 未配置。
 */
async function runScan(now = new Date()) {
  const out = {
    checked: 0, sent: 0, recipients: 0, waiting: 0, expired: 0, skipped: 0,
    // v4.3.3 需求 2：本轮因免打扰而进入发件箱的提醒条数 / 合并发出的封数
    queued: 0, flushed: 0,
    errors: [],
  };
  const cfg = loadRemindSettings();
  if (!cfg.remindEnabled) {
    out.skipped = -1;
    // 即使本轮不扫，也要把「当前生效的提前天数」写进状态：
    // 管理员在设置里改完提前天数后来看状态，看到的必须是新值，
    // 否则会以为「改了没生效」。
    setStatus({ state: 'disabled', checked: 0, sent: 0, recipients: 0, waiting: 0, expired: 0, errors: [], advanceDays: cfg.remindAdvanceDays });
    return out;
  }
  if (!cfg.smtpUser || !cfg.smtpPass) {
    /* v4.7.0：SMTP 没配**不再等于提醒全停**。只要家里有人把通道设成「企业微信」，
       提醒照样发得出去（很多家庭压根没有发件邮箱，旧逻辑把这些人一起堵死了）。
       只有「没 SMTP 且没人用企业微信」才真的无可发送。 */
    if (!push.hasWecomRecipients()) {
      // 以前这里是彻底静默的：管理员只点了「发送测试」而没点「保存」时，
      // 测试邮件能收到，待办提醒却永远不发，界面上没有任何迹象。
      out.skipped = -2;
      setStatus({ state: 'no-smtp', checked: 0, sent: 0, recipients: 0, waiting: 0, expired: 0, errors: [], advanceDays: cfg.remindAdvanceDays });
      return out;
    }
  }

  // 成员查询不再过滤「有没有邮箱」：只填了企业微信、没留邮箱的人同样要收得到提醒
  const byName = new Map();
  for (const u of db.all('SELECT id, display_name, username, notify_email, push_channel FROM users')) {
    if (!byName.has(u.display_name)) byName.set(u.display_name, u);
    if (!byName.has(u.username)) byName.set(u.username, u);
  }

  // 一次性待办：没发过、没完成、且必须在 48 小时窗口内
  // v4.10.0：repeat_rule 非空的（含「每天」）不算一次性 —— 它们走下面的重复扫描
  const oneShots = db.all(
    "SELECT * FROM todos WHERE done = 0 AND remind = 1 AND repeat = '' AND repeat_rule = ''" +
    " AND (reminded_at IS NULL AND remind_key = '')" +
    " AND todo_date IS NOT NULL AND todo_date != ''",
  );
  // 重复事项（含「每天」）：不看 done（它们本来就不参与完成状态），每个落点都发一次
  const repeats = db.all(
    "SELECT * FROM todos WHERE remind = 1 AND (repeat != '' OR repeat_rule != '')" +
    " AND todo_date IS NOT NULL AND todo_date != ''",
  );

  const todayKey = wallDateKey(now, cfg.tzOffsetMinutes);
  const prevKey = shiftDateKey(todayKey, -1);
  const WINDOW_MS = 48 * 3600e3;
  const nowIso = now.toISOString();

  for (const t of oneShots) {
    out.checked++;
    /* v4.22.0 需求 1：这一条自己设了提前天数就用它，否则跟随家庭设置 */
    const adv = advanceOf(t, cfg.remindAdvanceDays);
    const moment = localRemindMoment(t, cfg.remindDefaultTime, cfg.tzOffsetMinutes, adv);
    if (!moment) continue;
    if (now.getTime() < moment.getTime()) continue;                 // 还没到点
    if (now.getTime() - moment.getTime() > WINDOW_MS) {              // 错过窗口，不补发
      db.run('UPDATE todos SET reminded_at = ?, remind_key = ? WHERE id = ?', [nowIso, t.todo_date, t.id]);
      out.expired++;
      continue;
    }
    const sent = await sendOne(t, t.todo_date, moment, cfg, byName, out, nowIso, now, adv);
    if (sent === 'waiting' || sent === 'queued') out.waiting++;
  }

  for (const t of repeats) {
    out.checked++;
    // ★ 先在「落点」这一侧把提前天数补回来，再来判断今天该不该发。
    //   原因：提前 N 天时，真正到期的落点在 N 天之后，今天根本不是落点 ——
    //   如果还按老写法只找 [昨天, 今天] 里的落点，会先 `continue` 掉，
    //   于是提醒要么晚 N 天发、要么因超出 48 小时窗口干脆永远不发。
    //   `shiftDateKey(今天, +N)` 正好就是「今天这一轮该发的那一次落点」；
    //   N = 0 时它等于 [今天, 昨天]，与老行为完全一致。
    //
    //   occKey 本身始终是「事项真实的年度落点」（写进 remind_key 用的），
    //   提前只作用在提醒时刻上，否则 remind_key 记的就不是今年那一次，明年会重复发。
    const occKey = [todayKey, prevKey]
      .map((k) => shiftDateKey(k, advanceOf(t, cfg.remindAdvanceDays)))
      .find((k) => Repeat.isOccurrence(t, k));
    if (!occKey) continue;
    if (String(t.remind_key || '') === occKey) continue;             // 这一次已经发过了
    /* v4.21.0 需求 2：这一次已经手动勾完了就别再提醒（默认模板下「提前提醒」也一样：
       提前 N 天发出的那一轮，落点还没到，勾的是落点那天的框 —— 用 occKey 判断即可）。 */
    if (occurrenceDone(t.id, occKey)) continue;
    const adv = advanceOf(t, cfg.remindAdvanceDays);
    const moment = localRemindMoment({ todo_date: occKey, start_time: t.start_time },
      cfg.remindDefaultTime, cfg.tzOffsetMinutes, adv);
    if (!moment) continue;
    if (now.getTime() < moment.getTime()) continue;                  // 还没到点
    if (now.getTime() - moment.getTime() > WINDOW_MS) continue;      // 超出余量，等明年
    const sent = await sendOne(t, occKey, moment, cfg, byName, out, nowIso, now, adv);
    if (sent === 'waiting' || sent === 'queued') out.waiting++;
  }

  /* v4.3.3 需求 2：把已经到点的免打扰积压**合并成一封**发出去。
     放在扫描之后：本轮刚入队、且免打扰恰好已经结束的，也会被这一次 flush 带走。
     ★ 失败不标记 sent_at，下一分钟自然重试 —— 这就是这张表落库而不是放内存的意义。 */
  try {
    const flushed = await outbox.flush({
      smtp: { user: cfg.smtpUser, pass: cfg.smtpPass },
      smtpReady: !!(cfg.smtpUser && cfg.smtpPass),
      now,
      sendMail: ({ to, subject, text, html }) => mailer.sendMail({
        host: cfg.smtpHost, port: cfg.smtpPort, user: cfg.smtpUser, pass: cfg.smtpPass,
        fromName: config.siteName, to, subject, text, html,
      }),
    });
    out.flushed = flushed.mails;
    if (flushed.rows) out.recipients += flushed.rows;
    if (flushed.errors.length) out.errors.push(...flushed.errors);
    if (flushed.mails) {
      console.log(`[remind] 免打扰积压已合并发送 ${flushed.mails} 封（含 ${flushed.rows} 条提醒）`);
    }
  } catch (err) {
    out.errors.push(`汇总发件箱：${err && err.message ? err.message : err}`);
  }

  setStatus({
    state: 'ok', checked: out.checked, sent: out.sent, recipients: out.recipients,
    waiting: out.waiting, expired: out.expired, errors: out.errors,
    queued: out.queued, flushed: out.flushed,
    advanceDays: cfg.remindAdvanceDays,
  });
  return out;
}

/* ── v4.12.0 需求（记录本模块）：记录本提醒的扫描 ─────────────
   与待办提醒**共用同一套通道与开关**（家庭设置里的提醒总开关、SMTP、企业微信、
   每人自己的 push_channel 与免打扰），但调度是独立的：
   · 触发条件只有 remind_at <= now 且还没发过 —— 记录没有「重复」「提前落点」这些概念；
   · 收件人固定是**记录的作者本人**（记录本里的信息是「我记得要留意的事」，
     群发给全家等于把私人备注变成广播）；
   · 发完就写 reminded_at，一条只提醒一次；作者改了提醒设置会重新算 remind_at 并清空它。
   ★ 不 require api.js（那会成环）：自己的 SQL 自己查。 */
async function runRecordScan(now = new Date()) {
  const out = { sent: 0, errors: [] };
  const cfg = loadRemindSettings();
  if (!cfg.remindEnabled) return out;
  const nowIso = now.toISOString();
  const rows = db.all(
    'SELECT r.id, r.user_id, r.title, r.content, u.display_name, u.notify_email, u.username'
    + ' FROM records r JOIN users u ON u.id = r.user_id'
    + " WHERE r.remind = 1 AND r.reminded_at = '' AND r.remind_at != '' AND r.remind_at <= ?"
    + ' ORDER BY r.remind_at LIMIT 50',
    [nowIso],
  );
  if (!rows.length) return out;
  const smtpReady = !!(cfg.smtpUser && cfg.smtpPass) && config.pushMailEnabled !== false;
  for (const r of rows) {
    const lines = String(r.content || '').split('\n');
    const open = lines.filter((l) => /^☐ /.test(l)).length;
    const doneN = lines.filter((l) => /^☑ /.test(l)).length;
    /* v4.21.0 需求 1：记录本提醒的文案同样走可配置模板（分组在「待办提醒」里） */
    const vars = {
      站名: config.siteName,
      标题: String(r.title || ''),
      进度: open + doneN > 0 ? `清单进度：还有 ${open} 项没勾（已完成 ${doneN} 项）。` : '',
    };
    const rendered = msgTpl.render('record_remind', vars);
    const customHtml = msgTpl.htmlFor('record_remind', vars, {
      kind: 'todo',
      footnote: '你收到这封提醒，是因为你在记录本里为这条记录打开了提醒。',
    });
    const subject = rendered.subject;
    const body = rendered.text;
    const html = customHtml || mailLayout({
      heading: '记录本提醒',
      badge: String(r.title || ''),
      intro: `你存下的这条记录，按你设的时间提醒一下。${open + doneN > 0 ? `清单还有 ${open} 项没勾。` : ''}`,
      rows: [{ label: '标题', value: String(r.title || '') }],
      kind: 'todo',
      footnote: '你收到这封提醒，是因为你在记录本里为这条记录打开了提醒。',
    });
    try {
      const res = await push.deliver(
        [{ id: Number(r.user_id), username: r.username, email: r.notify_email, name: r.display_name }],
        { subject, text: body, html },
        {
          kind: 'record',
          smtpReady,
          sendMail: ({ to, subject: sub, text: tx, html: ht }) => mailer.sendMail({
            host: cfg.smtpHost, port: cfg.smtpPort, user: cfg.smtpUser, pass: cfg.smtpPass,
            fromName: config.siteName, to, subject: sub, text: tx, html: ht,
          }),
        },
      );
      if (res.errors.length) out.errors.push(...res.errors.map((e) => `「${r.title}」：${e}`));
      if (res.mail || res.wecom || res.deferred) out.sent++;
      /* ★ 一条记录只提醒一次：无论发没发出去都落标记 ——
         否则「没配邮箱」的家庭会每分钟重扫同一条，日志被刷爆、真问题反而看不见。 */
      db.run('UPDATE records SET reminded_at = ? WHERE id = ?', [nowIso, r.id]);
    } catch (err) {
      out.errors.push(`「${r.title}」：${(err && err.message) || err}`);
    }
  }
  return out;
}

/**
 * 发一条提醒。成功返回 'sent'，没有可发收件人 / 还在某个人的免打扰里返回 'waiting'，
 * 失败返回 'failed'。
 * ★ 成功才写 remind_key —— 无收件人时绝不能标记，否则就是「永久作废」。
 *
 * v2.0.0：收件人要再过一层**个人偏好**：
 *   · 某人在自己「通知设置」里关掉了待办提醒 → 不给他发（这是他的选择，不是故障）；
 *   · 某人设了免打扰 → 一封邮件发全家、没法只对他晚发，所以**整封等最晚的那个人出免打扰**
 *     （返回 'waiting'，下一轮扫描（1 分钟后）再看）。跳过他会让他永远收不到，
 *     这比全家晚几小时更糟。
 */
async function sendOne(t, occKey, moment, cfg, byName, out, nowIso, now, advIn) {
  let participants = [];
  try { participants = JSON.parse(t.participants || '[]'); } catch { /* 忽略 */ }
  /* ★ v4.28.0 修复：参与人为空时默认提醒**创建者本人**。
     一句话添加（网页顶部的快速输入 / 企业微信「待办 …」）建出来的待办 participants 是 []，
     旧逻辑在这里直接走到 `targets.length === 0 → waiting`，于是这条待办
     永远「等待收件人」、一次提醒都发不出去 —— 表现就是「重复待办不会提醒我」。
     语义上这也对：没指定参与人的事，本来就是建它的人自己的事。
     ★ 只补「空」的情况：明确选了参与人（哪怕选的是别人）就完全按参与人来，
       不会把创建者偷偷加进去。 */
  if (!participants.length && Number(t.user_id) > 0) {
    const owner = db.get('SELECT display_name, username FROM users WHERE id = ?', [Number(t.user_id)]);
    if (owner) participants = [String(owner.display_name || owner.username || '').trim()].filter(Boolean);
  }
  const prefsMap = userprefs.loadAll();
  const targets = [];
  for (const name of participants) {
    const u = byName.get(String(name).trim());
    if (!u) continue;
    /* v4.7.0 需求 2：原来的门槛是「有收件邮箱」，现在放宽成「有邮箱 **或** 走企业微信」。
       否则只填了企业微信的家庭成员永远收不到提醒。 */
    const channel = push.normalizeChannel(u.push_channel);
    /* v4.8.0：默认值变成 'auto'（优先企业微信），所以判据从「等于 wecom」改成
       「不是纯邮件」—— 否则默认通道的人会被这条门槛挡在外面。 */
    const viaWecom = channel !== 'mail';
    if (!u.notify_email && !viaWecom) continue;
    if (!userprefs.wantsRemind(u.id, prefsMap.get(Number(u.id)))) continue;
    if (targets.some((x) => x.id === Number(u.id))) continue;           // 同一个人被两个昵称匹配到
    targets.push({
      id: Number(u.id), email: u.notify_email, username: u.username,
      name: u.display_name || u.username, channel,
    });
  }
  if (!targets.length) return 'waiting';

  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  /* ★ v4.3.3 需求 2：按**收件人**各自算「最早能发的时刻」，不再取最晚的那个人。
     旧写法的两个问题：
       ① 一个人设了 22:00→08:00，全家都被压到早上 8 点才收到；
       ② 到点后一条一条发，早上醒来收件箱里躺着七八封，比晚一点更烦。
     现在：还在免打扰里的那些人，把这一条**单独入队**（due_at = 他自己的免打扰结束），
     由 outbox 到点合并成一封；已经出来的立刻发，互不牵连。 */
  const planned = targets.map((tg) => ({
    ...tg,
    at: Math.max(
      moment.getTime(),
      quiet.outOfQuiet(moment.getTime(), userprefs.quietOf(tg.id, 'remind', prefsMap.get(tg.id)), cfg.tzOffsetMinutes),
    ),
  }));
  const ready = planned.filter((p) => nowMs >= p.at);
  const waiting = planned.filter((p) => nowMs < p.at);

  /* v4.21.0 需求 1：标题与正文都取自可配置模板（默认模板渲染结果与旧版一字不差） */
  const msg = buildMail(t, occKey, cfg, advIn);
  const subject = msg.subject;
  const text = msg.text;
  const html = msg.html;
  let queued = 0;
  for (const p of waiting) {
    const qid = outbox.enqueue({
      userId: p.id, email: p.email, kind: 'remind', subject, text, html,
      dueAt: p.at, originId: Number(t.id) || 0,
    });
    if (qid) queued++;
  }

  if (!ready.length) {
    /* 全员都还在免打扰：已经把提醒交给发件箱了，所以这里可以标记「已提醒」——
       不标记的话每分钟都会重新扫到这一条、重新入队一次。
       入队本身是幂等的（同用户+同种类+同来源+同主题只留一条），
       标记只是省掉每分钟的空转。 */
    if (queued) {
      db.run('UPDATE todos SET reminded_at = ?, remind_key = ? WHERE id = ?', [nowIso, occKey, t.id]);
      out.queued = (out.queued || 0) + queued;
      return 'queued';
    }
    return 'waiting';
  }

  const emails = ready.map((x) => x.email).filter(Boolean);
  try {
    /* v4.7.0 需求 2：邮件仍是**一封群发**（发信量、合并逻辑都没变），
       选了企业微信的人额外单独推一条 —— 内容与邮件正文完全一致。 */
    const res = await push.deliver(ready, { subject, text, html }, {
      kind: 'remind',
      smtpReady: !!(cfg.smtpUser && cfg.smtpPass),
      sendMail: ({ to, subject: sub, text: tx, html: ht }) => mailer.sendMail({
        host: cfg.smtpHost, port: cfg.smtpPort, user: cfg.smtpUser, pass: cfg.smtpPass,
        fromName: config.siteName, to, subject: sub, text: tx, html: ht,
      }),
    });
    /* v4.10.0：deferred = 企微主动推送被个人免打扰拦下、已沉入队列（due_at=免打扰结束）。
       消息已安全落库、到点必发，所以按「已提醒」记账 —— 否则每轮重试、免打扰一结束反而连发。 */
    if (!res.mail && !res.wecom && !res.deferred) {
      // 一个都没发出去：不标记已提醒，下一轮自动重试（和原来「发信失败」同一种处理）
      if (res.errors.length) out.errors.push(...res.errors.map((e) => `「${t.title}」：${e}`));
      return 'failed';
    }
    if (res.errors.length) out.errors.push(...res.errors.map((e) => `「${t.title}」：${e}`));
    db.run('UPDATE todos SET reminded_at = ?, remind_key = ? WHERE id = ?', [nowIso, occKey, t.id]);
    out.sent++;
    out.recipients += res.mail + res.wecom + (res.deferred || 0);
    if (res.wecom) out.viaWecom = (out.viaWecom || 0) + res.wecom;
    if (res.deferred) out.deferred = (out.deferred || 0) + res.deferred;
    if (res.fallback) out.fallback = (out.fallback || 0) + res.fallback;
    if (queued) out.queued = (out.queued || 0) + queued;
    return queued ? 'queued' : 'sent';
  } catch (err) {
    out.errors.push(`「${t.title}」：${err.message}`);
    return 'failed';
  }
}

/**
 * 管理员手动触发「立即重新扫描」前的**放开**动作。
 *
 * ★ v4.28.0 行为修正：只放开「按新规则算出来的提醒时刻还在未来」的条目。
 *
 * 旧实现的三个问题（都会造成「过期事件被重复推送」）：
 *   ① 一次性待办：只要提醒时刻在 48 小时内，无论是否已经真的发过，一律清标记 →
 *      点一次「重新扫描」就把一小时前刚发过的提醒再发一遍；
 *   ② 重复事项：完全不看时刻，只要「今天 / 昨天（按全局提前天数补偿）是落点」
 *      就清掉 remind_key —— 今天 08:00 已发过的每天事项，09:00 点一下又发一次；
 *      往年的落点同样会被放开；
 *   ③ 重复事项用的是**全局**提前天数，而 runScan 用的是「这条待办自己设的」，
 *      两边口径不一致时放开与发送会错位。
 *
 * 现在统一委托给 rearmFutureReminders()（它用的就是 advanceOf() 的逐条口径）：
 *   · 提醒时刻已过（含今天已过点、往期落点）→ **不放开**，绝不会二次推送；
 *   · 提醒时刻还在未来却被误标 → 放开，到点正常发一次（这才是「重扫」该救的场景）。
 * 真正「没发出去」的条目本来就不会写 remind_key（sendOne 只有发成功 / 入队才写），
 * 所以不需要靠清标记来补发 —— 下一轮扫描自己会重试。
 *
 * @param {number} withinHours 保留参数（历史上是补发窗口），现已不参与判定
 * @param {number} nowMs 可注入的「现在」，便于测试固定时间
 */
function resetReminders(withinHours = 48, nowMs = Date.now()) {
  void withinHours;                      // 保留签名：调用方 / 老测试仍在传
  return rearmFutureReminders(nowMs);
}

/**
 * 管理员改了「提前几天提醒」之后，把那些**在新规则下提醒时刻还没到、却已经被标记
 * 「已提醒」**的待办重新放开。
 *
 * 为什么非要有这一步：提前天数变了，同一条待办的提醒时刻也跟着变。举例 ——
 * 待办日期 10/10，原来提前 5 天（10/05 08:00 已经发出）；管理员改成提前 0 天，
 * 新时刻是 10/10 08:00。若不处理，这条待办会一直背着旧的「已提醒」标记，
 * 到了 10/10 反而永远不会再发 —— 用户看到的就是「设置改了但没生效」。
 *
 * 只放开「按新规则算出来的提醒时刻还在未来」的条目：
 *   · 新时刻已经过去 → 说明这次提醒在旧规则下确实已经发生过，不重发，
 *     避免管理员一改设置全家就收到一堆补发邮件。
 *   · 无收件人而处于 waiting 的条目本来就没写标记，由正常扫描接手。
 *
 * @param {number} nowMs 可注入的「现在」，便于测试固定时间。
 */
function rearmFutureReminders(nowMs = Date.now()) {
  const cfg = loadRemindSettings();
  const now = Number(nowMs);
  const rows = db.all(
    "SELECT id, todo_date, start_time, repeat, repeat_rule, remind_advance_days, remind_key, reminded_at FROM todos WHERE remind = 1",
  );
  let n = 0;
  for (const t of rows) {
    if (!t.reminded_at && !t.remind_key) continue;      // 本来就没发过，不用管
    // 重复事项的提醒以「记录下来的那次落点」为准；一次性待办就是它自己的日期
    const baseKey = (t.repeat || t.repeat_rule) ? t.remind_key : t.todo_date;
    if (!baseKey) continue;
    /* ★ v4.28.0：必须用这条待办**自己**的提前天数（与 runScan / sendOne 同一口径）。
       旧写法用全局值：单条设了提前 2 天、全局 0 天时，算出来的「新时刻」与真实时刻
       差两天，于是该放开的不放开、或一改设置就把已经发过的再发一次。 */
    const m = localRemindMoment(
      { todo_date: baseKey, start_time: t.start_time },
      cfg.remindDefaultTime, cfg.tzOffsetMinutes, advanceOf(t, cfg.remindAdvanceDays),
    );
    if (!m || m.getTime() <= now) continue;             // 新时刻已过 → 不重发
    db.run("UPDATE todos SET reminded_at = NULL, remind_key = '' WHERE id = ?", [t.id]);
    n++;
  }
  return n;
}

/**
 * 发送测试邮件。override 可传管理员表单里尚未保存的 SMTP 参数（pass 为空则用已保存的）。
 */
async function sendTestMail(to, override = {}) {
  const saved = loadRemindSettings();
  const cfg = {
    smtpHost: String(override.host || '').trim() || saved.smtpHost,
    smtpPort: Number(override.port) || saved.smtpPort,
    smtpUser: String(override.user || '').trim() || saved.smtpUser,
    smtpPass: String(override.pass || '') || saved.smtpPass,
  };
  if (!cfg.smtpUser || !cfg.smtpPass) {
    throw Object.assign(new Error('请先填写发件邮箱与授权码并保存'), { status: 400 });
  }
  const addr = String(to || '').trim();
  if (!EMAIL_RE.test(addr)) {
    throw Object.assign(new Error('请填写正确的测试收件邮箱'), { status: 400 });
  }
  // 测试邮件也顺手把「提醒时刻到底怎么算出来的」写清楚：
  // 这样管理员一眼能看出「提前几天」这项设置有没有真的生效。
  const now = new Date();
  const sample = localRemindMoment(
    { todo_date: wallDateKey(now, saved.tzOffsetMinutes), start_time: '' },
    saved.remindDefaultTime, saved.tzOffsetMinutes, saved.remindAdvanceDays);
  const rows = [
    { label: '默认提醒时间', value: saved.remindDefaultTime },
    { label: '提前提醒', value: saved.remindAdvanceDays > 0 ? `提前 ${saved.remindAdvanceDays} 天` : '当天提醒' },
    { label: '时区', value: `UTC${saved.tzOffsetMinutes >= 0 ? '+' : '-'}${Math.abs(saved.tzOffsetMinutes) / 60}` },
    { label: '举例', value: `今天的待办会在 ${sample ? humanDate(sample, saved.tzOffsetMinutes) : '—'} 发出提醒` },
  ];
  await mailer.sendMail({
    host: cfg.smtpHost, port: cfg.smtpPort, user: cfg.smtpUser, pass: cfg.smtpPass,
    fromName: config.siteName, to: [addr],
    subject: `【${config.siteName}】测试邮件`,
    text: [
      `【${config.siteName}】测试邮件`,
      '',
      ...rows.map((r) => `${r.label}：${r.value}`),
      '',
      '收到它说明发件邮箱与授权码配置正确，待办到点后会把提醒发到参与人的收件邮箱。',
      '—— 本邮件由系统自动发送，请勿回复',
    ].join('\n'),
    html: mailLayout({
      heading: '发件配置测试',
      badge: '✅ 配置可用',
      intro: '收到这封邮件说明发件邮箱与授权码是正确的，待办到点后会把提醒发给参与人。',
      rows,
      kind: 'todo',
      footnote: '这是测试邮件，不代表任何待办事项。',
    }),
  });
  return { to: addr, host: cfg.smtpHost, port: cfg.smtpPort };
}

let timer = null;
/** 启动定时扫描：启动 10 秒后先跑一轮，之后每 60 秒一次 */
function start() {
  if (timer) return;
  const tick = async () => {
    try {
      const r = await runScan();
      if (r.sent) console.log(`[remind] 已发送 ${r.sent} 封待办提醒（收件人 ${r.recipients} 位）`);
      if (r.errors.length) console.error('[remind] 发送失败：', r.errors.join('；'));
      if (r.skipped === -2) console.warn('[remind] 未配置发件邮箱或授权码，本轮提醒跳过（请在「家庭设置」里填写并保存）');
      // v4.12.0：记录本提醒与待办提醒同一分钟扫描（各自独立判定，互不影响）
      const rr = await runRecordScan();
      if (rr.sent) console.log(`[remind] 已发送 ${rr.sent} 条记录本提醒`);
      if (rr.errors.length) console.error('[remind] 记录本提醒失败：', rr.errors.join('；'));
    } catch (err) {
      console.error('[remind] 扫描异常：', err && err.message);
    }
  };
  setTimeout(tick, 10 * 1000).unref();
  timer = setInterval(tick, 60 * 1000);
  timer.unref();
}

module.exports = {
  loadRemindSettings, localRemindMoment, remindWallKey, clampAdvanceDays, advanceOf,
  humanDate, wallDateKey, shiftDateKey, recordRemindMoment,
  buildMailText, buildMailHtml, mailLayout, buildMail, todoTemplateVars, occurrenceDone,
  runScan, runRecordScan, resetReminders, rearmFutureReminders, sendTestMail, getStatus, start, EMAIL_RE, TIME_RE,
  // v4.3.3 需求 2：免打扰汇总发件箱（测试与状态展示用）
  outbox,
};
