'use strict';
/**
 * SQLite 数据层。
 *
 * 引擎自动适配，对外暴露统一的 all / get / run 接口：
 *   1) node:sqlite     —— Node >= 22.5 内置，零安装（首选）
 *   2) better-sqlite3  —— 仅在旧版 Node 上作为备选（optionalDependency）
 *
 * 全库只有一个文件：config.dbPath。备份/迁移 = 拷这一个文件（或用 VACUUM INTO 产出一致性副本）。
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

/* ── 引擎探测 ───────────────────────────────────────────── */

function createEngine(file) {
  // 1) Node 内置 SQLite
  try {
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(file);
    return {
      kind: 'node:sqlite',
      exec: (sql) => raw.exec(sql),
      all: (sql, params) => raw.prepare(sql).all(...params),
      run: (sql, params) => raw.prepare(sql).run(...params),
      close: () => raw.close(),
    };
  } catch (err) {
    if (!/node:sqlite|Cannot find module/.test(String(err && err.message))) throw err;
  }
  // 2) 备选：better-sqlite3
  const Database = require('better-sqlite3');
  const raw = new Database(file);
  return {
    kind: 'better-sqlite3',
    exec: (sql) => raw.exec(sql),
    all: (sql, params) => raw.prepare(sql).all(...params),
    run: (sql, params) => raw.prepare(sql).run(...params),
    close: () => raw.close(),
  };
}

/* ── 参数归一化：布尔转 0/1，undefined 转 null ───────────── */

function norm(params) {
  if (!params || !params.length) return [];
  return params.map((v) => {
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v === undefined) return null;
    if (v instanceof Date) return v.toISOString();
    return v;
  });
}

/* ── 打开数据库 ─────────────────────────────────────────── */

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });

const engine = createEngine(config.dbPath);

// 外键约束与 WAL：让删除级联生效、读写并发更稳
engine.exec('PRAGMA foreign_keys = ON');
try { engine.exec('PRAGMA journal_mode = WAL'); } catch { /* 某些文件系统不支持 WAL，忽略 */ }
engine.exec('PRAGMA busy_timeout = 5000');

/* ★ v4.3.2 需求 3：这几条是「打包成 fpk 后界面卡顿」的正面修复之一。
   原生形态（fpk）把数据目录放在 NAS 的**共享目录**里，而共享目录很可能是
   mergerfs / FUSE 这类存储池，单次 fsync 的代价远大于本机磁盘。
   而 synchronous 在 WAL 下的默认值是 FULL —— 也就是**每次提交都要 fsync 数据文件**；
   应用恰好「每个请求都会写一次 sessions」（滑动续期，见 auth.js），
   于是每次点击都要等一次落盘，界面就是一顿一顿的。
   改成 NORMAL：提交不再等待 fsync（由 WAL 的 checkpoint 统一落盘）。
   代价只发生在「操作系统崩溃」这一种场景 —— 可能丢最后几个已提交事务；
   进程崩溃、断电前的已 checkpoint 数据都不受影响。对家用记账完全划算。 */
engine.exec('PRAGMA synchronous = NORMAL');
engine.exec('PRAGMA cache_size = -8000');   // 8MB 页缓存，减少 NAS 上的随机读
engine.exec('PRAGMA temp_store = MEMORY');  // 排序/分组走内存，不落磁盘临时文件

/* 把真正生效的 journal 模式记下来 —— 共享目录上 WAL 有可能建不起来，
   此时 SQLite 会**静默**退回 delete 日志模式（每次写入要建/删日志文件，更慢）。
   这条值会在启动横幅里打出来，是排查「同一份代码在家里快、在 NAS 上慢」的第一现场证据。 */
let journalMode = '';
try {
  const r = engine.all('PRAGMA journal_mode', []);
  journalMode = String((r && r[0] && r[0].journal_mode) || '');
} catch { /* 读不到就算了，不影响功能 */ }

/** 建表（幂等，每次启动执行） */
function initSchema() {
  engine.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'));
}

/* ── 旧库结构迁移（幂等） ────────────────────────────────── */

function columnExists(table, col) {
  return engine.all(`PRAGMA table_info(${table})`, []).some((r) => r.name === col);
}

/* ── todos 表重建 · 技术债 W-8：两段几乎相同的重建块合成一处 ──────────────
   ★ 历史背景：todos 被重建过两次（1.0.0 的 todo_date NOT NULL、2.0.0 的 repeat CHECK
     约束），两段「DDL + INSERT…SELECT + DROP + RENAME + 建索引」是复制粘贴出来的。
     本项目在更早的重建里踩过「新表少一列 → 用户数据凭空消失」的坑，而复制粘贴正是
     这个坑的高发区。
   ★ 现在的做法：
     ① 列定义只写一份（todosColumns），两次重建的差别只是「repeat 有几条规则」和
        「有没有 remind 三列」，用一个开关表达，不再各抄一遍；
     ② 搬数据时**只搬源表真的存在**的列，缺的列自动落到默认值；
        源表有、目标没有的列会打警告（正常升级不会出现，出现了也不会静默丢）；
     ③ 事务、回滚、重建索引都在同一个地方，改一次就两次都改到。 */
function todosColumns(opts) {
  const o = opts || {};
  // ① 只有「每年」时的约束（1.0.0/1.1.0 的库）；② 全部五条规则（v2.0.0 起）
  const rules = o.allRules
    ? "('','solar_yearly','lunar_yearly','solar_monthly','lunar_monthly','solar_weekly')"
    : "('','solar_yearly','lunar_yearly')";
  const cols = [
    ['id', 'INTEGER PRIMARY KEY AUTOINCREMENT'],
    ['user_id', 'INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE'],
    ['owner_name', "TEXT    NOT NULL DEFAULT ''"],
    ['title', 'TEXT    NOT NULL'],
    ['note', "TEXT    NOT NULL DEFAULT ''"],
    ['todo_date', 'TEXT'],
    ['start_time', "TEXT    NOT NULL DEFAULT ''"],
    ['end_time', "TEXT    NOT NULL DEFAULT ''"],
    ['location', "TEXT    NOT NULL DEFAULT ''"],
    ['participants', "TEXT    NOT NULL DEFAULT '[]'"],
    ['priority', "TEXT    NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high'))"],
    ['repeat', `TEXT    NOT NULL DEFAULT '' CHECK (repeat IN ${rules})`],
    ['done', 'INTEGER NOT NULL DEFAULT 0'],
    /* v4.22.0：这两列必须写进列清单，否则任何一次 todos 重建都会把它们吞掉
       （重建是按「目标列清单」搬数据的，清单里没有的列会静默丢）。 */
    ['remind_advance_days', 'INTEGER NOT NULL DEFAULT -1'],
    ['quick', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  /* 第二次重建（v2.0.0）时这三列已经在表里了 —— v1.2/v1.3 之后补的，
     重建漏掉它们就是「已提醒过的又提醒一遍」，所以这里是显式列出来的。 */
  if (o.remind) {
    cols.push(
      ['remind', 'INTEGER NOT NULL DEFAULT 1'],
      ['reminded_at', 'TEXT'],
      ['remind_key', "TEXT    NOT NULL DEFAULT ''"],
    );
  }
  cols.push(
    ['visibility', "TEXT    NOT NULL DEFAULT 'family' CHECK (visibility IN ('family','private'))"],
    ['created_at', "TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"],
    ['updated_at', "TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"],
  );
  return cols;
}

/** 真正干活的：重建 todos（opts 见 todosColumns），全程一个事务，失败回滚后原表不动 */
function rebuildTodos(opts) {
  const cols = todosColumns(opts);
  const names = cols.map((c) => c[0]);
  const existing = engine.all('PRAGMA table_info(todos)', []).map((r) => r.name);
  const copy = names.filter((n) => existing.indexOf(n) >= 0);
  const extra = existing.filter((n) => names.indexOf(n) < 0);
  if (extra.length) {
    console.warn(`  [migrate] ⚠ todos 重建：源表有目标清单之外的列（重建后不保留）：${extra.join(', ')}`);
  }
  const ddl = 'CREATE TABLE todos_mig (\n  '
    + cols.map((c) => `${c[0].padEnd(12)} ${c[1]}`).join(',\n  ') + '\n)';
  engine.exec('BEGIN IMMEDIATE');
  try {
    engine.exec(ddl);
    engine.exec(`INSERT INTO todos_mig (${copy.join(', ')})
      SELECT ${copy.join(', ')} FROM todos`);
    engine.exec('DROP TABLE todos');
    engine.exec('ALTER TABLE todos_mig RENAME TO todos');
    engine.exec('CREATE INDEX IF NOT EXISTS idx_todos_date ON todos (todo_date, start_time)');
    engine.exec('COMMIT');
  } catch (err) {
    try { engine.exec('ROLLBACK'); } catch { /* 忽略 */ }
    throw err;
  }
}

function migrate() {
  // 记录本次实际做了什么。升级是「静默行为」，必须留痕：不然出问题无从下手，
  // 也看不出来「到底有没有跑过迁移」。启动时打一行 [migrate] 输出即可。
  const done = [];
  // 增量列：直接补
  if (!columnExists('posts', 'tags')) {
    engine.exec("ALTER TABLE posts ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
    done.push('posts.tags');
  }
  if (!columnExists('records', 'images')) {
    engine.exec("ALTER TABLE records ADD COLUMN images TEXT NOT NULL DEFAULT '[]'");
    done.push('records.images');
  }
  // v1.5.0：记录本附件（PDF / Office / 压缩包等），存 [{name,path,size}]。
  // tags 列虽然界面上已经不用了，但**不删**：删列要重建表，而重建表会吞掉
  // 之前 ALTER 补上的列（本项目踩过这个坑），而且留着老数据才不丢、回滚也安全。
  if (!columnExists('records', 'attachments')) {
    engine.exec("ALTER TABLE records ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
    done.push('records.attachments');
  }
  if (!columnExists('todos', 'repeat')) {
    engine.exec("ALTER TABLE todos ADD COLUMN repeat TEXT NOT NULL DEFAULT ''");
    done.push('todos.repeat');
  }
  if (!columnExists('users', 'record_lock_enabled')) {
    engine.exec('ALTER TABLE users ADD COLUMN record_lock_enabled INTEGER NOT NULL DEFAULT 0');
    done.push('users.record_lock_enabled');
  }
  if (!columnExists('users', 'record_lock_hash')) {
    engine.exec("ALTER TABLE users ADD COLUMN record_lock_hash TEXT NOT NULL DEFAULT ''");
    done.push('users.record_lock_hash');
  }
  if (!columnExists('sessions', 'records_unlocked')) {
    engine.exec('ALTER TABLE sessions ADD COLUMN records_unlocked INTEGER NOT NULL DEFAULT 0');
    done.push('sessions.records_unlocked');
  }
  // v1.2.0：记录本解锁凭证改为按「页面会话」签发的随机 key（前端存 sessionStorage，
  // 关闭页面即失效）。旧布尔列 records_unlocked 不再使用，保留只为兼容旧库结构。
  if (!columnExists('sessions', 'records_unlocked_key')) {
    engine.exec("ALTER TABLE sessions ADD COLUMN records_unlocked_key TEXT NOT NULL DEFAULT ''");
    done.push('sessions.records_unlocked_key');
  }
  if (!columnExists('users', 'notify_email')) {
    engine.exec("ALTER TABLE users ADD COLUMN notify_email TEXT NOT NULL DEFAULT ''");
    done.push('users.notify_email');
  }
  // v1.6.0：用户自定义头像。存图片路径（/api/media/...），空串表示回退到「昵称首字色块」。
  if (!columnExists('users', 'avatar')) {
    engine.exec("ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT ''");
    done.push('users.avatar');
  }
  /* v4.7.0 需求 2 / v4.8.0 需求 4：主动提醒走哪条通道。
     'auto'（默认）= 优先企业微信、发不出去回退邮件；'mail' 只发邮件；'both' 两条都发。
     v4.7.0 的 'wecom' 是旧值，读取时由 push.normalizeChannel 归一成 'auto'。
     ★ users 表不参与 todos 那种重建，所以这条 ALTER 的先后无所谓；仍放在一起便于查阅。 */
  if (!columnExists('users', 'push_channel')) {
    engine.exec("ALTER TABLE users ADD COLUMN push_channel TEXT NOT NULL DEFAULT 'auto'");
    done.push('users.push_channel');
  }
  /* v4.11.0：界面主题，跟着人走（不是跟着浏览器走）。
     三套色板见 public/styles.css 的 [data-theme=...]；空串 = 还没选过，
     由前端按默认主题渲染。★ 只加列不加索引：索引若写进 schema.sql，
     老库在 migrate() 跑到这里之前就会因为「没有这列」而启动失败。 */
  if (!columnExists('users', 'theme')) {
    engine.exec("ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT ''");
    done.push('users.theme');
  }
  /* v4.8.0：把 v4.7.0 留下的「只用邮件」一次性挪到「智能优先企业微信」。
     ★ 必须用 settings 里的一次性标记，否则用户自己改回「只用邮件」后，
       下次重启又会被悄悄改回来 —— 那是最难查的一类问题。 */
  if (!engine.all("SELECT value FROM settings WHERE key = 'push_channel_auto_switched'", []).length) {
    engine.run("UPDATE users SET push_channel = 'auto' WHERE push_channel IN ('mail', 'wecom')", []);
    engine.run("INSERT INTO settings (key, value) VALUES ('push_channel_auto_switched', '1') "
      + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value', []);
    done.push('推送通道默认改为「智能优先企业微信」');
  }
  /* 旧版 todos.todo_date 是 NOT NULL，SQLite 不支持直接改列约束，需重建表。
     ★ W-8：重建的具体动作（DDL / 搬数据 / 事务 / 建索引）统一在 rebuildTodos() 里，
       这里只判断「要不要重建」以及留一条迁移痕迹。 */
  const dateCol = engine.all('PRAGMA table_info(todos)', []).find((r) => r.name === 'todo_date');
  if (dateCol && dateCol.notnull) {
    done.push('todos 重建（放开 todo_date NOT NULL）');
    rebuildTodos({});
  }
  // v1.2.0：待办邮件提醒列（放在 todos 重建之后，避免被重建吞掉）
  if (!columnExists('todos', 'remind')) {
    engine.exec('ALTER TABLE todos ADD COLUMN remind INTEGER NOT NULL DEFAULT 1');
    done.push('todos.remind');
  }
  if (!columnExists('todos', 'reminded_at')) {
    engine.exec('ALTER TABLE todos ADD COLUMN reminded_at TEXT');
    done.push('todos.reminded_at');
  }
  // v1.3.0：年度重复事项要「每年到时间都提醒」，只靠一个 reminded_at 时间戳记不住
  // 到底发的是哪一年的那一次，所以再存「已经提醒过的落点日期」remind_key。
  if (!columnExists('todos', 'remind_key')) {
    engine.exec("ALTER TABLE todos ADD COLUMN remind_key TEXT NOT NULL DEFAULT ''");
    const n = backfillRemindKey();
    done.push(`todos.remind_key（回填 ${n} 条历史提醒标记）`);
  }
  // v1.9.0：动态支持视频，与 images 并列存路径数组
  if (!columnExists('posts', 'videos')) {
    engine.exec("ALTER TABLE posts ADD COLUMN videos TEXT NOT NULL DEFAULT '[]'");
    done.push('posts.videos');
  }
  // v1.9.0：记录本可归档（不是删除，记录仍在库里、仍能搜到，只是列表默认不展示）
  if (!columnExists('records', 'archived')) {
    engine.exec('ALTER TABLE records ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
    done.push('records.archived');
  }
  // v1.9.0 / v2.0.0：重复规则从「每年」扩展到「每月」再加「每周」，
  // 而 repeat 上带着 CHECK 约束，SQLite 不支持改约束 → 只能重建表。
  // ★ 重建时必须把**所有列**都搬过去，尤其是 v1.2/v1.3 之后补的 remind / reminded_at /
  //   remind_key —— 少搬一列就是从用户手里丢数据（本项目在早先的重建里踩过这个坑）。
  // ★ 判定依据：建表 SQL 里有没有最新那条规则 'solar_weekly'。
  //   新库由 schema.sql 直接建好 → 跳过重建（幂等）；1.9.0 的库缺 weekly → 重建一次；
  //   1.8.0 的库连 monthly 都缺 → 同一个块把它一并补齐（不用重建两次）。
  const todosDdl = engine.all("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'todos'", []);
  if (todosDdl.length && !/solar_weekly/.test(String(todosDdl[0].sql || ''))) {
    done.push('todos 重建（放开 repeat 约束，支持按周重复）');
    if (!/solar_monthly/.test(String(todosDdl[0].sql || ''))) {
      done.push('todos 的 repeat 约束同时补齐了按月重复');
    }
    // 与上一次重建共用同一段实现，区别只有「五条规则 + remind 三列」（W-8）
    rebuildTodos({ allRules: true, remind: true });
  }
  // v4.0.0：账单带「交易平台」（AI 提取字段之一；支付宝/微信/银行卡…）。
  // bills 表不重建，直接 ALTER 补列（幂等；平台不影响任何既有查询）。
  if (!columnExists('bills', 'platform')) {
    engine.exec("ALTER TABLE bills ADD COLUMN platform TEXT NOT NULL DEFAULT ''");
    done.push('bills.platform');
  }
  /* ★ v4.3.3：下面这批 ALTER 必须留在**两次 todos 重建之后**。
     migrate() 里 todos 会被 DROP + RENAME 两次（放开 NOT NULL、放开 repeat 约束），
     重建只搬它自己列的清单 —— 若把新列加在重建之前，重建一跑就全被吞掉。
     这条坑本项目已经踩过一次，别再把新 ALTER 往上挪。 */

  // v4.3.3 需求 1：评论可以回复他人（两级结构，parent_id 指向顶层评论）
  if (!columnExists('comments', 'parent_id')) {
    engine.exec('ALTER TABLE comments ADD COLUMN parent_id INTEGER NOT NULL DEFAULT 0');
    done.push('comments.parent_id');
  }
  // 被回复人昵称存快照：评论被删后「回复 张三」仍要能正常显示
  if (!columnExists('comments', 'reply_to_name')) {
    engine.exec("ALTER TABLE comments ADD COLUMN reply_to_name TEXT NOT NULL DEFAULT ''");
    done.push('comments.reply_to_name');
  }
  // v4.3.3 需求 8：视频封面（移动端首帧不可靠，必须自带 poster）
  if (!columnExists('posts', 'video_covers')) {
    engine.exec("ALTER TABLE posts ADD COLUMN video_covers TEXT NOT NULL DEFAULT '{}'");
    done.push('posts.video_covers');
  }
  // v4.3.3 需求 5：「一起写」支持编辑，需要知道最后一次改动发生在什么时候
  if (!columnExists('post_contribs', 'updated_at')) {
    engine.exec("ALTER TABLE post_contribs ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
    done.push('post_contribs.updated_at');
  }
  /* v4.6.0 需求 4：共创里的视频也要有封面。
     移动端不认 #t=0.1 这种媒体片段，没有 poster 就是一块黑 ——
     帖子早就有 video_covers，共创一直缺，于是「一起写」里的视频在手机上永远是黑框。 */
  if (!columnExists('post_contribs', 'video_covers')) {
    engine.exec("ALTER TABLE post_contribs ADD COLUMN video_covers TEXT NOT NULL DEFAULT '{}'");
    done.push('post_contribs.video_covers');
  }
  /* v4.6.0 需求 3：待办的「催促完成」。
     urge_minutes = 0 表示不催；1–60 表示到点后每隔这么多分钟通过企业微信催一次，
     直到当事人回一句「已完成」。urge_last_at 记最后一次催的时间（空串 = 还没催过）。
     ★ 这两列同样必须留在两次 todos 重建之后，否则重建会把它们吞掉。 */
  if (!columnExists('todos', 'urge_minutes')) {
    engine.exec('ALTER TABLE todos ADD COLUMN urge_minutes INTEGER NOT NULL DEFAULT 0');
    done.push('todos.urge_minutes');
  }
  if (!columnExists('todos', 'urge_last_at')) {
    engine.exec("ALTER TABLE todos ADD COLUMN urge_last_at TEXT NOT NULL DEFAULT ''");
    done.push('todos.urge_last_at');
  }
  /* ★ 索引必须建在补列**之后**，而且不能写进 schema.sql ——
     schema.sql 在 migrate() 之前执行，老库里 comments 还没有 parent_id，
     在那边建索引会让升级中的库直接报「no such column: parent_id」，服务起不来。 */
  engine.exec('CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments (parent_id)');

  /* ═══ v4.10.0（文档 4.2 的加列清单，本轮落地部分）═══════════
     以下全部是「只加列、不重建」，且都排在两次 todos 重建**之后**。 */
  if (!columnExists('todos', 'end_date')) {
    engine.exec("ALTER TABLE todos ADD COLUMN end_date TEXT NOT NULL DEFAULT ''");
    done.push('todos.end_date');
  }
  if (!columnExists('todos', 'repeat_rule')) {
    engine.exec("ALTER TABLE todos ADD COLUMN repeat_rule TEXT NOT NULL DEFAULT ''");
    done.push('todos.repeat_rule');
  }
  let urgeStatusAdded = false;
  if (!columnExists('todos', 'urge_status')) {
    engine.exec("ALTER TABLE todos ADD COLUMN urge_status TEXT NOT NULL DEFAULT ''");
    done.push('todos.urge_status');
    urgeStatusAdded = true;
  }
  if (!columnExists('todos', 'urge_count')) {
    engine.exec('ALTER TABLE todos ADD COLUMN urge_count INTEGER NOT NULL DEFAULT 0');
    done.push('todos.urge_count');
  }
  if (!columnExists('todos', 'urge_max_count')) {
    engine.exec('ALTER TABLE todos ADD COLUMN urge_max_count INTEGER NOT NULL DEFAULT 20');
    done.push('todos.urge_max_count');
  }
  if (!columnExists('todos', 'urge_window_start')) {
    engine.exec("ALTER TABLE todos ADD COLUMN urge_window_start TEXT NOT NULL DEFAULT '08:00'");
    done.push('todos.urge_window_start');
  }
  if (!columnExists('todos', 'urge_window_end')) {
    engine.exec("ALTER TABLE todos ADD COLUMN urge_window_end TEXT NOT NULL DEFAULT '22:00'");
    done.push('todos.urge_window_end');
  }
  if (!columnExists('todos', 'urge_start_at')) {
    engine.exec("ALTER TABLE todos ADD COLUMN urge_start_at TEXT NOT NULL DEFAULT ''");
    done.push('todos.urge_start_at');
  }
  /* ★ v4.22.0 需求 1 / 2：两列必须放在上面两次 rebuildTodos() **之后**。
     rebuildTodos 按 todosColumns() 建新表再 DROP 旧表 —— 先 ALTER 再加重建，
     新列会被重建直接吞掉（本项目踩过「重建表吞列」）。 */
  if (!columnExists('todos', 'remind_advance_days')) {
    engine.exec('ALTER TABLE todos ADD COLUMN remind_advance_days INTEGER NOT NULL DEFAULT -1');
    done.push('todos.remind_advance_days（每条待办自己的提前天数，-1 跟随家庭设置）');
  }
  if (!columnExists('todos', 'quick')) {
    engine.exec('ALTER TABLE todos ADD COLUMN quick INTEGER NOT NULL DEFAULT 0');
    done.push('todos.quick（一句话添加的待办）');
  }
  /* 老数据回落：升级前就在催的待办（urge_minutes>0 且未完成、非重复）直接视作「等待催促」，
     否则升级瞬间它们会被状态机当成 idle 而停摆。只跑一次（列刚加上时）。 */
  if (urgeStatusAdded) {
    engine.run(
      "UPDATE todos SET urge_status = 'pending' WHERE urge_minutes > 0 AND done = 0 AND repeat = ''", []);
    done.push('urge_status 回填 pending');
  }
  if (!columnExists('records', 'content_json')) {
    engine.exec("ALTER TABLE records ADD COLUMN content_json TEXT NOT NULL DEFAULT ''");
    done.push('records.content_json');
  }
  if (!columnExists('bills', 'source_channel')) {
    engine.exec("ALTER TABLE bills ADD COLUMN source_channel TEXT NOT NULL DEFAULT ''");
    done.push('bills.source_channel');
  }
  if (!columnExists('mail_outbox', 'channel')) {
    engine.exec("ALTER TABLE mail_outbox ADD COLUMN channel TEXT NOT NULL DEFAULT ''");
    done.push('mail_outbox.channel');
  }
  /* v4.12.0 · 记录本提醒（默认不提醒）。
     ★ 六列一起补：只补一半会让 INSERT 的列名与表结构对不上（本项目踩过「重建表吞列」）。 */
  if (!columnExists('records', 'remind')) {
    engine.exec('ALTER TABLE records ADD COLUMN remind INTEGER NOT NULL DEFAULT 0');
    done.push('records.remind');
  }
  if (!columnExists('records', 'remind_time')) {
    engine.exec("ALTER TABLE records ADD COLUMN remind_time TEXT NOT NULL DEFAULT ''");
    done.push('records.remind_time');
  }
  if (!columnExists('records', 'remind_advance_days')) {
    engine.exec('ALTER TABLE records ADD COLUMN remind_advance_days INTEGER NOT NULL DEFAULT -1');
    done.push('records.remind_advance_days');
  }
  if (!columnExists('records', 'remind_channel')) {
    engine.exec("ALTER TABLE records ADD COLUMN remind_channel TEXT NOT NULL DEFAULT ''");
    done.push('records.remind_channel');
  }
  if (!columnExists('records', 'remind_at')) {
    engine.exec("ALTER TABLE records ADD COLUMN remind_at TEXT NOT NULL DEFAULT ''");
    done.push('records.remind_at');
  }
  if (!columnExists('records', 'reminded_at')) {
    engine.exec("ALTER TABLE records ADD COLUMN reminded_at TEXT NOT NULL DEFAULT ''");
    done.push('records.reminded_at');
  }

  /* ★ v4.16.0 需求 4：企业微信开关收敛为**一个** —— 「推送渠道设置 → 企业微信推送」。
     老库里的 wecom_enabled 是那个已下线的「启用企业微信接入」勾选框。
     一次性折算规则（带 wecom_switch_unified 标记，只跑一次）：
       · 五项配置都填齐、但那个勾选框是「未勾选」→ 把推送开关也关掉。
         不这么做的话，升级瞬间这类家庭会突然开始收企业微信消息。
       · 配置本来就没填齐（只是从没启用过）→ 不动。新装默认开着才是对的，
         否则「填完配置也不会发」这种反直觉状态会让人查半天。 */
  if (settingValue('wecom_switch_unified') === null) {
    const legacyOn = settingValue('wecom_enabled') === '1';
    const filled = ['wecom_corp_id', 'wecom_agent_id', 'wecom_secret', 'wecom_token', 'wecom_aes_key']
      .every((k) => String(settingValue(k) || '').trim() !== '');
    if (!legacyOn && filled) {
      engine.run(
        "INSERT INTO settings (key, value) VALUES ('push_wecom_enabled','0')"
        + ' ON CONFLICT(key) DO UPDATE SET value = excluded.value', []);
      done.push('企业微信开关折算（配置齐全但未启用 → 推送开关同步关闭）');
    }
    engine.run(
      "INSERT INTO settings (key, value) VALUES ('wecom_switch_unified','1')"
      + ' ON CONFLICT(key) DO UPDATE SET value = excluded.value', []);
  }

  if (done.length) {
    /* 技术债 W-8：把这次真的做了的事写进 schema_migrations（按主键去重）。
       升级是静默行为，没有这条履历，事后根本查不出某台机器到底补过什么。
       写失败只警告不抛——留痕不该把服务启动搞挂（老库可能还没有这张表）。 */
    try {
      for (const item of done) {
        engine.run(
          'INSERT INTO schema_migrations (id) VALUES (?) ON CONFLICT(id) DO NOTHING', [item]);
      }
    } catch (err) {
      console.warn(`  [migrate] 迁移记录写入失败（不影响功能）：${err && err.message}`);
    }
    console.log(`  [migrate] 数据库结构已升级：${done.join('、')}`);
  }
}

/**
 * 读一个 settings 键（不存在返回 null，用来区分「没设置过」与「设成空串」）。
 * v4.16.0 的一次性迁移要用这个判据，别用 get() 之外的方式猜。
 */
function settingValue(key) {
  const rows = engine.all('SELECT value FROM settings WHERE key = ?', [String(key || '')]);
  if (!rows.length) return null;
  return String(rows[0].value == null ? '' : rows[0].value);
}

/**
 * v4.10.0（A4=①）：精确重复规则的唯一读取入口。
 * repeat_rule 非空 → 直接用；否则把旧 repeat 的枚举翻译成新值（daily 在旧列里没有对应值，
 * 只能写 repeat=''，所以读取回落时 daily 天然回到 ''——这正是「必须双写」的原因）。
 */
function getRepeatRule(todo) {
  if (!todo) return '';
  const rule = String(todo.repeat_rule || '');
  if (rule) return rule;
  switch (String(todo.repeat || '')) {
    case 'solar_weekly': return 'weekly';
    case 'solar_monthly': return 'monthly_solar';
    case 'lunar_monthly': return 'monthly_lunar';
    case 'solar_yearly': return 'yearly_solar';
    case 'lunar_yearly': return 'yearly_lunar';
    default: return '';
  }
}

/**
 * 升级兼容：老版本的「已提醒」标记只有 reminded_at（一个时间戳）。
 * 这里把它翻译成对应的提醒落点日期，好处有两个：
 *   1. 升级后不会把已经发过的那一次再补发一遍；
 *   2. 重复事项也不会被老标记误吞掉——今年该发的那一次照发。
 * 换算不出来时留空，宁可多发一次也不漏发。
 */
function backfillRemindKey() {
  const Repeat = require('../public/repeat.js');
  const rows = engine.all("SELECT id, todo_date, repeat, reminded_at FROM todos WHERE reminded_at IS NOT NULL", []);
  let n = 0;
  for (const t of rows) {
    let key = '';
    if (!t.repeat) {
      key = t.todo_date || '';
    } else if (/^\d{4}-\d{2}-\d{2}/.test(String(t.reminded_at || ''))) {
      const year = Number(String(t.reminded_at).slice(0, 4));
      key = Repeat.occurrencesInYear({ date: t.todo_date, repeat: t.repeat }, year)[0]
        || (String(t.todo_date || '').slice(0, 4) === String(year) ? t.todo_date : '');
    }
    if (key) { engine.run('UPDATE todos SET remind_key = ? WHERE id = ?', [key, t.id]); n++; }
  }
  return n;
}

/** 旧备份文件里没有的新列，恢复时补默认值，避免 NOT NULL 约束报错 */
const COLUMN_DEFAULTS = {
  repeat: '', tags: '[]', images: '[]', participants: '[]', attachments: '[]',
  record_lock_enabled: 0, record_lock_hash: '',
  remind: 1, notify_email: '', remind_key: '', avatar: '',
  // v4.7.0：旧备份文件里没有这个字段，恢复时兜底成默认值（否则 NOT NULL 约束会炸）
  push_channel: 'auto',
  // v4.11.0：主题同样可能是旧备份里没有的字段
  theme: '',
  // v1.9.0
  videos: '[]', archived: 0,
  // v4.0.0
  platform: '',
  // v4.10.0
  end_date: '', repeat_rule: '', content_json: '', source_channel: '',
  urge_status: '', urge_count: 0, urge_max_count: 20, urge_window_start: '08:00', urge_window_end: '22:00',
  urge_start_at: '', channel: '',
  // v4.12.0：记录本提醒（旧备份里没有这几列，恢复时必须兜底，否则 NOT NULL 炸）
  remind_time: '', remind_advance_days: -1, remind_channel: '', remind_at: '', reminded_at: '',
};

const db = {
  get kind() { return engine.kind; },
  get file() { return config.dbPath; },
  /** 实际生效的日志模式（v4.3.2）：'wal' 是理想值；共享目录上可能是 'delete' */
  get journalMode() { return journalMode; },

  /** v4.10.0（A4=①）：精确重复规则读取（repeat_rule 优先、repeat 翻译回落） */
  getRepeatRule(todo) { return getRepeatRule(todo); },

  exec(sql) { engine.exec(sql); },

  /** 查询多行 */
  all(sql, params) { return engine.all(sql, norm(params)); },

  /** 查询单行，无结果返回 null */
  get(sql, params) {
    const rows = engine.all(sql, norm(params));
    return rows.length ? rows[0] : null;
  },

  /** 写入，返回受影响行数与自增主键 */
  run(sql, params) {
    const r = engine.run(sql, norm(params));
    return {
      changes: Number(r.changes || 0),
      lastInsertRowid: Number(r.lastInsertRowid || 0),
    };
  },

  /** 事务包裹，抛出异常自动回滚 */
  tx(fn) {
    engine.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      engine.exec('COMMIT');
      return out;
    } catch (err) {
      try { engine.exec('ROLLBACK'); } catch { /* 忽略 */ }
      throw err;
    }
  },

  /** 清掉过期会话 */
  pruneSessions() {
    const now = new Date().toISOString();
    return db.run('DELETE FROM sessions WHERE expires_at <= ?', [now]).changes;
  },

  /** 产出一致性单文件副本（VACUUM INTO，自动包含 WAL 中未落盘的数据） */
  snapshotTo(targetPath) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    if (fs.existsSync(targetPath)) fs.rmSync(targetPath);
    db.exec(`VACUUM INTO '${String(targetPath).replace(/'/g, "''")}'`);
    return targetPath;
  },

  close() { engine.close(); },
};

/**
 * 把 settings 表里的管理员设置套到运行配置上（优先级高于环境变量/.env）。
 * 在每次启动时执行一次，保证管理员在界面上改的设置重启后仍生效。
 *
 * ★ v1.6.0：站点名称固定为「我们一家」，不再从 settings 读取 family_name
 *   （旧库里那一行即使还在也不再生效，界面上的「家庭名称」设置项已移除）。
 * ★ v1.8.0：改名功能回来了，但用的是**新键 `site_name`**，而不是复活旧的 `family_name`。
 *   这么选是有意的：`family_name` 是 1.6.0 之前留下的旧值，直接复活它会让一堆老库
 *   在升级瞬间「自己改了名」；新键则保证老库升级后依然是「我们一家」，要改得管理员显式去改。
 */
function applyDbSettings() {
  const KEYS = ['allow_register', 'session_ttl_hours', 'site_name',
    'upload_video_max_mb', 'upload_image_max_mb', 'upload_file_max_mb',
    'push_mail_enabled', 'push_wecom_enabled',
    /* v4.24.0 需求 2：飞书 / 钉钉的家庭级总开关也随库恢复（重启后不丢勾选状态） */
    'push_feishu_enabled', 'push_dingtalk_enabled'];
  const marks = KEYS.map(() => '?').join(',');
  const rows = db.all(`SELECT key, value FROM settings WHERE key IN (${marks})`, KEYS);
  for (const r of rows) {
    if (r.key === 'allow_register') {
      config.allowRegister = String(r.value) !== '0';
    } else if (r.key === 'session_ttl_hours') {
      const n = Number(r.value);
      if (Number.isFinite(n) && n >= 1 && n <= 8760) config.sessionTtlHours = n;
    } else if (r.key === 'upload_video_max_mb') {
      // v4.10.0：视频上限后台可配（5-500MB），运行时字段，请求体上限按它动态计算
      const v = Number(r.value);
      if (Number.isFinite(v) && v >= 5 && v <= 500) config.videoMaxMb = v;
    } else if (r.key === 'upload_image_max_mb') {
      // v4.12.0：图片上限后台可配（1-100MB）
      const v = Number(r.value);
      if (Number.isFinite(v) && v >= 1 && v <= 100) config.imageMaxMb = v;
    } else if (r.key === 'upload_file_max_mb') {
      // v4.12.0：附件上限后台可配（1-200MB）
      const v = Number(r.value);
      if (Number.isFinite(v) && v >= 1 && v <= 200) config.fileMaxMb = v;
    } else if (r.key === 'push_mail_enabled') {
      config.pushMailEnabled = String(r.value) !== '0';
    } else if (r.key === 'push_wecom_enabled') {
      config.pushWecomEnabled = String(r.value) !== '0';
    } else if (r.key === 'push_feishu_enabled') {
      // v4.24.0 需求 2：飞书 / 钉钉的总开关（群机器人通道）
      config.pushFeishuEnabled = String(r.value) !== '0';
    } else if (r.key === 'push_dingtalk_enabled') {
      config.pushDingtalkEnabled = String(r.value) !== '0';
    } else if (r.key === 'site_name') {
      // 空串 / 只剩控制字符 = 没有自定义名称 → 保持出厂默认值
      const name = config.normalizeSiteName(r.value);
      if (name) config.siteName = name;
    }
  }
}

try {
  initSchema();
  migrate();
  applyDbSettings();
} catch (err) {
  if (/disk I\/O error/i.test(String(err && err.message))) {
    console.error('');
    console.error('  ✗ SQLite 磁盘 I/O 错误：数据库所在文件系统不支持 SQLite 的文件锁。');
    console.error('    常见原因：把 Windows / macOS 的目录「绑定挂载」进容器（9p / gRPC-FUSE）。');
    console.error('    解决办法（任选其一）：');
    console.error('      1. Windows / macOS 本机试跑：改用命名卷，见 docker-compose.windows.yml；');
    console.error('      2. 部署到 Linux 服务器：ext4 上的绑定挂载不受影响，按原方式部署即可；');
    console.error('      3. 不用 Docker：直接 node server.js，数据落在项目目录 data/ 下。');
    console.error('');
  }
  throw err;
}

/* ── 全量备份 / 恢复（含图片，用于 App 内一键备份与跨机器迁移）─ */

function listUploads() {
  if (!fs.existsSync(config.uploadDir)) return [];
  return fs
    .readdirSync(config.uploadDir)
    .filter((f) => fs.statSync(path.join(config.uploadDir, f)).isFile());
}

/** 导出全部数据为纯 JSON（图片以 base64 内联，单文件即可完整迁移） */
function exportAll() {
  const payload = {
    format: 'family-hub-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    tables: {
      users: db.all('SELECT * FROM users ORDER BY id'),
      todos: db.all('SELECT * FROM todos ORDER BY id'),
      posts: db.all('SELECT * FROM posts ORDER BY id'),
      comments: db.all('SELECT * FROM comments ORDER BY id'),
      records: db.all('SELECT * FROM records ORDER BY id'),
      // v1.9.0：动态共创与版块已读标记。旧备份文件里没有这两张表 → 见 importAll 的兜底。
      post_contribs: db.all('SELECT * FROM post_contribs ORDER BY id'),
      seen_marks: db.all('SELECT * FROM seen_marks ORDER BY user_id, kind'),
      // v2.0.0：个人通知偏好 + 家庭记账（同样是新增表，旧备份里没有 → importAll 会跳过）
      user_prefs: db.all('SELECT * FROM user_prefs ORDER BY user_id, key'),
      bills: db.all('SELECT * FROM bills ORDER BY id'),
      bill_categories: db.all('SELECT * FROM bill_categories ORDER BY kind, sort, id'),
      bill_budgets: db.all('SELECT * FROM bill_budgets ORDER BY category'),
      bill_chat: db.all('SELECT * FROM bill_chat ORDER BY id'),
      ocr_usage: db.all('SELECT * FROM ocr_usage ORDER BY month'),
      ai_logs: db.all('SELECT * FROM ai_logs ORDER BY id'),
      /* v4.21.0：重复事项「哪一天完成过」。这是用户数据（决定第二天要不要复活），
         备份里带上才叫完整；旧备份没有这张表 → importAll 跳过，不影响恢复。 */
      todo_done_marks: db.all('SELECT * FROM todo_done_marks ORDER BY todo_id, occ_date'),
    },
    uploads: listUploads().map((name) => ({
      name,
      base64: fs.readFileSync(path.join(config.uploadDir, name)).toString('base64'),
    })),
  };
  return payload;
}

/**
 * 从 exportAll() 的产物恢复。整体替换，不可撤销。
 * 恢复后所有会话失效，需要重新登录。
 */
function importAll(payload) {
  if (!payload || payload.format !== 'family-hub-backup' || typeof payload.tables !== 'object') {
    throw new Error('备份文件格式不正确');
  }
  const t = payload.tables;

  /* ★ v4.20.0（审查 W-1）：`PRAGMA foreign_keys` 在**事务内是 no-op** ——
     SQLite 官方规定 BEGIN 与 COMMIT 之间这条不生效。原来它写在 db.tx() 里面，
     等于「注释说导入时会关外键、实际从没关过」：备份里一旦有孤儿 user_id，
     整个导入会整单回滚，而这段代码看起来明明「已经处理过」。
     现在移到事务**外面**，并用 try/finally 保证无论成功失败都恢复外键约束。 */
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.tx(() => {
      db.exec('DELETE FROM comments');
      db.exec('DELETE FROM post_contribs');
      db.exec('DELETE FROM posts');
      // v4.21.0：完成标记指向 todos，必须比 todos 先清（外键已关，但顺序保持可读）
      db.exec('DELETE FROM todo_done_marks');
      db.exec('DELETE FROM todos');
      db.exec('DELETE FROM records');
      db.exec('DELETE FROM seen_marks');
      // v2.0.0：账单类表都指向 users，必须比 users 先清
      db.exec('DELETE FROM bill_chat');
      db.exec('DELETE FROM bills');
      db.exec('DELETE FROM bill_budgets');
      db.exec('DELETE FROM bill_categories');
      db.exec('DELETE FROM ocr_usage');
      db.exec('DELETE FROM ai_logs');
      db.exec('DELETE FROM user_prefs');
      db.exec('DELETE FROM users');
      db.exec('DELETE FROM sessions');

      /* overrides：少数列在两张表里同名但默认值不同（records.remind 默认 0，todos.remind 默认 1），
         全局 COLUMN_DEFAULTS 只能给一个值，所以按表覆盖。 */
      const insertRows = (table, cols, rows, overrides) => {
        if (!Array.isArray(rows) || !rows.length) return;
        const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
        for (const row of rows) {
          db.run(sql, cols.map((c) => {
            const v = row[c];
            if (v != null) return v;
            if (overrides && overrides[c] !== undefined) return overrides[c];
            return COLUMN_DEFAULTS[c] !== undefined ? COLUMN_DEFAULTS[c] : null;
          }));
        }
      };

      insertRows('users', ['id', 'username', 'display_name', 'password_hash', 'is_admin',
        'record_lock_enabled', 'record_lock_hash', 'notify_email', 'avatar', 'created_at',
        'push_channel', 'theme'], t.users);
      insertRows('todos', ['id', 'user_id', 'owner_name', 'title', 'note', 'todo_date', 'start_time', 'end_time',
        'location', 'participants', 'priority', 'repeat', 'done', 'remind', 'reminded_at', 'remind_key',
        'visibility', 'created_at', 'updated_at'], t.todos);
      insertRows('posts', ['id', 'user_id', 'owner_name', 'content', 'images', 'videos', 'tags', 'visibility', 'created_at', 'updated_at'], t.posts);
      // v4.21.0：旧备份里没有 todo_done_marks → 空数组直接返回，不报错
      insertRows('todo_done_marks', ['todo_id', 'occ_date', 'user_id', 'done_at'], t.todo_done_marks);
      insertRows('comments', ['id', 'post_id', 'user_id', 'owner_name', 'content', 'created_at'], t.comments);
      insertRows('records', ['id', 'user_id', 'owner_name', 'title', 'content', 'category', 'tags', 'images',
        'attachments', 'pinned', 'archived', 'visibility', 'created_at', 'updated_at',
        'content_json', 'remind', 'remind_time', 'remind_advance_days', 'remind_channel', 'remind_at', 'reminded_at'],
        t.records, { remind: 0 });
      // v1.9.0：旧备份文件里没有这两张表 → insertRows 对空数组直接返回，不会报错
      insertRows('post_contribs', ['id', 'post_id', 'user_id', 'owner_name', 'content', 'images', 'videos', 'created_at'], t.post_contribs);
      insertRows('seen_marks', ['user_id', 'kind', 'seen_at'], t.seen_marks);
      // v2.0.0：个人偏好与记账。同样是「旧备份里没有就跳过」。
      insertRows('user_prefs', ['user_id', 'key', 'value'], t.user_prefs);
      insertRows('bills', ['id', 'user_id', 'owner_name', 'kind', 'amount_cents', 'category', 'note',
        'platform', 'source', 'raw', 'spent_on', 'created_at', 'updated_at'], t.bills);
      insertRows('bill_categories', ['id', 'kind', 'name', 'sort'], t.bill_categories);
      insertRows('bill_budgets', ['category', 'amount_cents'], t.bill_budgets);
      insertRows('bill_chat', ['id', 'user_id', 'role', 'text', 'bill_id', 'created_at'], t.bill_chat);
      insertRows('ocr_usage', ['month', 'used'], t.ocr_usage);
      // v4.0.0：AI 调用日志。旧备份里没有 → insertRows 对空数组直接返回。
      insertRows('ai_logs', ['id', 'created_at', 'user_id', 'action', 'model', 'images',
        'prompt_tokens', 'completion_tokens', 'total_tokens', 'ok', 'error', 'duration_ms'], t.ai_logs);
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  // 图片先清空再写回，避免残留孤儿文件
  if (Array.isArray(payload.uploads)) {
    for (const f of listUploads()) fs.rmSync(path.join(config.uploadDir, f), { force: true });
    for (const f of payload.uploads) {
      if (!f || typeof f.name !== 'string' || typeof f.base64 !== 'string') continue;
      const safe = path.basename(f.name);
      if (!/^[A-Za-z0-9._-]+$/.test(safe)) continue; // 防目录穿越
      fs.writeFileSync(path.join(config.uploadDir, safe), Buffer.from(f.base64, 'base64'));
    }
  }

  return {
    users: (t.users || []).length,
    todos: (t.todos || []).length,
    posts: (t.posts || []).length,
    comments: (t.comments || []).length,
    records: (t.records || []).length,
    post_contribs: (t.post_contribs || []).length,
    bills: (t.bills || []).length,
    bill_chat: (t.bill_chat || []).length,
    uploads: (payload.uploads || []).length,
  };
}

module.exports = { db, exportAll, importAll, initSchema, getRepeatRule, UPLOAD_DIR: config.uploadDir };
