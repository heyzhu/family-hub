'use strict';
/**
 * 免打扰汇总发件箱（v4.3.3 需求 2）。
 *
 * ── 为什么需要它 ───────────────────────────────────────────
 * 旧行为是「只要有收件人还在免打扰里，整封邮件就等到最晚那个人出来」：
 *   · 一个人设了 22:00→08:00，全家都被拖到早上 8 点；
 *   · 等到点后是**一条一条**发 —— 睡醒一看收件箱躺着七八封提醒，
 *     比晚一点更让人烦；
 *   · 而且待办提醒是「一封发全家」，只要有一个人的个人免打扰没结束，
 *     其他人的提醒也一起压着（一人拖全家）。
 *
 * v4.3.3 起改成「先落发件箱、到点合并」：
 *   · 免打扰期间该发的每一封，按**收件人**拆开写进 mail_outbox；
 *   · 到该收件人的免打扰结束时刻，把积压的邮件**合并成一封**发出去；
 *   · 落库而不是放内存：进程重启、容器升级都会打断内存队列，
 *     只有落库才谈得上「不丢、不重」。
 *
 * ── 依赖方向 ───────────────────────────────────────────────
 * 本模块只依赖 db / config / push，**不依赖 reminders 或 notify** ——
 * 那两者都依赖它（入队 + 定时 flush）。一旦反向依赖就成环，
 * Node 在循环依赖里拿到的是半成品 exports（本项目踩过）。
 * 发信的动作由调用方通过 opts.sendMail / opts.send 注入，本模块不碰 SMTP 配置；
 * v4.7.0 起「发到哪条通道」交给 push 决定（它只依赖 db/config/wecom，同样不回环）。
 */

// ★ db.js 导出的是 { db, ... }，引擎挂在 .db 上；解构取错会得到「all is not a function」
const { db } = require('./db');
const config = require('./config');
const push = require('./push');

const iso = (ms) => new Date(ms).toISOString();
const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * 入队一封「暂时不能发」的邮件。
 * @param {{userId:number,email:string,kind?:string,subject:string,text:string,html?:string,
 *          dueAt?:string|number,originId?:number}} o
 * @returns {number|null} 新记录 id；缺 userId / email 时返回 null（调用方自行决定要不要计数）
 */
function enqueue(o) {
  const opt = o || {};
  const userId = Number(opt.userId) || 0;
  const email = String(opt.email || '').trim();
  // 没有收件人就没有「发给谁」这回事 —— 静默丢弃会让「提醒丢了」无从排查，
  // 所以返回 null，由调用方记进 waiting / errors。
  if (!userId || !email) return null;
  const dueMs = opt.dueAt == null ? Date.now()
    : (typeof opt.dueAt === 'number' ? opt.dueAt : Date.parse(String(opt.dueAt)));
  /* ★ 幂等查重：同一个用户、同一种类、同一个来源且**还没发**，就当作已经入队。
     查重**不看 subject**，因为主题里带着标题 —— 编辑一次标题就变了，
     按主题查重会让「同一条动态连改三次」排进三条。
     命中时用最新内容覆盖旧的那一条（原地更新），与 v4.2.0 通知去重的语义一致。 */
  const exist = db.get(
    "SELECT id FROM mail_outbox WHERE sent_at = '' AND user_id = ? AND kind = ? AND origin_id = ?",
    [userId, String(opt.kind || ''), Number(opt.originId) || 0],
  );
  if (exist) {
    db.run(
      'UPDATE mail_outbox SET subject = ?, text = ?, html = ?, email = ?, due_at = ? WHERE id = ?',
      [String(opt.subject || ''), String(opt.text || ''), String(opt.html || ''), email,
        iso(Number.isFinite(dueMs) ? dueMs : Date.now()), Number(exist.id)],
    );
    return Number(exist.id);
  }
  const res = db.run(
    `INSERT INTO mail_outbox (user_id, email, kind, subject, text, html, due_at, origin_id, created_at, sent_at)
     VALUES (?,?,?,?,?,?,?,?,?, '')`,
    [
      userId, email, String(opt.kind || ''), String(opt.subject || ''),
      String(opt.text || ''), String(opt.html || ''),
      iso(Number.isFinite(dueMs) ? dueMs : Date.now()),
      Number(opt.originId) || 0,
      new Date().toISOString(),
    ],
  );
  return Number(res.lastInsertRowid);
}

/** 某个用户（或全部，传 0）还在队列里的封数 —— 设置页要能看见「有几封在等」 */
function pendingCount(userId) {
  const uid = Number(userId) || 0;
  const row = uid
    ? db.get("SELECT COUNT(*) AS n FROM mail_outbox WHERE sent_at = '' AND user_id = ?", [uid])
    : db.get("SELECT COUNT(*) AS n FROM mail_outbox WHERE sent_at = ''");
  return Number((row && row.n) || 0);
}

/** 预览用：某人最早的待发时刻（人类可读的排查入口） */
function nextDueAt(userId) {
  const row = db.get(
    "SELECT due_at FROM mail_outbox WHERE sent_at = '' AND user_id = ? ORDER BY due_at ASC LIMIT 1",
    [Number(userId) || 0],
  );
  return (row && row.due_at) || '';
}

/**
 * 把积压的邮件合并成一封。
 * 只有一条时不套汇总模板 —— 「1 条提醒汇总」这种标题比原文更像系统通知噪音。
 */
function mergeRows(rows) {
  if (rows.length === 1) {
    const r = rows[0];
    return { subject: r.subject, text: r.text, html: r.html || '' };
  }
  const subject = `【${config.siteName}】${rows.length} 条提醒汇总`;
  const lines = [
    `你在免打扰时段收到了 ${rows.length} 条提醒，这里一并汇总：`,
    '',
  ];
  rows.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.subject}`);
    if (r.text) {
      // 正文整体缩进两格，让它和上一条的标题分清
      for (const ln of String(r.text).split('\n')) lines.push(ln ? `   ${ln}` : '');
    }
    lines.push('');
  });
  lines.push('—— 本邮件由系统自动发送，请勿回复');

  const parts = rows.map((r, i) => `
    <div style="border-top:1px solid #eee;padding:14px 0;">
      <div style="font-weight:600;color:#2f2a26;">${i + 1}. ${escapeHtml(r.subject)}</div>
      ${r.text
        ? `<pre style="white-space:pre-wrap;word-break:break-word;font:13px/1.7 -apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;color:#57504a;margin:8px 0 0;">${escapeHtml(r.text)}</pre>`
        : ''}
    </div>`).join('');
  const html = `<div style="font:14px/1.7 -apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;color:#2f2a26;">
    <p style="margin:0 0 6px;">你在免打扰时段收到了 <b>${rows.length}</b> 条提醒，这里一并汇总：</p>
    ${parts}
    <p style="margin:16px 0 0;color:#8d837a;font-size:12px;">—— 本邮件由系统自动发送，请勿回复</p>
  </div>`;
  return { subject, text: lines.join('\n'), html };
}

/**
 * 到点就把积压的发出去。
 *
 * @param {{send:Function, smtp?:{user:string,pass:string}, now?:Date|number}} opts
 *   send({email, subject, text, html}) —— 由调用方注入的发信函数（它自己带 SMTP 配置）
 * @returns {Promise<{mails:number, rows:number, errors:string[], pending:number}>}
 *
 * ★ 按「收件人」分组，不是按邮件 —— 每个人收到的是**自己那一封汇总**，
 *   不会看到别人的提醒（隐私），也不会被别人的免打扰拖住。
 */
async function flushInner(opts) {
  const opt = opts || {};
  const out = { mails: 0, wecom: 0, rows: 0, errors: [], pending: 0 };

  /* 兼容两种注入契约：
     新（v4.7.0）sendMail({to:[...], subject, text, html}) —— 支持群发，push 内部按人分流；
     旧 send({email, subject, text, html}) —— 单封，包一层即可，老调用方不用改。 */
  let sendMail = opt.sendMail;
  if (typeof sendMail !== 'function' && typeof opt.send === 'function') {
    const legacy = opt.send;
    sendMail = ({ to, subject, text, html }) => legacy({ email: to[0], subject, text, html });
  }
  const smtpReady = opt.smtpReady != null
    ? !!opt.smtpReady
    : !!(opt.smtp && opt.smtp.user && opt.smtp.pass);

  /* ★ v4.7.0：原来是「SMTP 没配就整段跳过」。但一家人都改用了企业微信时，
     队列会永远发不出去 —— 现在只要有企业微信收件人就继续跑。
     两者都没有才真的无可发送：队列原样留着（不写 sent_at），配置好了自然补发。 */
  const canMail = typeof sendMail === 'function' && smtpReady;
  if (!canMail && !push.hasWecomRecipients()) {
    out.pending = pendingCount(0);
    return out;
  }
  const nowMs = opt.now == null ? Date.now()
    : (opt.now instanceof Date ? opt.now.getTime() : Number(opt.now));
  const rows = db.all(
    "SELECT * FROM mail_outbox WHERE sent_at = '' AND due_at <= ? ORDER BY user_id ASC, id ASC LIMIT 200",
    [iso(nowMs)],
  );
  if (!rows.length) { out.pending = pendingCount(0); return out; }

  const groups = new Map();
  for (const r of rows) {
    const key = `${r.user_id}\u0000${r.email}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  for (const list of groups.values()) {
    const m = mergeRows(list);
    const uid = Number(list[0].user_id) || 0;
    try {
      // 一组 = 一个人，所以这里的「群发」实际只有一封邮件 + 可能一条企业微信
      const res = await push.deliver(
        [{ id: uid, email: list[0].email }],
        m,
        // ★ deferQuiet:false：这些行本身就是免打扰 defer 下来的，冲刷时不再二次 defer
        //   （且 due_at = 免打扰结束时刻，此刻多半已出时段）
        { sendMail, smtpReady, deferQuiet: false, deferKind: 'outbox', kind: String(list[0].kind || 'outbox') },
      );
      if (!res.mail && !res.wecom) {
        throw new Error(res.errors[0] || '没有可用的推送通道');
      }
      const ids = list.map((r) => Number(r.id));
      db.run(
        `UPDATE mail_outbox SET sent_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
        [iso(nowMs), ...ids],
      );
      out.mails++;
      if (res.wecom) out.wecom++;
      out.rows += list.length;
      for (const e of res.errors) out.errors.push(e);
    } catch (err) {
      // 失败就留在队列里：下一分钟再试。**绝不标记 sent_at**。
      out.errors.push(`${list[0].email || uid}：${err && err.message ? err.message : err}`);
    }
  }
  out.pending = pendingCount(0);
  return out;
}

/** 某个用户的积压全部作废（测试 / 管理员清理用，正常业务不调用） */
function drop(userId) {
  const uid = Number(userId) || 0;
  if (!uid) return 0;
  const row = db.get("SELECT COUNT(*) AS n FROM mail_outbox WHERE sent_at = '' AND user_id = ?", [uid]);
  db.run("DELETE FROM mail_outbox WHERE sent_at = '' AND user_id = ?", [uid]);
  return Number((row && row.n) || 0);
}

/* v4.3.3：两处调度都会每分钟调用 flush（reminders.runScan 与 notify.flushDue），
   并发跑会把同一批记录发两遍 —— sent_at 是在**发送成功之后**才写的，拦不住第二次。
   用一个模块级锁把并发挡在外面，后到的直接返回 busy。 */
let flushing = false;

async function flush(opts) {
  if (flushing) {
    return { mails: 0, rows: 0, errors: [], pending: pendingCount(0), busy: true };
  }
  flushing = true;
  try {
    return await flushInner(opts);
  } finally {
    flushing = false;
  }
}

module.exports = { enqueue, pendingCount, nextDueAt, mergeRows, flush, drop };
