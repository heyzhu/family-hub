'use strict';
/**
 * 家庭内容变更通知。
 *
 * 规则（与用户在需求里定的完全一致）：
 *  - 触发：家庭里【其他】成员新增或更新了设为「全家共享」的内容（动态 / 记录 / 待办），
 *    或者发表了评论 —— 包括评论，因为评论也是家庭内容的一部分；
 *  - 收件人：所有配置了收件邮箱的成员，但排除这次动作的作者本人；
 *  - 隐私：仅自己可见的内容一律不发（不能在邮件里泄露）；
 *  - 开关：管理员可在「家庭设置」里**按类型分别**关掉（settings.notify_on_change 总开关 +
 *    settings.notify_kinds 分项，取值 todo/post/record/comment）；两层都要过才发；
 *  - 防轰炸：一分钟内最多 20 封，超出只计数不发送，并把原因暴露给管理端；
 *  - ★ 绝不阻塞接口：发送放进串行队列 fire-and-forget，失败只记状态不抛错。
 *  - 邮件正文同时发纯文本与 HTML 两版（multipart/alternative），排版好看的那个优先。
 */
const { db } = require('./db');
const config = require('./config');
const mailer = require('./mailer');
const reminders = require('./reminders');
const userprefs = require('./userprefs');
/* v4.7.0 需求 2：变更通知也支持「按人走企业微信」。push 只依赖 db/config/wecom，
   不反向 require 本模块（也不 require outbox）→ 三者不成环。 */
const push = require('./push');
/* v4.3.3 需求 2：免打扰期间的变更通知入发件箱，到点按人合并成一封。
   outbox 只依赖 db / config / push，不会反向 require 本模块 → 不成环。 */
const outbox = require('./outbox');
/* v4.21.0 需求 1：内容变更通知的标题与正文改成家庭级可配置模板。
   msgTpl 只依赖 db / config → 不会与 reminders / notify 成环。 */
const msgTpl = require('./msgTpl');

const NOUN = { todo: '待办事项', post: '图文动态', record: '重点记录', comment: '动态' };

/** 可分项开关的内容类型。顺序即界面展示顺序。 */
const ALL_KINDS = ['todo', 'post', 'record', 'comment'];
const KIND_LABEL = { todo: '待办事项', post: '图文动态', record: '重点记录', comment: '评论' };

/* v4.15.0 需求 8：默认阈值常量已挪进 reminders.js 的 SETTINGS_DEFAULTS
   （notify_max_per_min，1–500，非法回 20），这里只留窗口长度。 */
const WINDOW_MS = 60 * 1000;

/**
 * v4.2.0 需求 4：**同一用户短时间内反复编辑同一条内容，只提醒一次**。
 *
 * 场景：妈妈把一条待办的标题改了、又补了个时间、再改了备注 —— 三次保存三封邮件，
 * 爸爸手机上连着响三下。这不是「有更新」，是噪声；噪声多了家人就会把通知关掉，
 * 那才是真正的损失。
 *
 * 口径：
 *   · 去重键 = 操作人 + 类型 + 条目 id（**不含动作**）——「新建后立刻改一下」
 *     也算同一条内容的连续编辑，同样只提醒一次；
 *   · **必须拿到稳定的条目 id 才去重**。拿不到 id 时完全按升级前的行为发送：
 *     没有 id 就无法判断「两条事件是不是同一条内容」，此时若拿标题凑合，
 *     会把「同一个人的两条同名但不同的内容」误判成重复而静默吞掉 ——
 *     宁可多发一封，也绝不吞通知（本项目最忌讳静默失败）。真实业务调用
 *     （api.js 的 8 处：待办 / 动态 / 记录 / 评论 / 共创）全部带 id，去重照常生效。
 *   · 时间窗默认 3 分钟（`DEDUPE_WINDOW_MS`），窗内第二次起**不再发**（计 deduped）；
 *   · 汇总模式下窗口内已有待发条目时，**原地更新内容**而不是再排一条 ——
 *     这样到点合并的那封摘要里，同一条内容也只会出现一次，且是最新内容；
 *   · 只有内存态：通知本就是「尽力而为」，重启后重新开始计数，不值得为它落库。
 */
const DEDUPE_WINDOW_MS = 3 * 60 * 1000;
let dedupeMap = new Map();
let dedupedCount = 0;

/** 去重键：拿不到稳定 id 时返回空串（= 这次不做去重，按原行为发送） */
function dedupeKey(ev) {
  if (ev.id == null || ev.id === '') return '';
  return `${ev.actor.id}|${ev.kind}|${ev.id}`;
}

/** 清空去重窗口（测试与「立即重新扫描」共用：窗口卡死后要给一个恢复手段） */
function resetDedupe() {
  dedupeMap = new Map();
  dedupedCount = 0;
}

let lastStatus = { at: '', sent: 0, recipients: 0, dropped: 0, errors: [] };
let queue = Promise.resolve();
let windowStart = Date.now();
let windowCount = 0;

/* ── 发送时机（深夜免打扰） ─────────────────────────
   v4.14.0 需求 4：**「汇总时间」这个选项撤掉了**。原来有两层：
     1) 汇总时间（notify_digest_time）：攒到每天这个点合并成一封；
     2) 免打扰时段（notify_quiet_start / notify_quiet_end）：这段时间内不发，顺延到结束。
   用户的原话是「有变动就提醒，别让我自己去挑一个几点汇总」——
   于是口径收敛成两条：
     · 没设免打扰 → 有变更立刻发（限流 20 封/分 + 3 分钟去重照旧，这就是防轰炸）；
     · 设了免打扰 → 期间全部攒着，免打扰一结束**第一时间合并成一封**发出去
       （到点合并由 flushDue / outbox 完成，见下面两处的说明）。
   顺带的好处：「汇总时间」原本是最容易被配成「攒一整天、结果半夜发」的一项，
   现在不可能配错了。 */

/** 待发队列。只存内存：重启后丢失，但通知本身是「尽力而为」，不值得为它落库。 */
let pending = [];
/** 队列里「最新的一次计划发送时刻」，用于界面显示「下一次什么时候发」 */
let pendingAt = 0;

/** 墙上时间：把瞬时按给定时区偏移换算成「家里人看到的」日期键与分钟数。
    免打扰（全站 + 个人）的跨零点判定统一在 quiet.js 里，见那里的说明。 */
const quiet = require('./quiet');
const { outOfQuiet } = quiet;

/**
 * 这次变更通知应该「什么时候」发出去。
 * @returns {number} 毫秒时间戳；等于/早于当前时刻表示立即发送
 */
function nextSendMoment(nowMs, cfg) {
  const tz = Number(cfg.tzOffsetMinutes) || 0;
  // 没有汇总时间这层了：要么现在，要么免打扰结束的那一刻
  return outOfQuiet(nowMs, cfg, tz);
}

/** 队列的可观测信息（管理端把它显示出来，「设置了但没动静」才排查得下去）
 *  v4.14.0：除了内存里的待发（全站免打扰），再报一份发件箱积压（个人免打扰）——
 *  两者都是「攒着等免打扰结束」的意思，分开报才知道是谁在等。 */
function queueInfo() {
  return {
    pending: pending.length,
    nextAt: pendingAt ? new Date(pendingAt).toISOString() : '',
    outbox: outbox.pendingCount(0),
  };
}

function getStatus() {
  return { ...lastStatus, errors: [...lastStatus.errors], kinds: loadKinds(), queue: queueInfo(), deduped: dedupedCount };
}

function pushError(msg) {
  lastStatus.errors = [...lastStatus.errors.slice(-4), String(msg).slice(0, 200)];
}

/** 分项：哪几类内容会触发通知。settings 里没有这条记录 = 全开（升级后行为不变）。 */
function loadKinds() {
  const row = db.get("SELECT value FROM settings WHERE key = 'notify_kinds'");
  if (!row) return ALL_KINDS.slice();
  const list = String(row.value).split(',')
    .map((s) => s.trim())
    .filter((k) => ALL_KINDS.includes(k));
  return list;
}

/**
 * 通知开关。
 * @param {string} [kind] 传了就连分项一起判断；不传只看总开关
 *   （老代码/老测试都是无参调用，必须保持可用）。
 */
function isEnabled(kind) {
  const row = db.get("SELECT value FROM settings WHERE key = 'notify_on_change'");
  const master = !row || String(row.value) !== '0';
  if (!master) return false;
  if (!kind) return true;
  return loadKinds().includes(kind);
}

function nounOf(kind) {
  return NOUN[kind] || '内容';
}

function verbOf(action, kind) {
  if (kind === 'comment') return '评论了';
  return action === 'update' ? '更新了' : '新增了';
}

function clip(text, max) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** 内容变更通知的模板变量（v4.21.0 需求 1：文案可配置，这里是唯一取数口） */
function changeVars(ev) {
  const who = `${ev.actor} ${verbOf(ev.action, ev.kind)}${nounOf(ev.kind)}`;
  return {
    站名: config.siteName,
    谁做了什么: who,
    标题行: ev.title ? (ev.kind === 'comment' ? `动态：${ev.title}` : `标题：${ev.title}`) : '',
    内容行: ev.detail ? (ev.kind === 'comment' ? `评论：${ev.detail}` : `内容：${ev.detail}`) : '',
    操作人: String(ev.actor || ''),
    动作: verbOf(ev.action, ev.kind),
    对象: nounOf(ev.kind),
  };
}

function buildText(ev) {
  // 站名取自 config.siteName，不能写死 —— 管理员在「家庭设置」里改了名，
  // 邮件正文也必须跟着改，否则标题叫新名、正文叫旧名（v1.8.0 修）。
  return msgTpl.render('notify_change', changeVars(ev)).text;
}

/** HTML 版通知（默认模板走结构化版式，自定义模板走品牌外壳 + 原文） */
function buildHtml(ev) {
  const custom = msgTpl.htmlFor('notify_change', changeVars(ev), {
    kind: ev.kind === 'comment' ? 'comment' : ev.kind,
    footnote: '你收到这封邮件，是因为你在这个家庭空间里配置了收件邮箱。',
  });
  if (custom) return custom;
  const rows = [];
  if (ev.kind === 'comment') {
    if (ev.title) rows.push({ label: '动态', value: ev.title });
    if (ev.detail) rows.push({ label: '评论', value: ev.detail, strong: true });
  } else {
    if (ev.title) rows.push({ label: '标题', value: ev.title, strong: true });
    if (ev.detail) rows.push({ label: '内容', value: ev.detail });
  }
  // 评论是挂在某条动态下的，可视作动态的一类，配色跟动态一致
  const kindKey = ev.kind === 'comment' ? 'comment' : ev.kind;
  return reminders.mailLayout({
    heading: `${ev.actor} ${verbOf(ev.action, ev.kind)}${nounOf(ev.kind)}`,
    badge: `${KIND_LABEL[ev.kind] || '家庭内容'} · ${config.siteName}`,
    intro: '家里有人更新了设为「全家共享」的内容。',
    rows,
    kind: kindKey,
    footnote: '你收到这封邮件，是因为你在这个家庭空间里配置了收件邮箱。',
  });
}

/** 一条变更通知的完整消息（标题 / 纯文本 / HTML） */
function buildMessage(ev) {
  const r = msgTpl.render('notify_change', changeVars(ev));
  return { subject: r.subject, text: r.text, html: buildHtml(ev) };
}

/** 收件人候选：**有收件邮箱或走企业微信**、且**不是**这次动作的作者（自己的操作不通知自己）
 *  v4.7.0 需求 2：门槛从「有邮箱」放宽成「有邮箱 **或** 选了企业微信」——
 *  否则只填了企业微信的家庭成员永远收不到内容变更通知。 */
function recipientsExcept(actorIds) {
  const ids = Array.from(new Set(actorIds)).filter((x) => x != null);
  // ★ 一个作者都认不出来时**返回空**（与旧实现一致）：宁可这一轮不发，
  //   也不能把作者本人算进收件人 —— 自己的操作不该通知自己。
  if (!ids.length) return [];
  const marks = ids.map(() => '?').join(',');
  const rows = db.all(
    `SELECT id, display_name, username, notify_email, push_channel FROM users WHERE id NOT IN (${marks})`,
    ids,
  );
  return rows.filter((u) => {
    // v4.8.0：默认通道是 'auto'（优先企业微信），只有明确选「只用邮件」的人才必须有邮箱
    const ch = push.normalizeChannel(u.push_channel);
    return !!u.notify_email || ch !== 'mail';
  });
}

/**
 * 把「指定可见成员」的两种入参形式统一成 id 数组。
 * 上游可能传 `",2,3,"`（数据库里那种格式）或 `[2,3]`（新接口），这里都认。
 * 非法值（空串 / 0 / 非数字）直接丢 —— 名单只影响「发给谁」，宁可少发也不发错人。
 */
function toIdList(v) {
  const raw = Array.isArray(v) ? v : String(v == null ? '' : v).split(',');
  const out = [];
  for (const x of raw) {
    const id = Number(String(x).trim()) || 0;
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * v2.0.0：把「个人免打扰结束时刻」算出来。
 * 传入的时刻若落在该用户自己的免打扰时段内，返回免打扰结束的瞬时；否则原样返回。
 * 复用 outOfQuiet 是刻意的 —— 跨零点、起止相同等边界只有一处实现。
 */
function quietEndFor(ms, quiet, tzOffsetMinutes) {
  if (!quiet || !quiet.start || !quiet.end) return ms;
  return outOfQuiet(ms, { notifyQuietStart: quiet.start, notifyQuietEnd: quiet.end }, tzOffsetMinutes);
}

/**
 * 单个事件的最终收件人：在「配了邮箱且不是作者」之上，再过一层**个人偏好**。
 * ★ 个人只能收窄：这里只判个人开关与个人分项；全局开关在 isEnabled() 里已经判过。
 * ★ 只给「一个事件一封邮件」的场景用（changed / 立即发）。多条合并成一封摘要时
 *   必须改用 recipientsExcept(整批作者) —— 逐条调这里会把其他作者变成收件人。
 * @returns {{email:string,id:number}[]}
 */
function notifyTargets(actorIds, kind, prefsMap) {
  return recipientsExcept(actorIds)
    .filter((u) => userprefs.wantsNotify(u.id, kind, prefsMap.get(Number(u.id))))
    .map((u) => ({
      id: Number(u.id),
      email: u.notify_email,
      username: u.username,
      name: u.display_name || u.username,
      channel: push.normalizeChannel(u.push_channel),
    }));
}

/** 限流闸门：一分钟最多 N 封（N 来自 settings.notify_max_per_min，v4.15.0 需求 8）。
 *  返回 false 表示这一封被拦下了。阈值每次现读，管理员改完立即生效。 */
function passRateLimit() {
  const now = Date.now();
  const max = reminders.loadRemindSettings().notifyMaxPerMin;
  if (now - windowStart > WINDOW_MS) { windowStart = now; windowCount = 0; }
  if (windowCount >= max) {
    lastStatus.dropped++;
    pushError(`一分钟内通知超过 ${max} 封，已暂停发送以免邮件轰炸（可在「我的 → 消息推送设置 → 内容通知」里调整）`);
    return false;
  }
  windowCount++;
  return true;
}

/** 真正入队发送。抽出来是因为「立即发」与「到点冲刷」两条路径都要用它。
 *  v4.7.0 需求 2：发信不再直接调 mailer，而是交给 push 按**每个收件人**的通道分流；
 *  邮件仍是一封群发（发信量与合并逻辑不变），选了企业微信的人额外各推一条。 */
function dispatch(targets, subject, text, html, cfg) {
  lastStatus.at = new Date().toISOString();
  queue = queue.then(async () => {
    const res = await push.deliver(targets, { subject, text, html }, {
      kind: 'notify',
      smtpReady: !!(cfg.smtpUser && cfg.smtpPass),
      sendMail: ({ to, subject: s, text: t, html: h }) => mailer.sendMail(smtpOpts(cfg, to, s, t, h)),
    });
    /* ★ v4.28.2：判据统一走 push.sentAny()（含飞书 / 钉钉）。
       旧写法只看 mail + wecom，只配飞书 / 钉钉的家庭会被记成「没有可用通道」并计 dropped，
       统计与推送日志都对不上真实投递。 */
    if (push.sentAny(res)) {
      lastStatus.sent++;
      lastStatus.recipients += res.mail + res.wecom + res.feishu + res.dingtalk + (res.deferred || 0);
    }
    for (const e of res.errors) pushError(e);
    if (!push.sentAny(res) && !res.errors.length) {
      lastStatus.dropped++;
      pushError('这条通知没有可用的推送通道（邮件 / 企业微信 / 飞书 / 钉钉都发不出去），已跳过');
    }
  }).catch((err) => pushError(err && err.message ? err.message : err));
}

function smtpOpts(cfg, emails, subject, text, html) {
  return {
    host: cfg.smtpHost, port: cfg.smtpPort, user: cfg.smtpUser, pass: cfg.smtpPass,
    fromName: config.siteName, to: emails, subject, text, html,
  };
}

/** 立即发一封（未设置发送时机时的原行为）。targets 由调用方算好（已过个人偏好） */
function sendOne(ev, cfg, targets) {
  if (!targets || !targets.length) return false;                        // 家里只有作者一人收得到（或都被个人设置挡了）
  if (!passRateLimit()) return false;
  const actorName = ev.actor.display_name || ev.actor.username || '家人';
  const shown = {
    actor: actorName, kind: ev.kind, action: ev.action,
    title: clip(ev.title, 60), detail: clip(ev.detail, 400),
  };
  const msg = buildMessage(shown);
  dispatch(targets, msg.subject, msg.text, msg.html, cfg);
  return true;
}

/** 合并通知的模板变量 */
function digestVars(items) {
  const lines = [];
  items.forEach((it, i) => {
    lines.push(`${i + 1}. ${it.actorName} ${verbOf(it.action, it.kind)}${nounOf(it.kind)}${it.title ? '：' + it.title : ''}`);
    if (it.detail) lines.push(`   ${it.detail}`);
  });
  return { 站名: config.siteName, 条数: String(items.length), 明细: lines.join('\n') };
}

/** 多条的汇总正文（汇总模式下到点合并成一封，避免早上八点同时轰出十几封） */
function buildDigestText(items) {
  return msgTpl.render('notify_digest', digestVars(items)).text;
}

/** 汇总消息的完整形态（标题随模板走） */
function buildDigest(items) {
  const vars = digestVars(items);
  const r = msgTpl.render('notify_digest', vars);
  const custom = msgTpl.htmlFor('notify_digest', vars, {
    kind: 'post',
    footnote: '你收到这封邮件，是因为你在这个家庭空间里配置了收件邮箱。',
  });
  return { subject: r.subject, text: r.text, html: custom || buildDigestHtml(items) };
}

function buildDigestHtml(items) {
  return reminders.mailLayout({
    heading: `家庭里有 ${items.length} 条新更新`,
    badge: `内容变更 · ${config.siteName}`,
    intro: '家里有人更新了设为「全家共享」的内容。',
    rows: items.map((it) => ({
      label: `${it.actorName} ${verbOf(it.action, it.kind)}${nounOf(it.kind)}`,
      value: [it.title, it.detail].filter(Boolean).join(' · ') || '（无详情）',
    })),
    kind: 'post',
    footnote: '你收到这封邮件，是因为你在这个家庭空间里配置了收件邮箱。',
  });
}

/**
 * 内容变更通知入口（同步返回，发信在后台队列里进行）。
 *
 * v1.9.0 起多了一层「什么时候发」：管理员设了汇总时间或免打扰时段时，
 * 事件先进待发队列，到点由 flushDue() 合并发出；两者都没设时行为与旧版一致（立即发）。
 *
 * @param {{actor:object, kind:'todo'|'post'|'record'|'comment', action:'create'|'update',
 *          title?:string, detail?:string, visibility?:string, visibleTo?:string|number[]}} ev
 * @returns {boolean} 是否真的排入了发送队列（便于测试断言）
 */
function changed(ev) {
  try {
    if (!ev || !ev.actor || !ev.actor.id) return false;
    /* v4.28.2：可见性从「全家 / 仅自己」变成「全家 / 指定可见成员」。
       · family → 照旧发给除作者外的全体（再看个人偏好）；
       · private → **只发给被点名的成员**，没被点名的人连邮件都不该收到
         （需求原文：「该条信息的推送逻辑以此设置为准，对不可见成员不推送」）。
         名单为空 = 仅自己可见 → 一个收件人都没有，直接不发。 */
    const visPrivate = String(ev.visibility || 'family') === 'private';
    const allowed = visPrivate ? toIdList(ev.visibleTo) : null;
    if (visPrivate && !allowed.length) return false;
    if (!isEnabled(ev.kind)) return false;                              // 总开关 + 该类型的分项开关

    const cfg = reminders.loadRemindSettings();
    /* v4.7.0 需求 2：没配发件邮箱不再等于「不发」—— 只要家里有人走企业微信就继续。 */
    if ((!cfg.smtpUser || !cfg.smtpPass) && !push.hasWecomRecipients()) return false;

    // v2.0.0：先算出「按个人偏好过滤后的收件人」——没有收件人就别排队了
    const prefsMap = userprefs.loadAll();
    let targets = notifyTargets([ev.actor.id], ev.kind, prefsMap);
    /* 私密内容只发给名单里的人。★ 放在 notifyTargets 之后：个人偏好（不想收 / 分项关闭）
       依然优先，名单只能进一步收窄，不能反过来把「关掉了通知」的人拉回来。 */
    if (visPrivate) targets = targets.filter((t) => allowed.includes(Number(t.id)));
    if (!targets.length) return false;

    const nowMs = Date.now();

    /* v4.2.0 需求 4：短时间内的连续编辑只提醒一次 —— 详见 DEDUPE_WINDOW_MS 的说明。
       放在收件人判定之后：家里没人收通知时不该白白占掉去重窗口。
       dkey 为空串（拿不到条目 id，例如老调用方）时**跳过整段去重**，行为与旧版一致。 */
    const dkey = dedupeKey(ev);
    if (dkey) {
      const lastAt = dedupeMap.get(dkey) || 0;
      if (nowMs - lastAt < DEDUPE_WINDOW_MS) {
        dedupedCount++;
        // 汇总模式下已有同一条待发条目 → 原地更新成最新内容，到点合并的摘要里仍然只有一条
        const queued = pending.filter((e) => e.key === dkey)[0];
        if (queued) {
          queued.title = clip(ev.title, 60);
          queued.detail = clip(ev.detail, 400);
          queued.allow = visPrivate ? allowed : null;   // 窗口内改了可见范围也要跟上
        }
        return false;
      }
      dedupeMap.set(dkey, nowMs);
      // 顺手清理过期键：长跑进程里不能让这个 Map 无限长大
      if (dedupeMap.size > 200) {
        for (const [k, t] of dedupeMap) if (nowMs - t >= DEDUPE_WINDOW_MS) dedupeMap.delete(k);
      }
    }

    let at = nextSendMoment(nowMs, cfg);
    /* ★ v4.3.3 需求 2：个人免打扰改为**按人拆开**，不再「取最晚的那个人」。
       旧写法的代价：一个人设了 22:00→08:00，全家都被压到早上 8 点才收到；
       而且到点后是逐条发，早上起来收件箱里躺着好几封。
       现在：还在免打扰里的人各自入发件箱（due = 他自己的免打扰结束），
       由 outbox 到点**合并成一封**发给他；已经出来的人照旧立即发 / 按汇总时间排队。 */
    const actorName = ev.actor.display_name || ev.actor.username || '家人';
    const shown = {
      actor: actorName, kind: ev.kind, action: ev.action,
      title: clip(ev.title, 60), detail: clip(ev.detail, 400),
    };
    const stillQuiet = [];
    for (const t of targets) {
      const end = quietEndFor(nowMs, userprefs.quietOf(t.id, 'notify', prefsMap.get(t.id)), cfg.tzOffsetMinutes);
      if (end > nowMs + 500) stillQuiet.push({ t, end });
    }
    if (stillQuiet.length) {
      const msg = buildMessage(shown);
      const subject = msg.subject;
      const text = msg.text;
      const html = msg.html;
      /* originId 必须**每一条事件都稳定且互不相同**：拿不到 ev.id 时用「负数时间戳」兜底。
         若都退化成 0，outbox 的幂等查重会把不同事件当成同一条，只留最后一封。 */
      const originId = Number(ev.id) || (0 - nowMs - Math.floor(Math.random() * 100000));
      let queued = 0;
      for (const { t, end } of stillQuiet) {
        const id = outbox.enqueue({
          userId: t.id, email: t.email, kind: ev.kind, subject, text, html,
          dueAt: end, originId,
        });
        if (id) queued++;
      }
      // 不在免打扰里的收件人：完全按原有「汇总时间 / 立即发」逻辑走，与免打扰无关
      const rest = targets.filter((t) => !stillQuiet.some((x) => x.t.id === t.id));
      if (rest.length) {
        const at2 = nextSendMoment(nowMs, cfg);
        if (at2 <= nowMs + 500) {
          if (sendOne(ev, cfg, rest)) queued++;
        } else {
          pending.push({
            key: dkey, actorId: ev.actor.id, actorName, kind: ev.kind, action: ev.action,
            title: shown.title, detail: shown.detail, at: at2,
            allow: visPrivate ? allowed : null,
          });
          pendingAt = Math.max(pendingAt, at2);
        }
      }
      return queued > 0;
    }
    if (at <= nowMs + 500) return sendOne(ev, cfg, targets);            // 没设时机 → 立即发

    pending.push({
      key: dkey,                     // v4.2.0：汇总模式下按此键原地更新，不重复排队
      actorId: ev.actor.id,
      actorName,
      kind: ev.kind,
      action: ev.action,
      title: shown.title,
      detail: shown.detail,
      at,
      /* v4.28.2：私密内容排队时也要记住「只发给谁」——汇总是在 later 才发的，
         不带着名单，到点就会发给全家（这正是「不可见成员也收到推送」的口子）。 */
      allow: visPrivate ? allowed : null,
    });
    pendingAt = Math.max(pendingAt, at);
    return true;
  } catch (err) {
    pushError(err && err.message ? err.message : err);
    return false;
  }
}

/* v4.3.3 需求 2：免打扰积压发件箱的冲刷。
   为什么 notify 这里也要做一次：待办提醒有独立的总开关，关掉之后
   reminders.runScan 会直接早退 —— 但「内容变更通知」的积压仍要能发出去，
   否则就是一堆提醒被静默吞掉（本项目最忌讳的失败方式）。
   outbox.flush 内部有并发锁，两处同时调用也不会把同一批发两遍。 */
let outboxBusy = false;
function flushOutbox(nowMs) {
  if (outboxBusy) return;
  const cfg = reminders.loadRemindSettings();
  /* v4.7.0 需求 2：SMTP 没配不再等于「不冲」。家里有人选企业微信时照样要发，
     否则免打扰期间积压的通知会永远卡在队列里。 */
  const smtpReady = !!(cfg.smtpUser && cfg.smtpPass);
  if (!smtpReady && !push.hasWecomRecipients()) return;
  outboxBusy = true;
  outbox.flush({
    smtp: { user: cfg.smtpUser, pass: cfg.smtpPass },
    smtpReady,
    now: nowMs || Date.now(),
    sendMail: ({ to, subject, text, html }) => mailer.sendMail(smtpOpts(cfg, to, subject, text, html)),
  }).then((r) => {
    if (r.mails) {
      lastStatus.at = new Date().toISOString();
      lastStatus.sent += r.mails;
      lastStatus.recipients += r.rows;
    }
    for (const e of r.errors) pushError(e);
  }).catch((err) => pushError(err && err.message ? err.message : err))
    .finally(() => { outboxBusy = false; });
}

/**
 * 冲刷到点的待发通知（server.js 每分钟调用一次）。
 * 到点的多条**合并成一封**摘要 —— 汇总模式的意义就在于此。
 */
function flushDue(nowMs = Date.now()) {
  try {
    // 先顺手把免打扰积压发掉（与内存里有没有待发通知无关）
    flushOutbox(nowMs);
    if (!pending.length) return { sent: 0, pending: 0 };
    const due = pending.filter((e) => e.at <= nowMs);
    if (!due.length) return { sent: 0, pending: pending.length };

    const cfg = reminders.loadRemindSettings();
    /* v4.7.0 需求 2：与企业微信共存 —— 没 SMTP 但有人走企业微信时照样要发。 */
    if ((!cfg.smtpUser || !cfg.smtpPass) && !push.hasWecomRecipients()) {
      return { sent: 0, pending: pending.length };
    }

    pending = pending.filter((e) => e.at > nowMs);
    pendingAt = pending.length ? Math.max(...pending.map((e) => e.at)) : 0;

    // v2.0.0：收件人再过一次个人偏好（有人在排队期间改了设置，这里要跟上）
    //
    // ★ 排除作者必须按「整批一起排」，不能逐条排。
    //   逐条的话，妈妈那条会把爸爸算成收件人、爸爸那条会把妈妈算成收件人，
    //   结果是两个人各自收到「包含自己刚做的变更」的摘要 —— 恰好破坏了
    //   「自己的操作不通知自己」这条最基本的规则（notify.test.js 专门盯着它）。
    //   分项开关（notify_kinds）反过来是逐条看：这批里只要有任意一条类型
    //   是他愿意收的，就发给他 —— 收件人只收一封摘要，没有「半封」的说法。
    const prefsMap = userprefs.loadAll();
    /* ★ v4.28.2：先按「可见名单」分组再发。
       一条摘要会把多条变更并进同一封邮件，所以收件人必须**看得见摘要里的每一条**：
         · allow == null → 全家可见，一组；
         · allow == [2,3] → 指定成员可见，同一份名单的人一组；
       同一分钟里既有全家可见又有私密变更时会拆成两封 —— 这是正确性的代价，
       把私密标题塞进集体摘要等于对不可见成员泄露内容。
       （收件人仍然按「整批排除作者」算，理由见上面那段注释。） */
    const groups = new Map();
    for (const e of due) {
      const key = e.allow == null ? '' : e.allow.join(',');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    let sent = 0;
    let dropped = 0;
    for (const list of groups.values()) {
      const actorIds = list.map((e) => e.actorId);
      const targets = recipientsExcept(actorIds)
        .filter((u) => list.some((e) => userprefs.wantsNotify(u.id, e.kind, prefsMap.get(Number(u.id)))))
        .map((u) => ({
          id: Number(u.id), email: u.notify_email, username: u.username,
          name: u.display_name || u.username,
          channel: push.normalizeChannel(u.push_channel),
        }));
      if (!targets.length) { dropped += list.length; continue; }
      if (!passRateLimit()) { dropped += list.length; continue; }
      const digest = buildDigest(list);
      dispatch(
        targets,
        digest.subject,
        digest.text, digest.html, cfg,
      );
      sent += list.length;
    }
    if (dropped) {
      // 没有收件人：明确记账，别让攒了半天的通知无声消失（这是本项目最忌讳的静默失败）
      lastStatus.dropped += dropped;
      pushError(`有 ${dropped} 条变更通知到点了，但家里没有其他成员配置收件邮箱或企业微信`
        + '（或都在个人设置里关掉了这类通知、或不在「指定可见成员」名单里），已跳过');
    }
    return { sent, pending: pending.length };
  } catch (err) {
    pushError(err && err.message ? err.message : err);
    return { sent: 0, pending: pending.length };
  }
}

/**
 * 手动清空限流窗口。管理端「立即重新扫描」会调用：
 * 触发过「一分钟 20 封」之后，窗口本来要等满一分钟才自然过期，
 * 期间所有通知都会被静默丢掉——必须给管理员一个立刻恢复的手段。
 * dropped 计数保留，作为历史痕迹继续展示。
 */
function resetRateLimit() {
  windowStart = Date.now();
  windowCount = 0;
}

module.exports = {
  changed, isEnabled, getStatus, resetRateLimit,
  loadKinds, buildText, buildHtml, ALL_KINDS, KIND_LABEL,
  // v4.21.0 需求 1：模板化后的完整消息（标题也随模板走，测试与调用方共用）
  buildMessage, buildDigest, changeVars, digestVars,
  // v1.9.0：发送时机与待发队列
  flushDue, queueInfo, nextSendMoment, outOfQuiet,
  buildDigestText, buildDigestHtml,
  // v2.0.0：个人偏好参与收件人判定
  recipientsExcept, notifyTargets, quietEndFor,
  // v4.2.0 需求 4：短时间连续编辑去重
  resetDedupe, DEDUPE_WINDOW_MS, dedupeKey,
};
