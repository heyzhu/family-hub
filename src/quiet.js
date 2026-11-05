'use strict';
/**
 * 「墙上时间」与免打扰时段的纯计算（v2.0.0 从 notify.js 抽出来）。
 *
 * 为什么单独一个模块：免打扰现在有**两个来源** ——
 *   1) 管理员在「家庭设置」里设的全站免打扰（内容变更通知用）；
 *   2) 每个成员在自己「通知设置」里设的个人免打扰（待办提醒 + 内容通知都用）。
 * 两处必须用**同一份**跨零点判定，否则会出现「22:00→08:00 在通知里生效、
 * 在待办提醒里却只按同日区间算」这种偏差。
 *
 * 依赖方向：本模块**不依赖任何其它模块**。
 * （notify.js 依赖 reminders.js，reminders.js 依赖本模块；
 *   若本模块反过来依赖 reminders.js 就会成环，而 Node 在循环依赖里拿到的是
 *   「还没赋值的 module.exports」——表现为 shiftDateKey is not a function 这种诡异报错。
 *   所以日期偏移这类纯函数就放在这里，reminders.js 反过来复用它。）
 */
'use strict';

/** 日期键偏移若干天（纯字符串/UTC 运算，与运行时区无关） */
function shiftDateKey(key, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** 把瞬时按给定时区偏移换算成「家里人看到的」日期键 */
function wallKeyAt(ms, tz) {
  const d = new Date(ms + tz * 60000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function wallMinutesAt(ms, tz) {
  const d = new Date(ms + tz * 60000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** 「某个墙上日期 + HH:MM」对应的瞬时 */
function wallInstant(dateKey, hhmm, tz) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const [hh, mm] = String(hhmm).split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - tz * 60000;
}

const toMin = (hhmm) => Number(String(hhmm).slice(0, 2)) * 60 + Number(String(hhmm).slice(3, 5));

/**
 * 把一个「想发送的时刻」挪出免打扰时段（如果需要）。
 * 跨零点的时段（开始 > 结束）要单独处理：落在凌晨那段时，免打扰的开始时刻在**前一天**。
 *
 * 入参 cfg 只用到两个字段（刻意用宽松形状，好让 notify 的全局配置与
 * userprefs 的个人时段都能直接传进来）：
 *   { notifyQuietStart, notifyQuietEnd } 或 { start, end }
 *
 * @returns {number} 处理后的瞬时（不在免打扰内就原样返回）
 */
function outOfQuiet(ms, cfg, tz) {
  if (!cfg) return ms;
  const s = cfg.notifyQuietStart !== undefined ? cfg.notifyQuietStart : cfg.start;
  const e = cfg.notifyQuietEnd !== undefined ? cfg.notifyQuietEnd : cfg.end;
  if (!s || !e) return ms;
  const sm = toMin(s);
  const em = toMin(e);
  // 起止相同 = 不启用。否则「00:00 到 00:00」会被理解成全天静音，把所有通知永久吞掉。
  if (sm === em) return ms;

  const key = wallKeyAt(ms, tz);
  const wrap = sm > em;                 // 例如 22:00 → 08:00
  const tm = wallMinutesAt(ms, tz);
  let start;
  let end;
  if (wrap) {
    if (tm >= sm) {                     // 当天夜里那一段
      start = wallInstant(key, s, tz);
      end = wallInstant(shiftDateKey(key, 1), e, tz);
    } else if (tm < em) {               // 次日凌晨那一段
      start = wallInstant(shiftDateKey(key, -1), s, tz);
      end = wallInstant(key, e, tz);
    } else {
      return ms;                        // 白天，不在免打扰内
    }
  } else {
    start = wallInstant(key, s, tz);
    end = wallInstant(key, e, tz);
    if (!(ms >= start && ms < end)) return ms;
  }
  return end;
}

module.exports = { shiftDateKey, wallKeyAt, wallMinutesAt, wallInstant, toMin, outOfQuiet };
