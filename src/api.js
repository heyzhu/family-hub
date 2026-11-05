'use strict';
/**
 * 业务接口。
 *
 * ★ 权限控制唯一收口点 ★
 * SQLite 没有行级安全（RLS），所以可见性判断必须由服务端代码保证。
 * 规则只有一条，并且只在这里实现一次：
 *
 *     可见  ⟺  visibility = 'family' OR user_id = <当前登录用户>
 *
 * 所有针对 todos / posts / comments / records 的读取、修改、删除都必须带上
 * VISIBLE 谓词；写入时 user_id 一律取自服务端会话，绝不接受客户端传入。
 * 新增接口时如果绕过了 VISIBLE，就等于开了越权漏洞。
 */
const fs = require('fs');
const path = require('path');
const { once } = require('node:events');   // v4.21.0（W-2）：分块写盘时等 drain
const config = require('./config');
const { db, exportAll, importAll, getRepeatRule } = require('./db');
const auth = require('./auth');
const reminders = require('./reminders');
const notify = require('./notify');
/* v2.0.0：家庭记账 + 百度 OCR 代理 + 个人通知偏好。
   bills / ocr / userprefs 都不反向 require api.js，所以这里没有循环依赖风险。 */
const bills = require('./bills');
const ocr = require('./ocr');
const userprefs = require('./userprefs');
/* v4.5.0 需求 5：企业微信自建应用。wecom 只依赖 db / config，
   bills 需要它推报表（bills → wecom 单向），这里再引入一次不会成环。 */
const wecom = require('./wecom');
/* v4.24.0 需求 2：飞书 / 钉钉群机器人。与 wecom 一样是「协议层」模块，不反向依赖 api。 */
const feishu = require('./feishu');
const dingtalk = require('./dingtalk');
/* v4.6.0 需求 3：待办催促。urge 只依赖 db / config / wecom，不反向 require api，
   所以这里引它不会成环（它的定时器由 server.js 起，不在这里）。 */
const urge = require('./urge');
/* v4.8.0 需求 4：统一推送通道。push 只依赖 db / config / wecom，
   reminders / notify / outbox 都单向依赖它，这里引它不成环（只为读个人绑定状态）。 */
const push = require('./push');
/* v4.21.0 需求 1：消息模板（家庭级配置，随 /api/settings 下发与保存）。
   msgTpl 只依赖 db / config，不反向 require api → 不成环。 */
const msgTpl = require('./msgTpl');
const Repeat = require('../public/repeat.js');

/** 可见性谓词。占位符顺序：先 user_id，再其它条件（必须放在 WHERE 的最后一组） */
const VISIBLE = "(visibility = 'family' OR user_id = ?)";

const VISIBILITIES = new Set(['family', 'private']);
const PRIORITIES = new Set(['low', 'normal', 'high']);

/* ── 小工具 ─────────────────────────────────────────────── */

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const str = (v, max, field, { required = false } = {}) => {
  const s = String(v == null ? '' : v).trim();
  if (required && !s) throw fail(`${field}不能为空`);
  if (s.length > max) throw fail(`${field}最多 ${max} 个字符`);
  return s;
};
const strList = (v, maxItems, maxLen, field) => {
  if (v == null) return [];
  if (!Array.isArray(v)) throw fail(`${field}格式不正确`);
  if (v.length > maxItems) throw fail(`${field}最多 ${maxItems} 项`);
  return v.map((x) => String(x).trim()).filter(Boolean).map((x) => {
    if (x.length > maxLen) throw fail(`${field}单项最多 ${maxLen} 个字符`);
    return x;
  });
};
const pickVisibility = (v) => (VISIBILITIES.has(v) ? v : 'family');
const parseJsonArray = (s) => {
  try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
};
/**
 * v4.3.3 需求 8：视频封面映射 {视频路径: 封面路径}。
 * 只要不是「普通对象」就一律当空对象 —— 老库的 NULL、脏数据、数组都不能让渲染炸。
 * 这里顺手做一次白名单裁剪：key/value 都必须是本站上传路径，避免把任意外链塞进 <video poster>。
 */
const parseJsonObject = (s) => {
  let v;
  try { v = JSON.parse(s || '{}'); } catch { return {}; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof k !== 'string' || typeof val !== 'string') continue;
    if (!/^\/api\/(media|file)\//.test(k) || !/^\/api\/(media|file)\//.test(val)) continue;
    out[k] = val;
  }
  return out;
};

/**
 * v4.3.3 需求 8：校验并裁剪「视频封面」映射。
 * 两道限制缺一不可：
 *   ① key 必须是**本次这条动态里真实存在的视频** —— 否则老封面会跟着新视频列表漂移，
 *      出现「视频换了、封面还是上一段的画面」；
 *   ② key/value 都必须是本站上传路径 —— 不能让任意外链进 <video poster>。
 */
const MEDIA_PATH_RE = /^\/api\/(media|file)\/[A-Za-z0-9._-]{1,120}$/;
function pickVideoCovers(v, videos) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  const allowed = new Set((videos || []).map(String));
  for (const [k, val] of Object.entries(v)) {
    if (typeof k !== 'string' || typeof val !== 'string') continue;
    if (!allowed.has(k)) continue;
    if (!MEDIA_PATH_RE.test(k) || !MEDIA_PATH_RE.test(val)) continue;
    out[k] = val;
  }
  return out;
}

/**
 * 记录本附件校验：最多 10 个，每个 {name, path, size}。
 * path 只接受本站上传接口产出的形式，杜绝把任意外链/本地路径写进库（存储型 XSS / SSRF 面）。
 */
const MAX_ATTACHMENTS = 10;
const ATTACH_PATH_RE = /^\/api\/(file|media)\/[A-Za-z0-9._-]{1,120}$/;
function pickAttachments(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw fail('附件格式不正确');
  if (v.length > MAX_ATTACHMENTS) throw fail(`附件最多 ${MAX_ATTACHMENTS} 个`);
  return v.map((a) => {
    const item = a && typeof a === 'object' ? a : {};
    const p = String(item.path || '').trim();
    if (!ATTACH_PATH_RE.test(p)) throw fail('附件地址不合法，请重新上传');
    /* v4.13.0（问题 3）：视频附件可以带一张封面（前端本地抽帧后一并上传）。
       有就带上，没有就不写这个字段 —— 老附件对象保持原样，不改变存储结构。 */
    const cover = String(item.cover || '').trim();
    const out = {
      name: str(item.name, 200, '附件名') || '附件',
      path: p,
      size: Math.max(0, Math.round(Number(item.size) || 0)),
    };
    if (cover && ATTACH_PATH_RE.test(cover)) out.cover = cover;
    return out;
  });
}

/**
 * 记录本「图片」列校验（v4.17.0 需求 3）。
 * 老数据 / 老客户端传的是纯路径字符串数组；本版起每张图可以带一条**备注**，
 * 所以允许两种形态混存：字符串 或 {src, note}。落库统一归一成 {src, note?} 对象 ——
 * 读侧（前端 recImgSrc / recImgNote）两种都认，老记录零迁移。
 * src 只接受本站上传路径（与附件同一套白名单），note ≤ 60 字。
 */
function pickRecordImages(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw fail('图片格式不正确');
  if (v.length > 9) throw fail('图片最多 9 张');
  return v.map((im) => {
    const o = im && typeof im === 'object' ? im : { src: im };
    const src = String(o.src == null ? '' : o.src).trim();
    if (!ATTACH_PATH_RE.test(src)) throw fail('图片地址不合法，请重新上传');
    const note = String(o.note == null ? '' : o.note).trim().slice(0, 60);
    return note ? { src, note } : { src };
  });
}
const dateOnly = (v, field) => {
  const s = String(v || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw fail(`${field}需为 YYYY-MM-DD 格式`);
  return s;
};
/** 日期可留空：未设日期的待办只出现在待办列表中 */
const optDate = (v, field) => {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  return dateOnly(s, field);
};
// ★ 重复规则清单**取自 repeat.js**（前后端同一份实现）。以前这里是手写的一份，
//   一旦扩展规则（v1.9.0 加了按月）就会出现「服务端认、界面不认」或反过来的错位。
// v4.10.0（A4=①）：REPEATS 是**新枚举**（daily/weekly/monthly_solar/...）；
//   老客户端发来的旧枚举名（solar_weekly...）经 LEGACY_RULE 翻译后照常接受。
const REPEATS = new Set([''].concat(Repeat.REPEATS));
const pickRepeat = (v) => {
  const s = String(v || '');
  if (REPEATS.has(s)) return s;
  return Repeat.LEGACY_RULE[s] || '';
};
/** 新枚举 → 旧 repeat 列的兼容值（daily 在旧 CHECK 里不存在，只能写 ''） */
const NEW2LEGACY = Object.fromEntries(Object.entries(Repeat.LEGACY_RULE).map(([k, v]) => [v, k]));
/** 双写：repeat_rule 是唯一真相，repeat 写兼容值（文档 A4=①：禁止只写一列） */
const repeatPair = (rule) => ({ rule, legacy: NEW2LEGACY[rule] || '' });
/** 跨天待办的结束日期（文档 5.2：结束不早于开始；无开始日强制空；与重复互斥由调用方保证） */
const pickEndDate = (v, date, field) => {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (!date) throw fail('跨天待办需要先设置开始日期');
  const end = dateOnly(s, field);
  if (end < date) throw fail('结束日期不能早于开始日期');
  return end;
};
/** 催促次数上限：0 = 不限；范围 0–999 */
const pickUrgeMaxCount = (v) => {
  if (v == null || v === '') return 20;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0) return 20;
  return Math.min(999, n);
};
/* v4.6.0 需求 3：催促间隔。0 = 不催；只接受 1–60 分钟整数，超范围夹到边界。
   为什么夹而不报错：这个值可能是企业微信那边用一句话说出来的（「每90分钟催一次」），
   为了一个频率把人挡在门外不值得 —— 变成 60 分钟（最长档）更符合直觉。 */
const pickUrgeMinutes = (v) => {
  if (v == null || v === '' || v === false) return 0;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(60, Math.max(1, n));
};
const timeOnly = (v, field) => {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw fail(`${field}需为 HH:MM 格式`);
  return s;
};
const idOf = (raw) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw fail('记录 ID 不正确');
  return n;
};
const nowIso = () => new Date().toISOString();

/* ── 行 → 前端对象 ──────────────────────────────────────── */

/**
 * 行 → 前端对象。
 * @param {object} r SQLite 原始行
 * @param {object} me 当前登录用户
 * @param {{defaultTime:string, advanceDays:number, tzOffsetMinutes:number, todayKey:string}} [ctx]
 *   重复事项的「下一次提醒」需要知道全局的默认提醒时间与提前天数；ctx 由 list() 一次性读好传进来，
 *   避免逐行查库（N 次 settings 读）。要的是「前端显示的时间」与「服务端真正发信的时间」同源，
 *   所以这里复用 reminders 的同一套计算，不另写一份。
 */
const shapeTodo = (r, me, ctx) => {
  /* v4.10.0（A4=①）：规则读取统一走「repeat_rule 优先、repeat 翻译回落」。
     repeat 字段继续回显旧枚举值（老前端兼容），repeatRule 是唯一真相（新枚举）。 */
  const ruleName = db.getRepeatRule(r);
  const out = {
    id: r.id,
    ownerName: r.owner_name,
    title: r.title,
    note: r.note,
    date: r.todo_date || '',
    // v4.10.0：跨天待办的结束日期（''= 单日）
    endDate: r.end_date || '',
    startTime: r.start_time,
    endTime: r.end_time,
    location: r.location,
    participants: parseJsonArray(r.participants),
    priority: r.priority,
    repeat: r.repeat || '',
    repeatRule: ruleName,
    done: !!r.done,
    remind: !!r.remind,
    /* v4.22.0 需求 1：这条待办自己设的提前天数（-1 = 跟随家庭设置）。
       下面的 advanceDays 是**实际生效值**（自己设了就是自己，否则取全局）。 */
    remindAdvanceDays: Number(r.remind_advance_days) >= 0 && Number(r.remind_advance_days) <= 5
      ? Number(r.remind_advance_days) : -1,
    /* v4.22.0 需求 2：一句话添加（网页 / 微信）的待办。只进待办列表，不占「周期提醒」卡。 */
    quick: !!r.quick,
    // v4.6.0 需求 3：催促完成（0 = 不催；1–60 分钟一催）
    urgeMinutes: Number(r.urge_minutes) || 0,
    urgeLastAt: r.urge_last_at || '',
    // v4.10.0：催促状态机与扩展配置
    urgeStatus: String(r.urge_status || 'idle'),
    urgeCount: Number(r.urge_count) || 0,
    urgeMaxCount: Number(r.urge_max_count) || 0,
    urgeWindowStart: r.urge_window_start || '08:00',
    urgeWindowEnd: r.urge_window_end || '22:00',
    urgeStartAt: r.urge_start_at || '',
    remindedAt: r.reminded_at || '',
    visibility: r.visibility,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    mine: r.user_id === me.id,
    // 年度重复事项用：下一次落点 / 下一次提醒（墙上时间的日期与时刻，前端直接展示）
    nextOccurrence: '',
    nextRemindKey: '',
    nextRemindTime: '',
    advanceDays: 0,
    // v4.19.0 需求 2-1：列表要把「几点提醒、这个点从哪来」讲清楚（仅重复事项填充）
    remindTime: '',
    remindTimeIsDefault: false,
    /* v4.21.0 需求 2：重复事项的「今天这次」是否已完成。
       一个全局 done 列表达不了「今天做完、明天还要做」，所以完成状态按落点日记在
       todo_done_marks 里；这里只回今天的那个布尔值，第二天天然变回 false。 */
    doneToday: false,
  };
  /* 实际生效的提前天数：这条待办自己设了 0–5 就用它，否则跟随家庭设置。
     ★ 与 reminders 扫描器共用 advanceOf()，保证「列表显示的下次提醒」= 「真正发信的时间」。 */
  const effAdv = reminders.advanceOf(r, ctx ? ctx.advanceDays : 0);
  out.advanceDays = effAdv;
  if (ctx && ruleName && out.date) {
    const src = { date: out.date, repeat: r.repeat || '', repeat_rule: r.repeat_rule || '' };    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(out.startTime || ''))
      ? out.startTime : ctx.defaultTime;
    /* v4.19.0 需求 2-3（bug 修复）：**提醒时刻已经过去**的落点不能再算「下一次」。
       旧逻辑只按日期取落点（nextOccurrence 从今天起算），于是每天重复的事项在当天
       提醒时间过了之后仍然显示「今天 08:00」—— 用户永远看不出下一次到底是什么时候。
       现在往前逐个落点走，直到找到一个「提醒时刻还没到」的：
         · 没开提前提醒：今天 08:00 过了 → 下一次就是明天 08:00；
         · 开了提前 N 天：提醒时刻按 occurrences - N 天算（与 reminders 同一套），
           所以最多要走 提前天数 + 1 步。
       循环上限 14 次：提前最多 5 天，留足余量，同时防住任何意外的死循环。 */
    let occ = Repeat.nextOccurrence(src, ctx.todayKey);
    for (let i = 0; occ && i < 14; i++) {
      const moment = reminders.localRemindMoment(
        { todo_date: occ, start_time: out.startTime },
        ctx.defaultTime, ctx.tzOffsetMinutes, effAdv,
      );
      if (!moment || moment.getTime() > Date.now()) break;
      occ = Repeat.nextOccurrence(src, shiftDateKey(occ, 1));
    }
    if (occ) {
      out.nextOccurrence = occ;
      out.nextRemindKey = reminders.remindWallKey(occ, effAdv);
      out.nextRemindTime = time;
      out.advanceDays = effAdv;
      out.remindTime = time;
      out.remindTimeIsDefault = time === ctx.defaultTime && String(out.startTime || '') !== time;
      /* v4.21.0 需求 2：今天的落点是否已完成（只有今天正好是落点时才可能为 true） */
      out.doneToday = !!(ctx.doneToday && ctx.doneToday.has(Number(r.id))
        && Repeat.isOccurrence(src, ctx.todayKey));
    }
  }
  return out;
};

const shapePost = (r, me) => ({
  id: r.id,
  ownerName: r.owner_name,
  content: r.content,
  images: parseJsonArray(r.images),
  // v1.9.0：视频与图片并列（页面上是「图片九宫格 + 下面一个播放器」的排布）
  videos: parseJsonArray(r.videos),
  // v4.3.3 需求 8：视频 → 封面图。没有封面的老视频回退成空对象，前端继续用 #t=0.1。
  videoCovers: parseJsonObject(r.video_covers),
  tags: parseJsonArray(r.tags),
  visibility: r.visibility,
  createdAt: r.created_at,
  /* v4.5.0 需求 3：**发布时间**是这条动态的固定属性，任何后续操作都不许改它。
     ★ 这里刻意再给一个 publishedAt 别名：本项目里 `created_at` 到处都是，
       「一起写」又会更新 `posts.updated_at`（首页排序与红点需要它），
       一旦展示层顺手拿了 updatedAt 兜底，就会出现「前天发的帖因为昨天有人
       补充了两句，日期变成了昨天」这种难查的问题。
       约定：**展示一律用 publishedAt / createdAt；updatedAt 只用于排序与红点**。 */
  publishedAt: r.created_at,
  updatedAt: r.updated_at,
  mine: r.user_id === me.id,
  comments: [],
  // v4.3.3 需求 1：点赞。由 list() 一次取回后归并；liked 表示「我赞过没有」。
  likes: [],
  liked: false,
  likeCount: 0,
  // v1.9.0：共创内容（家人对这条动态追加的图文视频），由 list() 一次取回后归并
  contributions: [],
});

/** 共创条目（v1.9.0）：结构上与「动态」很像，但没有自己的可见性 —— 跟随所属动态 */
const shapeContrib = (r, me) => ({
  id: r.id,
  postId: r.post_id,
  ownerName: r.owner_name,
  content: r.content,
  images: parseJsonArray(r.images),
  videos: parseJsonArray(r.videos),
  /* v4.6.0 需求 4：共创里的视频也要有封面。
     旧版只有 posts.video_covers —— 共创视频拿不到 poster，退回 iOS 不认的 #t=0.1，
     手机上就是一排黑框（这就是「移动端仍然没有预览图」的第二个来源）。 */
  videoCovers: parseJsonObject(r.video_covers),
  createdAt: r.created_at,
  // v4.3.3 需求 5：编辑过才有值，空串表示「还没动过」
  updatedAt: r.updated_at || '',
  mine: r.user_id === me.id,
});

const shapeComment = (r, me) => ({
  id: r.id,
  postId: r.post_id,
  ownerName: r.owner_name,
  content: r.content,
  // v4.3.3 需求 1：回复关系（两级）。parentId = 0 表示顶层评论。
  parentId: Number(r.parent_id) || 0,
  replyToName: r.reply_to_name || '',
  createdAt: r.created_at,
  mine: r.user_id === me.id,
  likes: [],
  liked: false,
  likeCount: 0,
});

const shapeRecord = (r, me) => {
  /* v4.10.0（A5=①）：行模型。content_json 有值 → 原样解析；
     老记录（只有 content）→ 服务端现场把 content 包装成一行 text（文档 5.5-6 的回落规则）。
     图片 / 附件行是 records.images / attachments 的**视图**（文档同款设计），
     追加在行尾，前端按 type 渲染。 */
  let rows = null;
  if (String(r.content_json || '')) {
    try {
      const parsed = JSON.parse(r.content_json);
      if (Array.isArray(parsed)) rows = parsed.filter((x) => x && typeof x === 'object');
    } catch { rows = null; }
  }
  if (!rows) {
    rows = String(r.content || '').split('\n').map((line) => {
      const m = /^([☐☑]) (.*)$/.exec(line);
      return m
        ? { type: 'checkbox', text: m[2], checked: m[1] === '☑' }
        : { type: 'text', text: line };
    });
  }
  const imgs = parseJsonArray(r.images);
  const atts = parseAttachmentList(r.attachments);
  return {
    id: r.id,
    ownerName: r.owner_name,
    title: r.title,
    content: r.content,
    // 行模型四型：text / checkbox / image / attachment（image、attachment 是列的视图）
    contentRows: rows.concat(
      imgs.map((url) => ({ type: 'image', url })),
      atts.map((a) => ({ type: 'attachment', name: a.name, url: a.url, size: a.size || 0 })),
    ),
    category: r.category,
    // tags 界面已停用（v1.5.0 移除标签功能），仍然回传只为兼容旧数据与旧客户端
    tags: parseJsonArray(r.tags),
    images: imgs,
    attachments: atts,
    pinned: !!r.pinned,
    // v1.9.0：归档。归档 ≠ 删除 —— 记录还在库里、还能搜到，只是列表默认不展示
    archived: !!r.archived,
    visibility: r.visibility,
    // v4.12.0：记录本提醒（默认不提醒）。advanceDays = -1 表示跟随家庭设置。
    remind: !!r.remind,
    remindTime: String(r.remind_time || ''),
    remindAdvanceDays: Number(r.remind_advance_days) >= 0 ? Number(r.remind_advance_days) : -1,
    remindChannel: String(r.remind_channel || ''),
    remindAt: String(r.remind_at || ''),
    remindedAt: String(r.reminded_at || ''),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    mine: r.user_id === me.id,
  };
};

/**
 * v4.10.0（A5=①）：把正文按行约定（`☐ x` / `☑ x` / 普通文本）派生成行模型数组并落
 * content_json —— 前端编辑器保持纯文本（勾选交互早已存在），存储层升级为行模型。
 * content 与 content_json 双写：content = 所有 text/checkbox 行按行拼接（文档 5.5-13），
 * 搜索 / CSV / 旧接口继续可用。
 */
function contentRowsOf(content) {
  return String(content || '').split('\n').slice(0, 500).map((line) => {
    const m = /^([☐☑]) (.*)$/.exec(line);
    return m
      ? { type: 'checkbox', text: m[2].slice(0, 2000), checked: m[1] === '☑' }
      : { type: 'text', text: line.slice(0, 2000) };
  });
}

/** 附件列表：只回传结构正确的项，脏数据直接丢掉，前端不必再防一遍 */
function parseAttachmentList(raw) {
  return parseJsonArray(raw)
    .map((a) => {
      if (!a || typeof a !== 'object') return null;
      const item = {
        name: String(a.name || '').slice(0, 200),
        path: String(a.path || ''),
        size: Number(a.size) || 0,
      };
      /* v4.13.0（问题 3）：视频附件的封面（老数据没有这个字段，保持原样）
         ★ 封面一律来自图片通道（/api/media/），不可能是有风险的地址。 */
      const cover = String(a.cover || '');
      if (/^\/api\/media\/[A-Za-z0-9._-]{1,120}$/.test(cover)) item.cover = cover;
      return item;
    })
    .filter((a) => a && a.path && /^\/api\/(file|media)\//.test(a.path));
}

/* ── 待办事项 ───────────────────────────────────────────── */

/** 组装 shapeTodo 需要的提醒上下文（全局默认时间 / 提前天数 / 时区 / 今天） */
function remindCtx() {
  const rs = reminders.loadRemindSettings();
  const todayKey = reminders.wallDateKey(new Date(), rs.tzOffsetMinutes);
  return {
    defaultTime: rs.remindDefaultTime,
    advanceDays: rs.remindAdvanceDays,
    tzOffsetMinutes: rs.tzOffsetMinutes,
    todayKey,
    /* v4.21.0 需求 2：今天已完成的重复事项 id 集合。
       一次查询解决整页，避免「每条待办查一次」的 N+1。 */
    doneToday: doneTodaySet(todayKey),
  };
}

/** 今天的「重复事项已完成」标记（id 集合） */
function doneTodaySet(dayKey) {
  const set = new Set();
  try {
    for (const row of db.all('SELECT todo_id FROM todo_done_marks WHERE occ_date = ?', [String(dayKey)])) {
      set.add(Number(row.todo_id));
    }
  } catch { /* 老库还没建这张表时当作「今天什么都没完成」，不能让列表整体 500 */ }
  return set;
}

/**
 * v4.22.0 需求 1：每条待办的提前天数。
 * -1 = 跟随家庭设置；0–5 = 自己指定。
 * ★ 非法值直接拒绝，不静默夹取 —— 否则用户填 7、库里存 5，
 *   界面改回 7 又变 5，事后根本查不出「为什么提醒早了两天」。
 */
function pickAdvanceDays(v, fallback = -1) {
  if (v == null || v === '') return fallback;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < -1 || n > 5) {
    throw fail('提前提醒天数需为 0-5 天（-1 表示跟随家庭设置）');
  }
  return n;
}

/* 列表一次最多返回多少条。★ v4.20.0（审查 W-9）：**这个上限不再是静默的** ——
   listPage() 会同时回一个真实 total，前端据 total > todos.length 明确提示
   「仅显示最近 N 条」。原来超限是直接截断、界面毫无提示，用户只看到「我记的东西不见了」。 */
const TODO_LIST_LIMIT = 2000;

const todos = {
  list(me) {
    return todos.listPage(me).todos;
  },

  /**
   * 列表 + 计数：`{ todos, total, truncated, limit, now }`
   *
   * ★ v4.21.0（技术债 G-4）：支持 `since` 增量。
   *   以前 12 秒轮询每次都把最多 2000 条待办 `SELECT *` 全拉一遍 —— 几百条时
   *   是几十 KB，几千条时就是几百 KB，每 12 秒一次、还带手机流量。
   *   增量模式只回「上次之后变过的行」+ 一份 id 清单（判删用）+ 今天的完成集合：
   *     · `ids`：别人删了哪条必须能发现，全量 id 只有数字，比整行小两个数量级；
   *     · `doneToday`：勾选「今天这一次」不会改 todos.updated_at，
   *       所以完成态必须单独回，否则增量同步看不到别人勾过的；
   *     · `now`：服务端时间，作为下一次的游标（不用客户端时钟，避免手机时间不准）。
   *   判断用 `>=` 而不是 `>`：同一毫秒内改动过的行宁可重发一次，也不能漏掉。
   */
  listPage(me, opts) {
    const o = opts || {};
    const since = typeof o.since === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]*Z?$/.test(o.since) ? o.since : '';
    const ctx = remindCtx();
    const now = new Date().toISOString();
    const totalRow = db.get(`SELECT COUNT(*) AS n FROM todos WHERE ${VISIBLE}`, [me.id]);
    const total = Number((totalRow && totalRow.n) || 0);
    const rows = since
      ? db.all(
        `SELECT * FROM todos WHERE ${VISIBLE} AND updated_at >= ?
          ORDER BY updated_at ASC, id ASC LIMIT ${TODO_LIST_LIMIT}`,
        [me.id, since],
      )
      : db.all(
        `SELECT * FROM todos WHERE ${VISIBLE}
          ORDER BY (todo_date IS NULL) ASC, todo_date ASC, start_time ASC, id ASC LIMIT ${TODO_LIST_LIMIT}`,
        [me.id],
      );
    const out = {
      todos: rows.map((r) => shapeTodo(r, me, ctx)),
      total,
      truncated: total > rows.length,
      limit: TODO_LIST_LIMIT,
      /* 下一次增量用的游标；老客户端读到多余字段不受影响 */
      now,
    };
    if (since) {
      out.since = since;
      out.incremental = true;
      out.ids = db.all(`SELECT id FROM todos WHERE ${VISIBLE}`, [me.id]).map((r) => Number(r.id));
      out.doneToday = Array.from(ctx.doneToday || []).map(Number);
      // 增量模式下 truncated 指的是「这一批变了多少」，跟全量的语义不同，别让界面误报
      out.truncated = false;
      /* 变更行数顶到上限（正常绝无可能，除非库被脚本批量改过）→ 让前端整份重拉，
         宁可多一次全量，也不能让界面停在「只同步了一半」的状态。 */
      out.reset = rows.length >= TODO_LIST_LIMIT;
    }
    return out;
  },

  /**
   * v4.20.0（审查 W-9）：**结束重复**。
   *
   * 为什么必须有这个动作：v4.19.0 起「一句话添加的待办默认每天重复」，
   * 而重复事项不参与完成状态（不会自动了结）、界面上也没有收尾入口 ——
   * 每件临时小事都会永久留在库里、每天提醒一次，长期必然撞上 2000 条上限。
   *
   * 语义：把这一条变回「一次性待办」并标记完成。清掉 repeat_rule /
   * 旧 repeat 列（漏一个前端就会继续当它是重复事项），同时清 remind_key，
   * 免得它因为「这个落点已经提醒过」的残留状态再也提醒不出来。
   * 权限：只有创建者能结束自己的重复（别人无权替你停掉提醒）。
   */
  endRepeat(me, id) {
    const row = db.get(`SELECT * FROM todos WHERE id = ? AND ${VISIBLE}`, [id, me.id]);
    if (!row) throw fail('事项不存在或无权访问', 404);
    if (row.user_id !== me.id) throw fail('只有创建者可以结束这条重复提醒', 403);
    if (!String(row.repeat_rule || '') && !pickRepeat(row.repeat)) throw fail('这条待办不是重复事项');
    db.run(
      "UPDATE todos SET repeat = '', repeat_rule = '', done = 1, reminded_at = '', remind_key = '', updated_at = ? WHERE id = ?",
      [nowIso(), id],
    );
    return shapeTodo(db.get('SELECT * FROM todos WHERE id = ?', [id]), me, remindCtx());
  },

  /**
   * v4.21.0 需求 2：**勾选重复事项的某一天**。
   *
   * 为什么单独一个接口、不塞进 PATCH：PATCH 改的是「事项本身」（改一次就影响以后每一次），
   * 而这里改的是「这一次做完了」——两件事的语义、权限、影响范围都不同。
   * 混在 PATCH 里，前端一次误传 done 就会把整条重复事项当成已完成（旧版正是这样，
   * 所以干脆不给勾选框）。
   *
   * 语义：写入 / 删除 todo_done_marks 的一行；只能标「这条规则确实成立的日期」。
   * 权限：能看到这条待办的人就能勾（家庭共享事项谁做完都算做完；
   *       私密事项只有自己能看见，自然也只有自己能勾）。
   * @param {{date?:string, done?:boolean}} b
   */
  completeOccurrence(me, id, b) {
    const row = db.get(`SELECT * FROM todos WHERE id = ? AND ${VISIBLE}`, [id, me.id]);
    if (!row) throw fail('事项不存在或无权访问', 404);
    const rule = getRepeatRule(row);
    if (!rule) {
      // 一次性待办别走这里：它的完成状态是全局的，走 PATCH { done }
      throw fail('这条待办不是重复事项，请直接标记完成');
    }
    /* ★ 日期默认值要用「今天」，但 shapeTodo 的上下文必须在**写完库之后**再取：
       它的 doneToday 是当场查出来的集合，先取就会把刚勾的这一下算成「没勾」，
       前端收到响应后又把乐观更新的完成态回滚掉（表现成「点了没反应」）。 */
    const rs = reminders.loadRemindSettings();
    const day = optDate((b || {}).date, '日期')
      || reminders.wallDateKey(new Date(), rs.tzOffsetMinutes);
    if (!Repeat.isOccurrence({ date: row.todo_date, repeat_rule: rule }, day)) {
      throw fail('这一天不是这条重复事项的日期');
    }
    const done = (b || {}).done == null ? true : !!(b || {}).done;
    if (done) {
      db.run(
        'INSERT INTO todo_done_marks (todo_id, occ_date, user_id, done_at) VALUES (?,?,?,?)'
        + ' ON CONFLICT(todo_id, occ_date) DO UPDATE SET user_id = excluded.user_id, done_at = excluded.done_at',
        [id, day, me.id, nowIso()],
      );
    } else {
      db.run('DELETE FROM todo_done_marks WHERE todo_id = ? AND occ_date = ?', [id, day]);
    }
    return shapeTodo(db.get('SELECT * FROM todos WHERE id = ?', [id]), me, remindCtx());
  },

  create(me, b) {
    const title = str(b.title, 100, '标题', { required: true });
    const date = optDate(b.date, '日期');
    const repeat = pickRepeat(b.repeat);
    if (repeat && !date) throw fail('重复事项需要先设置日期');
    /* v4.10.0：跨天待办。结束日期与重复互斥（daily + 跨 3 天会在日历上条数爆炸），
       有重复规则 → 强制清空；没有开始日期 → 强制清空。 */
    const endDate = repeat ? '' : pickEndDate(b.endDate, date, '结束日期');
    const visibility = pickVisibility(b.visibility);
    const urgeMinutes = pickUrgeMinutes(b.urgeMinutes);
    /* 催促状态机（文档 5.10.1-4）：开催促 → pending（urge_count=0）；不开 → idle。
       urge_start_at 缺省走「首次提醒时刻」，只有显式传了才存。 */
    const urgeStatus = urgeMinutes > 0 ? 'pending' : 'idle';
    /* v4.22.0 需求 1 / 2：提前天数（-1 跟随家庭设置）+ 是否一句话创建 */
    const remindAdvance = pickAdvanceDays(b.remindAdvanceDays, -1);
    const quick = b.quick ? 1 : 0;
    const res = db.run(
      `INSERT INTO todos (user_id, owner_name, title, note, todo_date, end_date, start_time, end_time,
                          location, participants, priority, repeat, repeat_rule, done, remind,
                          remind_advance_days, quick, urge_minutes,
                          urge_status, urge_max_count, urge_window_start, urge_window_end, urge_start_at,
                          visibility, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        me.id, me.display_name, title, str(b.note, 2000, '备注'),
        date, endDate, timeOnly(b.startTime, '开始时间'), timeOnly(b.endTime, '结束时间'),
        str(b.location, 100, '地点'),
        JSON.stringify(strList(b.participants, 30, 20, '参与人')),
        PRIORITIES.has(b.priority) ? b.priority : 'normal',
        repeatPair(repeat).legacy,
        repeat,
        // 年度重复事项在列表里单独展示且不参与完成状态，所以强制未完成
        repeat ? 0 : (b.done ? 1 : 0),
        b.remind == null ? 1 : (b.remind ? 1 : 0),   // 默认开启提醒
        remindAdvance,
        quick,
        urgeMinutes,
        urgeStatus,
        pickUrgeMaxCount(b.urgeMaxCount),
        timeOnly(b.urgeWindowStart, '催促静默开始') || '08:00',
        timeOnly(b.urgeWindowEnd, '催促静默结束') || '22:00',
        timeOnly(b.urgeStartAt, '催促开始时刻') || '',
        visibility,
        nowIso(), nowIso(),
      ],
    );
    const todo = shapeTodo(db.get('SELECT * FROM todos WHERE id = ?', [res.lastInsertRowid]), me, remindCtx());
    notify.changed({
      actor: me, kind: 'todo', action: 'create', visibility, id: todo.id,
      title: todo.title, detail: [todo.date || '未安排日期', todo.startTime].filter(Boolean).join(' '),
    });
    return todo;
  },

  update(me, id, b) {
    const row = db.get(`SELECT * FROM todos WHERE id = ? AND ${VISIBLE}`, [id, me.id]);
    if (!row) throw fail('事项不存在或无权访问', 404);

    // 可见性只允许创建者本人修改，避免他人把别人的事「藏起来」
    let visibility = row.visibility;
    if (b.visibility != null && b.visibility !== row.visibility) {
      if (row.user_id !== me.id) throw fail('只有创建者可以修改可见性', 403);
      visibility = pickVisibility(b.visibility);
    }

    const date = b.date == null ? (row.todo_date || '') : optDate(b.date, '日期');
    const repeat = b.repeat == null
      ? (String(row.repeat_rule || '') || pickRepeat(row.repeat))
      : pickRepeat(b.repeat);
    if (repeat && !date) throw fail('重复事项需要先设置日期');
    /* v4.10.0：跨天待办。结束日期只在调用方显式给的时候才校验更新；
       改了开始日期之后，原来的结束日期可能比新的开始还早 → 顺延校验/清空。 */
    let endDate = row.end_date || '';
    if (b.endDate != null) {
      endDate = repeat ? '' : pickEndDate(b.endDate, date, '结束日期');
    } else if (endDate && (repeat || !date || endDate < date)) {
      endDate = '';
    }
    if (endDate) {
      endDate = pickEndDate(endDate, date, '结束日期');
    }

    const startTime = b.startTime == null ? row.start_time : timeOnly(b.startTime, '开始时间');
    const remind = b.remind == null ? (row.remind ? 1 : 0) : (b.remind ? 1 : 0);
    /* v4.22.0 需求 1：提前天数。不传 = 保持原值；-1 = 跟随家庭设置。 */
    const remindAdvance = b.remindAdvanceDays == null
      ? (Number(row.remind_advance_days) >= 0 ? Number(row.remind_advance_days) : -1)
      : pickAdvanceDays(b.remindAdvanceDays, -1);
    // 年度重复事项不参与完成状态，始终保持未完成
    const done = repeat ? 0 : (b.done == null ? row.done : (b.done ? 1 : 0));
    // 提醒时点被改到将来的话，允许重新提醒一次（remind_key 也要一起清掉，
    // 否则重复事项会因为「该落点已经提醒过」而永远不再发）
    // ★ 必须带上「提前天数」：管理员设了提前 3 天提醒时，判定「是否还来得及再发一次」
    //   用的必须是提前之后的时刻，否则改完时间会出现「该提醒却没提醒」。
    const ctx = remindCtx();
    /* ★ v4.22.0：判断「是否还来得及再发一次」必须用这条待办**实际生效**的提前天数，
       不能只用全局 —— 单条设了提前 2 天、全局 0 天时，用全局会误判成「已过期」。 */
    const effAdv = remindAdvance >= 0 ? remindAdvance : ctx.advanceDays;
    const newMoment = reminders.localRemindMoment(
      { todo_date: date, start_time: startTime },
      ctx.defaultTime, ctx.tzOffsetMinutes, effAdv,
    );
    const canRemindAgain = !!(newMoment && newMoment.getTime() > Date.now());
    const remindedAt = canRemindAgain ? null : row.reminded_at;
    const remindKey = canRemindAgain ? '' : String(row.remind_key || '');

    /* v4.10.0：催促状态机联动。
       · 传了 urgeMinutes：0 → idle（关掉）；从关到开 → pending + 计数清零（重新开始催）；
         本来就开着 → 保持现有状态（active 不因改备注被打断）。
       · 没传 urgeMinutes：保持原状。 */
    const prevUrge = Number(row.urge_minutes) || 0;
    const urgeMinutes = b.urgeMinutes == null ? prevUrge : pickUrgeMinutes(b.urgeMinutes);
    let urgeStatus = String(row.urge_status || 'idle');
    let urgeCount = Number(row.urge_count) || 0;
    if (b.urgeMinutes != null) {
      if (urgeMinutes === 0) urgeStatus = 'idle';
      else if (prevUrge === 0) { urgeStatus = 'pending'; urgeCount = 0; }
    }
    if (urgeMinutes === 0) urgeStatus = 'idle';
    const urgeMaxCount = b.urgeMaxCount == null
      ? (Number(row.urge_max_count) || 0) : pickUrgeMaxCount(b.urgeMaxCount);
    const urgeWindowStart = b.urgeWindowStart == null
      ? (row.urge_window_start || '08:00') : (timeOnly(b.urgeWindowStart, '催促静默开始') || '08:00');
    const urgeWindowEnd = b.urgeWindowEnd == null
      ? (row.urge_window_end || '22:00') : (timeOnly(b.urgeWindowEnd, '催促静默结束') || '22:00');
    const urgeStartAt = b.urgeStartAt == null
      ? (row.urge_start_at || '') : timeOnly(b.urgeStartAt, '催促开始时刻');

    db.run(
      `UPDATE todos SET title = ?, note = ?, todo_date = ?, end_date = ?, start_time = ?, end_time = ?,
                        location = ?, participants = ?, priority = ?, repeat = ?, repeat_rule = ?, done = ?,
                        remind = ?, remind_advance_days = ?, urge_minutes = ?, urge_status = ?, urge_count = ?,
                        urge_max_count = ?, urge_window_start = ?, urge_window_end = ?, urge_start_at = ?,
                        reminded_at = ?, remind_key = ?,
                        visibility = ?, updated_at = ?
        WHERE id = ?`,
      [
        b.title == null ? row.title : str(b.title, 100, '标题', { required: true }),
        b.note == null ? row.note : str(b.note, 2000, '备注'),
        date,
        endDate,
        startTime,
        b.endTime == null ? row.end_time : timeOnly(b.endTime, '结束时间'),
        b.location == null ? row.location : str(b.location, 100, '地点'),
        b.participants == null ? row.participants : JSON.stringify(strList(b.participants, 30, 20, '参与人')),
        b.priority == null || !PRIORITIES.has(b.priority) ? row.priority : b.priority,
        repeatPair(repeat).legacy,
        repeat,
        done,
        remind,
        remindAdvance,
        urgeMinutes,
        urgeStatus,
        urgeCount,
        urgeMaxCount,
        urgeWindowStart,
        urgeWindowEnd,
        urgeStartAt,
        remindedAt,
        remindKey,
        visibility,
        nowIso(), id,
      ],
    );
    /* 网页上勾选完成 → 停催（文档 5.10.3：stopped_by_manual）。
       urge_minutes 保持原值 —— 那是用户的配置，清成 0 下次编辑就看不到原值了。 */
    if (done === 1 && !row.done && !repeat) {
      urge.stopUrgeManual(id);
    }
    const todo = shapeTodo(db.get('SELECT * FROM todos WHERE id = ?', [id]), me, ctx);
    // 只勾选/取消完成不算「更新了内容」，不打扰家人
    const CONTENT_FIELDS = ['title', 'note', 'date', 'endDate', 'startTime', 'endTime', 'location',
      'participants', 'repeat', 'visibility'];
    if (CONTENT_FIELDS.some((k) => b[k] != null)) {
      notify.changed({
        actor: me, kind: 'todo', action: 'update', visibility, id: todo.id,
        title: todo.title, detail: [todo.date || '未安排日期', todo.startTime].filter(Boolean).join(' '),
      });
    }
    return todo;
  },

  remove(me, id) {
    const res = db.run(`DELETE FROM todos WHERE id = ? AND ${VISIBLE}`, [id, me.id]);
    if (!res.changes) throw fail('事项不存在或无权删除', 404);
    /* v4.21.0 需求 2：顺手清掉这条重复事项的完成标记。
       外键 CASCADE 在正常情况下已经代劳，但 migrate() 重建表期间外键是关的，
       那条路径下会留下孤儿行 —— 显式删一次，代价只有一行 SQL。 */
    try { db.run('DELETE FROM todo_done_marks WHERE todo_id = ?', [id]); } catch { /* 老库还没这张表 */ }
    return { id };
  },
};

/* ── 图文动态与评论 ─────────────────────────────────────── */

/** 一条动态最多带几段视频。服务端与前端共用这一个数，别各写一份。 */
const MAX_POST_VIDEOS = 3;

/** 动态的「一句话摘要」：通知邮件的标题用它，避免各处自己拼字符串拼出不同措辞 */
function postSummary(post) {
  if (post.content) return post.content;
  const parts = [];
  if (post.images.length) parts.push(`${post.images.length} 张图片`);
  if (post.videos.length) parts.push(`${post.videos.length} 段视频`);
  return parts.length ? `（${parts.join(' + ')}）` : '（空动态）';
}
/** 动态的补充说明（通知邮件正文那行） */
function postDetail(post) {
  const parts = [];
  if (post.images.length) parts.push(`含 ${post.images.length} 张图片`);
  if (post.videos.length) parts.push(`含 ${post.videos.length} 段视频`);
  return parts.join('，');
}

const posts = {
  /**
   * @param {string} [q] 关键词：匹配正文 / 标签 / 作者昵称（动态搜索）
   * 先按可见性过滤，再叠加关键词 —— 顺序不能反，否则会搜到别人的私密内容。
   */
  list(me, limit = 100, q = '') {
    const n = Math.min(Math.max(Number(limit) || 100, 1), 300);
    const where = [VISIBLE];
    const params = [me.id];
    const kw = String(q || '').trim().slice(0, 50);
    if (kw) {
      where.push('(content LIKE ? OR tags LIKE ? OR owner_name LIKE ?)');
      const like = `%${kw}%`;
      params.push(like, like, like);
    }
    const rows = db.all(
      `SELECT * FROM posts WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
      [...params, n],
    );
    const list = rows.map((r) => shapePost(r, me));
    if (!list.length) return list;

    // 评论一次取回后按 post_id 归并，避免 N+1
    // 注意：comments 表本身没有 visibility 列，其可见性完全由所属动态决定——
    // 这里只取「已经通过可见性过滤的动态」的评论，因此不需要再加谓词。
    const ids = list.map((p) => p.id);
    const marks = ids.map(() => '?').join(',');
    const comments = db.all(
      `SELECT * FROM comments WHERE post_id IN (${marks}) ORDER BY created_at ASC, id ASC`,
      ids,
    );
    const byPost = new Map(list.map((p) => [p.id, p]));
    const byComment = new Map();                 // v4.3.3：点赞要按评论 id 反查
    for (const c of comments) {
      const target = byPost.get(c.post_id);
      if (!target) continue;
      const shaped = shapeComment(c, me);
      target.comments.push(shaped);
      byComment.set(shaped.id, shaped);
    }
    /* v4.3.3 需求 1：点赞一次取回，动态赞与评论赞在同一张表里（target 区分）。
       join users 取昵称：点赞区要显示「❤ 张三、李四」，只存 id 的话前端还得再查一次。 */
    const likeRows = db.all(
      `SELECT l.target, l.target_id, l.user_id, u.display_name
         FROM post_likes l JOIN users u ON u.id = l.user_id
        WHERE l.post_id IN (${marks}) ORDER BY l.created_at ASC, l.id ASC`,
      ids,
    );
    for (const r of likeRows) {
      if (r.target === 'comment') {
        const c = byComment.get(Number(r.target_id));
        if (!c) continue;                        // 评论已删，赞随之失效（显示时忽略即可）
        c.likes.push({ name: r.display_name, mine: Number(r.user_id) === me.id });
        c.likeCount = c.likes.length;
        c.liked = c.likes.some((x) => x.mine);
      } else {
        const p = byPost.get(Number(r.target_id));
        if (!p) continue;
        p.likes.push({ name: r.display_name, mine: Number(r.user_id) === me.id });
        p.likeCount = p.likes.length;
        p.liked = p.likes.some((x) => x.mine);
      }
    }
    // v1.9.0：共创内容一次取回后按 post_id 归并（同样避免 N+1）。
    // 与 comments 一样，本表没有 visibility 列，可见性完全由所属动态决定，
    // 而这里的 ids 已经过可见性过滤 → 不需要再加谓词（加了反而会 500）。
    const contribs = db.all(
      `SELECT * FROM post_contribs WHERE post_id IN (${marks}) ORDER BY created_at ASC, id ASC`,
      ids,
    );
    for (const c of contribs) {
      const target = byPost.get(c.post_id);
      if (target) target.contributions.push(shapeContrib(c, me));
    }
    return list;
  },

  create(me, b) {
    const content = str(b.content, 5000, '内容');
    const images = strList(b.images, 9, 300, '图片');
    // v1.9.0：视频与图片并列。一条动态最多 3 段视频 —— 再多就不是「记录此刻」而是发专辑了，
    // 而且每段都可能几十 MB，服务端与手机都吃不消。
    const videos = strList(b.videos, MAX_POST_VIDEOS, 300, '视频');
    const tags = strList(b.tags, 10, 16, '标签');
    if (!content && !images.length && !videos.length) throw fail('请输入内容，或选择图片 / 视频');
    const visibility = pickVisibility(b.visibility);
    // v4.3.3 需求 8：视频封面（没传就是空对象，前端回退到 #t=0.1）
    const videoCovers = pickVideoCovers(b.videoCovers, videos);
    const res = db.run(
      `INSERT INTO posts (user_id, owner_name, content, images, videos, video_covers, tags, visibility, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [me.id, me.display_name, content, JSON.stringify(images), JSON.stringify(videos),
        JSON.stringify(videoCovers), JSON.stringify(tags), visibility, nowIso(), nowIso()],
    );
    const post = shapePost(db.get('SELECT * FROM posts WHERE id = ?', [res.lastInsertRowid]), me);
    notify.changed({
      actor: me, kind: 'post', action: 'create', visibility, id: post.id,
      title: content || postSummary(post), detail: postDetail(post),
    });
    return post;
  },

  update(me, id, b) {
    const row = db.get(`SELECT * FROM posts WHERE id = ? AND ${VISIBLE}`, [id, me.id]);
    if (!row) throw fail('动态不存在或无权访问', 404);
    if (row.user_id !== me.id) throw fail('只能修改自己发布的动态', 403);
    const content = b.content == null ? row.content : str(b.content, 5000, '内容');
    const images = b.images == null ? parseJsonArray(row.images) : strList(b.images, 9, 300, '图片');
    const videos = b.videos == null ? parseJsonArray(row.videos) : strList(b.videos, MAX_POST_VIDEOS, 300, '视频');
    // 与创建保持一致：改完之后不能变成「既没文字也没图片也没视频」的空动态，
    // 否则动态流里会留下一张点不开也删不掉的空白卡片
    if (!content && !images.length && !videos.length) throw fail('请输入内容，或选择图片 / 视频');
    /* v4.3.3 需求 8：封面要与视频列表保持同步。
       ① 编辑正文 / 只换视频时，前端不一定重传封面 → 先合并旧封面；
       ② 再按**新的** videos 过滤，删掉的视频不会留下孤儿封面。 */
    const coverBase = {
      ...parseJsonObject(row.video_covers),
      ...(b.videoCovers && typeof b.videoCovers === 'object' ? b.videoCovers : {}),
    };
    const videoCovers = pickVideoCovers(coverBase, videos);
    db.run('UPDATE posts SET content = ?, images = ?, videos = ?, video_covers = ?, tags = ?, visibility = ?, updated_at = ? WHERE id = ?', [
      content,
      JSON.stringify(images),
      JSON.stringify(videos),
      JSON.stringify(videoCovers),
      b.tags == null ? row.tags : JSON.stringify(strList(b.tags, 10, 16, '标签')),
      b.visibility == null ? row.visibility : pickVisibility(b.visibility),
      nowIso(), id,
    ]);
    const post = shapePost(db.get('SELECT * FROM posts WHERE id = ?', [id]), me);
    notify.changed({
      actor: me, kind: 'post', action: 'update', visibility: post.visibility, id: post.id,
      title: post.content || postSummary(post), detail: postDetail(post),
    });
    return post;
  },

  remove(me, id) {
    const row = db.get(`SELECT * FROM posts WHERE id = ? AND ${VISIBLE}`, [id, me.id]);
    if (!row) throw fail('动态不存在或无权删除', 404);
    // 家庭内容允许家人协作整理，隐私内容只有本人能删
    if (row.visibility === 'private' && row.user_id !== me.id) throw fail('无权删除', 403);
    db.run('DELETE FROM posts WHERE id = ?', [id]);
    return { id };
  },
};

const comments = {
  create(me, b) {
    const postId = idOf(b.postId);
    const post = db.get(`SELECT id, content, visibility FROM posts WHERE id = ? AND ${VISIBLE}`, [postId, me.id]);
    if (!post) throw fail('动态不存在或无权评论', 404);
    const content = str(b.content, 1000, '评论', { required: true });
    /* v4.3.3 需求 1：回复他人评论（两级结构，交互同朋友圈）。
       · 回复一条顶层评论 → parent_id = 它自己；
       · 回复一条「回复」→ 挂到它所属的**顶层评论**下，被回复人取那一条的作者。
         这样无论点了谁，树最多只有两层，渲染与最小重绘都不会失控。
       · 被回复人昵称存快照：原评论被删后，「回复 张三」这句话仍要能正常显示。 */
    let parentId = 0;
    let replyToName = '';
    const wantParent = Number(b.parentId) || 0;
    if (wantParent > 0) {
      const parent = db.get('SELECT id, post_id, owner_name, parent_id FROM comments WHERE id = ?', [wantParent]);
      if (!parent || Number(parent.post_id) !== Number(postId)) throw fail('要回复的评论不存在', 404);
      parentId = Number(parent.parent_id) || Number(parent.id);
      replyToName = String(parent.owner_name || '');
    }
    const res = db.run(
      'INSERT INTO comments (post_id, user_id, owner_name, content, parent_id, reply_to_name, created_at) VALUES (?,?,?,?,?,?,?)',
      [postId, me.id, me.display_name, content, parentId, replyToName, nowIso()],
    );
    const comment = shapeComment(db.get('SELECT * FROM comments WHERE id = ?', [res.lastInsertRowid]), me);
    // 评论也算「更新了全家共享的内容」——通知除作者外的家人
    notify.changed({
      actor: me, kind: 'comment', action: 'create', visibility: post.visibility, id: comment.id,
      title: post.content,
      // v4.3.3：邮件里要能看出这是「回复某人」的评论，而不是一句没头没尾的话
      detail: replyToName ? `回复 ${replyToName}：${content}` : content,
    });
    return comment;
  },

  remove(me, id) {
    // 本人可删；动态发布者也可清理自己动态下的评论
    const row = db.get('SELECT * FROM comments WHERE id = ?', [id]);
    if (!row) throw fail('评论不存在', 404);
    const post = db.get(`SELECT id, user_id FROM posts WHERE id = ? AND ${VISIBLE}`, [row.post_id, me.id]);
    if (!post) throw fail('评论不存在或无权访问', 404);
    if (row.user_id !== me.id && post.user_id !== me.id) throw fail('只能删除自己的评论', 403);
    /* v4.3.3 需求 1：删顶层评论时，它下面的回复一起删（朋友圈同款语义）。
       不级联的话，子回复的 parent_id 会指向一条不存在的记录，
       界面上只剩一堆「回复 张三」却没有原评论的碎片。 */
    db.run('DELETE FROM comments WHERE parent_id = ?', [id]);
    db.run('DELETE FROM comments WHERE id = ?', [id]);
    return { id };
  },
};

/* ── 点赞（v4.3.3 需求 1） ─────────────────────────────────

   一条动态、一条评论都能被点赞，交互同朋友圈（再点一次 = 取消）。

   权限：先按可见性取到动态，取不到直接 404 —— 绝不「先查赞、再查动态」，
   否则会泄露「某个别人的私密动态/评论存在」这件事本身。

   幂等：UNIQUE(target, target_id, user_id) 是物理保证。前端连点两下、
   两个标签页同时点，最多也只会有一条记录（不会出现「一个人赞了两次」）。 */

const likes = {
  toggle(me, b) {
    const postId = idOf(b.postId);
    const post = db.get(`SELECT id, content, visibility FROM posts WHERE id = ? AND ${VISIBLE}`, [postId, me.id]);
    if (!post) throw fail('动态不存在或无权访问', 404);
    const target = b.target === 'comment' ? 'comment' : 'post';
    let targetId = postId;
    if (target === 'comment') {
      targetId = idOf(b.targetId);
      const c = db.get('SELECT id, post_id FROM comments WHERE id = ?', [targetId]);
      // 评论必须属于这条动态：只校验「评论存在」的话，拿一条别的动态的评论 id
      // 也能在这条动态下点出赞来（跨动态的脏数据）。
      if (!c || Number(c.post_id) !== Number(postId)) throw fail('评论不存在', 404);
    }
    const exist = db.get(
      'SELECT id FROM post_likes WHERE target = ? AND target_id = ? AND user_id = ?',
      [target, targetId, me.id],
    );
    if (exist) db.run('DELETE FROM post_likes WHERE id = ?', [exist.id]);
    else {
      db.run(
        'INSERT INTO post_likes (post_id, user_id, target, target_id, created_at) VALUES (?,?,?,?,?)',
        [postId, me.id, target, targetId, nowIso()],
      );
    }
    const rows = db.all(
      `SELECT l.user_id, u.display_name FROM post_likes l JOIN users u ON u.id = l.user_id
        WHERE l.target = ? AND l.target_id = ? ORDER BY l.created_at ASC, l.id ASC`,
      [target, targetId],
    );
    const out = rows.map((r) => ({ name: r.display_name, mine: Number(r.user_id) === me.id }));
    return { target, targetId, liked: !exist, count: out.length, likes: out };
  },
};

/* ── 动态共创（v1.9.0） ─────────────────────────────────────

   家庭朋友圈的「一起写」：家人可以对**别人的**动态追加图片 / 文字 / 视频，
   每条都留下「谁、什么时候、加了什么」，原动态作者也能看到全部改动痕迹。

   权限规则（与需求 9 一致，且刻意收窄到最小）：
     · 能给「全家可见」的动态追加内容 —— 家人之间本来就是共享的；
     · 「仅自己可见」的动态不开放共创（别人根本看不到它）；
     · 删除单条共创：贡献者本人可以撤掉，动态作者可以清理自己动态下的任何一条
       （与评论的删除规则保持一致，作者对自己那条动态有管理权）。
   可见性跟随所属动态 —— 本表没有 visibility 列，别在这里套 VISIBLE 谓词。 */

const contribs = {
  create(me, b) {
    const postId = idOf(b.postId);
    const post = db.get(`SELECT id, user_id, content, visibility FROM posts WHERE id = ? AND ${VISIBLE}`,
      [postId, me.id]);
    if (!post) throw fail('动态不存在或无权访问', 404);
    if (post.visibility === 'private' && post.user_id !== me.id) {
      throw fail('这条动态仅作者本人可见，不能一起写', 403);
    }
    const content = str(b.content, 2000, '内容');
    const images = strList(b.images, 9, 300, '图片');
    const videos = strList(b.videos, MAX_POST_VIDEOS, 300, '视频');
    if (!content && !images.length && !videos.length) throw fail('请填写内容，或选择图片 / 视频');
    // v4.6.0 需求 4：共创视频的封面（只认本次视频列表里真实存在的路径）
    const videoCovers = pickVideoCovers(b.videoCovers, videos);
    const res = db.run(
      `INSERT INTO post_contribs (post_id, user_id, owner_name, content, images, videos, video_covers, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [postId, me.id, me.display_name, content, JSON.stringify(images), JSON.stringify(videos),
        JSON.stringify(videoCovers), nowIso()],
    );
    // 共创也是「这条动态被更新了」→ 同步 updated_at：
    // 首页排序与红点提示都依赖它，不更新的话家人根本注意不到有人补充了内容。
    db.run('UPDATE posts SET updated_at = ? WHERE id = ?', [nowIso(), postId]);
    const contrib = shapeContrib(db.get('SELECT * FROM post_contribs WHERE id = ?', [res.lastInsertRowid]), me);
    notify.changed({
      actor: me, kind: 'post', action: 'update', visibility: post.visibility, id: postId,
      title: post.content || '（动态）', detail: content || '（补充了图片 / 视频）',
    });
    return contrib;
  },

  /* v4.3.3 需求 5：「一起写」支持编辑已经写下的内容。
     ★ 权限刻意只给作者本人：动态作者有「清理权」（可以删掉别人的补充），
       但没有「改写权」—— 允许改别人的话，「每条都留痕」就名存实亡了。
     ★ 编辑后同步 posts.updated_at：首页排序与红点都依赖它，
       否则家人根本注意不到有人改过内容。 */
  update(me, id, b) {
    const row = db.get('SELECT * FROM post_contribs WHERE id = ?', [id]);
    if (!row) throw fail('共创内容不存在', 404);
    const post = db.get(`SELECT id, user_id, content, visibility FROM posts WHERE id = ? AND ${VISIBLE}`,
      [row.post_id, me.id]);
    if (!post) throw fail('共创内容不存在或无权访问', 404);
    if (Number(row.user_id) !== Number(me.id)) throw fail('只能编辑自己补充的内容', 403);
    const content = b.content == null ? row.content : str(b.content, 2000, '内容');
    const images = b.images == null ? parseJsonArray(row.images) : strList(b.images, 9, 300, '图片');
    const videos = b.videos == null ? parseJsonArray(row.videos) : strList(b.videos, MAX_POST_VIDEOS, 300, '视频');
    if (!content && !images.length && !videos.length) throw fail('请填写内容，或选择图片 / 视频');
    // v4.6.0：编辑时同样同步封面 —— 换了视频，旧封面必须跟着失效（pickVideoCovers 会过滤掉）
    const coverBase = { ...parseJsonObject(row.video_covers), ...(b.videoCovers && typeof b.videoCovers === 'object' ? b.videoCovers : {}) };
    const videoCovers = pickVideoCovers(coverBase, videos);
    db.run(
      'UPDATE post_contribs SET content = ?, images = ?, videos = ?, video_covers = ?, updated_at = ? WHERE id = ?',
      [content, JSON.stringify(images), JSON.stringify(videos), JSON.stringify(videoCovers), nowIso(), id],
    );
    db.run('UPDATE posts SET updated_at = ? WHERE id = ?', [nowIso(), post.id]);
    const out = shapeContrib(db.get('SELECT * FROM post_contribs WHERE id = ?', [id]), me);
    notify.changed({
      actor: me, kind: 'post', action: 'update', visibility: post.visibility, id: post.id,
      title: post.content || '（动态）', detail: content || '（修改了补充的图片 / 视频）',
    });
    return out;
  },

  remove(me, id) {
    const row = db.get('SELECT * FROM post_contribs WHERE id = ?', [id]);
    if (!row) throw fail('共创内容不存在', 404);
    const post = db.get(`SELECT id, user_id FROM posts WHERE id = ? AND ${VISIBLE}`, [row.post_id, me.id]);
    if (!post) throw fail('共创内容不存在或无权访问', 404);
    if (row.user_id !== me.id && post.user_id !== me.id) throw fail('只能删除自己的补充内容', 403);
    db.run('DELETE FROM post_contribs WHERE id = ?', [id]);
    return { id };
  },
};

/* ── 重点事项记录本 ─────────────────────────────────────── */

/**
 * 记录本上锁时，未持有效解锁凭证的请求一律拦下（前端凭 code=RECORDS_LOCKED 弹解锁框）。
 * 凭证 = 解锁时签发、存在 sessionStorage 的随机 key，随 x-records-key 头带来；
 * 关闭页面后 sessionStorage 清空，凭证自然失效，需要重新输入密码。
 */
function guardRecords(me, recordsKey) {
  const key = String(recordsKey || '');
  if (me.record_lock_enabled && (!key || key !== me.records_unlocked_key)) {
    throw Object.assign(fail('记录本已上锁，请先解锁', 403), { code: 'RECORDS_LOCKED' });
  }
}

/* ── 记录本分类的「隐藏（删除）」名单 ──────────────────────
   分类不是一张独立的表，它只是 records.category 上的一个取值；预设分类又写死在前端。
   所以「删除分类」= ① 把该分类下的记录改成「通用」 ② 把分类名记进 settings 的
   隐藏名单，界面上不再展示。这样既不丢记录，也能真正把分类「删掉」。 */
const HIDDEN_CAT_KEY = 'records_hidden_categories';

function loadHiddenCategories() {
  const row = db.get('SELECT value FROM settings WHERE key = ?', [HIDDEN_CAT_KEY]);
  if (!row || !row.value) return [];
  return String(row.value).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
}

function putHiddenCategories(list) {
  const value = Array.from(new Set(list.map((s) => String(s).trim()).filter(Boolean))).slice(0, 100).join(',');
  db.run(
    'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [HIDDEN_CAT_KEY, value],
  );
}

/**
 * v4.12.0 需求（记录本模块）：把请求里的「记录本提醒」整理成一组可直接落库的值。
 *
 * 三件事必须一起做对，否则界面会「看起来打开了、实际不提醒」：
 *   ① 关掉提醒 → remind_at 清空（调度器只看 remind_at，清空即彻底不提醒）；
 *   ② 打开或改了时间/天数 → 重算 remind_at，并清空 reminded_at（改完能重新提醒一次）；
 *   ③ 只改标题/正文 → 不动提醒（否则每次编辑都会把已经提醒过的又翻出来）。
 */
const RECORD_REMIND_CHANNELS = new Set(['', 'mail', 'wecom', 'both']);
function recordRemindPatch(b, row) {
  const src = row || {};
  const has = (k) => b[k] != null;
  const on = has('remind') ? !!b.remind : !!src.remind;
  const time = has('remindTime') ? String(b.remindTime).trim() : String(src.remind_time || '');
  if (time && !TIME_RE.test(time)) throw fail('提醒时间需为 HH:MM 格式（留空表示跟随家庭设置）');
  let adv = has('remindAdvanceDays') ? Math.round(Number(b.remindAdvanceDays)) : Number(src.remind_advance_days);
  if (!Number.isFinite(adv)) adv = -1;
  if (has('remindAdvanceDays') && adv !== -1 && (adv < 0 || adv > 5)) {
    throw fail('提前提醒天数需为 0-5（-1 表示跟随家庭设置）');
  }
  const channel = has('remindChannel') ? String(b.remindChannel).trim() : String(src.remind_channel || '');
  if (!RECORD_REMIND_CHANNELS.has(channel)) {
    throw fail('提醒方式只能是：跟随系统 / 邮件 / 企业微信 / 两者都发');
  }
  /* ★ v4.12.0：「改过」必须按**值是否真的变了**判断，不能只看字段在不在请求里。
     表单每次保存都会把三个子项一起提交（哪怕用户只是改了标题），
     若按「字段存在」判，等于每次编辑正文都重新武装一次提醒 —— 与规则 ③ 正好相反。 */
  const touched = (has('remindTime') && time !== String(src.remind_time || ''))
    || (has('remindAdvanceDays') && adv !== (Number.isFinite(Number(src.remind_advance_days)) ? Number(src.remind_advance_days) : -1))
    || (has('remindChannel') && channel !== String(src.remind_channel || ''))
    || (has('remind') && on !== !!src.remind);
  const at = on ? reminders.recordRemindMoment(time, adv) : '';
  return {
    remind: on ? 1 : 0,
    time,
    adv,
    channel,
    at,
    // 打开提醒、或改过时间/天数时才重新计时；单纯编辑正文不动它
    resetReminded: !!(on && (touched || !src.remind_at)),
  };
}

const records = {
  list(me, query = {}, recordsKey) {
    guardRecords(me, recordsKey);
    const where = [VISIBLE];
    const params = [me.id];
    if (query.category) { where.push('category = ?'); params.push(String(query.category).slice(0, 20)); }
    /* v1.9.0 归档筛选。三种取值，默认值刻意保持与旧版一致（只看未归档）：
         '1'   只看已归档（「已归档」页签）
         '0'   只看未归档（默认）
         'all' 全都看
       另外：**带关键词搜索时不加这个条件** —— 归档的用途就是「收起来但还找得到」，
       搜索时把它藏掉等于变相删除，正是用户最不想要的那种「东西还在但找不到」。 */
    const arch = query.archived;
    if (arch === '1') where.push('archived = 1');
    else if (arch === '0') where.push('(archived IS NULL OR archived = 0)');
    else if (arch !== 'all' && !query.q) where.push('(archived IS NULL OR archived = 0)');
    if (query.q) {
      // 标签已停用（v1.5.0 移除标签功能），改为把「附件名」纳入搜索：
      // 「体检报告.pdf」这种按文件名找比按标签找更符合直觉。
      where.push('(title LIKE ? OR content LIKE ? OR category LIKE ? OR attachments LIKE ?)');
      const like = `%${String(query.q).slice(0, 50)}%`;
      params.push(like, like, like, like);
    }
    const rows = db.all(
      `SELECT * FROM records WHERE ${where.join(' AND ')}
        ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT 1000`,
      params,
    );
    return rows.map((r) => shapeRecord(r, me));
  },

  create(me, b, recordsKey) {
    guardRecords(me, recordsKey);
    const visibility = pickVisibility(b.visibility);
    const content = str(b.content, 20000, '内容');
    const rm = recordRemindPatch(b, null);
    const res = db.run(
      `INSERT INTO records (user_id, owner_name, title, content, content_json, category, tags, images, attachments,
                            pinned, visibility, created_at, updated_at,
                            remind, remind_time, remind_advance_days, remind_channel, remind_at, reminded_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'')`,
      [
        me.id, me.display_name,
        str(b.title, 120, '标题', { required: true }),
        content,
        // v4.10.0：行模型落库（编辑后 content_json 必有值；content 保持同步）
        JSON.stringify(contentRowsOf(content)),
        str(b.category, 20, '分类') || '通用',
        // tags 列保留但界面已停用：新记录一律写空数组，老数据照旧读得出来
        JSON.stringify(strList(b.tags, 10, 20, '标签')),
        JSON.stringify(pickRecordImages(b.images)),
        JSON.stringify(pickAttachments(b.attachments)),
        b.pinned ? 1 : 0,
        visibility,
        nowIso(), nowIso(),
        rm.remind, rm.time, rm.adv, rm.channel, rm.at,
      ],
    );
    const record = shapeRecord(db.get('SELECT * FROM records WHERE id = ?', [res.lastInsertRowid]), me);
    // 记录本内容往往涉及隐私，但「全家共享」的那部分本来就是给家人看的；
    // 邮件正文里只放标题，不放正文。
    notify.changed({ actor: me, kind: 'record', action: 'create', visibility, id: record.id, title: record.title, detail: '' });
    return record;
  },

  update(me, id, b, recordsKey) {
    guardRecords(me, recordsKey);
    const row = db.get(`SELECT * FROM records WHERE id = ? AND ${VISIBLE}`, [id, me.id]);
    if (!row) throw fail('记录不存在或无权访问', 404);

    let visibility = row.visibility;
    if (b.visibility != null && b.visibility !== row.visibility) {
      if (row.user_id !== me.id) throw fail('只有创建者可以修改可见性', 403);
      visibility = pickVisibility(b.visibility);
    }

    const newContent = b.content == null ? row.content : str(b.content, 20000, '内容');
    // v4.12.0：记录本提醒（默认不提醒）。只改标题/正文时不动提醒计时。
    const rm = recordRemindPatch(b, row);
    db.run(
      `UPDATE records SET title = ?, content = ?, content_json = ?, category = ?, tags = ?, images = ?, attachments = ?,
                          pinned = ?, archived = ?, visibility = ?, updated_at = ?,
                          remind = ?, remind_time = ?, remind_advance_days = ?, remind_channel = ?, remind_at = ?, reminded_at = ?
        WHERE id = ?`,
      [
        b.title == null ? row.title : str(b.title, 120, '标题', { required: true }),
        newContent,
        // v4.10.0：编辑后 content_json 有值（文档验收：老记录编辑后 content_json 不再为空）
        JSON.stringify(contentRowsOf(newContent)),
        b.category == null ? row.category : (str(b.category, 20, '分类') || '通用'),
        b.tags == null ? row.tags : JSON.stringify(strList(b.tags, 10, 20, '标签')),
        b.images == null ? row.images : JSON.stringify(pickRecordImages(b.images)),
        b.attachments == null ? row.attachments : JSON.stringify(pickAttachments(b.attachments)),
        b.pinned == null ? row.pinned : (b.pinned ? 1 : 0),
        b.archived == null ? row.archived : (b.archived ? 1 : 0),
        visibility,
        nowIso(),
        rm.remind, rm.time, rm.adv, rm.channel, rm.at,
        rm.resetReminded ? '' : String(row.reminded_at || ''),
        id,
      ],
    );
    const record = shapeRecord(db.get('SELECT * FROM records WHERE id = ?', [id]), me);
    // 只「归档/取消归档/置顶」不算内容变更，不打扰家人（与待办勾选完成同理）
    const CONTENT_FIELDS = ['title', 'content', 'category', 'images', 'attachments', 'visibility'];
    if (CONTENT_FIELDS.some((k) => b[k] != null)) {
      notify.changed({ actor: me, kind: 'record', action: 'update', visibility: record.visibility, id: record.id, title: record.title, detail: '' });
    }
    return record;
  },

  remove(me, id, recordsKey) {
    guardRecords(me, recordsKey);
    const res = db.run(`DELETE FROM records WHERE id = ? AND ${VISIBLE}`, [id, me.id]);
    if (!res.changes) throw fail('记录不存在或无权删除', 404);
    return { id };
  },

  /**
   * 删除一个分类（v1.6.0）。分类只是 records.category 上的取值，所以：
   *   1) 把该类下「我能改的」记录（家庭可见的 + 自己的）改成「通用」—— 记录本身不删；
   *   2) 把分类名记进隐藏名单，之后不再出现在分类条里。
   * 「通用」是兜底分类，不允许删除。
   */
  removeCategory(me, name, recordsKey) {
    guardRecords(me, recordsKey);
    const cat = String(name || '').trim().slice(0, 20);
    if (!cat) throw fail('分类名不能为空');
    if (cat === '通用') throw fail('「通用」是默认分类，不能删除');
    const res = db.run(
      `UPDATE records SET category = '通用', updated_at = ? WHERE category = ? AND ${VISIBLE}`,
      [nowIso(), cat, me.id],
    );
    const hidden = loadHiddenCategories();
    if (!hidden.includes(cat)) hidden.push(cat);
    putHiddenCategories(hidden);
    return { category: cat, moved: res.changes, hiddenCategories: loadHiddenCategories() };
  },
};

/* ── 图片 / 附件上传 ─────────────────────────────────────── */

/**
 * ★ v1.5.0 修的「动态图片上传失败」，服务端这一半：
 *   1) 旧版只认 jpeg/png/webp/gif 四个 MIME 字符串，而部分安卓浏览器会把
 *      真·JPEG 标成 image/heic 或干脆不给类型 → 好图被当成非法格式拒掉。
 *      现在改为【按文件头魔数嗅探】为准，客户端声明的类型完全不参与判断。
 *   2) 超过体积上限时只回「图片不能超过 5MB」，用户不知道自己的图多大。
 *      现在报出实际大小与上限，并且默认上限从 5MB 提到 10MB。
 * ★ SVG 仍然拒收：它是可执行内容（可内嵌 script），同源直接打开等于 XSS 面。
 * ★ HEIC/HEIF 也拒收，但给出可操作提示：能被浏览器显示的格式我们都收，
 *   显示不了的不收 —— 收了只会变成「上传成功却看不到图」，比报错更难排查。
 */

/** 文件头嗅探：返回真实图片类型（取不到返回 ''）。绝不只看客户端声明的 MIME。 */
function sniffImageType(buf) {
  const b = buf;
  if (b.length < 4) return '';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 8 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.slice(0, 6).toString('latin1') === 'GIF87a' || b.slice(0, 6).toString('latin1') === 'GIF89a') return 'gif';
  if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.length >= 12 && b.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (b.slice(0, 2).toString('latin1') === 'BM') return 'bmp';
  if (b.length >= 4 && (b.readUInt32BE(0) === 0x49492a00 || b.readUInt32BE(0) === 0x4d4d002a)) return 'tiff';
  if (b.length >= 12 && b.slice(4, 8).toString('latin1') === 'ftyp') {
    const brand = b.slice(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return 'heic';
  }
  if (b.readUInt32BE(0) === 0x00000100) return 'ico';
  const head = b.slice(0, 512).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  return '';
}

/** 上限文案：把「实际多大 / 上限多少」都告诉用户，别只说「太大了」 */
const tooBig = (label, bytes, maxMb) =>
  fail(`${label}有 ${(bytes / 1024 / 1024).toFixed(1)}MB，超过上限 ${maxMb}MB。请先压缩后再上传。`);

function decodeDataUrl(dataUrl) {
  const s = String(dataUrl || '');
  const m = /^data:([\w/+.-]*);base64,([A-Za-z0-9+/=\s]+)$/.exec(s);
  if (!m) throw fail('文件数据格式不正确，请重新选择文件');
  const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  if (!buf.length) throw fail('文件内容为空');
  return { mime: (m[1] || '').toLowerCase(), buf };
}

/* ── v4.21.0（技术债 W-2 余项）：大文件改成「分块解码 + 流式落盘」 ──────────
   ★ 问题：老写法 `Buffer.from(整段 base64)` 会在内存里再造一份完整副本，
     叠加请求体原文与 JSON 解析后的字符串，50MB 视频的峰值内存约 4~5 倍。
   ★ 现在：只解析出「MIME / base64 正文 / 字节数 / 前 512 字节」，解码按 48KB 一档
     （必须是 4 的倍数才能独立解码）立刻写出，内存里始终只有一个 48KB 的小缓冲。
     前 512 字节足够所有魔数嗅探（图片 12 字节、视频 12 字节、可执行文件 64 字节），
     所以校验口径一个字都没变。
   ★ 仍然走 base64 + JSON 这套协议（改协议要动前端上传通道与全部上传用例，
     留作下一刀）；这一刀只把「整份副本」从峰值里去掉。
   ★ 图片通道保持原样：上限只有 10MB，且落盘前要拿全量字节做魔数与尺寸判断，
     分块反而更绕。 */
function parseDataUrl(dataUrl) {
  const s = String(dataUrl || '');
  const m = /^data:([\w/+.-]*);base64,([A-Za-z0-9+/=\s]+)$/.exec(s);
  if (!m) throw fail('文件数据格式不正确，请重新选择文件');
  let b64 = m[2];
  // 只有真的带空白才复制一遍字符串（正常 dataURL 没有空白，这一步是 0 成本）
  if (/[^A-Za-z0-9+/=]/.test(b64)) b64 = b64.replace(/\s+/g, '');
  const pad = b64.endsWith('==') ? 2 : (b64.endsWith('=') ? 1 : 0);
  const size = Math.floor(b64.length / 4) * 3 - pad;
  if (size <= 0) throw fail('文件内容为空');
  const head = Buffer.from(b64.slice(0, 1024), 'base64').slice(0, 512);
  return { mime: (m[1] || '').toLowerCase(), b64, size, head: Buffer.from(head) };
}

/** 分块解码写盘；任何一步出错都删掉半成品，不留「看起来有、其实截断」的文件 */
async function writeB64ToFile(b64, dest) {
  const src = String(b64);
  const CHUNK = 48 * 1024;
  const out = fs.createWriteStream(dest);
  const finished = new Promise((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });
  try {
    for (let i = 0; i < src.length; i += CHUNK) {
      const piece = Buffer.from(src.slice(i, i + CHUNK), 'base64');
      if (!out.write(piece)) await once(out, 'drain');
    }
    out.end();
    await finished;
  } catch (err) {
    out.destroy();
    try { await fs.promises.unlink(dest); } catch { /* 半成品可能还没建出来 */ }
    throw err;
  }
}

/** 文件名由服务端生成，绝不使用客户端传来的名字（防目录穿越 / 覆盖） */
function newStoredName(ext) {
  return `${Date.now().toString(36)}-${require('node:crypto').randomBytes(8).toString('hex')}.${ext}`;
}

async function uploadImage(me, b) {
  const { buf } = decodeDataUrl(b.dataUrl);
  const sniffed = sniffImageType(buf);
  if (!sniffed) {
    throw fail('这个文件不是有效的图片（读不出图片内容）。若是 iPhone 的 HEIC 照片，请先在相册里导出为 JPG 再上传。');
  }
  if (sniffed === 'svg') throw fail('出于安全考虑，不支持上传 SVG 图片，请改用 JPG / PNG。');
  if (sniffed === 'heic') {
    throw fail('iPhone 的 HEIC 照片浏览器无法显示，请先在相册里导出为 JPG 再上传（iOS 设置 → 相机 → 格式 → 兼容性最佳 可默认存成 JPG）。');
  }
  // 扩展名一律以文件头嗅探结果为准 —— 客户端声明的 MIME 可以是假的 / 是空的。
  const ext = sniffed;
  const limit = config.imageMaxMb * 1024 * 1024;
  if (buf.length > limit) throw tooBig('这张图片', buf.length, config.imageMaxMb);

  const name = newStoredName(ext);
  await fs.promises.writeFile(path.join(config.uploadDir, name), buf);
  return { path: `/api/media/${name}`, size: buf.length };
}

/* —— 记录本附件 ——
   与图片分开：附件（PDF / Office / 压缩包）通常更大，且一律以「下载」方式提供，
   不在页面里内联渲染，所以没有 SVG 那类 XSS 顾虑。 */

/** 允许的附件扩展名（常用办公文档 / 压缩包 / 图片 / 音视频 / 纯文本） */
const FILE_EXTS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf', 'odt', 'ods', 'odp',
  'txt', 'md', 'csv', 'tsv', 'json', 'xml', 'log', 'yaml', 'yml', 'ics', 'vcf',
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'tif', 'tiff', 'ico',
  'mp3', 'm4a', 'wav', 'amr', 'aac', 'ogg', 'flac',
  'mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv', '3gp',
  'epub', 'db', 'sqlite', 'apk',
]);

/** 危险文件头：可执行文件无论改叫什么名字都不许进（PE / ELF / Mach-O / shell 脚本） */
function looksExecutable(buf) {
  if (buf.length < 4) return false;
  if (buf[0] === 0x4d && buf[1] === 0x5a) return true;                       // MZ (EXE/DLL)
  if (buf.slice(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return true; // ELF
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0xfeedface) return true;    // Mach-O
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0xcafebabe) return true;    // Java class / fat binary
  const head = buf.slice(0, 64).toString('utf8');
  return /^#!\s*\//.test(head);                                             // shebang 脚本
}

const extOfName = (name) => {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || '').trim());
  return m ? m[1].toLowerCase() : '';
};

async function uploadFile(me, b) {
  /* W-2：附件上限更大（默认 20MB 级），走分块解码，不再整份 Buffer 铺在内存里 */
  const { b64, size, head } = parseDataUrl(b.dataUrl);
  const original = String(b.name || '').trim().slice(0, 200) || '附件';
  const ext = extOfName(original);
  if (!ext || !FILE_EXTS.has(ext)) {
    throw fail(`不支持的文件类型${ext ? `（.${ext}）` : ''}。支持 PDF / Word / Excel / PPT / 压缩包 / 图片 / 音视频 / 文本等常用格式。`);
  }
  if (looksExecutable(head)) throw fail('这个文件是可执行程序，出于安全考虑不允许上传。');
  const limit = config.fileMaxMb * 1024 * 1024;
  if (size > limit) throw tooBig('附件', size, config.fileMaxMb);

  const stored = newStoredName(ext);
  await writeB64ToFile(b64, path.join(config.uploadDir, stored));
  /* v4.13.0（问题 3）：附件（尤其视频）可以带一张封面图。
     复用图片通道落盘（走同一套魔数嗅探与大小限制），返回 /api/media/ 地址 ——
     不能返回 /api/file/ 那种带 Content-Disposition: attachment 的地址，
     否则 <img> 拿到的响应是「下载」，视觉上就是一张裂图。 */
  let cover = '';
  if (b.cover) {
    try {
      cover = (await uploadImage(me, { dataUrl: b.cover })).path;
    } catch { cover = ''; }   // 封面失败不影响附件本身
  }
  return {
    name: original,
    path: `/api/file/${stored}`,
    size,
    ...(cover ? { cover } : {}),
  };
}

/* —— 动态视频（v1.9.0）——
   第三条上传通道，与图片、附件分开，因为它的体积上限差了一个量级（默认 50MB）。

   ★ 校验口径与图片一致：**只认文件头魔数，不看客户端声明的 MIME**。
     手机浏览器把 mp4 报成 application/octet-stream、把 mov 报成空类型都是常事。
   ★ 只收浏览器能直接 <video> 播的三种容器（MP4 / MOV / WebM）。
     AVI、MKV、WMV 收下来只会变成「上传成功却播不了」，比当场报错更难排查 ——
     这与图片那边「不收 HEIC」是同一条原则。
*/
function sniffVideoType(buf) {
  if (buf.length < 12) return '';
  // EBML 头：WebM（也包含 MKV，两者容器头完全一样，只能按 WebM 收）
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
  if (buf.slice(4, 8).toString('latin1') !== 'ftyp') return '';
  const brand = buf.slice(8, 12).toString('latin1');
  if (/^(qt|QT)/.test(brand)) return 'mov';
  if (/^(isom|iso2|iso4|iso5|iso6|mp41|mp42|mp4v|avc1|dash|mmp4|M4V|MSNV|3gp4|3gp5)$/.test(brand)) return 'mp4';
  return '';
}

async function uploadVideo(me, b) {
  /* W-2：视频是最大的一档（默认 50MB），分块解码后立刻落盘，
     峰值内存里不再有「整份文件的第二份副本」。嗅探只用前 512 字节。 */
  const { b64, size, head } = parseDataUrl(b.dataUrl);
  const kind = sniffVideoType(head);
  if (!kind) {
    throw fail('这个文件不是浏览器能播放的视频。请改用 MP4 / MOV / WebM 格式（手机上一般是相册导出的 MP4）。');
  }
  // v4.10.0：上限后台可配（config.videoMaxMb 运行时字段，家庭设置里改）
  const limit = config.videoMaxMb * 1024 * 1024;
  if (size > limit) throw tooBig('这段视频', size, config.videoMaxMb);
  const name = newStoredName(kind);
  await writeB64ToFile(b64, path.join(config.uploadDir, name));
  const out = { path: `/api/media/${name}`, size };

  /* v4.6.0 需求 4：顺手把首帧封面落成 `<视频同名>.cover.jpg`。
     ★ 为什么是「同目录同名」而不是再返回一个哈希文件名：前端要靠**路径约定**
       推导封面地址（视频 `/api/media/x.mp4` → 封面 `/api/media/x.cover.jpg`）。
       有了约定，共创里的视频、日历里的视频、以及没有写进 posts.video_covers 的老数据，
       全都能拿到封面 —— 这正是「移动端仍然是一排黑框」的最后一块拼图。
     ★ 封面失败绝不影响视频：视频已经落盘，这里只是「有没有多一张图」的区别。 */
  if (b.cover) {
    try {
      const cbuf = decodeDataUrl(b.cover).buf;
      const ctype = sniffImageType(cbuf);
      const okType = ctype && ctype !== 'svg' && ctype !== 'heic';
      const smallEnough = cbuf.length <= config.imageMaxMb * 1024 * 1024;
      if (okType && smallEnough) {
        const base = name.slice(0, name.lastIndexOf('.'));
        const coverName = `${base}.cover.jpg`;
        await fs.promises.writeFile(path.join(config.uploadDir, coverName), cbuf);
        out.cover = `/api/media/${coverName}`;
      }
    } catch { /* 封面序列化失败就算了，别让整段视频上传失败 */ }
  }
  return out;
}

/** 解析上传目录里的文件（媒体与附件共用一套校验） */
function mediaPath(name) {
  const safe = path.basename(String(name || ''));
  if (!/^[A-Za-z0-9._-]+$/.test(safe)) return null;
  const full = path.join(config.uploadDir, safe);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  return full;
}

/** 下载用的原始文件名：去掉路径分隔符与控制字符，避免头部注入 */
function safeDownloadName(name, fallbackExt) {
  const s = String(name || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim().slice(0, 120);
  if (s) return s;
  return `附件${fallbackExt ? '.' + fallbackExt : ''}`;
}

/* ── 备份 / 恢复 ────────────────────────────────────────── */

const backup = {
  /* ★ v4.20.0（审查 C-1）：导出与恢复**权限对称**。
     原来这里收了 me 却完全没用 —— 任一家庭成员（乃至任何能自助注册的人）
     GET /api/backup 就能拿走全库快照：users 表的 password_hash、
     他人 visibility='private' 的待办/动态/记录，以及全部图片 base64。
     写操作 restore 一直是 is_admin 门禁，读操作漏了，属权限矩阵不对称。
     产品口径：**备份是管理员职能**（与恢复、成员管理同一档）。 */
  export(me) {
    if (!me.is_admin) throw fail('只有管理员可以导出备份，请联系家庭管理员操作', 403);
    return exportAll();
  },
  restore(me, payload) {
    if (!me.is_admin) throw fail('只有管理员可以执行恢复操作', 403);
    const stats = importAll(payload);
    return stats;
  },
};

/* ── 版块红点（v1.9.0） ─────────────────────────────────────

   红点语义 = 「我在这个版块里看过之后，**别人**又更新了内容」。
   与微信朋友圈一致：自己发的东西不会给自己亮红点。

   ★ 两个「最新时间」都必须**先过可见性过滤**再取，否则会出现
     「红点一直亮着、点进去却什么都没有」的鬼影（被别人的私密内容点亮了）。
   ★ 存在服务端（不是 localStorage）是为了多设备一致：手机上点开了，电脑上也不再亮。
*/

const SEEN_KINDS = ['todo', 'post', 'record', 'bill'];

/** 各版块里「别人」最新的更新时间（我自己的改动不计入） */
function latestActivity(me) {
  const maxOf = (table) => {
    const row = db.get(
      `SELECT MAX(updated_at) AS t FROM ${table} WHERE ${VISIBLE} AND user_id != ?`,
      [me.id, me.id],
    );
    return (row && row.t) || '';
  };
  const out = { todo: maxOf('todos'), post: maxOf('posts'), record: maxOf('records') };
  /* v4.10.0（差异 #20）：记账 Tab 也有红点。账单表没有 visibility 列（全家共享），
     口径与其他版块一致：只看「别人记的」。 */
  const billRow = db.get('SELECT MAX(updated_at) AS t FROM bills WHERE user_id != ?', [me.id]);
  out.bill = (billRow && billRow.t) || '';
  return out;
}

function loadSeen(me) {
  const out = { todo: '', post: '', record: '', bill: '' };
  for (const r of db.all('SELECT kind, seen_at FROM seen_marks WHERE user_id = ?', [me.id])) {
    if (SEEN_KINDS.indexOf(String(r.kind)) >= 0) out[r.kind] = String(r.seen_at || '');
  }
  return out;
}

const seen = {
  state(me) {
    return { latest: latestActivity(me), seen: loadSeen(me), kinds: SEEN_KINDS };
  },
  mark(me, kind) {
    const k = String(kind == null ? '' : kind);
    if (SEEN_KINDS.indexOf(k) < 0) throw fail('版块名称不正确');
    const at = nowIso();
    db.run(
      `INSERT INTO seen_marks (user_id, kind, seen_at) VALUES (?,?,?)
       ON CONFLICT(user_id, kind) DO UPDATE SET seen_at = excluded.seen_at`,
      [me.id, k, at],
    );
    return { kind: k, seenAt: at };
  },
};

/* ── 系统设置（管理员） ─────────────────────────────────── */

/** 当前生效的系统设置（环境变量默认值 + 管理员在数据库里的覆盖值） */
function getSettings() {
  const rs = reminders.loadRemindSettings();
  return {
    // ★ v1.8.0：站点名称回到「管理员可改」。siteName 是当前生效值，
    //   defaultSiteName 是「恢复默认」要恢复到的那个值（前端不再自己写死字符串）。
    //   familyName 是 v1.6.0 及更早的旧字段名，这里继续回显同一个值，
    //   只为不弄坏可能还在读它的老页面；新代码一律用 siteName。
    siteName: config.siteName,
    defaultSiteName: config.defaultSiteName,
    siteNameMax: config.siteNameMax,
    siteNameCustom: config.siteName !== config.defaultSiteName,
    familyName: config.siteName,
    allowRegister: !!config.allowRegister,
    sessionTtlHours: config.sessionTtlHours,
    // v4.10.0：视频上传上限（后台可配，5-500MB），家庭设置页直接改
    videoMaxMb: config.videoMaxMb,
    remindEnabled: rs.remindEnabled,
    remindDefaultTime: rs.remindDefaultTime,
    // 提前几天提醒（0-5）。0 = 当天。
    remindAdvanceDays: rs.remindAdvanceDays,
    tzOffsetMinutes: rs.tzOffsetMinutes,
    smtpHost: rs.smtpHost,
    smtpPort: rs.smtpPort,
    smtpUser: rs.smtpUser,
    hasSmtpPass: !!rs.smtpPass,          // 授权码不回传，只告知是否已设置
    // v4.12.0：两条推送通道的家庭级总开关（「我的 → 推送配置」）
    pushMailEnabled: config.pushMailEnabled !== false,
    pushWecomEnabled: config.pushWecomEnabled !== false,
    /* v4.24.0 需求 2：飞书 / 钉钉群机器人 —— 总开关 + 配置状态（Webhook 不回传明文） */
    pushFeishuEnabled: config.pushFeishuEnabled !== false,
    pushDingtalkEnabled: config.pushDingtalkEnabled !== false,
    feishuStatus: hookStatus(feishu, feishu.loadConfig()),
    dingtalkStatus: hookStatus(dingtalk, dingtalk.loadConfig()),
    // 家庭内容变更时给其他成员发通知邮件（管理员可关；还可按内容类型细分）
    notifyOnChange: notify.isEnabled(),
    notifyKinds: notify.loadKinds(),
    notifyKindsAll: notify.ALL_KINDS,
    /* v4.14.0 需求 4：「汇总时间」这个选项已经**撤掉**了。
       现在的口径只有两条：
         · 没设免打扰 → 有变更就立刻发（限流 + 3 分钟去重仍在，防轰炸）；
         · 设了免打扰 → 期间攒着，免打扰一结束合并成一封发出去。
       所以这里不再下发 notifyDigestTime；老客户端如果还传这个字段，
       saveSettings 会像 familyName 一样**忽略而不报错**。 */
    notifyQuietStart: rs.notifyQuietStart,
    notifyQuietEnd: rs.notifyQuietEnd,
    /* v4.15.0 需求 8：防轰炸阈值（一分钟最多几封）做成可调项，
       位置在「我的 → 消息推送设置 → 内容通知」的弹窗里。 */
    notifyMaxPerMin: rs.notifyMaxPerMin,
    // 待发队列的可观测信息：看不到队列就会变成「设置成功了但什么都没发生」
    notifyQueue: notify.queueInfo(),
    // 上传上限，界面上直接展示，用户不用去猜「为什么这张传不上去」
    // v4.12.0 需求 2：图片 / 附件上限统一进「家庭设置 → 基础配置」，
    //   值来自 settings 表（upload_image_max_mb / upload_file_max_mb），环境变量只是兜底。
    imageMaxMb: config.imageMaxMb,
    fileMaxMb: config.fileMaxMb,
    // 旧字段名保留（老页面还在读），与新字段同值
    maxUploadMb: config.imageMaxMb,
    maxFileMb: config.fileMaxMb,
    maxVideoMb: config.videoMaxMb,
    postVideoMax: MAX_POST_VIDEOS,
    // 记录本里被删除（隐藏）的分类（v1.6.0）：分类不是独立表，删除分类 = 把该类记录
    // 移到「通用」并把分类名记进这里，之后不再出现在分类条里。
    recordsHiddenCategories: loadHiddenCategories(),
    // 提醒是个到点才动的后台行为，把最近一轮扫描的状态一并返回，问题才看得见
    remindStatus: reminders.getStatus(),
    notifyStatus: notify.getStatus(),
    /* v4.13.0（问题 5）：最近一次主动推送的结果（渠道 / 成功与否 / 错误）。
       放在这里是因为「我的 → 推送配置」只对管理员渲染，而 /api/settings 也只给管理员。 */
    pushLast: push.lastPush(),
    /* v4.21.0 需求 1：六条推送消息模板（生效值 + 系统默认值 + 变量清单 + 是否已自定义）。
       grouped：待办提醒 remind / 内容通知 notify / 记账推送 bill，前端按板块渲染。 */
    msgTemplates: msgTpl.summary(),
  };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_LOOSE_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/** 保存管理员设置：写入 settings 表并立即更新运行配置，重启后仍生效 */
function saveSettings(b) {
  const put = (key, value) => db.run(
    'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
  // ★ v1.6.0 起改名的旧字段 `familyName` 一律忽略（不报错，保持对旧客户端的兼容）：
  //   旧客户端会「保存整份设置」，如果这里认它，就会把老库里的旧名字重新写活。
  //   v1.8.0 的改名走**新字段 `siteName`**。
  if (b.siteName != null) {
    const raw = String(b.siteName);
    const name = config.normalizeSiteName(raw);
    // 全是控制字符（比如只敲了个换行）→ 明确报错，别让它悄悄变成「恢复默认」
    if (raw.trim() && !name) throw fail('站点名称包含不可用的字符，请换一个');
    // 空串 = 恢复默认：写空值而不是把默认名写死进库 ——
    // 这样「默认值」永远只有一个来源（config.defaultSiteName），以后改默认值也能跟着走。
    put('site_name', name);
    config.siteName = name || config.defaultSiteName;
  }
  if (b.allowRegister != null) {
    const on = !!b.allowRegister;
    put('allow_register', on ? '1' : '0');
    config.allowRegister = on;
  }
  if (b.sessionTtlHours != null) {
    const n = Math.round(Number(b.sessionTtlHours));
    if (!(n >= 1 && n <= 8760)) throw fail('免登录有效期需为 1-8760 小时');
    put('session_ttl_hours', String(n));
    config.sessionTtlHours = n;
  }
  /* v4.10.0：视频上传大小上限改到后台可配（需求一.4）。
     settings 键 upload_video_max_mb，范围 5–500MB；运行时缓存进 config.videoMaxMb，
     server.js 的请求体上限按它动态计算 —— 不然后台改大了，请求体还在按启动时的值拦 413。 */
  if (b.videoMaxMb != null) {
    const n = Math.round(Number(b.videoMaxMb));
    if (!(n >= 5 && n <= 500)) throw fail('视频上限需为 5-500 MB');
    put('upload_video_max_mb', String(n));
    config.videoMaxMb = n;
  }
  /* v4.12.0 需求 2：图片 / 附件上限也进基础配置。
     范围刻意收得比视频紧：图片是「前端压缩后的成品」，正常几百 KB，
     允许调到 100MB 只是为了照顾「原图不压缩」的少数场景；附件上限放到 200MB。 */
  if (b.imageMaxMb != null) {
    const n = Math.round(Number(b.imageMaxMb));
    if (!(n >= 1 && n <= 100)) throw fail('图片上限需为 1-100 MB');
    put('upload_image_max_mb', String(n));
    config.imageMaxMb = n;
  }
  if (b.fileMaxMb != null) {
    const n = Math.round(Number(b.fileMaxMb));
    if (!(n >= 1 && n <= 200)) throw fail('附件上限需为 1-200 MB');
    put('upload_file_max_mb', String(n));
    config.fileMaxMb = n;
  }
  /* v4.12.0：「我的 → 推送配置」的两个通道总开关。
     关掉不等于清空配置 —— SMTP / 企微参数仍然留着，重新勾上就恢复，不用重填。 */
  if (b.pushMailEnabled != null) {
    const on = !!b.pushMailEnabled;
    put('push_mail_enabled', on ? '1' : '0');
    config.pushMailEnabled = on;
  }
  if (b.pushWecomEnabled != null) {
    const on = !!b.pushWecomEnabled;
    put('push_wecom_enabled', on ? '1' : '0');
    /* ★ v4.16.0 需求 4：这个勾选框现在是企业微信的**唯一开关**。
       同步写一份旧键 wecom_enabled，一是让回滚到 4.15 的家庭行为一致，
       二是让读旧键的脚本/工具不至于看到两种互相矛盾的状态。 */
    put('wecom_enabled', on ? '1' : '0');
    config.pushWecomEnabled = on;
  }
  /* v4.24.0 需求 2：飞书 / 钉钉群机器人的总开关。关掉不删配置（Webhook 留着，重新勾上就能用）。 */
  if (b.pushFeishuEnabled != null) {
    const on = !!b.pushFeishuEnabled;
    put('push_feishu_enabled', on ? '1' : '0');
    config.pushFeishuEnabled = on;
  }
  if (b.pushDingtalkEnabled != null) {
    const on = !!b.pushDingtalkEnabled;
    put('push_dingtalk_enabled', on ? '1' : '0');
    config.pushDingtalkEnabled = on;
  }
  if (b.remindEnabled != null) {
    put('remind_enabled', b.remindEnabled ? '1' : '0');
  }
  if (b.remindDefaultTime != null) {
    const t = String(b.remindDefaultTime).trim();
    if (!TIME_RE.test(t)) throw fail('默认提醒时间需为 HH:MM 格式');
    put('remind_default_time', t);
  }
  // 提前几天提醒：0-5。只接受整数，超范围直接拒绝而不是静默忽略 ——
  // 「保存成功了但没生效」是上一版最让人困惑的问题，这里宁可报错也不假装成功。
  if (b.remindAdvanceDays != null) {
    const n = Math.round(Number(b.remindAdvanceDays));
    if (!Number.isInteger(n) || n < 0 || n > 5) throw fail('提前提醒天数需为 0-5 之间的整数');
    put('remind_advance_days', String(n));
  }
  /* v4.21.0 需求 1：消息模板。
     · msgTemplates: { todo_remind: { subject, body }, ... } —— 只改传上来的那几条；
     · msgTemplateReset: 'todo_remind' | ['todo_remind', ...] —— 恢复默认（删配置行）。
     校验失败抛的是普通 Error，这里转成 400，前端才能看到具体哪个变量写错了。 */
  if (b.msgTemplates != null) {
    if (typeof b.msgTemplates !== 'object' || Array.isArray(b.msgTemplates)) {
      throw fail('消息模板格式不正确');
    }
    try {
      msgTpl.save(b.msgTemplates);
    } catch (err) {
      throw fail((err && err.message) || '消息模板保存失败');
    }
  }
  if (b.msgTemplateReset != null) {
    msgTpl.reset(b.msgTemplateReset);
  }
  if (b.notifyOnChange != null) {
    put('notify_on_change', b.notifyOnChange ? '1' : '0');
  }
  // 内容变更通知的分项开关：只认识已知类型，其余忽略
  if (b.notifyKinds != null) {
    if (!Array.isArray(b.notifyKinds)) throw fail('通知类型格式不正确');
    const kinds = notify.ALL_KINDS.filter((k) => b.notifyKinds.includes(k));
    put('notify_kinds', kinds.join(','));
  }
  /* v4.14.0 需求 4：「汇总时间」已下线。
     ★ 这里**刻意不报错、也不写库**：老客户端 / 旧页面缓存还会带这个字段，
       回一个 400 会让「保存免打扰时段」跟着整单失败 —— 那是更糟的结果。
       库里的旧值原样留着但没人读，等于自动失效（不设免打扰 = 有变更即发）。 */
  if (b.notifyQuietStart != null) {
    const t = String(b.notifyQuietStart).trim();
    if (t && !TIME_RE.test(t)) throw fail('免打扰开始时间需为 HH:MM 格式（留空表示不启用）');
    put('notify_quiet_start', t);
  }
  if (b.notifyQuietEnd != null) {
    const t = String(b.notifyQuietEnd).trim();
    if (t && !TIME_RE.test(t)) throw fail('免打扰结束时间需为 HH:MM 格式（留空表示不启用）');
    put('notify_quiet_end', t);
  }
  /* v4.15.0 需求 8：内容通知的防轰炸阈值（一分钟最多几封）。
     范围 1–500：太小会把正常通知当轰炸拦掉，太大等于没有防护 —— 两头都拦一下。 */
  if (b.notifyMaxPerMin != null) {
    const n = Math.round(Number(b.notifyMaxPerMin));
    if (!(n >= 1 && n <= 500)) throw fail('防轰炸上限需在 1 ~ 500 封/分钟之间');
    put('notify_max_per_min', String(n));
  }
  if (b.tzOffsetMinutes != null) {
    const n = Math.round(Number(b.tzOffsetMinutes));
    if (!(n >= -720 && n <= 840)) throw fail('时区偏移需在 -720 ~ +840 分钟之间');
    put('tz_offset_minutes', String(n));
  }
  if (b.smtpHost != null) {
    put('smtp_host', String(b.smtpHost).trim().slice(0, 100) || 'smtp.qq.com');
  }
  if (b.smtpPort != null) {
    const n = Math.round(Number(b.smtpPort));
    if (!(n >= 1 && n <= 65535)) throw fail('SMTP 端口需为 1-65535');
    put('smtp_port', String(n));
  }
  if (b.smtpUser != null) {
    const u = String(b.smtpUser).trim().slice(0, 254);
    if (u && !EMAIL_LOOSE_RE.test(u)) throw fail('发件邮箱格式不正确');
    put('smtp_user', u);
  }
  if (b.smtpPass != null && String(b.smtpPass) !== '') {
    put('smtp_pass', String(b.smtpPass).slice(0, 200));
  }
  if (b.clearSmtpPass) put('smtp_pass', '');
  // 返回保存后的完整生效配置（授权码仍不回传）
  return getSettings();
}

/* ── v2.0.0：记账配置 / 通知全局现状 ───────────────────────── */

/**
 * 个人通知设置页需要展示的「全局现状」。
 * ★ 刻意不用 getSettings()：那个是管理员接口，含 smtp_user 等发件凭据。
 *   非管理员只需要知道「全局开了什么」，不需要知道用哪个邮箱发的。
 */
function notifyGlobalSnapshot() {
  const rs = reminders.loadRemindSettings();
  return {
    remindEnabled: rs.remindEnabled,
    remindDefaultTime: rs.remindDefaultTime,
    advanceDays: rs.remindAdvanceDays,
    notifyOnChange: notify.isEnabled(),
    notifyKinds: notify.loadKinds(),
    notifyKindsAll: notify.ALL_KINDS,
    notifyQuietStart: rs.notifyQuietStart,
    notifyQuietEnd: rs.notifyQuietEnd,
    // v4.15.0 需求 8：成员也要能看到「现在的防轰炸上限是多少」（只读展示）
    notifyMaxPerMin: rs.notifyMaxPerMin,
  };
}

/** 记账配置（管理员视角）。**密钥本身永不回传**，只告知「填过没有」+ 尾 4 位便于核对。 */
function billReportsPayload() {
  const rs = bills.loadSettings();
  const cfg = ocr.loadConfig();
  return {
    reportsEnabled: rs.enabled,
    dailyTime: rs.dailyTime,
    // v4.0.0：日报内容 = 当天（same_day）还是第二天发前一天（next_day，默认）
    reportWhen: rs.reportWhen,
    // v4.12.0 需求 5：日报 / 月报是否附带待办（默认勾选），附带的是「报告日的第二天」
    attachTodo: rs.attachTodo,
    attachDayLabel: rs.reportWhen === 'same_day' ? '明日待办' : '今日待办',
    monthlyReport: rs.monthly,
    /* v4.24.0 需求 1：AI 配置改为**通用平台三件套**（接口地址 + API Key + 模型 ID）。
       密钥只回尾号；`legacy` 表示密钥还来自旧键 qwen_api_key（提示管理员换填到新键）。
       ★ 兼容旧字段：hasQwenKey / qwenKeyTail / qwenVlModel 仍下发（老页面缓存还在时显示不错乱），
         但前端已改用新字段。 */
    aiBaseUrl: cfg.baseUrl,
    aiChatUrl: cfg.chatUrl,
    aiLegacy: !!cfg.legacy,
    hasAiKey: !!cfg.apiKey,
    aiKeyTail: cfg.apiKey ? cfg.apiKey.slice(-4) : '',
    aiVlModel: cfg.vlModel,
    aiDefaultModel: cfg.defaultModel,
    aiModels: ocr.modelPresets(),
    hasQwenKey: !!cfg.apiKey,
    qwenKeyTail: cfg.apiKey ? cfg.apiKey.slice(-4) : '',
    qwenVlModel: cfg.vlModel,
    // v4.0.0：AI 总开关 + 月度额度上限（额度告警用）
    aiEnabled: cfg.enabled,
    aiMonthlyLimit: ocr.monthlyLimit(),
    // v4.17.0 需求 5：自动识别分类规则（「记账分类与预算」里编辑）
    catRules: bills.loadCatRules(),
    // v4.18.0 需求 2：内置规则原文 —— 设置框没存过自定义规则时预置显示它，「恢复默认」也还原成它
    catRulesBuiltin: bills.builtinRulesText(),
    /* ★ v4.3.0 需求 1：**不再自动获取模型列表**。
       这里只回静态预设（跨平台示例项）+ 当前模型的信息（价格 / 视觉可用性提示），
       模型 ID 由管理员自由填写 —— 任何平台上了新模型都不用等我们改代码。 */
    models: ocr.modelPresets(),
    currentModel: ocr.modelInfo(cfg.vlModel),
    ocr: ocr.usageInfo(),
    status: bills.getStatus(),
  };
}

/**
 * 保存记账配置。只认已知字段 —— 非法值一律报错，不静默忽略
 * （「保存成功了但没生效」是这个项目最忌讳的问题）。
 *
 * v4.3.0 需求 1：新增一批 AI 参数（思考模式 / 输出上限 / 温度 / 超时 / 重试 /
 *   自愈 / 分类模式 / 图片压缩）—— 「凡能提升使用体验、需要用户配置的参数都开放」。
 *   模型 ID 允许自由填（只校验字符集）；名字看着不像视觉模型时**只提示不拦截**
 *   （v4.2.0 的硬拒会挡住用户填新模型的自由）。
 */
function saveBillSettings(b) {
  const put = (key, value) => db.run(
    'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
  /** 数值型配置：范围外直接报错（不静默存坏值，免得下次读出来莫名其妙被回落默认） */
  const putNum = (key, raw, min, max, label, int) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) {
      throw fail(`「${label}」需要是 ${min}–${max} 之间的${int ? '整数' : '数值'}`);
    }
    put(key, String(int ? Math.round(n) : n));
  };
  if (b.reportsEnabled != null) put('bill_reports_enabled', b.reportsEnabled ? '1' : '0');
  if (b.monthlyReport != null) put('bill_monthly_report', b.monthlyReport ? '1' : '0');
  if (b.reportWhen != null) {
    const v = String(b.reportWhen) === 'same_day' ? 'same_day' : 'next_day';
    put('bill_report_when', v);
  }
  /* v4.12.0 需求 5：是否附带待办（默认勾选）。
     附带哪一天不单独配 —— 由日报口径推出「报告日的第二天」：
       当天发当天 → 明日；第二天发前一天 → 今日。 */
  if (b.attachTodo != null) {
    put('bill_report_attach_todo', b.attachTodo ? '1' : '0');
  }
  /* —— v4.17.0 需求 5：用户自维护的「关键词 → 分类」规则 ——
     前端传 textarea 原文或数组都行（parseCatRules 两种都认）；
     格式错误直接 400，绝不把坏规则存进库。 */
  if (b.catRules != null) {
    try {
      put('bill_cat_rules', JSON.stringify(bills.saveCatRules(b.catRules)));
    } catch (err) {
      throw fail(err && err.message ? err.message : '分类规则格式不正确');
    }
  }
  // 旧字段兼容（off / today / next）：旧客户端仍可能传，翻译成新开关，不再写旧键
  if (b.reportTodo != null) {
    const v = String(b.reportTodo);
    if (!['off', 'today', 'next'].includes(v)) throw fail('「附带待办」只能是：不附带 / 今日 / 次日');
    put('bill_report_attach_todo', v === 'off' ? '0' : '1');
  }
  if (b.dailyTime != null) {
    const t = String(b.dailyTime).trim();
    if (!TIME_RE.test(t)) throw fail('日报推送时间需为 HH:MM 格式（例如 21:00）');
    put('bill_daily_time', t);
  }
  /* —— v4.0.0：AI 总开关 + 月度额度上限 —— */
  if (b.aiEnabled != null) put('ai_enabled', b.aiEnabled ? '1' : '0');
  if (b.aiMonthlyLimit != null) {
    const n = Math.round(Number(b.aiMonthlyLimit));
    if (!Number.isFinite(n) || n < 1 || n > 1000000) throw fail('AI 月度额度需为 1–1000000 的整数');
    put('ai_monthly_limit', String(n));
  }
  /* —— v4.3.0 需求 1：性能与体验参数（全部可选，传了才改） ——
     v4.25.0 需求 3：**思考模式 / 思考预算 / 最大输出 / 采样温度** 四项已下线。
     老客户端（含浏览器缓存的旧页面）仍可能把这四个字段带上来 —— 按项目规矩
     「先停读、再停校验」：这里**静默忽略**（不写库、也不报 400），
     老页面点保存不会整单失败，只是这四项不再生效。 */
  if (b.aiTimeoutMs != null) putNum('ai_timeout_ms', b.aiTimeoutMs, 5000, 300000, '请求超时（毫秒）', true);
  if (b.aiRetry != null) putNum('ai_retry', b.aiRetry, 0, 3, '失败重试次数', true);
  if (b.aiFallback != null) put('ai_fallback', b.aiFallback ? '1' : '0');
  if (b.aiCategoryMode != null) put('ai_category_mode', String(b.aiCategoryMode) === 'strict' ? 'strict' : 'auto');
  if (b.aiImgCompress != null) put('ai_img_compress', b.aiImgCompress ? '1' : '0');
  if (b.aiImgEdge != null) putNum('ai_img_edge', b.aiImgEdge, 640, 2400, '图片长边像素', true);
  if (b.aiImgQuality != null) putNum('ai_img_quality', b.aiImgQuality, 0.4, 0.95, '图片质量（0.4–0.95）', false);
  if (b.aiImgKb != null) putNum('ai_img_kb', b.aiImgKb, 200, 4000, '图片目标体积（KB）', true);
  /* —— v4.3.1 需求 4：提示词可配（少喂上下文 + 允许整段自定义，都是为提速） —— */
  if (b.aiCatHint != null) putNum('ai_cat_hint', b.aiCatHint, 0, 40, '提示词里列出的现有分类条数', true);
  if (b.aiPromptCustom != null) {
    const s = String(b.aiPromptCustom).trim();
    if (s.length > 2000) throw fail('自定义提示词最多 2000 个字符');
    /* ★ v4.3.2 需求 2：填进来的如果就是**内置默认模板原文**，落库存空串。
       设置页现在会预填默认内容，用户很可能一个字没改就点保存；
       若原样写进库，它就被固化成「自定义」了 —— 以后升级内置提示词，这个家庭
       永远拿不到新版（而他们从没打算自定义）。
       归一放在服务端而不是前端：「什么算默认」只应该有**一处**实现
       （ocr.DEFAULT_PROMPT），前端只负责把框里的内容如实提交。 */
    put('ai_prompt_custom', s && s !== ocr.DEFAULT_PROMPT.trim() ? s : '');
  }

  /* —— v4.24.0 需求 1：AI 通用平台配置（接口地址 + API Key + 模型 ID） ——
     ★ 兼容旧字段：老页面缓存可能还在提交 qwenKey / qwenVlModel / clearQwen，
       统一映射到新键（qwen_api_key 不再写入，避免同一份密钥存两处漂移）。 */
  let warning = '';
  const inKey = b.aiKey != null ? b.aiKey : b.qwenKey;
  if (inKey != null) put('ai_api_key', String(inKey).trim().slice(0, 200));
  if (b.aiBaseUrl != null) {
    const u = String(b.aiBaseUrl).trim().slice(0, 300);
    if (u && !/^https?:\/\/.+/i.test(u)) throw fail('接口地址要以 http(s):// 开头（OpenAI 兼容端点，例如 https://api.openai.com/v1）');
    put('ai_base_url', u);
  }
  const inModel = b.aiVlModel != null ? b.aiVlModel : b.qwenVlModel;
  if (inModel != null) {
    const v = String(inModel).trim();
    if (v && !ocr.MODEL_RE.test(v)) throw fail('模型名不正确（只允许字母数字 . _ - ，2–64 位）');
    /* v4.3.0：不再硬拒非视觉模型 —— 用户要能自由填。
       只在「名字明显不像视觉模型」时给一句提示，免得填错了要等上传才发现。 */
    if (v && !ocr.looksVision(v)) {
      warning = `配置已保存。提示：「${v}」的名字看起来不像视觉模型，`
        + '若上传后识别失败，请改用带 vl / vision 的模型。';
    }
    put('ai_vl_model', v);
  }
  if (b.clearAiKey === true || b.clearQwen === true) put('ai_api_key', '');
  const payload = billReportsPayload();
  return warning ? { ...payload, warning } : payload;
}

/* ════════════════════════════════════════════════════════════
   v4.5.0 需求 5：企业微信自建应用 —— 一句话记账 + 报表推送
   ────────────────────────────────────────────────────────────
   协议层（验签 / 加解密 / 发消息）全在 src/wecom.js，这里只做业务编排：
   把「谁发的」映射成家庭账号、把文本丢给 bills.chatRecord、把结果回一段话。

   ★ 为什么回调不走 api.handle：企业微信的请求体是 **XML**，而 server.js
     的通用流程会把它当 JSON 解析并直接 400。所以 server.js 里给
     /api/wecom/callback 单独开了一个前置分支（同样在 BASE_PATH 剥离之后）。
   ════════════════════════════════════════════════════════════ */

/* 企业微信 5 秒内没收到应答就会重发同一条消息。重发会记成两笔账 ——
   所以按 MsgId 去重，窗口 10 分钟，最多留 300 条（内存即可，重启丢了顶多重复提示一次）。 */
const WECOM_SEEN_MAX = 300;
const wecomSeen = new Map();

function wecomSeenBefore(msgId) {
  if (!msgId) return false;
  const now = Date.now();
  for (const [k, t] of wecomSeen) {
    if (now - t > 10 * 60 * 1000) wecomSeen.delete(k);
  }
  if (wecomSeen.has(msgId)) return true;
  wecomSeen.set(msgId, now);
  while (wecomSeen.size > WECOM_SEEN_MAX) {
    const oldest = wecomSeen.keys().next().value;
    wecomSeen.delete(oldest);
  }
  return false;
}

/* 「需要用户再回一句话」的挂起态。企业微信里没有弹窗，凡是二次确认都得这么办：
     · kind='bill' —— 刚记过一笔同金额，问「继续 / 取消」（2 分钟，短一点更符合直觉）
     · kind='ocr'  —— 发图识别出账单，问「确认入账 / 取消」（10 分钟，人要抬头核对截图）
   超时后用户再发一句话就是新的操作，不会被旧状态绑住。 */
const WECOM_PENDING_TTL = 2 * 60 * 1000;
const WECOM_OCR_TTL = 10 * 60 * 1000;
const wecomPending = new Map();

/* ★ v4.7.0 需求 1：企业微信“被动回复”有 **5 秒硬限制**，超时它会直接断开连接
   （用户那边什么也收不到）并**重投同一条消息**。文字记账是纯本地解析、毫秒级返回，
   所以 v4.5.0 一直没暴露；但发图入账要先 downloadMedia 再调 AI 识别，通常 3–15 秒，
   必然超时 —— 结果是：token 已经扣了，用户却一个字都没收到；更糟的是那条重投
   会被 MsgId 去重判成“重复投递” → 静默空响应，于是永远等不到回复。
   修法：图片消息**立即应答**（远小于 5 秒），识别完成后用**主动发消息**接口把结果推给他。
   wecomJobs 让测试能等这些后台任务跑完（生产不需要）。 */
const wecomJobs = new Set();

function wecomTrack(p) {
  const job = Promise.resolve(p)
    .catch((err) => console.error('[wecom] 后台识别任务失败', err))
    .finally(() => wecomJobs.delete(job));
  wecomJobs.add(job);
  return job;
}

/** 等所有后台识别任务结束（仅供测试；空转时立即返回） */
async function wecomJobIdle() {
  while (wecomJobs.size) await Promise.all([...wecomJobs]);
  return true;
}

/** 主动给某个人发一条消息。
    注意不能用 `pushText` —— 那个受「报表推送」开关管，而对话回复不该被报表开关拦住。 */
async function wecomSendTo(toUser, text) {
  const cfg = wecom.loadConfig();
  if (!wecom.isReady(cfg)) return { ok: false, error: '企业微信未配置完整' };
  return wecom.sendText(cfg, { toUser, content: text });
}

const money2 = (cents) => (Math.round(Number(cents) || 0) / 100).toFixed(2);

const WECOM_HELP = [
  '我在。这些事都能直接说：',
  '',
  '【记一笔】',
  '　今天买菜 30 元　｜　昨天打车 26　｜　这个月房租 3500',
  '　如果这笔今天已经记过一次，我会先提醒你：',
  '　　回 1 照记　｜　回 2 先存草稿　｜　回 3 放弃',
  '　存下的草稿到网页端「记账 → 明细 → 微信草稿箱」修改后提交。',
  '',
  '【发截图入账】',
  '　把账单 / 支付截图发过来 → 我先列出来，你回数字挑着记：',
  '　　0 全部入账　｜　1 3 只记第 1、3 笔　｜　1-3 记这三笔　｜　除了2 除了第 2 笔',
  '　　8 先存草稿箱　｜　9 放弃这次识别（10 分钟内有效）',
  '',
  '【看今天的事】',
  '　发「今日待办」或直接发「待办」，我会列出你今天的事项。',
  '',
  '【加待办】',
  '　待办 明天 10:00 交材料 每 30 分钟催一次',
  '　（催 1–60 分钟都行；不写就是普通待办，只发提醒）',
  '',
  '【做完了】',
  '　回「已完成」，我会把它标记完成并停止催促。',
  '　还没做完回「还没做 / 稍后」，我过个周期再催；不想被催了回「别再催了」。',
  '',
  '发「帮助」随时看这段说明。',
].join('\n');

/* ── v4.16.0 需求 4：企业微信里的「记到谁名下」只看账号映射 ──
   旧版有三层回落（映射 → 默认记账账号 → 第一个管理员）。第三层尤其危险：
   任何一个没映射的人发一句话，都会悄悄记到管理员头上，事后只能靠翻明细发现。
   现在只认映射：查不到就明确回一句，并把他的 UserID 直接告诉他，
   让他复制给管理员加一行就行 —— 既不记错账，也不用他猜自己叫什么。 */
function wecomUserOf(fromUser, cfg) {
  const mapped = wecom.userMapOf(cfg).get(String(fromUser || ''));
  if (!mapped) return null;
  const row = db.get(
    'SELECT id, username, display_name, is_admin FROM users WHERE username = ?',
    [String(mapped).replace(/^@/, '')],
  );
  if (!row) return null;
  return {
    id: row.id, username: row.username, display_name: row.display_name, is_admin: !!row.is_admin,
  };
}

/** 从 chatRecord 的结果里取出「该回给人看的那句话」 */
function wecomReplyOf(res) {
  const sys = (res && Array.isArray(res.chat) ? res.chat : [])
    .filter((c) => c && c.role === 'system')
    .map((c) => String(c.text || '').trim())
    .filter(Boolean);
  return sys.join('\n');
}

/* ── 待办一句话解析（v4.6.0 需求 3）──────────────────────
   典型写法：「待办 明天 10:00 交材料 每30分钟催一次」
   刻意只认有限的几种说法（日期 / 时间 / 催促频率），剩下的全部当标题 ——
   识别不出来就老老实实当标题，绝不猜出一个「差不多」的日期。 */
const CN_WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
const REL_DAYS = { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3 };

function shiftDateKey(key, days) {
  const [y, m, d] = String(key).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + Number(days || 0) * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}

/**
 * @returns {{title:string, date:string, startTime:string, urgeMinutes:number}}
 */
function wecomParseTodo(raw, todayKey) {
  let s = ` ${String(raw || '')} `;
  // 去掉「待办 / 提醒我」这类前缀，剩下的才是内容
  s = s.replace(/^\s*(新建待办|添加待办|加个待办|待办|提醒我|todo)\s*[:：,，]?\s*/i, ' ');
  if (!s.trim()) return null;

  // ① 催促频率。「每 30 分钟催一次」「催 30 分钟」「30 分钟一催」都认；只说「催」不给数字 → 30 分钟
  let urgeMinutes = 0;
  const mu = /每\s*(\d{1,3})\s*分钟\s*(?:催|提醒)(?:一次|1次)?|催\s*(\d{1,3})\s*分钟|(\d{1,3})\s*分钟\s*一?催/.exec(s);
  if (mu) {
    const n = Number(mu[1] || mu[2] || mu[3]) || 0;
    urgeMinutes = n > 0 ? Math.min(60, Math.max(1, n)) : 0;
    s = s.replace(mu[0], ' ');
  } else if (/(催|催办|催促)/.test(s)) {
    urgeMinutes = 30;                                  // 说了要催但没给频率 → 默认半小时
    s = s.replace(/每?天?催(办|促)?(我)?(一下)?/g, ' ');
  }

  // ② 日期：相对日 → 周几 → 具体日期，都没有就落在今天
  let date = todayKey;
  const rel = /(大后天|后天|明天|明日|今天|今日)/.exec(s);
  if (rel) {
    date = shiftDateKey(todayKey, REL_DAYS[rel[1]] || 0);
    s = s.replace(rel[0], ' ');
  } else {
    const wk = /(下)?(?:周|星期|礼拜)([一二三四五六日天])/.exec(s);
    if (wk) {
      const target = CN_WEEKDAY[wk[2]];
      const base = new Date(`${todayKey}T00:00:00Z`).getUTCDay();
      let diff = (target - base + 7) % 7;
      if (diff === 0) diff = 7;                        // 今天就是周三还说「周三」→ 指下周三
      if (wk[1]) diff += 7;                            // 「下周三」
      date = shiftDateKey(todayKey, diff);
      s = s.replace(wk[0], ' ');
    } else {
      const abs = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?/.exec(s)
        || /(\d{1,2})[月/-](\d{1,2})日?/.exec(s);
      if (abs) {
        const hasYear = abs.length > 3 && abs[1] && String(abs[1]).length === 4;
        const y = hasYear ? Number(abs[1]) : Number(String(todayKey).slice(0, 4));
        const mo = hasYear ? Number(abs[2]) : Number(abs[1]);
        const dd = hasYear ? Number(abs[3]) : Number(abs[2]);
        if (mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31) {
          const p = (n) => String(n).padStart(2, '0');
          date = `${y}-${p(mo)}-${p(dd)}`;
          s = s.replace(abs[0], ' ');
        }
      }
    }
  }

  // ③ 时间：10:00 / 10：00 / 10点 / 10点30
  let startTime = '';
  const tm = /(\d{1,2})\s*[:：点]\s*(\d{1,2})?/.exec(s);
  if (tm) {
    const h = Number(tm[1]);
    const mi = Number(tm[2] || 0);
    if (h >= 0 && h <= 23 && mi >= 0 && mi <= 59) {
      startTime = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
      s = s.replace(tm[0], ' ');
    }
  }

  const title = s.replace(/[,，。;；:：]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!title) return null;
  return { title: title.slice(0, 100), date, startTime, urgeMinutes };
}

/** 企业微信「已完成」：把这个人最近一条未完成待办标记完成，并停止催促 */
function wecomCompleteTodo(me) {
  const hit = urge.pickToComplete(me.username);
  if (!hit) return '没有找到未完成的待办（重复事项不需要标记完成，它不会结束）。';
  urge.markDone(hit.id, { via: 'wecom' });
  return `✅ 已把「${hit.title}」标记为完成，催促到此为止。`;
}

/* ── v4.8.0 需求 3：关键词查「今日待办」 ─────────────────────
   ★ 只列**这个人自己的**当天事项。家人的日程不该在企业微信会话里出现 ——
     这与 v4.6.0「催办只发本人、绝不群发全家」是同一条原则。 */

/** 查询指令（整句匹配，避免把「待办 明天交材料」误判成查询） */
const WECOM_TODO_QUERY_RE = new RegExp(
  '^(?:'
  + '今日待办|今天待办|今日事项|今日安排|'
  + '待办查询|查询待办|查看待办|待办列表|我的待办|待办清单|'
  + '今天(?:要|得)?(?:做|干|忙)(?:什么|啥)?|今天有什么事|'
  + 'todo\\s*list|list\\s*todo'
  + ')$', 'i',
);

const WECOM_WEEK = ['日', '一', '二', '三', '四', '五', '六'];

/** 今天有几号、周几 —— 只用于文案，不参与任何日期计算 */
function wecomTodayLabel(todayKey) {
  const [y, m, d] = String(todayKey).split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${m} 月 ${d} 日 周${WECOM_WEEK[wd]}`;
}

/**
 * 「今日待办」的回复文案。
 * 边界：只查**本人** + **今天到期**；已完成的不列（只报个数）；最多列 10 条。
 */
function wecomTodayTodos(me) {
  const todayKey = bills.todayKey();
  const rows = db.all(
    `SELECT * FROM todos WHERE user_id = ? AND todo_date = ?
      ORDER BY (start_time IS NULL OR start_time = '') ASC, start_time ASC, id ASC`,
    [me.id, todayKey],
  );
  const open = rows.filter((r) => !r.done);
  const doneCount = rows.length - open.length;
  if (!rows.length) {
    return [
      `📋 今天（${wecomTodayLabel(todayKey)}）你没有安排待办。`,
      '',
      '想加一条就发：「待办 明天 10:00 交材料 每 30 分钟催一次」',
    ].join('\n');
  }
  if (!open.length) {
    return `📋 今天（${wecomTodayLabel(todayKey)}）的 ${rows.length} 件事都做完了，干净利落。`;
  }
  const lines = open.slice(0, 10).map((r, i) => {
    const mark = r.repeat ? ' 🔁' : '';
    const time = String(r.start_time || '');
    const head = time ? `${time} ` : '全天 ';
    const urge = Number(r.urge_minutes) > 0 ? `（每 ${r.urge_minutes} 分钟催）` : '';
    return `${i + 1}. ${head}${r.title}${mark}${urge}`;
  });
  if (open.length > 10) lines.push(`… 还有 ${open.length - 10} 件`);
  const tail = [
    '',
    `共 ${open.length} 件未完成${doneCount ? `，已完成 ${doneCount} 件` : ''}。`,
    '做完回「已完成」标记；发「待办 …」可以再加一条。',
  ];
  return [`📋 今天（${wecomTodayLabel(todayKey)}）你有 ${open.length} 件事：`, ...lines, ...tail].join('\n');
}

/* ── v4.8.0 需求 2：截图识别后「按序号入账」 ─────────────────
   以前只有「确认 = 全部入账」一条路：一张小票里认错一笔，要么全记（然后手动删）、
   要么全放弃（白识别一次）。现在可以只记自己要的那几笔。 */

/** 把「1 3」「1,3」「第1笔」「1-3」里的序号抽出来（去重升序） */
function wecomPickNumbers(s) {
  const out = new Set();
  let rest = String(s || '');
  // 区间：1-3 / 1~3 / 1到3 / 1至3
  const rangeRe = /(\d{1,3})\s*(?:-|~|到|至)\s*(\d{1,3})/g;
  let m = rangeRe.exec(rest);
  while (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (hi - lo <= 50) for (let i = lo; i <= hi; i++) out.add(i);
    rest = rest.replace(m[0], ' ');
    m = rangeRe.exec(rest);
  }
  for (const d of rest.match(/\d{1,3}/g) || []) out.add(Number(d));
  return [...out].sort((a, b) => a - b);
}

/**
 * 解析一条「选择哪几笔」的指令。
 * @param {string} text 用户回复
 * @param {number} total 这张图识别出几笔
 * @returns {{mode:'all'}|{mode:'pick',picks:number[]}|{mode:'except',picks:number[]}|null}
 *   null = **不像选择指令**，交给后面的记账解析（例如「午饭 32」）。
 */
function wecomParseOcrPick(text, total, loose) {
  const s = String(text || '').trim();
  if (!s) return null;
  // v4.13.0（问题 6）：'0' 是数字菜单里的「全部入账」
  if (/^(0|全部|都记|都要|全记|全选|全要|all|确认|确定|继续|是|y|yes|ok)$/i.test(s)) return { mode: 'all' };
  const except = /^(?:除了|除|不要|去掉|排除|不含|扣掉)\s*([0-9\s,，、和及与\-~到至第笔条号]+)$/.exec(s);
  if (except) {
    const picks = wecomPickNumbers(except[1]);
    return picks.length ? { mode: 'except', picks } : null;
  }
  // 只由数字/分隔符/序数词组成才可能是选择指令
  if (!/^[0-9\s,，、和及与\-~到至第笔条号选记要]+$/.test(s)) return null;
  const nums = wecomPickNumbers(s);
  if (!nums.length) return null;
  /* 「32」这种单个大数字更像金额，不像序号 —— 没有「第/选/记/要/笔」这类明确标记时，
     只要有一个号越界就判定为「不是选择指令」，让它继续走记账解析。
     否则用户在等着确认时顺手记一笔，会被回一句「没有第 32 笔」。
     ★ loose = 已经确定「用户就在确认上下文里」（有挂起的截图）：这时纯数字一律当选择，
       越界由上层回「没有第 N 笔」，绝不悄悄记成一笔 ¥9。 */
  const explicit = /(第|选|记|要|笔|号)/.test(s);
  if (!loose && !explicit && nums.some((n) => n < 1 || n > total)) return null;
  return { mode: 'pick', picks: nums };
}

/**
 * 「这条消息看起来像在按序号挑选吗」—— 只用于**没有挂起**时的边界判断。
 * 判据刻意保守：必须带「第/笔/号/选」这类明确标记，或者是**两个以上**数字/区间。
 * 单个数字（「3」「32」）不算 —— 那是常见的一句话说金额写法。
 */
function wecomLooksLikePick(text) {
  const s = String(text || '').trim();
  if (!/^[0-9\s,，、和及与\-~到至第笔条号选记要]+$/.test(s)) return false;
  if (/(第|笔|号|选)/.test(s)) return true;
  const nums = s.match(/\d{1,3}/g) || [];
  return nums.length >= 2 || /[-~到至]/.test(s);
}

/**
 * 真正入账选中的那几笔。
 * @param {object} [opts]
 *   force=true 跳过「同日疑似重复」检测（用户看过提示后点了继续）
 * @returns {{text:string, keep:boolean, dupItems?:Array}} keep=true 表示「选择无效、挂起状态保留」，
 *   dupItems 非空表示「这些笔被重复检测拦下了」，调用方要把它们挂成 kind='ocrdup' 等用户决定
 */
function wecomCommitOcr(me, pending, text, opts) {
  const force = !!(opts && opts.force);
  const items = (pending && pending.items) || [];
  const pick = wecomParseOcrPick(text, items.length, true);
  if (!pick) {
    return {
      keep: true,
      text: `没看懂要记哪几笔。这张图一共 ${items.length} 笔，回复数字即可：\n`
        + '0　全部入账\n'
        + `1-${items.length}　只记这几笔（如 1 3）\n`
        + '8　先存草稿箱\n9　放弃',
    };
  }
  let idx;
  if (pick.mode === 'all') {
    idx = items.map((_, i) => i);
  } else if (pick.mode === 'except') {
    idx = items.map((_, i) => i).filter((i) => !pick.picks.includes(i + 1));
  } else {
    idx = pick.picks.map((n) => n - 1).filter((i) => i >= 0 && i < items.length);
    const bad = pick.picks.filter((n) => n < 1 || n > items.length);
    if (!idx.length) {
      return {
        keep: true,
        text: `没有第 ${bad.join('、')} 笔 —— 这张图一共 ${items.length} 笔。\n`
          + '回复 0 全部入账、序号选几笔、8 存草稿、9 放弃。',
      };
    }
  }
  if (!idx.length) {
    return { keep: true, text: '这样选完一笔都不剩了。回复 0 全部入账、8 存草稿、9 放弃这次识别。' };
  }

  const done = [];
  const failed = [];
  const dups = [];
  for (const i of idx) {
    const it = items[i];
    /* ★ v4.12.0 需求 1：微信截图入账也要做「重复入账检测」。
       为什么这条比文字那边更要紧：微信里没有明细列表可翻，「同一张小票发两次」
       在网页端能一眼看出来，在微信里只能等月底对账才发现。
       判据与文字路径**完全同一份实现**（bills.findSameDayDuplicate）：
       同一天 + 金额相同或相近（≥¥10 时容差 2%）+ 备注相近。
       命中先不入库，挂成 ocrdup 等用户回「继续」再强记。 */
    if (!force) {
      const dup = bills.findSameDayDuplicate(me, {
        kind: 'expense',
        amountCents: it.amountCents,
        category: it.category,
        note: it.note,
        spentOn: it.dateKey,
      });
      if (dup) { dups.push({ no: i + 1, item: it, dup }); continue; }
    }
    try {
      const row = bills.insertBill(me, {
        kind: 'expense',
        amountCents: it.amountCents,
        category: it.category,
        note: it.note,
        platform: it.platform,
        source: 'ocr',
        channel: 'wecom_image',   // v4.10.0（A9=③）：微信截图入账
        spentOn: it.dateKey,
        raw: '企业微信发图入账',
      });
      done.push({ no: i + 1, amountCents: Number(row.amount_cents || 0), item: it });
    } catch (err) {
      failed.push(`第 ${i + 1} 笔：${(err && err.message) || '入账失败'}`);
    }
  }
  const ignored = items.length - idx.length - dups.length;
  const total = done.reduce((a, b) => a + b.amountCents, 0);
  const picked = done.map((d) => `第 ${d.no} 笔`).join('、');
  const head = done.length
    ? `✅ 已入账 ${done.length} 笔（${picked}），合计 ¥${money2(total)}。`
    : '这几笔都没能入账。';
  const detail = done.slice(0, 10).map((d) => {
    const it = d.item || {};
    return `　· ${it.dateKey || ''} ${it.category || '其他'} ¥${money2(d.amountCents)}${it.note ? ` · ${it.note}` : ''}`;
  });
  const ignoredLine = ignored > 0 ? [`其余 ${ignored} 笔已忽略，不入账。`] : [];
  const failLine = failed.length ? [`\n有 ${failed.length} 笔失败：`, ...failed.slice(0, 5)] : [];
  /* v4.12.0 需求 1：把被拦下的几笔逐条讲清楚「与哪天哪笔像」，用户才判断得了要不要继续 */
  const dupLines = [];
  if (dups.length) {
    dupLines.push('');
    dupLines.push(`⚠️ 有 ${dups.length} 笔可能记过了，先没入账：`);
    for (const d of dups.slice(0, 10)) {
      const o = d.dup || {};
      dupLines.push(`　第 ${d.no} 笔 ¥${money2(d.item.amountCents)}${d.item.note ? `（${d.item.note}）` : ''}`
        + ` ≈ ${o.spentOn || ''} 的 ${o.category || ''} ¥${money2(o.amountCents)}${o.note ? `（${o.note}）` : ''}`);
    }
    dupLines.push('回复数字继续：');
    dupLines.push('1　仍然入账（这几笔）');
    dupLines.push('2　先存草稿箱');
    dupLines.push('3　放弃');
  }
  return {
    keep: false,
    dupItems: dups.length ? dups.map((d) => d.item) : [],
    text: [head, ...detail, ...ignoredLine, ...dupLines, ...failLine].filter(Boolean).join('\n'),
  };
}

/** 企业微信「待办 …」：建一条待办（可选催促完成） */
function wecomCreateTodo(me, text) {
  const parsed = wecomParseTodo(text, bills.todayKey());
  if (!parsed) return { text: '没看懂要建什么待办。试试：「待办 明天 10:00 交材料 每 30 分钟催一次」。' };
  /* v4.18.0 需求 3：一句话建的待办默认「每天提醒」—— repeat=daily，每天到点都推一次；
     没写具体时刻就 start_time 留空，提醒时刻走「消息推送 → 待办提醒」的默认时间
     （reminders 的 remind_default_time 兜底，同一套口径）。
     ★ 说了要催的不重复：重复事项进不了「完成」状态，而催促要靠「回已完成」闭环
       （urge 只扫 repeat=''/repeat_rule='' 的事项），两者互斥 —— 催促按单次事项处理。 */
  const repeat = parsed.urgeMinutes > 0 ? '' : 'daily';
  let todo;
  try {
    todo = todos.create(me, {
      title: parsed.title,
      date: parsed.date,
      startTime: parsed.startTime,
      remind: true,
      repeat,
      urgeMinutes: parsed.urgeMinutes,
      /* v4.22.0 需求 2：一句话建的待办打上来源标记 —— 只进待办列表，
         不占「周期提醒」卡；勾选完成后进「已完成」。 */
      quick: true,
    });
  } catch (err) {
    return { text: `建待办失败：${(err && err.message) || '服务异常'}` };
  }
  const when = [todo.date || '未安排日期', todo.startTime].filter(Boolean).join(' ');
  if (!todo.urgeMinutes) {
    return { text: `✅ 已建待办「${todo.title}」（${when}），每天都会提醒`
      + (todo.startTime ? '' : '（没写时刻，按「消息推送 → 待办提醒」的默认时间发）')
      + `。\n只想提醒一次的话，到网页日历里把这条待办的重复改成「不重复」。` };
  }
  const bound = urge.wecomIdOf(null, me.username);
  return {
    text: `✅ 已建待办「${todo.title}」（${when}）。\n`
      + `到点后每 ${todo.urgeMinutes} 分钟在这里催你一次，做完回「已完成」就停。`
      + (bound ? '' : '\n（提示：你还没绑定企业微信账号，催办消息发不出去 —— 请管理员在「我的 → 企业微信」里把企业微信 UserID 对应到你的家庭账号。）'),
  };
}

/** 发图入账的**同步**前置检查：不需要调 AI 就能判定的情况，直接走被动回复。
    为什么单独抽出来：这些分支一秒都不用等，塞进异步任务反而让用户多收一条「正在识别」。 */
function wecomImageBlocked() {
  const info = ocr.usageInfo();
  if (!info.configured) {
    return '还没配置 AI 服务，发图入账用不了。请管理员在「我的 → AI 参数设置」里填接口地址、API Key 和模型 ID。';
  }
  if (!info.enabled) return 'AI 识别已被管理员关闭，先手动发一句话记账吧。';
  if (info.exhausted) {
    return `本月识别额度已用完（${info.used}/${info.limit}），下个月自动恢复。这期间可以直接发一句话记账。`;
  }
  return '';
}

/** 企业微信「发图入账」的**识别部分**：识别 → 让用户确认 → 才真的入库。
    只负责产出「该回给用户的那段话」，不关心怎么发出去（被动回复还是主动推送）。 */
async function wecomRecognizeImage(msg, me) {
  const blocked = wecomImageBlocked();
  if (blocked) return { text: blocked };
  let media;
  try {
    media = await wecom.downloadMedia(msg.mediaId);
  } catch (err) {
    return { text: `取图片失败：${(err && err.message) || '网络异常'}。可以重新发一次，或直接用一句话记账。` };
  }
  const type = String(media.contentType || '').split(';')[0].trim() || 'image/jpeg';
  if (!/^image\//.test(type)) return { text: '这个附件不是图片，我暂时只认账单截图。' };
  /* v4.12.0 需求 6：企业微信图片与网页端**用同一份规格**判定。
     网页端在 canvas 里按 billParams().image 压到「长边 / 质量 / 目标体积」再上传；
     企业微信发来的是微信客户端压过的原图，服务端零依赖、没有编码器，
     所以这里用同一套参数做同一套判定：超接口上限直接拦（说人话），
     超目标体积/长边则如实提示「这是原图、识别可能稍慢」，不假装两边一模一样。 */
  const params = ocr.billParams();
  const gate = ocr.inspectIncomingImage(media, params.image);
  const bytes = media.buffer.length;
  if (gate.block) return { text: gate.block };
  const dataUrl = `data:${type};base64,${media.buffer.toString('base64')}`;

  let out;
  try {
    const cats = bills.listCategories();
    out = await ocr.recognizeBill(dataUrl, {
      /* ★ 与网页端 `POST /api/bills/ocr` **共用同一份参数集**（v4.8.0 需求 1）。
         模型 / 思考开关 / max_tokens / 超时 / 重试 / 温度 / 分类归一模式 / 提示词
         全部由 `ocr.billParams()` 一处产出，谁都不许在这里写字面量。 */
      ...params,
      todayKey: bills.todayKey(),
      categories: cats.expense,
      userId: me.id,
    });
  } catch (err) {
    return { text: `识别失败：${(err && err.message) || '服务异常'}。可以直接发一句话记账。` };
  }
  const items = (out && out.items) || [];
  if (!items.length) {
    return { text: '这张图里没认出支出金额。可以换一张更清楚的，或直接发一句话记账（比如「今天买菜 30 元」）。' };
  }
  // ★ 识别结果**不入库**，先挂起等确认 —— 截图识别会认错，账目一旦错了比没记更难收拾
  wecomPending.set(msg.fromUser, { kind: 'ocr', items, expireAt: Date.now() + WECOM_OCR_TTL });
  const total = items.reduce((a, b) => a + Number(b.amountCents || 0), 0);
  const lines = items.slice(0, 10).map((it, i) =>
    `${i + 1}. ${it.dateKey} ${it.category || '其他'} ¥${money2(it.amountCents)}${it.note ? ` · ${it.note}` : ''}`);
  if (items.length > 10) lines.push(`… 还有 ${items.length - 10} 笔（回复「全部」才会一起记）`);
  /* v4.8.0 需求 2：把「确认 = 全记」升级成「按序号挑」。
     v4.13.0（问题 6）：改成**数字菜单** —— 用户回一个数字就能完成，
     不用记「确认 / 取消 / 存草稿」这些词。文字说法仍然可用（老用户习惯不变）。 */
  const hint = items.length > 1
    ? [
      '回复数字即可：',
      '0　全部入账',
      `1-${items.length}　只记这几笔（如 1 3 或 1-3）`,
      '8　先存草稿箱（网页端再改）',
      '9　放弃这次识别',
    ].join('\n')
    : ['回复数字即可：', '0　入账', '8　先存草稿箱', '9　放弃'].join('\n');
  const big = (gate.overKb || gate.overEdge) && params.image.compress
    ? `\n（这张图 ${gate.overKb ? `${(bytes / 1024).toFixed(0)}KB、比设置里的目标体积 ${params.image.kb}KB 大` : ''}`
      + `${gate.overKb && gate.overEdge ? '，' : ''}`
      + `${gate.overEdge ? `长边 ${gate.facts.edge}px、比目标 ${params.image.edge}px 大` : ''}；`
      + '企业微信发图是原图直传，识别可能稍慢）'
    : '';
  return {
    text: [
      `📷 识别到 ${items.length} 笔支出，合计 ¥${money2(total)}：`,
      ...lines,
      '',
      hint,
      '（10 分钟内有效）' + big,
    ].join('\n'),
  };
}

/** 真正发出去：识别 → 主动推送给发图的人。
    o.push 可注入（测试用），默认走 sendText；拉长耗时也只影响这条后台任务，不影响回调响应。 */
function wecomHandleImage(msg, me, o) {
  const push = (o && o.push) || wecomSendTo;
  wecomTrack((async () => {
    let out;
    try {
      out = await wecomRecognizeImage(msg, me);
    } catch (err) {
      out = { text: `识别这条截图时出错了：${(err && err.message) || '服务异常'}。可以重发一次，或直接发一句话记账。` };
    }
    const text = out && out.text;
    if (!text) return;
    try {
      await push(msg.fromUser, text);
    } catch (err) {
      console.error('[wecom] 识别结果推送失败（用户这次可能收不到回复）', err);
    }
  })());
}

/**
 * 处理一条已解密的企业微信消息。
 * ★ 必须**在 5 秒内返回**（企业微信被动回复的硬限制），否则这条回复会被丢弃。
 *   凡是耗时操作（发图识别）都必须先应答、再异步主动推送，不能在这里 await。
 * @param {object} msg
 * @param {{push?:Function}} [opts] 仅测试注入用（默认用 sendText 主动发消息）
 * @returns {Promise<{text?:string, silent?:boolean}>}
 */
async function wecomHandleMessage(msg, opts) {
  const o = opts || {};
  const cfg = wecom.loadConfig();
  if (!msg || !msg.fromUser) return { silent: true };
  // AgentID 对不上 = 不是发给这个应用的（同一企业可能配了多个应用共用回调）
  if (msg.agentId && cfg.agentId && String(msg.agentId) !== String(cfg.agentId)) return { silent: true };

  if (msg.msgType === 'event') {
    // 进入应用 / 首次关注：回一段用法，别让人对着空白发愣
    if (msg.event === 'enter_agent' || msg.event === 'subscribe') return { text: WECOM_HELP };
    return { silent: true };
  }
  if (wecomSeenBefore(msg.msgId)) return { silent: true };

  const me = wecomUserOf(msg.fromUser, cfg);
  if (!me) {
    /* v4.16.0 需求 4：没有「默认记账账号」这个兜底了，必须让人知道自己在映射表里叫什么。
       直接把 UserID 回给他 —— 这是他自己的标识，告诉他没有任何风险，
       却省掉「管理员问：你的 UserID 是多少？」这一整轮沟通。 */
    return {
      text: `还没把这个企业微信账号对应到家庭账号。\n`
        + `你的企业微信 UserID 是：${msg.fromUser}\n`
        + '请让管理员在「我的 → 推送渠道设置 → 企业微信推送 → 账号映射」里加一行：\n'
        + `${msg.fromUser}=你的家庭账号\n`
        + '配好后直接再发一次就行。',
    };
  }

  // v4.6.0 需求 2 / v4.7.0 需求 1：图片消息 → 先应答、再异步识别推送
  /* 「没配密钥 / 额度用尽 / AI 关闭」这些**不用调 API 就能判定**的分支必须留在同步路径：
     它们一秒都不用等，塞进后台任务只会让用户白收一条「正在识别」，而 token 也没花，
     反而说不清「为什么有回复却没花额度」。 */
  if (msg.msgType === 'image') {
    const blocked = wecomImageBlocked();
    if (blocked) return { text: blocked };
    // 真正要调 AI 了：立刻应答（远小于 5 秒），识别完再主动推结果
    wecomHandleImage(msg, me, o);
    return {
      text: '📷 收到截图，正在识别，请稍等一下…\n（结果我直接发给你，这条不用回，也不用重发图片）',
    };
  }
  if (msg.msgType !== 'text') {
    return { text: '目前支持：文字记账、发账单截图入账、建待办、回「已完成」。发「帮助」看用法。' };
  }

  let text = String(msg.content || '').trim();
  if (!text) return { text: WECOM_HELP };

  if (/^(帮助|help|\?|？|说明)$/i.test(text)) return { text: WECOM_HELP };

  const pending = wecomPending.get(msg.fromUser);
  const pendingAlive = pending && pending.expireAt > Date.now();

  /* v4.10.0（文档 5.10.6 判定顺序：否定词在完成词**之前**）。
     「还没做 / 等一下 / 稍后」= 不算完成，把正在催的那条计时重置（下个完整间隔后再催）；
     「别再催了」= 停催、不标完成。两句都只在「确实有正在催的待办」时才有意义。 */
  if (/^(还没|还没做|没做|等一下|稍后|等等|先等等)$/i.test(text)) {
    const t = urge.activeUrgeOf(me.username);
    if (!t) return { text: '现在没有在催的待办。要记一笔请直接说（比如「午饭 32」）。' };
    urge.snoozeUrge(t.id, new Date());
    return { text: `好的，「${t.title}」${Number(t.urge_minutes) || 1} 分钟后再提醒。` };
  }
  if (/^(别催了|别再催了|不要催了|停止催促)$/i.test(text)) {
    const t = urge.activeUrgeOf(me.username);
    if (!t) return { text: '现在没有在催的待办。' };
    urge.stopUrgeManual(t.id);
    return { text: `好，「${t.title}」不再催了（待办保持未完成，配置原样保留）。` };
  }

  /* 「已完成」必须排在记账前面：这句话里没有金额，落到记账解析只会得到一句「没看懂」，
     而它恰恰是催办闭环的最后一环（需求 3）。 */
  if (/^(已完成|已做完|做完了?|完成了?|搞定了?|好了|done|finished|ok了)$/i.test(text)) {
    return { text: wecomCompleteTodo(me) };
  }

  /* ── v4.13.0（问题 6）：截图相关的一切都改成「选数字」 ─────────────
     需求原文：「交互尽量以选择数字的方式完成，避免要求用户输入『确认』『撤回』等文字指令」。
     菜单码（只在有挂起时有意义，避免把「8 元」这种正常记账吃掉）：
       ocr     ：0 = 全部入账、1~N = 只记这几笔、8 = 存草稿、9 = 放弃
       ocrdup  ：1 = 仍然入账、2 = 存草稿、3 = 放弃
       dup/bill：1 = 继续记、2 = 存草稿、3 = 放弃
     ★ 必须排在 wecomParseOcrPick **之前** —— 否则「8」会被解析成「第 8 笔」，
       然后回一句「没有第 8 笔」，用户当然会觉得「按提示点数字却没用」。
     ★ 文字说法（继续 / 存草稿 / 取消 / 全部）全部保留：老用户已经记熟了，
       新交互只是**多给一条更省事的路**，不是替换掉既有能力。 */
  if (pendingAlive) {
    const one = /^([0-9]{1,2})$/.exec(text);
    const n = one ? Number(one[1]) : -1;
    if (pending.kind === 'ocr') {
      if (text === '8') text = '存草稿';
      else if (text === '9') text = '取消';
      else if (text === '0') text = '全部';
    } else if (pending.kind === 'ocrdup') {
      if (n === 1) text = '继续';
      else if (n === 2) text = '存草稿';
      else if (n === 3) text = '取消';
    } else if (pending.kind === 'dup' || pending.kind === 'bill') {
      if (n === 1) text = '继续';
      else if (n === 2) text = '存草稿';
      else if (n === 3) text = '取消';
    }
  }

  /* v4.8.0 需求 2：截图识别的「按序号入账」。
     ★ 必须排在「确认/继续」**之前**：「1 3」既不是确认也不是一句账，
       落到最下面的记账解析只会得到一句「没看懂」。
     ★ 也只有「确实像选择指令」时才走这里（wecomParseOcrPick 返回 null 就放行）——
       否则用户在等着确认时顺手记一笔「午饭 32」，会被回一句「没有第 32 笔」。 */
  if (pendingAlive && pending.kind === 'ocr') {
    const pick = wecomParseOcrPick(text, (pending.items || []).length, true);
    if (pick) {
      const r = wecomCommitOcr(me, pending, text);
      if (!r.keep) {
        /* v4.12.0：被重复检测拦下的几笔挂成 ocrdup —— 用户回「继续」就照样入账，
           回「存草稿」存草稿箱，回「取消」放弃。 */
        if (r.dupItems && r.dupItems.length) {
          wecomPending.set(msg.fromUser, { kind: 'ocrdup', items: r.dupItems, expireAt: Date.now() + WECOM_OCR_TTL });
        } else {
          wecomPending.delete(msg.fromUser);
        }
      }
      return { text: r.text };
    }
  }

  if (/^(继续|确认|确定|是|y|yes|ok)$/i.test(text)) {
    if (!pendingAlive) return { text: '没有等待确认的操作，直接说一句话就能记账。' };
    /* v4.12.0 需求 1：截图里被「疑似重复」跳过的那几笔，回「继续」= 用户确认要记，强记。 */
    if (pending.kind === 'ocrdup') {
      wecomPending.delete(msg.fromUser);
      const r = wecomCommitOcr(me, { items: pending.items }, '全部', { force: true });
      return { text: r.text };
    }
    wecomPending.delete(msg.fromUser);
    const res = await bills.chatRecord(me, pending.text, { confirm: true, todayKey: bills.todayKey(), channel: 'wecom_text' });
    return { text: wecomReplyOf(res) || '已记账。' };
  }

  /* v4.9.0 需求 1：微信端「存草稿」—— 挂起中的疑似重复账可以先存后改。
     排在「取消」前面：两个词互不冲突，但存草稿的语义只在有挂起时有意义。 */
  if (/^(存草稿|存为草稿|先存草稿|保存草稿)$/i.test(text)) {
    /* v4.10.0（需求一.1）：截图识别结果也可以整批存草稿 —— 挂起里的每一笔
       各存一条（金额 / 分类 / 日期 / 原话齐备），回网页端逐条确认。
       v4.12.0：ocrdup（被重复检测拦下的那几笔）同样可以存草稿。 */
    if (pendingAlive && (pending.kind === 'ocr' || pending.kind === 'ocrdup')) {
      const items = pending.items || [];
      if (!items.length) {
        wecomPending.delete(msg.fromUser);
        return { text: '这张图没有识别到可存的账目。' };
      }
      let ok = 0;
      for (const it of items) {
        try {
          bills.saveDraftFromParsed(me, {
            kind: 'expense', amountCents: it.amountCents, category: it.category,
            note: it.note, platform: it.platform, dateKey: it.dateKey,
          }, `（截图识别）${it.note || ''}`.trim(), 'wecom');
          ok++;
        } catch { /* 单笔失败不拖累其余笔 */ }
      }
      wecomPending.delete(msg.fromUser);
      return {
        text: `已把识别出的 ${ok} 笔存为草稿。\n`
          + '到网页端「记账 → 明细」的「微信草稿箱」里逐条修改并确认提交。',
      };
    }
    if (!pendingAlive || (pending.kind !== 'dup' && pending.kind !== 'bill')) {
      return { text: '没有可以存草稿的操作。\n直接说一句话就能记账；如果提示「可能记过了」，回 2 就先存着。' };
    }
    const d = bills.saveDraftFromParsed(me, pending.parsed, pending.text, 'wecom');
    wecomPending.delete(msg.fromUser);
    return {
      text: `已存为草稿：${d.spentOn} ${d.category} ¥${money2(d.amountCents)}${d.note ? `（${d.note}）` : ''}。\n`
        + '到网页端「记账 → 明细」的「微信草稿箱」里修改并确认提交。',
    };
  }

  if (/^(取消|算了|不记了|n|no|cancel)$/i.test(text)) {
    wecomPending.delete(msg.fromUser);
    if (!pendingAlive) return { text: '没有等待确认的操作。' };
    return { text: pending.kind === 'ocr' ? '好的，这几笔不入账。' : '好的，这笔不记了。' };
  }

  // v4.8.0 需求 3：查「今日待办」—— 必须排在「建待办」之前，否则「今日待办」会被当成新建
  if (WECOM_TODO_QUERY_RE.test(text)) return { text: wecomTodayTodos(me) };

  /* v4.8.0 需求 2 的配套边界：**没有挂起的截图**时发「1 3」这种纯序号列表，
     不该被当成金额记成账（旧实现会记出一笔「其他 ¥3.00」）。
     单个数字（「3」「32」）仍然按老规矩当金额，避免把常见写法堵死。 */
  if (!pendingAlive && wecomLooksLikePick(text)) {
    return {
      text: '没有等待确认的截图，没法按序号入账。\n'
        + '要记一笔请直接说（比如「午饭 32」）；要发图入账，先把账单截图发给我。',
    };
  }

  // v4.6.0 需求 3：建待办（带可选的催促频率）
  /* ★ 这里**不能**用 \b 收尾：「待办」是中文，\b 只在 \w（字母数字下划线）与其它字符之间成立，
     中文后面接空格根本不算边界 —— 加了 \b 就会永远匹配不上（v4.6.0 实测踩过）。
     v4.8.0：改成「先剥前缀再看有没有内容」—— 只发「待办」两个字时当作查询今日待办，
     有内容才建。这样用户不必记住「新建待办」和「待办」两套说法。 */
  const todoCmd = /^(新建待办|添加待办|加个待办|待办|提醒我|todo)([\s\S]*)$/i.exec(text);
  if (todoCmd) {
    const rest = String(todoCmd[2] || '').replace(/^[\s:：,，]+/, '').trim();
    if (!rest) return { text: wecomTodayTodos(me) };
    return wecomCreateTodo(me, text);
  }

  /* v4.9.0 需求 1：微信端「同日疑似重复」阻塞检测。
     ★ 只解析不入库（parseBillForCheck），解析口径与正式入库完全一致；
     ★ 必须排在记账分支**之前**，且只拦「同一天 + 金额相同/相近 + 备注相近」——
       120 秒防误点仍由 chatRecord 内部管（confirm:true 跳过的就是那一层），
       这一层拦的是「今天已经记过一笔几乎一样的」：微信一句话零确认成本，
       网页上那种「看列表发现记重了」的自我纠错机会在微信里不存在。 */
  const pc = bills.parseBillForCheck(me, text, { todayKey: bills.todayKey() });
  if (pc.ok) {
    const dup = bills.findSameDayDuplicate(me, pc.parsed);
    if (dup) {
      wecomPending.set(msg.fromUser, {
        kind: 'dup', text, parsed: pc.parsed, expireAt: Date.now() + WECOM_PENDING_TTL,
      });
      const mine = money2(pc.parsed.amountCents);
      return {
        text: `⚠️ 这笔可能记过了：${dup.spentOn} ${dup.category} ¥${money2(dup.amountCents)}${dup.note ? `（${dup.note}）` : ''}\n`
          + `你要记的是：¥${mine}${pc.parsed.note ? `（${pc.parsed.note}）` : ''}\n\n`
          + '回复数字：1　照样再记一笔　2　先存草稿箱　3　放弃\n'
          + '（说「继续 / 存草稿 / 取消」也一样）',
      };
    }
  }

  let res;
  try {
    res = await bills.chatRecord(me, text, { confirm: false, todayKey: bills.todayKey(), channel: 'wecom_text' });
  } catch (err) {
    return { text: `记账失败：${(err && err.message) || '服务异常'}，请稍后再试。` };
  }

  if (res && res.needConfirm) {
    wecomPending.set(msg.fromUser, { kind: 'bill', text, parsed: res.parsed, expireAt: Date.now() + WECOM_PENDING_TTL });
    const d = res.duplicate || {};
    const amount = money2(d.amountCents);
    return {
      text: `刚才已经记过一笔 ${d.category || ''} ¥${amount}。\n`
        + '回复数字：1　照样再记一笔　2　先存草稿箱　3　放弃\n'
        + '（说「继续 / 存草稿 / 取消」也一样）',
    };
  }

  const reply = wecomReplyOf(res);
  if (reply) return { text: reply };
  return { text: WECOM_HELP };
}

/**
 * v4.8.0 需求 5：给「本人信息」补一个 push_info（是否绑定企业微信、应用是否可用）。
 * 单独抽出来，是因为 /api/me 下的六个写接口都会回一份 user，漏掉任何一个
 * 都会让前端拿到「没有 push_info」的对象、把界面上的绑定量刷成「未知」。
 */
/**
 * v4.25.0 需求 2：**哪几条通道真的启用着**。
 *
 * 为什么要单独回给前端：以前只有管理员拉得到 /api/settings（里面有开关状态），
 * 成员打开「推送方式」只看到六个选项，不知道哪条能用 —— 选了才知道发不出去。
 * 现在每条通道都带 enabled（家庭开关 + 是否配置齐全）与 ready（本机真的能用），
 * 界面上就能直接标「已启用 / 未启用」。
 */
function pushChannelsOf() {
  /* ★ SMTP 账号密码在 **reminders** 的设置里（不是 bills）—— 写成 bills.loadRemindSettings()
     会抛 TypeError，被 withPushInfo 的 try/catch 静默吞掉，表现为「/api/me 少了 push_channels」，
     而界面只会安静地不显示状态（v4.25.0 踩过一次）。 */
  const rem = reminders.loadRemindSettings();
  const wx = wecom.loadConfig();
  const fsC = feishu.loadConfig();
  const dtC = dingtalk.loadConfig();
  const mailCfg = !!(rem.smtpUser && rem.smtpPass);
  return {
    mail: { enabled: config.pushMailEnabled !== false && mailCfg, ready: config.pushMailEnabled !== false && mailCfg },
    wecom: { enabled: config.pushWecomEnabled !== false && wecom.isReady(wx), ready: wecom.isReady(wx) },
    feishu: { enabled: config.pushFeishuEnabled !== false && feishu.isReady(fsC), ready: feishu.isReady(fsC) },
    dingtalk: { enabled: config.pushDingtalkEnabled !== false && dingtalk.isReady(dtC), ready: dingtalk.isReady(dtC) },
  };
}

function withPushInfo(user) {
  if (!user || !user.id) return user;
  try {
    return { ...user, push_info: push.bindOf(user.id), push_channels: pushChannelsOf() };
  } catch (err) {
    /* 不让 /api/me 因推送状态算错而 500，但**必须留痕**：这里静默过一次，
       现象是「界面不显示通道状态」，查了很久才发现是内部函数名写错（v4.25.0）。 */
    console.warn(`[push] 补充推送信息失败：${err && err.message}`);
    return user;
  }
}

/** 设置页要展示的状态（不含 secret 明文） */
function wecomStatus() {
  const cfg = wecom.loadConfig();
  return {
    /* v4.16.0 需求 4：enabled 来自「推送渠道设置 → 企业微信推送」这一个开关，
       界面上不再有自己的「启用企业微信接入」勾选框。 */
    enabled: cfg.enabled,
    switchOn: cfg.enabled,
    ready: wecom.isReady(cfg),
    corpId: cfg.corpId,
    agentId: cfg.agentId,
    hasSecret: !!cfg.secret,
    token: cfg.token,
    aesKey: cfg.aesKey,
    userMap: cfg.userMap,
    callbackPath: wecom.callbackPath(),
    bondCount: wecom.userMapOf(cfg).size,
    /* v4.24.0 需求 3：可信 IP 代理（开关 + 配置状态；token 不回传明文） */
    proxyEnabled: !!cfg.proxyEnabled,
    proxyUrl: cfg.proxyUrl,
    hasProxyToken: !!cfg.proxyToken,
    proxyReady: !!(cfg.proxyEnabled && cfg.proxyUrl && cfg.proxyToken),
  };
}

/**
 * v4.24.0 需求 2：飞书 / 钉钉群机器人的配置状态（随 /api/settings 下发，也用于 hooks 路由）。
 * Webhook 地址只回「是否已配置 + 掩码」，不回传完整明文 —— 群机器人地址等于「谁都能往群里发消息」的钥匙。
 */
function hookStatus(mod, cfg) {
  const masked = cfg.webhook
    ? `${cfg.webhook.slice(0, Math.min(48, cfg.webhook.length))}${cfg.webhook.length > 48 ? '…' : ''}`
    : '';
  return {
    ready: mod.isReady(cfg),
    enabled: !!cfg.enabled,
    configured: !!cfg.webhook,
    hasSecret: !!cfg.secret,
    webhookMasked: masked,
  };
}

/* ── 路由 ───────────────────────────────────────────────── */

/**
 * @param {{method:string, pathname:string, query:URLSearchParams, body:any, me:object|null, ctx:{isAuthed:boolean}}} req
 * @returns {{status:number, json?:any, file?:string, download?:string}|null}  返回 null 表示未匹配到接口
 */
async function handle({ method, pathname, query, body, me, token, recordsKey, ip }) {
  const seg = pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const [head, second, third] = seg;
  const is = (m) => method === m;

  /* ——— 公开接口：无需登录 ——— */

  if (head === 'config' && is('GET')) {
    return { status: 200, json: {
      // v1.8.0：站点名称可由管理员自定义，公开下发（登录页标题要用，且它不是敏感信息）。
      // familyName 是旧字段名，保留是为了让仍读它的老页面不至于变成空白。
      siteName: config.siteName,
      familyName: config.siteName,
      allowRegister: config.allowRegister,
      hasUsers: auth.userCount() > 0,
      version: config.version,
      // v4.10.0：视频上传上限后台可配（settings.upload_video_max_mb），动态读取
      videoMaxMb: config.videoMaxMb,
      maxVideoMb: config.videoMaxMb,   // 旧字段名保留，前端老逻辑不受影响
      // 上传上限下发给前端：这样「太大了」的提示能在本地就说清楚，
      // 不必等把几 MB 的图传上去再被服务端拒回来。
      // v4.12.0 需求 2：三个上限全部由「家庭设置 → 基础配置」控制，这里是唯一出口。
      imageMaxMb: config.imageMaxMb,
      fileMaxMb: config.fileMaxMb,
      maxUploadMb: config.imageMaxMb,   // 旧字段名保留
      maxFileMb: config.fileMaxMb,
      // v1.9.0：视频上限（比图片大一个量级，前端要据此做本地预检与提示）
      maxVideoMb: config.maxVideoMb,
      /* v2.0.0：记账模块。**只下发「有没有配好」和额度计数，密钥永不出后端**。
         `billOcrQuota.exhausted` 让前端在额度用尽时自动隐藏图片识别入口 ——
         这个判断必须由服务端给，前端自己算不出来。
         注意 /api/config 是**免登录**接口，所以这里刻意不下发分类、预算这些业务数据。 */
      billOcrConfigured: ocr.aiReady(),
      billOcrQuota: ocr.quota(),
      /* v4.3.0 需求 1：上传前的图片压缩参数下发给前端（非敏感 —— 只有压缩力度，
         不含密钥）。这样管理员在设置里调「长边 / 质量 / 目标体积」能立刻生效，
         不必等发版。 */
      billOcrImage: ocr.imagePrefs(),
    } };
  }

  if (head === 'register' && is('POST')) {
    const user = withPushInfo(await auth.register(body || {}));
    return { status: 201, json: { user }, session: { action: 'create', userId: user.id } };
  }

  if (head === 'login' && is('POST')) {
    /* v4.20.0（审查 S-2）：把来源 IP 一起交给 auth.login，用于「失败 5 次锁 10 分钟」的退避。
       被锁时 auth 抛 429，server.js 会原样透传状态码与文案。 */
    const user = withPushInfo(await auth.login(body || {}, ip));
    return { status: 200, json: { user }, session: { action: 'create', userId: user.id } };
  }

  /* ——— 以下全部需要登录 ——— */

  if (head === 'logout' && is('POST')) {
    return { status: 200, json: { ok: true }, session: { action: 'destroy' } };
  }

  if (head === 'me') {
    /* v4.10.0（差异 #42）：「关于与系统状态」——版本 / 最近同步（前端补）/ 数据库状态 / AI 配置状态。
       ★ 必须放在 `is('GET')` 总入口**之前**：那个入口会吃掉所有 head=me 的 GET。 */
    if (is('GET') && second === 'system-status') {
      let dbBytes = 0;
      try { dbBytes = require('node:fs').statSync(db.file).size; } catch { /* 库文件还没落盘时为 0 */ }
      return { status: 200, json: {
        version: config.version,
        dbKind: db.kind,
        journalMode: db.journalMode,
        dbSizeMb: Math.round(dbBytes / 1024 / 1024 * 10) / 10,
        aiConfigured: ocr.aiReady(),
        aiEnabled: (ocr.usageInfo() || {}).enabled !== false,
        serverTime: nowIso(),
      } };
    }
    if (is('GET')) return { status: 200, json: { user: withPushInfo(me) } };
    if (is('POST') && second === 'profile') return { status: 200, json: { user: withPushInfo(auth.updateProfile(me.id, body || {})) } };
    if (is('POST') && second === 'password') {
      await auth.changeOwnPassword(me.id, body || {});
      return { status: 200, json: { ok: true }, session: { action: 'destroy' } };
    }
    if (is('POST') && second === 'records-lock') {
      const row = await auth.setRecordLock(me.id, body || {});
      return { status: 200, json: { user: withPushInfo(auth.sessionUser(row)) } };
    }
    if (is('POST') && second === 'records-unlock') {
      const key = await auth.unlockRecords(token, me.id, (body || {}).password);
      return { status: 200, json: { ok: true, key } };
    }
    if (is('POST') && second === 'notify-email') {
      const user = auth.setNotifyEmail(me.id, (body || {}).email);
      return { status: 200, json: { user: withPushInfo(user) } };
    }
    /* v4.7.0 需求 2：本人主动提醒走哪条通道（auto / mail / both）。
       v4.8.0 起三个值 = 智能（优先企业微信，发不出去回退邮件）/ 只用邮件 / 两条都发。
       放在 me 命名空间下：这是个人偏好，不是家庭设置，普通成员就能改自己的。 */
    if (is('POST') && second === 'push-channel') {
      const user = auth.setPushChannel(me.id, (body || {}).channel);
      return { status: 200, json: { user: withPushInfo(user) } };
    }
    /* v4.11.0：界面主题（forest / paper / ocean）。
       和 push-channel 一样属于「个人偏好」：普通成员就能改自己的，不需要管理员。 */
    if (is('POST') && second === 'theme') {
      const user = auth.setTheme(me.id, (body || {}).theme);
      return { status: 200, json: { user: withPushInfo(user) } };
    }
    // v1.9.0：修改自己的登录账号。需要当前密码 —— 用户名是登录凭据的一半。
    if (is('POST') && second === 'username') {
      return { status: 200, json: { user: withPushInfo(await auth.changeUsername(me.id, body || {})) } };
    }
    // 自定义头像（v1.6.0）：dataUrl 先走图片上传通道，再把路径写到用户上；
    // 传 path:'' 或都不传即恢复默认（昵称首字色块）。
    if (is('POST') && second === 'avatar') {
      const b = body || {};
      if (b.dataUrl) {
        const up = await uploadImage(me, { dataUrl: b.dataUrl });
        return { status: 200, json: { user: withPushInfo(auth.setAvatar(me.id, up.path)) } };
      }
      return { status: 200, json: { user: withPushInfo(auth.setAvatar(me.id, b.path || '')) } };
    }
  }

  if (head === 'settings') {
    if (!me.is_admin) throw fail('只有管理员可以修改系统设置', 403);
    if (is('GET') && !second) return { status: 200, json: { settings: getSettings() } };
    /* v4.23.0 需求 5：推送日志（仅管理员）。
       GET  /api/settings/push-logs?limit=200
       POST /api/settings/push-logs/clear  清空（返回清掉的条数） */
    if (is('GET') && second === 'push-logs') {
      return { status: 200, json: { logs: push.listLogs(query.get('limit')) } };
    }
    if (is('POST') && second === 'push-logs' && third === 'clear') {
      return { status: 200, json: { ok: true, cleared: push.clearLogs() } };
    }
    if (is('POST') && second === 'test-mail') {
      const b = body || {};
      const to = String(b.to || '').trim();
      // 先校验收件地址，避免把非法输入写进配置
      if (!EMAIL_LOOSE_RE.test(to)) throw fail('请填写正确的测试收件邮箱');
      // ★ 关键：把表单里填的发件配置一并保存。
      // 以前只发不存，管理员点了「发送测试」收到邮件就以为配置好了，
      // 实际上待办提醒因为库里没有发件邮箱而永远静默跳过。
      if (b.host != null || b.port != null || b.user != null || (b.pass != null && b.pass !== '')) {
        saveSettings({ smtpHost: b.host, smtpPort: b.port, smtpUser: b.user, smtpPass: b.pass });
      }
      try {
        const out = await reminders.sendTestMail(to);
        push.logOne({ kind: 'test', userId: me.id, name: me.display_name, channel: 'mail', ok: true, subject: '测试邮件', detail: to });
        return { status: 200, json: { ok: true, ...out, settings: getSettings() } };
      } catch (err) {
        push.logOne({ kind: 'test', userId: me.id, name: me.display_name, channel: 'mail', ok: false, subject: '测试邮件', detail: (err && err.message) || String(err) });
        throw err;
      }
    }
    if (is('POST') && second === 'rescan-remind') {
      // 「重新扫描」：把窗口内被误标为已提醒的待办放开，再立刻跑一轮
      const reset = reminders.resetReminders();
      // 顺手把「内容变更通知」的限流窗口也清掉：被「一分钟 20 封」卡住后
      // 本来要干等一分钟，管理端点这个按钮就能立刻恢复。
      // v4.2.0：连续编辑去重窗口同理 —— 清掉后同一条内容的再次编辑会重新提醒。
      notify.resetRateLimit();
      notify.resetDedupe();
      const result = await reminders.runScan();
      return { status: 200, json: { ok: true, reset, result, settings: getSettings() } };
    }
    if (is('POST') && !second) {
      // ★ 提前天数会改变每条待办的「提醒时刻」。改完之后必须把那些在新规则下
      //   时刻还没到、却已经被标记「已提醒」的待办重新放开，否则用户改完设置
      //   到了日期也收不到邮件 —— 表现就是「设置了但没生效」。
      const before = reminders.loadRemindSettings().remindAdvanceDays;
      const settings = saveSettings(body || {});
      const rearmed = settings.remindAdvanceDays !== before ? reminders.rearmFutureReminders() : 0;
      return { status: 200, json: { settings, rearmed } };
    }
  }

  /* v4.5.0 需求 5：企业微信自建应用配置（只有管理员能改）。
     ★ 回调 /api/wecom/callback 不在这里 —— 那是 XML 请求且必须免登录，
       由 server.js 的前置分支处理，见文件顶部的说明。 */
  /* ── v4.24.0 需求 2：飞书 / 钉钉群机器人（仅管理员） ──────────
     GET  /api/hooks            两条通道的配置状态
     POST /api/hooks/feishu     保存飞书配置 { webhook, secret }
     POST /api/hooks/feishu/test 发飞书测试消息
     钉钉同构（/api/hooks/dingtalk）。总开关不在这里 —— 它在 pushFeishuEnabled /
     pushDingtalkEnabled（/api/settings），与邮件 / 企微保持同一套口径。 */
  if (head === 'hooks') {
    if (!me.is_admin) throw fail('只有管理员可以配置飞书 / 钉钉推送', 403);
    const hookOf = second === 'dingtalk' ? dingtalk : second === 'feishu' ? feishu : null;
    if (!hookOf) return { status: 200, json: {
      feishu: hookStatus(feishu, feishu.loadConfig()),
      dingtalk: hookStatus(dingtalk, dingtalk.loadConfig()),
    } };
    if (is('POST') && third === 'test') {
      const out = await hookOf.sendTest();
      if (!out.ok) throw fail(out.errorText || out.error || '发送失败');
      return { status: 200, json: { ok: true, [second]: hookStatus(hookOf, hookOf.loadConfig()) } };
    }
    if (is('POST') && !third) {
      const b = body || {};
      const saved = hookOf.saveConfig(b);
      return { status: 200, json: { [second]: hookStatus(hookOf, saved) } };
    }
  }

  if (head === 'wecom') {
    if (!me.is_admin) throw fail('只有管理员可以配置企业微信', 403);
    if (is('GET') && !second) return { status: 200, json: { wecom: wecomStatus() } };
    if (is('POST') && second === 'test') {
      const out = await wecom.sendTest(String((body || {}).to || '').trim());
      if (!out.ok) throw fail(out.error || '发送失败');
      return { status: 200, json: { ok: true, wecom: wecomStatus() } };
    }
    if (is('POST') && !second) {
      const b = body || {};
      /* secret 走「留空 = 不修改」：GET 从不回传明文，前端保存时那一格自然是空的，
         如果按空串覆盖，管理员每改一次别的字段就会把 Secret 清掉 —— 之后所有
         发送都报「未配置完整」，而且看不出是为什么。 */
      const patch = { ...b };
      if (b.secret == null || String(b.secret).trim() === '') delete patch.secret;
      /* v4.24.0 需求 3：代理 token 同样走「留空 = 不修改」（GET 从不回传明文）。
         关掉代理时（proxyEnabled === false）前端不会提交 token，同样不会误清。 */
      if (b.proxyToken == null || String(b.proxyToken).trim() === '') delete patch.proxyToken;
      /* v4.16.0 需求 4：这里不再有「开启/关闭」这件事 —— 开关在推送渠道设置里，
         保存配置只负责「把五项填对」。配置不齐时不再强行把开关关掉（那会连
         用户刚打开的推送一起吞掉），而是如实回一个 ready=false，界面显示
         「配置不完整」，点「发测试消息」也会给出具体缺哪项。 */
      const saved = wecom.saveConfig(patch);
      return {
        status: 200,
        json: {
          wecom: wecomStatus(),
          ready: wecom.isReady(saved),
          missing: ['corpId', 'agentId', 'secret', 'token', 'aesKey'].filter((k) => !saved[k]),
        },
      };
    }
  }

  if (head === 'members') {
    if (is('GET') && !second) return { status: 200, json: { members: auth.listMembers() } };
    /* v4.10.0：管理员删除成员。前端弹二次确认（window.confirm），这里做服务端兜底：
       不能删自己 / 不能删最后一个管理员。数据随外键级联清除。 */
    if (is('DELETE') && second) {
      return { status: 200, json: auth.deleteMember(me, idOf(second)) };
    }
    if (is('POST') && third === 'reset-password') {
      const target = await auth.adminResetPassword(me, idOf(second), (body || {}).new_password);
      return { status: 200, json: { member: target } };
    }
    // 管理员管理他人的「记录本访问密码」：重置为登录密码 / 直接关闭
    if (is('POST') && third === 'record-lock') {
      const target = auth.adminSetRecordLock(me, idOf(second), (body || {}).action);
      return { status: 200, json: { member: target } };
    }
  }

  if (head === 'todos') {
    // v4.20.0（审查 W-9）：连 total 一起下发，前端才能在超限时明说「仅显示最近 N 条」
    if (is('GET') && !second) return { status: 200, json: todos.listPage(me, { since: query.get('since') }) };
    if (is('POST') && !second) return { status: 201, json: { todo: todos.create(me, body || {}) } };
    if (is('PATCH') && second) return { status: 200, json: { todo: todos.update(me, idOf(second), body || {}) } };
    if (is('DELETE') && second) return { status: 200, json: todos.remove(me, idOf(second)) };
    // v4.20.0（审查 W-9）：结束重复（变回一次性并标记完成）
    if (is('POST') && second && third === 'end-repeat') {
      return { status: 200, json: { todo: todos.endRepeat(me, idOf(second)) } };
    }
    /* v4.21.0 需求 2：勾选 / 取消「重复事项的某一天」（默认今天） */
    if (is('POST') && second && third === 'complete') {
      return { status: 200, json: { todo: todos.completeOccurrence(me, idOf(second), body || {}) } };
    }
    /* v4.10.0（文档 5.10 / 差异清单 #36）：催促流水查询。
       权限：owner 可看任何一条待办的流水；普通成员只能看**自己的**待办的。 */
    if (is('GET') && second === 'nag-logs') {
      const tid = idOf(query.get('todoId'));
      const row = db.get(`SELECT * FROM todos WHERE id = ? AND ${VISIBLE}`, [tid, me.id]);
      if (!row) throw fail('待办不存在或无权访问', 404);
      if (!me.is_admin && row.user_id !== me.id) throw fail('只能查看自己待办的催促日志', 403);
      return { status: 200, json: { logs: urge.nagLogs(tid) } };
    }
  }

  if (head === 'posts') {
    // q = 动态搜索关键词（匹配正文 / 标签 / 作者）
    if (is('GET') && !second) {
      return { status: 200, json: { posts: posts.list(me, query.get('limit'), query.get('q')) } };
    }
    if (is('POST') && !second) return { status: 201, json: { post: posts.create(me, body || {}) } };
    // v1.9.0 动态共创：往某条动态里追加内容（/api/posts/:id/contrib）
    if (is('POST') && second && third === 'contrib') {
      const contribution = contribs.create(me, { ...(body || {}), postId: second });
      return { status: 201, json: { contribution } };
    }
    if (is('PATCH') && second) return { status: 200, json: { post: posts.update(me, idOf(second), body || {}) } };
    if (is('DELETE') && second) return { status: 200, json: posts.remove(me, idOf(second)) };
  }

  // v1.9.0：删除一条共创内容（贡献者本人或动态作者）
  // v4.3.3 需求 5：PATCH 只给内容作者本人（服务端会再校验一次，不依赖前端隐藏按钮）
  if (head === 'contribs') {
    if (is('PATCH') && second) return { status: 200, json: { contribution: contribs.update(me, idOf(second), body || {}) } };
    if (is('DELETE') && second) return { status: 200, json: contribs.remove(me, idOf(second)) };
  }

  // v1.9.0：版块红点。GET 取「各版块最新活动时间 + 我看到哪儿了」，POST 标记某版块已读。
  if (head === 'seen') {
    if (is('GET')) return { status: 200, json: seen.state(me) };
    if (is('POST')) return { status: 200, json: seen.mark(me, (body || {}).kind) };
  }

  if (head === 'comments') {
    if (is('POST') && !second) return { status: 201, json: { comment: comments.create(me, body || {}) } };
    if (is('DELETE') && second) return { status: 200, json: comments.remove(me, idOf(second)) };
  }

  // v4.3.3 需求 1：点赞 / 取消赞（幂等，同一个接口来回切换）
  if (head === 'likes') {
    if (is('POST')) return { status: 200, json: likes.toggle(me, body || {}) };
  }

  if (head === 'records') {
    // 删除分类（v1.6.0）：把该类记录移到「通用」并隐藏该分类
    if (is('POST') && second === 'category' && third === 'delete') {
      return { status: 200, json: records.removeCategory(me, (body || {}).name, recordsKey) };
    }
    if (is('GET') && !second) {
      return { status: 200, json: {
        records: records.list(me, {
          category: query.get('category'),
          q: query.get('q'),
          // v1.9.0 归档筛选：''（默认，只看未归档）/ '1'（只看已归档）/ 'all'（全都看）
          archived: query.get('archived'),
        }, recordsKey),
        // 已删除（隐藏）的分类随列表一起下发，这样「删了分类」对全家人都立即生效，
        // 不必等管理员再进设置页（分类不是独立表，前端要自己把隐藏名单扣掉）
        hiddenCategories: loadHiddenCategories(),
      } };
    }
    if (is('POST') && !second) return { status: 201, json: { record: records.create(me, body || {}, recordsKey) } };
    if (is('PATCH') && second) return { status: 200, json: { record: records.update(me, idOf(second), body || {}, recordsKey) } };
    if (is('DELETE') && second) return { status: 200, json: records.remove(me, idOf(second), recordsKey) };
  }

  /* ── v2.0.0 个人通知偏好 ──────────────────────────────────
     ★ 这组接口**所有登录用户**都能用，不做 is_admin 判断。
       需求原文：「让非管理员用户也能自定义通知，涵盖通知内容与免打扰时间」。
     个人偏好只能「收窄」不能「放大」，所以这里把全局现状一并下发，
     前端才能把「管理员关了」和「我自己关了」分开显示 —— 否则用户会以为
     自己打开的开关生效了，实际被全局关掉的开关压着。 */
  if (head === 'prefs') {
    if (is('GET')) {
      return { status: 200, json: {
        prefs: userprefs.load(me.id),
        keys: userprefs.KEYS,
        kinds: userprefs.ALL_KINDS,
        global: notifyGlobalSnapshot(),
        me: { isAdmin: !!me.is_admin },
      } };
    }
    if (is('POST')) return { status: 200, json: { prefs: userprefs.save(me.id, body || {}) } };
  }

  /* ── v2.0.0 家庭记账 ─────────────────────────────────────── */
  if (head === 'bills') {
    /* — 记账页初始化：一次把要用的都取回来 — */
    if (is('GET') && second === 'bootstrap') {
      const rs = bills.loadSettings();
      return { status: 200, json: {
        categories: bills.listCategories(),
        // 预置分类名单一起下发：前端据此决定「哪些分类可以长按删除」。
        // 写死在前端会和解析器的关键词表脱节，所以由服务端单点提供。
        defaults: bills.defaultCategories(),
        budgets: bills.listBudgets(),
        // v4.0.0：我的快捷短语（需求 2：用户自定义，按人存）
        quick: bills.getQuickPhrases(me),
        // 额度信息必须由服务端给：前端自己算不出「跨月清零」和「AI 是否被停用」
        quota: ocr.usageInfo(),
        ocrConfigured: ocr.aiReady(),
        stats: bills.stats(me, {
          dateKey: query.get('dateKey'), month: query.get('month'),
          from: query.get('from'), to: query.get('to'),
        }),
        // 报表配置只有管理员需要看到（非管理员只是收件人，看推送时间没意义）
        reports: me.is_admin ? billReportsPayload() : null,
      } };
    }

    /* — 统计：个人 / 家庭 × 日 / 月（+ v4.0.0 日期范围） — */
    if (is('GET') && second === 'stats') {
      return { status: 200, json: bills.stats(me, {
        dateKey: query.get('dateKey'), month: query.get('month'),
        from: query.get('from'), to: query.get('to'),
      }) };
    }

    /* — v4.0.0 需求 2：自定义快捷短语（按人，登录即可用） — */
    if (second === 'quick') {
      if (is('GET')) return { status: 200, json: { quick: bills.getQuickPhrases(me) } };
      if (is('POST')) return { status: 200, json: { quick: bills.setQuickPhrases(me, (body || {}).phrases) } };
    }

    /* — v4.9.0 需求 2：记账日历（按天聚合，整月一次拉回） —
       口径与明细列表一致：只看支出、全家共享。month 留空 = 今天所在月。 */
    if (second === 'calendar' && is('GET')) {
      return { status: 200, json: bills.calendar(me, query.get('month')) };
    }

    /* — v4.9.0 需求 1：微信记账草稿箱（服务端） —
       GET    /api/bills/drafts          我的待处理草稿
       POST   /api/bills/drafts          确认提交（body.id 必填；amount/category/note/platform/spentOn 可改）
       DELETE /api/bills/drafts/<id>     删除草稿（已提交的不允许删，那是提交记录）
       ★ 只看 / 只动自己的草稿：草稿是「谁存的谁处理」，与服务端校验双保险。 */
    if (second === 'drafts') {
      if (is('GET') && !third) return { status: 200, json: { drafts: bills.listDrafts(me) } };
      if (is('POST')) {
        const b = body || {};
        const out = bills.submitDraft(me, Number(b.id), {
          amount: b.amount, category: b.category, note: b.note,
          platform: b.platform, spentOn: b.spentOn,
        });
        return { status: 200, json: out };
      }
      if (is('DELETE') && third) return { status: 200, json: bills.deleteDraft(me, Number(third)) };
    }

    /* — v4.0.0 需求 7 / v4.2.0 需求 3：AI 调用日志（管理员） —
       v4.2.0 需求 3：日志默认**只看本月**（`month` 可指定，留空取其当月），
       于是跨月后界面自然清空 —— 这就是「按自然月清零」，历史数据一条不删。
       ★ v4.3.0 需求 1：`ai-models`（一键获取模型列表）路由已**整体移除** ——
         不再由系统自动获取可用模型，模型 ID 由管理员自定义。 */
    if (second === 'ai-logs' && is('GET')) {
      if (!me.is_admin) throw fail('只有管理员可以查看 AI 调用日志', 403);
      const q = String(query.get('month') || '').slice(0, 7);
      const month = /^\d{4}-\d{2}$/.test(q) ? q : ocr.usageInfo().month;
      return { status: 200, json: { logs: ocr.listLogs(query.get('limit'), month), month } };
    }

    /* — 聊天式记账 — */
    if (second === 'chat') {
      if (is('GET')) return { status: 200, json: { chat: bills.chatList(me, query.get('limit')) } };
      if (is('POST')) {
        const text = String((body || {}).text || '').trim().slice(0, 200);
        if (!text) throw fail('请先输入一句话，比如「今天买菜 30 元」');
        // ★ 解析失败也是 201：这是一次成功的「对话」，只是没提取到金额。
        //   返回 400 会让前端把「没听懂」当成接口故障去弹错误提示。
        //   同理，防误点的 needConfirm 也是 201 —— 它同样是「一次成功的对话」。
        //   v4.0.0：聊天气泡随响应带回，由前端存进本地缓存（服务端不再落库）。
        //   ★ v4.2.0 需求 1：一句话记账**完全本地解析**，不接任何 AI 服务 ——
        //     这里不再注入 aiParse（AI 文本解析链路已整体移除）。
        return { status: 201, json: await bills.chatRecord(me, text, {
          confirm: !!(body || {}).confirm,
          todayKey: bills.todayKey(),
        }) };
      }
      if (is('DELETE')) return { status: 200, json: bills.clearChat(me) };
    }

    /* — 收支分类：读全家可见，增删只有管理员 — */
    if (second === 'categories') {
      if (is('GET') && !third) return { status: 200, json: { categories: bills.listCategories() } };
      if (is('POST')) {
        if (!me.is_admin) throw fail('只有管理员可以管理收支分类', 403);
        const b = body || {};
        if (third === 'delete') return { status: 200, json: bills.removeCategory(String(b.kind || ''), b.name) };
        if (!third) return { status: 200, json: { categories: bills.addCategory(String(b.kind || ''), b.name) } };
      }
    }

    /* — 月度预算：读全家可见，改只有管理员 — */
    if (second === 'budgets') {
      if (is('GET')) return { status: 200, json: { budgets: bills.listBudgets() } };
      if (is('POST')) {
        if (!me.is_admin) throw fail('只有管理员可以设置预算', 403);
        const b = body || {};
        return { status: 200, json: { budgets: bills.setBudget(String(b.category || ''), b.amount) } };
      }
    }

    /* — CSV 导出（自选时间范围 + 本人/全家两个维度） — */
    if (is('GET') && second === 'export.csv') {
      const from = String(query.get('from') || '').slice(0, 10);
      const to = String(query.get('to') || '').slice(0, 10);
      const scope = query.get('scope') === 'mine' ? 'mine' : 'all';
      const csv = bills.exportCsv(me, { from, to, scope, kind: query.get('kind') });
      // 文件名只留 ASCII：避免个别浏览器把 Content-Disposition 里的中文显示成乱码，
      // 用户拿到一个「%E8%B4%A6%E5%8D%95.csv」这样的名字。
      const stamp = [from || 'all', to || new Date().toISOString().slice(0, 10)].join('_');
      return { status: 200, text: csv, type: 'text/csv; charset=utf-8', download: `family-bills-${stamp}.csv` };
    }

    /* — AI 截图识别代理。★ 识别结果**不入库**，只回给前端让用户确认 — */
    if (is('POST') && second === 'ocr') {
      const b = body || {};
      const cats = bills.listCategories();
      const out = await ocr.recognizeBill(b.dataUrl, {
        /* ★ v4.8.0 需求 1：与企业微信发图共用**同一份**参数集（`ocr.billParams()`），
           不许在这里写任何参数字面量 —— 两个入口一旦各拼一份，迟早分叉。 */
        ...ocr.billParams(),
        todayKey: bills.todayKey(),
        // v4.3.0 需求 2：分类清单进提示词 + 结果三层归一（只传支出分类，本版只记支出）
        categories: cats.expense,
        // v4.17.0 需求 5：用户自维护的「关键词 → 分类」规则也参与归一与兜底
        rules: bills.loadCatRules(),
        userId: me.id,
      });
      /* 额度预警：只在**恰好跨过预警线**的那一次推一条系统气泡，
         而不是此后每识别一张都推（那会把聊天窗刷满）。
         `out.quota.used` 是包含本次在内的累计值，所以 === warnAt 天然只成立一次。

         v4.2.0 需求 2：模型自愈也要明确告知 —— 静默换模型等于把「配置没生效」
         藏起来，正是本项目最忌讳的事。 */
      let notice = '';
      if (out.fallback) {
        notice = `你选的模型「${out.fallback.from}」不可用（未开通 / 无权限 / 不支持），`
          + `已自动改用「${out.fallback.to}」完成识别，并把设置更新为可用模型。`;
      } else if (out.quota.used === out.quota.warnAt) {
        notice = `提醒：本月 AI 已用 ${out.quota.used}/${out.quota.limit} 次，快到上限了。达到上限后将自动转为手动录入。`;
      }
      const noticeChat = notice ? bills.shapeChat(bills.pushChat(me, 'system', notice)) : null;
      // v4.0.0：聊天不落库，气泡随响应带回前端存本地缓存
      return { status: 200, json: { ...out, notice, ...(noticeChat ? { chat: [noticeChat] } : {}) } };
    }

    /* — 记账配置（管理员）：推送时间 / 月度报表 / OCR 密钥 — */
    if (second === 'settings') {
      if (!me.is_admin) throw fail('只有管理员可以修改记账设置', 403);
      if (is('GET')) return { status: 200, json: { settings: billReportsPayload() } };
      if (is('POST')) return { status: 200, json: { settings: saveBillSettings(body || {}) } };
    }

    /* — 管理员立刻试发一次报表（不等定时器） — */
    if (is('POST') && second === 'report' && third === 'test') {
      if (!me.is_admin) throw fail('只有管理员可以触发报表发送', 403);
      const rs = bills.loadSettings();
      const today = bills.todayKey();
      const out = await bills.sendReports({
        // 默认发「昨天」的日报；月初顺手带上上个月的月报。也可以用 body 指定。
        dateKey: String((body || {}).dateKey || reminders.shiftDateKey(today, -1)).slice(0, 10),
        month: String((body || {}).month || '').slice(0, 7) || undefined,
      });
      return { status: 200, json: { ok: true, ...out, status: bills.getStatus(), dailyTime: rs.dailyTime } };
    }

    /* — 账单增删改查 — */
    if (is('GET') && !second) {
      return { status: 200, json: { bills: bills.list(me, {
        scope: query.get('scope'),
        kind: query.get('kind'),
        category: query.get('category'),
        from: query.get('from'),
        to: query.get('to'),
        q: query.get('q'),
        limit: query.get('limit'),
      }) } };
    }
    // 手动表单记账 / OCR 确认后入库：两条路径都落到这里
    if (is('POST') && !second) {
      const b = body || {};
      const cents = b.amountCents != null ? Math.round(Number(b.amountCents)) : Math.round(Number(b.amount) * 100);
      const row = bills.insertBill(me, {
        kind: b.kind,
        amountCents: cents,
        category: b.category,
        note: b.note,
        platform: b.platform,
        source: b.source === 'ocr' ? 'ocr' : 'text',
        raw: b.raw,
        spentOn: b.spentOn || b.dateKey,
      });
      const alert = bills.checkBudget(row);
      /* v4.3.2 需求 1：入库后比一次「有没有高度相似的旧账」，命中就随响应把那条带回去，
         由前端给一句「可能存在重复入账」的提示 + 一键撤销。
         提示式而非拦截式：这条路径同时服务手动表单与 OCR 确认入账，
         批量识别时连拦几次会把整条流程卡死。 */
      const similar = bills.findSimilarBill(me, {
        kind: row.kind, amountCents: row.amount_cents, category: row.category,
        note: row.note, spentOn: row.spent_on, excludeId: row.id,
      });
      // 记一笔就在聊天窗里留一条系统回复：这既是反馈，也是账目的第二处可见位置。
      // v4.0.0：聊天不落库，气泡随响应带回前端存本地缓存（需求 1）。
      const chatEcho = [bills.shapeChat(bills.pushChat(me, 'system', bills.systemTextFor(row, alert), row.id))];
      return { status: 201, json: { bill: bills.shape(row, me), alert, chat: chatEcho, similar } };
    }
    if (is('PATCH') && second) return { status: 200, json: bills.update(me, idOf(second), body || {}) };
    if (is('DELETE') && second) return { status: 200, json: bills.remove(me, idOf(second)) };
  }

  if (head === 'upload' && is('POST')) {
    return { status: 201, json: await uploadImage(me, body || {}) };
  }

  // 记录本附件上传（PDF / Office / 压缩包等，上限与图片分开）
  if (head === 'upload-file' && is('POST')) {
    return { status: 201, json: await uploadFile(me, body || {}) };
  }

  // 动态视频上传（v1.9.0）：第三条通道，上限比图片、附件都大一个量级
  if (head === 'upload-video' && is('POST')) {
    return { status: 201, json: await uploadVideo(me, body || {}) };
  }

  if (head === 'media' && is('GET') && second) {
    const file = mediaPath(second);
    if (!file) throw fail('图片不存在', 404);
    return { status: 200, file };
  }

  // 附件下载：?name= 是原始文件名，只用于 Content-Disposition，服务端会做清洗
  if (head === 'file' && is('GET') && second) {
    const file = mediaPath(second);
    if (!file) throw fail('附件不存在', 404);
    return { status: 200, file, download: safeDownloadName(query.get('name'), path.extname(file).slice(1)) };
  }

  if (head === 'backup' && is('GET')) {
    return {
      status: 200,
      json: backup.export(me),
      download: `family-hub-backup-${new Date().toISOString().slice(0, 10)}.json`,
    };
  }

  if (head === 'restore' && is('POST')) {
    return { status: 200, json: { restored: backup.restore(me, body) }, session: { action: 'destroy' } };
  }

  return null;
}

/* v4.6.0：wecomParseTodo / WECOM_HELP 一并导出 —— 待办解析是纯函数，
   单测直接喂字符串比「先配企业微信再走整条回调链路」精确得多。 */
module.exports = {
  handle, VISIBLE, wecomHandleMessage, wecomStatus,
  wecomParseTodo, WECOM_HELP,
  // v4.7.0：等后台识别任务结束（测试用）；wecomSendTo 供测试直接主动推送
  wecomJobIdle, wecomSendTo,
  // v4.8.0：序号选择的解析与入账、今日待办文案（都是可直接单测的纯函数）
  wecomParseOcrPick, wecomCommitOcr, wecomTodayTodos, WECOM_TODO_QUERY_RE,
};
