/* 重复事项的落点计算（每年 / 每月 × 公历 / 农历）
 *
 * 只保留这一份实现，浏览器与服务端共用：
 *   - 前端：万年历把重复事项展开到对应的一天
 *   - 服务端：提醒调度判断「今天是不是某条重复事项的落点」
 * 两边规则必须完全一致，否则会出现「日历上看得见、提醒却不发」这类错位。
 *
 * 基准日就是事项自己的 todo_date：那一次就是原事项本身，不算「继承出来的落点」。
 *
 * ★ v1.9.0 新增按月重复：
 *   - solar_monthly  每月公历同一日；某月没有这一天时（如 31 日遇 4 月）**顺延到该月最后一天**，
 *                    宁可提前一点也不要整月错过 —— 与「2 月 29 日遇平年取 2 月 28 日」同一套取舍。
 *   - lunar_monthly  每月农历同一日；该农历月没有这一天时（如「三十」遇 29 天的小月）**跳过该月**，
 *                    农历没有「月末顺延」的习惯说法，硬凑到廿九反而会让人认错日子。
 *   与年度规则最大的差别：**月度规则在基准年当年就要展开基准日之后的那些月份**，
 *   否则「3 月建的交房租，4 月之后当年都不提醒」。
 *
 * ★ v2.0.0 新增按周重复：
 *   - solar_weekly   每周同一星期几（星期几由基准日决定）。周是公历概念，
 *                    所以没有「农历每周」这种规则。与月度规则一样，
 *                    基准年当年就要展开基准日之后的那些周。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./lunar.js').Lunar);
  } else {
    root.Repeat = factory(root.Lunar);
  }
})(typeof window !== 'undefined' && window ? window : globalThis, function (Lunar) {
  'use strict';

  var pad = function (n) { return String(n).padStart(2, '0'); };
  var WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

  /* ★ 入参有两种形状，必须都认：
       - 前端：接口返回的 todo，字段是 date / repeat
       - 服务端：SQLite 的原始行，字段是 todo_date / repeat
     只认其中一种的话，服务端会静默地把所有重复事项都算成「没有落点」，
     表现就是「日历上看得到、提醒永远不发」。
   ★ v4.10.0（A4=①）：规则读取统一走「repeat_rule 优先、repeat 翻译回落」，
     返回的是**新枚举名**（daily/weekly/monthly_solar/monthly_lunar/yearly_solar/yearly_lunar）。
     repeat_rule 是唯一真相；旧 repeat 是 CHECK 兼容列（daily 在旧枚举里不存在，只能写 ''）。 */
  function baseDate(todo) { return todo ? (todo.date || todo.todo_date || '') : ''; }
  var LEGACY_RULE = {
    solar_weekly: 'weekly',
    solar_monthly: 'monthly_solar',
    lunar_monthly: 'monthly_lunar',
    solar_yearly: 'yearly_solar',
    lunar_yearly: 'yearly_lunar',
  };
  function rule(todo) {
    if (!todo) return '';
    /* ★ v4.19.0 需求 2-1（bug 修复）：还要认**驼峰 `repeatRule`** ——
       接口 shapeTodo 下发的是 `repeatRule`（新枚举唯一真相），库里那列才叫 `repeat_rule`。
       旧写法只看下划线字段，于是「每天」这种**只存在于新枚举**的规则（旧 repeat 列只能写 ''）
       被当成一次性事项：既混进「待办列表」（那一行 meta 是单行裁切的，信息看着不全），
       又进不了「周期提醒」卡。加上驼峰分支后，每天/每周等规则在前端判定才与库一致。 */
    var precise = String(todo.repeat_rule || todo.repeatRule || '');
    if (precise) return precise;
    var legacy = String(todo.repeat || '');
    return LEGACY_RULE[legacy] || legacy;
  }

  /** 全部重复规则（新增规则时这里与 RULE_LABEL 一起改，别只改一处） */
  var REPEATS = ['daily', 'weekly', 'monthly_solar', 'monthly_lunar', 'yearly_solar', 'yearly_lunar'];
  var RULE_LABEL = {
    daily: '每天',
    weekly: '每周（公历）',
    monthly_solar: '每月（公历）',
    monthly_lunar: '每月（农历）',
    yearly_solar: '每年（公历）',
    yearly_lunar: '每年（农历）',
  };

  var isMonthly = function (repeat) {
    return repeat === 'monthly_solar' || repeat === 'monthly_lunar';
  };

  var isWeekly = function (repeat) {
    return repeat === 'weekly';
  };

  var isDaily = function (repeat) {
    return repeat === 'daily';
  };

  /* 这些规则的「基准年当年」也要展开基准日之后的落点：
     月度（4 月之后还有 8 个月）、周度（本周之后还有 50 多个周）与每天（明天起天天都是）
     都是「当年会再来很多次」，只展开基准年之后的话，会出现「3 月建的交房租，当年 4 月起就不提醒」。 */
  var sameYearRules = function (repeat) {
    return isMonthly(repeat) || isWeekly(repeat) || isDaily(repeat);
  };

  function parseKey(key) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
    return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
  }

  /** 公历某年某月的天数（1-12 月） */
  function solarMonthDays(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  /**
   * 该重复事项在指定公历年的落点（日期键数组，升序）。
   * 不含基准日当天那一次（它就是原事项本身）；无落点返回空数组。
   */
  function occurrencesInYear(todo, year) {
    var repeat = rule(todo);
    var date = baseDate(todo);
    if (!todo || !repeat || !date) return [];
    if (REPEATS.indexOf(repeat) < 0) return [];
    var base = parseKey(date);
    if (!base) return [];
    if (!(base.y > 1900 && year <= 2100)) return [];

    // 年度规则只展开「基准年之后」的年份；月度 / 周度规则还要覆盖基准年当年剩下的落点（见文件头说明）
    if (year < base.y) return [];
    if (year === base.y && !sameYearRules(repeat)) return [];
    var out = [];
    var i;

    if (repeat === 'weekly') {
      // 周几由基准日决定（周日 = 0）。先算出该年 1 月 1 日之后的第一个同一星期几，
      // 再逐周 +7 天。全部用 UTC 运算，避免依赖进程时区。
      var wd = new Date(Date.UTC(base.y, base.m - 1, base.d)).getUTCDay();
      var jan1 = Date.UTC(year, 0, 1);
      var first = jan1 + ((wd - new Date(jan1).getUTCDay() + 7) % 7) * 86400000;
      for (var cur = first; ; cur += 7 * 86400000) {
        var dcur = new Date(cur);
        if (dcur.getUTCFullYear() !== year) break;
        var wk = dcur.getUTCFullYear() + '-' + pad(dcur.getUTCMonth() + 1) + '-' + pad(dcur.getUTCDate());
        if (wk > date) out.push(wk);
      }
      return out;
    }

    if (repeat === 'daily') {
      // 每天：基准日（含）之后的每一天都是落点。用 UTC 逐日推进，一年最多 366 项，
      // occurrencesInYear 只在「判断某个具体日期 / 找下一个落点」时被调用，量级完全可控。
      var start = (year === base.y)
        ? Date.UTC(base.y, base.m - 1, base.d)
        : Date.UTC(year, 0, 1);
      for (var dd = start + 86400000; ; dd += 86400000) {
        var dd2 = new Date(dd);
        if (dd2.getUTCFullYear() !== year) break;
        out.push(dd2.getUTCFullYear() + '-' + pad(dd2.getUTCMonth() + 1) + '-' + pad(dd2.getUTCDate()));
      }
      return out;
    }

    if (repeat === 'yearly_solar') {
      // 2 月 29 日：平年顺延到 2 月 28 日，尽量不错过
      if (base.m === 2 && base.d === 29) {
        var leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
        return [year + '-02-' + (leap ? '29' : '28')];
      }
      return [year + '-' + pad(base.m) + '-' + pad(base.d)];
    }

    if (repeat === 'monthly_solar') {
      for (i = 1; i <= 12; i++) {
        var d = base.d;
        var last = solarMonthDays(year, i);
        if (d > last) d = last;                  // 该月没有这一天 → 顺延到当月最后一天
        var key = year + '-' + pad(i) + '-' + pad(d);
        if (key > date) out.push(key);
      }
      return out;
    }

    // 农历规则：基准日转农历，再把目标农历年的同月同日（或每月同日）转回公历。
    // 一个公历年跨两个农历年，两个候选都查；闰月基准日跳过（同名闰月不是每年都有）。
    var l = Lunar.solar2lunar(base.y, base.m, base.d);
    if (!l || l.isLeap) return [];
    var jan = Lunar.solar2lunar(year, 1, 1);
    if (!jan) return [];

    if (repeat === 'yearly_lunar') {
      for (i = 0; i < 2; i++) {
        var ly = jan.ly + i;
        if (ly <= l.ly) continue;
        var s = Lunar.lunar2solar(ly, l.lm, l.ld, false);
        if (s && s.y === year) {
          var k = s.y + '-' + pad(s.m) + '-' + pad(s.d);
          if (k > date && out.indexOf(k) < 0) out.push(k);
        }
      }
      return out;
    }

    // monthly_lunar：该公历年覆盖到的两个农历年里，逐个月取同一个农历日
    for (i = 0; i < 2; i++) {
      var ly2 = jan.ly + i;
      for (var lm = 1; lm <= 12; lm++) {
        var s2 = Lunar.lunar2solar(ly2, lm, l.ld, false);
        if (!s2 || s2.y !== year) continue;      // 该农历月没有这一天（小月遇「三十」）→ 跳过
        var k2 = s2.y + '-' + pad(s2.m) + '-' + pad(s2.d);
        if (k2 > date && out.indexOf(k2) < 0) out.push(k2);
      }
    }
    out.sort();
    return out;
  }

  /** 某个公历日期是不是该重复事项的落点（含基准日当天那一次） */
  function isOccurrence(todo, dateKey) {
    var date = baseDate(todo);
    if (!todo || !rule(todo) || !date) return false;
    if (REPEATS.indexOf(rule(todo)) < 0) return false;
    var key = String(dateKey || '');
    if (!parseKey(key)) return false;
    if (key === date) return true;
    return occurrencesInYear(todo, Number(key.slice(0, 4))).indexOf(key) >= 0;
  }

  /**
   * 从 fromKey（含当天）往后第一个落点日期键。
   * 「重复事项的下一次是什么时候」——界面上的「下次提醒」就靠它，
   * 服务端算提醒时刻也用同一个落点，保证「日历上写的时间」与「实际发信时间」一致。
   * @returns {string} 'YYYY-MM-DD'，算不出来返回 ''
   */
  function nextOccurrence(todo, fromKey) {
    var date = baseDate(todo);
    if (!todo || !rule(todo) || !date) return '';
    if (REPEATS.indexOf(rule(todo)) < 0) return '';
    var from = parseKey(fromKey);
    if (!from) return '';
    // 基准日（原事项自己）还没过去，那它本身就是下一次
    if (date >= String(fromKey)) return date;
    var base = parseKey(date);
    if (!base) return '';
    // 从 fromKey 那年往后找；上限 2100 与农历表的覆盖范围一致
    for (var y = from.y; y <= base.y + 200 && y <= 2100; y++) {
      var occ = occurrencesInYear(todo, y);
      for (var i = 0; i < occ.length; i++) {
        if (occ[i] >= String(fromKey)) return occ[i];
      }
    }
    return '';
  }

  /** 人类可读的重复规则描述，如「每年公历 5月20日」「每月农历 初五」 */
  function label(todo) {
    var repeat = rule(todo);
    var date = baseDate(todo);
    if (!todo || !repeat || !date) return '';
    var base = parseKey(date);
    if (!base) return '';
    /* ★ 与 occurrencesInYear / nextOccurrence 保持同一套白名单：
       不认识的规则必须返回空，否则会掉进下面的兜底分支、被描述成「每年公历 X月X日」——
       一个根本不存在的规则被说成年度规则，比什么都不显示更容易误导人。 */
    if (REPEATS.indexOf(repeat) < 0) return '';
    if (repeat === 'yearly_lunar') {
      var l = Lunar.solar2lunar(base.y, base.m, base.d);
      return l ? '每年农历 ' + l.monthName + l.dayName : '每年农历';
    }
    if (repeat === 'monthly_lunar') {
      // 按月只说「哪一天」——每月都在同一个农历日，报月份反而让人以为是一年一次
      var l2 = Lunar.solar2lunar(base.y, base.m, base.d);
      return l2 ? '每月农历 ' + l2.dayName : '每月农历';
    }
    if (repeat === 'monthly_solar') return '每月公历 ' + base.d + ' 日';
    if (repeat === 'weekly') {
      var wd2 = new Date(Date.UTC(base.y, base.m - 1, base.d)).getUTCDay();
      return '每周公历 星期' + WEEK_CN[wd2];
    }
    if (repeat === 'daily') return '每天';
    return '每年公历 ' + base.m + '月' + base.d + '日';
  }

  return {
    // v4.10.0：规则读取出口（repeat_rule 优先、repeat 翻译回落）—— 前端筛选/表单都用它
    rule: rule,
    occurrencesInYear: occurrencesInYear,
    isOccurrence: isOccurrence,
    nextOccurrence: nextOccurrence,
    label: label,
    // v1.9.0：把规则清单与中文名也导出，前后端不再各写一份（避免「加了规则但界面不认」）
    REPEATS: REPEATS,
    RULE_LABEL: RULE_LABEL,
    isMonthly: isMonthly,
    // v2.0.0：每周重复
    isWeekly: isWeekly,
    // v4.10.0：每天重复
    isDaily: isDaily,
    // v4.10.0（A4=①）：旧 repeat 枚举 → 新枚举的对照表，服务端双写时要用
    LEGACY_RULE: LEGACY_RULE,
    // 「周期短于一年」的并集（按月 + 按周）：当年就要展开。日历与服务端提醒共用这一个判据，
    // 导出它是为了让测试能直接盯住「加了新规则却忘了归到这一类」这种最隐蔽的错。
    sameYearRules: sameYearRules,
  };
});
