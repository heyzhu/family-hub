'use strict';
/**
 * 推送消息模板（v4.21.0 需求 1）
 *
 * 背景：待办提醒 / 记录本提醒 / 内容通知 / 记账报表的文案原来**硬编码**在
 * reminders.js、notify.js、bills.js 里，想改一句话就得改代码、重新打包镜像。
 * 现在把「标题 + 正文」提取成家庭级可配置项：
 *   · 系统默认模板**预置在代码里**（DEFAULTS），配置页一打开就看得见全文，可直接照着改；
 *   · 存 settings 表（键前缀 msg_tpl_），改动立即生效、重启不丢、跟着备份走；
 *   · 「恢复默认」= 删掉那一行配置（不是把默认值写死进库）——
 *     以后升级调整默认文案，没自定义过的家庭自动跟着更新。
 *
 * 占位符写法 `{{变量名}}`（中文变量名，家里人也看得懂）。
 * 两条渲染规则刻意做得很朴素，因为使用模板的人是普通家庭成员，不是程序员：
 *   ① 一行里**所有**占位符都取到空值 → 整行不显示（「备注：{{备注}}」在没备注时整行消失）；
 *   ② 行尾空白去掉、连续空行压成一个、首尾空行去掉（改模板时多敲几个回车不会让邮件变丑）。
 *
 * 依赖方向：msgTpl → db / config（不 require reminders / notify / bills，避免成环）。
 * 那三个模块反过来 require 本模块。
 */

const { db } = require('./db');
const config = require('./config');

const SETTING_PREFIX = 'msg_tpl_';

/* ── 默认模板 ─────────────────────────────────────────────
   ★ 这里的文案就是 v4.20.0 之前写死在代码里的那些字，一个字都没改 ——
     升级上来的家庭「什么都不用做」也和以前一模一样（只有显式改过才会变）。
   ★ vars 的键必须与 render 时传入的对象键完全一致，写错了那一行会永远空着。 */
const DEFAULTS = {
  todo_remind: {
    group: 'remind',
    name: '待办提醒',
    desc: '待办到点时发出的提醒（邮件正文与企业微信消息同一份内容）',
    vars: [
      { key: '标题', desc: '待办标题' },
      { key: '时间', desc: '事项时间（含日期，已按你的时区换算）' },
      { key: '提前提醒', desc: '「提醒：提前 N 天（…）」整行，没开提前提醒时为空' },
      { key: '重复', desc: '重复规则（每天 / 每周公历 星期三…），一次性待办为空' },
      { key: '参与人', desc: '参与人，用「、」连接' },
      { key: '重要程度', desc: '重要 / 普通 / 稍后' },
      { key: '备注', desc: '备注内容' },
      { key: '站名', desc: '家庭空间的名字' },
    ],
    subject: '【待办提醒】{{标题}}',
    body: [
      '【{{站名}}】待办提醒',
      '',
      '事项：{{标题}}',
      '时间：{{时间}}',
      '{{提前提醒}}',
      '重复：{{重复}}',
      '参与人：{{参与人}}',
      '重要程度：{{重要程度}}',
      '备注：{{备注}}',
      '',
      '请打开「{{站名}}」查看详情。',
      '—— 本邮件由系统自动发送，请勿回复',
    ].join('\n'),
  },

  record_remind: {
    group: 'remind',
    name: '记录本提醒',
    desc: '记录本里设了提醒时间的条目，到点发出的提醒',
    vars: [
      { key: '标题', desc: '记录标题' },
      { key: '进度', desc: '「清单进度：还有 N 项没勾（已完成 M 项）」整行，没有清单时为空' },
      { key: '站名', desc: '家庭空间的名字' },
    ],
    subject: '【记录本提醒】{{标题}}',
    body: [
      '【{{站名}} · 记录本】',
      '',
      '你存下的「{{标题}}」，按你设的时间提醒一下。',
      '{{进度}}',
      '',
      '打开记录本查看完整内容。',
    ].join('\n'),
  },

  notify_change: {
    group: 'notify',
    name: '内容变更通知',
    desc: '家人新增 / 修改内容时的即时通知',
    vars: [
      { key: '谁做了什么', desc: '例：爸爸 新增了待办事项（标题与正文的第一行都用它）' },
      { key: '标题行', desc: '「标题：…」整行；评论通知里是「动态：…」' },
      { key: '内容行', desc: '「内容：…」整行；评论通知里是「评论：…」' },
      { key: '操作人', desc: '只是昵称' },
      { key: '动作', desc: '新增 / 更新 / 评论了' },
      { key: '对象', desc: '待办事项 / 图文动态 / 重点记录 / 评论' },
      { key: '站名', desc: '家庭空间的名字' },
    ],
    subject: '【{{站名}}】{{谁做了什么}}',
    body: [
      '{{谁做了什么}}',
      '',
      '{{标题行}}',
      '{{内容行}}',
      '',
      '打开「{{站名}}」查看详情。',
      '—— 本邮件由系统自动发送，请勿回复',
    ].join('\n'),
  },

  notify_digest: {
    group: 'notify',
    name: '内容变更合并通知',
    desc: '免打扰时段内攒下的多条变更，合并成一封发出去时用',
    vars: [
      { key: '条数', desc: '这次合并了几条' },
      { key: '明细', desc: '逐条列出（每条形如「1. 爸爸 新增了待办事项：买菜」）' },
      { key: '站名', desc: '家庭空间的名字' },
    ],
    subject: '【{{站名}}】家庭里有 {{条数}} 条新更新',
    body: [
      '家里最近有 {{条数}} 条更新：',
      '',
      '{{明细}}',
      '',
      '打开「{{站名}}」查看详情。',
      '—— 本邮件由系统自动发送，请勿回复',
    ].join('\n'),
  },

  bill_report: {
    group: 'bill',
    name: '记账日报 / 月报（邮件）',
    desc: '每天 / 每月自动发出的账单总结邮件',
    vars: [
      { key: '报表标题', desc: '例：10月26日 支出日报 / 2026年10月 支出月报' },
      { key: '范围', desc: '个人 + 家庭（邮件）' },
      { key: '副标题', desc: '「个人 + 家庭 · 站名」整行' },
      { key: '明细', desc: '家庭 / 我的 两个板块与其中的金额、笔数' },
      { key: '待办', desc: '文末的今日 / 明日待办预告整段；关掉「附待办」或没有待办时为空' },
      { key: '站名', desc: '家庭空间的名字' },
    ],
    subject: '【{{站名}} · 记账】{{报表标题}}（{{范围}}）',
    body: [
      '【{{站名}} · 记账】{{报表标题}}',
      '',
      '{{副标题}}',
      '',
      '{{明细}}',
      '',
      '{{待办}}',
      '',
      '打开「{{站名}}」查看账单明细与待办。',
      '—— 本邮件由系统自动发送，请勿回复',
    ].join('\n'),
  },

  bill_push: {
    group: 'bill',
    name: '记账日报 / 月报（企业微信）',
    desc: '推送到企业微信的账单总结（纯文本，没邮件尾巴）',
    vars: [
      { key: '报表标题', desc: '例：10月26日 支出日报' },
      { key: '副标题', desc: '「全家 · 站名」整行' },
      { key: '明细', desc: '全家板块与其中的金额、笔数' },
      { key: '站名', desc: '家庭空间的名字' },
    ],
    subject: '',
    body: [
      '【{{站名}}】{{报表标题}}',
      '{{副标题}}',
      '',
      '{{明细}}',
      '',
      '想记一笔就直接回一句话，比如「今天买菜 30 元」。',
    ].join('\n'),
  },
};

const KEYS = Object.keys(DEFAULTS);
const GROUPS = ['remind', 'notify', 'bill'];

/* ── 渲染 ─────────────────────────────────────────────── */

const PH = /\{\{\s*([^{}\s]+)\s*\}\}/g;

/** 把模板文本里的占位符替换掉；整行都空 → 该行不显示 */
function renderText(tpl, vars) {
  const src = String(tpl == null ? '' : tpl).replace(/\r\n?/g, '\n');
  const v = vars || {};
  const lines = [];
  for (const raw of src.split('\n')) {
    let touched = false;
    let anyValue = false;
    const line = raw.replace(PH, (m, key) => {
      touched = true;
      const val = v[key] == null ? '' : String(v[key]);
      if (val !== '') anyValue = true;
      return val;
    });
    if (touched && !anyValue) continue;
    lines.push(line.replace(/[ \t]+$/, ''));
  }
  // 连续空行压成一个、首尾空行去掉
  const out = [];
  for (const l of lines) {
    if (l === '' && out[out.length - 1] === '') continue;
    out.push(l);
  }
  while (out.length && out[0] === '') out.shift();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/** 占位符清单（做校验、也给界面提示用） */
function placeholdersOf(text) {
  const src = String(text == null ? '' : text);
  const out = [];
  let m;
  PH.lastIndex = 0;
  while ((m = PH.exec(src))) {
    if (out.indexOf(m[1]) < 0) out.push(m[1]);
  }
  return out;
}

/** 取某条模板的生效版本：库里有自定义就用库里的，否则用默认 */
function get(key) {
  const def = DEFAULTS[key];
  if (!def) return null;
  let custom = null;
  try {
    const row = db.get('SELECT value FROM settings WHERE key = ?', [SETTING_PREFIX + key]);
    if (row && row.value) {
      const parsed = JSON.parse(row.value);
      const subject = String((parsed && parsed.subject) || '');
      const body = String((parsed && parsed.body) || '');
      // 正文必须非空才算有效自定义（空值等于没配，别把推送变成空消息）
      if (body.trim()) custom = { subject, body };
    }
  } catch { /* 库里的脏值一律当「没配」，绝不让它把推送搞挂 */ }
  return custom
    ? { key, subject: custom.subject || def.subject, body: custom.body, custom: true }
    : { key, subject: def.subject, body: def.body, custom: false };
}

/** 渲染成 { subject, text, custom } */
function render(key, vars) {
  const t = get(key);
  if (!t) return { subject: '', text: '', custom: false };
  return {
    subject: renderText(t.subject, vars),
    text: renderText(t.body, vars),
    custom: t.custom,
  };
}

const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const ACCENT = {
  todo: '#d4653f',
  post: '#3f8f74',
  record: '#7a6bd4',
  comment: '#3f8f74',
};

/**
 * 自定义模板的邮件 HTML：保留品牌外壳（站名 / 色条 / 页脚），
 * 正文按用户写的纯文本原样呈现（`white-space:pre-wrap`，换行与缩进都不丢）。
 * ★ 默认模板不走这里 —— 默认仍然用 reminders.mailLayout 的结构化表格版式，
 *   升级后邮件长什么样和以前完全一致。
 */
function wrapHtml(opts) {
  const o = opts || {};
  const bar = ACCENT[o.kind] || ACCENT.todo;
  const site = escapeHtml(config.siteName);
  const heading = escapeHtml(String(o.heading || '').trim() || config.siteName);
  const body = escapeHtml(String(o.text || ''));
  const foot = o.footnote ? `${escapeHtml(o.footnote)}<br>` : '';
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title></head>
<body style="margin:0;padding:0;background:#f7f4f0">
  <div style="padding:22px 14px;background:#f7f4f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 10px rgba(60,45,35,.08)">
      <div style="height:4px;background:${bar}"></div>
      <div style="padding:18px 20px 0">
        <div style="font-size:12.5px;color:#9a9088;letter-spacing:.03em">🏠 ${site}</div>
        <h1 style="margin:6px 0 0;font-size:18px;line-height:1.45;color:#322d29;font-weight:700">${heading}</h1>
      </div>
      <div style="padding:14px 20px 20px;color:#322d29;font-size:14px;line-height:1.75;white-space:pre-wrap;word-break:break-word">${body}</div>
      <div style="padding:13px 20px;background:#fbf9f7;border-top:1px solid #e9e3db;color:#9a9088;font-size:12px;line-height:1.6">
        ${foot}本邮件由「${site}」自动发送，请勿回复。
      </div>
    </div>
  </div>
</body></html>`;
}

/** 邮件 HTML：自定义模板 → 品牌外壳 + 原文；默认模板 → 用调用方给的结构化版式 */
function htmlFor(key, vars, opts) {
  const o = opts || {};
  const r = render(key, vars);
  if (!r.custom) return null;
  return wrapHtml({ heading: r.subject || o.heading, text: r.text, kind: o.kind, footnote: o.footnote });
}

/* ── 校验与保存 ─────────────────────────────────────────── */

const MAX_SUBJECT = 120;
const MAX_BODY = 4000;

/** 校验一条模板；返回 { subject, body }（已 trim）。不合法直接抛错（中文文案）。 */
function checkOne(key, raw) {
  const def = DEFAULTS[key];
  if (!def) throw new Error('未知的消息模板');
  const subject = String((raw && raw.subject) || '').replace(/\r\n?/g, '\n').trim();
  const body = String((raw && raw.body) || '').replace(/\r\n?/g, '\n');
  if (!body.trim()) throw new Error(`「${def.name}」的正文不能为空`);
  if (subject.length > MAX_SUBJECT) throw new Error(`「${def.name}」的标题不能超过 ${MAX_SUBJECT} 个字`);
  if (body.length > MAX_BODY) throw new Error(`「${def.name}」的正文不能超过 ${MAX_BODY} 个字`);
  if (subject.indexOf('\n') >= 0) throw new Error(`「${def.name}」的标题只能是单行`);
  const allowed = def.vars.map((v) => v.key);
  for (const [label, text] of [['标题', subject], ['正文', body]]) {
    const bad = placeholdersOf(text).filter((k) => allowed.indexOf(k) < 0);
    if (bad.length) {
      throw new Error(`「${def.name}」的${label}里有不认识的变量：{{${bad.join('}}、{{')}}}`
        + `（可用：${def.vars.map((v) => `{{${v.key}}}`).join(' ')}）`);
    }
    // 没闭合的占位符：{{ 或 }} 还单独存在 → 渲染出来是一串乱码，不如当场拦住
    const stripped = String(text).replace(PH, '');
    if (stripped.indexOf('{{') >= 0 || stripped.indexOf('}}') >= 0) {
      throw new Error(`「${def.name}」的${label}里有没闭合的占位符，请写成 {{变量名}} 的形式`);
    }
  }
  return { subject, body };
}

function putSetting(key, value) {
  db.run(
    'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}

function delSetting(key) {
  db.run('DELETE FROM settings WHERE key = ?', [key]);
}

/**
 * 保存模板。`patch` 形如 `{ todo_remind: { subject, body } }`。
 * ★ 与默认文案完全一致时**删掉配置行**，而不是把默认值写进库 ——
 *   这样「恢复默认」与「手工改回一模一样的字」效果一致，以后升级默认文案也能跟着走。
 * @returns {string[]} 实际被保存（自定义）的模板 key
 */
function save(patch) {
  const map = patch || {};
  const keys = Object.keys(map).filter((k) => DEFAULTS[k]);
  if (!keys.length) throw new Error('没有需要保存的消息模板');
  const checked = {};
  for (const k of keys) checked[k] = checkOne(k, map[k]);
  for (const k of keys) {
    const def = DEFAULTS[k];
    const same = checked[k].subject === def.subject.trim() && checked[k].body === def.body;
    if (same) delSetting(SETTING_PREFIX + k);
    else putSetting(SETTING_PREFIX + k, JSON.stringify(checked[k]));
  }
  return keys;
}

/** 恢复默认：删掉配置行（不传 key 就全部恢复） */
function reset(keys) {
  const list = keys == null ? KEYS : (Array.isArray(keys) ? keys : [keys]);
  const done = list.filter((k) => !!DEFAULTS[k]);
  for (const k of done) delSetting(SETTING_PREFIX + k);
  return done;
}

/**
 * 给配置页的完整快照（仅管理员接口下发）。
 * 含「现在生效的」与「系统默认的」两份，前端才能同时做编辑与恢复默认。
 */
function summary() {
  const out = {};
  for (const k of KEYS) {
    const def = DEFAULTS[k];
    const cur = get(k);
    out[k] = {
      key: k,
      group: def.group,
      name: def.name,
      desc: def.desc,
      vars: def.vars,
      subject: cur.subject,
      body: cur.body,
      custom: cur.custom,
      defaultSubject: def.subject,
      defaultBody: def.body,
    };
  }
  return out;
}

/** 按板块分组（前端按「待办提醒 / 内容通知 / 记账推送」三块渲染） */
function byGroup(group) {
  return KEYS.filter((k) => DEFAULTS[k].group === group);
}

module.exports = {
  KEYS,
  GROUPS,
  DEFAULTS,
  SETTING_PREFIX,
  renderText,
  placeholdersOf,
  get,
  render,
  wrapHtml,
  htmlFor,
  checkOne,
  save,
  reset,
  summary,
  byGroup,
};
