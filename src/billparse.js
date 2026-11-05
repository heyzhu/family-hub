'use strict';
/**
 * 一句话记账的解析（v2.0.0）。
 *
 * 纯函数、零依赖：不碰数据库、不碰网络、不读系统时间（「今天」由调用方传进来）。
 * 这么做有三个好处：
 *   1. 规则可以单独测（金额、收支、分类、日期四条线各测各的）；
 *   2. 服务端、OCR 后处理、以及前端「本地预解析」可以共用同一套规则；
 *   3. 时间相关的断言不会因为「跑测试的那天」而失效。
 *
 * 设计取舍：
 *   - 金额一律换算成**分**（整数）返回给调用方入库，浮点只在本模块内部短暂存在。
 *   - 认不出来就**如实返回 ok:false**，让界面提示「没听懂，请手动补一下」。
 *     绝不猜一个金额出来 —— 记账记错钱比记不上更糟。
 */

/* ── 分类与关键词 ───────────────────────────────────────────
   分类清单是「出厂预置」；管理员可以在记账设置里增删分类（存 bill_categories 表），
   但关键词表是内置的：自定义分类靠「名字被原话提到」直接命中（见 guessCategory）。 */

const DEFAULT_CATEGORIES = {
  expense: ['餐饮', '购物', '交通', '住房', '水电', '通讯', '医疗', '教育', '人情', '娱乐', '日用', '其他'],
  income: ['工资', '奖金', '理财', '红包', '兼职', '报销', '其他收入'],
};

/* ── 分类别名表（v4.3.0 需求 2：结合式分类策略的第二层） ─────────────
   大模型对同一个意思往往给出五花八门的名字（「餐饮」被写成「吃饭 / 饮食 /
   餐饮美食 / 外卖」…），如果不做归并，每识别一次就可能往 bill_categories
   里塞一条新分类，几个月后分类表就没法看了。

   这张表是「别名 → 标准（预置）分类名」。命中即复用现有分类，**不新建**。
   它只在「现有分类里没有完全同名的」时候才起作用 —— 用户自己建过
   「水果」分类时，「水果」这条账单仍然会落到「水果」上（exact 优先）。 */
const CATEGORY_ALIAS = {
  餐饮: ['吃饭', '吃饭喝酒', '饮食', '美食', '餐费', '餐饮美食', '用餐', '外卖', '零食', '水果', '饮料',
    '咖啡', '奶茶', '早餐', '午餐', '晚餐', '夜宵', '酒水', '饭店', '餐厅', '买菜', '食材', '食品'],
  购物: ['买东西', '购物消费', '服饰', '服饰鞋包', '服装', '鞋子', '数码', '数码电器', '家电',
    '化妆品', '护肤', '美妆', '网购', '百货', '母婴'],
  交通: ['出行', '交通出行', '打车', '公共交通', '加油', '油费', '停车', '高速', '过路费', '机票',
    '火车', '高铁', '地铁', '公交', '车费', '骑车', '共享单车', '网约车', '车辆'],
  住房: ['房租', '租金', '物业费', '物业', '房贷', '住房支出', '装修', '家具', '家居', '搬家', '中介'],
  水电: ['水费', '电费', '燃气费', '煤气费', '燃气', '煤气', '取暖费', '暖气费', '水电燃气', '水电煤'],
  通讯: ['话费', '手机费', '电话费', '流量费', '宽带费', '网费', '宽带', '会员', '订阅', '网络', '通信'],
  医疗: ['看病', '医疗健康', '医药', '药品', '挂号', '体检', '牙科', '疫苗', '门诊', '住院', '医院', '保健品'],
  教育: ['学习', '教育培训', '学费', '书本费', '书费', '培训', '补习', '课程', '网课', '考试',
    '报名费', '文具', '幼儿园', '辅导班', '书本', '玩具图书'],
  人情: ['随礼', '份子钱', '礼金', '送礼', '请客', '人情往来', '婚礼', '满月', '压岁钱', '礼物'],
  娱乐: ['休闲', '休闲娱乐', '娱乐消费', '电影', '游戏', '旅游', '门票', '演唱会', '景区', '酒店',
    '住宿', '健身', '唱歌', 'KTV', '娱乐活动', '玩具'],
  日用: ['生活用品', '日用百货', '日用品', '纸巾', '洗护', '清洁', '洗衣', '超市', '垃圾袋',
    '清洁用品', '卫生纸', '家居日用'],
};

/** 归一用的名字清洗：与 bills.ensureExpenseCategory 完全同口径 */
function cleanCategoryName(raw) {
  return String(raw == null ? '' : raw).trim().replace(/[\s,，、]+/g, '').slice(0, 12);
}

/**
 * 三层分类归一（v4.3.0 需求 2）。
 *   ① exact    —— 与现有分类同名，直接用（用户自建分类的最高优先级）
 *   ② alias    —— 命中别名表 → 复用标准分类
 *   ③ contains —— 现有分类名是 AI 名字的子串（「餐饮美食」含「餐饮」），取最长者
 *   ④ new      —— 都不中：matched=false，交由调用方按 strict/auto 模式处理
 *
 * @param {string} raw  模型返回的分类名
 * @param {string[]} existing 现有支出分类名
 * @returns {{name:string, matched:boolean, reason:'exact'|'alias'|'contains'|'new'|'empty'}}
 */
function matchCategory(raw, existing, rules) {
  const name = cleanCategoryName(raw);
  const list = (Array.isArray(existing) ? existing : []).map((x) => String(x || '')).filter(Boolean);
  if (!name) return { name: '', matched: false, reason: 'empty' };
  if (list.indexOf(name) >= 0) return { name, matched: true, reason: 'exact' };
  /* v4.17.0 需求 5：用户自维护的「关键词 → 分类」规则优先于内置别名表 ——
     用户明确写了「外卖 → 餐饮」就不会再被内置表的归属抢走。
     命中取最长关键词（「车厘子」优先于「果」这类短词）。 */
  const ruleHit = (() => {
    const arr = Array.isArray(rules) ? rules : [];
    let best = null;
    for (const r of arr) {
      const cat = cleanCategoryName(r && r.cat);
      for (const kw of (r && Array.isArray(r.kws) ? r.kws : [])) {
        const w = String(kw || '').trim();
        if (!w || !cat) continue;
        if ((name === w || name.indexOf(w) >= 0 || w.indexOf(name) >= 0)
          && (!best || w.length > best.w.length)) best = { w, cat };
      }
    }
    return best;
  })();
  if (ruleHit) return { name: ruleHit.cat, matched: true, reason: 'rule' };
  // 别名：先看整名，再看别名键被包含（「今天吃外卖了」这类脏数据也能救）
  const aliasHit = (() => {
    for (const std of Object.keys(CATEGORY_ALIAS)) {
      const arr = CATEGORY_ALIAS[std];
      if (arr.indexOf(name) >= 0) return std;
      for (const a of arr) if (a && name.indexOf(a) >= 0) return std;
    }
    return '';
  })();
  if (aliasHit && list.indexOf(aliasHit) >= 0) return { name: aliasHit, matched: true, reason: 'alias' };
  // 包含：AI 名字里含某个现有分类名（取最长的，避免「餐」这类短名抢走）
  let best = '';
  for (const c of list) if (c && c !== '其他' && name.indexOf(c) >= 0 && c.length > best.length) best = c;
  if (best) return { name: best, matched: true, reason: 'contains' };
  return { name, matched: false, reason: 'new' };
}

const CATEGORY_KEYWORDS = {
  expense: {
    餐饮: ['饭', '餐', '吃', '早餐', '午餐', '晚餐', '外卖', '奶茶', '咖啡', '火锅', '烧烤', '零食', '水果', '菜', '食堂', '夜宵', '米线', '面', '汉堡', '蛋糕', '饮料', '可乐', '麦当劳', '肯德基'],
    购物: ['购物', '淘宝', '京东', '拼多多', '衣服', '裤子', '鞋', '包', '化妆品', '护肤', '数码', '耳机', '手机', '电脑', '家电', '手机壳', '玩具', '快递', '包包'],
    交通: ['打车', '地铁', '公交', '加油', '油费', '停车', '高铁', '火车', '机票', '飞机', '车费', '过路费', '滴滴', '共享单车', '充卡'],
    住房: ['房租', '租金', '物业', '房贷', '中介', '装修', '家具', '搬家'],
    水电: ['水费', '电费', '燃气', '煤气', '取暖', '暖气', '水电', '物业水'],
    通讯: ['话费', '流量', '宽带', '网费', '手机费', '电话费', '会员', '订阅'],
    医疗: ['医院', '看病', '挂号', '药', '体检', '牙', '疫苗', '门诊', '住院', '医保'],
    教育: ['学费', '书费', '培训', '补习', '课程', '网课', '考试', '报名费', '幼儿园', '辅导'],
    人情: ['红包', '随礼', '份子', '礼金', '送礼', '请客', '人情', '婚礼', '满月', '压岁'],
    娱乐: ['电影', '游戏', 'KTV', '旅游', '门票', '演唱会', '景区', '酒店', '健身', '唱', '玩'],
    日用: ['纸巾', '洗发', '牙膏', '沐浴', '日用', '超市', '洗衣', '清洁', '垃圾袋', '日用品', '卫生纸'],
    其他: [],
  },
  income: {
    工资: ['工资', '薪水', '薪资', '发薪', '月薪'],
    奖金: ['奖金', '年终奖', '绩效', '提成', '奖励'],
    理财: ['理财', '利息', '分红', '基金', '股票', '收益', '存款利息'],
    红包: ['红包', '压岁钱', '转账给我', '收到转账'],
    兼职: ['兼职', '外快', '副业', '接单'],
    报销: ['报销', '退款', '退回', '退还'],
    其他收入: [],
  },
};

/* v4.18.0 需求 2：把内置关键词表序列化成设置框的文本格式（每行「分类：kw1、kw2」）。
   用途：「记账分类与预算 → 自动识别分类规则」的**默认预置内容**与「恢复默认」的还原源 ——
   内置规则不再是看不见的黑盒，用户能直接在预置文本上增删改。
   ★ 只序列化支出表：本应用只记支出（收入分类已下线，addCategory 只收 expense），
     收入内置表继续作底层兜底不外露 —— 收入关键词（理财 / 基金 / 股票…）一旦预置成
     用户规则，会把「买理财 1000」这类支出话术抢到收入分类上（规则层不分收支）。 */
function builtinRulesText() {
  const table = CATEGORY_KEYWORDS.expense || {};
  return Object.keys(table)
    .filter((cat) => Array.isArray(table[cat]) && table[cat].length > 0)
    .map((cat) => `${cat}：${table[cat].join('、')}`)
    .join('\n');
}

/* 收支判定的关键词。注意顺序：先看「收入」再看「支出」，
   因为「退回的报销」这类话里两类词都可能出现，收入词更少见、更应该优先。 */
const INCOME_WORDS = [
  '收入', '收到', '转入', '进账', '到账', '发工资', '发了工资', '工资', '薪水', '奖金', '年终奖',
  '报销', '退款', '退回', '退还', '利息', '分红', '收益', '赚了', '卖了', '卖掉', '兼职', '外快',
  '压岁钱', '补贴', '养老金', '公积金', '提成', '收款', '别人还我', '还我钱', '红包收',
];
const EXPENSE_WORDS = [
  '支出', '花了', '花', '买了', '买', '付了', '付款', '付', '交了', '交', '充了', '充值', '消费',
  '请客', '打车', '外卖', '还款', '还钱', '借出', '转账给', '给了', '缴费', '扣款', '用了',
];

/* ── 中文数字 ───────────────────────────────────────────────
   家里长辈很可能会打「一百二」「两千三」这种。只支持到万，够用且不容易猜错。 */

const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 两: 2, 贰: 2, 三: 3, 叁: 3, 四: 4, 肆: 4, 五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9 };
const CN_UNIT = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000, 万: 10000, 萬: 10000 };

/**
 * 中文数字 → 阿拉伯数字。认不出来返回 null。
 * 支持：十二 / 二十 / 一百二 / 两千三 / 一万二 / 三百零五 / 十五块五
 */
function cnToNumber(s) {
  const str = String(s || '');
  if (!str) return null;
  let total = 0;      // 已经结算完的「万」以上部分
  let section = 0;    // 当前节（万以下）
  let num = 0;        // 当前位的数字
  let seen = false;
  for (const ch of str) {
    if (Object.prototype.hasOwnProperty.call(CN_DIGIT, ch)) {
      num = CN_DIGIT[ch];
      seen = true;
    } else if (Object.prototype.hasOwnProperty.call(CN_UNIT, ch)) {
      const unit = CN_UNIT[ch];
      seen = true;
      if (unit === 10000) {
        // 「一百二十万」：section 此时已经攒够 120，直接结算成 120 * 10000
        total = (total || 0) + (section + num) * 10000;
        section = 0;
        num = 0;
      } else {
        if (num === 0 && unit === 10) num = 1;       // 「十二」= 12
        section += (num || 1) * unit;
        num = 0;
      }
    } else if (/\s/.test(ch)) {
      continue;
    } else {
      return null;                                    // 混进不认识的字 → 整串不认
    }
  }
  if (!seen) return null;
  return total + section + num;
}

/* ── 金额 ─────────────────────────────────────────────────── */

/* 数字部分：先认「千分位」写法（1,200 / 12,000.50），再退回普通写法。
   ★ 千分位必须整体吃掉，不能靠「先匹配到 1 再匹配到 200」：两个候选打分相近，
     而取分规则是「同分取靠后的」，于是「房租 1,200」会被记成 200 元 —— 差一个数量级。 */
const AMOUNT_NUM = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)';
const AMOUNT_RE = new RegExp(`([¥￥]|rmb|RMB)?\\s*${AMOUNT_NUM}\\s*(万|k|K|千|块钱|块|元|角|毛|分)?`, 'g');
/* 「553块5」「12块5毛」= 553.5 元 —— 中文口语里「块」后面的个位数是「角」。
   单独一条正则先处理，否则通用规则会只吃掉「553块」而把尾巴的 5 丢掉。 */
const BLOCK_JIAO_RE = /(\d+(?:\.\d{1,2})?)\s*(?:块钱|块|元)\s*([零〇一二两三四五六七八九\d])\s*(?:角|毛)?/;
const CN_AMOUNT_RE = /([零〇一壹二两贰三叁四肆五伍六陆七柒八捌九玖十拾百佰千仟万萬]+)\s*(万|千|块钱|块|元|角|毛)?/g;

/** 元 → 分（四舍五入到分，避免 0.1+0.2 式误差进库） */
const toCents = (yuan) => Math.round(Number(yuan) * 100);
const toYuan = (cents) => Math.round(Number(cents)) / 100;

/**
 * 从一句话里找金额。
 * @returns {{cents:number, raw:string, index:number}|null}
 */
function findAmount(text) {
  const s = String(text || '');
  let best = null;

  // 0) 「12块5」这类整数带零头：先单独认，认到就直接返回（它就是最完整的那个金额）
  const jiao = BLOCK_JIAO_RE.exec(s);
  if (jiao) {
    const head = Number(jiao[1]);
    const tailNum = /^\d$/.test(jiao[2]) ? Number(jiao[2]) : cnToNumber(jiao[2]);
    if (Number.isFinite(head) && tailNum != null) {
      // tailNum 是「角」：5 角 = 50 分
      return { cents: toCents(head) + Math.round(tailNum * 10), raw: jiao[0], index: jiao.index };
    }
  }

  AMOUNT_RE.lastIndex = 0;
  let m;
  while ((m = AMOUNT_RE.exec(s))) {
    const symbol = m[1];
    const numStr = m[2].replace(/,/g, '');      // 千分位只是写法，「1,200」= 1200
    const unit = m[3] || '';
    let value = Number(numStr);
    if (!Number.isFinite(value)) continue;
    if (unit === '万') value *= 10000;
    else if (unit === 'k' || unit === 'K' || unit === '千') value *= 1000;
    else if (unit === '角' || unit === '毛') value /= 10;

    /* 打分：带货币符号或单位的更可信；带小数点的更可信；
       纯数字最短的优先（「3 个鸡蛋 12 元」应该取 12 而不是 3）。
       同一个位置只保留一条。 */
    let score = 0;
    if (symbol) score += 3;
    if (unit && unit !== '分') score += 3;
    if (numStr.indexOf('.') >= 0) score += 2;
    // 前后有没有非数字字符（孤立数字更可能是金额）
    const before = s[m.index - 1];
    const after = s[m.index + m[0].length];
    if (/(^|[^\d])/.test(before === undefined ? '' : before)) score += 1;
    if (after === undefined || !/\d/.test(after)) score += 1;
    // 太长的整数（如 20261008）不像金额
    if (!unit && !symbol && numStr.replace(/\..*$/, '').length >= 7) score -= 3;

    const hit = { cents: toCents(value), raw: m[0].trim(), index: m.index, score };
    // 同分时取**靠后**的那个：中文里金额通常落在句尾（「买菜 30」），
    // 而句首出现的数字更可能是「3 斤」「2 个」这种数量词。
    if (!best || hit.score >= best.score) best = hit;
  }

  // 中文数字：只在没有任何阿拉伯金额时才尝试（避免「一百二」里的「十二」被误读）
  if (!best) {
    CN_AMOUNT_RE.lastIndex = 0;
    while ((m = CN_AMOUNT_RE.exec(s))) {
      const n = cnToNumber(m[1]);
      if (n == null) continue;
      let value = n;
      const unit = m[2] || '';
      if (unit === '万') value *= 10000;
      else if (unit === '千') value *= 1000;
      const hit = { cents: toCents(value), raw: m[0].trim(), index: m.index, score: 1 };
      if (!best) best = hit;
    }
  }
  if (!best || best.cents <= 0) return null;
  return { cents: best.cents, raw: best.raw, index: best.index };
}

/* ── 收支方向 ─────────────────────────────────────────────── */

/** @returns {'income'|'expense'|null} null = 两类词都没有说 */
function findKind(text) {
  const s = String(text || '');
  for (const w of INCOME_WORDS) if (s.indexOf(w) >= 0) return 'income';
  for (const w of EXPENSE_WORDS) if (s.indexOf(w) >= 0) return 'expense';
  return null;
}

/* ── 分类 ─────────────────────────────────────────────────── */

/**
 * 猜分类。
 * @param {string} text 原话（或 OCR 文本）
 * @param {'income'|'expense'} kind
 * @param {string[]} [extra] 管理员自建的分类名（命中名字本身即归类）
 * @param {Array<{cat:string,kws:string[]}>} [rules] 用户自维护的「关键词 → 分类」规则
 *   （v4.17.0 需求 5）。优先级：自带分类名 → 用户规则 → 内置关键词表。
 */
function guessCategory(text, kind, extra, rules) {
  const s = String(text || '');
  const table = CATEGORY_KEYWORDS[kind] || {};
  // 先试「自带分类名」：用户自己写了分类名（含管理员新建的），最可信
  const names = (DEFAULT_CATEGORIES[kind] || []).concat(Array.isArray(extra) ? extra : []);
  for (const name of names) {
    if (name && name !== '其他' && name !== '其他收入' && s.indexOf(name) >= 0) return name;
  }
  // 再试用户规则：命中越长的关键词越可信（与内置表同一套打分口径）
  let best = '';
  let bestLen = 0;
  for (const r of (Array.isArray(rules) ? rules : [])) {
    const cat = cleanCategoryName(r && r.cat);
    if (!cat) continue;
    for (const kw of (r && Array.isArray(r.kws) ? r.kws : [])) {
      const w = String(kw || '').trim();
      if (w && s.indexOf(w) >= 0 && w.length > bestLen) { best = cat; bestLen = w.length; }
    }
  }
  if (best) return best;
  // 最后按内置关键词打分（命中越长的词越可信，「水电」优先于「水」）
  for (const name of Object.keys(table)) {
    for (const kw of table[name]) {
      if (kw && s.indexOf(kw) >= 0 && kw.length > bestLen) { best = name; bestLen = kw.length; }
    }
  }
  return best || (kind === 'income' ? '其他收入' : '其他');
}

/* ── 用户自维护的分类规则（v4.17.0 需求 5）────────────────── */

/**
 * 解析 / 校验分类规则。两种入参都认：
 *   · 字符串：界面 textarea 的格式，每行一条「分类：关键词1、关键词2」；
 *   · 数组：API JSON 形态 [{cat, kws}]，kws 可为字符串（分隔符同上）或数组。
 * @returns {Array<{cat:string,kws:string[]}>} 归一后的规则（空规则剔除）
 * @throws {Error} 格式不合法时抛中文错误（api 层直接转 400）
 */
function parseCatRules(raw) {
  /** 单条关键词的合法性：1–20 个字，不能带分隔符/冒号（会被误拆） */
  const KW_BAD = /[:：]/;
  let entries = [];
  if (typeof raw === 'string') {
    entries = raw.split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const idx = line.search(/[:：]/);
        if (idx < 0) throw new Error(`规则「${line.slice(0, 20)}」缺少冒号：请写成「分类：关键词1、关键词2」`);
        return { cat: line.slice(0, idx), kws: line.slice(idx + 1) };
      });
  } else if (Array.isArray(raw)) {
    entries = raw.map((r) => ({
      cat: r && typeof r === 'object' ? String(r.cat || r.category || '') : String(r || ''),
      kws: r && typeof r === 'object'
        ? (Array.isArray(r.kws) ? r.kws.join('、') : String(r.kws == null ? '' : r.kws))
        : '',
    }));
  } else if (raw != null) {
    throw new Error('分类规则格式不正确');
  }
  if (entries.length > 50) throw new Error('分类规则最多 50 条');
  const out = [];
  for (const e of entries) {
    const cat = cleanCategoryName(e.cat);
    if (!cat) throw new Error('规则里的分类名不能为空');
    const kws = String(e.kws || '').split(/[、,，;；\s]+/).map((w) => w.trim()).filter(Boolean);
    if (!kws.length) throw new Error(`分类「${cat}」至少要写一个关键词（留空就删掉这一行）`);
    for (const w of kws) {
      if (w.length > 20) throw new Error(`关键词「${w.slice(0, 10)}…」超过 20 个字`);
      if (KW_BAD.test(w)) throw new Error(`关键词「${w}」里不能有冒号`);
    }
    out.push({ cat, kws });
  }
  // 同一分类的重复行合并（用户分两行写同一个分类是常见操作）
  // ★ 花括号不能省：一行写成 if/for/if 时，else 会被解析到最内层 if 上（悬垂 else），
  //   结果「新分类」永远进不了 merged —— 正是首跑全绿的假象下藏着的真 bug。
  const merged = [];
  for (const r of out) {
    const prev = merged.find((x) => x.cat === r.cat);
    if (prev) {
      for (const w of r.kws) {
        if (prev.kws.indexOf(w) < 0) prev.kws.push(w);
      }
    } else {
      merged.push(r);
    }
  }
  return merged;
}

/* ── 日期 ─────────────────────────────────────────────────── */

const DAY_WORDS = [['大前天', -3], ['前天', -2], ['昨天', -1], ['昨儿', -1], ['今儿', 0], ['今天', 0], ['刚刚', 0], ['刚才', 0]];

/**
 * 从话里找记账日期。
 * @param {string} text
 * @param {string} todayKey 'YYYY-MM-DD'（由调用方按家里人所在时区算好传进来）
 * @returns {{dateKey:string, raw:string}|null} 没提到就返回 null（调用方按今天算）
 */
function findDate(text, todayKey) {
  const s = String(text || '');
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(todayKey || '')) ? String(todayKey) : '';
  for (const [w, delta] of DAY_WORDS) {
    if (s.indexOf(w) >= 0 && today) return { dateKey: shiftKey(today, delta), raw: w };
  }
  // 8 月 3 日 / 8月3号 / 08-03
  let m = /(\d{1,2})\s*[月\-/]\s*(\d{1,2})\s*[日号]?/.exec(s);
  if (m && today) {
    const mm = Number(m[1]);
    const dd = Number(m[2]);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      let y = Number(today.slice(0, 4));
      const key = `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      // 记账是「过去发生的事」：算出未来日期说明是去年的（比如 1 月说「12 月 30 日」）
      if (key > today) y -= 1;
      return { dateKey: `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`, raw: m[0] };
    }
  }
  return null;
}

function shiftKey(key, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/* ── 备注：把金额、日期这些「已经抽走的信息」从句子里摘掉 ──── */

/* 「已经消费掉的动词」：金额与收支方向都取走了，这些词里没有半点商品信息。
   不摘掉的话备注会变成「花了 买水果」这种读起来别扭的句子。
   ★ 刻意只收「本身不含商品含义」的词 —— 像「买了」就不收：
     「买了双鞋」摘掉「买了」会变成「双鞋」，反而更难读。 */
const NOTE_NOISE = ['花了', '花费', '花销', '付了', '交了', '充了', '消费了', '总共', '一共'];

function stripNote(text, tokens) {
  let s = String(text || '');
  for (const t of tokens) {
    if (!t) continue;
    const i = s.indexOf(t);
    if (i < 0) continue;
    // 只摘第一次出现的那个（同一句话里重复出现同一个词很少见，全摘反而会改语义）
    s = s.slice(0, i) + ' ' + s.slice(i + t.length);
  }
  // 语气词/无信息动词可以全摘：它们摘掉后不影响读起来的意思
  s = s.replace(new RegExp(NOTE_NOISE.join('|'), 'g'), ' ');
  return s
    .replace(/[¥￥]/g, ' ')
    /* ★ 这里**不能**把半角句点当成标点删掉：「58.5」会被拆成「58 5」，
       下一步再去找金额就会挑中尾巴那个 5，把 58.5 记成 5 元 —— 记错钱比记不上更糟。 */
    .replace(/[，,。、；;：:!！?？~～]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/* ── 对外主入口：一句话记账 ───────────────────────────────── */

/**
 * 解析「一句话记账」。
 * @param {string} text 用户输入
 * @param {{todayKey?:string, extraCategories?:string[]}} [opts]
 * @returns {{ok:boolean, amountCents:number, kind:'income'|'expense',
 *            category:string, note:string, dateKey:string, raw:string, reason:string}}
 */
function parseBillText(text, opts) {
  const o = opts || {};
  const raw = String(text == null ? '' : text).trim().slice(0, 500);
  const today = o.todayKey || '';
  /* ★ 先把日期片段摘掉再找金额：否则「8月3日买菜30」里会先撞上日期里的 8 和 3
     （三个候选同分，取靠后的那个仍然可能挑中「3」）。 */
  const d = findDate(raw, today);
  const scan = d ? stripNote(raw, [d.raw]) : raw;
  const amount = findAmount(scan);
  if (!amount) {
    return { ok: false, amountCents: 0, kind: 'expense', category: '其他', note: raw, dateKey: today, raw, reason: '没找到金额' };
  }
  const kind = findKind(raw) || 'expense';       // 没说明就按支出算（绝大多数记账是支出）
  const category = guessCategory(raw, kind, o.extraCategories, o.rules);
  const note = stripNote(raw, [d ? d.raw : '', amount.raw]) || category;
  return {
    ok: true,
    amountCents: amount.cents,
    kind,
    category,
    note,
    dateKey: d ? d.dateKey : (today || ''),
    raw,
    reason: '',
  };
}

/**
 * 解析 OCR 出来的账单截图文本。
 *
 * 截图里通常是「微信支付 / 支付宝」的账单详情，关键信号有两类：
 *   1. 带 ¥ / ￥ / 元 的数字（金额）；
 *   2. 带正负号的数字（-12.50 = 支出，+12.50 = 收入，微信与支付宝都是这个约定）。
 * 金额取「绝对值最大的那个带货币信号/小数位的数字」——账单里常混着
 * 交易单号、时间、余额，纯数字一大堆，取第一个必然出错。
 *
 * @param {string} text OCR 全文
 * @param {{todayKey?:string, extraCategories?:string[]}} [opts]
 * @returns {{ok:boolean, amountCents:number, kind:'income'|'expense', category:string,
 *            note:string, dateKey:string, raw:string, reason:string, candidates:number}}
 */
function parseOcrText(text, opts) {
  const o = opts || {};
  const raw = String(text == null ? '' : text).trim().slice(0, 4000);
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  let best = null;
  for (const line of lines) {
    // 优先「¥12.50 / ￥12.50 / -12.50 / +12.50 / 12.50元」
    const m = /([+\-]?)\s*(?:[¥￥]\s*)?(\d{1,7}(?:\.\d{1,2})?)\s*(?:元)?/.exec(line);
    if (!m) continue;
    const value = Number(m[2]);
    if (!Number.isFinite(value) || value <= 0) continue;
    let score = 0;
    if (/[¥￥]/.test(line)) score += 3;
    if (m[1] === '-' || m[1] === '+') score += 3;
    if (/\.\d\d/.test(m[2])) score += 2;
    if (/元/.test(line)) score += 2;
    // 「余额 / 收款方 / 单号 / 时间」这些行里的数字要压权重
    if (/余额|可用|单号|订单|时间|尾号|卡号|笔数/.test(line)) score -= 5;
    if (/金额|合计|总计|实付|实收|支付金额|收款金额/.test(line)) score += 4;
    if (value > 1000000) score -= 4;
    if (!best || score > best.score) best = { cents: toCents(value), score, sign: m[1], line };
  }

  if (!best || best.cents <= 0) {
    return { ok: false, amountCents: 0, kind: 'expense', category: '其他', note: lines.join(' ').slice(0, 200), dateKey: o.todayKey || '', raw, reason: '没在截图里找到金额', candidates: 0 };
  }

  // 方向：① 数字前缀的 +/- 最可信；② 其次看「收入 / 付款」这类明确的措辞；
  // ③ 都没有才退回通用关键词。
  /* ★ 必须先把「收款方 / 付款方 / 商户」这类**角色词**摘掉再判方向：
     截图里几乎每张都有「收款方：美团外卖」，「收款」会命中收入关键词，
     于是每一笔外卖都被记成收入 —— 这是最容易踩、也最难发现的坑。 */
  const kindText = raw.replace(/收款方|付款方|收款账[户号]|交易对象|商户全称|商户|对方|账户/g, '');
  let kind = null;
  if (best.sign === '-') kind = 'expense';
  else if (best.sign === '+') kind = 'income';
  if (!kind) {
    if (/已收款|收款成功|到账|收入|退款|退回/.test(kindText)) kind = 'income';
    else kind = findKind(kindText) || 'expense';
  }

  // 商户/备注：优先「收款方 / 商户 / 商品 / 备注」这类标签行
  let note = '';
  const labelRe = /(?:收款方|商户全称|商户|商品|交易对象|付款方|备注|摘要|说明)\s*[:：]?\s*(.+)/;
  for (const line of lines) {
    const m = labelRe.exec(line);
    if (m && m[1].trim()) { note = m[1].trim(); break; }
  }
  if (!note) {
    // 退而求其次：找一行不含数字、且不是常见标题的短文本
    for (const line of lines) {
      if (/\d/.test(line)) continue;
      if (/微信支付|支付宝|银行|账单详情|交易详情|收支|支付成功|已支付|已收款|收款|支出|收入|付款|完成|成功/.test(line)) continue;
      if (line.length >= 2 && line.length <= 30) { note = line; break; }
    }
  }
  const category = guessCategory(`${note} ${raw}`, kind, o.extraCategories, o.rules);
  const d = findDate(raw, o.todayKey || '');

  return {
    ok: true,
    amountCents: best.cents,
    kind,
    category,
    note: note || category,
    dateKey: d ? d.dateKey : (o.todayKey || ''),
    raw,
    reason: '',
    candidates: lines.length,
  };
}

/* ── OCR 多条目提取（v2.0.2）───────────────────────────────
   用户上传的多数是「账单列表截图」（微信月账单 / 支付宝收支明细），
   一张图里动辄十几笔。旧逻辑 parseOcrText 只挑「金额最可信的一条」，
   其余全部漏掉。parseOcrItems 按**行**扫描，把每一笔都提出来：
     · 日期行（9月30日 / 2026-09-30）→ 给后续条目当默认日期；
     · 标题行（不含数字的短文本）→ 攒起来当条目的备注；
     · 金额行（-25.50 / ¥25.50 / 25.50元）→ 生成一笔支出；
     · 合计 / 余额 / 单号 / 标注「收入」的行 → 跳过（收入也不再记账，只计数告知）。
   认不出的行一律忽略 —— 宁可漏一条让用户手动补，也不能把单号当成金额记进账。 */

/* 汇总行 / 元信息行：一律不当账目。★ 刻意包含「金额 / 实付 / 订单金额」——
   账单详情页那种带标签的行交给旧逻辑 parseOcrText 兜底；本函数专注列表截图。
   ★ ^支出：月账单顶部的「支出 ¥3,456.78」是整月汇总，绝不能当成一笔账
   （否则每张截图都会多出一条巨大金额）。^收入 不在这里跳：
   它要走下面的收入分支**计数**后跳过，好让用户知道有几笔收入被略过了。 */
const OCR_SKIP_RE = /微信支付|支付宝|云闪付|账单|收支统计|本月|合计|总计|结余|余额|零钱|零钱通|银行卡|可用额度|单号|订单|商户单号|交易单号|付款时间|交易时间|创建时间|当前状态|交易状态|对方账户|收款方|付款方|商户|商品说明|支付方式|交易分类|收付款|优惠券|红包记录|二维码|支付成功|收款成功|退款成功|已完成|已全额退款|查看|明细|统计|导出|常见问题|笔数|金额|实付|实收|我的账单|^支出/;

/* 一行里的金额 token：可选正负号 + 可选 ¥ + 数字（支持千分位）+ 可选「元/块」 */
const OCR_AMOUNT_RE = /([+＋\-−–])?\s*(?:[¥￥]\s*)?(\d{1,7}(?:,\d{3})*(?:\.\d{1,2})?)\s*(元|块)?/;

/**
 * 从 OCR 文本里提取**全部**账单条目。
 * @param {string} text OCR 全文（逐行）
 * @param {{todayKey?:string, extraCategories?:string[]}} [opts]
 * @returns {{ok:boolean, items:Array<{amountCents:number, kind:'expense', category:string,
 *            note:string, dateKey:string, raw:string}>, skippedIncome:number, raw:string, reason:string}}
 */
function parseOcrItems(text, opts) {
  const o = opts || {};
  const raw = String(text == null ? '' : text).trim().slice(0, 4000);
  const lines = raw.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const items = [];
  let skippedIncome = 0;
  let currentDate = '';
  const pendingNotes = [];
  const pushNote = (s) => { pendingNotes.push(s); if (pendingNotes.length > 3) pendingNotes.shift(); };

  for (const line of lines) {
    /* ① 独立的日期行：「9月30日」「2026-09-30」「10月1日 08:12」。
       判据：能解析出日期，且把数字/日期单位/时间分隔符摘掉后几乎不剩字 ——
       这样「9月30日买了水果」不会被当成日期行吞掉。 */
    const d = findDate(line, o.todayKey || '');
    if (d && line.replace(/\d|[年月日\-/:时点分秒\s]/g, '').length <= 2) {
      currentDate = d.dateKey;
      continue;
    }
    /* ② 汇总行 / 元信息行：不是账目，绝不入账 */
    if (OCR_SKIP_RE.test(line)) continue;

    /* ③ 找金额：要有「钱的信号」才认 —— 带正负号 / 带 ¥ / 带「元」/ 两位小数。
       纯整数（「3 件」「12:30」）没有信号，一律不认。 */
    const m = OCR_AMOUNT_RE.exec(line);
    let amountCents = 0;
    let sign = '';
    if (m) {
      const value = Number(m[2].replace(/,/g, ''));
      const hasSignal = !!(m[1] || m[3] || /[¥￥]/.test(line) || /\d+\.\d{1,2}\b/.test(m[2]));
      if (Number.isFinite(value) && value > 0 && hasSignal) {
        amountCents = toCents(value);
        sign = m[1] || '';
      }
    }
    if (!amountCents) {
      // 没金额：像标题/备注的短行攒起来，给下一条金额行当备注（OCR 常把「标题 / 金额」拆成两行）
      if (!/\d/.test(line) && line.length >= 2 && line.length <= 30) pushNote(line);
      continue;
    }

    /* ④ 收入行跳过（只计数告知）：带 + 号、或明确写「收入 / 收款 / 到账」。
       v2.0.2 只记支出，收入方向的东西既不能入账也不该静默消失。 */
    if (sign === '+' || sign === '＋' || /收入|已收款|到账|收款/.test(line)) {
      skippedIncome++;
      pendingNotes.length = 0;
      continue;
    }

    /* ⑤ 生成一笔支出。备注 = 攒下来的标题行 + 同行金额以外的文字。 */
    const inlineNote = (line.slice(0, m.index) + ' ' + line.slice(m.index + m[0].length))
      .replace(/[¥￥+＋\-−–]/g, ' ').replace(/\s+/g, ' ').trim();
    const note = [pendingNotes.join(' '), inlineNote].join(' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    const noteText = note === '其他' ? '' : note;
    items.push({
      amountCents,
      kind: 'expense',
      category: guessCategory(noteText || line, 'expense', o.extraCategories, o.rules),
      note: noteText,
      dateKey: currentDate || o.todayKey || '',
      raw: line,
    });
    pendingNotes.length = 0;
    if (items.length >= 50) break;          // 疯狂截图的保险丝，防止把一次导入变成几百笔
  }

  /* 去重：同金额 + 同备注 + 同日期 的只留一条（OCR 偶尔会把一行重排成两行） */
  const seen = new Set();
  const deduped = items.filter((it) => {
    const k = `${it.amountCents}|${it.note}|${it.dateKey}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    ok: deduped.length > 0,
    items: deduped,
    skippedIncome,
    raw,
    reason: deduped.length ? '' : '没在截图里找到可记账的条目',
  };
}

/* ── CSV ──────────────────────────────────────────────────── */

/**
 * CSV 单元格转义。
 * ★ 防「CSV 注入」：以 = + - @ 开头的内容在 Excel 里会被当公式执行，
 *   前面补一个单引号（这也是各家导出功能的标准做法）。
 */
function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** 把二维数组拼成 CSV 文本（不含 BOM，BOM 由导出方按需加） */
function toCsv(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => (Array.isArray(r) ? r : [r]).map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const fmtYuan = (cents) => (Math.round(Number(cents) || 0) / 100).toFixed(2);

module.exports = {
  DEFAULT_CATEGORIES, CATEGORY_KEYWORDS, CATEGORY_ALIAS, matchCategory, cleanCategoryName, parseCatRules,
  builtinRulesText,
  INCOME_WORDS, EXPENSE_WORDS,
  cnToNumber, findAmount, findKind, findDate, guessCategory,
  parseBillText, parseOcrText, parseOcrItems, stripNote,
  csvCell, toCsv, fmtYuan, toCents, toYuan, shiftKey,
};
