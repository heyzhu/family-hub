'use strict';
/**
 * 待办「催促完成」（v4.6.0 需求 3；v4.10.0 按需求文档 5.10 升级为状态机）
 *
 * 业务意图：有些待办不是「忘了看邮件」，而是「看到了但还没做」。邮件只有一次，
 * 之后就再没有声音了 —— 于是约定：待办到点后，按设定的间隔（1–60 分钟）用
 * **企业微信**反复催，直到当事人自己回一句「已完成」，系统标记完成并立刻停催。
 *
 * ★ v4.10.0 的状态机（todos.urge_status）：
 *     idle                  没开催促
 *     pending               已开催促、还没到开始时刻
 *     active                正在催（每次发出后置回 active）
 *     paused                （v4.14.0 起不再产生）旧版静默时段的遗留态，遇到即恢复 active
 *     done_by_reply         当事人在微信回「已完成」→ 完成 + 停催
 *     stopped_by_manual     网页上标完成 / 手动关掉开关 / 回「别再催了」→ 停催
 *     stopped_by_deadline   到结束日（end_date||todo_date 的 end_time，缺省 23:59）→ 停催不标完成
 *                           （24 小时硬顶也归入这一态：都是「时间到了自动停」）
 *     stopped_by_max_count  催满 urge_max_count 次 → 停催
 *   ★ 停催靠状态进终态，**不再清 urge_minutes** —— 那是用户的配置，清成 0 下次编辑就看不到原值。
 *   ★ J2 查询条件：urge_status IN ('pending','active','paused')。
 *   ★ v4.14.0 需求 5：**没有静默时段**了，所以 paused 不会再被写入（见 runScan 的说明）。
 *
 * ★ 依赖：db / config / wecom（发企微）+ push / reminders / mailer（发邮件）。
 *   绝不能 require api / bills —— api 要调本模块标记完成、server 要调本模块起定时器，
 *   反向依赖就会成环（拿到半成品 exports）。
 *
 * ★ v4.16.0 需求 2：**只配了邮件的家庭也能催**。
 *   之前这里第一行就是 `if (!wecom.isReady()) return`，等于把纯邮件家庭整块挡在外面。
 *   现在按人算：能用企业微信就用企业微信（能回「已完成」），用不上就发邮件。
 *   邮件没有交互能力，所以正文必须写清楚**怎么让它停下来**：
 *   打开应用把这条待办标记完成，之后就不再催。
 *
 * ★ v4.28.5 需求 3：**四条推送渠道一视同仁**。
 *   旧版按 `ch !== 'mail'` 判企微、按 `ch !== 'wecom'` 判邮件，于是选了飞书 / 钉钉的人
 *   实际收到的是企微或邮件 —— 通道选了等于没选。现在把投递整段交给 push.deliver
 *   （它统一处理四条通道的总开关、配置状态、首选失败走兜底），催促只负责：
 *   ① 算出这个人的首选 / 兜底；② 占位防重；③ 按实际送达的通道记流水；④ 推进状态机。
 */

const { db } = require('./db');
const config = require('./config');
const wecom = require('./wecom');
/* v4.16.0 需求 2：只配了邮件的家庭也要能催。
   ★ 依赖方向：push → db/config/wecom/quiet；reminders → push/outbox/...；
     mailer 是叶子模块。三者都不 require urge，所以这里加依赖不会成环。 */
const push = require('./push');
const reminders = require('./reminders');
const mailer = require('./mailer');
/* v4.28.5：催促按「待办类」的通道偏好走，kind 必须与 push.KIND_CHANNEL_KEY 对齐 */
const userprefs = require('./userprefs');
/* ★ v4.28.6：重复事项（每天 / 每周 / 每月…）也要能催。
   落点判定与待办列表 / 提醒 / 日报预告共用 public/repeat.js，绝不在这里另写一套日期规则。 */
const Repeat = require('../public/repeat.js');

/** 到点之后最多催这么久就自动停 —— 防失控的硬顶（不可配），与 urge_max_count 是主备两层 */
const MAX_URGE_HOURS = 24;
/** ★ v4.15.0 需求 7：没填开始时间时不再硬编码 09:00，改用「我的」默认提醒时间
 *  （settings.remind_default_time，管理员在「消息提醒 → 待办提醒」里设的那一项）。
 *  这里只是**取不到配置时的兜底**，保证任何情况下都有一个安全值可用。 */
const FALLBACK_URGE_TIME = '09:00';
/** 活动中的状态集合（J2 的查询条件；终态一律不在其中） */
const ACTIVE_STATUSES = ['pending', 'active', 'paused'];
/** 合并消息里最多列几条（多余的折叠成「还有 N 件」） */
const MERGE_MAX = 5;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 结束日（文档 5.2-7：服务端唯一取法，别处不准自己算）。
 * 跨天待办的「截止」= end_date 那天的 end_time（没有就是那天 23:59）。
 */
function getEndDate(todo) {
  return String((todo && (todo.end_date || todo.todo_date)) || '');
}

/** 把本地 HH:MM 换算成该日期上的 UTC 瞬时（配合 tz_offset_minutes，与全库口径一致） */
function wallTime(dateKey, time, tzOffsetMinutes) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''));
  const t = TIME_RE.test(String(time || '')) ? String(time) : '23:59';
  if (!m) return NaN;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    + Number(t.slice(0, 2)) * 3600000
    + Number(t.slice(3, 5)) * 60000;
  const tz = Number(tzOffsetMinutes == null ? config.tzOffsetMinutes : tzOffsetMinutes) || 0;
  return wall - tz * 60000;
}

/**
 * v4.15.0 需求 7：「我的」默认提醒时间（settings.remind_default_time）。
 * 全家只有一份（成员跟随管理员的默认值），所以直接读 settings；
 * 一次 tick 只查一次库，由调用方把结果传进 urgeDueAt，避免每条待办各查一遍。
 */
function defaultUrgeTime() {
  const rows = db.all("SELECT value FROM settings WHERE key = 'remind_default_time'", []);
  const v = rows.length ? String(rows[0].value || '') : '';
  return TIME_RE.test(v) ? v : FALLBACK_URGE_TIME;
}

/**
 * 这条待办「该开始被催」的时刻（UTC 瞬时）。
 * v4.10.0：urge_start_at 非空时优先用它（用户手动改过的开始时刻），
 * 否则沿用 start_time；**没填开始时间就用「我的」默认提醒时间**（v4.15.0 需求 7），
 * 日期锚在 todo_date（跨天也只按第一天开始）。
 * @param {{todo_date?:string, start_time?:string, urge_start_at?:string}} todo
 * @param {number} [tzOffsetMinutes]
 * @param {string} [defTime] 这一轮算好的默认提醒时间（不传则现查一次库）
 * @returns {Date|null}
 */
function urgeDueAt(todo, tzOffsetMinutes, defTime) {
  const date = String((todo && todo.todo_date) || '');
  if (!date) return null;
  return urgeDueAtOn(todo, date, tzOffsetMinutes, defTime);
}

/**
 * v4.28.6：**指定落点日期**的起催时刻。
 * 重复事项的 todo_date 是「基准日」（可能是几年前建的那天），拿它算时刻等于永远算在过去；
 * 每天 / 每周的催促必须锚在**今天这个落点**上，时刻仍取 urge_start_at → start_time → 默认值。
 */
function urgeDueAtOn(todo, dateKey, tzOffsetMinutes, defTime) {
  const date = String(dateKey || '');
  if (!date) return null;
  const fallback = TIME_RE.test(String(defTime || '')) ? String(defTime) : defaultUrgeTime();
  const explicit = String((todo && todo.urge_start_at) || '');
  const time = TIME_RE.test(explicit)
    ? explicit
    : (TIME_RE.test(String((todo && todo.start_time) || '')) ? todo.start_time : fallback);
  const ms = wallTime(date, time, tzOffsetMinutes);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** 截止时刻（UTC 瞬时）：结束日的 end_time（缺省 23:59）。跨天待办催到结束日那天为止。 */
function deadlineAt(todo, tzOffsetMinutes) {
  const end = getEndDate(todo);
  if (!end) return NaN;
  return wallTime(end, String((todo && todo.end_time) || '') , tzOffsetMinutes);
}

/**
 * v4.28.6：重复事项**这一个落点**的截止时刻。
 * 每天的事项今天 23:59 收口，明天重新开始 —— 不能拿基准日的日期当截止。
 * 系列结束日（end_date）早于今天时返回 NaN 之外还要由调用方按「系列已结束」处理。
 */
function occurrenceDeadlineAt(todo, occDate, tzOffsetMinutes) {
  const date = String(occDate || '');
  if (!date) return NaN;
  const seriesEnd = String((todo && todo.end_date) || '');
  if (seriesEnd && date > seriesEnd) return NaN;      // 这一轮已超出「重复到哪天」
  return wallTime(date, String((todo && todo.end_time) || ''), tzOffsetMinutes);
}

/** 当前墙上日期（YYYY-MM-DD），与 reminders.wallDateKey 同口径 */
function wallToday(now, tzOffsetMinutes) {
  const tz = Number(tzOffsetMinutes == null ? config.tzOffsetMinutes : tzOffsetMinutes) || 0;
  return new Date(now.getTime() + tz * 60000).toISOString().slice(0, 10);
}

/** 这条待办的重复规则（'' = 一次性） */
function repeatRuleOf(todo) {
  return Repeat.rule(todo || {});
}

/** 某一天这个落点是否已经勾完（老库没有这张表时按未完成） */
function occurrenceDone(todoId, dayKey) {
  return reminders.occurrenceDone(todoId, dayKey);
}

/** 当前本地 HH:MM（按 tz_offset_minutes 显式偏移，不依赖进程时区） */
function localHHMM(now, tzOffsetMinutes) {
  const tz = Number(tzOffsetMinutes == null ? config.tzOffsetMinutes : tzOffsetMinutes) || 0;
  const d = new Date(now.getTime() + tz * 60000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/* ★ v4.14.0 需求 5：`inQuietWindow()`（「允许催促时段」判定）已随静默机制一起删除。
   催促不再有任何时段限制，只受截止时刻 / 24 小时硬顶 / 次数上限三重约束。 */

/** 家庭账号 → 企业微信 UserID（userMap 的反查）。没绑定返回空串。 */
function wecomIdOf(cfg, username) {
  const want = String(username || '').trim();
  if (!want) return '';
  const c = cfg || wecom.loadConfig();
  for (const [wx, fh] of wecom.userMapOf(c)) {
    if (fh === want) return wx;
  }
  return '';
}

/** 截止时间的人话写法（文档 5.10.2-4 的四条规则，跨天必须按这套写，不准统一写「今天」） */
function deadlineText(todo, now, tzOffsetMinutes) {
  /* v4.28.6：重复事项的截止是「今天这个落点」的结束时刻，不是基准日（可能是几年前） */
  const end = String((todo && todo._occ) || '') || getEndDate(todo);
  const time = TIME_RE.test(String(todo.end_time || '')) ? todo.end_time : '23:59';
  const todayKey = (() => {
    const tz = Number(tzOffsetMinutes == null ? config.tzOffsetMinutes : tzOffsetMinutes) || 0;
    return new Date(now.getTime() + tz * 60000).toISOString().slice(0, 10);
  })();
  const tomorrowKey = new Date(Date.parse(todayKey + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  if (end === todayKey) return `今天 ${time}`;
  if (end === tomorrowKey) return `明天 ${time}`;
  const days = Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(todayKey + 'T00:00:00Z')) / 86400000);
  return `${Number(end.slice(5, 7))}月${Number(end.slice(8, 10))}日 ${time}（还剩 ${days} 天）`;
}

/** 单条催办文案（文档 5.10.2-3 的句式） */
function urgeText(todo, now, tzOffsetMinutes) {
  const lines = [`⏰ 催一下：「${todo.title}」`, `截止：${deadlineText(todo, now, tzOffsetMinutes)}`];
  // 跨天且今天不是结束日 → 额外告诉对方「这是持续的事，进行到第几天」
  const start = String(todo.todo_date || '');
  const end = String((todo && todo._occ) || '') || getEndDate(todo);
  if (end && end !== start && end !== deadlineTodayKey(now, tzOffsetMinutes)) {
    const total = Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000) + 1;
    const passed = Math.round((Date.parse(deadlineTodayKey(now, tzOffsetMinutes) + 'T00:00:00Z')
      - Date.parse(start + 'T00:00:00Z')) / 86400000) + 1;
    if (total > 1 && passed >= 1) lines.splice(2, 0, `第 ${Math.min(passed, total)}/${total} 天`);
  }
  lines.push('做完直接回「已完成」，我就把它标记完成并停止提醒。');
  return lines.join('\n');
}

function deadlineTodayKey(now, tzOffsetMinutes) {
  const tz = Number(tzOffsetMinutes == null ? config.tzOffsetMinutes : tzOffsetMinutes) || 0;
  return new Date(now.getTime() + tz * 60000).toISOString().slice(0, 10);
}

/** 多条同时到点 → 合并成一条消息（最多列 MERGE_MAX 条，多余的折叠） */
function mergedUrgeText(items, now, tzOffsetMinutes) {
  const shown = items.slice(0, MERGE_MAX);
  const lines = [`⏰ 有 ${items.length} 件事到点了：`];
  shown.forEach((t, i) => {
    lines.push(`${i + 1}. 「${t.title}」（截止：${deadlineText(t, now, tzOffsetMinutes)}）`);
  });
  if (items.length > MERGE_MAX) lines.push(`… 还有 ${items.length - MERGE_MAX} 件`);
  lines.push('做完直接回「已完成」，我就把对应那条标记完成并停止提醒。');
  return lines.join('\n');
}

/**
 * 邮件版催办正文（v4.16.0 需求 2）。
 *
 * 邮件是**单向**的：企业微信里回一句「已完成」就能停，邮件做不到。
 * 所以正文必须把「怎么停」写成人话动作，而不是「回复本邮件」这种收不到的说法：
 *   打开应用 → 待办 → 点这条左边的勾。
 * 顺带写清「还会继续发」，免得用户以为它只是一次性提醒而忽略了它。
 */
function mailUrgeText(items, now, tzOffsetMinutes) {
  const lines = [];
  if (items.length === 1) {
    lines.push(`⏰ 催一下：「${items[0].title}」`);
    lines.push(`截止：${deadlineText(items[0], now, tzOffsetMinutes)}`);
    const start = String(items[0].todo_date || '');
    const end = String((items[0] && items[0]._occ) || '') || getEndDate(items[0]);
    /* 重复事项不写「第 X/Y 天」：那套文案是给跨天持续事项的，每天的事项写出来是「第 365/365 天」 */
    if (end && end !== start && !repeatRuleOf(items[0])) {
      const day = Math.round((Date.parse(deadlineTodayKey(now, tzOffsetMinutes) + 'T00:00:00Z')
        - Date.parse(start + 'T00:00:00Z')) / 86400000) + 1;
      const total = Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000) + 1;
      if (total > 1 && day >= 1) lines.splice(2, 0, `第 ${Math.min(day, total)}/${total} 天`);
    }
  } else {
    lines.push(`⏰ 有 ${items.length} 件事到点了：`);
    items.slice(0, MERGE_MAX).forEach((t, i) => {
      lines.push(`${i + 1}. 「${t.title}」（截止：${deadlineText(t, now, tzOffsetMinutes)}）`);
    });
    if (items.length > MERGE_MAX) lines.push(`… 还有 ${items.length - MERGE_MAX} 件`);
  }
  lines.push('');
  lines.push('这条提醒会按你设定的间隔继续发，直到把对应待办标记为完成。');
  lines.push('怎么停：打开「我们一家」→ 待办，点一下这条待办左边的勾（✓），之后就不会再催。');
  return lines.join('\n');
}

/** 邮件版催办的 HTML（结构尽量简单：多数邮件客户端都老实渲染） */
function mailUrgeHtml(items, now, tzOffsetMinutes) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const rows = items.slice(0, MERGE_MAX).map((t) =>
    `<li style="margin:0 0 6px"><b>${esc(t.title)}</b>`
    + `<span style="color:#6b7280"> · 截止 ${esc(deadlineText(t, now, tzOffsetMinutes))}</span></li>`).join('');
  const more = items.length > MERGE_MAX
    ? `<p style="color:#6b7280;margin:6px 0 0">… 还有 ${items.length - MERGE_MAX} 件</p>` : '';
  return `<div style="font:15px/1.6 -apple-system,'Segoe UI',sans-serif;color:#111827">
    <p style="margin:0 0 10px">⏰ ${items.length === 1 ? '有一件事到点了' : `有 ${items.length} 件事到点了`}：</p>
    <ul style="padding-left:20px;margin:0">${rows}</ul>${more}
    <p style="margin:14px 0 0">这条提醒会按你设定的间隔继续发，直到把对应待办标记为完成。</p>
    <p style="margin:6px 0 0"><b>怎么停</b>：打开「${esc(config.siteName)}」→ 待办，点一下这条待办左边的勾（✓），之后就不会再催。</p>
  </div>`;
}

/** 发件邮箱是否可用（与待办提醒同一份配置；家庭级「邮件推送」关掉就视为不可用） */
function smtpOf() {
  const rs = reminders.loadRemindSettings();
  return {
    ready: !!(rs.smtpUser && rs.smtpPass) && config.pushMailEnabled !== false,
    host: rs.smtpHost, port: rs.smtpPort, user: rs.smtpUser, pass: rs.smtpPass,
  };
}

/**
 * v4.28.6：跨天复位重复事项的催促计数。
 *
 * 为什么必须单独一步：`urge_count` / `urge_status` 是**行级**的，而「每天」是一条行、
 * 每天一个新落点。不清零的话，第二天的 `urge_count` 已经等于 urge_max_count、
 * `urge_status` 还停在 stopped_by_max_count —— 主查询只扫 pending/active/paused，
 * 于是「每天重复 + 催促」只在第一天响过、之后永远静默。
 *
 * 只复位「落点相关」的终态（截止 / 催满 / 回已完成），
 * `stopped_by_manual`（用户自己关掉的）不因跨天自动复活。
 * ★ 必须在主查询之前调用：终态进不了主查询，事后补就来不及了。
 */
function rollRepeatUrge(now, tzOffsetMinutes) {
  const today = wallToday(now, tzOffsetMinutes);
  const rows = db.all(
    `SELECT id, todo_date, end_date, repeat, repeat_rule, urge_status, urge_occ_date,
            repeat_end_mode, repeat_end_date, repeat_end_count, repeat_sent_count, repeat_ended_at
       FROM todos
      WHERE done = 0 AND urge_minutes > 0 AND (repeat != '' OR repeat_rule != '')`,
    [],
  );
  for (const t of rows) {
    /* v4.28.8：系列已经结束（按时间到期 / 按次数发够 / 手动结束）→ 催促也必须停。
       旧版只认 end_date，于是「结束重复」之后提醒停了、催促却每天复位继续发，
       用户收到的是「明明结束了还在催」。end_date 的判断保留在后面，作为老数据兜底。 */
    if (reminders.repeatEnded(t, today)) {
      stopUrge(t.id, 'stopped_by_deadline');
      continue;
    }
    if (String(t.urge_occ_date || '') === today) continue;   // 今天已经复位过
    if (!Repeat.isOccurrence(t, today)) continue;            // 今天不是落点，等下次
    if (String(t.urge_status || '') === 'stopped_by_manual') continue;
    if (String(t.end_date || '') && String(t.end_date) < today) {
      stopUrge(t.id, 'stopped_by_deadline');                 // 系列已结束，别再空扫
      continue;
    }
    db.run(
      `UPDATE todos SET urge_status = 'pending', urge_count = 0, urge_last_at = '', urge_occ_date = ?
        WHERE id = ?`,
      [today, t.id],
    );
  }
}

/**
 * 扫一轮：把该催的都催掉（v4.10.0 状态机版；v4.16.0 起支持纯邮件；v4.28.6 起含重复事项）。
 * @param {{now?:Date, tzOffsetMinutes?:number}} [opts] now 仅供测试注入
 * @returns {Promise<{sent:number, nags:number, errors:string[], skipped:string, tried:number,
 *                     stopped:number, paused:number}>}
 */
async function tickUrge(opts) {
  const o = opts || {};
  const now = o.now instanceof Date ? o.now : new Date();
  const tz = Number.isFinite(Number(o.tzOffsetMinutes)) ? Number(o.tzOffsetMinutes) : undefined;
  const cfg = wecom.loadConfig();
  const wxReady = wecom.isReady(cfg);
  const smtp = smtpOf();
  const out = {
    sent: 0, nags: 0, errors: [], skipped: '', tried: 0, stopped: 0, paused: 0,
    viaMail: 0, viaWecom: 0, viaFeishu: 0, viaDingtalk: 0,
  };
  /* v4.28.5：四条通道任意一条能用就继续。旧版只认企微 + 邮件，
     只配飞书 / 钉钉的家庭被整轮跳过；现在直接问 push 的「已启用且已配置」清单。 */
  const avail = push.configuredChannels();
  if (!avail.length) {
    out.skipped = '没有已启用且已配置的推送渠道（企业微信 / 邮件 / 飞书 / 钉钉）';
    return out;
  }

  /* ★ v4.28.6：重复事项**也参与催促**。
     旧版这里写死 `t.repeat='' AND t.repeat_rule=''`，理由是「重复事项不会被完成，催了也完结不了」——
     但重复事项的完成态是「这一天的落点」（todo_done_marks），本来就可以被勾掉，
     于是「每天重复 + 开了催促」的待办一次都不会响 —— 这正是本轮要修的 bug。
     现在按落点催：每天 0 点后把计数清零重来（rollRepeatUrge），当天勾掉即停，明天照常开始。 */
  rollRepeatUrge(now, tz);
  /* J2 查询条件：urge_status IN ('pending','active','paused') —— 终态不再扫
     （重复事项的终态会在跨天时由 rollRepeatUrge 复位）。 */
  const rows = db.all(
    `SELECT t.id, t.user_id, t.title, t.todo_date, t.end_date, t.end_time, t.start_time,
            t.repeat, t.repeat_rule, t.urge_occ_date,
            t.repeat_end_mode, t.repeat_end_date, t.repeat_end_count,
            t.repeat_sent_count, t.repeat_ended_at,
            t.urge_minutes, t.urge_last_at, t.urge_status, t.urge_count,
            t.urge_max_count, t.urge_window_start, t.urge_window_end, t.urge_start_at,
            u.username, u.push_channel, u.push_fallback, u.notify_email
       FROM todos t JOIN users u ON u.id = t.user_id
      WHERE u.deleted = 0 AND t.done = 0 AND t.urge_minutes > 0
        AND t.urge_status IN ('pending','active','paused')
        AND t.todo_date IS NOT NULL AND t.todo_date <> ''
      ORDER BY t.todo_date ASC, t.start_time ASC LIMIT 500`,
    [],
  );

  // 先做「不发消息也能推进状态」的三类判定（截止 / 次数上限 / 静默）
  const due = [];
  /* v4.15.0 需求 7：「没填开始时间」的默认时刻这一轮只取一次库 */
  const defTime = defaultUrgeTime();
  for (const t of rows) {
    const isRepeat = !!repeatRuleOf(t);
    /* 重复事项只在「今天确实是一个落点」时催；今天不是落点（如每周三的事项今天周二）就跳过，
       不推进任何状态 —— 不能因为今天没轮到它就把它标成 stopped。 */
    let occ = '';
    if (isRepeat) {
      occ = wallToday(now, tz);
      if (!Repeat.isOccurrence(t, occ)) continue;
      /* v4.28.8：系列已收口 → 今天不再催，并且把状态落成终态，
         免得下一轮又被 rollRepeatUrge 复位。 */
      if (reminders.repeatEnded(t, occ)) {
        stopUrge(t.id, 'stopped_by_deadline');
        out.stopped++;
        continue;
      }
      // 跨天还没复位（理论上下面的 rollRepeatUrge 已处理）→ 本轮先不催，下一轮一定复位
      if (String(t.urge_occ_date || '') !== occ) continue;
      // 今天这个落点已经勾完 → 今天不再催，明天由 rollRepeatUrge 复位
      if (occurrenceDone(t.id, occ)) continue;
    }
    const dl = isRepeat ? occurrenceDeadlineAt(t, occ, tz) : deadlineAt(t, tz);
    if (Number.isFinite(dl) && now.getTime() > dl) {
      stopUrge(t.id, 'stopped_by_deadline');
      out.stopped++;
      continue;
    }
    const startAt = isRepeat ? urgeDueAtOn(t, occ, tz, defTime) : urgeDueAt(t, tz, defTime);
    if (!startAt) continue;
    if (now.getTime() - startAt.getTime() > MAX_URGE_HOURS * 3600000) {
      // 24 小时硬顶：都是「时间到了自动停」，归入 stopped_by_deadline
      stopUrge(t.id, 'stopped_by_deadline');
      out.stopped++;
      continue;
    }
    const max = Number(t.urge_max_count) || 0;
    if (max > 0 && Number(t.urge_count) >= max) {
      stopUrge(t.id, 'stopped_by_max_count');
      out.stopped++;
      continue;
    }
    /* ★ v4.14.0 需求 5：**「允许催促时段」（静默）整段删掉了**。
       催促的语义是「到点没做完就一直催到做完」，它自己已经有三重边界：
       截止时刻 / 24 小时硬顶 / 次数上限，再加一层「几点到几点才催」只会
       让人分不清它和「免打扰」的关系（而且默认 08:00–22:00 会被读成
       「只在半夜催」——v4.10.0 就为这个歧义改过一次实现）。
       现在：只要还没到截止、没到次数上限，就按间隔催。
       老数据里可能残留 urge_status='paused'（旧版落的），这里顺手恢复成 active，
       否则那几条会永远卡在「没人处理」的状态里。 */
    if (t.urge_status === 'paused') {
      db.run("UPDATE todos SET urge_status = 'active' WHERE id = ? AND urge_status = 'paused'", [t.id]);
    }

    if (now.getTime() < startAt.getTime()) continue;   // 还没到 urge_start_at
    const gap = Math.max(1, Number(t.urge_minutes) || 1) * 60000;
    const last = t.urge_last_at ? Date.parse(t.urge_last_at) : NaN;
    if (Number.isFinite(last) && now.getTime() - last < gap) continue;
    if (occ) t._occ = occ;          // 文案里的「截止」按今天的落点写
    due.push(t);
  }

  if (!due.length) return out;

  // 按人合并：同一个人的多条到点 → 一条消息（最多列 5 条）
  const byUser = new Map();
  for (const t of due) {
    if (!byUser.has(t.username)) byUser.set(t.username, []);
    byUser.get(t.username).push(t);
  }

  /* 一次 tick 只查一遍所有人的类别偏好，和 push.deliver 内部同源 */
  const prefsMap = userprefs.loadAll();

  for (const [username, items] of byUser) {
    /* v4.28.5：路由交给 push.deliver —— 四条通道的总开关、配置状态、
       这个人有没有绑定企微 / 留邮箱、首选失败走兜底，全部由它一处裁决。
       ★ 绝不因为找不到人而群发到 @all —— 催促是私事：target 永远是具体某个人。 */
    const head = items[0] || {};
    const uid = Number(head.user_id) || userIdOf(username);
    const mode = push.modeFor(uid, 'remind', prefsMap);
    const primary = push.normalizeChannel(mode.primary);
    /* ★ 两套枚举名不同：push 用 'mail'，todo_nag_logs 的 CHECK 用 'email'。
       直接拿 'mail' 去占位会被 CHECK 静默 IGNORE，于是「一条都没发、也不报错」。 */
    const channel = primary === 'mail' ? 'email' : primary;
    const email = String(head.notify_email || '').trim();
    const wxId = wxReady ? wecomIdOf(cfg, username) : '';
    const target = {
      id: uid, username, name: head.owner_name || username,
      email, wecomUser: wxId, channel: primary,
    };

    // 发送前先占位（5.10.8 幂等）：四元组唯一索引，占位失败 = 别的进程刚发过 → 跳过该条
    const claimed = [];
    for (const t of items) {
      const seq = Number(t.urge_count) || 0;
      /* ★ v4.28.6：占位键带上落点日期 —— 重复事项每天 nag_seq 都从 0 开始，
         不带日期的话第二天那次会被唯一键判成「已经发过」直接 IGNORE。 */
      const occDate = String(t._occ || '');
      const r = db.run(
        `INSERT OR IGNORE INTO todo_nag_logs (todo_id, user_id, nag_seq, channel, occ_date, msg_type, delivered)
         VALUES (?,?,?,?,?,'urge','pending')`,
        [t.id, uid, seq, channel, occDate],
      );
      if (r && r.changes > 0) claimed.push({ todo: t, seq, occ: occDate });
    }
    if (!claimed.length) continue;

    out.tried++;
    const todos = claimed.map((c) => c.todo);
    const subject = claimed.length === 1
      ? `【待办催促】${claimed[0].todo.title}`
      : `【待办催促】${claimed.length} 件事到点了`;
    /* 邮件 / 群机器人看不到「回已完成」的入口，用 mailUrgeText 写清「去应用里勾一下」；
       企业微信单独给一份可回执的文案（deliver 的 wecomMsg 只作用于企微）。 */
    const wxText = claimed.length === 1
      ? urgeText(claimed[0].todo, now, tz)
      : mergedUrgeText(todos, now, tz);
    const msg = { subject, text: mailUrgeText(todos, now, tz), html: mailUrgeHtml(todos, now, tz) };

    /* eslint-disable no-await-in-loop */
    const res = await push.deliver([target], msg, {
      kind: 'urge',
      now,
      deferQuiet: false,          // 催促本身就是「到点没做完」，不能再沉进免打扰队列
      smtpReady: smtp.ready,
      wecomMsg: { subject: '', text: wxText },
      sendMail: ({ to, subject: s, text: t, html: h }) => mailer.sendMail({
        host: smtp.host, port: smtp.port, user: smtp.user, pass: smtp.pass,
        fromName: config.siteName, to, subject: s, text: t, html: h,
      }),
    });
    /* eslint-enable no-await-in-loop */

    const used = res.wecom ? 'wecom' : res.mail ? 'email'
      : res.feishu ? 'feishu' : res.dingtalk ? 'dingtalk' : '';
    if (used) {
      out.sent++;
      const counter = { wecom: 'viaWecom', email: 'viaMail', feishu: 'viaFeishu', dingtalk: 'viaDingtalk' }[used];
      if (counter) out[counter] = (out[counter] || 0) + 1;
      /* 首选不可用而走了兜底时，流水要记**实际**通道，不能留占位时的首选值 */
      if (used !== channel) {
        for (const c of claimed) {
          db.run('UPDATE todo_nag_logs SET channel = ? WHERE todo_id = ? AND user_id = ? AND nag_seq = ? AND channel = ? AND occ_date = ?',
            [used, c.todo.id, uid, c.seq, channel, c.occ]);
        }
      }
      out.nags += commitUrge(claimed, used, now, out);
    } else {
      const why = (res.errors && res.errors.length ? res.errors.join('；') : '')
        || (primary === 'wecom' ? '还没绑定企业微信账号'
          : primary === 'mail' ? '没配收件邮箱'
            : `首选「${push.labelOf(primary)}」不可用，也没设可用的兜底方式`);
      out.errors.push(`「${head.title || username}」${why}`);
      out.skipped = `有待办的主人${why}`;
      failUrge(claimed, channel, why, now, out);
    }
  }
  return out;
}

/**
 * 催办成功后的记账（v4.16.0 从原来内联的循环里抽出来，两个通道共用）。
 * 乐观锁：`WHERE urge_count = 原值` —— 影响行数为 0 说明状态已被别人改掉
 * （刚标完成 / 刚点「别再催了」），这时只把那行流水标成 dedup，不动计数。
 * @returns {number} 真正推进了计数（= 确实催到）的条数
 */
function commitUrge(claimed, channel, now, out) {
  let n = 0;
  for (const c of claimed) {
    const adv = db.run(
      `UPDATE todos SET urge_count = urge_count + 1, urge_last_at = ?, urge_status = 'active'
        WHERE id = ? AND urge_count = ? AND urge_status IN ('pending','active','paused')`,
      [now.toISOString(), c.todo.id, c.seq],
    );
    const delivered = adv && adv.changes > 0 ? 'success' : 'dedup';
    db.run('UPDATE todo_nag_logs SET delivered = ? WHERE todo_id = ? AND nag_seq = ? AND channel = ? AND occ_date = ?',
      [delivered, c.todo.id, c.seq, channel, c.occ]);
    if (delivered === 'success') n++;
  }
  return n;
}

/** 发送失败：流水标 fail、计数照常 +1（5.10.7-1），下个周期继续催 */
function failUrge(claimed, channel, err, now, out) {
  for (const c of claimed) {
    db.run('UPDATE todo_nag_logs SET delivered = ?, error_code = ? WHERE todo_id = ? AND nag_seq = ? AND channel = ? AND occ_date = ?',
      ['fail', String(err).slice(0, 60), c.todo.id, c.seq, channel, c.occ]);
    db.run(
      `UPDATE todos SET urge_count = urge_count + 1, urge_last_at = ?, urge_status = 'active'
        WHERE id = ? AND urge_count = ? AND urge_status IN ('pending','active','paused')`,
      [now.toISOString(), c.todo.id, c.seq],
    );
  }
  return out;
}

function userIdOf(username) {
  const row = db.get('SELECT id FROM users WHERE username = ? AND deleted = 0', [String(username || '')]);
  return row ? row.id : 0;
}

/** 进入某个终态（已是终态则不动；urge_minutes 保持原值 —— 那是用户的配置） */
function stopUrge(id, status) {
  db.run(
    "UPDATE todos SET urge_status = ? WHERE id = ? AND urge_status IN ('pending','active','paused','')",
    [status, Number(id)],
  );
}

/**
 * 在某人的待办里挑一条「最该被标记完成」的（5.10.5：不追问、不出列表、自动挑）。
 *
 * 优先级刻意这样排：
 *   ① 正在被催的（urge_status='active'，其次 urge_last_at 非空）—— 用户回「已完成」十有八九是回它；
 *   ② 今天及以前、已经开始到点的 —— 顺手把过期未完成的收掉；
 *   ③ 最近的一条未完成。
 * 重复事项也参与（v4.28.6）：只认「今天确实是落点、且今天还没勾完」的那条，
 *   回「已完成」= 勾掉今天的落点，明天照常再来（写 todo_done_marks，而不是把整条规则完成掉）。
 *
 * @returns {object|null} 命中的 todo 行
 */
function pickToComplete(username, opts) {
  const o = opts || {};
  const now = o.now instanceof Date ? o.now : new Date();
  const uname = String(username || '').trim();
  if (!uname) return null;
  const rows = db.all(
    `SELECT t.id, t.title, t.todo_date, t.end_date, t.end_time, t.start_time,
            t.repeat, t.repeat_rule, t.urge_minutes, t.urge_last_at, t.urge_status
       FROM todos t JOIN users u ON u.id = t.user_id
      WHERE u.username = ? AND u.deleted = 0 AND (t.done = 0 OR t.repeat != '' OR t.repeat_rule != '')
        AND t.todo_date IS NOT NULL AND t.todo_date <> ''
      ORDER BY (t.urge_status = 'active') DESC, (t.urge_last_at <> '') DESC,
               t.todo_date ASC, t.start_time ASC, t.id ASC
      LIMIT 50`,
    [uname],
  );
  if (!rows.length) return null;
  /* 重复事项必须先过「今天是不是落点 / 今天是否已勾完」两道门，
     否则会把「每周三」的事项在周四当成候选，勾了也没意义。 */
  const today = wallToday(now, o.tzOffsetMinutes);
  const usable = rows.filter((r) => {
    if (!repeatRuleOf(r)) return true;
    if (!Repeat.isOccurrence(r, today)) return false;
    return !occurrenceDone(r.id, today);
  });
  if (!usable.length) return null;
  const urged = usable.find((r) => r.urge_status === 'active') || usable.find((r) => String(r.urge_last_at || ''));
  if (urged) return urged;
  const defTime = defaultUrgeTime();
  const started = usable.find((r) => {
    const due = repeatRuleOf(r) ? urgeDueAtOn(r, today, o.tzOffsetMinutes, defTime) : urgeDueAt(r, o.tzOffsetMinutes, defTime);
    return due && due.getTime() <= now.getTime();
  });
  return started || usable[0];
}

/**
 * 标记完成（v4.10.0：状态机停催，**不清 urge_minutes** —— 文档 5.10.4-3 点名要求）。
 *
 * ★ v4.28.6：重复事项走「勾掉今天这个落点」——
 *   写 todo_done_marks，绝不把 todos.done 置 1（那会让整条每天事项从列表和日历里消失）。
 * @param {number} id
 * @param {{via?:string}} [opts] via 'wecom' → done_by_reply；缺省（网页）→ stopped_by_manual
 */
function markDone(id, opts) {
  const o = opts || {};
  const now = o.now instanceof Date ? o.now : new Date();
  const status = o.via === 'wecom' ? 'done_by_reply' : 'stopped_by_manual';
  const row = db.get('SELECT * FROM todos WHERE id = ?', [Number(id)]);
  if (row && repeatRuleOf(row)) {
    const today = wallToday(now, o.tzOffsetMinutes);
    if (Repeat.isOccurrence(row, today)) {
      db.run(
        'INSERT INTO todo_done_marks (todo_id, occ_date, user_id, done_at) VALUES (?,?,?,?)'
        + ' ON CONFLICT(todo_id, occ_date) DO UPDATE SET user_id = excluded.user_id, done_at = excluded.done_at',
        [Number(id), today, Number(row.user_id) || 0, now.toISOString()],
      );
    }
    db.run(
      'UPDATE todos SET urge_status = ?, urge_last_at = ?, urge_occ_date = ? WHERE id = ?',
      [status, now.toISOString(), today, Number(id)],
    );
    return db.get('SELECT * FROM todos WHERE id = ?', [Number(id)]);
  }
  db.run(
    'UPDATE todos SET done = 1, urge_status = ?, urge_last_at = ?, updated_at = ? WHERE id = ?',
    [status, now.toISOString(), now.toISOString(), Number(id)],
  );
  return db.get('SELECT * FROM todos WHERE id = ?', [Number(id)]);
}

/** 回「还没做 / 稍后」：不算完成，把计时重置为现在（下个完整间隔后再催），回执 N 分钟后再提醒 */
function snoozeUrge(id, now) {
  const at = (now instanceof Date ? now : new Date()).toISOString();
  db.run(
    "UPDATE todos SET urge_last_at = ?, urge_status = 'active' WHERE id = ? AND done = 0",
    [at, Number(id)],
  );
}

/** 回「别再催了」/ 手动关开关 / 删除待办：停催、不标完成 */
function stopUrgeManual(id) {
  stopUrge(Number(id), 'stopped_by_manual');
}

/** 找出某人「正在被催」的那条（优先 active，其次最近催过的）——否定词 / 别再催了的定位规则 */
function activeUrgeOf(username) {
  return db.get(
    `SELECT t.* FROM todos t JOIN users u ON u.id = t.user_id
      WHERE u.username = ? AND u.deleted = 0 AND t.done = 0 AND t.urge_minutes > 0
        AND t.urge_status IN ('active','paused')
      ORDER BY t.urge_last_at DESC, t.id ASC LIMIT 1`,
    [String(username || '')],
  ) || null;
}

/** 催促流水（日志接口用）：owner 可看任何人的；成员只看自己的 */
function nagLogs(todoId) {
  return db.all(
    'SELECT nag_seq, channel, msg_type, sent_at, delivered, error_code FROM todo_nag_logs'
    + ' WHERE todo_id = ? ORDER BY nag_seq DESC, id DESC LIMIT 200',
    [Number(todoId) || 0],
  );
}

module.exports = {
  MAX_URGE_HOURS,
  /* v4.15.0：DEFAULT_URGE_TIME 改名 FALLBACK_URGE_TIME（默认值现在来自 settings），
     旧名字作为别名继续导出 —— 老测试与外部调用不会因为它改名而炸。 */
  FALLBACK_URGE_TIME,
  DEFAULT_URGE_TIME: FALLBACK_URGE_TIME,
  defaultUrgeTime,
  MERGE_MAX,
  ACTIVE_STATUSES,
  urgeDueAt,
  /* v4.28.6：重复事项按「今天的落点」起催 / 截止，跨天复位计数 */
  urgeDueAtOn,
  occurrenceDeadlineAt,
  rollRepeatUrge,
  repeatRuleOf,
  wallToday,
  deadlineAt,
  getEndDate,
  localHHMM,
  wecomIdOf,
  urgeText,
  mergedUrgeText,
  /* v4.16.0 需求 2：纯邮件家庭的催办正文（怎么停下来写在里面） */
  mailUrgeText,
  mailUrgeHtml,
  smtpOf,
  deadlineText,
  tickUrge,
  pickToComplete,
  markDone,
  snoozeUrge,
  stopUrgeManual,
  stopUrge,
  activeUrgeOf,
  nagLogs,
};
