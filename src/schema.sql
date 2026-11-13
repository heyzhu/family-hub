-- ─────────────────────────────────────────────────────────────
-- 我们一家 · 数据库结构（SQLite）
-- 每次服务启动都会执行一遍，语句均为 IF NOT EXISTS，可安全重复运行。
-- 升级版本时在此文件追加新的 CREATE / ALTER 语句即可，不会丢数据。
-- ─────────────────────────────────────────────────────────────

-- 用户表：本软件是家庭级应用，所有注册用户同属一家人
-- record_lock_*：记录本访问密码。enabled=1 时打开记录本需先解锁；
--                hash 为空表示复用登录密码，否则为自定义访问密码（scrypt 哈希）。
-- avatar：自定义头像图片路径（v1.6.0 新增），空串表示用「昵称首字色块」兜底。
CREATE TABLE IF NOT EXISTS users (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  username            TEXT    NOT NULL UNIQUE,                 -- 登录名
  display_name        TEXT    NOT NULL,                        -- 显示昵称
  password_hash       TEXT    NOT NULL,                        -- scrypt 加盐哈希，绝不存明文
  is_admin            INTEGER NOT NULL DEFAULT 0,              -- 第一个注册的用户自动为 1
  record_lock_enabled INTEGER NOT NULL DEFAULT 0,
  record_lock_hash    TEXT    NOT NULL DEFAULT '',
  notify_email        TEXT    NOT NULL DEFAULT '',             -- 提醒/通知收件邮箱，空表示不接收
  push_channel        TEXT    NOT NULL DEFAULT 'auto',         -- v4.7.0 主动提醒走哪条；v4.8.0 默认 auto = 优先企业微信、邮件兜底（另可 mail / both）
  avatar              TEXT    NOT NULL DEFAULT '',             -- 自定义头像路径，空表示用首字色块
  theme               TEXT    NOT NULL DEFAULT '',             -- v4.11.0 界面主题：'forest' / 'paper' / 'ocean'，空表示用默认主题
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 会话表：支撑「登录一次，1 天内免登录」
-- records_unlocked：记录本上锁时，本会话是否已通过密码解锁
CREATE TABLE IF NOT EXISTS sessions (
  token            TEXT    PRIMARY KEY,                      -- 随机 32 字节，只存在 httpOnly Cookie 里
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  records_unlocked INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at       TEXT    NOT NULL
);

-- 系统设置：管理员在界面上修改的注册开关 / 免登录有效期 / 通知与提醒参数。
-- 保存在数据库里，优先级高于环境变量与 .env，重启后仍然生效。
-- 与通知相关的键（v1.5.0）：
--   remind_enabled       待办到点提醒的总开关
--   remind_advance_days  提前几天提醒（0-5）
--   notify_on_change     内容变更通知总开关
--   notify_kinds         内容变更通知分项，逗号分隔：todo,post,record,comment
-- v1.6.0：站点名称曾固定为「我们一家」；v1.8.0 起改为管理员可在「家庭设置」里自定义，
--   存的键是 site_name（空 = 用默认名）。旧的 family_name 键保留但**永不读取**，
--   这样老库升级后不会突然改名。改这些键都不需要改表结构（本来就是 key/value）。
--   records_hidden_categories  记录本里被删除（隐藏）的分类，逗号分隔
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 待办事项：万年历日程
-- todo_date 允许为空：不设日期的待办只出现在待办列表中，不出现在日历上
-- repeat 重复规则（v1.9.0 从「每年」扩展到「每月」，v2.0.0 再加「每周」，
--        规格由 public/repeat.js 单点实现）：
--        ''=不重复；'solar_yearly'=每年公历同一天；'lunar_yearly'=每年农历同一天；
--        'solar_monthly'=每月公历同一天；'lunar_monthly'=每月农历同一天；
--        'solar_weekly'=每周公历同一星期几。
--        基准日期就是 todo_date，之后按规则自动继承显示（前端展开、服务端判落点，同一份实现）。
--        ★ 这个 CHECK 约束变更需要重建表（SQLite 不支持改约束）—— 见 db.js 的 migrate()。
-- remind/reminded_at/remind_key：邮件提醒。remind_key 存「已经提醒过的落点日期」，
--        一次性待办存自己的 todo_date；重复事项存本次的落点，所以每个周期都能再发一次。
CREATE TABLE IF NOT EXISTS todos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_name   TEXT    NOT NULL DEFAULT '',
  title        TEXT    NOT NULL,
  note         TEXT    NOT NULL DEFAULT '',
  todo_date    TEXT,                                     -- YYYY-MM-DD，可为空（未安排日期）
  start_time   TEXT    NOT NULL DEFAULT '',              -- HH:MM，空串表示不限
  end_time     TEXT    NOT NULL DEFAULT '',
  location     TEXT    NOT NULL DEFAULT '',
  participants TEXT    NOT NULL DEFAULT '[]',            -- JSON 数组，参与人昵称
  priority     TEXT    NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  repeat       TEXT    NOT NULL DEFAULT '' CHECK (repeat IN ('','solar_yearly','lunar_yearly','solar_monthly','lunar_monthly','solar_weekly')),
  -- v4.10.0：精确重复规则（含 daily）。''= 未设置，读取时回落 repeat（见 db.js getRepeatRule）。
  -- 旧 repeat 带 CHECK，SQLite 改不了 CHECK，所以按文档 A4=① 用「新旧双列、读取回落」，
  -- 不重建表；写入时两列同时写（repeat_rule 是唯一真相，repeat 写兼容值）。
  repeat_rule  TEXT    NOT NULL DEFAULT '',
  -- v4.10.0：跨天待办。''= 单日（结束日就是 todo_date）。
  -- 规则：end_date 非空时必须 >= todo_date；todo_date 为空时 end_date 强制为空；与重复互斥。
  end_date     TEXT    NOT NULL DEFAULT '',
  done         INTEGER NOT NULL DEFAULT 0,
  remind       INTEGER NOT NULL DEFAULT 1,
  -- v4.22.0 需求 1：每条待办自己的「提前几天提醒」。
  --   -1 = 跟随家庭设置（默认，老数据行为不变）；0–5 = 这条待办自己指定，并**覆盖**全局值。
  remind_advance_days INTEGER NOT NULL DEFAULT -1,
  -- v4.22.0 需求 2：是否由「一句话添加」（网页 / 微信）创建。1 = 是。
  --   这类待办每天重复、只进「待办列表」，不占「周期提醒」卡；
  --   ★ v4.28.0 起与所有重复事项同口径：勾选只表示「今天不再提醒」，
  --     从待办列表移除、**不进「已完成」**（明天照常回来）。
  quick        INTEGER NOT NULL DEFAULT 0,
  -- v4.6.0：催促完成。0 = 不催；1–60 = 到点后每隔这么多分钟用企业微信催一次
  urge_minutes INTEGER NOT NULL DEFAULT 0,
  urge_last_at TEXT    NOT NULL DEFAULT '',
  -- v4.10.0：催促状态机（文档 5.10）。idle/pending/active/paused/done_by_reply/
  -- stopped_by_deadline/stopped_by_max_count/stopped_by_manual。'' 老数据回落 idle。
  -- 停催靠状态进终态，不再清 urge_minutes（那是用户的配置，清了下次编辑就看不见原值）。
  urge_status  TEXT    NOT NULL DEFAULT '',
  urge_count   INTEGER NOT NULL DEFAULT 0,              -- 已经催过几次（催满 urge_max_count 自动停）
  urge_max_count INTEGER NOT NULL DEFAULT 20,           -- 0 = 不限
  urge_window_start TEXT NOT NULL DEFAULT '08:00',      -- 静默时段（本地时刻 HH:MM）
  urge_window_end   TEXT NOT NULL DEFAULT '22:00',
  urge_start_at     TEXT NOT NULL DEFAULT '',           -- 催促开始时刻 HH:MM，''= 首次提醒时刻
  reminded_at  TEXT,
  remind_key   TEXT    NOT NULL DEFAULT '',
  visibility   TEXT    NOT NULL DEFAULT 'family' CHECK (visibility IN ('family','private')),
  -- v4.28.2：指定可见成员（只有 visibility='private' 时有意义），存 ",2,3," 形式：
  --   两端带逗号，服务端用 instr(visible_to, ',<id>,') 精确匹配，避免 id 前缀误命中
  --   （2 与 12）。创建者本人不在里面 —— 他始终可见（user_id 就是本人）。
  --   ★ 空串 + private 的老数据 = 「仅自己可见」，语义向后兼容，不需要改库值。
  visible_to   TEXT    NOT NULL DEFAULT '',
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 重复事项的「某一天已经做完」（v4.21.0 需求 2）
-- 背景：重复事项没有全局完成状态（明天的同一件事必须还是未完成），
--   但「今天这次」是可以做完的 —— 旧版干脆不给勾选框，结果每天重复的待办
--   永远挂在待办列表里做不掉。这里按「落点日」记账：
--     · 一行 = 某条重复事项的某一天已经完成；
--     · 删掉这一行 = 撤回完成（再勾一次就取消）；
--     · 第二天天然读不到昨天的行 → 自动回到未完成，不需要任何定时任务。
-- ★ 只对重复事项写入；一次性待办的完成状态仍然在 todos.done（语义没变）。
CREATE TABLE IF NOT EXISTS todo_done_marks (
  todo_id      INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  occ_date     TEXT    NOT NULL,                     -- YYYY-MM-DD，落点（墙上日期）
  user_id      INTEGER NOT NULL DEFAULT 0,           -- 谁勾的（只做留痕，权限仍看可见性）
  done_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (todo_id, occ_date)
);

-- 迁移记录（v4.21.0 · 技术债 W-8）
-- 为什么要有这张表：升级一直是「静默行为」——只在启动日志里打一行。
--   出了问题（比如某台机器上的老库没按预期补列）事后根本查不出「到底跑过哪些迁移」。
--   现在 migrate() 每做一件事就往这里写一行（主键去重），只写不读业务不依赖它，
--   排查时 `SELECT * FROM schema_migrations` 就是这台机器的升级履历。
-- ★ 刻意不放进备份/恢复：它描述的是「这台机器」而不是「这家人」，
--   从别的机器恢复备份时不应该把别人的升级履历搬过来。
CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 图文动态：家庭朋友圈
-- videos：视频路径 JSON 数组（v1.9.0 新增）。与 images 并列，播放器在卡片里内联播放。
-- video_covers（v4.3.3 需求 8）：视频封面映射，JSON 对象 {视频路径: 封面图片路径}。
--   为什么必须单独存封面：移动端 Safari 对 `#t=0.1` 这类媒体片段**不生效**，
--   而且部分安卓浏览器在 preload=metadata 时不绘制首帧 → 列表里一排黑框。
--   上传视频时前端用 canvas 抽第一帧、与视频一起上传，这里存下来当 poster。
--   存成对象而不是改 videos 的数组结构：videos 是字符串数组，改成对象数组会让
--   老数据（纯字符串）解析出 undefined，所有历史动态一起炸。
CREATE TABLE IF NOT EXISTS posts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_name   TEXT    NOT NULL DEFAULT '',
  content      TEXT    NOT NULL DEFAULT '',
  images       TEXT    NOT NULL DEFAULT '[]',              -- JSON 数组，图片路径
  videos       TEXT    NOT NULL DEFAULT '[]',              -- JSON 数组，视频路径
  video_covers TEXT    NOT NULL DEFAULT '{}',              -- JSON 对象，视频路径 → 封面路径
  tags         TEXT    NOT NULL DEFAULT '[]',              -- JSON 数组，标签
  visibility   TEXT    NOT NULL DEFAULT 'family' CHECK (visibility IN ('family','private')),
  -- v4.28.2：指定可见成员（只有 visibility='private' 时有意义），存 ",2,3," 形式：
  --   两端带逗号，服务端用 instr(visible_to, ',<id>,') 精确匹配，避免 id 前缀误命中
  --   （2 与 12）。创建者本人不在里面 —— 他始终可见（user_id 就是本人）。
  --   ★ 空串 + private 的老数据 = 「仅自己可见」，语义向后兼容，不需要改库值。
  visible_to   TEXT    NOT NULL DEFAULT '',
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 动态共创（v1.9.0）：家人对**别人的**动态追加内容，每条留痕（谁、什么时候、加了什么）。
-- 与 comments 分开：评论是「说一句话」，共创是「往这条动态里添内容」，要能带图片与视频。
-- 可见性完全跟随所属动态（本表没有 visibility 列，不要往上套 VISIBLE 谓词）。
-- updated_at（v4.3.3 需求 5）：「一起写」也能改自己已经写下的内容了。
--   保留 created_at（首次写下）并新增 updated_at，界面上显示「一起写 · 编辑于 …」，
--   这样家人能看出这条后来被动过，而不是以为一开始就是这么写的。
CREATE TABLE IF NOT EXISTS post_contribs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_name TEXT    NOT NULL DEFAULT '',
  content    TEXT    NOT NULL DEFAULT '',
  images     TEXT    NOT NULL DEFAULT '[]',
  videos     TEXT    NOT NULL DEFAULT '[]',
  -- v4.6.0：共创里视频的封面映射 {视频路径: 封面路径}（移动端不认 #t=0.1，必须有 poster）
  video_covers TEXT  NOT NULL DEFAULT '{}',
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT    NOT NULL DEFAULT ''
);

-- 版块「已读」标记（v1.9.0）：底部导航红点用。
-- 红点规则：某个版块里最新的内容更新时间 > 我上次查看该版块的时间 → 亮红点。
-- 放服务端（而不是 localStorage）是为了多设备一致：手机上点开了，电脑上也不再亮。
CREATE TABLE IF NOT EXISTS seen_marks (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind     TEXT    NOT NULL,                             -- todo / post / record
  seen_at  TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, kind)
);

-- 动态评论：多用户评论全部展示
-- v4.3.3 需求 1：支持回复他人评论（交互同朋友圈 —— 只有两级，回复统一挂在**顶层评论**下）。
--   parent_id     = 被回复的那条顶层评论 id；0 表示这条本身就是顶层评论。
--                   刻意不做多级树：朋友圈也只有两级，多级在手机上根本展开不清，
--                   而且递归渲染会让「最小重绘」的节点复用彻底失控。
--   reply_to_name = 被回复人的昵称快照。为什么不 join 查：评论可能被删，
--                   删了之后「回复 张三」这句话仍然要能正常显示，不能变成空。
CREATE TABLE IF NOT EXISTS comments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id       INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_name    TEXT    NOT NULL DEFAULT '',
  content       TEXT    NOT NULL,
  parent_id     INTEGER NOT NULL DEFAULT 0,
  reply_to_name TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 点赞（v4.3.3 需求 1）：一条动态、一条评论都能被点赞。
-- 用 target + target_id 一张表覆盖两种对象，而不是拆两张表：
--   两种赞的语义、权限、去重规则完全一样，拆开只会让「取这条动态的全部赞」
--   变成两次查询再合并。
-- ★ UNIQUE(target, target_id, user_id) 是**幂等的物理保证**：
--   前端连点两下、两个标签页同时点，都不会出现「一个人赞两次」。
-- ★ 本表同样没有 visibility 列，可见性跟随所属动态（与 comments / post_contribs 一致）。
CREATE TABLE IF NOT EXISTS post_likes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target     TEXT    NOT NULL DEFAULT 'post' CHECK (target IN ('post','comment')),
  target_id  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (target, target_id, user_id)
);

-- 重点事项记录本：长期保存的重要信息
-- attachments：附件（v1.5.0 新增），JSON 数组 [{name,path,size}]，name 是原始文件名。
-- archived：归档（v1.9.0 新增），1 = 已归档。归档不是删除 —— 记录还在库里、还能搜到，
--           只是列表默认不展示（长按记录卡片可归档/取消归档），给「办完但想留个底」的事用。
-- 界面已不再使用 tags（v1.5.0 移除标签功能），但列保留：
--             删列要重建表，而本项目吃过「重建表吞掉先补的列」的亏；保留还能让老数据不丢。
CREATE TABLE IF NOT EXISTS records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_name  TEXT    NOT NULL DEFAULT '',
  title       TEXT    NOT NULL,
  content     TEXT    NOT NULL DEFAULT '',
  category    TEXT    NOT NULL DEFAULT '通用',
  tags        TEXT    NOT NULL DEFAULT '[]',              -- JSON 数组（已停用，保留兼容）
  images      TEXT    NOT NULL DEFAULT '[]',              -- JSON 数组，图片路径
  attachments TEXT    NOT NULL DEFAULT '[]',              -- JSON 数组，附件 [{name,path,size}]
  -- v4.10.0：行模型内容（A5=①）。''= 老记录，服务端现场把 content 包装成一行 text 返回。
  -- 写入时同步把 content 更新成所有 text/checkbox 行的拼接，保证搜索与旧接口可用。
  content_json TEXT   NOT NULL DEFAULT '',
  pinned      INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0,                 -- 1 = 已归档（v1.9.0）
  -- v4.12.0：记录本提醒。**默认不提醒**（需求：记录本里的信息是「长期保存」的，
  --   不是「到点要做什么」的，默认开着只会变成骚扰）。
  --   remind_time        '' = 跟随家庭设置里的「默认提醒时间」
  --   remind_advance_days -1 = 跟随家庭设置；0–5 = 自己指定提前几天
  --   remind_channel     '' = 跟随系统推送方式；mail / wecom / both = 本条单独指定
  --   remind_at          算好的提醒时刻（UTC ISO）；reminded_at 为空表示还没发过
  remind      INTEGER NOT NULL DEFAULT 0,
  remind_time TEXT    NOT NULL DEFAULT '',
  remind_advance_days INTEGER NOT NULL DEFAULT -1,
  remind_channel TEXT NOT NULL DEFAULT '',
  remind_at   TEXT    NOT NULL DEFAULT '',
  reminded_at TEXT    NOT NULL DEFAULT '',
  visibility  TEXT    NOT NULL DEFAULT 'family' CHECK (visibility IN ('family','private')),
  -- v4.28.2：指定可见成员（只有 visibility='private' 时有意义），存 ",2,3," 形式：
  --   两端带逗号，服务端用 instr(visible_to, ',<id>,') 精确匹配，避免 id 前缀误命中
  --   （2 与 12）。创建者本人不在里面 —— 他始终可见（user_id 就是本人）。
  --   ★ 空串 + private 的老数据 = 「仅自己可见」，语义向后兼容，不需要改库值。
  visible_to   TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_todos_date     ON todos (todo_date, start_time);
CREATE INDEX IF NOT EXISTS idx_posts_created  ON posts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_post  ON comments (post_id, created_at);
/* ★ idx_comments_parent（parent_id）**不在**这里建：老库里 comments 还没有这一列，
   而 schema.sql 是在 migrate() 之前执行的 —— 在这里建索引会让升级中的老库直接
   报「no such column: parent_id」，服务根本起不来。它放在 db.js 的 migrate() 里、
   ALTER 补列之后。 */
CREATE INDEX IF NOT EXISTS idx_contribs_post  ON post_contribs (post_id, created_at);
-- v4.3.3：取「一条动态下所有赞」走这个索引；target 在前是因为查询永远带上它
CREATE INDEX IF NOT EXISTS idx_likes_target   ON post_likes (target, target_id);
CREATE INDEX IF NOT EXISTS idx_records_order  ON records (pinned DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp   ON sessions (expires_at);

-- ─────────────────────────────────────────────────────────────
-- v2.0.0 · 个人通知偏好 + 家庭记账（全部是新增表，**不动任何原有业务表**）
-- ─────────────────────────────────────────────────────────────

-- 个人偏好：每个成员自己的通知偏好，与管理员在「家庭设置」里定的全站值分开。
-- 设计要点：**个人设置只能「收窄」不能「放大」** —— 管理员把某类通知总开关关掉了，
-- 个人再打开也不会收到（见 notify.js / reminders.js）。这样管理员仍然能兜住全局。
-- 用 key/value 存而不是加列：以后再加偏好项不用改表结构（settings 表同款思路）。
--   remind_enabled      个人是否接收待办提醒（'0' / '1'；整行不存在 = 跟随全局）
--   remind_advance_days 个人提前几天（'0'-'5'）
--   notify_on_change    个人是否接收内容变更通知（'0' / '1'）
--   notify_kinds        个人接收哪些类型，逗号分隔：todo,post,record,comment
--   notify_quiet_start / notify_quiet_end  个人免打扰时段（HH:MM，空 = 不启用）
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     TEXT    NOT NULL,
  value   TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, key)
);

-- 家庭账单（v2.0.0）：全家人的收支流水。
-- ★ 需求明确「家庭成员可查看全部家庭账单」，所以本表**没有 visibility 列**，
--   账单本身就是全家共享的内容（与 comments / post_contribs 同一套路数：
--   可见性不写在表上，就别往上套 VISIBLE 谓词）。
-- ★ 金额一律用「分」存整数：浮点数做金额加减会累积误差（0.1+0.2 !== 0.3），
--   界面上再除以 100 显示。导出的 CSV 也按两位小数输出。
-- spent_on：这笔账算在哪一天（按家里人看到的墙上日期，YYYY-MM-DD），
--   与 created_at（记录时间）分开 —— 「今天补记昨天的账」是很常见的事。
CREATE TABLE IF NOT EXISTS bills (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_name   TEXT    NOT NULL DEFAULT '',
  kind         TEXT    NOT NULL DEFAULT 'expense' CHECK (kind IN ('income','expense')),
  amount_cents INTEGER NOT NULL DEFAULT 0,
  category     TEXT    NOT NULL DEFAULT '其他',
  note         TEXT    NOT NULL DEFAULT '',
  source       TEXT    NOT NULL DEFAULT 'text' CHECK (source IN ('text','ocr')),
  raw          TEXT    NOT NULL DEFAULT '',               -- 用户原话 / OCR 原文，便于追溯
  spent_on     TEXT    NOT NULL DEFAULT '',               -- YYYY-MM-DD
  -- platform（v4.0.0）：交易平台（支付宝/微信/银行卡…）。AI 提取字段之一，
  --   老库由 db.js 的 migrate() 补列（ALTER TABLE ... ADD COLUMN，幂等）。
  platform     TEXT    NOT NULL DEFAULT '',
  -- v4.10.0（A9=③）：精确来源。''= 回落读 source；五值
  -- manual/local_text/ai_image/wecom_text/wecom_image。旧 source 继续双写兼容。
  source_channel TEXT  NOT NULL DEFAULT '',
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- AI 调用日志（v4.0.0）：每次调用千问（截图识别 / 一句话解析 / 拉模型列表）记一条，
--   含图片数、token 用量与成功与否 —— API 成本必须可审计，不能只在控制台里打一行。
-- user_id 可为空（系统级调用 / 测试注入没有用户上下文）。
CREATE TABLE IF NOT EXISTS ai_logs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_id           INTEGER,
  action            TEXT    NOT NULL DEFAULT '',             -- ocr | sentence | models
  model             TEXT    NOT NULL DEFAULT '',
  images            INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  ok                INTEGER NOT NULL DEFAULT 0,
  error             TEXT    NOT NULL DEFAULT '',
  duration_ms       INTEGER NOT NULL DEFAULT 0
);

-- 收支分类（v2.0.0）：出厂预置一份（见 bills.js 的 DEFAULT_CATEGORIES），
-- 管理员可以在「记账设置」里增删；分类名改了不影响历史账单（账单里存的是名字快照）。
CREATE TABLE IF NOT EXISTS bill_categories (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT    NOT NULL CHECK (kind IN ('income','expense')),
  name TEXT    NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE (kind, name)
);

-- 分类月度预算（v2.0.0）：记账后如果某分类当月已达预算，立刻在聊天窗里提醒。
-- 只按分类维度，不按人 —— 「这个月家里买衣服花超了」比「妈妈买超了」更有用。
CREATE TABLE IF NOT EXISTS bill_budgets (
  category     TEXT PRIMARY KEY,
  amount_cents INTEGER NOT NULL DEFAULT 0
);

-- 记账聊天记录（v2.0.0）：★ v4.0.0 起聊天内容**不再写库**，只存浏览器本地缓存且仅保留当日
--   （需求 1：聊天是过程性内容，不值得永久落库）。表保留是为了不丢历史数据、备份格式不变。
CREATE TABLE IF NOT EXISTS bill_chat (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT    NOT NULL CHECK (role IN ('user','system')),
  text       TEXT    NOT NULL DEFAULT '',
  bill_id    INTEGER,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- OCR 月度用量（v2.0.0）：百度 OCR 每月 1000 次免费额度，后端记账、每月 1 号自动换月。
-- 主键是月份字符串（YYYY-MM），所以「跨月清零」不需要任何定时任务 —— 换个月份就是 0。
CREATE TABLE IF NOT EXISTS ocr_usage (
  month TEXT PRIMARY KEY,
  used  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_bills_spent   ON bills (spent_on DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_bills_user    ON bills (user_id, spent_on DESC);
-- v4.22.0 需求 3：统计 / 明细都以 `kind='expense' AND spent_on 范围` 为条件。
--   单列 spent_on 索引只能先按日期过滤再回表筛 kind；(kind, spent_on) 能把范围一次走完，
--   2 万条时统计聚合从 ~22ms 降到个位数毫秒（见 _verify/_bench-bills.js）。
CREATE INDEX IF NOT EXISTS idx_bills_kind_spent ON bills (kind, spent_on);
CREATE INDEX IF NOT EXISTS idx_bill_chat     ON bill_chat (user_id, id);
CREATE INDEX IF NOT EXISTS idx_ai_logs_at    ON ai_logs (created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- v4.3.3 · 免打扰期间的邮件汇总发件箱
-- ─────────────────────────────────────────────────────────────

-- 为什么需要这张表（而不是内存队列）：
--   旧行为是「只要有收件人还在免打扰里，整封邮件就等到最晚那个人出来」——
--   一个人设了 22:00→08:00，全家都被拖到早上 8 点；而且等到点后是**一条一条**发，
--   睡醒一看收件箱里躺着七八封提醒，体验比晚一点更糟。
--   v4.3.3 起：免打扰期间该发的每一封都**先落这张表**，到免打扰结束的那个时刻，
--   按「收件人」把积压的邮件**合并成一封**发出去。
-- 必须落库：进程重启、容器升级都会打断内存队列，落库才谈得上「不丢、不重」。
--   due_at    = 最早可以发送的时刻（= 该收件人免打扰结束的瞬时，ISO 字符串）
--   sent_at   = 实际发出的时刻，空串表示还在队列里
--   origin_id = 来源记录（如 todos.id），仅用于排查，不参与业务判断
CREATE TABLE IF NOT EXISTS mail_outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT    NOT NULL DEFAULT '',
  kind       TEXT    NOT NULL DEFAULT '',        -- remind | notify | bill
  subject    TEXT    NOT NULL DEFAULT '',
  text       TEXT    NOT NULL DEFAULT '',
  html       TEXT    NOT NULL DEFAULT '',
  due_at     TEXT    NOT NULL DEFAULT '',
  origin_id  INTEGER NOT NULL DEFAULT 0,
  -- v4.10.0：出站通道。''= 邮件（历史行为）；'wecom' = 免打扰期间 defer 下来的企业微信主动推送，
  -- 冲刷时用 wecom.sendText 发出（差异 #12：企微主动推送也受个人免打扰约束）。
  channel    TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at    TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON mail_outbox (sent_at, due_at);
CREATE INDEX IF NOT EXISTS idx_outbox_user    ON mail_outbox (user_id, sent_at);

-- ─────────────────────────────────────────────────────────────
-- v4.10.0 · 催促流水（文档 5.10.8：幂等占位 + 留痕）
-- ─────────────────────────────────────────────────────────────
-- 「下次什么时候催」不存表，由 urge_last_at + urge_minutes 现算（与 urge.js 一致）。
-- 本表做两件事：发送前先占位（四元组唯一索引，并发重复插入直接冲突 → 不会发两条），
-- 以及留流水（第几次、走哪个通道、成功失败），供催促日志接口查询。
CREATE TABLE IF NOT EXISTS todo_nag_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  todo_id    INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  nag_seq    INTEGER NOT NULL,                        -- = 本次发送前 todos.urge_count 的值
  channel    TEXT    NOT NULL CHECK (channel IN ('wecom','email')),
  msg_type   TEXT    NOT NULL DEFAULT '',
  sent_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- ★ 默认 'pending'：先占位再发送，发完更新成 success/fail（dedup 保留给将来）
  delivered  TEXT    NOT NULL DEFAULT 'pending' CHECK (delivered IN ('pending','success','fail','dedup')),
  error_code TEXT    NOT NULL DEFAULT '',
  UNIQUE (todo_id, user_id, nag_seq, channel)
);
CREATE INDEX IF NOT EXISTS idx_nag_logs_at ON todo_nag_logs (sent_at);

-- ─────────────────────────────────────────────────────────────
-- v4.9.0 · 企业微信记账草稿箱（服务端）
-- ─────────────────────────────────────────────────────────────

-- 微信端「存草稿」的落点：重复检测拦下后，用户可以选择先存着，回网页端改好再提交。
-- 为什么独立成表而不是复用 bills + 状态列：草稿没有「账」的完整性（可能还缺确认），
--   混进 bills 会让每一条「全家共享账单」的查询都要多带一个 status 过滤，
--   漏一处草稿就出现在全家账本里 —— 独立表从物理上杜绝这种事故。
-- status：draft = 待处理；submitted = 已确认入账（bill_id 回指正式账单，留痕可查）。
-- raw 保留用户原话：提交时网页端能看到「当时在微信里说的是什么」，改起来有依据。
CREATE TABLE IF NOT EXISTS bill_drafts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_name   TEXT    NOT NULL DEFAULT '',
  kind         TEXT    NOT NULL DEFAULT 'expense' CHECK (kind IN ('income','expense')),
  amount_cents INTEGER NOT NULL DEFAULT 0,
  category     TEXT    NOT NULL DEFAULT '其他',
  note         TEXT    NOT NULL DEFAULT '',
  platform     TEXT    NOT NULL DEFAULT '',
  spent_on     TEXT    NOT NULL DEFAULT '',               -- YYYY-MM-DD
  raw          TEXT    NOT NULL DEFAULT '',               -- 微信里的原话
  source       TEXT    NOT NULL DEFAULT 'wecom',
  status       TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted')),
  bill_id      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_bill_drafts_user ON bill_drafts (user_id, status, updated_at DESC);


-- ─────────────────────────────────────────────────────────────
-- v4.23.0 · 推送日志（需求 5：所有推送留痕，管理员可清除）
-- ─────────────────────────────────────────────────────────────
-- 一条 = 一次「对某个人的一次投递尝试」，由 push.deliver 统一写入。
-- 为什么不在 push.deliver 里只记聚合结果：排查「XX 没收到」时需要知道
--   「他那条走了哪条通道、失败原因是什么」，聚合成一行就答不了这个问题。
-- kind：remind（待办提醒）/ record（记录本提醒）/ notify（内容通知）/
--       bill（记账推送）/ outbox（免打扰缓发）/ test（测试发送）/ push（其他）
-- channel：wecom / mail / ''（没有可用通道）
-- ★ 只保留最近若干条（push.js 里按上限裁剪），避免长期运行后日志表无限膨胀。
CREATE TABLE IF NOT EXISTS push_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT    NOT NULL DEFAULT '',
  kind       TEXT    NOT NULL DEFAULT '',
  user_id    INTEGER NOT NULL DEFAULT 0,
  user_name  TEXT    NOT NULL DEFAULT '',
  channel    TEXT    NOT NULL DEFAULT '',
  ok         INTEGER NOT NULL DEFAULT 0,
  subject    TEXT    NOT NULL DEFAULT '',
  detail     TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_push_logs_kind ON push_logs (kind, id DESC);

-- ── 忘记密码（v4.26.0）───────────────────────────────────────
-- 一条 = 一次「邮箱验证码」申请。规则由 src/resetpw.js 统一裁决：
--   · 只认 users.notify_email（用户自己绑定的收件邮箱），不额外引入邮箱账号概念；
--   · 6 位数字，15 分钟有效、单次使用、错 5 次作废、10 分钟内最多发 3 次；
--   · code_hash = sha256(salt + ':' + code)，**不存明文**（库被看到也不能直接拿去重置）；
--   · 每次申请先清掉该用户的旧记录 —— 一人同时只允许一个有效验证码，
--     否则「连点三次拿三个码」会让用户不知道该填哪个。
CREATE TABLE IF NOT EXISTS password_resets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  code_hash  TEXT    NOT NULL,
  salt       TEXT    NOT NULL DEFAULT '',
  tries      INTEGER NOT NULL DEFAULT 0,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT '',
  expires_at TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets (user_id, id DESC);
