/* 农历 / 万年历核心算法
 * 数据表覆盖 1900-2100 年，压缩编码：
 *   低 4 位       = 闰月月份（0 表示无闰月）
 *   0x10000 位    = 闰月天数（1=30 天，0=29 天）
 *   0x8000..0x10  = 正月到十二月各月天数（1=30 天，0=29 天）
 * 锚点：1900-01-31 为农历 1900 年正月初一
 */
(function (global) {
  'use strict';

  var LUNAR_INFO = [
    0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
    0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
    0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
    0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
    0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
    0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,
    0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
    0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,
    0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
    0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0,
    0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
    0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
    0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
    0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
    0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
    0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0,
    0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,
    0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,
    0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160,
    0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252,
    0x0d520
  ];

  var MONTH_CN = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
  var DAY_CN = ['初', '十', '廿', '卅'];
  var DAY_UNIT = ['日', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  var GAN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
  var ZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
  var ZODIAC = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];
  var SOLAR_TERM = ['小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨', '立夏', '小满', '芒种', '夏至',
    '小暑', '大暑', '立秋', '处暑', '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至'];
  // 1900 年小寒为 1 月 6 日，用分钟精度近似（误差 < 1 天，与主流万年历一致到日）
  var TERM_INFO = [0, 21208, 42467, 63836, 85337, 107014, 128867, 150921, 173149, 195551, 218072, 240693,
    263343, 285989, 308563, 331033, 353350, 375494, 397447, 419210, 440795, 462224, 483532, 504758];

  var SOLAR_FESTIVAL = {
    '1-1': '元旦', '2-14': '情人节', '3-8': '妇女节', '3-12': '植树节', '4-1': '愚人节',
    '5-1': '劳动节', '5-4': '青年节', '6-1': '儿童节', '7-1': '建党节', '8-1': '建军节',
    '9-10': '教师节', '10-1': '国庆节', '12-24': '平安夜', '12-25': '圣诞节'
  };
  var LUNAR_FESTIVAL = {
    '1-1': '春节', '1-15': '元宵节', '2-2': '龙抬头', '5-5': '端午节', '7-7': '七夕节',
    '7-15': '中元节', '8-15': '中秋节', '9-9': '重阳节', '12-8': '腊八节', '12-23': '小年'
  };

  function fix(y, m, d) { // 归一化为 UTC 毫秒，规避本地时区误差
    return Date.UTC(y, m - 1, d);
  }

  function leapMonth(y) { return LUNAR_INFO[y - 1900] & 0xf; }

  function leapDays(y) {
    if (!leapMonth(y)) return 0;
    return (LUNAR_INFO[y - 1900] & 0x10000) ? 30 : 29;
  }

  function monthDays(y, m) {
    return (LUNAR_INFO[y - 1900] & (0x10000 >> m)) ? 30 : 29;
  }

  function yearDays(y) {
    var i, sum = 348;
    for (i = 0x8000; i > 0x8; i >>= 1) sum += (LUNAR_INFO[y - 1900] & i) ? 1 : 0;
    return sum + leapDays(y);
  }

  function lunarDayName(d) {
    if (d === 10) return '初十';
    if (d === 20) return '二十';
    if (d === 30) return '三十';
    return DAY_CN[Math.floor(d / 10)] + DAY_UNIT[d % 10];
  }

  function ganzhiYear(ly) {
    var idx = (ly - 4) % 60;
    if (idx < 0) idx += 60;
    return GAN[idx % 10] + ZHI[idx % 12];
  }

  /** 公历 -> 农历。y/m/d 为公历年月日（1-12 / 1-31） */
  function solar2lunar(y, m, d) {
    if (y < 1900 || y > 2100) return null;
    var offset = (fix(y, m, d) - fix(1900, 1, 31)) / 86400000;
    if (offset < 0) return null;

    var i, temp = 0, ly;
    for (i = 1900; i <= 2100 && offset > 0; i++) {
      temp = yearDays(i);
      offset -= temp;
    }
    if (offset < 0) { offset += temp; i--; }
    ly = i;

    var leap = leapMonth(ly), isLeap = false, lm = 1;
    for (lm = 1; lm <= 12; lm++) {
      var days;
      if (leap > 0 && lm === leap + 1 && !isLeap) {
        --lm;
        isLeap = true;
        days = leapDays(ly);
      } else {
        days = monthDays(ly, lm);
      }
      // 闰月标记必须在 break 之前复位：否则「闰月之后那一个月」里的日期
      // 会被误判成闰月（例如 2020 闰四月之后，五月初五被报成「闰五月初五」）。
      if (isLeap && lm === leap + 1) isLeap = false;
      if (offset < days) break;
      offset -= days;
    }

    var ld = Math.floor(offset) + 1;
    lm = Math.max(1, Math.min(12, lm));

    return {
      ly: ly,
      lm: lm,
      ld: ld,
      isLeap: isLeap,
      monthName: (isLeap ? '闰' : '') + MONTH_CN[lm - 1] + '月',
      dayName: lunarDayName(ld),
      ganzhi: ganzhiYear(ly),
      zodiac: ZODIAC[(ly - 4) % 12],
      festival: festivalOf(ly, lm, ld, isLeap, m, d)
    };
  }

  function festivalOf(ly, lm, ld, isLeap, sm, sd) {
    if (isLeap) return '';
    var key = lm + '-' + ld;
    if (LUNAR_FESTIVAL[key]) return LUNAR_FESTIVAL[key];
    var solar = SOLAR_FESTIVAL[sm + '-' + sd];
    if (solar) return solar;
    return '';
  }

  /** 24 节气：返回该公历日的节气名，无则空串 */
  function solarTerm(y, m, d) {
    if (y < 1900 || y > 2100) return '';
    var idx = (m - 1) * 2;
    for (var k = 0; k < 2; k++) {
      var minutes = 525948.76 * (y - 1900) + TERM_INFO[idx + k];
      var dt = new Date(fix(1900, 1, 6) + minutes * 60000);
      if (dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === m && dt.getUTCDate() === d) {
        return SOLAR_TERM[idx + k];
      }
    }
    return '';
  }

  /** 农历 -> 公历。ly/lm/ld 为农历年月日，isLeap 表示闰月。返回 {y,m,d} 或 null */
  function lunar2solar(ly, lm, ld, isLeap) {
    if (ly < 1900 || ly > 2100 || lm < 1 || lm > 12 || ld < 1 || ld > 30) return null;
    var leap = leapMonth(ly);
    if (isLeap && leap !== lm) return null;          // 该年没有这个闰月
    if (!isLeap && ld > monthDays(ly, lm)) return null;
    if (isLeap && ld > leapDays(ly)) return null;

    var offset = 0, m, y;
    for (y = 1900; y < ly; y++) offset += yearDays(y);   // 先累计整年
    for (m = 1; m < lm; m++) offset += monthDays(ly, m); // 再累计年内整月
    // 闰月排在第 leap 个月之后：目标月在其后的普通月要补上闰月天数
    if (!isLeap && leap > 0 && lm > leap) offset += leapDays(ly);
    offset += ld - 1;

    var dt = new Date(fix(1900, 1, 31) + offset * 86400000);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }

  /** 综合标签：节日优先，其次节气，最后农历日 */
  function dayLabel(y, m, d) {
    var l = solar2lunar(y, m, d);
    if (!l) return '';
    if (l.festival) return l.festival;
    var t = solarTerm(y, m, d);
    if (t) return t;
    return l.dayName === '初一' ? l.monthName : l.dayName;
  }

  global.Lunar = {
    solar2lunar: solar2lunar,
    lunar2solar: lunar2solar,
    solarTerm: solarTerm,
    dayLabel: dayLabel,
    ganzhiYear: ganzhiYear,
    leapMonth: leapMonth,
    monthDays: monthDays,
    leapDays: leapDays
  };
})(
  /* 浏览器里挂到 window；Node 里挂到 module.exports —— 农历算法只保留一份实现，
     服务端（提醒调度算「今年农历落点」）与前端（万年历）共用同一个文件。 */
  (typeof window !== 'undefined' && window)
    ? window
    : (typeof module !== 'undefined' && module.exports ? module.exports : globalThis)
);
