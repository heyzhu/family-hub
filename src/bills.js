'use strict';
/**
 * 家庭记账（v2.0.0）。
 *
 * 需求锚点：
 *   · 聊天式一句话记账（自动提金额 / 猜分类；v2.0.2 起只记支出）
 *   · 百度 OCR 截图记账（后端代理），识别结果**必须用户确认后**才入库
 *   · 个人 / 家庭 × 日 / 月 四个维度的统计
 *   · 账单列表：筛选个人 / 全家、编辑、删除本人账单
 *   · 每日定时邮件推送个人日报 + 家庭日报（时间由管理员设，全员自动接收）
 *   · CSV 导出（自选时间范围、个人 / 全家两个维度）
 *   · 分类与预算由管理员维护；记账后若该分类当月已达预算 → 立刻提醒
 *
 * 权限（与需求文档「四、权限规则」一致）：
 *   · 家庭成员可查看**全部**家庭账单（本表没有 visibility 列，账单本身是全家共享的）
 *   · 用户**只能编辑 / 删除自己**的账单
 *   · 只有管理员能设置推送时间、管理分类与预算
 *
 * 金额一律以「分」存整数，只在出口处换算成元。
 */
const config = require('./config');
const { db } = require('./db');
const reminders = require('./reminders');
const mailer = require('./mailer');
const parse = require('./billparse');
/* v4.5.0 需求 5：日报 / 月报同时推一份到企业微信自建应用。
   ★ 单向依赖（bills → wecom）：wecom 里绝不能 require bills，否则成环。 */
const wecom = require('./wecom');
/* v4.16.0 需求 4：「推给谁」要跟每个人的「推送方式」一致，通道归一只有一处实现（push.normalizeChannel）。
   ★ 依赖方向仍然单向：push 只依赖 db / config / wecom / quiet，不反向 require bills。 */
const push = require('./push');
/* v4.25.0 需求 4：报表要读「记账」这一类各自的推送渠道（个人偏好），批量取用 loadAll。
   userprefs 只依赖 db，不会成环。 */
const userprefs = require('./userprefs');
/* v4.24.0 需求 2：飞书 / 钉钉群机器人 —— 与 wecom 同为「协议层」，不会反向依赖本模块 */
const feishu = require('./feishu');
const dingtalk = require('./dingtalk');
/* v4.21.0 需求 1：报表文案改成家庭级可配置模板（记账推送板块）。
   msgTpl 只依赖 db / config → 不会与 bills 成环。 */
const msgTpl = require('./msgTpl');
/* v4.28.0：日报的待办预告要展开重复事项的落点 —— 与日历、提醒调度共用 repeat.js，
   不在这里再写一份「什么时候该出现」的规则（repeat.js 零依赖，不会成环）。 */
const Repeat = require('../public/repeat.js');

/* ── 设置 ─────────────────────────────────────────────────── */

const SETTINGS_DEFAULTS = {
  bill_reports_enabled: '1',
  // 每天几点推送日报（HH:MM）。
  bill_daily_time: '21:00',
  // v4.0.0：日报内容是「当天」还是「前一天」。'next_day'（默认，历史行为）=
  //   每天 21:00 推送**前一天**的日报；'same_day' = 当天到点就发**当天**的日报。
  bill_report_when: 'next_day',
  // 月初（1 号）同一时刻是否补发上一个自然月的月报
  bill_monthly_report: '1',
  /* v4.12.0 需求 5：日报 / 月报是否附带待办预告。默认**勾选**（'1'）。
     ★ 与旧的 bill_report_todo（off/today/next 三值）并存：
       新键存在就以新键为准；不存在时才按旧键回落（off → 不附带，其余 → 附带）。
       这样老库升级后不会被「默认开」直接改行为，用户改过「不附带」的也不会被强行打开。 */
  bill_report_attach_todo: '1',
  // v4.3.3 需求 3：旧的三值设置（仅作兼容回落，不再写入）
  bill_report_todo: 'today',
  // v3.0.0：百度 OCR 的 AK/SK 换成 AI 平台密钥（v4.24.0 起是通用 OpenAI 兼容三件套）——
  // 一个 API Key + **一个视觉模型**；旧键 qwen_* 仍读出来供平滑迁移，不再写入。
  // 旧键 bill_ocr_ak / bill_ocr_sk / qwen_text_model 留在库里无害
  // （settings 是 key-value，读不到就是默认空串）；v4.2.0 起一句话记账不再用 AI，
  // qwen_text_model 已彻底不再读写。
  qwen_api_key: '',
  qwen_vl_model: '',
  // 幂等：上次发日报的日期键 / 上次发月报的月份键。重启后不会重复发。
  bill_report_last_day: '',
  // v4.3.3 需求 3：**报告覆盖的那一天**（不是「发送的那一天」）。
  // 旧键 last_day 记的是发送日，导致「当天发当天」切换后当天的报告被误判成已发。
  bill_report_last_key: '',
  // 上一次尝试发送的时刻（用于失败后的重试节流，不参与「发过没发过」的判断）
  bill_report_last_try: '',
  bill_report_last_month: '',
  bill_report_last_at: '',
  bill_report_last_result: '',
};
const TIME_RE = reminders.TIME_RE;

function loadSettings() {
  const map = { ...SETTINGS_DEFAULTS };
  const seen = new Set();
  for (const r of db.all('SELECT key, value FROM settings')) {
    if (r.key in map) {
      map[r.key] = String(r.value == null ? '' : r.value);
      seen.add(r.key);
    }
  }
  const tz = Number(config.tzOffsetMinutes);
  return {
    enabled: map.bill_reports_enabled !== '0',
    dailyTime: TIME_RE.test(map.bill_daily_time) ? map.bill_daily_time : '21:00',
    reportWhen: map.bill_report_when === 'same_day' ? 'same_day' : 'next_day',
    monthly: map.bill_monthly_report !== '0',
    /* v4.12.0 需求 5：是否附带待办（默认勾选）。
       新键存在 → 用它；否则按旧三值回落（off = 以前就关了，别擅自打开）。 */
    attachTodo: seen.has('bill_report_attach_todo')
      ? map.bill_report_attach_todo !== '0'
      : map.bill_report_todo !== 'off',
    // v4.24.0：老键读出来只作迁移判断（ocr.loadConfig 自己也读 settings）；不再写入。
    qwenKey: map.qwen_api_key,
    qwenVlModel: map.qwen_vl_model,
    lastDay: map.bill_report_last_day,
    lastKey: map.bill_report_last_key,
    lastTry: map.bill_report_last_try,
    lastMonth: map.bill_report_last_month,
    lastAt: map.bill_report_last_at,
    lastResult: map.bill_report_last_result,
    tzOffsetMinutes: Number.isFinite(tz) ? tz : 480,
  };
}

const putSetting = (key, value) => db.run(
  'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  [key, String(value == null ? '' : value)],
);

/* ── 分类 ─────────────────────────────────────────────────── */

/** 出厂预置分类。首次访问时写进 bill_categories（幂等），之后以库里的为准。 */
function ensureCategories() {
  const rows = db.all('SELECT kind, name FROM bill_categories');
  const have = new Set(rows.map((r) => `${r.kind}:${r.name}`));
  let added = 0;
  for (const kind of ['expense', 'income']) {
    const list = parse.DEFAULT_CATEGORIES[kind];
    list.forEach((name, i) => {
      if (have.has(`${kind}:${name}`)) return;
      db.run('INSERT OR IGNORE INTO bill_categories (kind, name, sort) VALUES (?,?,?)', [kind, name, i]);
      added++;
    });
  }
  return added;
}

/** @returns {{expense:string[], income:string[]}} */
function listCategories() {
  ensureCategories();
  const out = { expense: [], income: [] };
  for (const r of db.all('SELECT kind, name FROM bill_categories ORDER BY kind, sort, id')) {
    if (out[r.kind]) out[r.kind].push(r.name);
  }
  return out;
}

function allCategoryNames(kind) {
  const c = listCategories();
  return c[kind] || [];
}

/** 出厂预置分类（只读副本）。前端用它区分「可删的自定义分类」与「不可删的预置分类」。 */
function defaultCategories() {
  return { expense: parse.DEFAULT_CATEGORIES.expense.slice(), income: parse.DEFAULT_CATEGORIES.income.slice() };
}

/* ── 用户自维护的「关键词 → 分类」规则（v4.17.0 需求 5）──────────
   存 settings.bill_cat_rules（JSON 数组）。一句话记账、OCR 逐行兜底、
   AI 结果归一三处共用同一份；内置关键词表仍然生效，用户规则优先于它。 */

/** 读规则：库里没有 / 坏了都回落 []（坏规则不该把整个记账页打挂） */
function loadCatRules() {
  const row = db.get('SELECT value FROM settings WHERE key = ?', ['bill_cat_rules']);
  if (!row || !String(row.value || '').trim()) return [];
  try {
    return parse.parseCatRules(JSON.parse(String(row.value)));
  } catch { return []; }
}

/** 存规则（api 层负责管理员校验）。返回归一后的数组，供前端回显。 */
function saveCatRules(raw) {
  const rules = parse.parseCatRules(raw == null ? [] : raw);
  putSetting('bill_cat_rules', JSON.stringify(rules));
  return rules;
}

/** 管理员新增分类（v2.0.2 起只有支出分类） */
function addCategory(kind, rawName) {
  const name = String(rawName || '').trim().replace(/[\s,，、]+/g, '').slice(0, 12);
  if (kind !== 'expense') throw fail('现在只记支出，收入分类已下线');
  if (!name) throw fail('请填写分类名称');
  const exists = db.get('SELECT id FROM bill_categories WHERE kind = ? AND name = ?', [kind, name]);
  if (exists) throw fail(`「${name}」已经存在了`);
  const sort = (db.get('SELECT MAX(sort) AS m FROM bill_categories WHERE kind = ?', [kind]) || {}).m;
  db.run('INSERT INTO bill_categories (kind, name, sort) VALUES (?,?,?)', [kind, name, (Number(sort) || 0) + 1]);
  return listCategories();
}

/**
 * 确保支出分类存在（v3.0.0 需求 4：大模型返回的分类自动添加，无需用户手动创建）。
 * 与 addCategory 的区别：这是**系统行为** —— 不要求管理员身份、名字已存在时静默返回；
 * 名字清洗规则与 addCategory 一致（去空白与分隔符、≤12 字）。
 * 收口在 insertBill：文字 / 截图 / 手动三个入口全覆盖。
 * @param {string} rawName
 * @returns {string} 清洗后的分类名（空串表示没建）
 */
function ensureExpenseCategory(rawName) {
  const name = String(rawName || '').trim().replace(/[\s,，、]+/g, '').slice(0, 12);
  if (!name) return '';
  if (allCategoryNames('expense').indexOf(name) >= 0) return name;
  const sort = (db.get('SELECT MAX(sort) AS m FROM bill_categories WHERE kind = ?', ['expense']) || {}).m;
  db.run('INSERT OR IGNORE INTO bill_categories (kind, name, sort) VALUES (?,?,?)',
    ['expense', name, (Number(sort) || 0) + 1]);
  return name;
}

/** 管理员删除分类（v2.0.2 起只有支出分类）。已经记过的账单**不动**（分类是名字快照），只是以后不能再选。 */function removeCategory(kind, rawName) {
  const name = String(rawName || '').trim();
  if (kind !== 'expense') throw fail('现在只记支出，收入分类已下线');
  // 出厂预置分类不允许删。两个原因：
  //   ① 一句话记账靠关键词往这些名字上归类，删了之后「午饭 30」会归到不存在的分类；
  //   ② ensureCategories() 是幂等的自愈逻辑，删掉下一次 listCategories() 又会插回来，
  //      结果只剩「账单被搬到别的分类」这一个副作用，对用户来说纯属惊吓。
  if ((parse.DEFAULT_CATEGORIES[kind] || []).indexOf(name) >= 0) {
    throw fail(`「${name}」是预置分类，不能删除`);
  }
  const cat = listCategories()[kind] || [];
  if (!name || cat.indexOf(name) < 0) throw fail('分类不存在', 404);
  // 至少留一个分类，否则记账界面会没有选项可选
  if (cat.length <= 1) throw fail('至少要保留一个分类');
  const moved = db.run('UPDATE bills SET category = ? WHERE kind = ? AND category = ?', [cat[0], kind, name]).changes;
  db.run('DELETE FROM bill_categories WHERE kind = ? AND name = ?', [kind, name]);
  db.run('DELETE FROM bill_budgets WHERE category = ?', [name]);
  return { categories: listCategories(), moved };
}

/* ── 预算 ─────────────────────────────────────────────────── */

/** @returns {Array<{category:string, amountCents:number}>} */
function listBudgets() {
  return db.all('SELECT category, amount_cents FROM bill_budgets WHERE amount_cents > 0 ORDER BY category')
    .map((r) => ({ category: r.category, amountCents: Number(r.amount_cents) || 0 }));
}

/**
 * 设置某分类的月度预算（传 0 或空表示取消）。
 * ★ 只允许**支出**分类：预算管的是「花销别超」，收入没有「超支」这个概念
 *   （`checkBudget` 也只对 `expense` 生效）。不校验的话，收入分类会往 `bill_budgets`
 *   里留下一条永远不生效的数据 —— 「保存成功了但没作用」是这个项目最忌讳的问题。
 *   注意这里用**分类名**判断，不是名字里有没有「收入」：像「其他」这种两边都有的名字
 *   只要在支出列里存在就允许（预算本来就按名字聚合，收入那边不会被它影响）。
 *   传 0 取消时不校验 —— 用户想清掉一条历史脏数据，不该被拦。
 */
function setBudget(category, yuan) {
  const name = String(category || '').trim();
  if (!name) throw fail('请选择分类');
  const n = Math.round(Number(yuan) * 100);
  if (!Number.isFinite(n) || n < 0) throw fail('预算金额不正确');
  if (n > 0 && !allCategoryNames('expense').includes(name)) throw fail('收入分类不需要设置预算');
  if (n === 0) db.run('DELETE FROM bill_budgets WHERE category = ?', [name]);
  else db.run(
    'INSERT INTO bill_budgets (category, amount_cents) VALUES (?,?) ON CONFLICT(category) DO UPDATE SET amount_cents = excluded.amount_cents',
    [name, n],
  );
  return listBudgets();
}

/* ── 记账 ─────────────────────────────────────────────────── */

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 月份键是否真的合法（`2026-13` 这种形状对、月份不存在的也得拦下来）。
 * ★ 用 monthRange 复用同一套校验，不另外写一遍正则 —— 否则「校验说能过、查询说不能过」，
 *   表现就是切到那个月份时日历整个空掉（而不是回落本月）。
 */
const isMonthKey = (m) => monthRange(m) !== null;

/**
 * v4.22.0 需求 3：月份键（YYYY-MM）→ 半开区间 [月初, 下月初)。
 *
 * ★ 为什么不继续用 `spent_on LIKE '2026-10-%'`：
 *   SQLite 的 LIKE 前缀优化**只在模式是字面量时生效**；一旦写成绑定参数 `LIKE ?`，
 *   执行计划就退化成「只用 kind 索引扫全表再逐行匹配」。实测 2 万条账时，
 *   当月汇总 3.4ms→1.8ms、分类 GROUP BY 4.1ms→2.2ms。
 *   半开区间还顺带避开「12 月 +1 月」的跨年拼接错误。
 */
function monthRange(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const ny = mo === 12 ? y + 1 : y;
  const nm = mo === 12 ? 1 : mo + 1;
  const p = (n) => String(n).padStart(2, '0');
  return [`${y}-${p(mo)}-01`, `${ny}-${p(nm)}-01`];
}
const SOURCES = new Set(['text', 'ocr']);

/** 今天的墙上日期键 */
const todayKey = (tz) => reminders.wallDateKey(new Date(), Number.isFinite(Number(tz)) ? Number(tz) : config.tzOffsetMinutes);

function pickKind(v) {
  /* ★ v2.0.2 只记支出：传 income 一律拒绝。
     历史收入数据**保留在库里**（升级零迁移、数据零丢失），
     只是不再展示（list 强制 kind='expense'）、不能再新建。 */
  if (v === 'income') throw fail('现在只记支出了，收入记账已下线');
  return 'expense';
}

function pickDate(v, tz) {
  const s = String(v || '').trim();
  if (DATE_RE.test(s)) return s;
  return todayKey(tz);
}

function shape(row, me) {
  return {
    id: row.id,
    ownerName: row.owner_name,
    userId: row.user_id,
    kind: row.kind,
    amountCents: Number(row.amount_cents) || 0,
    amount: (Number(row.amount_cents) || 0) / 100,
    category: row.category,
    note: row.note,
    platform: row.platform || '',
    source: row.source,
    /* v4.10.0（A9=③）：精确来源，'' 回落旧 source 翻译。五值：
       manual（网页手动）/ local_text（网页一句话）/ ai_image（网页截图）
       / wecom_text（微信一句话）/ wecom_image（微信截图） */
    sourceChannel: String(row.source_channel || '')
      || (row.source === 'ocr' ? 'ai_image' : 'local_text'),
    raw: row.raw,
    spentOn: row.spent_on,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    mine: !!(me && row.user_id === me.id),
  };
}

/**
 * 账单列表（默认按记账日期倒序）。
 * ★ 不做可见性过滤：需求明确「家庭成员可查看全部家庭账单」。
 *   `scope='mine'` 才按 user_id 过滤，那是用户自己点「只看我的」。
 */
function list(me, o) {
  const opt = o || {};
  const where = [];
  const params = [];
  if (opt.scope === 'mine') { where.push('user_id = ?'); params.push(me.id); }
  // ★ v2.0.2 只记支出：历史收入账保留在库里但**一律不展示** ——
  //   明细 / 搜索 / CSV 导出都是这一个口径，不再提供 kind 参数切换。
  where.push("kind = 'expense'");
  if (opt.category && opt.category !== '全部') { where.push('category = ?'); params.push(String(opt.category)); }
  if (opt.from && DATE_RE.test(opt.from)) { where.push('spent_on >= ?'); params.push(opt.from); }
  if (opt.to && DATE_RE.test(opt.to)) { where.push('spent_on <= ?'); params.push(opt.to); }
  if (opt.q) {
    where.push('(note LIKE ? OR raw LIKE ? OR category LIKE ? OR owner_name LIKE ?)');
    const like = `%${String(opt.q).slice(0, 50)}%`;
    params.push(like, like, like, like);
  }
  const limit = Math.min(Math.max(Number(opt.limit) || 200, 1), 1000);
  const sql = `SELECT * FROM bills ${where.length ? 'WHERE ' + where.join(' AND ') : ''}` +
    ' ORDER BY spent_on DESC, id DESC LIMIT ' + limit;
  return db.all(sql, params).map((r) => shape(r, me));
}

function getById(id) {
  return db.get('SELECT * FROM bills WHERE id = ?', [Number(id)]);
}

/**
 * 写入一笔账（内部用）。所有入口（文字 / OCR 确认 / 手动表单）最终都走这里。
 * @param {object} me
 * @param {object} b 额外接受 `channel`（v4.10.0 A9=③）：manual/local_text/ai_image/wecom_text/wecom_image。
 *   缺省按 source 翻译（text→local_text / ocr→ai_image）。旧 source 列继续双写兼容值。
 * @returns {object} 新建的账单行
 */
function insertBill(me, b) {
  const tz = config.tzOffsetMinutes;
  const kind = pickKind(b.kind);
  const cents = Math.round(Number(b.amountCents));
  if (!Number.isFinite(cents) || cents <= 0) throw fail('金额需要大于 0');
  if (cents > 100000000) throw fail('金额太大了（上限 100 万元）');
  const category = String(b.category || '').trim().slice(0, 12) || '其他';
  const names = allCategoryNames(kind);
  if (names.length && names.indexOf(category) < 0) {
    /* v3.0.0：分类不再要求「先去设置页手动创建」—— 大模型返回什么就自动建什么（需求 4）。
       只对支出开放（本版只记支出）；金额里编不出分类以外的东西，宽度受 12 字上限约束。 */
    if (kind === 'expense') {
      ensureExpenseCategory(category);
    } else {
      throw fail(`「${category}」不是有效的分类，请重新选择`);
    }
  }
  const now = new Date().toISOString();
  const src = SOURCES.has(b.source) ? b.source : 'text';
  const CHANNELS = new Set(['manual', 'local_text', 'ai_image', 'wecom_text', 'wecom_image']);
  const channel = CHANNELS.has(b.channel) ? b.channel : (src === 'ocr' ? 'ai_image' : 'local_text');
  const res = db.run(
    'INSERT INTO bills (user_id, owner_name, kind, amount_cents, category, note, platform, source, source_channel, raw, spent_on, created_at, updated_at)' +
    ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [me.id, me.display_name || me.username || '', kind, cents, category,
      String(b.note || '').slice(0, 200), String(b.platform || '').trim().slice(0, 20),
      src, channel,
      String(b.raw || '').slice(0, 2000), pickDate(b.spentOn, tz), now, now],
  );
  return getById(res.lastInsertRowid);
}

/**
 * 记账后的预算检查。
 * @returns {null|{category:string, spentCents:number, budgetCents:number, over:boolean}}
 */
function checkBudget(bill) {
  if (!bill || bill.kind !== 'expense') return null;
  const b = db.get('SELECT amount_cents FROM bill_budgets WHERE category = ? AND amount_cents > 0', [bill.category]);
  if (!b) return null;
  const month = String(bill.spent_on || '').slice(0, 7);
  if (!isMonthKey(month)) return null;
  const rg = monthRange(month);
  if (!rg) return null;
  const row = db.get(
    "SELECT COALESCE(SUM(amount_cents),0) AS s FROM bills WHERE kind = 'expense' AND category = ? AND spent_on >= ? AND spent_on < ?",
    [bill.category, rg[0], rg[1]],
  );
  const spent = Number(row && row.s) || 0;
  const budget = Number(b.amount_cents) || 0;
  return { category: bill.category, spentCents: spent, budgetCents: budget, over: spent >= budget };
}

/* ── 聊天消息（v4.0.0：只回给前端，**不落库**） ─────────────── */

/* 需求 1：聊天内容只存浏览器本地缓存且仅保留当日，不再进数据库。
   bill_chat 表保留（历史数据不丢、备份格式不变），但服务端不再写入；
   pushChat 退化为「造一条气泡对象」—— POST 响应里带回给前端，前端追加进
   localStorage（按日期键，跨天自动清空）。GET /api/bills/chat 因此恒为空。 */
let chatSeq = 0;

function pushChat(me, role, text, billId) {
  chatSeq += 1;
  return {
    // 本地缓存的气泡要有稳定 id（前端 data-key 用）：时间戳 + 序号，进程内唯一
    id: `m${Date.now().toString(36)}-${chatSeq}`,
    role: role === 'system' ? 'system' : 'user',
    text: String(text || '').slice(0, 500),
    billId: billId || null,
    createdAt: new Date().toISOString(),
  };
}

function shapeChat(row) {
  return { id: row.id, role: row.role, text: row.text, billId: row.bill_id != null ? row.bill_id : row.billId, createdAt: row.createdAt || row.created_at };
}

/** v4.0.0 起聊天不再落库 → 服务端没有历史可给（前端用本地缓存渲染）。保留接口兼容。 */
function chatList() {
  return [];
}

/** v4.0.0 起没有库里可清的聊天（本地缓存由前端清）。保留接口兼容。 */
function clearChat() {
  return { removed: 0 };
}

/* ── 「一句话记账」主流程 ─────────────────────────────────── */

const money = (cents) => `¥${parse.fmtYuan(cents)}`;

/** 系统回复气泡的文案（v2.0.2 起只有支出） */
function systemTextFor(bill, alert) {
  let s = `已记一笔支出：${bill.category} ${money(bill.amount_cents)}${bill.note ? `（${bill.note}）` : ''}`;
  if (bill.spent_on !== todayKey(config.tzOffsetMinutes)) s += ` · ${bill.spent_on}`;
  if (alert && alert.over) {
    s += `\n⚠️ 「${alert.category}」本月已花 ${money(alert.spentCents)}，达到/超过预算 ${money(alert.budgetCents)}`;
  }
  return s;
}

/* 「短时间」的窗口长度。需求：短时间内发送相同金额时先提示、确认后再入账。
   120 秒足够覆盖「手抖点两下」「网络慢、以为没成功又点一次」这两类误点，
   又不会把「早上买菜 30、晚上买水果又 30」这种真实的两笔拦下来（那种间隔远超窗口）。
   只认「同一个人 + 同方向 + 同金额」，刻意不要求分类也相同 ——
   分类是解析器猜的，同金额但分类被猜得不一样时恰恰更需要问一句。 */
const DUP_WINDOW_MS = 120 * 1000;

/** 找出「刚刚」记过的一笔同方向、同金额的账（用于防误点二次确认）。@returns {object|null} */
function findRecentDuplicate(me, kind, amountCents) {
  const since = new Date(Date.now() - DUP_WINDOW_MS).toISOString();
  return db.get(
    'SELECT * FROM bills WHERE user_id = ? AND kind = ? AND amount_cents = ? AND created_at >= ?' +
    ' ORDER BY id DESC LIMIT 1',
    [me.id, kind, amountCents, since],
  ) || null;
}

/* ═══ v4.3.2 需求 1：与已有记录「高度相似」的重复入账检测 ═══════════

   和上面那个 120 秒窗口是**两件事**，不要混：
     · `findRecentDuplicate` 管「手抖点了两下」—— 窗口 120 秒、只比同方向同金额，
       命中就**先不入库**，问一句再决定（阻塞式）。
     · 这里管「重复入账」—— 同一张小票被识别两次、昨天记过今天又记一遍，
       这类重复**隔了几分钟到几天**，120 秒窗口根本够不着。它是**提示式**的：
       账照常入，但把疑似的那条摆出来，让用户一眼看出「这笔我记过了」并一键撤销。
       不阻塞的理由：家庭账本里「同一天同金额同分类」大多是真花了两笔
       （两杯咖啡、两次买菜），每次都拦下来会把人烦到关掉这个功能。

   判定口径（宁可少报，也不天天误报）：
     · 时间窗口：这笔账**自己的日期**前后各 7 天（锚在自己身上，补记上月账单也搜得到）。
     · 硬条件：同一个人 + 同方向 + **金额完全相同**（差一分都不算）。
       刻意**不跨家人比对** —— 两个人各记一笔同样金额是合法的，合并比对全是误报。
     · 软条件打分（≥2 分才算「高度相似」）：
           同一天 +1    备注完全相同 +2    备注互相包含 +1    分类相同 +1
       于是：同一天同分类 = 2 分 → 报；跨天但备注一字不差 = 2 分 → 报；
             同一天、同金额、但分类与备注都不同（买水 vs 打车）= 1 分 → 不报；
             只是金额碰巧一样 = 0 分 → 不报。 */
const SIMILAR_WINDOW_DAYS = 7;
const SIMILAR_SCORE_MIN = 2;

/**
 * 备注归一化：全角转半角、去掉空白与常见标点、转小写，再比 ——
 * 「早餐」/「早餐  」/「早餐。」/「早餐!」应当算同一条。
 * ★ CJK 标点必须显式列出：全角转半角的范围是 U+FF01–U+FF5E（对应 ASCII 标点），
 *   而中文句号「。」(U+3002)、顿号「、」、书名号、省略号都在 U+3000 区，不在那个范围里。
 *   漏掉它们的后果很实在：用户在备注末尾多打一个句号，就会被判成「不相似」。
 */
function normNote(s) {
  return String(s == null ? '' : s)
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s_.,;:!?'"“”‘’()（）\[\]【】\-—·。、，！？；：　「」『』《》〈〉…～]/g, '')
    .toLowerCase();
}

/**
 * 找出与「待入账的这一笔」高度相似的历史账单。
 * @param {object} me
 * @param {{kind?:string, amountCents:number, category?:string, note?:string, spentOn?:string,
 *          excludeId?:number}} cand `excludeId` 传刚写入那笔的 id，避免它跟自己比
 * @returns {null|{id:number, amountCents:number, category:string, note:string, spentOn:string,
 *                 score:number, sameDay:boolean}}
 */
function findSimilarBill(me, cand) {
  const c = cand || {};
  const kind = pickKind(c.kind);
  const cents = Math.round(Number(c.amountCents));
  if (!Number.isFinite(cents) || cents <= 0) return null;
  const tz = config.tzOffsetMinutes;
  /* 窗口锚在**这笔账自己的日期**上（±7 天），而不是锚在「今天」。
     为什么：补记上月账单时（比如今天才想起记 13 号的账），锚在今天就等于
     永远搜不到 13 号那笔 —— 而这恰恰是最容易重复的一类。
     日期字符串做 UTC 算术，不受进程时区影响（与全库口径一致）。 */
  const dayIn = pickDate(c.spentOn, tz);
  const dayMs = Date.parse(dayIn + 'T00:00:00Z');
  const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);
  const since = dayStr(dayMs - SIMILAR_WINDOW_DAYS * 86400000);
  const until = dayStr(dayMs + SIMILAR_WINDOW_DAYS * 86400000);
  const catIn = String(c.category || '').trim();
  const noteIn = normNote(c.note);
  const excludeId = Number(c.excludeId) || 0;

  const rows = db.all(
    'SELECT * FROM bills WHERE user_id = ? AND kind = ? AND amount_cents = ?' +
    ' AND spent_on >= ? AND spent_on <= ? AND id != ? ORDER BY created_at DESC LIMIT 20',
    [me.id, kind, cents, since, until, excludeId],
  );

  let best = null;
  for (const r of rows) {
    let score = 0;
    const sameDay = String(r.spent_on || '') === dayIn;
    if (sameDay) score += 1;
    const noteDb = normNote(r.note);
    if (noteIn && noteDb && noteIn === noteDb) score += 2;
    else if (noteIn && noteDb && (noteDb.indexOf(noteIn) >= 0 || noteIn.indexOf(noteDb) >= 0)) score += 1;
    if (catIn && String(r.category || '').trim() === catIn) score += 1;
    if (score >= SIMILAR_SCORE_MIN && (!best || score > best.score)) {
      best = {
        id: Number(r.id),
        amountCents: Number(r.amount_cents) || 0,
        category: String(r.category || ''),
        note: String(r.note || ''),
        spentOn: String(r.spent_on || ''),
        score,
        sameDay,
      };
    }
  }
  return best;
}

/* ═══ v4.9.0 需求 1：微信端记账的「同日疑似重复」阻塞检测 ═══════════

   和上面两层又是**两件事**，三层的分工别混：
     · `findRecentDuplicate`（120 秒窗口）管「手抖点两下」，网页 / 微信都走，阻塞式；
     · `findSimilarBill`（±7 天打分）管「重复入账提示」，只服务网页端，**不阻塞** ——
       家庭账本里「同一天同金额」大多是真花了两笔，网页上拦下来会把人烦死；
     · 这一层管「微信里的一句账」：微信是**一句话、零确认成本**的入口，发出去就是全部信息，
       网页上那种「看到列表才发现记重了」的自我纠错机会不存在。所以需求明确：
       **同日期 + 金额相同或相近 + 备注相近 → 提醒并阻止直接提交**，让人先看一眼再决定。

   判定口径（见 README）：
     · 日期：spent_on 完全相同；
     · 金额：完全相同；或「相近」= 两笔都 ≥ NEAR_AMOUNT_MIN_CENTS 且差额 ≤ NEAR_AMOUNT_RATIO；
     · 备注：normNote 归一后完全相同 / 互相包含 / 相似度 ≥ NOTE_SIM_MIN；
       ★ 双方备注都为空也算「相近」—— 微信一句话经常不带备注，金额同日撞车时必须问一句；
       一空一实（或明显不同）不算相近 → 不拦。
     ★ 仍然只跟**自己**的历史账比，不跨家人 —— 两个人各买一杯奶茶是合法的。 */
const NEAR_AMOUNT_MIN_CENTS = 1000;   // ¥10：低于这个数只认金额完全相同
const NEAR_AMOUNT_RATIO = 0.02;       // 相近容差：两笔都 ≥ ¥10 时允许 2% 的出入
const NOTE_SIM_MIN = 0.6;             // 备注相似度下限（编辑距离比值）

/** 金额「相近」的容差（分）。小额（<¥10）必须分毫不差才算相近。 */
function nearAmountTol(cents) {
  if (!Number.isFinite(cents) || cents < NEAR_AMOUNT_MIN_CENTS) return 0;
  return Math.max(1, Math.round(cents * NEAR_AMOUNT_RATIO));
}

/**
 * 备注相似度：1 - 归一化编辑距离 / 较长串长度。空串与空串算 1，空串与实串算 0。
 * 只在两个归一化备注都非空且既不相等也不互相包含时才用 —— 那几种情况已经单独计分。
 * 备注都很短（一两个字），编辑距离便宜且足够准；上限 50 字防止极端输入拖慢回调。
 */
function noteSimilarity(a, b) {
  const s = String(a || '').slice(0, 50);
  const t = String(b || '').slice(0, 50);
  if (!s && !t) return 1;
  if (!s || !t) return 0;
  const m = s.length;
  const n = t.length;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/**
 * 微信端阻塞检测：同一天 + 金额相同/相近 + 备注相近 → 返回最像的那条旧账。
 * @param {object} me
 * @param {{kind?:string, amountCents:number, category?:string, note?:string, spentOn?:string}} cand
 * @returns {null|{id:number, amountCents:number, category:string, note:string, spentOn:string, near:boolean}}
 */
function findSameDayDuplicate(me, cand) {
  const c = cand || {};
  const kind = pickKind(c.kind);
  const cents = Math.round(Number(c.amountCents));
  if (!Number.isFinite(cents) || cents <= 0) return null;
  const dayIn = pickDate(c.spentOn, config.tzOffsetMinutes);
  const tol = nearAmountTol(cents);
  const noteIn = normNote(c.note);
  const catIn = String(c.category || '').trim();

  const rows = db.all(
    'SELECT * FROM bills WHERE user_id = ? AND kind = ? AND spent_on = ?' +
    ' AND amount_cents BETWEEN ? AND ? ORDER BY id DESC LIMIT 20',
    [me.id, kind, dayIn, cents - tol, cents + tol],
  );

  let best = null;
  for (const r of rows) {
    const noteDb = normNote(r.note);
    // 「备注相近」：完全相同 / 互相包含 / 相似度达标（仅限 ≥4 字的备注），或双方都空。
    // ★ 相似度只对长备注启用：中文里「一两个字之差」在短备注上往往是完全不同的东西
    //   （买菜/买米、打车/打球），编辑距离算出来「很像」反而是误报。
    const simOk = Math.max(noteIn.length, noteDb.length) >= 4
      && noteSimilarity(noteIn, noteDb) >= NOTE_SIM_MIN;
    const same = noteIn && noteDb && (noteIn === noteDb
      || noteDb.indexOf(noteIn) >= 0 || noteIn.indexOf(noteDb) >= 0 || simOk);
    const bothEmpty = !noteIn && !noteDb;
    if (!same && !bothEmpty) continue;
    const cand2 = {
      id: Number(r.id),
      amountCents: Number(r.amount_cents) || 0,
      category: String(r.category || ''),
      note: String(r.note || ''),
      spentOn: String(r.spent_on || ''),
      near: Number(r.amount_cents) !== cents,
    };
    // 多条命中时优先报「备注最像」的那条：完全相同 > 互相包含 > 相似度
    if (!best || same) best = cand2;
  }
  return best;
}

/**
 * 微信记账的「只解析、不入库」：把 recordFromText 里那段解析配置原样走一遍，
 * 让企业微信侧能在真正入账**之前**拿到 parsed（同日疑似重复检测要用它）。
 * 解析口径（分类名单 / 基准日 / 收入拒收）必须与正式入库完全一致，
 * 否则会出现「检测时说不是收入、入库时又被拒」的裂缝。
 */
function parseBillForCheck(me, text, opts) {
  const o = opts || {};
  const current = listCategories();
  const baseDay = DATE_RE.test(String(o.todayKey || '')) ? o.todayKey : todayKey(o.tzOffsetMinutes);
  const parsed = parse.parseBillText(String(text || ''), {
    todayKey: baseDay,
    extraCategories: current.expense,
    rules: loadCatRules(),          // v4.17.0 需求 5：用户自维护规则优先于内置关键词
  });
  return { ok: !!parsed.ok && parsed.kind !== 'income', parsed };
}

/* ═══ v4.9.0 需求 1：服务端草稿箱（微信「存草稿」的落点） ═══════════ */

function shapeDraft(row) {
  return {
    id: row.id,
    ownerName: row.owner_name,
    kind: row.kind,
    amountCents: Number(row.amount_cents) || 0,
    amount: (Number(row.amount_cents) || 0) / 100,
    category: row.category,
    note: row.note,
    platform: row.platform || '',
    spentOn: row.spent_on,
    raw: row.raw,
    source: row.source,
    status: row.status,
    billId: Number(row.bill_id) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getDraft(me, id) {
  return db.get('SELECT * FROM bill_drafts WHERE id = ? AND user_id = ?', [Number(id) || 0, me.id]);
}

/** 我的草稿列表（draft 在前按更新时间倒序；submitted 的留着当「提交记录」但不进默认列表） */
function listDrafts(me) {
  return db.all(
    "SELECT * FROM bill_drafts WHERE user_id = ? AND status = 'draft' ORDER BY updated_at DESC, id DESC LIMIT 100",
    [me.id],
  ).map(shapeDraft);
}

/** 微信端「存草稿」：把解析结果原样落库。@returns {object} 草稿行 */
function saveDraftFromParsed(me, parsed, raw, source) {
  const p = parsed || {};
  const now = new Date().toISOString();
  const res = db.run(
    'INSERT INTO bill_drafts (user_id, owner_name, kind, amount_cents, category, note, platform, spent_on, raw, source, status, created_at, updated_at)' +
    " VALUES (?,?,?,?,?,?,?,?,?,?,'draft',?,?)",
    [
      me.id, me.display_name || me.username || '', pickKind(p.kind),
      Math.round(Number(p.amountCents)) || 0,
      String(p.category || '其他').slice(0, 12) || '其他',
      String(p.note || '').slice(0, 200),
      String(p.platform || '').trim().slice(0, 20),
      pickDate(p.dateKey, config.tzOffsetMinutes),
      String(raw || '').slice(0, 500),
      source === 'wecom' ? 'wecom' : 'web',
      now, now,
    ],
  );
  /* ★ 注意查的是 bill_drafts，不是 bills —— getById 是账单表的查询，用错表不是 404 而是拿回 undefined */
  return shapeDraft(db.get('SELECT * FROM bill_drafts WHERE id = ?', [res.lastInsertRowid]));
}

/**
 * 确认提交草稿（网页端）：`patch` 允许先把金额/分类/日期/备注改一遍再入库（一步完成）。
 * 入库走 `insertBill` —— 与微信 / OCR / 手动录入同一个校验与写入口，草稿侧不做第二套规则。
 * 成功后草稿标记 submitted 并回指正式账单（不删行：留痕，提交记录可查）。
 */
function submitDraft(me, id, patch) {
  const row = getDraft(me, id);
  if (!row) throw fail('草稿不存在或已被处理', 404);
  if (row.status !== 'draft') throw fail('这条草稿已经提交过了');
  const p = patch || {};
  const bill = insertBill(me, {
    kind: row.kind,
    amountCents: p.amount != null ? Math.round(Number(p.amount) * 100) : row.amount_cents,
    category: p.category != null ? p.category : row.category,
    note: p.note != null ? p.note : row.note,
    platform: p.platform != null ? p.platform : row.platform,
    source: 'text',
    /* v4.16.0 需求 6：草稿也要继承**当初是在哪记的**，否则一笔微信截图的账
       提交完会变成「网页一句话」，来源就废了。
       bill_drafts 只存了 source（wecom/web）两个粗粒度值，所以：
         · wecom + raw 以「（截图识别）」开头 → 微信 AI（截图识别存的草稿）
         · 其余 wecom → 微信一句话
         · web  → 网页一句话 */
    channel: String(row.source) === 'wecom'
      ? (/^（截图识别）/.test(String(row.raw || '')) ? 'wecom_image' : 'wecom_text')
      : 'local_text',
    raw: row.raw ? `（草稿）${row.raw}` : '（微信草稿入账）',
    spentOn: p.spentOn != null ? p.spentOn : row.spent_on,
  });
  db.run("UPDATE bill_drafts SET status = 'submitted', bill_id = ?, updated_at = ? WHERE id = ?",
    [bill.id, new Date().toISOString(), row.id]);
  return { draft: shapeDraft(getDraft(me, id)), bill: shape(bill, me) };
}

/** 删除草稿（用户明确不要了才删；submitted 的不允许删 —— 那是提交记录） */
function deleteDraft(me, id) {
  const row = getDraft(me, id);
  if (!row) throw fail('草稿不存在', 404);
  if (row.status !== 'draft') throw fail('已提交的草稿是提交记录，不能删除');
  db.run('DELETE FROM bill_drafts WHERE id = ?', [row.id]);
  return { ok: true };
}

/* ═══ v4.9.0 需求 2：记账日历（按天聚合） ═══════════════════

   明细列表是「一行一笔」，日历要的是「一天一格」—— 一个 GROUP BY 就够，
   不需要把整月账单拉到前端再算：一是流量，二是口径必须与服务端一致。
   口径与明细列表完全相同：只看支出（v2.0.2 起收入一律不展示）；
   账单天然全家共享（表上没有 visibility 列），所以这里不做任何人过滤 ——
   「该日家庭记账金额总和」指的就是全家。 */
function calendar(me, month) {
  const m = isMonthKey(String(month || '')) ? String(month) : todayKey(config.tzOffsetMinutes).slice(0, 7);
  const rg = monthRange(m);
  const rows = db.all(
    "SELECT spent_on AS d, SUM(amount_cents) AS total, COUNT(*) AS cnt" +
    " FROM bills WHERE kind = 'expense' AND spent_on >= ? AND spent_on < ? GROUP BY spent_on ORDER BY d",
    rg,
  );
  const days = rows.map((r) => ({
    date: r.d,
    expenseCents: Number(r.total) || 0,
    count: Number(r.cnt) || 0,
  }));
  const monthExpenseCents = days.reduce((s, d) => s + d.expenseCents, 0);
  const monthCount = days.reduce((s, d) => s + d.count, 0);
  return { month: m, days, monthExpenseCents, monthCount };
}

/**
 * 聊天窗里输入一句话 → 解析 → 入库 → 回一条系统气泡（本地解析路径，v2.0.0 起语义不变）。
 * @param {object} me
 * @param {string} text
 * @param {{confirm?:boolean, todayKey?:string, tzOffsetMinutes?:number, source?:string}} [opts]
 *   `confirm: true` 表示「用户已经确认这是一笔重复，仍要记账」，跳过防误点检查直接入库。
 * @returns {{ok:boolean, bill?:object, chat:object[], alert?:object|null, parsed:object,
 *            needConfirm?:boolean, duplicate?:object, similar?:object|null}}
 *   `similar`（v4.3.2 需求 1）非空表示「这笔与 7 天内某条旧账高度相似」——
 *   账已经入好了，前端据此给一句「可能存在重复入账」的提示并提供一键撤销。
 */
function recordFromText(me, text, opts) {
  const o = opts || {};
  const current = listCategories();
  // ★ 基准日可注入：相对词（今天/昨天/前天）要有个「今天」才能解析。
  //   测试里注入固定值 → 断言不随「跑测试那天」漂移。
  const baseDay = DATE_RE.test(String(o.todayKey || '')) ? o.todayKey : todayKey(o.tzOffsetMinutes);
  const parsed = parse.parseBillText(text, {
    todayKey: baseDay,
    // ★ v2.0.2 只记支出：候选分类只给支出的 —— 收入分类名（工资/红包…）混进来
    //   会把「给孩子的红包 88」归到收入分类「红包」上，入不了库。
    extraCategories: current.expense,
    rules: loadCatRules(),          // v4.17.0 需求 5：用户自维护规则优先于内置关键词
  });

  if (!parsed.ok) {
    const userMsg = pushChat(me, 'user', String(text || '').slice(0, 500));
    const hint = '这句话里没找到金额。可以试试：「今天买菜 30 元」「昨天打车 26」「这个月房租 3500」';
    const sys = pushChat(me, 'system', hint);
    return { ok: false, chat: [shapeChat(userMsg), shapeChat(sys)], parsed, alert: null };
  }

  /* ★ v2.0.2 只记支出：解析出「收入」方向的一句话不再入账，回一句说明。
     用系统气泡而不是报错 —— 这不是故障，是产品口径变了，要让人看得明白；
     也照常写下用户气泡，让这段对话在聊天记录里是完整的一问一答。 */
  if (parsed.kind === 'income') {
    const userMsg = pushChat(me, 'user', String(text || '').slice(0, 500));
    const sys = pushChat(me, 'system',
      '现在只记支出啦，「收到 / 工资 / 报销」这类收入不再入账。要记花销的话，直接写「今天买菜 30 元」就好。');
    return { ok: false, chat: [shapeChat(userMsg), shapeChat(sys)], parsed, alert: null };
  }

  /* ★ 防误点：短时间内「同方向 + 同金额」→ **先不入库**，回一个 needConfirm 让前端问一句，
     用户确认后再带 confirm 重发一次。
     刻意连用户那句话都不写进聊天记录：否则「取消」之后聊天窗里会留下一条没有对应账目的
     用户气泡，看起来像「记了但没生效」。确认入库时才会正常写下用户气泡 + 系统气泡。 */
  if (!o.confirm) {
    const dup = findRecentDuplicate(me, parsed.kind, parsed.amountCents);
    if (dup) {
      return {
        ok: false,
        needConfirm: true,
        duplicate: {
          id: dup.id,
          kind: dup.kind,
          amountCents: Number(dup.amount_cents) || 0,
          category: dup.category,
          note: dup.note,
          spentOn: dup.spent_on,
        },
        parsed,
        chat: [],
        alert: null,
      };
    }
  }

  const userMsg = pushChat(me, 'user', String(text || '').slice(0, 500));
  const row = insertBill(me, {
    kind: parsed.kind,
    amountCents: parsed.amountCents,
    category: parsed.category,
    note: parsed.note,
    source: o.source === 'ocr' ? 'ocr' : 'text',
    // v4.10.0（A9=③）：网页一句话 = local_text；微信一句话由调用方传 wecom_text
    channel: o.channel,
    raw: parsed.raw,
    spentOn: parsed.dateKey,
  });
  const alert = checkBudget(row);
  /* v4.3.2 需求 1：入库后再比一次「有没有高度相似的旧账」。
     放在入库**之后**（而不是之前拦下来）是刻意的：这是提示，不是拦截 ——
     正常记账的路径一秒都不能被拖慢或多一次往返。命中与否都不影响这笔账已经记上。 */
  const similar = findSimilarBill(me, {
    kind: row.kind, amountCents: row.amount_cents, category: row.category,
    note: row.note, spentOn: row.spent_on, excludeId: row.id,
  });
  const sys = pushChat(me, 'system', systemTextFor(row, alert), row.id);
  return { ok: true, bill: shape(row, me), chat: [shapeChat(userMsg), shapeChat(sys)], alert, parsed, similar };
}

/**
 * 聊天记账总入口。
 *
 * ★ v4.2.0 需求 1：**完全本地解析，不接任何 AI 服务**。
 *   之前的版本会先调 AI 文本模型（v4.0.0「AI 优先」），现在整条 AI 链路已移除：
 *   一句话记账只走 `recordFromText`（src/billparse.js 的本地规则），
 *   零外呼、零 token 成本、断网可用、结果可预测 —— 顺带也把「AI 未配置 / 停用 /
 *   超额度」这几种降级分支一并消灭了。
 *
 * 返回形状与 recordFromText 完全一致（保留 async 与对象参数是为了不破坏既有调用方）：
 *   · 「没找到金额」「收入说明气泡」「防重复 needConfirm」等既有语义全部不变。
 *
 * @param {object} me
 * @param {string} text
 * @param {{confirm?:boolean, todayKey?:string, tzOffsetMinutes?:number}} [opts]
 * @returns {Promise<object>}
 */
async function chatRecord(me, text, opts) {
  return recordFromText(me, text, opts || {});
}

/* ── v4.0.0 需求 2：自定义快捷短语（按人存 user_prefs） ────── */

const QUICK_KEY = 'bill_quick_phrases';
const QUICK_MAX = 8;
const QUICK_LEN = 30;
/** 从未设置过时的出厂例句（与旧版硬编码一致，升级后界面不变） */
const DEFAULT_QUICKS = ['今天买菜 30 元', '昨天打车 26', '这个月房租 3500', '充话费 100'];

/** 清洗一列短语：去空、去重、≤30 字、最多 8 条 */
function sanitizeQuicks(rawList) {
  const arr = Array.isArray(rawList) ? rawList : [];
  const out = [];
  for (const v of arr) {
    const s = String(v == null ? '' : v).trim().slice(0, QUICK_LEN);
    if (!s || out.indexOf(s) >= 0) continue;
    out.push(s);
    if (out.length >= QUICK_MAX) break;
  }
  return out;
}

/** 我自己的快捷短语（没设置过 = 出厂例句） */
function getQuickPhrases(me) {
  const row = db.get('SELECT value FROM user_prefs WHERE user_id = ? AND key = ?', [me.id, QUICK_KEY]);
  if (!row) return DEFAULT_QUICKS.slice();
  try {
    const list = sanitizeQuicks(JSON.parse(row.value));
    return list.length ? list : DEFAULT_QUICKS.slice();
  } catch { return DEFAULT_QUICKS.slice(); }
}

/** 保存我的快捷短语（全量替换；传空数组 = 恢复出厂例句） */
function setQuickPhrases(me, rawList) {
  const list = sanitizeQuicks(rawList);
  if (list.length) {
    db.run(
      'INSERT INTO user_prefs (user_id, key, value) VALUES (?,?,?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value',
      [me.id, QUICK_KEY, JSON.stringify(list)],
    );
  } else {
    // 全删 = 回出厂例句：把行删掉，getQuickPhrases 自然回落
    db.run('DELETE FROM user_prefs WHERE user_id = ? AND key = ?', [me.id, QUICK_KEY]);
  }
  return getQuickPhrases(me);
}

/* ── 统计 ─────────────────────────────────────────────────── */

function sumFor(where, params) {
  const row = db.get(
    `SELECT COALESCE(SUM(CASE WHEN kind='income' THEN amount_cents ELSE 0 END),0) AS income,` +
    ` COALESCE(SUM(CASE WHEN kind='expense' THEN amount_cents ELSE 0 END),0) AS expense` +
    ` FROM bills WHERE ${where}`, params,
  );
  const income = Number(row && row.income) || 0;
  const expense = Number(row && row.expense) || 0;
  return { incomeCents: income, expenseCents: expense, netCents: income - expense };
}

/**
 * 统计：个人 / 家庭 × 日 / 月；v4.0.0 起支持**自定义日期范围**（需求 4）。
 * @param {object} me
 * @param {{dateKey?:string, month?:string, from?:string, to?:string}} [opts]
 *   from/to 都合法且 from ≤ to 时，额外返回 range 口径（供「按日期范围筛选」展示）。
 */
function stats(me, opts) {
  const o = opts || {};
  const day = DATE_RE.test(String(o.dateKey || '')) ? o.dateKey : todayKey(config.tzOffsetMinutes);
  const month = isMonthKey(String(o.month || '')) ? o.month : day.slice(0, 7);
  /* v4.22.0 需求 3：当月口径用半开区间（不用 LIKE 绑定参数），让 (kind, spent_on) 索引真正走范围 */
  const rg = monthRange(month);
  const out = {
    day,
    month,
    personal: {
      day: sumFor("user_id = ? AND spent_on = ?", [me.id, day]),
      month: sumFor("user_id = ? AND spent_on >= ? AND spent_on < ?", [me.id, rg[0], rg[1]]),
    },
    family: {
      day: sumFor('spent_on = ?', [day]),
      month: sumFor('spent_on >= ? AND spent_on < ?', [rg[0], rg[1]]),
    },
    // 支出按分类的小计（当月），给统计卡片画排行用
    monthByCategory: db.all(
      "SELECT category, SUM(amount_cents) AS cents FROM bills WHERE kind='expense' AND spent_on >= ? AND spent_on < ?" +
      ' GROUP BY category ORDER BY cents DESC LIMIT 12',
      [rg[0], rg[1]],
    ).map((r) => ({ category: r.category, amountCents: Number(r.cents) || 0 })),
  };
  // v4.0.0：日期范围筛选（from/to 都合法才启用）
  if (DATE_RE.test(String(o.from || '')) && DATE_RE.test(String(o.to || '')) && o.from <= o.to) {
    out.range = {
      from: o.from,
      to: o.to,
      personal: rangeStats(o.from, o.to, me.id),
      family: rangeStats(o.from, o.to, null),
    };
  }
  return out;
}

/* ── 编辑 / 删除（只能动自己的） ─────────────────────────── */

function update(me, id, patch) {
  const row = getById(id);
  if (!row) throw fail('账单不存在', 404);
  // ★ 先按 id 取到再判归属：取不到 404、不是自己的 403（不能让别人编辑）
  if (row.user_id !== me.id) throw fail('只能修改自己记的账', 403);
  const b = patch || {};
  const next = {
    kind: b.kind !== undefined ? pickKind(b.kind) : row.kind,
    amountCents: b.amount !== undefined ? Math.round(Number(b.amount) * 100)
      : (b.amountCents !== undefined ? Math.round(Number(b.amountCents)) : row.amount_cents),
    category: b.category !== undefined ? String(b.category).trim().slice(0, 12) : row.category,
    note: b.note !== undefined ? String(b.note).slice(0, 200) : row.note,
    platform: b.platform !== undefined ? String(b.platform).trim().slice(0, 20) : (row.platform || ''),
    spentOn: b.spentOn !== undefined ? pickDate(b.spentOn, config.tzOffsetMinutes) : row.spent_on,
  };
  if (!Number.isFinite(next.amountCents) || next.amountCents <= 0) throw fail('金额需要大于 0');
  if (next.amountCents > 100000000) throw fail('金额太大了（上限 100 万元）');
  const names = allCategoryNames(next.kind);
  if (names.length && names.indexOf(next.category) < 0) throw fail(`「${next.category}」不是有效的分类，请重新选择`);
  db.run(
    'UPDATE bills SET kind=?, amount_cents=?, category=?, note=?, platform=?, spent_on=?, updated_at=? WHERE id=?',
    [next.kind, next.amountCents, next.category, next.note, next.platform, next.spentOn, new Date().toISOString(), row.id],
  );
  const out = getById(row.id);
  return { bill: shape(out, me), alert: checkBudget(out) };
}

function remove(me, id) {
  const row = getById(id);
  if (!row) throw fail('账单不存在', 404);
  if (row.user_id !== me.id) throw fail('只能删除自己记的账', 403);
  db.run('DELETE FROM bills WHERE id = ?', [row.id]);
  return { removed: 1 };
}

/* ── CSV 导出 ─────────────────────────────────────────────── */

const CSV_HEADER = ['日期', '记账人', '分类', '备注', '金额(元)', '记账方式', '来源'];
const SOURCE_CN = { text: '文字', ocr: 'OCR' };
/* v4.16.0 需求 6：四种来源的固定叫法（与前端 BILL_SOURCE_LABEL 同一套文案）。
   ★ 只有这四种（+ 手动）—— 名字写死在这里，是为了让导出、界面、文档三处不会各叫一个名字。 */
const SOURCE_CHANNEL_CN = {
  local_text: '网页一句话',
  ai_image: '网页 AI',
  wecom_text: '微信一句话',
  wecom_image: '微信 AI',
  manual: '网页手动',
};

/**
 * 导出 CSV 文本（含 UTF-8 BOM，Excel 直接双击打开不乱码）。
 * ★ v2.0.2 只记支出：不再有「收支类型」列（全是支出，这一列成了纯噪音）。
 * @param {object} me
 * @param {{from?:string, to?:string, scope?:'mine'|'family', kind?:string}} [opts]
 */
function exportCsv(me, opts) {
  const o = opts || {};
  const rows = list(me, { ...o, limit: 1000 });
  const body = rows.map((b) => [
    b.spentOn,
    b.ownerName,
    b.category,
    b.note,
    parse.fmtYuan(b.amountCents),
    SOURCE_CN[b.source] || b.source,
    // v4.16.0 需求 6：精确来源（网页一句话 / 网页 AI / 微信一句话 / 微信 AI）
    SOURCE_CHANNEL_CN[b.sourceChannel] || (b.source === 'ocr' ? '网页 AI' : '网页一句话'),
  ]);
  return '\ufeff' + parse.toCsv([CSV_HEADER].concat(body));
}

/* ── 日报 / 月报邮件 ─────────────────────────────────────── */

const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

function rangeStats(fromKey, toKey, userId) {
  const where = ['spent_on >= ?', 'spent_on <= ?'];
  const params = [fromKey, toKey];
  if (userId != null) { where.push('user_id = ?'); params.push(userId); }
  /* v4.22.0 需求 3：求和与笔数合成 1 条（原来 sumFor + COUNT 两条各扫一遍）。
     口径不变：net = 收入 − 支出；count 只数支出（v2.0.2 只记支出后与旧版一致）。 */
  const agg = db.get(
    `SELECT COALESCE(SUM(CASE WHEN kind = 'income'  THEN amount_cents ELSE 0 END), 0) AS income,
            COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount_cents ELSE 0 END), 0) AS expense,
            COALESCE(SUM(CASE WHEN kind = 'expense' THEN 1 ELSE 0 END), 0) AS n
       FROM bills WHERE ${where.join(' AND ')}`,
    params,
  ) || {};
  const income = Number(agg.income) || 0;
  const expense = Number(agg.expense) || 0;
  const s = { incomeCents: income, expenseCents: expense, netCents: income - expense };
  const top = db.all(
    "SELECT category, SUM(amount_cents) AS cents FROM bills WHERE kind='expense' AND spent_on >= ? AND spent_on <= ?" +
    (userId != null ? ' AND user_id = ?' : '') +
    ' GROUP BY category ORDER BY cents DESC LIMIT 6',
    userId != null ? [fromKey, toKey, userId] : [fromKey, toKey],
  ).map((r) => ({ category: r.category, amountCents: Number(r.cents) || 0 }));
  return { ...s, top, count: Number(agg.n) || 0 };
}

function dayTitle(key) {
  const [y, m, d] = key.split('-').map(Number);
  return `${m}月${d}日 星期${WEEK_CN[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}`;
}

function monthTitle(month) {
  const [y, m] = month.split('-').map(Number);
  return `${y}年${m}月`;
}

/**
 * 日报的收件人与内容。
 * @param {string} dateKey 报表归属日（「昨天」）
 */
function buildDailyReport(dateKey) {
  const users = db.all("SELECT id, display_name, username, notify_email FROM users WHERE notify_email != '' ORDER BY id");
  const family = rangeStats(dateKey, dateKey, null);
  const title = dayTitle(dateKey);
  const personal = [];
  for (const u of users) {
    const s = rangeStats(dateKey, dateKey, u.id);
    personal.push({ user: u, stats: s });
  }
  return { dateKey, title, family, personal };
}

function buildMonthlyReport(month) {
  const [y, m] = month.split('-').map(Number);
  const from = `${month}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const to = `${month}-${String(lastDay).padStart(2, '0')}`;
  const users = db.all("SELECT id, display_name, username, notify_email FROM users WHERE notify_email != '' ORDER BY id");
  const family = rangeStats(from, to, null);
  const personal = users.map((u) => ({ user: u, stats: rangeStats(from, to, u.id) }));
  return { month, from, to, title: monthTitle(month), family, personal };
}

function reportRows(stats) {
  /* ★ v2.0.2 只记支出：报表里不再有「收入 / 结余」两行 ——
     收入记账下线后这两行永远是 ¥0.00，留着只会让人疑惑「是不是坏了」。 */
  const rows = [
    { label: '支出', value: money(stats.expenseCents) },
    { label: '笔数', value: `${stats.count} 笔` },
  ];
  if (stats.top && stats.top.length) {
    rows.push({ label: '支出前几项', value: stats.top.map((t) => `${t.category} ${money(t.amountCents)}`).join('、') });
  }
  return rows;
}

/* ── v4.21.0 需求 1：报表文案由模板渲染 ───────────────────────── */

/** 「— 全家 10月26日 —」这样的分板块正文（金额 / 笔数 / 前几项） */
function reportSectionLines(sections) {
  const lines = [];
  for (const sec of sections || []) {
    lines.push(`— ${sec.label} —`);
    for (const r of reportRows(sec.stats)) lines.push(`${r.label}：${r.value}`);
    lines.push('');
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/** 文末的待办预告整段；m.todos === null 表示「不附带」→ 整段为空（模板里那行会消失） */
function reportTodoBlock(m) {
  if (!m.todos) return '';
  const label = String(m.todoLabel || '今日待办预告');
  const lines = [`— ${label} —`];
  if (m.todos.length) {
    for (const t of m.todos) lines.push(`· ${t.time ? `${t.time} ` : ''}${t.title}`);
  } else {
    lines.push(m.todoEmpty || '今天没有待办事项。');
  }
  return lines.join('\n');
}

/** 记账报表邮件的模板变量（唯一取数口） */
function reportVars(m) {
  return {
    站名: config.siteName,
    报表标题: String(m.heading || ''),
    范围: String(m.scope || '个人 + 家庭'),
    副标题: String(m.badge || ''),
    明细: reportSectionLines(m.sections),
    待办: reportTodoBlock(m),
  };
}

function reportText(heading, badge, stats, footnote) {
  return msgTpl.render('bill_report', {
    站名: config.siteName, 报表标题: String(heading || ''), 范围: '个人 + 家庭',
    副标题: String(badge || ''), 明细: reportSectionLines([{ label: String(badge || ''), stats }]), 待办: '',
  }).text;
}

function reportHtml(heading, badge, stats, footnote) {
  return reminders.mailLayout({
    heading,
    badge,
    intro: '这是家庭记账自动生成的支出总结。',
    rows: reportRows(stats),
    kind: 'todo',
    footnote: footnote || '你收到这封邮件，是因为你在这个家庭空间里配置了收件邮箱。',
  });
}

/* ── v4.2.0 需求 5：个人 + 家庭合成一封 + 附加今日待办预告 ────── */

/**
 * 今日待办预告（只读查询，**完全不碰待办提醒的既有逻辑**）。
 * 口径：该用户能看到的、**这一天要处理**且尚未完成的待办 —— 家庭共享的 + 自己的私事。
 *
 * ★ v4.28.0 修复：旧实现只查 `todo_date = 那天`，而重复事项的 `todo_date` 是
 *   **基准日**（可能是几年前建的那一天），永远不等于「今天 / 明天」，
 *   于是任何重复事项都不会出现在日报的待办预告里 —— 用户看到的就是
 *   「日报只列一次性事项，每天/每周/每年的提醒像消失了一样」。
 *
 * 现在的判定与「待办列表」完全同源：
 *   · 这一天是某个落点的**提醒日**（落点 = 这一天 + 这条自己的提前天数）→ 列这一天；
 *   · 或这一天本身就是落点（提前 0 天时与上面等价；提前 > 0 且提醒日没处理时兜底）。
 * 落点、提前天数、完成标记分别复用 repeat.js / reminders.advanceOf / todo_done_marks，
 * 不在这里另写一套日期规则。
 * @param {number} userId
 * @param {string} todayKey YYYY-MM-DD（墙上今天）
 * @returns {Array<{title:string, time:string}>}
 */
function todoPreviewFor(userId, todayKey) {
  const day = String(todayKey || '').slice(0, 10);
  if (!DATE_RE.test(day)) return [];
  /* 先把候选行缩小到「当天的一次性事项 + 所有重复事项」，再在内存里判落点：
     重复规则是 JS 实现（含农历换算），SQL 里写不出来，硬写成 SQL 会变成第二份规则。 */
  const rows = db.all(
    "SELECT * FROM todos WHERE (todo_date = ? OR repeat != '' OR repeat_rule != '')" +
    /* v4.28.2：可见性与 api.js 的 VISIBLE 同口径 —— 全家可见 / 我创建的 / 被点名让我看的。
       只按 user_id 判的话，别人「指定可见成员」把我拉进去的待办不会出现在我的日报预告里。 */
    " AND (visibility = 'family' OR user_id = ? OR instr(visible_to, ?) > 0)"
    + ' ORDER BY start_time, id',
    [day, Number(userId), `,${Number(userId)},`],
  );
  /* 已经勾过「完成」的落点不再预告：勾选表示「这一天不做了 / 不再提醒」，
     与待办列表、企业微信「今日待办」保持同一口径。窗口取 [这一天, +5]：
     提前提醒最多 5 天，落点最多在这之后的第 5 天。 */
  const done = new Map();
  try {
    for (const r of db.all(
      'SELECT todo_id, occ_date FROM todo_done_marks WHERE occ_date >= ? AND occ_date <= ?',
      [day, reminders.shiftDateKey(day, 5)],
    )) {
      const id = Number(r.todo_id);
      if (!done.has(id)) done.set(id, new Set());
      done.get(id).add(String(r.occ_date));
    }
  } catch { /* 老库还没这张表：当作没有标记 */ }
  const gAdv = reminders.loadRemindSettings().remindAdvanceDays;
  return rows
    .filter((r) => {
      const rule = db.getRepeatRule(r);
      if (!rule) return r.todo_date === day && !r.done;   // 一次性事项：当天且未完成
      const marks = done.get(Number(r.id)) || new Set();
      const adv = reminders.advanceOf(r, gAdv);
      const remindDayOcc = reminders.shiftDateKey(day, adv);
      if (Repeat.isOccurrence(r, remindDayOcc)) return !marks.has(remindDayOcc);
      if (Repeat.isOccurrence(r, day)) return !marks.has(day);
      return false;
    })
    .slice(0, 20)
    .map((r) => ({ title: String(r.title || '').slice(0, 80), time: String(r.start_time || '') }));
}

/**
 * 合并邮件正文（纯文本）：家庭板块 + 个人板块 + 今日待办预告。
 * @param {{heading:string, badge:string, sections:Array<{label:string,stats:object}>, todos:Array}} m
 */
/**
 * v4.5.0 需求 5：企业微信推送用的纯文本版报表。
 *
 * 为什么不直接复用 mergeReportText：那一版是邮件正文，尾部写着
 * 「本邮件由系统自动发送，请勿回复」—— 放在企业微信会话里既多余又误导
 * （企业微信本来就是可以回复来记账的）。这里只保留「标题 + 数字」。
 * v4.21.0 需求 1：这句话本身也进了模板（bill_push），想改照样能改。
 */
function reportPushText(m) {
  const text = msgTpl.render('bill_push', {
    站名: config.siteName,
    报表标题: String(m.heading || ''),
    副标题: String(m.badge || ''),
    明细: reportSectionLines(m.sections),
  }).text;
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/* v4.21.0 需求 1：报表邮件的完整形态（标题 / 纯文本 / HTML 三件套一起出）。
   标题以前是写死在 sendReports 里的字符串，现在随模板走 —— 否则改了正文却改不了标题。 */
function reportMail(m) {
  const vars = reportVars(m);
  const r = msgTpl.render('bill_report', vars);
  return { subject: r.subject, text: r.text, html: mergeReportHtml(m) };
}

function mergeReportText(m) {
  return msgTpl.render('bill_report', reportVars(m)).text;
}

/** 合并邮件正文（HTML）：默认模板沿用 reminders.mailLayout，自定义模板走品牌外壳 + 原文 */
function mergeReportHtml(m) {
  const vars = reportVars(m);
  const custom = msgTpl.htmlFor('bill_report', vars, {
    kind: 'todo',
    footnote: '你收到这封邮件，是因为你在这个家庭空间里配置了收件邮箱。',
  });
  if (custom) return custom;
  const rows = [];
  for (const sec of m.sections) {
    rows.push({ label: sec.label, value: '　' });                       // 分组小标题
    for (const r of reportRows(sec.stats)) rows.push({ label: `　${r.label}`, value: r.value });
  }
  // v4.3.3 需求 3：待办预告可配置；null = 不附带（整段不出现在邮件里）
  if (m.todos) {
    const label = String(m.todoLabel || '今日待办预告');
    rows.push({ label, value: '　' });
    if (m.todos.length) {
      for (const t of m.todos) rows.push({ label: `　${t.time || '全天'}`, value: t.title });
    } else {
      rows.push({ label: '　', value: String(m.todoEmpty || '今天没有待办事项').replace(/。$/, '') });
    }
  }
  return reminders.mailLayout({
    heading: m.heading,
    badge: m.badge,
    // v4.12.0：附带待办可关闭；文案里的日期随日报口径变化（当天发当天=明日，第二天发前一天=今日）
    intro: m.todos
      ? `个人账单与家庭账单已合并到这一封；文末附上${String(m.todoLabel || '待办预告').replace(/待办预告$/, '待办')}。`
      : '个人账单与家庭账单已合并到这一封。',
    rows,
    kind: 'todo',
    footnote: '你收到这封邮件，是因为你在这个家庭空间里配置了收件邮箱。',
  });
}

const lastSend = { at: '', result: '', errors: [] };

function setLastSend(result, errors) {
  lastSend.at = new Date().toISOString();
  lastSend.result = result;
  lastSend.errors = (errors || []).slice(-4);
  putSetting('bill_report_last_at', lastSend.at);
  putSetting('bill_report_last_result', result);
}

/**
 * 报表在企业微信里到底发给谁（v4.16.0 需求 1 / 需求 2，见下方函数体内的说明）。
 * @returns {string[]} 企业微信 UserID 列表
 */
/**
 * v4.16.0 需求 1 / 需求 2：企业微信报表的收件人**只看账号映射 + 每个人的推送方式**。
 *   · 账号映射（wecom_user_map）里对应到家庭账号、且这个人的推送方式不是「仅邮件」
 *     → 他会收到企业微信报表；
 *   · 「额外抄送 UserID」（wecom_report_to）已下线：报表不再支持手工抄送外部 UserID，
 *     也不接受 @all —— 那等于把家庭账本群发给全公司。
 * @returns {string[]} 企业微信 UserID 列表
 */
function wecomReportRecipients(cfg) {
  const map = wecom.userMapOf(cfg || wecom.loadConfig());   // Map<wxUserId, username>
  const byUser = new Map();
  for (const [wx, uname] of map) {
    const key = String(uname || '').trim();
    if (key && !byUser.has(key)) byUser.set(key, wx);
  }
  const out = [];
  for (const u of db.all('SELECT id, username, push_channel FROM users ORDER BY id')) {
    /* v4.25.0 需求 4：报表走「记账」这一类的渠道（没单独配就是他的推送方式） */
    if (push.channelFor(u.id, 'bill') === 'mail') continue;   // 明确只要邮件
    const wx = byUser.get(String(u.username || '').trim());
    if (wx && out.indexOf(wx) < 0) out.push(wx);
  }
  return out;
}

function getStatus() {
  const cfg = loadSettings();
  const rem = reminders.loadRemindSettings();
  /* v4.12.0 需求 5：推送方式跟随系统设置 —— 页面只需如实显示「现在会走哪条路」。
     · 邮件：系统里配了发件邮箱 + 授权码，且家庭级「邮件推送」没关
     · 企业微信：应用配置完整 + 家庭级「企业微信推送」没关（v4.16.0：不再有自己的报表开关） */
  const viaMail = !!(rem.smtpUser && rem.smtpPass) && config.pushMailEnabled !== false;
  const viaWecom = wecom.isReady() && config.pushWecomEnabled !== false;
  const wecomTos = viaWecom ? wecomReportRecipients(wecom.loadConfig()) : [];
  return {
    at: lastSend.at || cfg.lastAt,
    result: lastSend.result || cfg.lastResult,
    errors: [...lastSend.errors],
    lastDay: cfg.lastDay,
    lastMonth: cfg.lastMonth,
    dailyTime: cfg.dailyTime,
    reportWhen: cfg.reportWhen,
    // v4.12.0：是否附带待办 + 附带的是哪一天（由口径推出，前端直接显示）
    attachTodo: cfg.attachTodo,
    attachDayLabel: cfg.reportWhen === 'same_day' ? '明日待办' : '今日待办',
    channels: { mail: viaMail, wecom: viaWecom },
    channelText: viaMail && viaWecom ? '邮件 + 企业微信'
      : viaMail ? '邮件'
        : viaWecom ? '企业微信' : '未配置（不计推送）',
    /* v4.16.0：报表在企业微信里发给谁（账号映射 + 额外收件人，已按各自推送方式过滤）。
       前端「记账推送」里直接显示人数，省得管理员猜「填了映射到底发不发」。 */
    wecomRecipients: wecomTos,
    wecomRecipientCount: wecomTos.length,
    enabled: cfg.enabled,
    monthly: cfg.monthly,
  };
}

/**
 * 真的把日报 / 月报发出去。
 * @param {{dateKey?:string, month?:string, force?:boolean}} [opts]
 */
async function sendReports(opts) {
  const o = opts || {};
  const cfg = loadSettings();
  const rem = reminders.loadRemindSettings();
  const out = { mails: 0, recipients: 0, wecom: 0, feishu: 0, dingtalk: 0, errors: [], skipped: '' };
  /* v4.5.0 需求 5：两条通道各自独立。
     ★ 旧版在这里「没配 SMTP 就直接 return」，等于把企业微信推送一起堵死了 ——
       很多家庭根本没配发件邮箱，正是最需要企业微信这条通道的场景。
     现在只要有任意一条通道可用就继续；都没配才跳过。 */
  const viaMail = !!(rem.smtpUser && rem.smtpPass) && config.pushMailEnabled !== false;
  const wxCfg = wecom.loadConfig();
  const viaWecom = wecom.isReady(wxCfg) && config.pushWecomEnabled !== false;
  /* v4.24.0 需求 2：飞书 / 钉钉群机器人 —— 与企微同级的即时通道 */
  const fsCfg = feishu.loadConfig();
  const dtCfg = dingtalk.loadConfig();
  const viaFeishu = feishu.isReady(fsCfg) && config.pushFeishuEnabled !== false;
  const viaDingtalk = dingtalk.isReady(dtCfg) && config.pushDingtalkEnabled !== false;
  if (!viaMail && !viaWecom && !viaFeishu && !viaDingtalk) {
    out.skipped = '未配置发件邮箱或授权码，企业微信 / 飞书 / 钉钉推送也都没开';
    setLastSend('skipped:no-channel', [out.skipped]);
    return out;
  }
  /* v4.16.0 需求 1：报表**严格按每个人自己的「推送方式」**投递（我的 → 推送渠道设置），
     与待办提醒 / 内容通知同一套语义（对齐 push.deliver）：
       · mail  → 只发邮件；
       · wecom → 只发企业微信（没在账号映射里对应上就明确报错，绝不静默丢）；
       · both  → 两条都发（用户自己勾的，不叫重复）；
       · auto  → 优先企业微信，用不上（没映射 / 企微没开）才落邮件。
     ★ 旧版是「全员邮件 + 全员企微各发一遍」两套口径并存：选「智能」的人一封报表
       收两份。现在一个人只按他选的方式收到一份。 */
  const wxOf = new Map();                     // username → 企业微信 UserID
  for (const [wx, uname] of wecom.userMapOf(wxCfg)) {
    const key = String(uname || '').trim();
    if (key && !wxOf.has(key)) wxOf.set(key, wx);
  }
  const people = [];                          // 每人一条：{ u, ch, name, wx }
  /* v4.25.0 需求 4：报表属于「记账」类，走各自的 channel_bill；没配就沿用 push_channel。
     一次取全部个人偏好，避免逐人查库。 */
  const prefsMap = userprefs.loadAll();
  for (const u of db.all('SELECT id, username, display_name, notify_email, push_channel FROM users ORDER BY id')) {
    const ch = push.channelFor(u.id, 'bill', prefsMap);
    const name = u.display_name || u.username || `用户${u.id}`;
    const wx = wxOf.get(String(u.username || '').trim()) || '';
    people.push({ u, ch, name, wx });
  }
  /* v4.24.0 需求 2：企微腿只收「auto / wecom / both」的人 —— 选了飞书 / 钉钉的人
     不再因为「账号映射里有他」而被并进企微收件人（那是 v4.24.0 之前不会发生的组合）。 */
  const wantWxOf = (p) => !!(viaWecom && p.wx
    && (p.ch === 'auto' || p.ch === 'wecom' || p.ch === 'both'));
  const wantMailOf = (p) => !!(viaMail && p.u.notify_email
    && (p.ch === 'mail' || p.ch === 'both' || (p.ch === 'auto' && !wantWxOf(p))));
  const wxTos = [];                           // 企微腿：合并成一次 API 调用
  const hookTos = { feishu: [], dingtalk: [] };  // 群机器人腿：按通道去重，各发一条
  for (const p of people) {
    if (p.ch === 'wecom' && !wantWxOf(p)) {
      /* 「仅企业微信」却发不了：必须说清楚为什么，否则用户只会觉得「报表坏了」。 */
      out.errors.push(viaWecom
        ? `${p.name}：推送方式是「仅企业微信」，但还没在「账号映射」里对应，收不到报表`
        : `${p.name}：推送方式是「仅企业微信」，但企业微信推送没开，收不到报表`);
    }
    if (p.ch === 'feishu' && !viaFeishu) {
      out.errors.push(`${p.name}：推送方式是「飞书群」，但飞书推送没开或还没配置群机器人的 Webhook，收不到报表`);
    }
    if (p.ch === 'dingtalk' && !viaDingtalk) {
      out.errors.push(`${p.name}：推送方式是「钉钉群」，但钉钉推送没开或还没配置群机器人的 Webhook，收不到报表`);
    }
    if (wantWxOf(p) && wxTos.indexOf(p.wx) < 0) wxTos.push(p.wx);
    if (p.ch === 'feishu' && viaFeishu && hookTos.feishu.length === 0) hookTos.feishu.push(p);
    if (p.ch === 'dingtalk' && viaDingtalk && hookTos.dingtalk.length === 0) hookTos.dingtalk.push(p);
  }
  if (!people.some(wantMailOf) && !wxTos.length && !hookTos.feishu.length && !hookTos.dingtalk.length) {
    // 按各自的推送方式算下来一个人都投不出去：明确记账，别静默消失。
    out.skipped = viaWecom || viaFeishu || viaDingtalk
      ? '按每个人的推送方式算下来，还没有能收报表的家人（收件邮箱 / 账号映射 / 群机器人 Webhook / 推送开关都查一下）'
      : '家里还没有人配置收件邮箱';
    setLastSend('skipped:no-recipient', [out.skipped]);
    return out;
  }
  const base = {
    host: rem.smtpHost, port: rem.smtpPort, user: rem.smtpUser, pass: rem.smtpPass,
    fromName: config.siteName,
  };
  /* v4.23.0 需求 5：每一次真实投递都写日志（成功也写），
     这样「XX 说没收到」打开日志就能看到他那条走了哪条通道、失败原因是什么。 */
  const log = (u, channel, ok, subject, detail) => push.logOne({
    kind: 'bill', userId: u.id, name: u.display_name || u.username || '',
    channel, ok, subject, detail,
  });
  const sendMailOne = async (u, msg, note) => {
    try {
      await mailer.sendMail({
        ...base, to: [u.notify_email], subject: msg.subject, text: msg.text, html: msg.html,
      });
      out.mails++;
      out.recipients += 1;
      log(u, 'mail', true, msg.subject, note || '');
      return true;
    } catch (err) {
      out.errors.push(`${u.notify_email}：${err && err.message ? err.message : err}`);
      log(u, 'mail', false, msg.subject, (err && err.message) || String(err));
      return false;
    }
  };

  /* v4.5.0 需求 5：同一份报表再推一条到企业微信。
     ★ v4.16.0 需求 1：收件人就是上面算好的 wxTos（按账号映射 + 各自推送方式），
       一次 API 调用用 '|' 合并（企业微信按人分别投递，不会互相看到）。
     ★ 不带「今日待办预告」：待办是个人视角，群发会把某人的日程推给全家。
     ★ v4.23.0 需求 4：返回值改为「这一批企微到底成没成」——
       之前失败只记 errors，选「智能」的人那天就彻底收不到（邮件腿因为
       wantMail 被算成 false 而没发）。现在失败时由调用方按人补邮件。 */
  const pushWecom = async (mail) => {
    if (!viaWecom || !wxTos.length) return false;
    let subject = '';
    try {
      const content = reportPushText(mail);
      subject = String((mail && mail.heading) || '');
      const r = await wecom.sendText(wxCfg, { toUser: wxTos.join('|'), content });
      if (!r || r.ok === false) throw new Error((r && (r.errorText || r.error)) || '企业微信发送失败');
      out.wecom = (out.wecom || 0) + 1;
      for (const p of people) if (wantWxOf(p)) log(p.u, 'wecom', true, subject, '');
      return true;
    } catch (err) {
      const why = (err && err.message) || String(err);
      out.errors.push(`企业微信：${why}`);
      for (const p of people) if (wantWxOf(p)) log(p.u, 'wecom', false, subject, why);
      return false;
    }
  };

  /* v4.2.0 需求 5：个人账单与家庭账单**合并成一封**，按原有推送时间发。
     原来每个收件人要收两封（全家一封 + 个人一封），一天两封、月初更多，
     家人已经在抱怨邮件太多。现在每人一封：正文里家庭/个人分板块，文末附今日待办预告。
     发送时刻、幂等键、收件人判定、限额保护全部沿用原逻辑，不产生新的调度路径。 */
  const todayForTodos = String(o.todoKey || todayKey(cfg.tzOffsetMinutes)).slice(0, 10);
  /* v4.12.0 需求 5：附带哪一天，由「报告日的第二天」决定 ——
     · 当天发当天（reportWhen=same_day）：报告日 = 今天 → 附带**明天**的待办
     · 第二天发前一天（next_day）：报告日 = 昨天 → 附带**今天**的待办
     所以标签与空态文案随口径变化，页面上的说明也跟着变（需求原文）。
     ★ 旧实现固定按「今天 +1」，导致 same_day 口径下附带的仍是今天，与「第二天待办」不符。 */
  const reportDay = String(o.dateKey || '').slice(0, 10) || todayForTodos;
  const attachDay = reminders.shiftDateKey(reportDay, 1);
  const sameDayMode = cfg.reportWhen === 'same_day';
  const todoLabel = sameDayMode ? '明日待办预告' : '今日待办预告';
  const todoEmpty = sameDayMode ? '明天没有待办事项。' : '今天没有待办事项。';
  const todosOf = (u) => (cfg.attachTodo ? todoPreviewFor(u.id, attachDay) : null);
  const personalOf = (r, u) => (r.personal.filter((p) => Number(p.user.id) === Number(u.id))[0] || null);

  /** 某个人的日报 / 月报（家庭 + 个人合并成一封） */
  const userMail = (u, r, suffix) => {
    const mine = personalOf(r, u);
    const sections = [{ label: `全家 ${r.title}`, stats: r.family }];
    if (mine) sections.push({ label: `我的 ${r.title}`, stats: mine.stats });
    return reportMail({
      heading: `${r.title} ${suffix}`,
      badge: `个人 + 家庭 · ${config.siteName}`,
      sections,
      todos: todosOf(u),
      todoLabel,
      todoEmpty,
    });
  };

  /* v4.23.0 需求 4：邮件腿的收件人 = 按每个人自己的推送方式算出来的那份。
     auto 的人如果企微发失败，这里会多补一封邮件（见下方 fallback）。 */
  const sendMails = async (r, suffix, wxOk) => {
    for (const p of people) {
      const wantMail = wantMailOf(p);
      /* 「智能」且本轮走企微、但企微整批失败 → 回退邮件。
         ★ 只在 viaMail 有发件能力时才补；没配 SMTP 时补也补不出去，
           错误已经由 pushWecom 记在 errors 里，界面看得见。 */
      const fallback = !wantMail && p.ch === 'auto' && wantWxOf(p) && !wxOk && viaMail;
      if (!wantMail && !fallback) continue;
      if (!p.u.notify_email) continue;
      const msg = userMail(p.u, r, suffix);
      await sendMailOne(p.u, msg, fallback ? '企业微信发送失败，已自动改用邮件送达' : '');
    }
  };

  /* v4.24.0 需求 2：报表同样能推到飞书 / 钉钉群机器人。
     群 Webhook 没有个人视图，所以推的是「全家版」内容（与企微腿同一份 reportPushText）；
     同一条通道无论几个人选都只发一条，按人选逐条写日志（同一结果回填每个人）。 */
  const pushHook = async (mod, hcfg, chName, mail) => {
    const plist = hookTos[chName];
    if (!plist.length) return false;
    const label = chName === 'feishu' ? '飞书' : '钉钉';
    let subject = '';
    try {
      const content = reportPushText(mail);
      subject = String((mail && mail.heading) || '');
      const r = await mod.sendText(hcfg, { content });
      if (!r || r.ok === false) throw new Error((r && (r.errorText || r.error)) || `${label}发送失败`);
      out[chName] = (out[chName] || 0) + 1;
      for (const p of plist) log(p.u, chName, true, subject, '');
      return true;
    } catch (err) {
      const why = (err && err.message) || String(err);
      out.errors.push(`${label}：${why}`);
      for (const p of plist) log(p.u, chName, false, subject, why);
      return false;
    }
  };

  if (o.dateKey) {
    const r = buildDailyReport(o.dateKey);
    const familyMail = {
      heading: `${r.title} 支出日报`,
      badge: `全家 · ${config.siteName}`,
      sections: [{ label: `全家 ${r.title}`, stats: r.family }],
      todos: null,
    };
    // 企微先发：它的成败决定「智能」的人要不要补邮件
    const wxOk = await pushWecom(familyMail);
    await pushHook(feishu, fsCfg, 'feishu', familyMail);
    await pushHook(dingtalk, dtCfg, 'dingtalk', familyMail);
    await sendMails(r, '支出日报', wxOk);
  }

  if (o.month) {
    const r = buildMonthlyReport(o.month);
    const familyMail = {
      heading: `${r.title} 支出月报`,
      badge: `全家 · ${config.siteName}`,
      sections: [{ label: `全家 ${r.title}`, stats: r.family }],
      todos: null,
    };
    const wxOk = await pushWecom(familyMail);
    await pushHook(feishu, fsCfg, 'feishu', familyMail);
    await pushHook(dingtalk, dtCfg, 'dingtalk', familyMail);
    await sendMails(r, '支出月报', wxOk);
  }

  setLastSend(out.errors.length ? `errors:${out.errors.length}` : 'ok', out.errors);
  return out;
}

/**
 * v4.3.3 需求 3：旧库只有 bill_report_last_day（**发送日**）。
 * 升级当天不能因为「幂等键换了」就重发一遍同样的报告。
 * 推导：next_day 模式下那天发的是前一天的报告；same_day 模式下就是当天。
 * 只在 lastKey 为空时用一次，属一次性兼容，之后都走 lastKey。
 */
function legacyLastKey(lastDay, sameDay) {
  const d = String(lastDay || '').slice(0, 10);
  if (!DATE_RE.test(d)) return '';
  return sameDay ? d : reminders.shiftDateKey(d, -1);
}

/** 到点该不该发？纯函数，方便测试固定时间。 */
function duePlan(now, cfg) {
  const tz = cfg.tzOffsetMinutes;
  const today = reminders.wallDateKey(now, tz);
  const yKey = reminders.shiftDateKey(today, -1);
  const wall = new Date(now.getTime() + tz * 60000);
  if (!cfg.enabled) return null;
  const dueMin = Number(cfg.dailyTime.slice(0, 2)) * 60 + Number(cfg.dailyTime.slice(3, 5));
  const nowMin = wall.getUTCHours() * 60 + wall.getUTCMinutes();
  const sameDay = cfg.reportWhen === 'same_day';

  /* v4.3.3 需求 3：补发窗口按「归属日」算，而不是「同一个自然日内」。
     · same_day：窗口只在当天（0~360 分钟）。跨过零点再补发「今天」的报告没有意义
       —— 那一刻「今天」已经变成新的一天，发出去只会是一封空报告。
     · next_day：允许跨零点（对 1440 取模）。NAS 半夜才醒、容器凌晨重启都很常见，
       这时补发「前一天」的日报完全正确；旧版按自然日算，会把这一天的报告直接丢掉。 */
  const diff = sameDay
    ? nowMin - dueMin
    : (((nowMin - dueMin) % 1440) + 1440) % 1440;
  if (diff < 0 || diff > 360) return null;

  const plan = { dateKey: '', month: '' };
  /* 幂等键改成「报告覆盖的那一天」（lastKey），而不是「哪天发的」（lastDay）。
     旧写法在「当天发当天 / 第二天发前一天」之间切换时会误判：
     比如今天 21:00 已按 next_day 发过「昨天」的报告（lastDay = 今天），
     随后切到 same_day，当天剩下的时间里 duePlan 认为「今天已经发过了」，
     于是永远等不到今天的报告 —— 这正是「设了当天发当天、到点却没收到」的根因。 */
  const wantKey = sameDay ? today : yKey;
  const sentKey = cfg.lastKey || legacyLastKey(cfg.lastDay, sameDay);
  if (sentKey !== wantKey) plan.dateKey = wantKey;

  // 每月 1 号（家里人的墙上日期）补发上个月的月报
  if (cfg.monthly && today.slice(8) === '01') {
    const prevMonth = reminders.shiftDateKey(today, -1).slice(0, 7);
    if (cfg.lastMonth !== prevMonth) plan.month = prevMonth;
  }
  if (!plan.dateKey && !plan.month) return null;
  return plan;
}

/** 每分钟一次的检查（server.js 调用；与待办提醒的定时器相互独立） */
let timer = null;
async function tick(now = new Date()) {
  const cfg = loadSettings();
  const plan = duePlan(now, cfg);
  if (!plan) return { sent: false };
  /* v4.3.3 需求 3：失败 / 跳过的重试节流。
     旧版是「无论成功与否都写 lastDay」，目的是避免每分钟重试把邮箱打爆 ——
     副作用是：当天因为没配 SMTP、或还没人填收件邮箱而跳过之后，
     即使随后把这些配好了，当天也**再也不会补发**（用户看到的就是「到点没收到」）。
     现在改成：
       · 确实发出过邮件（mails > 0）→ 写 lastKey，当天不再发；
       · 跳过 / 全部失败 → 只写 lastTry，10 分钟内不再重试。
     节流目的不变，但条件一旦修好，当天仍能补上。 */
  const lastTryMs = Date.parse(cfg.lastTry || '') || 0;
  if (lastTryMs && now.getTime() - lastTryMs < 10 * 60 * 1000) {
    return { sent: false, throttled: true };
  }
  const out = await sendReports(plan);
  const tz = cfg.tzOffsetMinutes;
  const today = reminders.wallDateKey(now, tz);
  /* v4.5.0 需求 5：企业微信推送成功也要算「已发」——
     否则只开企业微信、没配邮箱的家庭会每分钟重推一次（10 分钟节流后就变成刷屏）。
     ★ v4.28.2 修复：判据收进 push.sentAny()，把飞书 / 钉钉也计入。
       旧写法只看 mails + wecom，于是「推送方式全部选了飞书群 / 钉钉群」的家庭
       每次都被判成没发出去 → 写 lastTry → **每 10 分钟重推一次报表**，永不停止。 */
  const delivered = push.sentAny(out);
  if (delivered) {
    if (plan.dateKey) {
      putSetting('bill_report_last_key', plan.dateKey);
      // 老键继续跟着写：万一回滚到 4.3.2，那边看到的仍是「今天已发」，不会重复轰炸
      putSetting('bill_report_last_day', today);
    }
    if (plan.month) putSetting('bill_report_last_month', plan.month);
  } else {
    putSetting('bill_report_last_try', now.toISOString());
  }
  if (out.mails) console.log(`[bill] 已发送记账报表 ${out.mails} 封（收件人 ${out.recipients}）`);
  if (out.wecom) console.log('[bill] 记账报表已推送到企业微信');
  if (out.feishu) console.log('[bill] 记账报表已推送到飞书群');
  if (out.dingtalk) console.log('[bill] 记账报表已推送到钉钉群');
  if (out.skipped) console.warn(`[bill] 记账报表未发送：${out.skipped}（10 分钟后重试）`);
  if (out.errors.length) console.error('[bill] 记账报表发送失败：', out.errors.join('；'));
  return { sent: true, ...out };
}

function start() {
  if (timer) return;
  setTimeout(() => { tick().catch(() => {}); }, 15 * 1000).unref();
  timer = setInterval(() => { tick().catch((err) => console.error('[bill] 报表检查异常：', err && err.message)); }, 60 * 1000);
  timer.unref();
}

module.exports = {
  SETTINGS_DEFAULTS, loadSettings, loadCatRules, saveCatRules,
  // v4.18.0 需求 2：内置关键词表 → 设置框预置文本（「恢复默认」的还原源）
  builtinRulesText: parse.builtinRulesText,
  ensureCategories, listCategories, defaultCategories, addCategory, removeCategory,
  listBudgets, setBudget,
  list, getById, insertBill, update, remove, shape,
  recordFromText, chatRecord, ensureExpenseCategory, checkBudget, systemTextFor,
  // v4.3.2 需求 1：高度相似（疑似重复入账）检测
  findSimilarBill, SIMILAR_WINDOW_DAYS, SIMILAR_SCORE_MIN,
  // v4.9.0 需求 1：微信端同日疑似重复（阻塞式）+ 服务端草稿箱
  findSameDayDuplicate, parseBillForCheck, NEAR_AMOUNT_MIN_CENTS, NEAR_AMOUNT_RATIO, NOTE_SIM_MIN,
  listDrafts, saveDraftFromParsed, submitDraft, deleteDraft,
  // v4.9.0 需求 2：记账日历（按天聚合）
  calendar,
  chatList, pushChat, clearChat, shapeChat,
  DEFAULT_QUICKS, getQuickPhrases, setQuickPhrases, sanitizeQuicks,
  stats, exportCsv, CSV_HEADER,
  /* v4.16.0 需求 6：来源口径（四种来源的固定叫法）+ 报表企业微信收件人算法 */
  SOURCE_CHANNEL_CN, wecomReportRecipients,
  buildDailyReport, buildMonthlyReport, reportText, reportHtml,
  // v4.2.0 需求 5：合并邮件（个人 + 家庭一封）与今日待办预告
  mergeReportText, mergeReportHtml, todoPreviewFor,
  // v4.21.0 需求 1：标题 / 正文 / HTML 一次取全（模板化后的唯一出口）
  reportMail, reportPushText, reportVars,
  sendReports, duePlan, tick, start, getStatus,
  todayKey,
};
