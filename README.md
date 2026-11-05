# 我们一家（family-hub）

> 一个自托管的家庭共享记录 Web 应用。待办、动态、记录本与记账共用一个网址，全家人在各自账号里读写同一份数据。当前版本 4.25.0，默认监听端口 3455。

> **许可证**：本项目采用 GNU Affero General Public License v3.0（`AGPL-3.0-only`），全文见仓库根目录的 `LICENSE`。

本文档只记录仓库文件能够核对的事实，以及使用者可以自行复现的命令。本文档不写入性能数据、效果评价、未来计划或第三方服务承诺。文末按 MLA 格式列出引用来源。

---

## 一、项目简介

本项目由三部分组成：服务端使用 Node.js 内置的 `node:http` 与 `node:sqlite`；业务代码位于 `src/`；前端位于 `public/`，由原生 HTML、CSS 与 JavaScript 组成。项目没有前端构建步骤，`package.json` 的 `dependencies` 为空对象；`better-sqlite3` 只作为 `optionalDependencies` 存在，供低于 22.5 的 Node 版本回退使用。服务端在启动时按 `src/schema.sql` 幂等建表，并对老库执行 `src/db.js` 里的结构迁移 (Family Hub Project, package.json, ll. 2-18; server.js, ll. 11-30; src/db.js, ll. 19-44)。

全部结构化数据保存在 `DB_PATH` 指向的单个 SQLite 文件里，默认路径是 `data/family.db`；图片、记录本附件与动态视频保存在 `UPLOAD_DIR` 指向的目录里，默认路径是 `data/uploads`。服务端每次启动会创建这两个目录。浏览器通过同源 HTTP 与服务端通信，会话凭证放在 httpOnly Cookie 里 (Family Hub Project, src/config.js, ll. 88-92; src/db.js, ll. 60-61; src/auth.js, ll. 580-596)。

界面是单页壳 `public/index.html`，底部有五个页签：待办、动态、记录本、记账、我的。页面还引用 `public/manifest.webmanifest`，浏览器可以把它添加到主屏幕。界面提供 `forest`、`paper`、`ocean` 三套主题 (Family Hub Project, public/index.html, ll. 13-16, 88-129; public/app.js, l. 61)。

版本号以 `package.json` 为唯一来源，`GET /api/config` 会把版本、站点名称、注册开关以及上传上限下发给前端 (Family Hub Project, src/config.js, ll. 76-86; src/api.js, ll. 3152-3183)。

---

## 二、项目旨在解决的核心问题

本节归纳四类家庭信息在本项目中的收拢方式；每一项都对应仓库里实际存在的模块。

| 家庭里常见的情况 | 本项目提供的收拢方式 |
| --- | --- |
| 家人的日程与提醒分散在各自的备忘录里。 | 本项目把待办、万年历与提醒放进同一个「待办」页签。服务端 `src/reminders.js` 每分钟扫描到点事项；`public/repeat.js` 承担重复规则的落点计算；`public/lunar.js` 提供农历数据。 |
| 家庭照片与生活记录散落在群聊里，家人难以回看与补充。 | 本项目把文字、图片、视频、评论、点赞与「一起写」共创放进「动态」页签。`src/api.js` 对 `posts`、`comments`、`post_contribs`、`post_likes` 提供读写接口。 |
| 证件位置、账号备忘、病史这类信息需要长期保存，又要限制查看范围。 | 本项目用「记录本」页签保存分类、正文、图片、附件与归档状态，并提供访问密码。服务端用统一的可见性谓词判断谁能读、谁能改。 |
| 一家人各记各的账，口径和统计对不上。 | 本项目用「记账」页签提供一句话记账、统计、日历、CSV 导出与定时报表。`src/billparse.js` 在本地解析金额、日期、分类与备注；`src/bills.js` 负责账单与报表。 |

本表涉及的模块与部署文件见本节标注 (Family Hub Project, src/reminders.js; public/repeat.js; public/lunar.js; src/api.js; src/billparse.js; src/bills.js; docker-compose.yml; 部署说明.md)。

上述四类数据默认对全家可见；创建者可以把单条内容设为 `private`，此时服务端只允许创建者本人访问。写操作里的 `user_id` 一律取自服务端会话，服务端不接受客户端指定的用户身份 (Family Hub Project, src/api.js, ll. 45-46, 650-702; src/schema.sql, l. 76; src/billparse.js, ll. 1-24)。

部署形态上，本项目把数据留在部署者自己的目录里：源码方式写在项目下的 `data/`，Docker Compose 方式把宿主机 `./data` 挂载到容器 `/data`。备份、迁移与恢复都围绕这个目录进行 (Family Hub Project, docker-compose.yml, ll. 74-82; 部署说明.md, ll. 446-478)。

---

## 三、主要功能特性

### 3.1 待办与万年历

- 本项目提供公历与农历日历数据，待办可以填写标题、日期、起止时间、参与人、重要程度、备注与可见性 (Family Hub Project, src/api.js, ll. 650-695)。
- 重复规则支持六种取值：不重复、每周公历、每月公历、每月农历、每年公历、每年农历。`public/repeat.js` 是规则落点的唯一实现，前端与服务端共用同一份文件 (Family Hub Project, src/schema.sql, l. 76; public/repeat.js, ll. 19-45)。
- 服务端支持提前提醒天数、按落点日记录重复事项的完成状态，以及通过企业微信催促完成 (Family Hub Project, src/api.js, ll. 620-648; server.js, ll. 646-662)。
- 待办列表接口 `GET /api/todos?since=` 支持增量返回；服务端会回传变更行、全部 id 与当天完成集合 (Family Hub Project, src/api.js, ll. 543-580)。

### 3.2 图文动态

- 一条动态可以包含文字、最多 9 张图片与最多 3 段视频；服务端对内容为空且没有媒体的提交返回 400 (Family Hub Project, src/api.js, ll. 941-963)。
- 本项目提供评论、点赞、家人共创「一起写」、标签筛选与关键词搜索；评论随动态一次取回 (Family Hub Project, src/api.js, ll. 864-924, 3426-3462)。
- 三条上传通道分别对应 `POST /api/upload`、`POST /api/upload-file`、`POST /api/upload-video`，请求体里的媒体以 base64 传入 (Family Hub Project, src/api.js, ll. 3731-3743; server.js, ll. 246-257)。

### 3.3 重点事项记录本

- 一条记录可以包含标题、正文、分类、勾选框、最多 9 张图片与最多 10 个附件；服务端把归档标记与置顶标记一起保存 (Family Hub Project, src/api.js, ll. 112-137, 1302-1326; src/schema.sql, l. 232)。
- 本项目提供访问密码、分类自定义、归档切换与关键词搜索；搜索范围包含标题、正文、分类与附件名 (Family Hub Project, src/api.js, ll. 1271-1300, 3226-3233)。
- 附件下载走 `GET /api/file/<文件名>?name=<原始文件名>`，服务端用 `Content-Disposition: attachment` 返回文件 (Family Hub Project, src/api.js, ll. 3751-3756)。

### 3.4 家庭记账

- `POST /api/bills/chat` 接收一句自然语言，例如「今天买菜 30 元」。`src/billparse.js` 用本地规则提取金额、日期、分类与备注，金额按「分」以整数入库；解析不出金额时服务端返回说明，不会猜一个数字 (Family Hub Project, src/billparse.js, ll. 1-24; src/bills.js, ll. 838-856)。
- 本项目只记录支出；被判定为收入方向的一句话不会入账，服务端会返回说明 (Family Hub Project, src/bills.js, ll. 859-867)。
- 本项目提供个人／家庭 × 日／月的统计、自定义日期范围、分类预算、记账日历、账单明细增删改查与 CSV 导出 (Family Hub Project, src/api.js, ll. 3507-3632, 3687-3728)。
- 截图识别是可选功能。管理员在「我的 → AI 参数设置」里填写接口地址、API Key 与模型 ID；服务端按 OpenAI 兼容的 `chat/completions` 协议调用，识别结果只回给前端，用户确认后才调用账单写入接口。密钥不会下发给浏览器 (Family Hub Project, src/ocr.js, ll. 1-52, 71-96; src/api.js, ll. 3634-3665)。
- 服务端为 AI 调用提供月度额度护栏，默认值是每月 1000 次；管理员可以在设置里调整 (Family Hub Project, src/ocr.js, ll. 59-62)。
- 定时报表由 `src/bills.js` 里的独立定时器驱动，默认每天 21:00 推送日报，月初可以附带月报 (Family Hub Project, src/bills.js, ll. 44-57, 1746)。

### 3.5 账号、通知与推送

- 第一个注册的账号自动成为管理员，并会把自助注册开关写为关闭。管理员可以在「我的 → 家庭设置 → 新成员自助注册」重新打开开关，让家人注册；`src/db.js` 在启动时用数据库里的 `allow_register` 覆盖环境变量值 (Family Hub Project, src/auth.js, ll. 200-228; src/db.js, ll. 640-649; public/app.js, ll. 10599-10602)。
- 登录使用用户名与密码；密码用 scrypt 加盐哈希；连续 5 次失败后，同一用户名与来源 IP 的组合锁定 10 分钟；会话默认 24 小时有效并滑动续期 (Family Hub Project, src/auth.js, ll. 36-58, 245-250; src/config.js, l. 92)。
- 推送通道有六个取值：`auto`、`wecom`、`mail`、`both`、`feishu`、`dingtalk`。`auto` 优先企业微信，发不出去时回退邮件；飞书群与钉钉群走群机器人 Webhook，多人选择同一通道时服务端只发一条 (Family Hub Project, src/push.js, ll. 12-50)。
- 「待办提醒」「内容通知」「记账」三类可以各自指定通道，偏好键是 `channel_todo`、`channel_notify`、`channel_bill`；键不存在时沿用该成员的全局通道 (Family Hub Project, src/userprefs.js, l. 52; src/push.js, ll. 67-98)。
- 企业微信自建应用提供 `/api/wecom/callback` 回调。服务端在会话中间件之前单独处理这条 XML 请求；管理员在网页里填写企业 ID、应用 AgentId、应用 Secret、接收消息 Token 与 EncodingAESKey (Family Hub Project, server.js, ll. 299-305, 476-481; 部署说明.md, ll. 675-685)。
- 飞书与钉钉的 Webhook 配置接口 `/api/hooks` 只对管理员开放；服务端分别按两种签名规则处理加签 (Family Hub Project, src/api.js, ll. 3324-3347; src/feishu.js, ll. 44-63; src/dingtalk.js)。
- 待办提醒、内容变更通知、催促与记账报表各有独立的每分钟定时器；服务端把投递结果写进 `push_logs` 表，管理员可以查询或清空 (Family Hub Project, server.js, ll. 627-662; src/api.js, ll. 3270-3278)。
- 前端每 12 秒轮询一次当前打开的版块；页面重新可见、窗口聚焦与网络恢复时也会触发同步 (Family Hub Project, public/app.js, ll. 6810-6823)。

### 3.6 运维与安全边界

- 服务端为静态资源与接口响应设置 `Content-Security-Policy`（`script-src 'self'`）、`X-Content-Type-Options: nosniff` 等响应头 (Family Hub Project, server.js, ll. 120-135)。
- 管理员可以导出 JSON 备份与从备份恢复；`GET /api/backup` 与 `POST /api/restore` 最终调用的 `backup.export`、`backup.restore` 都校验管理员身份 (Family Hub Project, src/api.js, ll. 1678-1686, 3758-3767)。
- 服务端支持 `BASE_PATH` 与 `SOCKET_PATH`，用于把应用挂在带路径前缀的网关后面；未配置时只监听 TCP 端口 (Family Hub Project, src/config.js, ll. 136-144; server.js, ll. 620-623, 683-702)。
- 历史版本说明与逐版改动记录保存在 `docs/README-history.md`；企业微信代理的部署说明保存在 `docs/wecom-proxy.md` 与 `docs/wecom-proxy-1panel.md` (Family Hub Project, docs/README-history.md; docs/wecom-proxy.md; docs/wecom-proxy-1panel.md)。

---

## 四、安装步骤与依赖要求

### 4.1 依赖要求

| 项目 | 要求 | 依据 |
| --- | --- | --- |
| Node.js | `>= 22.5.0`；该版本起内置 `node:sqlite` | (Family Hub Project, package.json, ll. 7-9) |
| 第三方运行时依赖 | 无；`dependencies` 为空对象 | (Family Hub Project, package.json, l. 15) |
| 低版本 Node 的回退 | `better-sqlite3 ^11.5.0`，需执行 `npm install` | (Family Hub Project, package.json, ll. 16-18; src/db.js, ll. 19-44) |
| 数据库 | 单个 SQLite 文件，由程序自动创建 | (Family Hub Project, src/db.js, ll. 60-61) |
| 浏览器 | 能通过 HTTP 打开同源页面；前端没有打包步骤 | (Family Hub Project, public/index.html, ll. 125-129) |
| Docker 方式 | Docker Engine ≥ 20.10 与 Docker Compose v2（部署手册给出的要求） | (Family Hub Project, 部署说明.md, ll. 20-31) |

`node -v` 可以确认当前 Node 版本。`docker compose version` 可以确认 Compose 版本。

### 4.2 方式 A：源码直接运行

```bash
git clone <仓库地址>          # 把 <仓库地址> 换成实际仓库 URL
cd family-hub
node -v                      # 需要 v22.5.0 或更高
node server.js               # 等价于 npm start
```

服务端启动后会打印访问地址、数据库路径、图片目录与登录有效期。首次启动会在项目下建出 `data/family.db` 与 `data/uploads/`。浏览器打开 `http://localhost:3455` 即可进入登录页 (Family Hub Project, server.js, ll. 668-681; src/config.js, ll. 88-91)。

首次使用按下面顺序操作：

1. 打开 `http://localhost:3455`，点「注册新账号」。第一个账号自动成为管理员。
2. 管理员登录后，进入「我的 → 家庭设置 → 新成员自助注册」，把开关改为「允许注册」。
3. 家人各自注册账号；全部注册完成后，管理员把开关改回「关闭注册」。

第 2 步不能省略：服务端在首位用户注册时会把 `settings.allow_register` 写成 `0`，而且启动时会用数据库里的值覆盖环境变量 `ALLOW_REGISTER` (Family Hub Project, src/auth.js, ll. 215-226; src/db.js, ll. 640-649)。

### 4.3 方式 B：Docker Compose

```bash
cd family-hub
mkdir -p data
# Linux 上若 data 目录属主不是 uid 1000，需要执行：
# sudo chown -R 1000:1000 data
cp .env.docker.example .env     # 可选；不创建 .env 也能用默认值
docker compose up -d --build
```

`docker-compose.yml` 把宿主机 `${PORT:-3455}` 映射到容器内固定的 `3455`，并把 `./data` 挂载到 `/data`。容器以 `node` 用户（uid 1000）运行，入口脚本会检查数据目录是否可写。健康检查打的是公开的 `/api/config` (Family Hub Project, docker-compose.yml, ll. 31-34, 74-89; Dockerfile, ll. 46-55; 部署说明.md, ll. 106-122)。

```bash
docker compose ps
docker compose logs -f --tail=100
curl -s http://localhost:3455/api/config
```

### 4.4 配置项

源码方式把环境变量写进项目根目录的 `.env`，模板是 `.env.example`；`src/config.js` 自己读取该文件，不需要 `dotenv`。Compose 方式用 `.env` 为 `docker-compose.yml` 提供变量，模板是 `.env.docker.example`；容器内的 `PORT`、`DB_PATH`、`UPLOAD_DIR` 由 compose 固定，使用者不要在 `.env` 里改这三项 (Family Hub Project, src/config.js, ll. 11-27; .env.example, ll. 1-16; docker-compose.yml, ll. 74-78)。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PORT` | `3455` | 源码方式的监听端口；Compose 方式表示宿主机端口 |
| `HOST` | `0.0.0.0` | 监听地址；只给本机访问时可设 `127.0.0.1` |
| `DB_PATH` | `data/family.db` | SQLite 文件路径 |
| `UPLOAD_DIR` | `data/uploads` | 图片、附件与视频目录 |
| `SESSION_TTL_HOURS` | `24` | 会话有效期（小时），滑动续期 |
| `MAX_SESSIONS_PER_USER` | `10` | 单账号保留的并发会话数 |
| `MAX_UPLOAD_MB` / `MAX_FILE_MB` / `MAX_VIDEO_MB` | `10` / `20` / `50` | 图片、附件、单段视频的体积上限（MB） |
| `ALLOW_REGISTER` | `1` | 自助注册的初始开关；数据库里的设置优先 |
| `TRUST_PROXY` | `1` | 是否依据 `X-Forwarded-Proto` 给 Cookie 加 `Secure` |
| `TZ_OFFSET_MINUTES` | `480` | 待办提醒使用的时区偏移（分钟） |
| `AI_API_KEY` / `AI_BASE_URL` / `AI_VL_MODEL` | 空 | 截图识别的兜底配置；网页里填的值优先 |
| `BASE_PATH` / `SOCKET_PATH` | 空 | 网关路径前缀与 Unix Socket 入口 |

服务端把站点名称、注册开关、免登录时长、上传上限、SMTP 与群机器人 Webhook 存在 `settings` 表里；管理员在网页里保存后，运行时配置立即更新，并在下次启动时从数据库读回相应字段 (Family Hub Project, src/db.js, ll. 640-660; src/api.js, ll. 1843-1852; src/feishu.js, ll. 44-63; .env.example, ll. 45-48)。

---

## 五、详细的使用方法（含基础示例）

### 5.1 界面流程

1. 管理员与家人分别登录。`我的` 页可以修改个人资料、收件邮箱、推送方式、主题与通知偏好。
2. 用户在 `待办` 页新建事项，填写日期、时间、参与人与重复规则；日历与列表会显示同一条数据。
3. 用户在 `动态` 页发帖，家人可以评论、点赞或用「一起写」补充内容。
4. 用户在 `记录本` 页新建记录，添加图片或附件；上锁后打开记录本需要先解锁。
5. 用户在 `记账` 页输入一句话，例如「今天买菜 30 元」；界面回显一条系统消息，账单同时写入明细。
6. 管理员在 `我的` 页配置家庭设置、发件邮箱、推送渠道、AI 参数与报表时间。

界面里的五类内容都通过 `/api/*` 接口读写；除公开接口外，服务端要求请求携带登录会话 (Family Hub Project, server.js, ll. 285, 484-491; public/index.html, ll. 108-119)。

### 5.2 HTTP 接口基础示例

下面的示例使用 `curl`，终端需要采用 UTF-8 编码。`BASE` 指向第五节启动的服务；`JAR` 保存登录会话 Cookie。示例中的日期与密码请按实际情况替换。公开接口是 `GET /api/config`、`POST /api/register`、`POST /api/login`；其余接口都需要会话 (Family Hub Project, server.js, l. 285)。

```bash
BASE=http://localhost:3455
JAR=./fh-cookies.txt

# 1. 查看版本、站点名称、注册开关与已有用户数（无需登录）
curl -s "$BASE/api/config"

# 2. 首次部署时注册第一个账号；服务端返回会话 Cookie，该账号是管理员
curl -s -c "$JAR" -X POST "$BASE/api/register" \
  -H 'Content-Type: application/json' \
  -d '{"username":"dad","display_name":"爸爸","password":"change-me-123"}'

# 3. 新建一条待办
curl -s -b "$JAR" -X POST "$BASE/api/todos" \
  -H 'Content-Type: application/json' \
  -d '{"title":"交水电费","date":"2026-11-06","startTime":"09:00"}'

# 4. 发布一条动态
curl -s -b "$JAR" -X POST "$BASE/api/posts" \
  -H 'Content-Type: application/json' \
  -d '{"content":"周末全家去公园","tags":["周末"]}'

# 5. 新建一条记录本内容
curl -s -b "$JAR" -X POST "$BASE/api/records" \
  -H 'Content-Type: application/json' \
  -d '{"title":"证件存放","content":"户口本放在书房第二个抽屉"}'

# 6. 用一句话记一笔账（解析在本地完成，不调用外部 AI）
curl -s -b "$JAR" -X POST "$BASE/api/bills/chat" \
  -H 'Content-Type: application/json' \
  -d '{"text":"今天买菜 30 元"}'

# 7. 查看账单明细、导出 CSV、导出整站备份（备份仅管理员可用）
curl -s -b "$JAR" "$BASE/api/bills"
curl -s -b "$JAR" -OJ "$BASE/api/bills/export.csv?scope=all"
curl -s -b "$JAR" -OJ "$BASE/api/backup"
```

请求与响应的对应关系如下。这些字段名来自 `src/api.js` 的路由实现，使用者启动服务后可以直接复现 (Family Hub Project, src/api.js, ll. 3401-3405, 3426-3432, 3464-3483, 3582-3597, 3688-3725, 3758-3763)。

| 请求 | 成功状态 | 响应要点 |
| --- | --- | --- |
| `GET /api/config` | 200 | 返回 `version`、`siteName`、`allowRegister`、`hasUsers`、`billOcrConfigured` 等字段 |
| `POST /api/register` | 201 | 返回 `{user: ...}` 并签发会话 Cookie |
| `POST /api/todos` | 201 | 返回 `{todo: ...}`；`title` 必填，`date` 与 `startTime` 可省略 |
| `POST /api/posts` | 201 | 返回 `{post: ...}`；正文、图片、视频三者不能全空 |
| `POST /api/records` | 201 | 返回 `{record: ...}`；`title` 必填 |
| `POST /api/bills/chat` | 201 | 返回 `{ok, bill, chat, ...}`；「今天买菜 30 元」会生成 `amountCents: 3000` 的一笔支出 |
| `GET /api/bills` | 200 | 返回 `{bills: [...]}` |
| `GET /api/bills/export.csv` | 200 | 返回 CSV 附件，表头包含日期、记账人、分类、备注、金额(元)、记账方式、来源 |
| `GET /api/backup` | 200 | 返回 JSON 附件，文件名形如 `family-hub-backup-<日期>.json` |

管理员可以用 `POST /api/settings` 修改系统设置。例如，下面的请求把自助注册重新打开；请求体只写要改的键，其他设置保持不变 (Family Hub Project, src/api.js, ll. 1843-1847)。

```bash
curl -s -b "$JAR" -X POST "$BASE/api/settings" \
  -H 'Content-Type: application/json' \
  -d '{"allowRegister":true}'
```

### 5.3 可选能力的配置入口

| 能力 | 配置位置 | 不配置时的行为 |
| --- | --- | --- |
| 邮件提醒与通知 | 管理员在网页的家庭设置里保存 SMTP 主机、端口、账号与授权码 | 邮件通道不可用；设置页会显示跳过原因 |
| 截图识别 | 管理员在「我的 → AI 参数设置」填写接口地址、API Key、模型 ID | 「传小票」入口不可用；一句话记账与其余功能照常 |
| 企业微信自建应用 | 管理员在企业微信接入设置里填五项参数，并把页面给出的回调地址填到企业微信后台 | 回调返回 503，其他功能不受影响 |
| 飞书群 / 钉钉群 | 管理员通过 `/api/hooks` 保存 Webhook 与可选加签密钥 | 该通道发不出去，失败原因写入推送日志 |
| 三类独立推送通道 | 成员在「待办提醒 / 内容通知 / 记账」各自的设置里选择通道 | 三类都沿用该成员的全局通道 |
| 网关路径前缀 | 设置 `BASE_PATH`，必要时设置 `SOCKET_PATH` | 只监听 TCP 端口 |

AI 配置的出厂默认值是 `https://api.openai.com/v1` 与 `gpt-4o-mini`；旧配置键 `qwen_api_key`、`qwen_vl_model` 与环境变量 `DASHSCOPE_API_KEY` 仍被读取，用于平滑迁移。密钥只在服务端使用 (Family Hub Project, src/ocr.js, ll. 65-96; .env.example, ll. 50-64; src/api.js, l. 2685)。

企业微信回调属于免登录的 XML 请求，服务端在会话中间件之前单独处理；未启用或配置不完整时返回 503 (Family Hub Project, server.js, ll. 299-318, 476-481)。

### 5.4 数据、备份与恢复

```bash
node scripts/init-db.js        # 打印各表行数，确认数据库可读
npm run backup                 # 冷备份，产物在 data/backups/
```

`npm run backup` 对应 `node scripts/backup.js`。脚本用 SQLite 的 `VACUUM INTO` 生成一致性副本，文件名形如 `family-hub-<时间>.db`，并只保留最近 30 份。脚本不需要停止服务；恢复时需要停止服务，再用备份文件覆盖 `DB_PATH` 指向的文件。图片在 `data/uploads/`，迁移时使用者需要一并拷贝 (Family Hub Project, scripts/backup.js, ll. 1-23, 37-55)。

管理员还可以在网页里导出 JSON 备份（含全部结构化数据与图片），并用「从备份恢复」还原；恢复会替换现有数据，且仅管理员可执行 (Family Hub Project, 部署说明.md, ll. 476-478; src/api.js, ll. 3758-3767)。

Docker Compose 把数据绑定挂载到宿主机 `./data`，`docker compose down` 不会删除这个目录 (Family Hub Project, docker-compose.yml, ll. 80-82; 部署说明.md, ll. 189-190)。

---

## 六、已知边界与维护状态

- 本项目采用单家庭模式。能注册进入同一部署的人属于同一个家庭；`visibility='family'` 的内容对所有成员可见，`private` 的内容只对创建者可见 (Family Hub Project, src/api.js, ll. 45-46; docs/README-history.md, ll. 1422-1443, 1643)。
- 前端用 12 秒轮询同步，服务端没有 WebSocket 推送。页面重新可见、窗口聚焦与网络恢复时也会触发同步 (Family Hub Project, public/app.js, ll. 6810-6823)。
- 登录入口是 `POST /api/login`，请求体包含用户名与密码；管理员可以重置成员密码 (Family Hub Project, src/api.js, ll. 3186-3195, 3390-3392; 部署说明.md, l. 1175)。
- 记账模块目前只记支出；被判定为收入的自然语言不会入账 (Family Hub Project, src/bills.js, ll. 859-867)。
- 截图识别依赖部署者自己配置的 OpenAI 兼容服务；未配置时该功能不可用，一句话记账不依赖任何外部服务 (Family Hub Project, src/ocr.js, ll. 1-52; src/bills.js, ll. 918-925)。
- 飞书群与钉钉群是群 Webhook，没有个人绑定；多人选择同一通道时服务端只发一条消息 (Family Hub Project, src/push.js, ll. 18-21)。
- 服务端以单个 SQLite 文件为唯一数据源，仓库提供的部署形态是单实例 (Family Hub Project, src/db.js, ll. 1-9, 60-68)。
- 媒体以 base64 放进 JSON 请求体，服务端按上传上限动态计算请求体上限；反向代理需要相应放宽请求体限制 (Family Hub Project, server.js, ll. 246-257; 部署说明.md, ll. 382-385)。
- 项目在既有文档里登记了两条技术债，当前版本只记录、未处理：W-7 指 `public/app.js`、`src/api.js` 与 `public/styles.css` 三个大文件尚未拆分；W-8 指 `src/db.js` 里 `todos` 表的两段 DROP+RENAME 重建逻辑尚未合并去重。两条记录的理由都是拆分或改写带来的回归风险高于当前收益 (Family Hub Project, docs/README-history.md, ll. 80-89)。

---

## 七、依据与可复现性

本文的事实部分来自下列仓库文件；命令部分来自仓库里的脚本、Compose 定义与部署手册。本文没有写入推测、性能数据或第三方效果评价。源码启动命令、`/api/*` 请求示例、`scripts/init-db.js` 与 `npm run backup` 都可以在部署者自己的机器上复现；Docker Compose 命令以仓库内的 `docker-compose.yml` 与 `Dockerfile` 为依据，使用者需要在装有 Docker 的机器上执行。

### 引用文献（MLA 格式）

Family Hub Project. .env.docker.example. family-hub, 2026.

Family Hub Project. .env.example. family-hub, 2026.

Family Hub Project. docker-compose.yml. family-hub, 2026.

Family Hub Project. Dockerfile. family-hub, 2026.

Family Hub Project. docs/README-history.md. family-hub, 2026.

Family Hub Project. docs/wecom-proxy-1panel.md. family-hub, 2026.

Family Hub Project. docs/wecom-proxy.md. family-hub, 2026.

Family Hub Project. package.json. family-hub, version 4.25.0, 2026.

Family Hub Project. public/app.js. family-hub, 2026.

Family Hub Project. public/index.html. family-hub, 2026.

Family Hub Project. public/lunar.js. family-hub, 2026.

Family Hub Project. public/manifest.webmanifest. family-hub, 2026.

Family Hub Project. public/repeat.js. family-hub, 2026.

Family Hub Project. public/styles.css. family-hub, 2026.

Family Hub Project. scripts/backup.js. family-hub, 2026.

Family Hub Project. scripts/init-db.js. family-hub, 2026.

Family Hub Project. server.js. family-hub, 2026.

Family Hub Project. src/api.js. family-hub, 2026.

Family Hub Project. src/auth.js. family-hub, 2026.

Family Hub Project. src/billparse.js. family-hub, 2026.

Family Hub Project. src/bills.js. family-hub, 2026.

Family Hub Project. src/config.js. family-hub, 2026.

Family Hub Project. src/db.js. family-hub, 2026.

Family Hub Project. src/dingtalk.js. family-hub, 2026.

Family Hub Project. src/feishu.js. family-hub, 2026.

Family Hub Project. src/ocr.js. family-hub, 2026.

Family Hub Project. src/push.js. family-hub, 2026.

Family Hub Project. src/reminders.js. family-hub, 2026.

Family Hub Project. src/schema.sql. family-hub, 2026.

Family Hub Project. src/userprefs.js. family-hub, 2026.

Family Hub Project. 部署说明.md. family-hub, 2026.

---

## 附录：许可证

本项目采用 GNU Affero General Public License, Version 3（SPDX：`AGPL-3.0-only`）。许可证全文见仓库根目录的 `LICENSE`；`package.json` 的 `license` 字段与 `Dockerfile` 的 `org.opencontainers.image.licenses` 标签都与之保持一致。

AGPL-3.0 第 13 条规定：如果你修改本软件并通过网络向用户提供服务，必须向这些用户提供你所运行版本的完整对应源代码。这一条对改造后的自托管服务同样适用。

项目没有第三方运行时依赖。`optionalDependencies` 中的 `better-sqlite3` 只用于低于 Node 22.5 的版本回退，其许可证以该包自身发行内容为准。
