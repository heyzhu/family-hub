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
 * 通道取值（v4.13.0 → v4.24.0）：
 *   'auto'  **默认**。优先企业微信；企业微信发不出去（没绑定 / 应用没启用 / 发送失败）
 *           就回退邮件 —— 邮件是兜底，不是主路。
 *   'wecom' **仅企业微信**（v4.13.0 新增）：只发企业微信，失败也不回退邮件。
 *           适合「邮件那点额度/延迟不想用、就是要走企微」的人；代价是没绑定就收不到，
 *           所以界面在选它时会明确提醒「先把企微绑定好」。
 *   'feishu' / 'dingtalk'（v4.24.0 新增）：发到管理员配好的飞书 / 钉钉**群机器人**。
 *           群 Webhook 没有「个人绑定」的概念 —— 全家一个群，一次投递全家可见，
 *           多人选同一条通道时**只发一条**（按通道去重）。失败同样不回退邮件，
 *           但原因会写进推送日志。
 *   'mail'  只用邮件（给明确不想要即时消息的人）
 *   'both'  邮件 + 企业微信两条都发
 *   ★ v4.7.0 里 'wecom' 曾经是「优先企微、失败回退邮件」的旧值（后来被 'auto' 取代）。
 *     现在它有了新语义，LEGACY_CHANNELS 不再把它折成 'auto' ——
 *     写库值没变，改的是解释方式；真实老数据极少（v4.8.0 起默认就是 'auto'）。
 */

// ★ db.js 导出的是 { db, ... }，引擎挂在 .db 上；解构取错会得到「get is not a function」
const { db } = require('./db');
const config = require('./config');
const wecom = require('./wecom');
const feishu = require('./feishu');
const dingtalk = require('./dingtalk');
const quiet = require('./quiet');   // 纯计算模块，零依赖，不会成环
const userprefs = require('./userprefs');   // 只依赖 db；push → userprefs 单向

const CHANNELS = ['auto', 'wecom', 'mail', 'both', 'feishu', 'dingtalk'];
const DEFAULT_CHANNEL = 'auto';
/* v4.13.0：'wecom' 已是正式通道，不再有需要归一的历史值。
   保留这张表（空对象）是为了让 normalizeChannel 的调用点与语义保持稳定。 */
const LEGACY_CHANNELS = {};
const CHANNEL_LABEL = {
  auto: '智能（优先企业微信）',
  wecom: '仅企业微信',
  feishu: '飞书群',
  dingtalk: '钉钉群',
  mail: '邮件',
  both: '邮件 + 企业微信',
};

/** 任何脏值一律当默认值处理：用户把设置改坏了也不该让提醒停掉 */
function normalizeChannel(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (LEGACY_CHANNELS[s]) return LEGACY_CHANNELS[s];
  return CHANNELS.includes(s) ? s : DEFAULT_CHANNEL;
}

/** 读某个家庭成员的推送通道（没设置过 = 'auto'） */
function channelOf(userId) {
  const id = Number(userId) || 0;
  if (!id) return DEFAULT_CHANNEL;
  const row = db.get('SELECT push_channel FROM users WHERE id = ?', [id]);
  return normalizeChannel(row && row.push_channel);
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

  const mailTo = [];
  const wxTo = [];
  /* v4.24.0 需求 2：群机器人通道按通道去重 —— 同一条消息投给全家群只发一次，
     选了这条通道的每个人的 plan 都会被同一次投递的结果回填。 */
  const hookPlans = { feishu: [], dingtalk: [] };
  /* v4.23.0 需求 5：每个收件人一条「投递计划」，发送完成后按它写日志 ——
     一条日志要能回答「这个人这条消息走了哪条通道、成没成、为什么没成」。 */
  const plans = [];
  /* v4.25.0 需求 4：类别通道是个人偏好，一次取全，别逐人查库 */
  const prefsMap = userprefs.loadAll();
  for (const t of list) {
    /* 优先级：调用方显式指定的 channel（免打扰冲刷 / 单测）> 该类内容自己的渠道 > 我的推送方式 */
    const ch = normalizeChannel(t.channel || channelFor(t.id, kind, prefsMap));
    const uname = t.username || usernameOf(t.id);
    const wx = t.wecomUser || wecomIdOf(uname, cfg);
    const name = t.name || uname || t.email || wx || `用户${Number(t.id) || ''}`;
    let wantWx = wecomOn && (ch === 'auto' || ch === 'wecom' || ch === 'both') && !!wx && wxReady;
    /* v4.24.0 需求 2：飞书 / 钉钉通道。只在「明确选了它」时走 —— auto 的语义保持
       「优先企业微信、邮件兜底」不变，不偷偷扩展成「任意一条能用的即时通道」，
       否则「我没配飞书却突然收到飞书消息」这种事没法向用户解释。 */
    const hookCh = (ch === 'feishu' || ch === 'dingtalk') ? ch : '';
    const hookOn = hookCh === 'feishu' ? fsOn : dtOn;
    const hookReady = hookCh === 'feishu' ? fsReady : dtReady;
    let wantHook = !!hookCh && hookOn && hookReady;
    let deferredQuiet = false;
    const plan = {
      t, ch, name, userId: Number(t.id) || 0, wantWx: false, wantMail: false,
      ok: false, channel: '', detail: '', deferred: false,
    };
    /* v4.10.0（差异 #12）：即时通道的**主动推送**同样受个人免打扰约束 ——
       在免打扰时段内不立即发，把消息沉进 mail_outbox（channel=该即时通道，due_at=免打扰结束时刻），
       到点由既有的冲刷任务发出。回执类（记账回执 / 完成回执）走的是消息应答路径，
       不经过本函数，天然不受影响 —— 与文档「免打扰只拦主动推送，不拦回执」一致。
       邮件腿不受这里管：上游（reminders / notify）在生成发送计划时已经把时刻挪出了免打扰。 */
    if ((wantWx || wantHook) && o.deferQuiet !== false) {
      const prefs = quietPrefsOf(t.id);
      const quietEnd = quiet.outOfQuiet(nowMs, prefs, config.tzOffsetMinutes);
      if (quietEnd !== nowMs) {
        if (deferInstant(t.id, msg, quietEnd, o.deferKind, wantWx ? 'wecom' : hookCh)) {
          out.deferred++;
          plan.deferred = true;
          plan.detail = `免打扰时段内，已入队，${new Date(quietEnd).toISOString()} 后发送`;
        }
        wantWx = false;    // 本轮不发（消息已安全入队，上游按「已投递」记账）
        wantHook = false;
        deferredQuiet = true;  // 这个人整体缓发：邮件腿也不立即发（消息同一条已在队列里）
      }
    }
    /* v4.8.0 需求 4：邮件是**兜底**，不再是主路。
       · auto：企业微信能用就只发企业微信，用不上（没绑定 / 应用没启用）才发邮件；
       · wecom / feishu / dingtalk：**只发选中的即时通道**，发不出去也不回退邮件（原因进日志）；
       · both：邮件 + 企业微信两条都发；
       · mail：只发邮件（用户明确不要即时消息）。
       ★ 无论如何都不静默丢弃 —— 这是本模块从 v4.7.0 起的硬承诺。 */
    const wantMail = mailOn && !deferredQuiet
      && (ch === 'mail' || ch === 'both' || (ch === 'auto' && !wantWx));
    plan.wantWx = wantWx;
    plan.wantMail = wantMail;
    if (!deferredQuiet) {
      if (wantWx) plan.channel = 'wecom';
      else if (wantHook) plan.channel = hookCh;
      else if (wantMail && t.email) plan.channel = 'mail';
    }
    plans.push(plan);
    if (wantWx) {
      wxTo.push({ to: wx, ch, email: t.email || '', name, plan });
    }
    if (wantHook) hookPlans[hookCh].push(plan);
    if (wantMail && t.email) {
      mailTo.push(t.email);
      if (ch === 'auto' && !wantWx) out.fallback++;   // 「本来想发企业微信，落到了邮件」
    }
    if (ch === 'wecom' && !wantWx && !deferredQuiet) {
      /* 仅企业微信 = 没有邮件兜底，所以「为什么收不到」必须说清楚，
         否则用户只会觉得「提醒坏了」。 */
      let why = '';
      if (!wecomOn) why = '企业微信推送总开关已关闭，选了「仅企业微信」的家人收不到消息';
      else if (!wxReady) why = '企业微信应用未启用，选了「仅企业微信」的家人收不到消息';
      else why = `${name}还没绑定企业微信账号，「仅企业微信」模式下收不到消息`;
      out.errors.push(why);
      plan.detail = why;
    } else if (hookCh && !wantHook && !deferredQuiet) {
      /* v4.24.0 需求 2：飞书 / 钉钉通道发不出去时同样说清楚为什么（没有邮件兜底）。 */
      const label = hookCh === 'feishu' ? '飞书' : '钉钉';
      const why = !hookOn
        ? `${label}推送总开关已关闭，选了「${label}群」的家人收不到消息`
        : `还没配置${label}群机器人的 Webhook 地址，选了「${label}群」的家人收不到消息`;
      out.errors.push(why);
      plan.detail = why;
    } else if (!deferredQuiet && !plan.channel) {
      plan.detail = (!t.email && ch === 'auto')
        ? '没绑定企业微信，也没留收件邮箱，这条消息没有可用的通道'
        : '当前通道不可用（总开关关着 / 未配置），这条消息没有发出去';
    }
  }

  // ① 邮件：仍然一封群发（不改变原有发信量与合并逻辑）
  let mailOk = false;
  let mailErr = '';
  if (mailTo.length && mailOn) {
    const canMail = typeof o.sendMail === 'function' && (o.smtpReady !== false);
    if (!canMail) {
      mailErr = `未配置发件邮箱，${mailTo.length} 位家人的邮件没发出去`;
      out.errors.push(mailErr);
    } else {
      try {
        await o.sendMail({
          to: mailTo,
          subject: String(msg.subject || ''),
          text: String(msg.text || ''),
          html: String(msg.html || ''),
        });
        out.mail = mailTo.length;
        mailOk = true;
      } catch (err) {
        mailErr = `邮件：${(err && err.message) || err}`;
        out.errors.push(mailErr);
      }
    }
  }
  for (const p of plans) {
    if (!p.wantMail || p.deferred) continue;
    if (!p.t.email) { p.detail = p.detail || '没有设置收件邮箱'; continue; }
    if (mailOk) { p.ok = true; p.channel = 'mail'; p.detail = ''; }
    else p.detail = mailErr || '邮件没有发出去';
  }

  // ② 企业微信：只能按人逐个发（没有「群发给这几个人」以外的合并概念）
  const sendWecom = typeof o.sendWecom === 'function'
    ? o.sendWecom
    : (toUser, content) => wecom.sendText(cfg, { toUser, content });
  /* v4.23.0：报表的邮件是「个人版」、企业微信是「全家版」，两者内容不同；
     允许调用方单独给企微一份 msg（不传就与邮件同一份，行为不变）。 */
  const wxMsg = o.wecomMsg || msg;
  for (const t of wxTo) {
    try {
      const r = await sendWecom(t.to, wecomBodyOf(wxMsg));
      if (r && r.ok === false) throw new Error(r.error || '发送失败');
      out.wecom++;
      if (t.plan) { t.plan.ok = true; t.plan.channel = 'wecom'; t.plan.detail = ''; }
    } catch (err) {
      const why = `企业微信(${t.name || t.to})：${(err && err.message) || err}`;
      out.errors.push(why);
      if (t.plan) t.plan.detail = why;
      /* v4.13.0：只有「智能」才用邮件兜底 —— 「仅企业微信」就是不要邮件，
         失败时再补一封邮件等于偷偷改了用户的选择。 */
      if (t.ch === 'auto' && t.email && mailOn && typeof o.sendMail === 'function' && o.smtpReady !== false) {
        try {
          await o.sendMail({
            to: [t.email], subject: String(msg.subject || ''),
            text: String(msg.text || ''), html: String(msg.html || ''),
          });
          out.mail++;
          out.fallback++;
          if (t.plan) {
            t.plan.ok = true;
            t.plan.channel = 'mail';
            t.plan.detail = `${why} → 已自动改用邮件送达`;
          }
        } catch (e2) {
          const why2 = `邮件兜底(${t.name || t.email})：${(e2 && e2.message) || e2}`;
          out.errors.push(why2);
          if (t.plan) t.plan.detail = `${why}；${why2}`;
        }
      }
    }
  }

  // ③ 飞书 / 钉钉群机器人（v4.24.0 需求 2）：群 Webhook 一次投递全家可见，
  //    多人选同一条通道只发一条；文案与企微同一版式（wecomBodyOf：标题并首行 + 按行截断）。
  const sendHook = async (mod, hcfg, chName) => {
    const plist = hookPlans[chName];
    if (!plist.length) return;
    const label = chName === 'feishu' ? '飞书' : '钉钉';
    try {
      const r = await mod.sendText(hcfg, { content: wecomBodyOf(msg) });
      if (r && r.ok === false) throw new Error(r.errorText || r.error || '发送失败');
      out[chName] = (out[chName] || 0) + 1;
      for (const p of plist) { p.ok = true; p.channel = chName; p.detail = ''; }
    } catch (err) {
      const why = `${label}群机器人：${(err && err.message) || err}`;
      out.errors.push(why);
      for (const p of plist) p.detail = why;
    }
  };
  await sendHook(feishu, fsCfg, 'feishu');
  await sendHook(dingtalk, dtCfg, 'dingtalk');

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
  const rows = db.all("SELECT id, username, notify_email FROM users");
  for (const u of rows) {
    const ch = channelOf(u.id);
    // v4.13.0：'wecom' 现在也是「会走企业微信」的正式取值
    if (wxOk && (ch === 'auto' || ch === 'wecom' || ch === 'both') && wecomIdOf(u.username, wcfg)) return true;
    // v4.24.0：群 Webhook 没有「个人绑定」—— 只要有人选了、通道可用就算
    if (ch === 'feishu' && fsOk) return true;
    if (ch === 'dingtalk' && dtOk) return true;
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
  channelOf,
  channelFor,
  KIND_CHANNEL_KEY,
  wecomIdOf,
  wecomBodyOf,
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
