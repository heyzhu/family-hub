'use strict';
/**
 * 统一推送通道（v4.7.0 需求 2，v4.8.0 需求 4 调整默认策略）
 *
 * 背景：v4.5.0 之前所有「主动提醒」都只有邮件一条路（待办提醒、内容变更通知）。
 * 很多家庭根本没配发件邮箱，等于这些提醒全部落空；而企业微信通道当时只接了记账报表。
 * 本模块把「发给谁」与「怎么发」拆开：调用方只管拼一条消息，通道由**每个收件人自己**决定。
 *
 * 依赖方向：push → db / config / wecom（都不反向 require 本模块，不成环）。
 * ★ 绝不 require notifications / reminders / outbox —— 那三个都要反过来用它。
 *
 * 通道取值（v4.28.3 起）：只剩四条**具体**通道 —— 'wecom' / 'mail' / 'feishu' / 'dingtalk'。
 *
 * 每人对每条内容有两层选择：
 *   · 首选（users.push_channel，或 user_prefs.channel_todo/notify/bill 的单类覆盖）——
 *     消息先走它；
 *   · 兜底（users.push_fallback，全局唯一）—— 首选发不出去（没绑定 / 发送失败 /
 *     通道没配）时才走它；空串 = 不设兜底。
 *
 * ★ v4.28.3 删掉了 'auto'（智能）与 'both'（双渠道）：
 *   'auto' 是在替用户猜优先级、'both' 是让同一份内容发两遍。现在两件事都由用户显式选。
 *   老库里的这两个值由 db.js 的一次性迁移落成「wecom + mail」，
 *   normalizeChannel 里也保留了同样的映射 —— 迁移没跑到也不会投递失败。
 * ★ 首选整条通道都没配（不是「这个人没绑定」）时，会落到兜底或任一可用通道：
 *   「绝不静默丢弃」是这个模块从 v4.7.0 起的硬承诺。
 */

// ★ db.js 导出的是 { db, ... }，引擎挂在 .db 上；解构取错会得到「get is not a function」
const { db } = require('./db');
const config = require('./config');
const wecom = require('./wecom');
const feishu = require('./feishu');
const dingtalk = require('./dingtalk');
const quiet = require('./quiet');   // 纯计算模块，零依赖，不会成环
const userprefs = require('./userprefs');   // 只依赖 db；push → userprefs 单向

/* v4.28.3：通道模型从「六选一」改成「首选 + 兜底」。
   『智能』『双渠道』这两种模式被删除 —— 它们原本是在替用户猜：
     · 智能   = 先企业微信、失败回退邮件；
     · 双渠道 = 邮件和企业微信都发一遍。
   现在两件事都由用户显式选择：**首选**发不出去时才走**兜底**。
   语义变了，取值集合也收敛成四条**具体**通道（不再有组合值）。 */
const CHANNELS = ['wecom', 'mail', 'feishu', 'dingtalk'];
/** 老库 / 没选过的人用这个默认首选：等价于原来的「智能」语义的首腿，升级后行为不变 */
const DEFAULT_CHANNEL = 'wecom';
/* v4.28.3：'auto' / 'both' 已下线，但它们还躺在老库里（users.push_channel /
   user_prefs.channel_*）。这里做一次映射，保证「没迁移到」的脏数据也能正常投递。
   ★ auto → wecom 只是首选；它的「邮件兜底」由 db.js 的一次性迁移写进 push_fallback。
     万一迁移没跑到，deliver 的「首选不可用就降级」仍不会让消息丢掉。 */
const LEGACY_CHANNELS = { auto: 'wecom', both: 'wecom' };
const CHANNEL_LABEL = {
  wecom: '企业微信',
  feishu: '飞书群',
  dingtalk: '钉钉群',
  mail: '邮件',
};

/** 任何脏值一律当默认值处理：用户把设置改坏了也不该让提醒停掉 */
function normalizeChannel(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (LEGACY_CHANNELS[s]) return LEGACY_CHANNELS[s];
  return CHANNELS.includes(s) ? s : DEFAULT_CHANNEL;
}

/** 兜底通道：'' = 不设兜底（首选发不出去就如实报错，不替用户换通道） */
function normalizeFallback(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return '';
  if (LEGACY_CHANNELS[s]) return LEGACY_CHANNELS[s];
  return CHANNELS.includes(s) ? s : '';
}

/** 读某个家庭成员的推送通道（首选）；没设置过 = DEFAULT_CHANNEL */
function channelOf(userId) {
  const id = Number(userId) || 0;
  if (!id) return DEFAULT_CHANNEL;
  const row = db.get('SELECT push_channel FROM users WHERE id = ?', [id]);
  return normalizeChannel(row && row.push_channel);
}

/** 读某个家庭成员的兜底通道；没设置过 / 关掉 = ''（不兜底） */
function fallbackOf(userId) {
  const id = Number(userId) || 0;
  if (!id) return '';
  const row = db.get('SELECT push_fallback FROM users WHERE id = ?', [id]);
  return normalizeFallback(row && row.push_fallback);
}

/**
 * v4.25.0 需求 4：**按内容类别**取通道。
 *
 * 「待办 / 内容 / 记账」三类可以各自指定走哪条通道，配置在「消息推送设置」里
 * 三者的设置菜单内（个人偏好，键 `channel_todo / channel_notify / channel_bill`）。
 * 没单独配（键不存在）就沿用这个人的「推送方式」（push_channel）—— 这才是默认行为，
 * 老库升级后一行数据都不需要改。
 *
 * `kind` 用的是 push 日志那套既有口径（remind / record / notify / bill），
 * 不做二次命名：日志里写的是哪一类，路由就按哪一类走，排查时对得上。
 *
 * @param {number} userId
 * @param {string} [kind] 未知/空 → 纯全局
 * @param {Map<number, object>} [prefsMap] 批量场景传入 userprefs.loadAll()，省掉逐人查库
 */
const KIND_CHANNEL_KEY = {
  remind: 'channel_todo',
  record: 'channel_todo',    // 记录本提醒也是「待办类」，与待办共用一个开关，不再多造一个概念
  notify: 'channel_notify',
  bill: 'channel_bill',
};
function channelFor(userId, kind, prefsMap) {
  const id = Number(userId) || 0;
  if (!id) return DEFAULT_CHANNEL;
  const key = KIND_CHANNEL_KEY[String(kind || '').trim()];
  if (key) {
    const p = prefsMap ? (prefsMap.get(id) || {}) : userprefs.load(id);
    const v = String(p[key] == null ? '' : p[key]).trim().toLowerCase();
    if (v && v !== 'inherit') return normalizeChannel(v);
  }
  return channelOf(id);
}

/**
 * v4.28.3：一次拿到「首选 + 兜底」。
 *
 * 需求口径：待办提醒 / 内容通知 / 记账三类**默认跟随**全局的首选+兜底；
 * 用户可以在某一类上单独指定**首选**，而**兜底永远沿用全局设置** ——
 * 不允许「三类各配一套兜底」，否则出问题时没人说得清消息到底该往哪落。
 *
 * @returns {{primary:string, fallback:string, overridden:boolean}}
 *   overridden = 这一类的首选是用户单独指定的（不是跟随全局）
 */
function modeFor(userId, kind, prefsMap) {
  const id = Number(userId) || 0;
  if (!id) return { primary: DEFAULT_CHANNEL, fallback: '', overridden: false };
  const globalPrimary = channelOf(id);
  const fallback = fallbackOf(id);
  const key = KIND_CHANNEL_KEY[String(kind || '').trim()];
  if (key) {
    const p = prefsMap ? (prefsMap.get(id) || {}) : userprefs.load(id);
    const v = String(p[key] == null ? '' : p[key]).trim().toLowerCase();
    if (v && v !== 'inherit' && v !== 'auto' && v !== 'both') {
      return { primary: normalizeChannel(v), fallback, overridden: true };
    }
  }
  return { primary: globalPrimary, fallback, overridden: false };
}

/** 家庭账号（username）→ 企业微信 UserID；没绑定返回空串 */
function wecomIdOf(username, cfg) {
  const want = String(username || '').trim();
  if (!want) return '';
  const c = cfg || wecom.loadConfig();
  for (const [wx, fh] of wecom.userMapOf(c)) {
    if (fh === want) return wx;
  }
  return '';
}

/** 只知道 userId 时反查 username（发件箱里只存了 user_id + email） */
function usernameOf(userId) {
  const id = Number(userId) || 0;
  if (!id) return '';
  const row = db.get('SELECT username FROM users WHERE id = ?', [id]);
  return String((row && row.username) || '');
}

/**
 * 企业微信侧的文案（v4.8.0 需求 5：排版与截断都改过）。
 *
 * 「两种方式内容一致」是需求原话 —— 企业微信没有 subject 这个概念，
 * 所以把标题并进第一行，正文一个字不改（同一份 msg.text，不做二次摘要）。
 *
 * 三个细节都是踩过才知道的：
 *  ① 有些调用方的 text 首行就是标题（邮件正文自带抬头），企业微信再拼一次会重复两遍；
 *  ② 空行不留三个以上（微信里看起来很松散），行尾空格去掉；
 *  ③ 超过 2000 字**不能硬切**（会切在句子中间），改成按行截断并说明去哪里看全文。
 */
function wecomBodyOf(msg, limit) {
  const max = Math.max(200, Number(limit) || 2000);
  const subject = String((msg && msg.subject) || '').trim();
  const raw = String((msg && msg.text) || '').replace(/\r\n?/g, '\n');
  const lines = raw.split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .filter((l, i, arr) => !(l === '' && (i === 0 || arr[i - 1] === '')));  // 连续空行只留一个
  const head = subject ? `【${config.siteName}】${subject}` : `【${config.siteName}】`;
  // 正文首行与标题重复时不再重复（邮件里常见「标题：内容」的排版）
  const first = String(lines[0] || '').trim();
  if (first && subject && (first === subject || first === head || first === `【${config.siteName}】${subject}`)) {
    lines.shift();
  }
  const body = lines.join('\n').replace(/^\n+/, '').trim();
  const full = body ? `${head}\n\n${body}` : head;
  if (full.length <= max) return full;
  // 按行截断：留出尾巴那句话的位置，绝不把最后一行切成半句
  const budget = max - 40;
  const kept = [];
  let used = head.length + 2;
  for (const l of body.split('\n')) {
    if (used + l.length + 1 > budget) break;
    kept.push(l);
    used += l.length + 1;
  }
  const tail = '\n\n…（内容较长，已截断；完整内容请在网页端查看）';
  if (!kept.length) return `${head}${tail}`;
  return `${head}\n\n${kept.join('\n')}${tail}`;
}

/**
 * 把一条消息发给一组人，按每人自己的通道分流。
 *
 * @param {Array<{id?:number, username?:string, email?:string, name?:string,
 *                channel?:string, wecomUser?:string}>} targets
 * @param {{subject:string, text:string, html?:string}} msg
 * @param {{sendMail?:Function, sendWecom?:Function, smtpReady?:boolean}} ctx
 *   sendMail({to:[email...], subject, text, html}) —— 由调用方带 SMTP 配置注入（保持原发信量：一封群发）
 *   sendWecom(toUser, content) —— 默认用企业微信的 sendText
 * @returns {Promise<{mail:number, wecom:number, fallback:number, errors:string[], skipped:string}>}
 */
async function deliver(targets, msg, ctx) {
  const o = ctx || {};
  const out = { mail: 0, wecom: 0, feishu: 0, dingtalk: 0, fallback: 0, errors: [], skipped: '', deferred: 0 };
  const list = (targets || []).filter((t) => t && (t.email || t.id || t.wecomUser || t.username));
  if (!list.length) {
    out.skipped = 'no-target';
    return out;
  }

  const cfg = wecom.loadConfig();
  const wxReady = wecom.isReady(cfg);
  /* v4.12.0 需求（我的 → 推送配置）：每条通道一个家庭级总开关。
     关掉「邮件推送」= 家里不再发任何邮件（待办提醒 / 内容通知 / 报表 / 发件箱冲刷全部生效）；
     关掉「企业微信推送」= 不再走企业微信（回执类消息不受影响，那是应答不是推送）。
     v4.24.0 需求 2：飞书 / 钉钉群机器人同属「即时通道」，各有一个总开关；
     群 Webhook 没有个人绑定概念，配好 Webhook 就等于全家都能收。 */
  const mailOn = config.pushMailEnabled !== false;
  const wecomOn = config.pushWecomEnabled !== false;
  const fsCfg = feishu.loadConfig();
  const dtCfg = dingtalk.loadConfig();
  const fsOn = config.pushFeishuEnabled !== false;
  const dtOn = config.pushDingtalkEnabled !== false;
  const fsReady = feishu.isReady(fsCfg);
  const dtReady = dingtalk.isReady(dtCfg);
  const nowMs = (o.now instanceof Date ? o.now.getTime() : Number(o.now)) || Date.now();
  /* v4.23.0 需求 5：日志用的分类。调用方不传就是 'push'（不猜，宁可粗一点也不写错）。 */
  const kind = String(o.kind || o.deferKind || 'push').slice(0, 20);

  /* v4.28.3：先按「首选 + 兜底」给每个人算出投递计划，再分两轮发。
     上一版是「顺着 ch 的取值写分支」，六种取值各自 if 一遍，谁都说不清
     『智能』『双渠道』到底在哪一行生效。现在只有两个动作：发首选；首选没成就发兜底。 */
  const canMail = mailOn && typeof o.sendMail === 'function' && (o.smtpReady !== false);
  const avail = {
    wecom: wecomOn && wxReady,
    feishu: fsOn && fsReady,
    dingtalk: dtOn && dtReady,
    mail: canMail,
  };
  /** 这条通道「家庭级」是否配置齐全（与具体某个人无关） */
  const chLabel = (ch) => CHANNEL_LABEL[ch] || ch;
  const unavailableWhy = (ch) => {
    if (ch === 'mail') return mailOn ? '还没配置发件邮箱' : '「邮件推送」总开关关着';
    if (ch === 'wecom') return wecomOn ? '企业微信应用未启用' : '「企业微信推送」总开关关着';
    if (ch === 'feishu') return fsOn ? '还没配置飞书群机器人的 Webhook' : '「飞书推送」总开关关着';
    return dtOn ? '还没配置钉钉群机器人的 Webhook' : '「钉钉推送」总开关关着';
  };
  /** 对**这个收件人**来说，这条通道能不能落 */
  const usableFor = (ch, t, wx) => {
    if (!avail[ch]) return { ok: false, why: unavailableWhy(ch) };
    if (ch === 'wecom' && !wx) return { ok: false, why: '还没绑定企业微信账号' };
    if (ch === 'mail' && !t.email) return { ok: false, why: '没有设置收件邮箱' };
    return { ok: true, why: '' };
  };
  const firstUsable = (t, wx, except) => CHANNELS.find((c) => c !== except && usableFor(c, t, wx).ok) || '';

  /* v4.23.0 需求 5：每个收件人一条「投递计划」，发送完成后按它写日志 ——
     一条日志要能回答「这个人这条消息走了哪条通道、成没成、为什么没成」。 */
  const plans = [];
  /* v4.25.0 需求 4：类别通道是个人偏好，一次取全，别逐人查库 */
  const prefsMap = userprefs.loadAll();
  for (const t of list) {
    const mode = modeFor(t.id, kind, prefsMap);
    /* 调用方显式指定的 channel（免打扰冲刷 / 单测）优先；它只顶替**首选**，
       兜底永远取该成员在设置里选的兜底 —— 与「三类自定义」同一口径。 */
    const explicit = String(t.channel || '').trim().toLowerCase();
    let primary = explicit ? normalizeChannel(explicit) : mode.primary;
    const primarySet = primary;
    let fallback = normalizeFallback(mode.fallback);
    const uname = t.username || usernameOf(t.id);
    const wx = t.wecomUser || wecomIdOf(uname, cfg);
    const name = t.name || uname || t.email || wx || `用户${Number(t.id) || ''}`;

    /* 首选这条通道**整个家庭都没配**（不是「这个人没绑定」）时：
       有兜底就交给兜底轮，没兜底就落到任意一条能用的通道上 ——
       「绝不静默丢弃」是这个模块从 v4.7.0 起的硬承诺，用户选错一个没配的通道
       不该表现为「提醒坏了」。 */
    let degradeWhy = '';
    if (!avail[primary]) {
      /* ★ 降级目标必须对**这个人**可用：光看通道配好了不够 ——
         首选企微没配、兜底定成邮件、可他又没留邮箱，那条「已改发邮件」就成了假消息。 */
      const alt = (fallback && usableFor(fallback, t, wx).ok)
        ? fallback
        : firstUsable(t, wx, primary);
      if (alt) {
        degradeWhy = `首选「${chLabel(primary)}」不可用（${unavailableWhy(primary)}），已改发「${chLabel(alt)}」`;
        if (alt === fallback) { primary = alt; fallback = ''; } else { primary = alt; }
      }
    }
    if (fallback === primary) fallback = '';

    const plan = {
      t, ch: primary, primary, primarySet, fallback, name, wx,
      userId: Number(t.id) || 0, ok: false, channel: '', detail: '', deferred: false,
      failWhy: degradeWhy, usedFallback: false,
    };

    /* v4.10.0（差异 #12）：即时通道的**主动推送**同样受个人免打扰约束 ——
       在免打扰时段内不立即发，把消息沉进 mail_outbox（channel=该即时通道，due_at=免打扰结束时刻），
       到点由既有的冲刷任务发出。回执类（记账回执 / 完成回执）走的是消息应答路径，
       不经过本函数，天然不受影响 —— 与文档「免打扰只拦主动推送，不拦回执」一致。
       ★ 只对首选生效：兜底是「首选失败」时才走的路，而免打扰不是失败，是**推迟**。 */
    if ((primary === 'wecom' || primary === 'feishu' || primary === 'dingtalk') && o.deferQuiet !== false) {
      const prefs = quietPrefsOf(t.id);
      const quietEnd = quiet.outOfQuiet(nowMs, prefs, config.tzOffsetMinutes);
      if (quietEnd !== nowMs && deferInstant(t.id, msg, quietEnd, o.deferKind, primary)) {
        out.deferred++;
        plan.deferred = true;
        plan.detail = `免打扰时段内，已入队，${new Date(quietEnd).toISOString()} 后发送`;
      }
    }
    plans.push(plan);
  }

  /* ── 一轮投递：把 batch 里的人按各自本轮的通道分桶发出去 ──────────────
     which='primary' 用首选通道，'fallback' 用兜底通道。
     群机器人（飞书 / 钉钉）一趟只发一条，结果回填给同通道的所有人。 */
  async function dispatchPass(batch, which) {
    if (!batch.length) return;
    const mailItems = [];
    const wxItems = [];
    const hookItems = { feishu: [], dingtalk: [] };
    for (const p of batch) {
      const ch = which === 'primary' ? p.primary : p.fallback;
      if (!ch) continue;
      const u = usableFor(ch, p.t, p.wx);
      if (!u.ok) { p.failWhy = p.failWhy || `${chLabel(ch)}：${u.why}`; continue; }
      if (ch === 'wecom') wxItems.push(p);
      else if (ch === 'mail') mailItems.push(p);
      else hookItems[ch].push(p);
    }

    const sendHook = async (chName, plist) => {
      if (!plist.length) return;
      const mod = chName === 'feishu' ? feishu : dingtalk;
      const hcfg = chName === 'feishu' ? fsCfg : dtCfg;
      const label = chName === 'feishu' ? '飞书' : '钉钉';
      try {
        const r = await mod.sendText(hcfg, { content: wecomBodyOf(msg) });
        if (r && r.ok === false) throw new Error(r.errorText || r.error || '发送失败');
        out[chName] = (out[chName] || 0) + 1;
        for (const p of plist) { p.ok = true; p.channel = chName; }
      } catch (err) {
        const why = `${label}群机器人：${(err && err.message) || err}`;
        out.errors.push(why);
        for (const p of plist) p.failWhy = why;
      }
    };
    await sendHook('feishu', hookItems.feishu);
    await sendHook('dingtalk', hookItems.dingtalk);

    /* 邮件仍然一封群发（不改变原有发信量与合并逻辑） */
    if (mailItems.length) {
      try {
        await o.sendMail({
          to: mailItems.map((p) => p.t.email),
          subject: String(msg.subject || ''),
          text: String(msg.text || ''),
          html: String(msg.html || ''),
        });
        out.mail += mailItems.length;
        for (const p of mailItems) { p.ok = true; p.channel = 'mail'; }
      } catch (err) {
        const why = `邮件：${(err && err.message) || err}`;
        out.errors.push(why);
        for (const p of mailItems) p.failWhy = why;
      }
    }

    /* 企业微信只能按人逐个发（没有「群发给这几个人」以外的合并概念） */
    const sendWecom = typeof o.sendWecom === 'function'
      ? o.sendWecom
      : (toUser, content) => wecom.sendText(cfg, { toUser, content });
    /* v4.23.0：报表的邮件是「个人版」、企业微信是「全家版」，两者内容不同；
       允许调用方单独给企微一份 msg（不传就与邮件同一份，行为不变）。 */
    const wxMsg = o.wecomMsg || msg;
    for (const p of wxItems) {
      try {
        const r = await sendWecom(p.wx, wecomBodyOf(wxMsg));
        if (r && r.ok === false) throw new Error(r.error || '发送失败');
        out.wecom++;
        p.ok = true;
        p.channel = 'wecom';
      } catch (err) {
        const why = `企业微信(${p.name})：${(err && err.message) || err}`;
        out.errors.push(why);
        p.failWhy = why;
      }
    }
  }

  await dispatchPass(plans.filter((p) => !p.deferred), 'primary');

  /* 第二轮：首选没成、且用户设了兜底的人。兜底与首选相同则跳过（不重复发同一通道）。 */
  const needFallback = plans.filter((p) => !p.deferred && !p.ok && p.fallback && p.fallback !== p.primary);
  if (needFallback.length) {
    await dispatchPass(needFallback, 'fallback');
    for (const p of needFallback) {
      if (!p.ok) continue;
      p.usedFallback = true;
      out.fallback++;
      p.detail = `${p.failWhy || `首选「${chLabel(p.primary)}」没发出去`} → 已改用「${chLabel(p.fallback)}」送达`;
    }
  }

  /* 收尾：成功的清掉中间态原因；失败的把「为什么」写清楚，一个都不许沉默 */
  for (const p of plans) {
    if (p.deferred) continue;
    if (p.ok) {
      if (p.usedFallback) continue;                     // 上面已经写好「已改用兜底送达」
      p.detail = p.detail || '';
      continue;
    }
    if (!p.failWhy) {
      p.failWhy = p.primary === p.fallback
        ? `首选与兜底都是「${chLabel(p.primary)}」，这条消息没有发出去`
        : `首选「${chLabel(p.primary)}」没发出去，且没有设置兜底方式`;
    }
    p.detail = p.fallback && p.fallback !== p.primary
      ? `${p.failWhy}；兜底「${chLabel(p.fallback)}」也没发出去`
      : p.failWhy;
    if (!out.errors.includes(p.detail)) out.errors.push(p.detail);
  }

  if (!out.mail && !out.wecom && !out.feishu && !out.dingtalk && !out.deferred) out.skipped = 'no-channel';
  /* v4.23.0 需求 5：逐人写推送日志。写失败绝不影响推送本身。 */
  writeLogs(plans.map((p) => ({
    kind,
    userId: p.userId,
    name: p.name,
    channel: p.deferred ? p.ch : p.channel,
    ok: p.ok,
    subject: msg && msg.subject,
    detail: p.deferred ? p.detail : (p.ok ? (p.detail || '') : (p.detail || '没有可用的推送通道')),
  })));
  recordLastPush(out, msg, o);
  return out;
}

/* ── v4.13.0（问题 5）：「上次推送」可观测信息 ─────────────────────
   需求原文：在推送配置里展示上次推送渠道与推送状态，便于排查问题。
   为什么记在 settings 表而不是内存：内存里的东西重启就没了，而「昨天那条提醒
   到底发出去没有」恰恰是重启之后最想知道的。只保留**最近一次**，一个键够用。
   写失败绝不影响推送本身（用户的提醒比这条记录重要）。 */
const LAST_PUSH_KEY = 'push_last';

function recordLastPush(out, msg, o) {
  try {
    const channels = [];
    if (out.wecom) channels.push('wecom');
    if (out.mail) channels.push('mail');
    if (out.feishu) channels.push('feishu');
    if (out.dingtalk) channels.push('dingtalk');
    const rec = {
      at: new Date().toISOString(),
      kind: String((o && o.deferKind) || 'push').slice(0, 20),
      channels,
      ok: channels.length > 0,
      mail: Number(out.mail) || 0,
      wecom: Number(out.wecom) || 0,
      feishu: Number(out.feishu) || 0,
      dingtalk: Number(out.dingtalk) || 0,
      deferred: Number(out.deferred) || 0,
      subject: String((msg && msg.subject) || '').slice(0, 120),
      errors: (out.errors || []).slice(0, 3).map((e) => String(e).slice(0, 200)),
      skipped: String(out.skipped || ''),
    };
    db.run(
      'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [LAST_PUSH_KEY, JSON.stringify(rec)],
    );
  } catch { /* 记录失败不影响推送 */ }
}

/** 上次推送的概要（没有记录返回 null） */
function lastPush() {
  try {
    const row = db.get('SELECT value FROM settings WHERE key = ?', [LAST_PUSH_KEY]);
    const rec = row && row.value ? JSON.parse(row.value) : null;
    return rec && typeof rec === 'object' ? rec : null;
  } catch { return null; }
}

/* ── v4.23.0 需求 5：推送日志 ───────────────────────────────────
   目标：所有推送都留痕，管理员能查、能一键清。
   ★ 日志是**旁路**：写失败、裁剪失败都不允许影响推送本身（外面包 try）。
   ★ 保留上限 3000 条：家用场景下足够回溯一两个月，又不会让单文件库无限长。
     超过就按 id 删除最旧的一段（id 自增，等价于时间序）。 */
const MAX_LOGS = 3000;

function writeLogs(rows) {
  if (!rows || !rows.length) return;
  try {
    const at = new Date().toISOString();
    for (const r of rows) {
      db.run(
        'INSERT INTO push_logs (at, kind, user_id, user_name, channel, ok, subject, detail)'
        + ' VALUES (?,?,?,?,?,?,?,?)',
        [at, String(r.kind || 'push').slice(0, 20), Number(r.userId) || 0,
          String(r.name || '').slice(0, 40), String(r.channel || '').slice(0, 20),
          r.ok ? 1 : 0, String(r.subject || '').slice(0, 120), String(r.detail || '').slice(0, 300)],
      );
    }
    const cnt = db.get('SELECT COUNT(*) AS n FROM push_logs');
    if (cnt && Number(cnt.n) > MAX_LOGS) {
      db.run(
        'DELETE FROM push_logs WHERE id < (SELECT id FROM push_logs ORDER BY id DESC LIMIT 1 OFFSET ?)',
        [MAX_LOGS - 1],
      );
    }
  } catch { /* 日志失败不影响推送 */ }
}

/** 写一条与具体通道无关的日志（测试发送等旁路用） */
function logOne(entry) {
  writeLogs([entry || {}]);
}

/** 最近的推送日志（默认 200 条，最多 500） */
function listLogs(limit) {
  const n = Math.max(1, Math.min(500, Math.round(Number(limit)) || 200));
  try {
    return db.all(
      'SELECT id, at, kind, user_id, user_name, channel, ok, subject, detail'
      + ' FROM push_logs ORDER BY id DESC LIMIT ?', [n],
    ).map((r) => ({
      id: Number(r.id) || 0,
      at: String(r.at || ''),
      kind: String(r.kind || ''),
      userId: Number(r.user_id) || 0,
      userName: String(r.user_name || ''),
      channel: String(r.channel || ''),
      ok: Number(r.ok) === 1,
      subject: String(r.subject || ''),
      detail: String(r.detail || ''),
    }));
  } catch { return []; }
}

/** 清空推送日志，返回清掉的条数（管理员动作） */
function clearLogs() {
  const cnt = db.get('SELECT COUNT(*) AS n FROM push_logs');
  const n = Number(cnt && cnt.n) || 0;
  db.run('DELETE FROM push_logs', []);
  return n;
}

/**
 * 一次投递到底算不算「发出去了」。
 *
 * ★ v4.28.2 修复（问题 2：只配飞书 / 钉钉时每 10 分钟重复推送）：
 *   调用方原来各自写成 `res.mail > 0 || res.wecom > 0`，把 v4.24.0 才加进来的
 *   飞书 / 钉钉两条**即时通道漏掉了**。后果是一整条负反馈链：
 *     1. 飞书 / 钉钉其实已经发成功，但调用方判成「一个都没发出去」；
 *     2. 于是不写「已发」标记（todos.remind_key / 报表 last_key / outbox.sent_at）；
 *     3. 下一轮扫描又看到「没发过」→ 再发一次；
 *     4. 记账报表的重试节流正好是 10 分钟 → 表现就是「每 10 分钟重复推送」。
 *   判据统一收在这里，今后再加通道只要改这一处，不会再有第四个调用点漏掉。
 *
 * 兼容两种返回体：push.deliver 用 `mail`，bills.sendReports 用 `mails`。
 * `deferred`（免打扰已入队）也算成功 —— 消息已安全落库、到点必发，
 * 上游必须据此记账，否则免打扰一结束就会连发。
 *
 * @param {object} res push.deliver / bills.sendReports 的返回值
 * @returns {boolean}
 */
function sentAny(res) {
  const r = res || {};
  const n = (v) => Number(v) || 0;
  return n(r.mail) > 0 || n(r.mails) > 0 || n(r.wecom) > 0
    || n(r.feishu) > 0 || n(r.dingtalk) > 0 || n(r.deferred) > 0;
}

/** 某成员的个人免打扰时段（user_prefs；没设置 = 空串 = 不启用） */
function quietPrefsOf(userId) {
  const id = Number(userId) || 0;
  if (!id) return null;
  const rows = db.all(
    "SELECT key, value FROM user_prefs WHERE user_id = ? AND key IN ('notify_quiet_start','notify_quiet_end')",
    [id],
  );
  const prefs = {};
  for (const r of rows) prefs[r.key] = String(r.value || '');
  if (!prefs.notify_quiet_start || !prefs.notify_quiet_end) return null;
  return { notifyQuietStart: prefs.notify_quiet_start, notifyQuietEnd: prefs.notify_quiet_end };
}

/**
 * 把一条即时通道（企微 / 飞书 / 钉钉）的主动推送沉进免打扰队列（mail_outbox）。
 * due_at = 免打扰结束时刻；冲刷任务到点后经 push.deliver 按该成员**当时的**通道发出
 * （与企微一致：队列里存的是内容，路由交给冲刷那一刻的通道设置）。
 * ★ 直接写表而不是 require outbox —— outbox 反过来依赖 push，反过来 require 就成环。
 * ★ 去重：同一人同通道同主题同正文的未发行已存在时不重复入队（免打扰内每轮重试不会堆队列）。
 * @returns {boolean} 是否真的入了队
 */
function deferInstant(userId, msg, dueAtMs, kind, channel) {
  const id = Number(userId) || 0;
  const ch = ['wecom', 'feishu', 'dingtalk'].includes(channel) ? channel : 'wecom';
  if (!id) return false;
  const subject = String((msg && msg.subject) || '').slice(0, 200);
  const text = String((msg && msg.text) || '').slice(0, 4000);
  const dup = db.get(
    "SELECT id FROM mail_outbox WHERE sent_at = '' AND user_id = ? AND channel = ? AND subject = ? AND text = ?",
    [id, ch, subject, text],
  );
  if (dup) return false;
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO mail_outbox (user_id, email, kind, subject, text, html, due_at, origin_id, channel, created_at, sent_at)"
    + " VALUES (?, '', ?, ?, ?, '', ?, 0, ?, ?, '')",
    [id, String(kind || 'notify').slice(0, 20), subject, text,
      new Date(dueAtMs).toISOString(), ch, now],
  );
  return true;
}

/** 通道中文名（设置页与状态文案共用一处，避免两处写法不一致） */
function labelOf(ch) {
  return CHANNEL_LABEL[normalizeChannel(ch)];
}

/**
 * 家庭里「已启用且已配置」的通道，按固定优先级排列。
 *
 * 这是 v4.28.3 两个下拉框的唯一数据源：界面上只允许选这四条里的**单个**通道，
 * 一个都没有时提示「先配好再选」—— 而不是让用户先选一个空通道、再自己发现发不出去。
 * 判定与 deliver 里的 avail 完全同源（同一套 isReady / 总开关），避免两边各说各话。
 */
function configuredChannels() {
  const wcfg = wecom.loadConfig();
  const list = {
    wecom: config.pushWecomEnabled !== false && wecom.isReady(wcfg),
    mail: config.pushMailEnabled !== false && mailReady(),
    feishu: config.pushFeishuEnabled !== false && feishu.isReady(),
    dingtalk: config.pushDingtalkEnabled !== false && dingtalk.isReady(),
  };
  return CHANNELS.filter((c) => list[c]);
}

/* SMTP 账号密码存在 reminders 的设置里。在这里 require 会成环
   （reminders → push），所以只在调用时惰性取一次，取不到就当「没配」。 */
function mailReady() {
  try {
    const rem = require('./reminders').loadRemindSettings();
    return !!(rem && rem.smtpUser && rem.smtpPass);
  } catch (e) {
    return false;
  }
}

/**
 * 家里是否至少有一个人「选了某条即时通道、且那条通道真的可用」。
 *
 * 用途：判断「SMTP 没配，提醒是不是真的发不出去了」。旧逻辑只看 SMTP ——
 * 于是只配了企业微信的家庭，提醒会被整段跳过（新版必须能识别这种情况）。
 * v4.24.0：飞书 / 钉钉群机器人也算「即时通道收件人」—— 一家人全选飞书、
 * SMTP 没配时，发件箱照样要冲刷。
 */
function hasWecomRecipients() {
  const wcfg = wecom.loadConfig();
  const wxOk = wecom.isReady(wcfg) && config.pushWecomEnabled !== false;
  const fsOk = feishu.isReady() && config.pushFeishuEnabled !== false;
  const dtOk = dingtalk.isReady() && config.pushDingtalkEnabled !== false;
  if (!wxOk && !fsOk && !dtOk) return false;
  const rows = db.all("SELECT id, username, notify_email FROM users WHERE deleted = 0");
  for (const u of rows) {
    /* v4.28.3：首选与兜底都算「会走这条通道」——
       只看首选会漏掉「首选邮件、兜底企微」的人，发件箱就永远不冲刷了。 */
    const mode = modeFor(u.id, '');
    const wants = (ch) => mode.primary === ch || mode.fallback === ch;
    if (wxOk && wants('wecom') && wecomIdOf(u.username, wcfg)) return true;
    // v4.24.0：群 Webhook 没有「个人绑定」—— 只要有人选了、通道可用就算
    if (wants('feishu') && fsOk) return true;
    if (wants('dingtalk') && dtOk) return true;
  }
  return false;
}

/** 这个人的企业微信绑定情况（界面用来显示「已绑定 / 未绑定」） */
function bindOf(userId) {
  const uname = usernameOf(userId);
  const cfg = wecom.loadConfig();
  const wx = uname ? wecomIdOf(uname, cfg) : '';
  return { username: uname, wecomUser: wx, bound: !!wx, ready: wecom.isReady(cfg) };
}

module.exports = {
  CHANNELS,
  DEFAULT_CHANNEL,
  /* v4.13.0：'wecom' 转正后这张表已清空，仍导出 —— 测试用它确认「没有历史别名了」 */
  LEGACY_CHANNELS,
  CHANNEL_LABEL,
  normalizeChannel,
  normalizeFallback,
  channelOf,
  fallbackOf,
  modeFor,
  channelFor,
  configuredChannels,
  KIND_CHANNEL_KEY,
  wecomIdOf,
  wecomBodyOf,
  sentAny,
  deliver,
  labelOf,
  hasWecomRecipients,
  bindOf,
  lastPush,
  /* v4.23.0 需求 5：推送日志 */
  logOne,
  listLogs,
  clearLogs,
};
