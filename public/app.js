/* ═══════════════════════════════════════════════════════════
   我们一家 · 前端逻辑
   纯原生 JS，无构建、无框架。
   数据以服务端为唯一来源：写入走「乐观更新 → 请求 → 回读校验」，
   读取走「12 秒轮询 + 切回页面立即刷新」。
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── DOM 小工具 ───────────────────────────────────────── */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  /* ── 接口与资源的基址（v4.20.0，审查 S-1b）────────────────────────
     飞牛统一网关把应用挂在 /app/<appname> 下时，页面地址是
     https://域名:5666/app/familyhub/，而页面里所有 `/api/...` 都是**绝对路径**，
     浏览器会把它们打到网关根目录 —— 压根到不了应用，表现为「页面能开、数据全空」。
     server.js 配了 BASE_PATH 时会注入 `<meta name="fh-base" content="/app/familyhub">`。

     ★ 为什么是 meta 而不是内联 <script>：本服务的 CSP 是 `script-src 'self'`，
       内联脚本会被浏览器**静默拒绝执行**（index.html 里就写着这条规则）。
       v4.20.0 之前注入的正是内联脚本，所以这个变量其实一直是 undefined。
     ★ 读 meta 必须发生在 DOM 解析到 head 之后 —— app.js 是放在 </body> 前的
       外链脚本，执行时 head 一定已就绪，`document.querySelector` 能拿到。
     ★ 基址为空串时（端口模式，绝大多数部署）以下全是空操作，行为一字不变。 */
  const API_BASE = (() => {
    try {
      const m = document.querySelector('meta[name="fh-base"]');
      return m ? String(m.getAttribute('content') || '').replace(/\/+$/, '') : '';
    } catch { return ''; }
  })();

  /**
   * 站内资源地址（图片 / 视频封面 / 附件）→ 带前缀的可用地址。
   * 只处理以 `/` 开头的站内绝对路径：data: / blob: / 外链一律原样返回。
   * 库里存的永远是不带前缀的 `/api/media/xxx` —— 前缀只在**写进 DOM 那一刻**加，
   * 绝不回写数据库（否则编辑一次记录就会把前缀存进去，换部署方式后全失效）。
   */
  const assetUrl = (p) => {
    const s = String(p == null ? '' : p);
    return API_BASE && s.charAt(0) === '/' ? API_BASE + s : s;
  };

  /* 站点名称：v1.8.0 起由管理员在「家庭设置」里自定义，值来自服务端（/api/config 与
     /api/settings 都会下发）。这里保留一份出厂默认值，用于「恢复默认」以及
     连上老服务端 / 接口失败时兜底 —— 名称再怎么样也不能变成空白标题。 */
  const DEFAULT_APP_NAME = '我们一家';
  let APP_NAME = DEFAULT_APP_NAME;

  /* ── 界面主题（v4.11.0）─────────────────────────────────────────────
     三套色板定义在 styles.css 的 :root[data-theme=...] 里，前端只负责：
       ① 把 <html data-theme> 换成用户选的那套（CSS 变量随之整页生效）
       ② 把选择存到服务端（跟着人走，换手机/换浏览器也一样）
       ③ 本地留一份缓存，让首屏在接口回来之前就是对的（避免闪一下默认色）

     ★ 为什么「本地缓存 + 服务端」两份而不是只留服务端：
       只留服务端 → 每次打开都先按默认色画一帧，再跳成用户主题（肉眼可见的闪）。
       只留本地   → 换设备就丢了，与「跟着人走」的要求冲突。
       两份并存时**以服务端为准**：/api/me 回来后无条件按它校正一次。 */
  const THEMES = ['forest', 'paper', 'ocean'];
  const DEFAULT_THEME = 'paper';
  const THEME_KEY = 'fh_theme';
  const THEME_META = {
    forest: { name: '青野', desc: '清新竹绿', paper: '#f4f8f5' },
    paper: { name: '米白', desc: '温柔奶油', paper: '#faf7f2' },
    ocean: { name: '澄蓝', desc: '澄澈海蓝', paper: '#f5f8fd' },
  };

  /** 脏值一律回落到默认主题：宁可显示默认色，也不要整页没有变量可用 */
  function normalizeTheme(v) {
    const t = String(v == null ? '' : v).trim().toLowerCase();
    return THEMES.includes(t) ? t : DEFAULT_THEME;
  }

  /**
   * 应用主题（纯本地，不发请求）。
   * @param {string} name 主题名
   * @param {boolean} [cache] 是否写入 localStorage（服务端校正时也要写，保持一致）
   */
  function applyTheme(name, cache) {
    const t = normalizeTheme(name);
    document.documentElement.setAttribute('data-theme', t);
    state.theme = t;
    // 手机浏览器的地址栏颜色跟着主题走，否则「奶油色页面 + 白地址栏」会割裂
    const meta = document.querySelector('#theme-color');
    if (meta) meta.setAttribute('content', THEME_META[t].paper);
    if (cache !== false) {
      try { localStorage.setItem(THEME_KEY, t); } catch { /* 隐私模式忽略 */ }
    }
    return t;
  }

  /** 点主题卡片：先换色（立刻有反馈），再存服务端；失败回滚并提示 */
  async function pickTheme(name) {
    const next = normalizeTheme(name);
    const prev = normalizeTheme(state.theme);
    if (next === prev) return;
    applyTheme(next);
    render();
    try {
      const out = await api('/api/me/theme', { method: 'POST', body: { theme: next } });
      if (out && out.user) state.me = Object.assign({}, state.me, out.user);
      render();
    } catch (err) {
      /* 回滚：界面上是 A、库里是 B 是最难解释的状态，宁可退回原来的 */
      applyTheme(prev);
      render();
      toast((err && err.message) || '主题保存失败，已恢复原来的主题', 'err');
    }
  }

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

  const pad = (n) => String(n).padStart(2, '0');
  const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayKey = () => dateKey(new Date());

  /**
   * 相对时间文案。
   *
   * ★ v4.5.0 需求 3：判断「昨天」必须按**日历日**，不能按小时差。
   *   旧实现是 `diff < 172800e3 → 昨天`，看起来等价，实际差得远：
   *   前天 20:00 到今天 08:00 只隔 36 小时，会被说成「昨天」。
   *   于是「前天发的帖、昨天有人一起写」这个场景下，用户刷新后看到帖子
   *   写着「昨天」，就以为是共创把发布时间改掉了 —— 数据一直是好的，
   *   错的是这句文案。现在前天就是「前天」，昨天的共创也改不动它。
   */
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const dayStart = (t) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
    const dayGap = Math.round((dayStart(now) - dayStart(d)) / 86400000);

    if (dayGap <= 0) {
      if (diff < 60e3) return '刚刚';
      if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
      return `${Math.floor(diff / 3600e3)} 小时前`;
    }
    if (dayGap === 1) return `昨天 ${hm}`;
    if (dayGap === 2) return `前天 ${hm}`;
    if (d.getFullYear() === now.getFullYear()) {
      return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
    }
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function humanDate(key) {
    const [y, m, d] = key.split('-').map(Number);
    const t = new Date();
    const tKey = todayKey();
    const yKey = dateKey(new Date(t.getTime() - 86400e3));
    if (key === tKey) return '今天';
    if (key === yKey) return '昨天';
    return `${y}年${m}月${d}日`;
  }

  const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

  function avatarColor(name) {
    let h = 0;
    const s = String(name || '?');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return `hsl(${h}, 46%, 52%)`;
  }

  /* 昵称 → 自定义头像路径。动态 / 评论里只带作者昵称，所以要靠这张表把头像找回来。
     每次成员或本人数据更新后由 refreshAvatarMap() 重建。 */
  let avatarMap = new Map();
  function refreshAvatarMap() {
    const m = new Map();
    const put = (u) => { if (u && u.display_name && u.avatar) m.set(u.display_name, u.avatar); };
    (state.members || []).forEach(put);
    put(state.me);
    avatarMap = m;
  }
  const avatarPathOf = (name) => avatarMap.get(String(name || '')) || '';

  /**
   * 头像：有自定义图片就显示图片，否则回退到「昵称首字 + 按名字生成的底色」。
   * 图片加载失败（文件被删等）时由全局 error 监听把它退回首字色块（见 bindAvatarFallback）。
   */
  const avatarHtml = (name, cls) => {
    const path = avatarPathOf(name);
    const initial = esc(String(name || '?').slice(0, 1));
    if (path) {
      return `<div class="avatar img ${cls || ''}" data-initial="${initial}" data-name="${esc(String(name || ''))}" ` +
        `style="background:${avatarColor(name)}"><img src="${esc(assetUrl(path))}" alt="" referrerpolicy="no-referrer"></div>`;
    }
    return `<div class="avatar ${cls || ''}" style="background:${avatarColor(name)}">${initial}</div>`;
  };

  /** 头像图片加载失败 → 就地把该节点还原成首字色块 */
  function bindAvatarFallback() {
    document.addEventListener('error', (e) => {
      const img = e.target;
      if (!img || img.tagName !== 'IMG') return;
      const box = img.closest ? img.closest('.avatar.img') : null;
      if (!box) return;
      box.classList.remove('img');
      box.textContent = box.getAttribute('data-initial') || '?';
    }, true);
  }

  /* ── Toast ────────────────────────────────────────────── */

  function toast(message, kind) {
    const root = $('#toast-root');
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = message;
    root.appendChild(el);
    setTimeout(() => el.remove(), kind === 'err' ? 3600 : 2000);
  }

  /* ── API ──────────────────────────────────────────────── */

  /** 记录本解锁凭证：存在 sessionStorage，关闭页面即失效（服务端逐一校验） */
  function recordsKey() {
    try { return sessionStorage.getItem('fh-records-key') || ''; } catch { return ''; }
  }

  async function api(path, options) {
    const opts = options || {};
    const headers = opts.body !== undefined ? { 'Content-Type': 'application/json' } : {};
    const rk = recordsKey();
    if (rk) headers['x-records-key'] = rk;
    /* ★ API_BASE：网关模式下接口必须带前缀（v4.20.0，审查 S-1b）。
       所有请求都从这一个出口发出去 —— 新增接口不必再关心部署形态。 */
    const res = await fetch(API_BASE + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    if (!res.ok) {
      const err = new Error((data && data.error) || `请求失败（${res.status}）`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /* ── 带进度的上传（v2.0.0，需求 6） ──────────────────────
     ★ 为什么单独开一条通道：`fetch` 至今没有暴露「上传进度」的标准做法
       （ReadableStream 的 duplex 只在部分浏览器可用，且拿不到已发送字节数）。
       `XMLHttpRequest.upload.onprogress` 是唯一稳定可靠的路子。
       其余请求继续走上面的 fetch —— 不为了一件小事把整套网络层换掉。 */
  function xhrUpload(path, body, onProgress) {
    return new Promise((resolve, reject) => {
      let xhr = null;
      try { xhr = new XMLHttpRequest(); } catch { reject(new Error('当前浏览器不支持上传进度')); return; }
      xhr.open('POST', API_BASE + path, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      const rk = recordsKey();
      if (rk) xhr.setRequestHeader('x-records-key', rk);
      xhr.upload.onprogress = (ev) => {
        if (onProgress && ev.lengthComputable && ev.total) onProgress(ev.loaded / ev.total);
      };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText || 'null'); } catch { data = null; }
        if (xhr.status >= 200 && xhr.status < 300) { resolve(data); return; }
        const err = new Error((data && data.error) || `上传失败（${xhr.status}）`);
        err.status = xhr.status;
        err.data = data;
        reject(err);
      };
      xhr.onerror = () => reject(new Error('网络中断，上传失败'));
      xhr.ontimeout = () => reject(new Error('上传超时'));
      xhr.onabort = () => reject(new Error('上传已取消'));
      xhr.send(JSON.stringify(body));
    });
  }

  /**
   * 上传进度面板（浮在屏幕下方的一条）。返回控制器 —— 用完**必须** done()/fail()，
   * 否则那一条会一直挂在屏幕上，看起来像卡死了。
   */
  /**
   * 带进度条的操作浮层。
   * v4.3.1 需求 4：`opts.tick` 打开后标签会实时跟一个「· 已用 Ns」——
   *   截图识别是长耗时操作（模型侧 5~15s 很正常），进度条不动又没秒数，
   *   用户最容易当成「卡死了」而反复点。同一次请求耗时不变，但等待是「可见」的。
   */
  function progressPanel(label, opts) {
    const root = $('#toast-root');
    const el = document.createElement('div');
    el.className = 'uprog';
    el.innerHTML = `<div class="uprog-top"><span class="uprog-label">${esc(label)}</span>` +
      `<span class="uprog-pct">0%</span></div><div class="uprog-bar"><i></i></div>`;
    root.appendChild(el);
    const pctEl = el.querySelector('.uprog-pct');
    const labelEl = el.querySelector('.uprog-label');
    const barEl = el.querySelector('.uprog-bar > i');
    let shown = 0;
    let closed = false;
    let base = label;
    let secs = 0;
    const paint = () => { labelEl.textContent = (opts && opts.tick && secs) ? `${base} · 已用 ${secs}s` : base; };
    let timer = opts && opts.tick ? setInterval(() => { secs++; paint(); }, 1000) : null;
    const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };
    const close = (kind, text, delay) => {
      if (closed) return;
      closed = true;
      stopTimer();                       // ★ 不停表的话，节点已移除还在被改（而且计时器会泄漏）
      el.classList.add(kind);
      if (text) labelEl.textContent = text;
      setTimeout(() => el.remove(), delay);
    };
    return {
      label(text) { base = text; paint(); },
      set(p) {
        if (closed) return;
        const v = Math.max(0, Math.min(1, Number(p) || 0));
        if (v < shown) return;                     // 进度只许前进，别因为换了个文件往回跳
        shown = v;
        pctEl.textContent = `${Math.round(v * 100)}%`;
        barEl.style.width = `${(v * 100).toFixed(1)}%`;
      },
      done(text) { this.set(1); close('done', text, 1400); },
      fail(text) { close('fail', text, 3200); },
    };
  }

  /* ── 应用状态 ─────────────────────────────────────────── */

  const PAGE_SIZES = [5, 10, 20, 50];
  function loadPageSize() {
    try {
      const n = Number(localStorage.getItem('fh-todo-page-size'));
      return PAGE_SIZES.includes(n) ? n : 5;
    } catch { return 5; }
  }

  const state = {
    config: {
      // 站点名称（siteName）也在这里 —— v1.8.0 起由服务端下发，applyConfig 会合并进来。
      allowRegister: true, hasUsers: false, version: '',
      maxUploadMb: 10, maxFileMb: 20,
      // v1.9.0：视频上限与「一条动态最多几段视频」，都由服务端下发（单一来源）
      maxVideoMb: 50, postVideoMax: 3,
    },
    me: null,
    /* v4.11.0：当前界面主题（forest / paper / ocean），来自用户偏好 */
    theme: DEFAULT_THEME,
    members: [],
    /* v4.5.0 需求 5：企业微信配置状态（只有管理员会去拉；null = 未加载/无权） */
    wecom: null,
    todos: [],
    posts: [],
    records: [],
    tab: 'calendar',
    cursor: { y: new Date().getFullYear(), m: new Date().getMonth() },
    selected: todayKey(),
    todoFilter: 'pending',          // 默认只看未完成，打开就是「还要做什么」
    todoQuery: '',
    todoPageSize: loadPageSize(),   // 每页显示条数（可设置，默认 5）
    todoShown: loadPageSize(),      // 当前已展开的条数（点「加载更多」递增）
    /* v4.20.0（审查 W-9）：服务端总数与「是否被截断」。
       列表 API 一次最多回 2000 条，超了就是静默丢 —— 这两个字段让界面能明说。 */
    todoTotal: 0,
    todoTruncated: false,
    // 「周期提醒」（v2.0.0 由「周期提醒」改名并扩到每月/每周）卡片是否展开（默认收起）
    repeatOpen: false,
    recQuery: '',
    recCategory: '全部',
    recShowArchived: false,         // 记录本：是否切到「已归档」列表（v1.9.0）
    recHidden: [],                  // 已删除（隐藏）的分类（v1.6.0，随 /api/records 下发）
    postQuery: '',                  // 动态搜索关键词（v1.5.0）
    postTag: '',
    // v1.9.0：动态页双视图 —— feed（动态流，默认）/ calendar（按日历看，带当天条数）
    postView: 'feed',
    postCalCursor: { y: new Date().getFullYear(), m: new Date().getMonth() },
    postCalDay: '',                 // 动态日历里选中的那一天（空 = 用今天）
    /* v4.23.0 需求 3：帖子右下角「⋯」菜单的展开状态（存的是帖子 id，0 = 都收起）。
       为什么不用 DOM 上的 toggle：整页重绘（轮询同步）会把菜单冲掉，
       状态放 state 里才能「重绘后仍然开着」。 */
    postMenu: 0,
    /* 每条帖子哪些块被手动展开了：{ [postId]: { comments: true } }。
       点赞行不需要记 —— 它只看「我赞过没有 / 有没有人赞」。 */
    postOpen: {},
    /* v2.0.0 需求 4：发帖 / 视图切换 / 搜索 合并成一块工具条，「发帖」默认收起。
       ★ 草稿必须落在 state 里：收起后 textarea 不在 DOM 上，
         只靠 data-preserve 会直接丢掉用户敲了一半的字。 */
    composeOpen: false,
    compose: { images: [], videos: [], visibility: 'family', visibleTo: [], text: '', tags: '' },
    /* v4.3.3 需求 6：草稿恢复提示（'' = 不显示；'post' = 动态草稿已恢复）。
       记录本的恢复提示画在弹窗里，不需要 state。
       必须进 DATA_SIG.moments —— 它是界面状态，不进指纹那次 render 会被早退掉。 */
    draftNotice: '',
    /* v4.13.0（问题 4）：草稿自动保存的进度（pending=true 正在存 / at=上次落盘时间）。
       只用于「存草稿」按钮旁那行小字，不参与 DATA_SIG（用 paintDraftHint 局部更新，
       整页重绘会打断正在输入的输入法）。 */
    draftState: { pending: false, at: '' },
    /* v4.13.0（问题 4）：发帖表情面板是否展开。它是界面状态 → 必须进 DATA_SIG.moments */
    composeEmoji: false,
    // v1.9.0：版块红点。latest = 各版块「别人」的最新更新时间，seen = 我上次查看的时间
    seen: { latest: {}, seen: {} },
    // 月份切换的入场动画方向（'left' / 'right'），由滑动手势设置、render() 消费一次后清空
    calAnim: '',
    /* v2.0.0：渲染指纹。「屏幕上这份内容」对应哪份数据 —— 一模一样就不再动 DOM，
       这是「同步不打断输入与视频播放」的第一道闸门。 */
    sig: { calendar: '\u0000', moments: '\u0000', records: '\u0000', me: '\u0000', bills: '\u0000' },
    prevTab: '',
    // v2.0.0：个人通知偏好（非管理员也能设）。global 是管理员那边的现状，用来显示「已被全局关掉」。
    prefs: null,
    prefsGlobal: null,
    /* v4.12.0：「我的」页分区的展开状态。除「外观主题」外默认收起
       （需求原文），收起时标题条上给一句摘要，不算藏信息。
       v4.15.0 需求 2：分区扩到 9 个，新增 ai（AI 参数）/ cat（分类与预算）——
       它们原来在「记账设置」页签里。 */
    meOpen: { profile: false, members: false, notify: false, push: false, ai: false, cat: false, backup: false, system: false },
    /* v4.16.0 需求 4：推送渠道设置里「邮件 / 企业微信」两块配置的折叠状态。
       默认展开（undefined 当作 true），点了标题才收起。 */
    pushOpen: { mail: true, wecom: true },
    // v2.0.0 家庭记账
    bills: [],
    billChat: [],
    billStats: null,
    billMeta: null,                 // { categories, budgets, quota, ocrConfigured }
    billScope: 'all',               // all | mine
    billKind: '',                   // '' | income | expense
    billCategory: '全部',
    billQuery: '',
    billFrom: '',                   // CSV 导出用：起始日期（空 = 不限）
    billTo: '',
    billExportScope: 'all',
    billMonth: '',                  // 统计卡里看的月份（空 = 今天所在月）
    billDate: '',                   // 统计卡里看的日期（空 = 今天）
    billStatFrom: '',               // v4.0.0 统计：日期范围筛选起点（空 = 不启用）
    billStatTo: '',                 // v4.0.0 统计：日期范围筛选终点
    billQuick: [],                  // v4.0.0 我的快捷短语（需求 2，按人存服务端）
    billAiLogs: null,               // v4.0.0 管理端拉回来的 AI 调用日志（null = 没拉过）
    billView: 'chat',               // chat | list | stats | settings
    /* v4.12.0 需求 3：日历并入「统计」，统计下再分「筛选查看 / 日历查看」两个子视图。
       与待办页的「待办列表 / 日历」同一种交互（seg-mini 分段，零重绘）。 */
    billStatsView: 'calendar',      // filter | calendar（v4.15.0 需求 5：默认日历查看）
    /* v4.22.0 需求 3：明细 / 统计的「已加载」标记。
       切标签时若数据已在内存里，直接渲染、不再发请求 —— 这是「切换顺畅」的关键；
       数据被写操作刷新过时，对应标记由 refresh* 重新置位。 */
    billListLoaded: false,
    billStatsLoaded: false,
    billCalLoaded: '',
    /* v4.12.0 需求 2：分类与预算只显示「已设预算」的分类，
       其余统一收在一个下拉框里，选了再加预算行。 */
    billBudgetPick: '',
    billSending: false,
    // v4.3.1 需求 4：识别截图进行中（挡住重复提交：连点会各发一次请求 = 双倍耗时与费用）
    billOcrBusy: false,
    // v4.3.1 需求 6：记账设置里的「识别参数」是否展开（默认收拢，交互同「周期提醒」）
    billAiParamsOpen: false,
    billOcrDraft: null,             // OCR 确认 / 编辑账单的弹窗草稿（null = 没在编辑）
    billOcrItems: null,             // v2.0.2 OCR 多条确认弹窗的草稿（null = 没在编辑）
    billDrafts: [],                 // v4.1.0 识别草稿箱（localStorage 持久，空闲时再修改入账）
    /* v4.3.2 需求 1：疑似重复入账的提示（只放内存，刷新即消失 —— 它讲的是「刚才那一下」，
       不是需要长期保留的状态）。每项 = {bill, similar}：
         bill    = 刚记上的那笔（提供「撤销这一笔」的 id）
         similar = 服务端认为高度相似的那条旧账（提供「和哪天哪笔像」的说明） */
    billDupTips: [],
    /* v4.9.0 需求 3：日历页签的「待办列表 / 日历」双视图（交互同动态模块的 动态流/按日历看）。
       两种视图的卡片**都保留在 DOM 里**，靠容器类 + CSS 控制显隐 —— 切换零重绘、
       输入态与滚动位置天然保留（本项目最小重绘架构下最稳的做法）。 */
    todoView: 'list',               // list | calendar
    /* v4.9.0 需求 1：微信记账草稿箱（服务端）。微信端「存草稿」落库，网页端改好再提交。 */
    billServerDrafts: [],
    /* v4.9.0 需求 2：记账日历视图。光标懒初始化（第一次进日历视图才取当月）。 */
    billCalCursor: null,            // {y, m}
    billCalData: null,              // { month, days:[{date,expenseCents,count}], monthExpenseCents, monthCount }
    billCalDay: '',                 // 日历里点开的那天（空 = 没展开当日面板）
    billCalDayBills: null,          // 那天的账单明细（点开才拉）
    settings: null,                 // 管理员可改的系统设置（家庭名/注册开关/免登录时长）
    sync: 'idle',       // idle | busy | offline
    lastSyncAt: 0,
    booted: false,
  };

  /** 页签 → 内容容器 */
  const VIEW_OF = {
    calendar: 'view-calendar', moments: 'view-moments', records: 'view-records',
    me: 'view-me', bills: 'view-bills',
  };

  const REC_CATEGORIES = ['通用', '证件', '账号', '医疗', '财务', '物品', '其他'];

  /** 记录本分类：分类可自定义，所以除了预设还要把已用过的分类带出来；已删除的要扣掉 */
  function recordCategories() {
    const hidden = new Set(state.recHidden || []);
    const set = new Set(REC_CATEGORIES);
    state.records.forEach((r) => { if (r.category) set.add(r.category); });
    return Array.from(set).filter((c) => !hidden.has(c));
  }

  /* ── 展示小工具（时间 / 体积 / 附件） ─────────────────── */

  /** 距今天还有多少天（按本地日历日算，和墙上时间一致） */
  function daysFromToday(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
    if (!m) return null;
    const target = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const n = new Date();
    const base = Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
    return Math.round((target - base) / 86400e3);
  }

  /**
   * 「下次提醒」文案：重复事项要展示的是下一次什么时候提醒，
   * 而不是当初建这条时填的那一天（那可能是好几年前）。
   *
   * v4.3.3 需求 4：**必须完整显示年月日**。
   * 旧版只显示「3月8日」，跨年的周期提醒（每年一次）看起来像下个月就要到，
   * 用户没法判断到底是今年还是明年 —— 这类误读在实际使用里很常见。
   * 「今天/明天/后天」这类友好说法保留，但降级成括号里的补充说明，
   * 主体永远是「2027年3月8日」这种无歧义写法。
   */
  function nextRemindText(key, time) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key || ''))) return '';
    const d = daysFromToday(key);
    const full = `${key.slice(0, 4)}年${Number(key.slice(5, 7))}月${Number(key.slice(8, 10))}日`;
    let when = full;
    if (d === 0) when = `${full}（今天）`;
    else if (d === 1) when = `${full}（明天）`;
    else if (d === 2) when = `${full}（后天）`;
    else if (d !== null && d > 0 && d <= 60) when = `${full}（${d} 天后）`;
    else if (d !== null && d < 0) when = `${full}（已到期）`;
    return `${when}${time ? ' ' + time : ''}`;
  }

  function fmtBytes(n) {
    const b = Math.max(0, Number(n) || 0);
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
  }

  /** 按扩展名给个图标，让附件列表一眼能扫出类型 */
  const FILE_ICONS = {
    pdf: '📕', doc: '📘', docx: '📘', rtf: '📘', odt: '📘',
    xls: '📗', xlsx: '📗', csv: '📗', tsv: '📗', ods: '📗',
    ppt: '📙', pptx: '📙', odp: '📙',
    zip: '🗜️', rar: '🗜️', '7z': '🗜️', tar: '🗜️', gz: '🗜️', bz2: '🗜️', xz: '🗜️',
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', webp: '🖼️', bmp: '🖼️', heic: '🖼️', tif: '🖼️',
    mp3: '🎵', wav: '🎵', m4a: '🎵', amr: '🎵', aac: '🎵', ogg: '🎵', flac: '🎵',
    mp4: '🎬', mov: '🎬', m4v: '🎬', webm: '🎬', avi: '🎬', mkv: '🎬', '3gp': '🎬',
    txt: '📄', md: '📄', json: '📄', xml: '📄', log: '📄', yaml: '📄', yml: '📄',
    ics: '📅', vcf: '👤', epub: '📖',
  };
  const fileIcon = (name) => {
    const ext = String(name || '').split('.').pop().toLowerCase();
    return FILE_ICONS[ext] || '📎';
  };
  const attachUrl = (a) => `${a.path}?name=${encodeURIComponent(a.name || '附件')}`;

  /** 附件列表（只读展示 / 可点下载） */
  function attachListHtml(items, cls) {
    const list = Array.isArray(items) ? items.filter((a) => a && a.path) : [];
    if (!list.length) return '';
    return `<div class="attach-list ${cls || ''}">` + list.map((a) =>
      `<a class="attach" href="${esc(attachUrl(a))}" data-act="attach-download" data-url="${esc(attachUrl(a))}"
          title="下载 ${esc(a.name)}">${
        a.cover
          ? `<img class="att-thumb" src="${esc(a.cover)}" alt="" loading="lazy">`
          : `<span class="att-ico">${fileIcon(a.name)}</span>`}` +
      `<span class="att-name">${esc(a.name)}</span><span class="att-size">${esc(fmtBytes(a.size))}</span></a>`).join('') +
      '</div>';
  }

  /**
   * 全站统一的搜索条（v1.7.0）。
   * 待办 / 记录本以前直接用裸 `<input type="search">`，跟动态页那条圆角搜索条长得完全不一样；
   * 现在三处共用同一套 `.search-bar` 结构：放大镜 + 无边框输入 + 「有词才出现」的清除按钮。
   * ⚠️ `preserve` 必须沿用原来的 data-preserve 键（todo-q / rec-q / post-q）——
   *    输入态保护是按这个键找回焦点与光标的。
   */
  function searchBarHtml(o) {
    const v = String(o.value == null ? '' : o.value);
    const on = !!v.trim();
    /* ★ 「清除」按钮**总是渲染出来**，靠 `hidden` 控制显隐。
       早先是「有词才渲染、没词就不渲染」，看着更省 DOM，但它和
       「最小重绘会跳过握着焦点的子树」撞在一起就会自相矛盾：
       输入框里有词时按钮该在，可重绘被跳过了 → 按钮不出现；
       点了清除、词没了按钮该消失，重绘同样被跳过 → 按钮赖着不走。
       常驻 + 就地切 hidden 之后，显隐只由 syncSearchBar() 一处决定。 */
    return `<div class="search-bar${o.grow === false ? '' : ' grow'}${on ? ' filled' : ''}">
        <span class="sb-ico" aria-hidden="true">🔍</span>
        <input class="sb-input" type="search" placeholder="${esc(o.placeholder)}"
               data-preserve="${esc(o.preserve)}" value="${esc(v)}" data-act="${esc(o.act)}"${o.id ? ` id="${esc(o.id)}"` : ''}>
        <button type="button" class="sb-clear" data-act="${esc(o.clearAct)}"${on ? '' : ' hidden'}
          title="清除搜索" aria-label="清除搜索">✕</button>
      </div>`;
  }

  /** 搜索条的「有词」标记与「清除」按钮都是从关键词派生的展示态，必须在**改关键词的地方**
   *  就地同步一次 —— 只靠渲染同步会被「最小重绘跳过聚焦子树」挡掉（见上面的注释）。 */
  function syncSearchBar(input) {
    if (!input || !input.closest) return;
    const bar = input.closest('.search-bar');
    if (!bar) return;
    const on = !!String(input.value || '').trim();
    bar.classList.toggle('filled', on);
    const btn = bar.querySelector('.sb-clear');
    if (btn) btn.hidden = !on;
  }

  /* ── 同步状态指示 ─────────────────────────────────────── */

  function setSync(kind) {
    state.sync = kind;
    const pill = $('#sync-pill');
    const text = $('#sync-text');
    if (!pill) return;
    pill.classList.toggle('busy', kind === 'busy');
    pill.classList.toggle('offline', kind === 'offline');
    if (kind === 'busy') {
      text.textContent = '同步中';
    } else if (kind === 'offline') {
      text.textContent = '离线';
    } else if (state.lastSyncAt) {
      const d = new Date(state.lastSyncAt);
      text.textContent = `已同步 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      pill.title = `已同步（${d.toLocaleString()}）`;
    } else {
      text.textContent = '已同步';
    }
  }

  /* ── 输入态保护：刷新渲染时不打断正在输入的内容 ───────── */

  /* 「主动清空」标记：点搜索框的「清除」按钮时，DOM 里的旧文字还在，
     若不特殊处理，captureInputs 会把它记下来、下一次渲染又填回输入框 ——
     结果是「列表已经全量显示了，输入框里还留着旧关键词」。
     置上这个键，captureInputs 就跳过它，让清空真正生效。 */
  let preserveSkip = null;

  /* 搜索框的「清除」：四个搜索框共用一套动作。
     ★ 只改 state 是不够的，必须**顺手把 DOM 里那份旧文字抹掉**：
     输入框此刻通常还是焦点所在（v2.0.0 为了「连打第二个字不断，
     重绘后会把焦点还给搜索框」），而最小重绘对「握着焦点的节点」是直接跳过的
     （见 patchNode 的 holdsFocus 分支），于是 state 里已经空了、屏幕上还写着旧关键词。
     浏览器里点按钮会把焦点移到按钮上，恰好躲过去；键盘 / 触屏 / 自动化就躲不过去。 */
  const QUERY_ACT_KEY = {
    'post-query': 'post-q', 'todo-query': 'todo-q', 'rec-query': 'rec-q', 'bill-query': 'bill-q',
  };

  function clearSearchInput(act) {
    const el = document.querySelector(`[data-act="${act}"]`);
    if (el) { el.value = ''; syncSearchBar(el); }
    if (QUERY_ACT_KEY[act]) preserveSkip = QUERY_ACT_KEY[act];
  }

  function captureInputs() {
    const saved = [];
    $$('[data-preserve]').forEach((el) => {
      const key = el.getAttribute('data-preserve');
      if (key === preserveSkip) return;
      if (el.value) saved.push({ key, value: el.value });
      if (el === document.activeElement) {
        saved.focus = key;
        try { saved.sel = [el.selectionStart, el.selectionEnd]; } catch { /* 某些类型不支持 */ }
      }
    });
    preserveSkip = null;
    return saved;
  }

  function restoreInputs(saved) {
    if (!saved || (!saved.length && !saved.focus)) return;
    $$('[data-preserve]').forEach((el) => {
      const key = el.getAttribute('data-preserve');
      const hit = saved.find((s) => s.key === key);
      if (hit && !el.value) el.value = hit.value;
    });
    if (saved.focus) {
      const target = document.querySelector(`[data-preserve="${saved.focus}"]`);
      if (target) {
        target.focus();
        if (saved.sel) { try { target.setSelectionRange(saved.sel[0], saved.sel[1]); } catch { /* 忽略 */ } }
      }
    }
  }

  /* ── 递归最小重绘（v2.0.0，需求 1：同步时不打断输入与视频播放） ────────
     旧做法是 `el.innerHTML = 新模板`。它有两个代价：
       1. 正在播放的 <video> 被整个重建 → 从头开始播；
       2. 输入框被换掉 → 焦点与光标位置都没了（手机上还会把键盘收起）。
     这里改成「对齐 + 就地更新」：
       · 先按 `data-key` 认领「同一个东西」，没写 data-key 的按「标签名 + class + 同名序号」认领；
       · 标签名不同 → 整块替换；叶子节点比 outerHTML，一致就一个字节都不动
         （<video> 在播放中 outerHTML 不变 → 它就活下来了）；
       · 有子元素 → 递归下去继续对齐（所以卡片里的视频、输入框都能被保住）；
       · 焦点所在的**那一个输入控件**、以及带 `data-keep` 的子树，一律不碰
         （★ 只是「那个节点」，不是「它所在的整棵子树」，且只保护输入类控件 ——
         否则整张卡片里的新消息、新评论、被删掉的行都会被一起冻结，见 holdsFocus 的注释）；
       · 任何一步抛异常都往外抛，由调用方回退到整片 innerHTML —— 宁可重绘，
         也不能因为一个重绘 bug 把页面搞成空白。
     ═════════════════════════════════════════════════════════ */

  const PATCH_IGNORE = new Set(['SCRIPT', 'STYLE']);

  /** 生成一个节点的对齐键。同一个容器里同名同 class 的多个节点靠序号区分 */
  function patchKey(node, counter) {
    if (node.nodeType !== 1) return '#text';
    const tag = node.tagName;
    if (PATCH_IGNORE.has(tag)) return `${tag}#${node.src || node.textContent.slice(0, 40)}`;
    const cls = node.getAttribute('class') || '';
    const dk = node.getAttribute('data-key');
    if (dk) return `${tag}.${cls}*${dk}`;
    const base = `${tag}.${cls}`;
    const n = (counter[base] || 0) + 1;
    counter[base] = n;
    return `${base}#${n}`;
  }

  /**
   * 焦点是否**正好**落在这个节点上。
   *
   * ★ v2.0.1 把语义收窄过：原来是「焦点在这棵子树里就不碰」，那会把**兄弟内容一起冻结** ——
   *   输入框必然住在某个容器里（记账卡片、动态卡片…），于是那个容器里的
   *   新消息气泡、新评论、以及**被删掉的那一行**全都不会更新，表现成
   *   「发了但没回显」「删了还在」。而真正怕被 patch 弄丢的只有输入控件自己
   *   （`value` / `checked` 是 DOM **属性**，重建节点就会丢），所以只跳它一个就够。
   *
   * ★ v2.0.2 再收窄一次：只有「装着用户输入值」的控件才值得保护。
   *   按钮被点一下也会成为 activeElement（Android Chrome 点按钮必抢焦点），
   *   但按钮没有任何用户输入态 —— 保护它毫无收益，反而把「发送中…」的
   *   禁用按钮永远冻在屏幕上回不来（需求③「发送按钮变三个点」的根因就是它）。
   */
  function holdsFocus(node) {
    const a = document.activeElement;
    if (!a || a === document.body) return false;
    if (a !== node) return false;
    const tag = node && node.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
      || !!(node.hasAttribute && node.hasAttribute('data-preserve'));
  }

  /** 把 fresh 的属性同步到 old 上（少了的删掉，多了的补上） */
  function patchAttrs(oldEl, newEl) {
    for (const a of Array.from(newEl.attributes)) {
      if (oldEl.getAttribute(a.name) !== a.value) oldEl.setAttribute(a.name, a.value);
    }
    for (const a of Array.from(oldEl.attributes)) {
      if (!newEl.hasAttribute(a.name)) oldEl.removeAttribute(a.name);
    }
  }

  /** 就地更新一个已存在的节点，尽量不替换它 */
  function patchNode(oldNode, newNode) {
    if (oldNode.nodeType !== newNode.nodeType || oldNode.nodeType !== 1) {
      if (oldNode.textContent !== newNode.textContent) oldNode.textContent = newNode.textContent;
      return;
    }
    if (oldNode.hasAttribute('data-keep')) return;         // 声明「别动我」的子树
    if (holdsFocus(oldNode)) return;                       // 用户正在这里输入
    if (oldNode.tagName !== newNode.tagName) { oldNode.replaceWith(newNode); return; }
    // 叶子（没有元素子节点）直接比整段标签：属性 + 文本一次比完
    if (!oldNode.firstElementChild && !newNode.firstElementChild) {
      if (oldNode.outerHTML !== newNode.outerHTML) oldNode.replaceWith(newNode);
      return;
    }
    patchAttrs(oldNode, newNode);
    patchChildren(oldNode, Array.from(newNode.childNodes));
  }

  /** 把 parent 的子节点对齐到 freshNodes（本次渲染期望的样子） */
  function patchChildren(parent, freshNodes) {
    const fresh = freshNodes.filter((n) => n.nodeType === 1 || (n.nodeType === 3 && n.textContent.trim()));
    const old = Array.from(parent.childNodes)
      .filter((n) => n.nodeType === 1 || (n.nodeType === 3 && n.textContent.trim()));

    const oldCounter = {};
    const byKey = new Map();
    for (const n of old) {
      const k = patchKey(n, oldCounter);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(n);
    }

    const freshCounter = {};
    const used = new Set();
    let prev = null;
    for (const want of fresh) {
      const k = patchKey(want, freshCounter);
      const bucket = byKey.get(k) || [];
      let keep = null;
      for (const cand of bucket) { if (!used.has(cand)) { keep = cand; break; } }

      if (keep) {
        used.add(keep);
        // ★ 先把位置摆正再做内容对齐：否则 patchNode 抛异常时节点已经落在错的位置上
        const at = prev ? prev.nextSibling : parent.firstChild;
        if (keep !== at) parent.insertBefore(keep, at);
        patchNode(keep, want);
        prev = keep;
      } else {
        parent.insertBefore(want, prev ? prev.nextSibling : parent.firstChild);
        prev = want;
      }
    }
    for (const n of old) if (!used.has(n) && n.parentNode === parent) parent.removeChild(n);
  }

  /** 把容器内容更新成 html（内部走最小重绘）。失败时回退整片替换，保证「至少能看见」 */
  function patchHtml(container, html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    try {
      patchChildren(container, Array.from(tpl.content.childNodes));
      container.dataset.patched = '1';
      return true;
    } catch (err) {
      console.error('[patch] 最小重绘失败，回退整片替换：', err);
      container.innerHTML = html;
      container.dataset.patched = '1';
      return false;
    }
  }

  /* ── 渲染 ─────────────────────────────────────────────── */

  /* 每个页签「屏幕上这份内容」对应的数据指纹。渲染完记下来，下一次同步时先比一遍：
     一模一样就一个字节都不动 —— 这是「同步不打断用户」最省事也最有效的一层。 */
  const DATA_SIG = {
    calendar: () => JSON.stringify([state.todos, state.selected, state.todoFilter, state.todoQuery,
      state.todoShown, state.cursor, state.repeatOpen,
      /* v4.20.0（审查 W-9）：截断提示条是否出现也是屏幕内容，不进指纹那次 render 会早退 */
      state.todoTotal, state.todoTruncated,
      /* v4.9.0 需求 3：列表 / 日历双视图切换也是界面状态，变了要重绘 */
      state.todoView]),
    moments: () => JSON.stringify([state.posts, state.postQuery, state.postTag, state.postView,
      state.postCalCursor, state.postCalDay, state.compose, state.composeOpen,
      /* v4.3.3 需求 6：草稿恢复提示条的出现/消失同样是界面状态 */
      state.draftNotice,
      /* v4.13.0（问题 4）：表情面板开合也是界面状态，不进指纹的话点「表情」不会展开 */
      state.composeEmoji,
      /* v4.23.0 需求 3：三点菜单 / 评论展开同样是界面状态，
         不进指纹的话「点⋯」那次 render 会因为数据没变被早退 */
      state.postMenu, state.postOpen]),
    records: () => JSON.stringify([state.records, state.recQuery, state.recCategory,
      state.recShowArchived, state.recHidden]),
    /* v4.11.0：state.theme 必须进指纹 —— 换主题是「界面状态」变化，
       不进的话那次 render 会因为「数据没变」被早退，卡片上的选中态不会动。 */
    me: () => JSON.stringify([state.me, state.theme, state.members, state.settings, state.prefs, state.wecom,
      /* v4.10.0：系统状态卡片（版本 / DB / AI 状态）也是屏幕内容 */
      state.systemStatus,
      /* v4.12.0：「我的」拆成 7 个可折叠分区，哪几块展开着同样是界面状态 ——
         不进指纹的话，点「展开」那次 render 会被早退（和 v4.11.0 换主题是同一个坑）。 */
      state.meOpen, state.prefsGlobal,
      /* ★ v4.15.0 需求 2/3：AI 参数、分类预算、记账推送状态都搬进了「我的」，
         它们的数据来自 billMeta —— 不进指纹的话「我的」页会一直显示旧的预算/报表状态。 */
      state.billMeta, state.billBudgetPick, state.billAiParamsOpen, state.billAiLogs,
      /* v4.16.0 需求 4：推送渠道设置里两套配置的折叠状态（点标题收起 / 展开） */
      state.pushOpen]),
    bills: () => JSON.stringify([state.bills, state.billChat, state.billStats, state.billMeta,
      state.billScope, state.billQuery, state.billView, state.billExport,
      /* v4.0.0：快捷短语与统计范围也是「屏幕内容」，变了要重绘 */
      state.billQuick, state.billStatFrom, state.billStatTo, state.billAiLogs,
      /* v4.1.0：识别草稿箱的条数变化（存草稿 / 入账 / 删除）都要立刻反映到卡片 */
      state.billDrafts,
      /* v4.3.2 需求 1：疑似重复入账的提示条 —— 同样是界面状态，
         不进指纹的话「刚记的这笔弹出提示」那次 render 会被早退掉。 */
      state.billDupTips,
      /* v4.9.0：微信草稿箱 / 记账日历（月聚合数据 + 点开的那天及其明细）都直接决定屏幕内容 */
      state.billServerDrafts, state.billCalData, state.billCalDay, state.billCalDayBills,
      /* ★ v2.0.2：billSending 必须进指纹 —— 否则发送结束时那次 render 会因为
         「数据没变」而早退，「发送中…」的禁用按钮就永远回不到「发送」（需求③的完整根因：
         reloadBillAll 的那次 render 在 billSending=true 时记下了指纹，finally 里的
         render 指纹相同被跳过）。按钮的加载态是「界面状态」而非「业务数据」，要单独进指纹。 */
      state.billSending,
      /* v4.3.1 需求 4：识别中（📷 变 ⏳ 且禁用）也是界面状态，必须进指纹 —— 
         否则识别结束那次 render 会因「数据没变」早退，按钮永远停在 ⏳。 */
      state.billOcrBusy,
      /* v4.3.1 需求 6：识别参数区的展开/收拢（同「周期提醒」的折叠态） */
      state.billAiParamsOpen,
      /* v4.12.0：统计下的「筛选 / 日历」子视图、预算下拉的选择
         （v4.15.0 起设置三块折叠搬到「我的」的 meOpen，billSetOpen 已删除） */
      state.billStatsView, state.billBudgetPick]),
  };

  /* ═══ 多行输入框自适应高度（v4.13.0 问题 4）═══════════════════════
     为什么不用 CSS 的 `field-sizing: content`：Safari 17 以下不支持，
     表现就是「输入多了框不长大、内容被裁在框里」。用 scrollHeight 量，全端一致。
       · data-max-h：上限（超过后框内滚动），默认 320px
       · data-min-h：初始高度，默认 0（用 CSS 里的 min-height）
     ★ 必须在「值回填之后」调用（restoreInputs / 打开弹窗之后），否则量到的是空框。 */
  function autoGrow(el) {
    if (!el || el.tagName !== 'TEXTAREA') return;
    const max = Number(el.dataset.maxH) || 320;
    const min = Number(el.dataset.minH) || 0;
    el.style.height = 'auto';
    const need = el.scrollHeight + 2;
    el.style.height = `${Math.min(Math.max(need, min), max)}px`;
    el.style.overflowY = need > max ? 'auto' : 'hidden';
  }
  function growAutos(root) {
    const box = root || document;
    if (!box || typeof box.querySelectorAll !== 'function') return;
    box.querySelectorAll('textarea[data-autogrow]').forEach(autoGrow);
  }

  /* ═══ 草稿自动保存的进度指示（v4.13.0 问题 4）════════════════════
     「存草稿」按钮旁要能看出「刚才那几行字到底存没存」。
     三个状态：pending（输入中、0.8 秒计时还没到）/ saved（已落盘）/ 空（没有草稿）。
     ★ 动态与记录本各一份（kind = 'post' | 'rec'），否则两边会互相刷成对方的状态。
     ★ 只改这两个节点的文字，不走 render —— 打字时整页重绘会打断输入法。 */
  function draftHintText(kind) {
    const d = ((state.draftState || {})[kind]) || {};
    if (d.pending) return '正在保存草稿…';
    if (!d.at) return '';
    const t = new Date(d.at);
    if (Number.isNaN(t.getTime())) return '草稿已保存';
    return `草稿已保存 · ${pad(t.getHours())}:${pad(t.getMinutes())}`;
  }
  function paintDraftHint(kind) {
    const selector = kind === 'rec' ? '#rec-draft-hint' : '#post-draft-hint';
    const text = draftHintText(kind);
    const pending = !!(((state.draftState || {})[kind]) || {}).pending;
    $$(selector).forEach((el) => {
      el.textContent = text;
      el.classList.toggle('hidden', !text);
      el.classList.toggle('saving', pending);
    });
  }
  /** 输入中：先把「正在保存」点亮，落盘后再变成具体时间 */
  function markDraftPending(kind) {
    const k = kind === 'rec' ? 'rec' : 'post';
    const cur = state.draftState || {};
    state.draftState = Object.assign({}, cur, {
      [k]: { pending: true, at: (cur[k] || {}).at || '' },
    });
    paintDraftHint(k);
  }
  function markDraftSaved(kind) {
    const k = kind === 'rec' ? 'rec' : 'post';
    const cur = state.draftState || {};
    state.draftState = Object.assign({}, cur, {
      [k]: { pending: false, at: new Date().toISOString() },
    });
    paintDraftHint(k);
  }

  /* ═══ v4.28.1：版权 / 仓库 / 反馈三行 ═════════════════════════════════
     桌面端沉在左侧导航的最底部（.rail-foot，margin-top:auto），手机端放在
     「我的」页最底部（.app-foot 里同一份 HTML）。两处共用 brandFootHtml()，
     省得版本号、年份在两处各写一遍最后对不上。
     ★ 版本号取 /api/config（package.json 唯一来源），年份取运行时当前年，
       不写死；链接一律新窗口 + rel="noopener"，避免 window.opener 反向控制。 */
  const REPO_URL = 'https://github.com/heyzhu/family-hub';
  const FEEDBACK_URL = 'https://ucnesevkt97r.feishu.cn/share/base/form/shrcnjPD0oOBFud80o3p4yqSdyh';

  function brandFootHtml() {
    const ver = (state.config && state.config.version) || '?';
    const year = new Date().getFullYear();
    return `<div class="bf-line">${esc(APP_NAME)} v${esc(ver)}</div>`
      + `<div class="bf-line">© ${year} ${esc(APP_NAME)} · AGPL-3.0</div>`
      + '<div class="bf-line bf-links">'
      + `<a href="${REPO_URL}" target="_blank" rel="noopener">GitHub 仓库</a>`
      + '<span class="bf-dot" aria-hidden="true">·</span>'
      + `<a href="${FEEDBACK_URL}" target="_blank" rel="noopener">意见反馈</a>`
      + '</div>';
  }

  /* 侧栏底栏在 #main 之外，render() 的 DOM 替换管不到它，因此单独刷一次。
     innerHTML 写入会丢 hover 态，加一道签名缓存：内容没变就不碰 DOM。 */
  let railFootSig = '';
  function paintRailFoot() {
    const html = brandFootHtml();
    if (html === railFootSig) return;
    railFootSig = html;
    const el = $('#rail-foot');
    if (el) el.innerHTML = html;
  }

  function render() {
    if (!state.me) return;
    paintRailFoot();
    const map = VIEW_OF;
    const el = $('#' + map[state.tab]);
    if (!el) return;

    // 页签显隐与底栏高亮：即使内容没变也必须做（切页签本来就是「只换显隐」）
    $$('#main .view').forEach((v) => v.classList.toggle('hidden', v !== el));
    $$('#tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));

    // 月份切换动画是一次性的：在这里消费掉，免得早退分支把它吃掉
    const anim = state.calAnim;
    state.calAnim = '';

    const sig = DATA_SIG[state.tab] ? DATA_SIG[state.tab]() : '';
    if (el.dataset.patched === '1' && state.sig[state.tab] === sig) {
      if (anim) {
        const grid = el.querySelector('.cal-grid[data-cal]');
        if (grid) grid.classList.add('anim-' + anim);
      }
      growAutos(el);                // 切页签回来时高度可能还没算过（幂等，很便宜）
      paintDots();
      mountArtPlayers();            // v4.26.0：切回动态页签时补挂播放器（已挂的是空操作）
      return;                       // ← 数据没变：不动 DOM，播放中的视频与输入框全都不受影响
    }

    // 先抓输入态，再抓滚动位置（整片替换时两者都会丢）
    const saved = captureInputs();
    const scroller = $('#main');
    const keepScroll = state.tab === state.prevTab && scroller ? scroller.scrollTop : null;

    // 内容变化时才重绘：能最小重绘就最小重绘，不行再整片替换
    try {
      if (state.tab === 'calendar') {
        /* v4.9.0 需求 3：列表 / 日历双视图。两种视图的卡片都在 DOM 里，
           容器类（#view-calendar.todo-mode-*）决定哪边显示 —— 切换不销毁节点，
           输入框内容、滚动位置、「加载更多」的分页进度天然都保留。 */
        el.classList.toggle('todo-mode-list', state.todoView !== 'calendar');
        el.classList.toggle('todo-mode-calendar', state.todoView === 'calendar');
        patchHtml(el, todoToolsHtml() + todoListHtml() + calendarHtml() + dayPanelHtml() + repeatListHtml());
      }
      if (state.tab === 'moments') patchHtml(el, momentsHtml());
      if (state.tab === 'records') patchHtml(el, recordsHtml());
      if (state.tab === 'me') patchHtml(el, meHtml());
      if (state.tab === 'bills') patchHtml(el, billsHtml());
    } catch (err) {
      console.error('[render] 生成页面失败：', err);
      throw err;
    }

    restoreInputs(saved);
    if (keepScroll !== null && scroller) scroller.scrollTop = keepScroll;
    if (anim) {
      const grid = el.querySelector('.cal-grid[data-cal]');
      if (grid) grid.classList.add('anim-' + anim);
    }
    state.sig[state.tab] = sig;
    state.prevTab = state.tab;
    growAutos(el);        // v4.13.0：多行输入框按内容定高（值在 restoreInputs 之后才是最终的）
    paintDots();          // 底部红点（v1.9.0）
    mountArtPlayers();    // v4.26.0：给新渲染出来的视频挂 ArtPlayer（无视频时直接返回）
  }

  /* ═══ 日历 ═══════════════════════════════════════════════ */

  /* 重复规则的中文标签由 repeat.js 统一提供（RULE_LABEL，含 v4.10.0 的「每天」），
     界面不再自己维护一份（加规则时不会漏改）。 */

  /* 重复规则的落点计算在 repeat.js 里，服务端提醒调度用的是同一份实现——
     两边规则必须一致，否则会出现「日历上看得见、提醒却不发」这种错位。 */
  const repeatOccurrencesInYear = (t, year) => Repeat.occurrencesInYear(t, year);
  const repeatRuleLabel = (t) => Repeat.label(t);

  /** 某条待办是否覆盖某个日期（v4.10.0 跨天：todo_date ≤ day ≤ end_date||todo_date） */
  const todoCoversDay = (t, key) => {
    if (!t.date) return false;
    if (key === t.date) return true;
    const end = t.endDate || t.date;
    return key > t.date && key <= end;
  };

  /** 日历/当日面板用的日期 → 事项映射（含重复展开），years 为需覆盖的公历年 */
  function todosByDate(years) {
    const map = new Map();
    const put = (key, t) => {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(t);
    };
    for (const t of state.todos) {
      if (!t.date) continue;
      put(t.date, t);                           // 重复事项的基准日同样出现在日历上
      if (t.repeat || t.repeatRule) {
        for (const y of years) for (const key of repeatOccurrencesInYear(t, y)) put(key, t);
      }
      // v4.10.0：跨天待办在结束日之前的每一天都出现（文档 5.3：不是只在开始那天出现）
      if (t.endDate && t.endDate > t.date) {
        let d = Date.parse(t.date + 'T00:00:00Z') + 86400000;
        const endMs = Date.parse(t.endDate + 'T00:00:00Z');
        for (; d <= endMs; d += 86400000) {
          const key = new Date(d).toISOString().slice(0, 10);
          if (!map.has(key) || !map.get(key).includes(t)) put(key, t);
        }
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.startTime || '99:99').localeCompare(b.startTime || '99:99') || a.id - b.id);
    }
    return map;
  }

  /* ── 日历跳转（v4.3.3 需求 7）────────────────────────────
     点左上角「2026年10月」→ 输入年月日，直接跳到那一天。
     为什么需要：查明年的生日、翻多年前的记录、看某个月的周期提醒，
     靠「上个月」箭头一下一下点几十次不现实。
     待办日历与动态日历共用一个弹窗，只有确认后写回的目标不同。 */

  function openDateJump(kind, y, m, d) {
    const now = new Date();
    const yy = Number(y) || now.getFullYear();
    const mm = Number(m) || now.getMonth() + 1;
    const dd = Number(d) || now.getDate();
    openModal({
      title: kind === 'post' ? '跳到指定日期 · 动态日历'
        : (kind === 'bill' ? '跳到指定日期 · 记账日历' : '跳到指定日期 · 待办日历'),
      body: `
        <div class="field"><span>年</span>
          <input type="number" data-mk="jy" min="1900" max="2200" value="${yy}" inputmode="numeric"></div>
        <div class="field"><span>月</span>
          <input type="number" data-mk="jm" min="1" max="12" value="${mm}" inputmode="numeric"></div>
        <div class="field"><span>日</span>
          <input type="number" data-mk="jd" min="1" max="31" value="${dd}" inputmode="numeric"></div>
        <small class="field-hint">日填超过当月天数时，会自动夹到当月最后一天（不会跳到下个月）。</small>`,
      foot: `
        <div class="spacer"></div>
        <button type="button" class="btn-ghost" data-act="modal-close">取消</button>
        <button type="button" class="btn-primary" data-act="date-jump-ok" data-kind="${esc(kind)}">跳转</button>`,
    });
  }

  function applyDateJump(kind) {
    const y = Math.round(Number(modalValue('jy')) || 0);
    const m = Math.round(Number(modalValue('jm')) || 0);
    if (!(y >= 1900 && y <= 2200) || !(m >= 1 && m <= 12)) {
      toast('请填写正确的年份（1900–2200）与月份（1–12）', 'err');
      return;
    }
    // 夹到当月最后一天：填「2 月 31 日」跳去 3 月 3 日是最容易让人以为「跳错了」的坑
    const dim = new Date(y, m, 0).getDate();
    const d = Math.min(dim, Math.max(1, Math.round(Number(modalValue('jd')) || 1)));
    const key = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (kind === 'post') {
      state.postCalCursor = { y, m: m - 1 };
      state.postCalDay = key;
    } else if (kind === 'bill') {
      /* v4.9.0 需求 2：记账日历跳月 —— 跳完顺手把当月聚合拉回来 */
      state.billCalCursor = { y, m: m - 1 };
      state.billCalDay = key;
      state.billCalDayBills = null;
      refreshBillCalendar().then(render).catch(() => {});
    } else {
      state.cursor = { y, m: m - 1 };
      state.selected = key;
    }
    closeModal();
    render();
  }

  function calendarHtml() {
    const { y, m } = state.cursor;
    const byDate = todosByDate([y - 1, y, y + 1]);   // 月视图首尾可能跨年
    const first = new Date(y, m, 1);
    const startOffset = first.getDay();               // 周日开头
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const cells = [];

    for (let i = 0; i < 42; i++) {
      const dayNum = i - startOffset + 1;
      const d = new Date(y, m, dayNum);
      const key = dateKey(d);
      const other = dayNum < 1 || dayNum > daysInMonth;
      const list = byDate.get(key) || [];
      const label = Lunar.dayLabel(d.getFullYear(), d.getMonth() + 1, d.getDate());
      const l = Lunar.solar2lunar(d.getFullYear(), d.getMonth() + 1, d.getDate());
      const isFest = !!(l && l.festival) || /节$/.test(label) || /^(春节|元宵|端午|中秋|除夕|元旦|清明)$/.test(label);
      const dots = list.slice(0, 3).map((t) => `<i class="${(Repeat.rule(t) ? (key === todayKey() && !!t.doneToday) : !!t.done) ? 'done' : ''}"></i>`).join('');
      cells.push(
        `<button type="button" class="cal-cell${other ? ' other' : ''}${key === todayKey() ? ' today' : ''}${key === state.selected ? ' selected' : ''}" data-act="pick-date" data-date="${key}">` +
        `<span class="d-num">${d.getDate()}</span>` +
        `<span class="d-sub${isFest ? ' fest' : ''}">${esc(label)}</span>` +
        `<span class="dots">${dots}</span>` +
        '</button>',
      );
    }

    const headLunar = Lunar.solar2lunar(y, m + 1, 15);
    return `
      <div class="card cal-only">
        <div class="cal-head">
          <div class="cal-title">
            <button type="button" class="cal-jump" data-act="cal-jump" title="点击跳转到指定年月日">${y}年${m + 1}月</button>
            <span>${headLunar ? `${headLunar.ganzhi}年 · ${headLunar.zodiac}年` : ''}</span>
          </div>
          <div class="cal-nav">
            <button type="button" class="icon-btn" data-act="cal-prev" title="上个月">‹</button>
            <button type="button" class="btn-ghost btn-sm" data-act="cal-today">今天</button>
            <button type="button" class="icon-btn" data-act="cal-next" title="下个月">›</button>
          </div>
        </div>
        <div class="cal-week">${WEEK_CN.map((w, i) => `<span class="${i === 0 ? 'wk' : ''}">${w}</span>`).join('')}</div>
        <div class="cal-grid" data-cal="todo">${cells.join('')}</div>
      </div>`;
  }

  function dayPanelHtml() {
    const key = state.selected;
    const [y, m, d] = key.split('-').map(Number);
    const lunar = Lunar.solar2lunar(y, m, d);
    const term = Lunar.solarTerm(y, m, d);
    const list = (todosByDate([y]).get(key) || []);
    const dateObj = new Date(y, m - 1, d);
    const isToday = key === todayKey();

    return `
      <div class="card day-panel cal-only">
        <div class="day-panel-head">
          <div class="day-date">
            <b>${humanDate(key)} 星期${WEEK_CN[dateObj.getDay()]}</b>
            <span class="lunar">${lunar ? `${lunar.monthName}${lunar.dayName}` : ''}</span>
            ${lunar && lunar.festival ? `<span class="tag-fest">${esc(lunar.festival)}</span>` : ''}
            ${!lunar || !lunar.festival ? (term ? `<span class="tag-fest">${esc(term)}</span>` : '') : ''}
            ${isToday ? '<span class="badge date">今天</span>' : ''}
          </div>
          <button type="button" class="btn-soft btn-sm" data-act="todo-new" data-date="${key}">＋ 添加待办</button>
        </div>
        ${list.length
          ? list.map((t) => todoHtml(t, { showDate: false, dayKey: key })).join('')
          : '<div class="empty" style="padding:16px"><span class="em">🗓️</span>这一天还没有安排</div>'}
      </div>`;
  }

  /* v4.21.0 需求 2：完成状态统一口径 ——
     一次性待办看 todos.done；重复事项看「今天这次」（doneToday，服务端按落点日算）。
     只写一处，列表筛选、计数、排序、日历圆点都引用它，避免同一个概念四种写法。 */
  function todoDoneOf(t) {
    return Repeat.rule(t) ? !!t.doneToday : !!t.done;
  }

  function todoSort(list) {
    // 重复事项按「今天」排（它在列表里代表的是今天这一次），一次性待办按自己的日期
    const dk = (t) => (Repeat.rule(t) ? todayKey() : (t.date || '9999-12-31'));
    return list.slice().sort((a, b) => {
      const da = todoDoneOf(a);
      const db2 = todoDoneOf(b);
      if (da !== db2) return da ? 1 : -1;
      if (da) return dk(b).localeCompare(dk(a)) || b.id - a.id;
      return dk(a).localeCompare(dk(b)) || (a.startTime || '99:99').localeCompare(b.startTime || '99:99') || a.id - b.id;
    });
  }

  function todoHtml(t, opts) {
    const o = opts || {};
    // v4.10.0：周期判定走 repeat.js 统一读取（repeat_rule 优先、repeat 回落）
    const isRepeat = !!(t.repeat || t.repeatRule);
    /* v4.21.0 需求 2 / v4.28.0 修正：重复事项也能勾 —— 但勾的是「今天这一行代表的落点」。
       提前 N 天提醒时，今天这一行代表的是 N 天后的那个落点（服务端算好放在 rowOccDate），
       所以不能再用「今天是不是落点」来判断能否勾，也不能阻止勾「将来那个落点」——
       用户此刻要表达的是「这件事今天处理完了，别再提醒我」。
       日历日面板（opts.dayKey）仍然只允许勾不晚于今天的落点。 */
    const useRowKey = !o.dayKey && !!t.rowOccDate;
    const tickDay = String(o.dayKey || (useRowKey ? t.rowOccDate : todayKey())).slice(0, 10);
    const repeatTickable = isRepeat && Repeat.isOccurrence(t, tickDay)
      && (useRowKey || tickDay <= todayKey());
    const doneNow = isRepeat
      ? (useRowKey ? !!t.doneToday : (tickDay === todayKey() && !!t.doneToday))
      : !!t.done;
    const noTick = o.noTick != null ? o.noTick : (isRepeat && !repeatTickable);
    const meta = [];
    if (t.repeat || t.repeatRule) {
      // ★ 重复事项显示「下一次提醒」而不是当初建这条时填的日期。
      //   基准日可能是好几年前（比如 2020 年建的结婚纪念日），显示出来只会让人困惑；
      //   用户真正关心的是「下一次什么时候提醒我」。数据由服务端算好下发
      //   （服务端调度用的是同一套落点与提前天数，显示与实际发信时间必然一致）。
      const key = t.nextRemindKey || t.nextOccurrence || '';
      const text = nextRemindText(key, t.nextRemindTime);
      const advance = Number(t.advanceDays) || 0;
      meta.push(`<span class="next-remind" title="${esc(advance > 0
        ? `提前 ${advance} 天提醒（事项本身在 ${t.nextOccurrence || key}）`
        : '到点当天提醒')}">⏰ 下次提醒 ${esc(text || '—')}` +
        `${advance > 0 ? `<i class="adv-tag">提前${advance}天</i>` : ''}</span>`);
      /* v4.19.0 需求 2-1：重复事项的关键信息补全 —— 旧版只有一个短徽标（「每天」）
         和「下次提醒」，看不出「几点提醒、这个点是哪来的」。
         现在把三件事拆开讲清楚：
           ① 🔁 规则（每天 / 每周公历 星期三 / 每年公历 5月20日…）
           ② 🕐 提醒时间（本条单独设的，或跟随「待办提醒」默认时间）
           ③ ⏰ 下次提醒的具体日期与时刻（上面那条） */
      const ruleName = t.repeatRule || Repeat.rule(t);
      const ruleText = repeatRuleLabel(t) || Repeat.RULE_LABEL[ruleName] || '重复';
      meta.push(`<span class="badge repeat" title="重复规则：${esc(ruleText)}，到点自动提醒">🔁 ${esc(ruleText)}</span>`);
      if (t.remind) {
        const rt = t.remindTime || t.nextRemindTime || '';
        if (rt) {
          meta.push(`<span class="rep-time" title="${esc(t.remindTimeIsDefault
            ? '跟随消息推送设置里的「待办提醒」默认时间'
            : '这条待办单独设置的时间')}">🕐 提醒时间 ${esc(rt)}${t.remindTimeIsDefault ? '<i class="def-tag">默认</i>' : ''}</span>`);
        }
      } else {
        meta.push('<span class="rep-time off">🔕 未开启提醒</span>');
      }
    } else if (o.showDate !== false) {
      if (t.endDate && t.endDate > t.date) {
        // v4.10.0：跨天待办显示「10-21 ~ 10-23 · 共 3 天」（文档 5.2-3）
        const days = Math.round((Date.parse(t.endDate + 'T00:00:00Z')
          - Date.parse(t.date + 'T00:00:00Z')) / 86400000) + 1;
        meta.push(`<span>📅 ${esc(t.date)} ~ ${esc(t.endDate)} · 共 ${days} 天</span>`);
      } else {
        meta.push(`<span>📅 ${t.date ? esc(t.date) : '待安排'}</span>`);
      }
    }
    if (t.startTime && !t.repeat && !t.repeatRule) meta.push(`<span>🕐 ${esc(t.startTime)}${t.endTime ? '–' + esc(t.endTime) : ''}</span>`);
    if (t.participants.length) meta.push(`<span>👥 ${esc(t.participants.join('、'))}</span>`);
    if (!o.hideOwner && t.ownerName) meta.push(`<span>✍️ ${esc(t.ownerName)}</span>`);

    // ★ v1.6.0：徽标不再单独占一行（那样每条待办的高度会随徽标数量变化），
    //   统一并进 meta 行 —— 既保证「所有信息都留了位置」，也让每条高度一致。
    // v4.19.0：重复规则已在上面的 🔁 徽标里讲清楚，这里不再重复；🔔 只留给一次性待办。
    if (t.remind && t.date && !t.repeat && !t.repeatRule) meta.push('<span class="badge repeat">🔔 提醒</span>');
    // v4.6.0 需求 3：开了「催促完成」的待办要一眼看得出来（催多少次都可能，用户得知道它在响）
    if (t.urgeMinutes > 0) {
      meta.push(`<span class="badge urge" title="到点后每 ${t.urgeMinutes} 分钟催一次：企业微信里回「已完成」就停；只配了邮件时，到待办里勾一下这条就停">⏰ 每 ${t.urgeMinutes} 分钟催</span>`);
    }
    if (t.priority === 'high') meta.push('<span class="badge p-high">重要</span>');
    if (t.priority === 'low') meta.push('<span class="badge p-low">稍后</span>');
    if (t.visibility === 'private') meta.push(`<span class="badge priv">${visBadgeText(t)}</span>`);

    const tick = noTick
      ? '<span class="tick tick-static" title="重复事项：只有它到点的那一天才能勾选完成">🔁</span>'
      : (isRepeat
        ? `<button type="button" class="tick" data-act="todo-day-toggle" data-id="${t.id}" data-date="${esc(tickDay)}"
                   title="${doneNow ? '取消今天的完成' : '标记今天完成：今天不再提醒（明天/下个周期照常）'}">✓</button>`
        : `<button type="button" class="tick" data-act="todo-toggle" data-id="${t.id}" title="标记完成">✓</button>`);

    /* 三行固定结构（标题 / 元信息 / 备注）：备注为空也占位，这样每条待办高度完全一致，
       默认 5 条能稳稳落在一屏内。超出部分由 CSS 单行省略。 */
    return `
      <div class="todo${doneNow ? ' done' : ''}${isRepeat ? ' todo-repeat' : ''}">
        ${tick}
        <div class="t-body" data-act="todo-edit" data-id="${t.id}" style="cursor:pointer">
          <div class="t-title">${esc(t.title)}</div>
          <div class="t-meta">${meta.join('')}</div>
          <div class="t-note">${t.note ? esc(t.note) : ''}</div>
        </div>
      </div>`;
  }

  /** 一次性待办（参与筛选/分页/完成状态） */
  function onceTodos() {
    return state.todos.filter((t) => !Repeat.rule(t));
  }

  /**
   * v4.21.0 需求 2 / v4.28.0 修正：主列表 = 一次性待办 + **今天该处理的那一次重复事项**。
   * 为什么不把重复事项无条件塞进列表：一条「每年 5 月 20 日」的纪念日会在一年里
   * 每天都占一行、还每天出现在「未完成」里 —— 那不是混排，是噪声。
   *
   * 「今天该处理」由**服务端**算好（shapeTodo.rowOccDate）：
   *   · 今天是它的提醒日（落点 − 提前天数）→ 代表那个落点；
   *   · 或今天就是落点本身（提前 0 天时两者等价）。
   * ★ v4.28.0：勾完「今天完成」之后**直接从列表移除** —— 它只表示「今天不再提醒」，
   *   不是「这件事已完成」，所以也不该出现在「已完成」筛选里（重复事项明天/下个周期还会回来）。
   */
  function mainTodos() {
    const todayRepeats = state.todos.filter((t) => Repeat.rule(t) && t.rowOccDate && !t.doneToday);
    return onceTodos().concat(todayRepeats);
  }

  /** 重复事项：单独列出，不参与完成筛选（它们本来就没有完成状态） */
  function repeatTodos() {
    const q = state.todoQuery.trim().toLowerCase();
    return state.todos
      .filter((t) => {
        if (!Repeat.rule(t)) return false;
        /* v4.22.0 需求 2：一句话添加的待办只在「待办列表」里，不进周期提醒卡 */
        if (t.quick) return false;
        if (!q) return true;
        const hay = [t.title, t.note, t.date, t.participants.join(' ')].join(' ').toLowerCase();
        return hay.includes(q);
      })
      // ★ 按「下一次提醒的日期」排序：列表里显示的就是这一列，若还按建单日期排，
      //   排序结果和眼睛看到的日期对不上（比如 2020 年建的纪念日排在最前面）。
      .sort((a, b) => String(a.nextRemindKey || '').localeCompare(String(b.nextRemindKey || '')) || a.id - b.id);
  }

  function filteredTodos() {
    const q = state.todoQuery.trim().toLowerCase();
    return todoSort(mainTodos().filter((t) => {
      const done = todoDoneOf(t);
      if (state.todoFilter === 'pending' && done) return false;
      if (state.todoFilter === 'done' && !done) return false;
      if (q) {
        const hay = [t.title, t.note, t.date, t.participants.join(' ')].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }));
  }

  /* v4.9.0 需求 3：日历页签顶部的视图切换工具条 —— 交互与动态模块的
     「动态流 / 按日历看」完全一致（seg-mini 分段 + 右侧主操作按钮）。 */
  function todoToolsHtml() {
    return `
      <div class="card card-pad todo-view-tools">
        <div class="list-tools">
          <div class="segmented seg-mini" data-act="todo-view">
            <button type="button" data-view="list" class="${state.todoView !== 'calendar' ? 'on' : ''}">待办列表</button>
            <button type="button" data-view="calendar" class="${state.todoView === 'calendar' ? 'on' : ''}">日历</button>
          </div>
          <button type="button" class="btn-soft btn-sm" data-act="todo-new">＋ 添加待办</button>
        </div>
      </div>`;
  }

  function todoListHtml() {
    const list = filteredTodos();
    const shown = list.slice(0, state.todoShown);
    const rest = list.length - shown.length;
    /* v4.21.0 需求 2：计数口径跟着主列表走（一次性 + 今天到点的重复事项）——
       重复事项第二天自动回到未完成，所以「未完成」每天都会重新把它算进去，
       这正是「每天要做的事」该有的样子。 */
    const all = mainTodos();
    const total = all.length;
    const pending = all.filter((t) => !todoDoneOf(t)).length;
    return `
      <div class="card card-pad todo-list-card list-only">
        <div class="section-head">
          <div class="section-title">待办列表<span class="count-pill">未完成 ${pending} / 共 ${total}</span></div>
          <!-- v4.12.0 需求：首页去掉「详细添加」按钮（顶部工具条里已经有一个 ＋添加待办），
               这个位置改放「每页条数」—— 它是列表自身的显示设置，放在列表标题旁最合手。 -->
          <select class="page-size" data-act="todo-page-size" title="每页显示条数">
            ${PAGE_SIZES.map((n) => `<option value="${n}"${state.todoPageSize === n ? ' selected' : ''}>每页 ${n} 条</option>`).join('')}
          </select>
        </div>
        <div class="quick-add">
          <input class="grow" type="text" maxlength="100" placeholder="一句话加待办：默认今天起、每天提醒" data-preserve="todo-quick"
                 data-act="todo-quick-input">
          <button type="button" class="btn-primary btn-sm" data-act="todo-quick-add">添加</button>
        </div>
        <div class="list-tools">
          <div class="segmented" data-act="todo-filter">
            <button type="button" data-filter="all" class="${state.todoFilter === 'all' ? 'on' : ''}">全部</button>
            <button type="button" data-filter="pending" class="${state.todoFilter === 'pending' ? 'on' : ''}">未完成</button>
            <button type="button" data-filter="done" class="${state.todoFilter === 'done' ? 'on' : ''}">已完成</button>
          </div>
          <!-- v4.12.0：搜索框挪到原「每页条数」的位置（工具条右端），跟其它列表页保持一致 -->
          ${searchBarHtml({
            act: 'todo-query', clearAct: 'todo-q-clear', preserve: 'todo-q',
            /* v4.28.1 需求 3：搜索框挪到分段按钮右侧同一行后，手机上只剩 ~170px ——
               「搜索标题 / 备注 / 参与人」会被截成「搜索标题 / 备注 / 参…」，这里收成四个字。 */
            placeholder: '搜索待办', value: state.todoQuery,
          })}
        </div>
        ${shown.length
          ? shown.map((t) => todoHtml(t)).join('')
          : '<div class="empty"><span class="em">📝</span>没有符合条件的待办</div>'}
        ${rest > 0 ? `<button type="button" class="btn-ghost btn-more" data-act="todo-more">加载更多（还有 ${rest} 条）</button>` : ''}
        ${state.todoTruncated
          ? `<div class="note-box todo-trunc">⚠️ 这条列表一次最多加载 ${state.todos.length} 条（家庭里共有 ${state.todoTotal} 条）。
              更早的没有显示出来 —— 可以把不用的重复提醒「结束重复」，或删掉过期事项。</div>`
          : ''}
      </div>`;
  }

  /**
   * 周期提醒（v2.0.0 由「周期提醒」改名）：独立成卡、放在日历页最末，默认**收起**。
   * 理由：这类事项一年也就几条，展开着会白占半屏；但也不能藏没了——
   * 所以留一个带条数的标题，点一下即可展开。
   * 例外：正在搜索时自动展开。搜到了却看不见，比不提供搜索更让人困惑。
   *
   * ★ 改名不是换个字：v1.9.0 只有「每年 / 每月」，v2.0.0 又加了「每周」，
   *   「年度」这个词已经明显说小了范围，用户会以为周提醒不在这里。
   */
  function repeatListHtml() {
    /* v4.10.0：周期判定改走 repeat.js 的统一读取（repeat_rule 优先、repeat 回落），
       「每天」这种只存在于 repeat_rule 的规则也能进周期区块 */
    const all = state.todos.filter((t) => !!Repeat.rule(t) && !t.quick);
    if (!all.length) return '';
    const open = state.repeatOpen;
    const list = repeatTodos();
    const body = open
      ? `<div class="note-box" style="margin-bottom:10px">这些事项按周期到时间就会自动提醒。
          <b>今天轮到的那一次已经在上面「待办列表」里</b>，勾一下表示今天不再提醒：
          它会从列表里消失，但不会进「已完成」（这是周期事项，明天 / 下个周期照常回来）；
          这张卡里留着的是全部重复规则的清单，方便随时改或「结束重复」。</div>`
        + (list.length
          ? list.map((t) => todoHtml(t, { noTick: true })).join('')
          : '<div class="empty" style="padding:14px"><span class="em">🔍</span>没有匹配的周期提醒事项</div>')
      : '';
    return `
      <div class="card card-pad repeat-list-card list-only${open ? ' open' : ''}">
        <button type="button" class="repeat-toggle" data-act="repeat-toggle" aria-expanded="${open ? 'true' : 'false'}">
          <span class="section-title">周期提醒<span class="count-pill">${all.length} 条</span></span>
          <span class="repeat-caret">${open ? '收起' : '展开'}<i>${open ? '⌃' : '⌄'}</i></span>
        </button>
        ${body}
      </div>`;
  }

  /* ═══ 动态 ═══════════════════════════════════════════════ */

  function allPostTags() {
    const set = new Set();
    state.posts.forEach((p) => p.tags.forEach((t) => set.add(t)));
    return Array.from(set);
  }

  /* ── 动态内容的可复用片段（v4.6.0 需求 1）──────────────────
     动态流与「按日历查看」原本各写各的：日历那边只画了正文和图片，
     **共创、评论、点赞统统没有** —— 家人按日期回看时，这些互动像凭空消失了。
     抽成共用函数之后，两个视图用的是同一份渲染逻辑，
     以后再加互动形式也不会只出现在动态流里漏掉日历。

     ★ 评论节点必须带 data-key="cmt-<id>"：删评论 / 多人同时评论时，
       靠序号认领会把上一条的节点复用掉，若那条正握着焦点就会被整块跳过。 */

  /** 单条评论（含「回复 谁」） */
  function commentItemHtml(p, c, isReply) {
    return `
        <div class="comment${isReply ? ' reply' : ''}" data-key="cmt-${c.id}">
          ${avatarHtml(c.ownerName)}
          <div class="comment-body">
            <span class="c-name">${esc(c.ownerName)}</span>
            ${c.replyToName ? `<span class="comment-reply-to">回复 ${esc(c.replyToName)}</span>` : ''}
            <span class="c-text">${esc(c.content)}</span>
            <span class="c-time">${esc(fmtTime(c.createdAt))}</span>
            ${c.mine || p.mine ? `<button type="button" class="comment-del" data-act="comment-del" data-id="${c.id}">删除</button>` : ''}
            <div class="comment-ops">
              <button type="button" data-act="like-toggle" data-id="${p.id}" data-target="comment" data-tid="${c.id}"
                      class="${c.liked ? 'liked' : ''}" title="点赞">${c.liked ? '❤️' : '🤍'}${c.likeCount ? ' ' + c.likeCount : ''}</button>
              <button type="button" data-act="comment-reply" data-id="${p.id}" data-cid="${c.id}" data-name="${esc(c.ownerName)}">回复</button>
            </div>
          </div>
        </div>`;
  }

  /** 评论列表：顶层评论在前，它的回复紧跟其后缩进（父评论被删则子回复当顶层显示） */
  function commentsListHtml(p) {
    const all = p.comments || [];
    const isRoot = (c) => !Number(c.parentId)
      || !all.some((x) => Number(x.id) === Number(c.parentId));
    const html = all
      .filter(isRoot)
      .map((c) => commentItemHtml(p, c, false)
        + all.filter((x) => Number(x.parentId) === Number(c.id))
          .map((r) => commentItemHtml(p, r, true)).join(''))
      .join('');
    return html || '<div style="font-size:12.5px;color:var(--muted)">还没有评论，来说点什么吧</div>';
  }

  /** 点赞行（朋友圈式：❤ 已赞 + 赞过的人）。
   *  v4.23.0 需求 3：**默认不显示** —— 只有「我赞过」或「已经有人赞」时才出现。
   *  点赞入口统一收到右下角「⋯」菜单里，界面回到「只看内容」的样子。 */
  function likeRowHtml(p) {
    const show = !!p.liked || !!((p.likes && p.likes.length));
    return `
        <div class="post-like-row${show ? '' : ' hidden'}">
          <button type="button" class="like-btn${p.liked ? ' on' : ''}" data-act="like-toggle" data-id="${p.id}" data-target="post">
            ${p.liked ? '❤️ 已赞' : '🤍 点赞'}${p.likeCount ? ` ${p.likeCount}` : ''}
          </button>
          ${(p.likes && p.likes.length)
            ? `<span class="like-names">${p.likes.map((l) => esc(l.name)).join('、')} 觉得很赞</span>`
            : ''}
        </div>`;
  }

  /** 一起写（共创）区：家人往这条动态里追加的图文视频，每条留名留时间 */
  function contribsHtml(p) {
    const list = p.contributions || [];
    if (!list.length) return '';
    const items = list.map((c) => `
        <div class="contrib">
          ${avatarHtml(c.ownerName)}
          <div class="contrib-body">
            <div class="contrib-head">
              <span class="c-name">${esc(c.ownerName)}</span>
              <span class="c-time">一起写 · ${esc(fmtTime(c.createdAt))}</span>
              ${c.updatedAt ? '<span class="contrib-edited">已编辑</span>' : ''}
              ${c.mine ? `<button type="button" class="comment-del" data-act="contrib-edit" data-id="${c.id}" data-post="${p.id}">编辑</button>` : ''}
              ${c.mine || p.mine ? `<button type="button" class="comment-del" data-act="contrib-del" data-id="${c.id}">删除</button>` : ''}
            </div>
            ${c.content ? `<div class="contrib-text">${esc(c.content)}</div>` : ''}
            ${(c.images || []).length
              ? `<div class="post-imgs n${Math.min(c.images.length, 9)}" data-gal="${esc(JSON.stringify(c.images))}">${c.images
                  .map((src) => `<img src="${esc(assetUrl(src))}" loading="lazy" alt="" data-act="img-view" data-src="${esc(src)}">`).join('')}</div>`
              : ''}
            ${videoPlayerHtml(c.videos || [], c.videoCovers)}
          </div>
        </div>`).join('');
    return `<div class="contribs"><div class="contrib-title">✍️ 一起写（${list.length}）</div>${items}</div>`;
  }

  /* ★ `.comments` 里刻意把评论列表单独包一层 `.comment-list`，与 `.comment-form` 平级。
     原因：最小重绘对「握着焦点的节点」是**整棵子树**跳过。提交评论后焦点还在这个输入框里
     （按 Enter 提交时更是如此），若评论列表与输入框同属一层，整层都会被跳过 ——
     表现就是「发表评论后评论显示不及时，要等焦点移开才冒出来」。
     拆成两层后，输入框那一层照旧受保护，评论列表这一层能正常增删。 */
  /* v4.23.0 需求 3：评论区**默认收起**（含已有评论与输入框）。
     点右下角「⋯ → 评论」才展开，展开后自动聚焦输入框。
     收起不等于删除 —— 已有评论还在 DOM 里（只是 hidden），搜索也照样搜得到。 */
  function commentsBlockHtml(p) {
    const open = !!((state.postOpen || {})[p.id] && state.postOpen[p.id].comments);
    return `<div class="comments${open ? '' : ' hidden'}" data-post="${p.id}">
            <div class="comment-list">${commentsListHtml(p)}</div>
            <div class="comment-form" data-post="${p.id}">
              <div class="comment-input-row">
                <input type="text" placeholder="写下你的评论…" data-preserve="comment-${p.id}" data-act="comment-input" data-id="${p.id}">
                <button type="button" data-act="emoji-toggle" data-id="${p.id}" title="插入表情" aria-label="插入表情">😊</button>
                <button type="button" data-act="comment-send" data-id="${p.id}">发送</button>
              </div>
            </div>
          </div>`;
  }

  /* v4.23.0 需求 3：把「一起写 / 编辑 / 删除 / 赞 / 评论」收进右下角「⋯」菜单。
     权限沿用原逻辑：一起写 = 可见范围允许（服务端也会校验），编辑 / 删除 = 本人。
     ★ 菜单项直接复用原来的 data-act，不再另起一套动作 ——
       否则权限、确认弹窗、成功提示都要复制一份，迟早两份逻辑走偏。 */
  function postMenuHtml(p, canContrib) {
    const id = p.id;
    const items = [
      `<button type="button" class="post-menu-item" data-act="like-toggle" data-id="${id}" data-target="post">${p.liked ? '💔 取消赞' : '❤️ 赞'}</button>`,
      `<button type="button" class="post-menu-item" data-act="post-comment-open" data-id="${id}">💬 评论</button>`,
      canContrib ? `<button type="button" class="post-menu-item" data-act="contrib-add" data-id="${id}">✍️ 一起写</button>` : '',
      p.mine ? `<button type="button" class="post-menu-item" data-act="post-edit" data-id="${id}">✏️ 编辑</button>` : '',
      p.mine ? `<button type="button" class="post-menu-item danger" data-act="post-del" data-id="${id}">🗑️ 删除</button>` : '',
    ].filter(Boolean).join('');
    return `<div class="post-menu" role="menu">${items}</div>`;
  }

  /** 帖子右下角的「⋯」按钮（菜单展开时把菜单挂在它上方） */
  function postFootHtml(p, canContrib) {
    const open = Number(state.postMenu) === Number(p.id);
    return `<div class="post-foot">
        ${open ? postMenuHtml(p, canContrib) : ''}
        <button type="button" class="post-more${open ? ' on' : ''}" data-act="post-more" data-id="${p.id}"
                aria-haspopup="menu" aria-expanded="${open ? 'true' : 'false'}"
                title="点赞、评论、一起写…" aria-label="更多操作">⋯</button>
      </div>`;
  }

  function momentsHtml() {
    /* ★ v4.3.2 需求 4：发帖前已选好的图片要能点开看大图。
       旧写法只在 <div class="thumb"> 里放了个 <img>，没挂任何动作 —— 点它等于点空白，
       用户在上传后想确认「选的是不是这张」时没辙。
       现在给 img 挂上 img-view（与正文里的图片同一个动作），并让外层容器带 data-gal，
       于是灯箱进去之后还能左右翻看这一组，和发完帖之后的体验完全一致。
       `×` 删除按钮是 img 的兄弟节点、自己带 data-act，不会被 img-view 抢走点击。 */
    const composePaths = state.compose.images.map((im) => im.path);
    const imgs = state.compose.images.map((im, i) =>
      `<div class="thumb"><img src="${esc(assetUrl(im.path))}" alt="" data-act="img-view" data-src="${esc(im.path)}"><button type="button" data-act="compose-del" data-i="${i}">×</button></div>`).join('');
    // v1.9.0：已选视频（用 <video> 做首帧预览，不自动播放，免得一进页面就开始响）
    const vids = state.compose.videos.length
      ? `<div class="composer-videos">${videoChipHtml(state.compose.videos.map((v) => v.path), 'compose-vdel', '', coverMapOf(state.compose.videos))}</div>`
      : '';

    const tags = allPostTags();
    /* ★ v4.15.0 需求 6：搜索框下面这排标签**同时承担发帖时的选标签**——
       原来发帖面板里另有一排「点选已有标签」（pickChips），两排长得一样、
       位置却隔了半屏，用户要来回找。现在只有一排：
         · 发帖面板收起时：点标签 = 筛选动态（原行为）；
         · 发帖面板展开时：点标签 = 加进这次发布（点第二次取消）；
       标签栏左侧的说明文字随之切换，点下去会发生什么不用猜。 */
    const composing = state.composeOpen;
    const composeTagList = composing
      ? String(state.compose.tags || '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
      : [];
    const tagChips = tags.length
      ? `<div class="tag-filter${composing ? ' composing' : ''}">` +
        `<span class="tf-label">${composing ? '点标签加入这次发布' : '标签'}</span>` +
        (composing ? '' : `<button type="button" class="chip${state.postTag === '' ? ' on' : ''}" data-act="post-tag" data-tag="">全部</button>`) +
        tags.map((t) => {
          const on = composing ? composeTagList.includes(t) : state.postTag === t;
          return `<button type="button" class="chip${on ? ' on' : ''}" data-act="post-tag" data-tag="${esc(t)}">#${esc(t)}</button>`;
        }).join('') +
        `</div>`
      : '';
    const q = state.postQuery.trim().toLowerCase();
    const all = state.posts;
    const list = all
      .filter((p) => !state.postTag || p.tags.includes(state.postTag))
      .filter((p) => {
        if (!q) return true;
        // 搜索范围：正文 / 标签 / 发布人 / 评论内容 / 共创内容 —— 家人常是按「谁发的」或
        // 「共创里提过的一句话」来找东西的
        const hay = [p.content, p.tags.join(' '), p.ownerName,
          p.comments.map((c) => c.content).join(' '),
          (p.contributions || []).map((c) => c.content).join(' ')].join(' ').toLowerCase();
        return hay.includes(q);
      });

    const feed = list
      .map((p) => {
      const imgsHtml = p.images.length
        ? `<div class="post-imgs n${Math.min(p.images.length, 9)}" data-gal="${esc(JSON.stringify(p.images))}">${p.images
            .map((src) => `<img src="${esc(assetUrl(src))}" loading="lazy" alt="" data-act="img-view" data-src="${esc(src)}" title="点击放大">`).join('')}</div>`
        : '';
      // v1.9.0：视频播放器（一条动态最多 3 段，服务端也会再校验一次）
      const vidsHtml = videoPlayerHtml(p.videos, p.videoCovers);
      const tagsHtml = p.tags.length
        ? `<div class="post-tags">${p.tags.map((t) => `<span class="badge">#${esc(t)}</span>`).join('')}</div>`
        : '';
      /* 评论 / 点赞 / 共创三块统一走共用函数（见上方 commentItemHtml 等）：
         日历视图也要用同一份，绝不能再各写一遍 —— v4.6.0 需求 1 就是补这个洞。 */
      // 仅自己可见的动态不显示「一起写」入口（服务端也会拒）
      const canContrib = p.visibility === 'family' || p.mine;

      return `
        <div class="card post">
          <div class="post-head">
            ${avatarHtml(p.ownerName)}
            <div class="post-who">
              <b>${esc(p.ownerName)}</b>${p.visibility === 'private' ? ` <span class="badge priv">${visBadgeText(p)}</span>` : ''}
              <div class="when">发布于 ${esc(fmtTime(p.publishedAt || p.createdAt))}</div>
            </div>
            <!-- v4.23.0 需求 3：原来这里常驻「一起写 / 编辑 / 删除」三个按钮，
                 现在统一收进下方右下角的「⋯」菜单，头部只留作者与时间。 -->
          </div>
          ${p.content ? `<div class="post-content">${esc(p.content)}</div>` : ''}
          ${imgsHtml}
          ${vidsHtml}
          ${tagsHtml}
          ${contribsHtml(p)}
          ${likeRowHtml(p)}
          ${commentsBlockHtml(p)}
          ${postFootHtml(p, canContrib)}
        </div>`;
    }).join('');

    /* v2.0.0 需求 4：把「发帖 / 视图切换 / 搜索」三块合成一张工具卡。
       旧版是三个独立卡片竖着排（发帖卡 → 切换条 → 搜索卡），占了小半屏，
       而且「发帖」这个最高频的动作被埋在工具区上方、和搜索毫无关联。
       现在：一行放「动态流 / 按日历看」+ 右侧「✍️ 发帖」按钮（发帖面板默认收起），
       第二行放搜索框与标签筛选 —— 一眼就能看出这一页能干什么。 */
    /* ★ 一律走 String(x || '')：草稿对象是会被替换的，少一个字段就整页白屏，
       宁可显示成空也不要把渲染搞崩（渲染函数里不该出现「读某个字段必定存在」的假设）。 */
    const draftText = String(state.compose.text || '');
    const draftTags = String(state.compose.tags || '');
    const draftCount = state.compose.images.length + state.compose.videos.length
      + (draftText.trim() ? 1 : 0) + (draftTags.trim() ? 1 : 0);
    /* ★ 面板开合**只**听 state.composeOpen 一个人的。
       不要写成「有草稿就强制展开」——那样草稿在的时候按钮会显示「收起」却收不起来，
       用户会以为界面坏了。草稿本来就不会丢（存在 state 里），收起是完全安全的操作。 */
    const composerOpen = state.composeOpen;

    const toolsCard = `
      <div class="card feed-tools post-tools">
        <div class="pt-row">
          <div class="segmented seg-mini" data-act="post-view">
            <button type="button" data-view="feed" class="${state.postView === 'feed' ? 'on' : ''}">动态流</button>
            <button type="button" data-view="calendar" class="${state.postView === 'calendar' ? 'on' : ''}">按日历看</button>
          </div>
          <button type="button" class="btn-${composerOpen ? 'ghost' : 'primary'} btn-sm pt-compose-btn" data-act="post-compose">
            ${composerOpen ? '收起' : '✍️ 发帖'}${!composerOpen && draftCount ? ` <span class="pt-draft">${draftCount}</span>` : ''}
          </button>
        </div>
        ${state.postView === 'feed' ? `
          <div class="pt-row">
            ${searchBarHtml({
              act: 'post-query', clearAct: 'post-q-clear', preserve: 'post-q', id: 'post-q',
              placeholder: '搜索动态：内容 / 标签 / 发布人 / 评论 / 一起写…', value: state.postQuery, grow: false,
            })}
          </div>
          ${tagChips}
          ${state.postQuery.trim() || state.postTag
            ? `<div class="search-hint">找到 ${list.length} 条动态${state.postTag ? `（标签 #${esc(state.postTag)}）` : ''}${
              all.length > list.length ? ` · 共 ${all.length} 条` : ''}</div>`
            : ''}`
          /* 发帖面板展开、但当前是「按日历看」时，标签栏也要在（否则发帖没法选标签） */
          : (composerOpen ? tagChips : '')}
      </div>`;

    const composer = composerOpen ? `
      <div class="card composer">
        ${state.draftNotice === 'post' ? `<div class="draft-bar">
          <span class="grow">📝 已恢复上次未发布的内容</span>
          <button type="button" class="drop" data-act="draft-drop">丢弃草稿</button>
        </div>` : ''}
        <textarea placeholder="记录此刻的生活…" rows="2" data-autogrow data-max-h="360"
                  data-preserve="compose-text" data-act="compose-text">${esc(draftText)}</textarea>
        ${imgs.length ? `<div class="composer-imgs" data-gal="${esc(JSON.stringify(composePaths))}">${imgs}</div>` : ''}
        ${vids}
        ${state.composeEmoji ? `<div class="emoji-panel" id="compose-emoji">
          ${COMPOSE_EMOJIS.map((e) =>
            `<button type="button" class="emoji-pick" data-act="compose-emoji-pick" data-emoji="${e}">${e}</button>`).join('')}
        </div>` : ''}
        <!-- v4.28.2：可见范围（默认全家可见）。选「指定可见成员」后展开成员勾选，
             默认一个都不勾 = 仅自己可见；没勾的人看不到这条动态、也收不到通知。 -->
        <div class="compose-vis">
          <button type="button" class="btn-ghost btn-sm${state.compose.visibility === 'private' ? '' : ' on'}"
                  data-act="compose-vis" data-vis="family">👨‍👩‍👧 全家可见</button>
          <button type="button" class="btn-ghost btn-sm${state.compose.visibility === 'private' ? ' on' : ''}"
                  data-act="compose-vis" data-vis="private">🔒 指定可见成员</button>
        </div>
        ${state.compose.visibility === 'private' ? `<div class="vis-members">
          <div class="vis-members-hint">默认只有你自己可见；勾选要一起看的家人：</div>
          <div class="chips">${visOthers().length
            ? visOthers().map((m) => `<button type="button" class="chip vis-chip${
              (state.compose.visibleTo || []).map(Number).includes(Number(m.id)) ? ' on' : ''}"
                data-act="compose-vis-member" data-vis-id="${Number(m.id)}">${esc(m.display_name)}</button>`).join('')
            : '<span class="field-hint">家里还没有其他成员</span>'}</div>
        </div>` : ''}
        <div class="composer-bar">
          <div class="composer-ops-left">
            <button type="button" class="btn-ghost btn-sm" data-act="compose-pick">＋ 图片</button>
            <button type="button" class="btn-ghost btn-sm" data-act="compose-vpick">＋ 视频</button>
            <button type="button" class="btn-ghost btn-sm${state.composeEmoji ? ' on' : ''}" data-act="compose-emoji">😊 表情</button>
          </div>
          <div class="composer-ops-right">
            <span class="draft-hint${draftHintText('post') ? '' : ' hidden'}${((state.draftState || {}).post || {}).pending ? ' saving' : ''}" id="post-draft-hint">${esc(draftHintText('post'))}</span>
            <button type="button" class="btn-ghost btn-sm" data-act="draft-save">💾 存草稿</button>
            <button type="button" class="btn-primary btn-sm" data-act="compose-publish">发布</button>
          </div>
        </div>
        <input type="text" class="composer-tags" maxlength="80" placeholder="添加标签（用空格分隔，如：出游 美食）"
               data-preserve="compose-tags" data-act="compose-tags" value="${esc(draftTags)}">
        <input type="file" accept="image/*" multiple class="hidden" id="compose-file">
        <input type="file" accept="video/*" multiple class="hidden" id="compose-video-file">
      </div>` : '';

    if (state.postView === 'calendar') {
      return toolsCard + composer + postCalendarHtml();
    }

    return toolsCard + composer +
      `${feed || `<div class="card empty"><span class="em">${q ? '🔍' : '🖼️'}</span>${
        q ? `没有匹配「${esc(state.postQuery.trim())}」的动态` : '还没有动态，发布第一条吧'}</div>`}`;
  }

  /* ── 动态日历（v1.9.0，需求 10）──────────────────────────
     按日历看动态：每一格是一天，格子上显示当天发了几条（条数徽标）。
     点某天 → 下面列出那天的动态，图片可点开大图、视频可直接播放。

     日期归属按**浏览器本地时区**算（与上面「3 小时前」这类时间显示同一套口径）：
     服务端存的是 UTC，若直接取 ISO 前 10 位，晚上发的动态会被算到前一天去。 */

  function postsByDate() {
    const map = new Map();
    state.posts.forEach((p) => {
      const k = dateKey(new Date(p.publishedAt || p.createdAt));
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(p);
    });
    return map;
  }

  /**
   * v4.5.0 需求 4：日历里「那天写的共创」。
   *
   * 为什么要单独归一次日：共创有自己的创建时间，可能和原帖不是同一天
   * （前天发帖、昨天补充）。旧版日历只按**原帖**的 createdAt 分组，
   * 于是昨天那一格看起来「什么都没有」，共创内容在日历视图里彻底消失。
   *
   * ★ 只收「与原帖不同天」的共创：同一天的那条在原帖卡片里已经看得到，
   *   再列一遍就是重复内容。跨天的这条会标注「补充了 X 的动态」，
   *   既能在日历上被发现，也不会让人误以为是一篇新动态。
   */
  function contribExtrasByDate() {
    const map = new Map();
    state.posts.forEach((p) => {
      const postKey = dateKey(new Date(p.publishedAt || p.createdAt));
      for (const c of (p.contributions || [])) {
        const ck = dateKey(new Date(c.createdAt));
        if (!ck || ck === postKey) continue;
        if (!map.has(ck)) map.set(ck, []);
        map.get(ck).push({ post: p, contrib: c, postKey });
      }
    });
    return map;
  }

  function postCalendarHtml() {
    const { y, m } = state.postCalCursor;
    const byDate = postsByDate();
    // v4.5.0 需求 4：徽标也要把「那天补充的共创」算进去，否则日历上依然看不见它
    const extrasByDate = contribExtrasByDate();
    const first = new Date(y, m, 1);
    const startOffset = first.getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const sel = state.postCalDay || todayKey();
    let monthTotal = 0;
    const cells = [];

    for (let i = 0; i < 42; i++) {
      const dayNum = i - startOffset + 1;
      const d = new Date(y, m, dayNum);
      const key = dateKey(d);
      const other = dayNum < 1 || dayNum > daysInMonth;
      const nPost = (byDate.get(key) || []).length;
      const nExtra = (extrasByDate.get(key) || []).length;
      const n = nPost + nExtra;
      if (!other) monthTotal += n;
      const label = Lunar.dayLabel(d.getFullYear(), d.getMonth() + 1, d.getDate());
      cells.push(
        `<button type="button" class="cal-cell pcal${other ? ' other' : ''}${key === todayKey() ? ' today' : ''}${key === sel ? ' selected' : ''}" data-act="post-pick-date" data-date="${key}">` +
        `<span class="d-num">${d.getDate()}</span>` +
        `<span class="d-sub">${esc(label)}</span>` +
        (n ? `<span class="pcount" title="当天 ${nPost} 条动态${nExtra ? `、${nExtra} 条共创` : ''}">${n}</span>` : '') +
        '</button>',
      );
    }

    const headLunar = Lunar.solar2lunar(y, m + 1, 15);
    return `
      <div class="card">
        <div class="cal-head">
          <div class="cal-title">
            <button type="button" class="cal-jump" data-act="post-cal-jump" title="点击跳转到指定年月日">${y}年${m + 1}月</button>
            <span>${headLunar ? `${headLunar.ganzhi}年 · ${headLunar.zodiac}年` : ''}${monthTotal ? ` · 本月 ${monthTotal} 条` : ''}</span>
          </div>
          <div class="cal-nav">
            <button type="button" class="icon-btn" data-act="post-cal-prev" title="上个月">‹</button>
            <button type="button" class="btn-ghost btn-sm" data-act="post-cal-today">今天</button>
            <button type="button" class="icon-btn" data-act="post-cal-next" title="下个月">›</button>
          </div>
        </div>
        <div class="cal-week">${WEEK_CN.map((w, i) => `<span class="${i === 0 ? 'wk' : ''}">${w}</span>`).join('')}</div>
        <div class="cal-grid" data-cal="post">${cells.join('')}</div>
        <div class="cal-tip">左右滑动可切换月份 · 数字是当天动态条数</div>
      </div>
      ${postDayListHtml()}`;
  }

  function postDayListHtml() {
    const key = state.postCalDay || todayKey();
    const list = postsByDate().get(key) || [];
    // v4.5.0 需求 4：这一天别人补充的共创（原帖不是这天发的）
    const extras = contribExtrasByDate().get(key) || [];
    const [y, m, d] = key.split('-').map(Number);
    const lunar = Lunar.solar2lunar(y, m, d);
    /* v4.6.0 需求 1：日历里的当天动态必须和动态流**是同一份内容**。
       旧版这里只画了正文 / 图片 / 视频，共创、评论、点赞全被漏掉 ——
       按日期回看时会误以为「那天没人评论、也没人一起写」。
       现在共用 contribsHtml / likeRowHtml / commentsBlockHtml，连评论框都一起带过来，
       于是日历里也能直接点赞、回复、插表情，不用切回动态流。 */
    return `
      <div class="card day-panel">
        <div class="day-panel-head">
          <div class="day-date">
            <b>${humanDate(key)} 星期${WEEK_CN[new Date(y, m - 1, d).getDay()]}</b>
            <span class="lunar">${lunar ? `${lunar.monthName}${lunar.dayName}` : ''}</span>
            <span class="badge date">${list.length} 条动态${extras.length ? ` · ${extras.length} 条共创` : ''}</span>
          </div>
        </div>
        ${list.length
          ? list.map((p) => `
            <div class="cal-post">
              <div class="cal-post-head">${avatarHtml(p.ownerName)}<b>${esc(p.ownerName)}</b>${p.visibility === 'private' ? ` <span class="badge priv">${visBadgeText(p)}</span>` : ''}<span class="c-time">${esc(fmtTime(p.publishedAt || p.createdAt))}</span></div>
              ${p.content ? `<div class="post-content">${esc(p.content)}</div>` : ''}
              ${p.images.length
                ? `<div class="post-imgs n${Math.min(p.images.length, 9)}" data-gal="${esc(JSON.stringify(p.images))}">${p.images
                    .map((src) => `<img src="${esc(assetUrl(src))}" loading="lazy" alt="" data-act="img-view" data-src="${esc(src)}">`).join('')}</div>`
                : ''}
              ${videoPlayerHtml(p.videos, p.videoCovers)}
              ${p.tags.length ? `<div class="post-tags">${p.tags.map((t) => `<span class="badge">#${esc(t)}</span>`).join('')}</div>` : ''}
              ${contribsHtml(p)}
              ${likeRowHtml(p)}
              ${commentsBlockHtml(p)}
              ${postFootHtml(p, p.visibility === 'family' || p.mine)}
            </div>`).join('')
          : (extras.length ? '' : '<div class="empty" style="padding:16px"><span class="em">🖼️</span>这一天还没有动态</div>')}
        ${extras.length ? `
          <div class="cal-contribs">
            ${extras.map(({ post, contrib, postKey }) => `
              <div class="cal-post cal-contrib">
                <div class="cal-post-head">${avatarHtml(contrib.ownerName)}<b>${esc(contrib.ownerName)}</b>
                  <span class="c-time">一起写 · ${esc(fmtTime(contrib.createdAt))}</span></div>
                <div class="contrib-ref">✍️ 补充了 <b>${esc(post.ownerName)}</b> ${esc(humanDate(postKey))} 的动态${
                  post.content ? `「${esc(post.content.slice(0, 20))}${post.content.length > 20 ? '…' : ''}」` : ''}</div>
                ${contrib.content ? `<div class="post-content">${esc(contrib.content)}</div>` : ''}
                ${(contrib.images || []).length
                  ? `<div class="post-imgs n${Math.min(contrib.images.length, 9)}" data-gal="${esc(JSON.stringify(contrib.images))}">${contrib.images
                      .map((src) => `<img src="${esc(assetUrl(src))}" loading="lazy" alt="" data-act="img-view" data-src="${esc(src)}">`).join('')}</div>`
                  : ''}
                ${videoPlayerHtml(contrib.videos || [], contrib.videoCovers)}
              </div>`).join('')}
          </div>` : ''}
      </div>`;
  }

  /* ═══ 记录本 ═════════════════════════════════════════════ */

  function filteredRecords() {
    const q = state.recQuery.trim().toLowerCase();
    return state.records.filter((r) => {
      if (state.recCategory !== '全部' && r.category !== state.recCategory) return false;
      if (q) {
        // 标签功能已移除（v1.5.0）；搜索覆盖标题 / 正文 / 分类 / 附件名 ——
        // 「体检报告.pdf」这种按文件名找比按标签找更顺手
        const hay = [r.title, r.content, r.category,
          (r.attachments || []).map((a) => a.name).join(' ')].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function recordsHtml() {
    if (recordsLocked()) {
      return `
        <div class="card card-pad lock-card">
          <div class="lock-icon">🔒</div>
          <div class="lock-title">记录本已上锁</div>
          <div class="lock-hint">这里保存着重要信息，输入访问密码后查看<br>（自定义访问密码或登录密码均可）</div>
          <input type="password" id="lock-pass" maxlength="64" placeholder="访问密码 / 登录密码" autocomplete="off">
          <button type="button" class="btn-primary" data-act="records-unlock">解锁</button>
        </div>`;
    }
    const list = filteredRecords();
    /* 分类可自定义：预设 + 历史用过的分类，末尾再给一个「＋」让用户输入新分类。
       v1.6.0：分类条支持【长按删除】（手机上长按、电脑上右键）：点一下是筛选，
       长按则把该分类下的记录移到「通用」并把这个分类删掉。
       ★ v2.0.0 需求 5：去掉分类名右侧那个「×」。
         它和「点一下 = 筛选」直接冲突 —— 手指稍微偏一点就变成删分类，
         而且看着像「这个分类可以有多个 / 能勾选」，误导性大于便利性。
         删除入口只剩长按（手机）/ 右键（桌面），下面那行提示写清楚了。 */
    const cats = ['全部'].concat(recordCategories()).map((c) => {
      const deletable = c !== '全部' && c !== '通用';
      return `<button type="button" class="chip${state.recCategory === c ? ' on' : ''}${deletable ? ' chip-del' : ''}"
          data-act="rec-cat" data-cat="${esc(c)}"${deletable ? ' data-longpress="rec-cat"' : ''}
          title="${deletable ? '点按筛选 · 长按删除该分类' : '点按筛选'}">${esc(c)}</button>`;
    }).join('');

    return `
      <div class="card card-pad">
        <div class="list-tools">
          ${searchBarHtml({
            act: 'rec-query', clearAct: 'rec-q-clear', preserve: 'rec-q',
            placeholder: '搜索标题 / 正文 / 附件名…', value: state.recQuery,
          })}
          <button type="button" class="btn-primary btn-sm" data-act="rec-new">＋ 新建记录</button>
        </div>
        <div class="chips cats-row">${cats}</div>
        <div class="cats-hint">提示：长按分类可删除（该分类下的记录会移到「通用」）· 长按记录卡片可归档</div>
        <div class="segmented seg-wrap arch-switch" data-act="rec-arch-view">
          <button type="button" data-arch="0" class="${state.recShowArchived ? '' : 'on'}">当前记录</button>
          <button type="button" data-arch="1" class="${state.recShowArchived ? 'on' : ''}">已归档</button>
        </div>
      </div>
      ${list.length ? list.map(recordHtml).join('')
        : `<div class="card empty"><span class="em">${state.recShowArchived ? '🗄️' : '📌'}</span>${
            state.recShowArchived ? '还没有归档的记录（长按记录卡片即可归档）' : '还没有记录，把重要的信息存进来吧'}</div>`}`;
  }

  /** 记录正文渲染：☐ / ☑ 开头的行渲染为待办样式勾选框，可点击切换；其余按普通文本行 */
  /**
   * 记录正文（把 `☐ xxx` / `☑ xxx` 行渲染成勾选样式）。
   * @param {object} r
   * @param {{readOnly?:boolean}} [opts]
   *   v4.3.1 需求 2：**列表页传 readOnly** —— 列表卡片本身是「点进查看页」的大按钮，
   *   里面再放可点的勾选框，滑动时很容易误触把事项勾掉/取消。列表里只做展示，
   *   勾选动作统一放到查看页 / 编辑页去做（那里才是「正在操作这一条」的上下文）。
   */
  /* ═══ 记录本正文编辑（v4.16.0 需求 5 引入，需求 4 收敛为三种能力）══════════

     需求：记录本输入框支持结构化内容。做法上有一个关键取舍 —— **不存 HTML，存 Markdown 子集**：

     ① 安全：记录本是全家共享的。存 HTML 就意味着渲染时要把它塞回 innerHTML，
        任何一个人（或任何一段被粘贴进来的内容）都能写入 `<img onerror=…>`；
        CSP 只禁脚本，禁不掉所有手法。存 Markdown 则是**先转义、再上样式**，
        用户输入里的 `<` 永远只是 `<`。
     ② 兼容：records.content 仍是纯文本 —— 搜索、导出、行模型（content_json）、
        老客户端全都照旧可用；勾选框那套 `☐ / ☑` 行约定也一个字没改。
     ③ 可读：直接看数据库也知道写的是什么，不用在 HTML 里翻。

     支持的标记（工具栏一一对应，v4.16.0 需求 4 定稿，只此三种）：
       ![图](/api/media/…)   图片 —— 文件存在服务器磁盘，正文里只存**引用路径**
       行首 ☐ / ☑            勾选框（原有语义）
       行首 `1. `            序号列表（编辑区里是 <ol>/<li>）
     加粗 / 斜体 / 下划线 / 删除线 / 高亮 / 代码 / 无序列表已全部下线：
     渲染只做纯文本转义，正文是什么就显示什么。 */
  const REC_IMG_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

  /* v4.17.0 需求 3：图片条目允许两种形态 ——
     老记录 / 老草稿是纯路径字符串，新记录是 {src, note}（备注显示在图下方）。
     读侧统一走这两个助手，两种形态都认，老数据零迁移。 */
  const recImgSrc = (im) => (im && typeof im === 'object' ? String(im.src || '') : String(im || ''));
  const recImgNote = (im) => (im && typeof im === 'object' ? String(im.note || '').trim() : '');

  /** 正文（Markdown 子集）里的站内图片路径列表 —— 列表页拿它做「正文图片」缩略图 */
  function recContentImgs(md) {
    const s = String(md == null ? '' : md);
    const out = [];
    const re = new RegExp(REC_IMG_RE.source, 'g');
    let m;
    while ((m = re.exec(s))) {
      if (/^\/api\//.test(m[2])) out.push(m[2]);
    }
    return out;
  }

  /** 一段正文 → HTML：先整体转义防 XSS，再还原图片；其余标记一律原样显示。
      v4.17.0 需求 2：渲染出的正文图片带 img-view 动作（详情页点击全屏放大）；
      opts.noImg = 列表页口径，图片不内联渲染（由缩略图列展示），避免被裁成半截。 */
  function recMdInline(raw, opts) {
    const s = esc(String(raw == null ? '' : raw));
    return s.replace(REC_IMG_RE, (m, alt, src) => {
      /* 只认站内 /api/ 路径，防止 javascript: / data: 之类的伪协议混进 <img src> */
      if (!/^\/api\//.test(src)) return alt || '';
      if (opts && opts.noImg) return '';
      return `<img class="rec-img" src="${src}" alt="${alt || '图片'}" loading="lazy" `
        + `data-act="img-view" data-src="${src}" title="点击放大">`;
    });
  }

  /** 一行正文 → HTML（序号行渲染成「1. 内容」，仍留在同一个 pre-wrap 块里） */
  function recLineHtml(line, opts) {
    const s = String(line == null ? '' : line);
    const ol = /^(\d{1,2})[.)]\s+(.*)$/.exec(s);
    if (ol) return `<span class="rec-li">${ol[1]}.</span> ${recMdInline(ol[2], opts)}`;
    return recMdInline(s, opts);
  }

  /** Markdown 子集 → 编辑器里的 HTML（序号列表还原成 <ol>，其余每行一个 div） */
  function recMdToEditorHtml(md) {
    const lines = String(md == null ? '' : md).split('\n');
    const out = [];
    let inOl = false;
    const closeOl = () => { if (inOl) { out.push('</ol>'); inOl = false; } };
    for (const line of lines) {
      const ol = /^(\d{1,2})[.)]\s+(.*)$/.exec(line);
      if (ol) {
        if (!inOl) { out.push('<ol>'); inOl = true; }
        out.push(`<li>${recMdInline(ol[2]) || '&nbsp;'}</li>`);
        continue;
      }
      closeOl();
      const html = recMdInline(line);
      out.push(`<div>${html || '<br>'}</div>`);
    }
    closeOl();
    return out.join('');
  }

  /**
   * 编辑器 HTML → Markdown 子集。
   * 浏览器敲回车会生成 <div>；图片是 <img>（还原成 `![图](路径)`），
   * 序号列表是 <ol>/<li>（还原成 `1. `）。粘贴内容统一按纯文本插入
   * （见 openRecordForm 的 paste 处理），所以这里不必应付任意脏标签；
   * 真遇到未知标签也只是把文字提出来，不会变成 HTML。
   */
  function recEditorToMd(root) {
    if (!root) return '';
    const imgMd = (n) => {
      const src = String(n.getAttribute('src') || '').trim();
      return /^\/api\//.test(src) ? `![图](${src})` : '';
    };
    const inlineOf = (el) => {
      const parts = [];
      const walk = (node) => {
        for (const n of Array.from(node.childNodes || [])) {
          if (n.nodeType === 3) {
            const t = String(n.nodeValue || '').replace(/\u00a0/g, ' ');
            if (t) parts.push(t);
            continue;
          }
          if (n.nodeType !== 1) continue;
          const tag = String(n.tagName || '').toUpperCase();
          if (tag === 'BR') { parts.push('\n'); continue; }
          if (tag === 'IMG') { parts.push(imgMd(n)); continue; }
          walk(n);
        }
      };
      walk(el);
      return parts.join('');
    };
    const lines = [];
    const walkBlocks = (parent) => {
      for (const n of Array.from(parent.childNodes || [])) {
        if (n.nodeType === 3) {
          const t = String(n.nodeValue || '').replace(/\u00a0/g, ' ');
          if (t.trim()) lines.push(t.replace(/\s+$/, ''));
          continue;
        }
        if (n.nodeType !== 1) continue;
        const tag = String(n.tagName || '').toUpperCase();
        if (tag === 'OL') {
          let i = 0;
          for (const li of Array.from(n.children || [])) {
            if (String(li.tagName).toUpperCase() !== 'LI') continue;
            i++;
            const body = inlineOf(li).replace(/\n/g, ' ').trim();
            lines.push(`${i}. ${body}`);
          }
          continue;
        }
        /* 老版本产生过 <ul>：条目按普通行摊平（不留 `- ` 标记，反正也不渲染了） */
        if (tag === 'UL') {
          for (const li of Array.from(n.children || [])) {
            if (String(li.tagName).toUpperCase() !== 'LI') continue;
            const body = inlineOf(li).replace(/\n/g, ' ').trim();
            if (body) lines.push(body);
          }
          continue;
        }
        if (tag === 'IMG') {
          const md = imgMd(n);
          if (md) lines.push(md);
          continue;
        }
        if (tag === 'DIV' || tag === 'P') {
          // 粘贴/浏览器嵌套产生的多层 div 摊平成多行
          if (n.querySelector && n.querySelector('div,p,ul,ol,li')) { walkBlocks(n); continue; }
          lines.push(inlineOf(n).replace(/\n+$/, ''));
          continue;
        }
        if (tag === 'BR') { lines.push(''); continue; }
        lines.push(inlineOf(n).replace(/\n+$/, ''));
      }
    };
    walkBlocks(root);
    while (lines.length && !String(lines[lines.length - 1]).trim()) lines.pop();
    return lines.join('\n');
  }

  /** 把编辑器内容同步回隐藏的 textarea（textarea 是**唯一取值口径**：保存 / 草稿 / 测试都在读它） */
  function recSyncContent() {
    const layer = $('#modal-layer');
    if (!layer) return '';
    const ed = layer.querySelector('#rec-editor');
    const ta = layer.querySelector('[data-mk="content"]');
    if (!ed || !ta) return ta ? ta.value : '';
    ta.value = recEditorToMd(ed);
    return ta.value;
  }

  function recContentHtml(r, opts) {
    if (!r.content) return '';
    const live = !(opts && opts.readOnly);
    const noImg = !!(opts && opts.noImg);
    const lines = String(r.content).split('\n');
    const out = [];
    let textBuf = [];
    const flushText = () => {
      if (textBuf.length) {
        // v4.16.0 需求 5：逐行渲染 Markdown 子集（加粗 / 斜体 / 列表…），
        // 行与行之间仍用换行符 —— .rec-text 是 pre-wrap，不需要额外 <br>
        out.push(`<div class="rec-text">${textBuf.map((l) => recLineHtml(l, { noImg })).join('\n')}</div>`);
        textBuf = [];
      }
    };
    lines.forEach((line, i) => {
      const m = /^([☐☑]) (.*)$/.exec(line);
      if (m) {
        flushText();
        const done = m[1] === '☑';
        const attr = live
          ? ` data-act="rec-check-item" data-id="${r.id}" data-line="${i}" title="点击切换完成状态"`
          : ' title="点开这条记录后可以勾选（列表里不能勾，避免误触）"';
        out.push(
          `<div class="rec-check${done ? ' done' : ''}${live ? '' : ' ro'}"${attr}>` +
          `<span class="tick">✓</span><span class="rc-text">${recMdInline(m[2], { noImg })}</span></div>`,
        );
      } else {
        textBuf.push(line);
      }
    });
    flushText();
    return out.length ? `<div class="rec-body">${out.join('')}</div>` : '';
  }

  /**
   * 记录卡片：列表里所有条目高度一致（不因文字多少被拉长）。
   * v4.17.0 需求 2：正文里的内联图片不再塞进裁切区（之前会被裁成半截），
   * 改成**左侧「正文图片」缩略图（最多 2 张）、右侧「图片附件」缩略图（最多 2 张）**，
   * 溢出的张数用「+N」提示；各自成一组，点开灯箱可整组翻看。
   */
  function recordHtml(r) {
    const imgs = (r.images || []).map(recImgSrc);
    const atts = r.attachments || [];
    const bodyImgs = recContentImgs(r.content);
    /** 一组缩略图：最多 2 张 + 「+N」。空组返回空串（不占位）。 */
    const thumbGroup = (list, label, cls) => {
      if (!list.length) return '';
      const shown = list.slice(0, 2);
      return `<div class="rec-thumbs ${cls || ''}" data-gal="${esc(JSON.stringify(list))}" title="${esc(label)}">`
        + shown.map((src) =>
          `<img src="${esc(assetUrl(src))}" loading="lazy" alt="" data-act="img-view" data-src="${esc(src)}" title="点击放大">`).join('')
        + (list.length > 2 ? `<span class="rec-thumb-more">+${list.length - 2}</span>` : '')
        + '</div>';
    };
    const thumbsCols = (bodyImgs.length || imgs.length)
      ? `<div class="rec-thumbs-cols">${thumbGroup(bodyImgs, '正文图片')}${thumbGroup(imgs, '图片附件', 'rec-thumbs-att')}</div>`
      : '';
    // 列表正文不再内联渲染图片（noImg），只留文字与勾选行
    const body = recContentHtml(r, { readOnly: true, noImg: true });
    return `
      <div class="card rec${r.archived ? ' archived' : ''}" data-act="rec-open" data-id="${r.id}"
           data-longpress="rec-archive" title="点击查看 · 长按归档">
        <div class="rec-head">
          ${r.pinned ? '<span class="pin" title="已置顶">★</span>' : ''}
          <div class="rec-title">${esc(r.title)}</div>
          ${r.archived ? '<span class="badge arch">🗄️ 已归档</span>' : ''}
        </div>
        <div class="rec-main">
          <div class="rec-clip">${body || '<div class="rec-body rec-empty">（无正文）</div>'}</div>
          ${thumbsCols}
        </div>
        <div class="rec-foot">
          <span class="badge cat">${esc(r.category)}</span>
          ${atts.length ? `<span class="badge att-badge" title="${esc(atts.map((a) => a.name).join('、'))}">📎 ${atts.length} 个附件</span>` : ''}
          ${r.visibility === 'private' ? `<span class="badge priv">${visBadgeText(r)}</span>` : ''}
          ${r.remind ? `<span class="badge rec-remind" title="到 ${esc(r.remindTime || '跟随系统')} 提醒我${r.remindedAt ? '（已提醒过）' : ''}">🔔 ${r.remindedAt ? '已提醒' : '待提醒'}</span>` : ''}
          <span>${esc(r.ownerName)} · ${esc(fmtTime(r.updatedAt))}</span>
        </div>
      </div>`;
  }

  /* ── 记录本：只读查看页 ─────────────────────────────────
     点条目先看，改内容要点「编辑」——避免在列表上一点就进编辑态，
     手滑改了家里的重要信息还不知道。正文里的勾选项保持可点（那是既有能力）。 */

  let recViewId = null;          // 当前查看中的记录 id（null = 没有查看页）

  function recViewBodyHtml(r) {
    const imgs = r.images || [];
    const atts = r.attachments || [];
    const badges = [
      `<span class="badge cat">${esc(r.category)}</span>`,
      r.pinned ? '<span class="badge p-high">★ 置顶</span>' : '',
      r.visibility === 'private' ? `<span class="badge priv">${visBadgeText(r)}</span>` : '',
    ].filter(Boolean).join('');
    /* v4.17.0 需求 2/3：整页可看的图（正文内联 + 图片附件）合成**一个灯箱图组**，
       挂在 .rec-view 根上 —— 正文图、附件图点开都能左右翻到彼此；
       图片附件的备注（recImgNote）显示在对应图下方。 */
    const gal = recContentImgs(r.content).concat(imgs.map(recImgSrc));
    const imgsHtml = imgs.length
      ? `<div class="rec-view-imgs">` + imgs.map((im) => {
          const src = recImgSrc(im);
          const note = recImgNote(im);
          return `<figure class="rec-view-fig">`
            + `<img src="${esc(assetUrl(src))}" loading="lazy" alt="${esc(note || '图片')}" data-act="img-view" data-src="${esc(src)}" title="点击放大">`
            + (note ? `<figcaption>${esc(note)}</figcaption>` : '')
            + `</figure>`;
        }).join('') + '</div>'
      : '';
    return `
      <div class="rec-view" data-rec-id="${r.id}" data-gal="${esc(JSON.stringify(gal))}">
        <div class="rec-view-meta">${badges}</div>
        ${recContentHtml(r) || '<div class="rec-body rec-empty">（无正文）</div>'}
        ${imgsHtml}
        ${atts.length ? `<div class="rec-view-atts"><div class="rva-title">附件（点一下下载）</div>${attachListHtml(atts)}</div>` : ''}
        <div class="rec-view-foot">${esc(r.ownerName)} · 更新于 ${esc(fmtTime(r.updatedAt))}</div>
      </div>`;
  }

  function openRecordView(recId) {
    const r = state.records.find((x) => x.id === recId);
    if (!r) return;
    openModal({
      title: r.title || '记录',
      body: `<div class="rec-view-holder">${recViewBodyHtml(r)}</div>`,
      foot: `
        <button type="button" class="btn-ghost" data-act="modal-close">关闭</button>
        <div class="spacer"></div>
        <button type="button" class="btn-primary" data-act="rec-edit" data-id="${r.id}">编辑</button>`,
    });
    recViewId = r.id;            // 必须放在 openModal 之后：它内部会先 closeModal 把这里清空
  }

  /** 查看页里的勾选项被点后，重新渲染查看页正文（数据已由服务端确认） */
  function recRefreshView() {
    if (recViewId == null) return;
    const holder = $('#modal-layer .rec-view-holder');
    const r = state.records.find((x) => x.id === recViewId);
    if (holder && r) holder.innerHTML = recViewBodyHtml(r);
  }

  /**
   * 长按删除分类（v1.6.0）。
   * 分类不是独立的一张表，它只是记录上的一个取值，所以「删除分类」= 把该分类下的
   * 记录改到「通用」+ 把分类名记进隐藏名单；**记录本身不会被删除**，这一点必须让用户知道。
   */
  async function deleteRecordCategory(cat) {
    const name = String(cat || '').trim();
    if (!name || name === '全部') return;
    if (name === '通用') { toast('「通用」是默认分类，不能删除', 'err'); return; }
    if (!window.confirm(`删除分类「${name}」？\n\n该分类下的记录会移到「通用」，记录本身不会被删除。`)) return;
    try {
      const out = await api('/api/records/category/delete', { method: 'POST', body: { name } });
      if (Array.isArray(out.hiddenCategories)) state.recHidden = out.hiddenCategories;
      if (state.recCategory === name) state.recCategory = '全部';
      await refreshRecords();
      toast(`已删除分类「${name}」${out.moved ? `，${out.moved} 条记录已移到「通用」` : ''}`, 'ok');
    } catch (err) { toast(err.message || '删除分类失败', 'err'); }
  }

  /* ═══ 记账（v2.0.0，需求文档「家庭账单记录」） ═══════════

     三个视图：
       chat  聊天式记账 —— 说一句话就能记一笔（解析全在服务端）
       list  账单明细 —— 筛选个人 / 全家、编辑、删除本人账单
       stats 统计 —— 范围合计 / 分类排行 + 月历（calendar / filter 两个子视图）
     ★ v4.15.0 需求 2：原来的第四个「设置」页签已下线 —— 推送时间与月度报表搬进
       「我的 → 消息推送设置 → 记账推送」，OCR 密钥搬进「我的 → AI 参数设置」，
       分类与预算搬进「我的 → 记账分类与预算」，记账页只留上面三个。

     ★ 界面只做展示与交互，**不做任何金额解析** ——
       「一句话里哪个数字是钱」这套逻辑只在 src/billparse.js 一处实现，
       前端自己再猜一遍必然会和服务端算出两个结果。
     ═════════════════════════════════════════════════════════ */

  /* v4.12.0 需求 3：日历并入「统计」 —— 顶部分段只剩 记账 / 明细 / 统计 / 设置，
     日历是统计里的第二个子视图（与待办页「待办列表 / 日历」同一种交互）。 */
  const BILL_VIEWS = [['chat', '💬 记账'], ['list', '📋 明细'], ['stats', '📊 统计']];
  /* ★ v2.0.2 只记支出：收入相关的页签、分类列、示例句全部下线。
     历史收入数据保留在库里（服务端 list 已强制只返回 expense），界面上不再有任何入口。 */
  const BILL_KIND_CN = { expense: '支出' };

  /** v4.0.0 需求 2：快捷短语的出厂例句（用户没自定义过 / 清空后用它兜底）。
      与服务端 bills.DEFAULT_QUICKS 保持一致 —— 服务端是「我的短语」的唯一数据源。 */
  const DEFAULT_BILL_QUICKS = ['今天买菜 30 元', '昨天打车 26', '这个月房租 3500', '充话费 100'];

  /** 分 → 元（带正负号，支出为负、收入为正，前端展示用，不做任何算术） */
  function fmtYuan(cents) {
    const n = (Number(cents) || 0) / 100;
    return n.toFixed(2);
  }
  const moneySigned = (kind, cents) => `${kind === 'income' ? '+' : '−'}¥${fmtYuan(cents)}`;

  function billCats(kind) {
    const m = state.billMeta || {};
    const c = m.categories || {};
    return (c[kind] || []);
  }
  const allBillCats = () => billCats('expense');

  /** 预置分类名单（服务端 /api/bills/bootstrap 下发）。不在名单里的才算自定义分类、才允许长按删除。 */
  function isDefaultCat(cat) {
    const m = state.billMeta || {};
    const d = m.defaults || {};
    const all = d.expense || [];
    // 名单还没取回来时保守一点：先当成预置（不可删），避免用户手滑删掉自愈不回来的分类
    if (!all.length) return true;
    return all.indexOf(cat) >= 0;
  }

  function billsHtml() {
    if (!state.me) return '';
    /* ★ v4.15.0 需求 2：记账页不再有「⚙️ 设置」页签 ——
       账单推送 / AI 参数 / 分类预算 全部并入「我的」，记账页只留
       「记账 / 明细 / 统计」三个高频视图。
       老状态（state.billView === 'settings'）在这里兜一次，避免升级后进来是空白页。 */
    if (state.billView === 'settings') state.billView = 'chat';
    const views = BILL_VIEWS;
    const seg = `<div class="segmented seg-wrap bill-views" data-act="bill-view">
        ${views.map(([k, label]) =>
          `<button type="button" data-view="${k}" class="${state.billView === k ? 'on' : ''}">${label}</button>`).join('')}
      </div>`;
    // OCR 额度预警：不到预警线不打扰，到了就在页顶常驻一行
    const q = (state.billMeta && state.billMeta.quota) || null;
    const warn = q && q.warn
      ? `<div class="card card-pad bill-warn">本月已用 AI <b>${q.used}/${q.limit}</b> 次，快到上限了。达到上限后将自动转为手动录入（文字记账不受影响）。</div>`
      : (q && q.exhausted
        ? `<div class="card card-pad bill-warn">本月已用 AI 次数已达上限（${q.limit} 次），AI 识别已自动停用，下个月 1 号自动恢复。现在仍可以正常文字记账。</div>`
        : '');

    /* v4.1.0 需求 1：识别草稿箱 —— 列表页与聊天页都挂在顶部，空闲时进来继续处理 */
    const drafts = state.billDrafts.length ? billDraftsHtml() : '';
    /* v4.9.0 需求 1：微信草稿箱 —— 微信端「存草稿」落库的账，回网页端改好再提交 */
    const sdrafts = state.billServerDrafts.length ? billServerDraftsHtml() : '';
    /* v4.3.2 需求 1：疑似重复入账的提示 —— 四个视图都挂在最上面（记完账人可能正在任意一屏） */
    const dup = billDupNoticeHtml();

    if (state.billView === 'list') return seg + warn + dup + sdrafts + drafts + billListHtml();
    if (state.billView === 'stats') return seg + warn + dup + billStatsHtml();
    return seg + warn + dup + sdrafts + drafts + billChatHtml();
  }

  /* ── v4.1.0 需求 1：识别草稿箱 ──────────────────────────
     OCR 识别结果可以不当场入账，一键整批存进浏览器本地（localStorage 持久，
     跨天不清 —— 「空闲时再处理」的前提是它得还在）。每条都能打开改好再入账，
     入账成功自动从草稿箱移除；不想记了就单条删。 */

  /* ── v4.3.2 需求 1：疑似重复入账的提示 ─────────────────────
     服务端在入库后回一句「这笔与 7 天内某条高度相似」，这里把它摆成一条
     **不阻塞**的提示：账已经记上了，用户看一眼决定「留着」还是「删掉」。
     为什么不在入库前拦住：家庭账本里「同一天同金额同分类」大多是真花了两笔
     （两杯咖啡、两次买菜），每次都拦下来会把人烦到干脆关掉这个功能；
     而真正要防的「重复入账」（同一张小票识别两次、昨天记过今天又记一遍）
     给一次提示 + 一键撤销就已经够了。 */

  /** 记一条疑似重复。同一笔账只记一次；批量入账时最多并排留 5 条，避免刷屏 */
  function pushBillDupTip(bill, similar) {
    if (!bill || !similar) return;
    const id = Number(bill.id);
    if (state.billDupTips.some((t) => Number(t.bill && t.bill.id) === id)) return;
    state.billDupTips = state.billDupTips.concat([{ bill, similar }]).slice(-5);
  }

  /** 从提示条里摘掉一条（用户点了「删掉」或「保留」） */
  function dropBillDupTip(id) {
    const n = Number(id);
    state.billDupTips = state.billDupTips.filter((t) => Number(t.bill && t.bill.id) !== n);
  }

  function billDupNoticeHtml() {
    if (!state.billDupTips.length) return '';
    const rows = state.billDupTips.map((t) => {
      const b = t.bill || {};
      const s = t.similar || {};
      const mine = [b.category, b.note].filter(Boolean).join(' · ');
      const old = [s.category, s.note].filter(Boolean).join(' · ');
      // 命中原因如实写出来，用户才判断得了「到底像不像」
      const why = s.sameDay ? '同一天 · 同金额' : '同金额 · 分类或备注也相近';
      return `
      <div class="dup-row" data-key="dup-${esc(String(b.id))}">
        <div class="dup-text">
          <b>¥${esc(fmtYuan(b.amountCents))}${mine ? ` · ${esc(mine)}` : ''}</b>
          <span class="dup-sub">与 ${esc(s.spentOn || '前几天')} 的「${esc(old || '同金额一笔')}」高度相似（${esc(why)}）</span>
        </div>
        <div class="dup-ops">
          <button type="button" class="btn-soft btn-sm" data-act="bill-dup-del" data-id="${esc(String(b.id))}">删掉刚记的这笔</button>
          <button type="button" class="btn-ghost btn-sm" data-act="bill-dup-ignore" data-id="${esc(String(b.id))}">保留</button>
        </div>
      </div>`;
    }).join('');
    return `
      <div class="card card-pad bill-dup">
        <div class="sec-head"><span class="sec-ico">⚠️</span>
          <span class="sec-title">可能存在重复入账</span>
          <span class="sec-note">账已经记上了，确认一下更放心</span></div>
        ${rows}
      </div>`;
  }

  function billDraftsHtml() {
    const rows = state.billDrafts.map((r) => `
      <div class="bd-row" data-key="draft-${esc(r.id)}">
        <div class="bd-main">
          <div class="bd-top"><span class="bd-note">${esc(r.note || '（未命名）')}</span>
            <span class="bd-amt">¥${esc(r.amount)}</span></div>
          <div class="bd-sub"><span>${esc(r.date || '')}</span><span>· ${esc(r.category || '其他')}</span>${
            r.platform ? `<span>· ${esc(r.platform)}</span>` : ''}</div>
        </div>
        <div class="br-ops">
          <button type="button" class="btn-soft btn-sm" data-act="bill-draft-open" data-id="${esc(r.id)}">修改入账</button>
          <button type="button" class="btn-ghost btn-sm" data-act="bill-draft-del" data-id="${esc(r.id)}">删除</button>
        </div>
      </div>`).join('');
    return `
      <div class="card card-pad bill-drafts">
        <div class="sec-head"><span class="sec-ico">📝</span>
          <span class="sec-title">识别草稿箱（${state.billDrafts.length}）</span>
          <span class="sec-note">识别结果暂存的账，改好一笔入一笔</span></div>
        ${rows}
      </div>`;
  }

  /* ── v4.9.0 需求 1：微信记账草稿箱（服务端）──────────────
     微信里被「疑似重复」拦下后回「存草稿」的账落在这里（服务端 bill_drafts 表）。
     与上面的「识别草稿箱」（localStorage）是两个东西：
       · 识别草稿箱 = 网页 OCR 结果暂存本地；
       · 微信草稿箱 = 微信端存到服务端，**换设备也能看到**，改好一笔提交一笔。
     「修改入账」复用账单编辑弹窗（mode 'sdraft'），提交 = POST /api/bills/drafts
     （修改字段随请求带上，一步完成），成功后草稿标记 submitted 自动从列表消失。 */
  function billServerDraftsHtml() {
    const rows = state.billServerDrafts.map((r) => `
      <div class="bd-row" data-key="sdraft-${esc(r.id)}">
        <div class="bd-main">
          <div class="bd-top"><span class="bd-note">${esc(r.note || r.raw || '（未填写备注）')}</span>
            <span class="bd-amt">¥${esc(r.amount)}</span></div>
          <div class="bd-sub"><span>${esc(r.spentOn || '')}</span><span>· ${esc(r.category || '其他')}</span>${
            r.platform ? `<span>· ${esc(r.platform)}</span>` : ''}<span>· 来自微信</span></div>
        </div>
        <div class="br-ops">
          <button type="button" class="btn-soft btn-sm" data-act="bill-sdraft-open" data-id="${esc(r.id)}">修改入账</button>
          <button type="button" class="btn-ghost btn-sm" data-act="bill-sdraft-del" data-id="${esc(r.id)}">删除</button>
        </div>
      </div>`).join('');
    return `
      <div class="card card-pad bill-drafts bill-sdrafts">
        <div class="sec-head"><span class="sec-ico">💬</span>
          <span class="sec-title">微信草稿箱（${state.billServerDrafts.length}）</span>
          <span class="sec-note">微信里「存草稿」的账，改好一笔提交一笔</span></div>
        ${rows}
      </div>`;
  }

  async function refreshBillServerDrafts() {
    const out = await api('/api/bills/drafts');
    state.billServerDrafts = out.drafts || [];
  }

  /** 从微信草稿箱打开一条进编辑弹窗（与识别草稿箱同一个弹窗，mode 不同） */
  function openBillSdraft(id) {
    const r = state.billServerDrafts.find((x) => x.id === id);
    if (!r) { toast('这条草稿不存在了', 'err'); return; }
    state.billOcrDraft = {
      mode: 'sdraft', draftId: r.id, kind: 'expense',
      amount: fmtYuan(r.amountCents), category: r.category, note: r.note || '',
      platform: r.platform || '', date: r.spentOn || todayKey(),
      text: r.raw || '', parsedOk: true,
    };
    renderBillEditModal();
  }

  /* ── 聊天式记账 ───────────────────────────────────────── */

  function billChatHtml() {
    const m = state.billMeta || {};
    const q = m.quota || null;
    // 额度用尽 / 管理员停用 → 自动隐藏图片识别入口（需求原文），但文字记账必须保留
    const aiOff = !!(q && q.enabled === false);
    const ocrOn = !!m.ocrConfigured && !(q && q.exhausted);
    const ocrHint = aiOff ? '（AI 功能已停用）'
      : (!m.ocrConfigured ? '（管理员还没配置）'
        : (q && q.exhausted ? '（本月额度已用完）' : ''));

    /* 气泡同样带 data-key：新消息追加后，靠序号认领会把「上一条系统回复」的节点
       复用成「下一条」，一旦那条节点正握着焦点就会被整块跳过 —— 表现为「发了但没回显」。
       按 id 认领后，新气泡必定是新增节点，一定画得出来。
       ★ v4.0.0：气泡数据来自浏览器本地缓存（仅保留当日），不再请求服务端历史。 */
    const bubbles = state.billChat.length
      ? state.billChat.map((c) => `
          <div class="bubble ${c.role === 'system' ? 'sys' : 'me'}" data-key="chat-${esc(c.id)}">
            <div class="bubble-text">${esc(c.text)}</div>
          </div>`).join('')
      : `<div class="bubble sys"><div class="bubble-text">说一句话就能记账，比如：<br>
           「今天买菜 30 元」「昨天打车 26」「这个月房租 3500」「充话费 100」</div></div>`;

    /* v4.0.0 需求 2：快捷短语是「我的」—— 服务端按人存，可在弹窗里增删 */
    const quick = (state.billQuick && state.billQuick.length) ? state.billQuick : DEFAULT_BILL_QUICKS;

    return `
      <div class="card bill-chat-card">
        <div class="bill-chat" id="bill-chat">${bubbles}</div>
        <div class="bill-quick">
          ${quick.map((t) => `<button type="button" class="chip" data-act="bill-quick" data-text="${esc(t)}">${esc(t)}</button>`).join('')}
          <button type="button" class="chip chip-edit" data-act="bill-quick-edit" title="自定义快捷短语">✏️</button>
        </div>
        <div class="bill-input-row">
          <button type="button" class="bill-ocr-btn${ocrOn ? '' : ' off'}" data-act="bill-ocr"
            ${ocrOn && !state.billOcrBusy ? '' : 'disabled'} title="${ocrOn
              ? '上传账单截图自动识别' : '图片识别不可用 ' + esc(ocrHint)}">${state.billOcrBusy ? '⏳' : '📷'}</button>
          <input type="text" class="bill-input" placeholder="说一句话，例如：今天买菜 30 元"
                 data-preserve="bill-text" data-act="bill-text" maxlength="200">
          <button type="button" class="btn-primary btn-sm" data-act="bill-send" ${state.billSending ? 'disabled' : ''}>${state.billSending ? '…' : '发送'}</button>
        </div>
        <div class="bill-hint" data-key="bill-hint">
          ${
    /* v4.2.0 需求 3：这一行实时显示**本月已用 AI 次数**与**消耗的 token 总额**。
       一句话记账已改为纯本地解析，所以这里只说截图识别 —— 不再有「AI 未配置
       所以文字记账降级」这种说法。两个数字都按自然月统计，跨月自动归零。 */
    aiOff
      ? 'AI 功能已停用（管理员可在「我的 → AI 参数设置」里开启）· 一句话记账是本地解析，不受影响'
      : (!m.ocrConfigured
        ? '本月已用 AI 次数：0 · token：0（截图识别未配置：管理员在「我的 → AI 参数设置」里填接口地址、API Key 和模型 ID）'
        : (q && q.exhausted
          ? `本月已用 AI 次数：${q.used || 0} · token：${q.tokens || 0}（已达上限 ${q.limit} 次，截图识别转为手动录入，下月 1 号自动清零）`
          : `本月已用 AI 次数：${(q && q.used) || 0} · token：${(q && q.tokens) || 0}`))
  }
        </div>
        <input type="file" accept="image/*" class="hidden" id="bill-ocr-file">
      </div>`;
  }

  /* ── 账单明细 ─────────────────────────────────────────── */

  /* v4.16.0 需求 6：每条账都记来源，界面用统一叫法展示。
     四种来源（+ 手动）：网页一句话 / 网页 AI / 微信一句话 / 微信 AI。
     文案分两层：徽标里只放 2–4 个字（一行里还要塞分类、记账人、备注，放长句会挤成两行），
     title 里给一句完整解释（鼠标悬停 / 长按能看到「这到底是怎么记上的」）。 */
  const BILL_SOURCE_LABEL = {
    local_text: '网页一句话',
    ai_image: '网页 AI',
    wecom_text: '微信一句话',
    wecom_image: '微信 AI',
    manual: '网页手动',
  };
  const BILL_SOURCE_DESC = {
    local_text: '在网页「记账」里打一句话记的（本地解析，不联网）',
    ai_image: '在网页上传账单截图，由 AI 识别后入账',
    wecom_text: '在企业微信里发一句话记的',
    wecom_image: '在企业微信里发账单截图，由 AI 识别后入账',
    manual: '在网页表单里逐项填写入账',
  };
  /** 一条账的来源徽标（认不出来就不画，绝不显示原始英文） */
  function billSourceBadge(b) {
    const key = String((b && b.sourceChannel) || '');
    const label = BILL_SOURCE_LABEL[key];
    if (!label) return '';
    return `<span class="badge src" title="${esc(BILL_SOURCE_DESC[key] || label)}">${esc(label)}</span>`;
  }

  function billListHtml() {
    const cats = ['全部'].concat(allBillCats());
    const chips = cats.map((c) =>
      `<button type="button" class="chip${state.billCategory === c ? ' on' : ''}" data-act="bill-cat" data-cat="${esc(c)}">${esc(c)}</button>`).join('');

    /* ★ 每一行都带 data-key（按账单 id）—— 这不是样式约定，而是「删除后能立刻消失」的关键。
       最小重绘是按「标签名 + class + 同名序号」认领节点的：删掉第 2 条时，第 2 行的位置会被
       第 3 条顶上，而**第 2 行的 DOM 恰好是用户刚点过「删除」的那一行** → holdsFocus 直接跳过它，
       屏幕上留下的还是那条已经删掉的账（第 3 行的节点则被当成多余的删了）。
       带上 id 后，被删的行在新树里根本不存在 → 直接 removeChild，与焦点在哪儿无关。 */
    const rows = state.bills.map((b) => `
      <div class="bill-row" data-key="bill-${b.id}">
        <div class="br-main">
          <div class="br-top">
            <span class="br-cat">${esc(b.category)}</span>
            <span class="br-amt ${b.kind === 'income' ? 'in' : 'out'}">${moneySigned(b.kind, b.amountCents)}</span>
          </div>
          <div class="br-sub">
            <span>${esc(b.spentOn)}</span>
            <span>· ${esc(b.ownerName)}</span>
            ${billSourceBadge(b)}
            ${b.platform ? `<span class="badge cat">${esc(b.platform)}</span>` : ''}
            ${b.note ? `<span class="br-note">${esc(b.note)}</span>` : ''}
          </div>
        </div>
        ${b.mine ? `<div class="br-ops">
          <button type="button" class="btn-ghost btn-sm" data-act="bill-edit" data-id="${b.id}">编辑</button>
          <button type="button" class="btn-ghost btn-sm" data-act="bill-del" data-id="${b.id}">删除</button>
        </div>` : '<span class="br-lock" title="只能编辑自己记的账">🔒</span>'}
      </div>`).join('');

    return `
      <div class="card card-pad">
        <div class="list-tools">
          ${searchBarHtml({
            act: 'bill-query', clearAct: 'bill-q-clear', preserve: 'bill-q',
            placeholder: '搜索备注 / 分类 / 记账人…', value: state.billQuery,
          })}
          <button type="button" class="btn-soft btn-sm" data-act="bill-export">导出 CSV</button>
        </div>
        <div class="segmented seg-wrap" data-act="bill-scope">
          <button type="button" data-scope="all" class="${state.billScope === 'all' ? 'on' : ''}">全家</button>
          <button type="button" data-scope="mine" class="${state.billScope === 'mine' ? 'on' : ''}">只看我的</button>
        </div>
        <div class="chips cats-row">${chips}</div>
      </div>
      <div class="card bill-list">
        ${rows || `<div class="empty"><span class="em">🧾</span>${
          state.billQuery.trim() || state.billCategory !== '全部' ? '没有匹配的账单' : '还没有账单，去「记账」说一句话试试'}</div>`}
      </div>`;
  }

  /* ── v4.9.0 需求 2：记账日历 ────────────────────────────
     数据聚合在服务端（GET /api/bills/calendar?month=YYYY-MM，一条 GROUP BY），
     前端一次拉整月，格子渲染不逐日请求。口径与明细列表一致：只看支出、全家共享。
     空状态两层：某天没记账 → 格子里只有日期数字，不放金额占位；
     整月一笔都没有 → 网格下给一条「这个月还没有记账」。 */
  async function refreshBillCalendar() {
    if (!state.billCalCursor) {
      const n = new Date();
      state.billCalCursor = { y: n.getFullYear(), m: n.getMonth() };
    }
    const mm = String(state.billCalCursor.m + 1).padStart(2, '0');
    const key = state.billCalCursor.y + '-' + mm;
    state.billCalData = await api('/api/bills/calendar?month=' + key);
    state.billCalLoaded = key;
  }

  /** 当前「日历查看」所在的年月键（v4.22.0：切标签时判断要不要重拉日历） */
  function currentBillCalKey() {
    if (!state.billCalCursor) {
      const n = new Date();
      state.billCalCursor = { y: n.getFullYear(), m: n.getMonth() };
    }
    return state.billCalCursor.y + '-' + String(state.billCalCursor.m + 1).padStart(2, '0');
  }

  /** 点开某天：拉那天的账单明细（复用明细列表接口的 from/to 范围过滤） */
  async function refreshBillCalDay(key) {
    state.billCalDay = key;
    state.billCalDayBills = null;
    render();
    try {
      const qs = new URLSearchParams({ from: key, to: key, limit: '50' });
      const out = await api('/api/bills?' + qs.toString());
      // 等待期间用户可能点了另一天：回来的如果不是当前选中的那天就丢弃
      if (state.billCalDay === key) { state.billCalDayBills = out.bills || []; render(); }
    } catch (err) { toast(err.message || '加载失败', 'err'); }
  }

  function billCalHtml() {
    const n = new Date();
    const cur = state.billCalCursor || { y: n.getFullYear(), m: n.getMonth() };
    const { y, m } = cur;
    const todayK = todayKey();
    const byDate = new Map(((state.billCalData && state.billCalData.days) || []).map((d) => [d.date, d]));
    const first = new Date(y, m, 1);
    const startOffset = first.getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const cells = [];

    for (let i = 0; i < 42; i++) {
      const dayNum = i - startOffset + 1;
      const d = new Date(y, m, dayNum);
      const key = dateKey(d);
      const other = dayNum < 1 || dayNum > daysInMonth;
      const day = byDate.get(key);
      cells.push(
        `<button type="button" class="cal-cell${other ? ' other' : ''}${key === todayK ? ' today' : ''}${key === state.billCalDay ? ' selected' : ''}"` +
        ` data-act="bill-cal-pick" data-date="${key}">` +
        `<span class="d-num">${d.getDate()}</span>` +
        (day && !other
          ? `<span class="d-amt">¥${fmtYuan(day.expenseCents)}</span>${day.count > 1 ? `<span class="d-cnt">${day.count} 笔</span>` : ''}`
          : '') +
        '</button>',
      );
    }

    const data = state.billCalData;
    const dayBills = state.billCalDayBills;
    return `
      <div class="card bill-cal-card">
        <div class="cal-head">
          <div class="cal-title">
            <button type="button" class="cal-jump" data-act="bill-cal-jump" title="点击跳转到指定年月">${cur.y}年${cur.m + 1}月</button>
            <span>家庭支出 · 当月合计 ¥${fmtYuan(data ? data.monthExpenseCents : 0)}（${data ? data.monthCount : 0} 笔）</span>
          </div>
          <div class="cal-nav">
            <button type="button" class="icon-btn" data-act="bill-cal-prev" title="上个月">‹</button>
            <button type="button" class="btn-ghost btn-sm" data-act="bill-cal-today">今天</button>
            <button type="button" class="icon-btn" data-act="bill-cal-next" title="下个月">›</button>
          </div>
        </div>
        <div class="cal-week">${WEEK_CN.map((w, i) => `<span class="${i === 0 ? 'wk' : ''}">${w}</span>`).join('')}</div>
        <div class="cal-grid" data-cal="bill">${cells.join('')}</div>
        ${data && !data.days.length ? '<div class="empty" style="padding:14px 0 4px"><span class="em">🧾</span>这个月还没有记账，去「💬 记账」说一句话试试</div>' : ''}
      </div>
      ${state.billCalDay ? `
      <div class="card card-pad bill-cal-day">
        <div class="section-head">
          <div class="section-title">${humanDate(state.billCalDay)} 的账<span class="count-pill">${dayBills ? `${dayBills.length} 笔` : '加载中…'}</span></div>
          <button type="button" class="btn-ghost btn-sm" data-act="bill-cal-close">收起</button>
        </div>
        ${dayBills && dayBills.length
          ? dayBills.map((b) => `
            <div class="bill-row" data-key="bill-${b.id}">
              <div class="br-main">
                <div class="br-top">
                  <span class="br-cat">${esc(b.category)}</span>
                  <span class="br-amt ${b.kind === 'income' ? 'in' : 'out'}">${moneySigned(b.kind, b.amountCents)}</span>
                </div>
                <div class="br-sub">
                  <span>· ${esc(b.ownerName)}</span>
                  ${billSourceBadge(b)}
                  ${b.note ? `<span class="br-note">${esc(b.note)}</span>` : ''}
                </div>
              </div>
              ${b.mine ? `<div class="br-ops">
                <button type="button" class="btn-ghost btn-sm" data-act="bill-edit" data-id="${b.id}">编辑</button>
                <button type="button" class="btn-ghost btn-sm" data-act="bill-del" data-id="${b.id}">删除</button>
              </div>` : '<span class="br-lock" title="只能编辑自己记的账">🔒</span>'}
            </div>`).join('')
          : (dayBills ? '<div class="empty" style="padding:12px 0"><span class="em">🗒️</span>这一天没有记账</div>' : '')}
      </div>` : ''}`;
  }

  /* ── 统计 ─────────────────────────────────────────────── */

  function statBox(title, s, variant) {
    /* ★ v2.0.2 只记支出：统计卡不再有「收入 / 结余」两行 ——
       收入下线后它们永远是 ¥0.00，留着只会让人疑惑「是不是没记上」。
       ★ v4.0.0 需求 4：日卡（stat-day，暖色）与月卡（stat-month，冷色）视觉上明确区分，
       再配「当日 / 当月」徽标 —— 四张卡不再长得一模一样。
       ★ v4.15.0 需求 5：新增 'range' 变体 —— 「我的/全家 · 范围合计」统计的是
       **一段日期范围**，前面挂「当日」纯属误导（用户明确指出要去掉）。 */
    const v = variant === 'day' ? 'day' : (variant === 'range' ? 'range' : 'month');
    const badge = v === 'day' ? '当日' : (v === 'range' ? '' : '当月');
    return `
      <div class="stat-box stat-${v}">
        <div class="sb-title">${badge ? `<span class="sb-badge sb-badge-${v}">${badge}</span>` : ''}${esc(title)}</div>
        <div class="sb-rows">
          <div class="sb-row"><span>支出</span><b class="out">¥${fmtYuan(s.expenseCents)}</b></div>
        </div>
      </div>`;
  }

  /* ── 统计（v4.12.0 需求 3：日历并入统计，拆成「筛选查看 / 日历查看」）──
     与待办页的「待办列表 / 日历」同一种交互：seg-mini 分段 + 右侧一句说明。
     两个子视图共用同一份数据（/api/bills/bootstrap 的 stats + /api/bills/calendar），
     切换只改 state.billStatsView，不额外请求。 */

  function billStatsHtml() {
    const onCal = state.billStatsView === 'calendar';
    const switchHtml = `
      <div class="card card-pad stats-view-tools">
        <div class="list-tools">
          <div class="segmented seg-mini" data-act="bill-stats-view">
            <button type="button" data-view="filter" class="${onCal ? '' : 'on'}">筛选查看</button>
            <button type="button" data-view="calendar" class="${onCal ? 'on' : ''}">日历查看</button>
          </div>
        </div>
        <div class="stats-hint">${onCal
          ? '按天看全家支出，点某一天展开当天明细；右上角可跳到任意年月。'
          : '按日期范围筛选，看这段时间钱花在哪儿；默认就是本月。'}</div>
      </div>`;
    return switchHtml + (onCal ? billCalHtml() : billFilterHtml());
  }

  /**
   * 「筛选查看」：**只剩日期范围**一种口径（需求原文：移除日期选择和月份选择）。
   * 原来那四张「我的/全家 · 当日/当月」卡片依赖「日期」「月份」两个输入，
   * 输入没了它们就失去了意义，所以一并去掉 —— 范围合计 + 本月分类两段反而更清楚。
   */
  function billFilterHtml() {
    const st = state.billStats;
    const today = todayKey();
    const monthFirst = today.slice(0, 8) + '01';
    if (!st) return '<div class="card empty"><span class="em">📊</span>正在统计…</div>';
    const rg = st.range;
    const top = rg ? (rg.family.top || []).slice(0, 8) : [];
    const topMax = top.length ? Math.max.apply(null, top.map((r) => r.amountCents)) : 1;
    const rank = (st.monthByCategory || []).slice(0, 8);
    const max = rank.length ? Math.max.apply(null, rank.map((r) => r.amountCents)) : 1;

    return `
      <div class="card card-pad">
        <div class="sec-head"><span class="sec-ico">🗓️</span><span class="sec-title">日期范围</span>
          <span class="sec-note">只看支出 · 全家共享</span></div>
        <div class="list-tools stat-tools">
          <label class="field field-sm"><span>从</span>
            <input type="date" value="${esc(state.billStatFrom || monthFirst)}" data-act="bill-stat-from"></label>
          <label class="field field-sm"><span>至</span>
            <input type="date" value="${esc(state.billStatTo || today)}" data-act="bill-stat-to"></label>
          <button type="button" class="btn-soft btn-sm" data-act="bill-range-apply">查看</button>
        </div>
        <div class="field-hint">默认就是本月 1 号到今天，改完日期点「查看」即可。</div>
      </div>
      ${rg ? `
      <div class="card card-pad stat-range-card">
        <div class="sec-head"><span class="sec-ico">📈</span>
          <span class="sec-title">${esc(rg.from)} ~ ${esc(rg.to)}</span>
          <span class="sec-note">全家 ${rg.family.count} 笔</span></div>
        <div class="stat-grid">
          ${statBox('我的 · 范围合计', rg.personal, 'range')}
          ${statBox('全家 · 范围合计', rg.family, 'range')}
        </div>
        <div class="sb-rows range-extra">
          <div class="sb-row"><span>我的笔数</span><b>${rg.personal.count} 笔</b></div>
          <div class="sb-row"><span>全家笔数</span><b>${rg.family.count} 笔</b></div>
        </div>
        ${top.length ? top.map((r) => `
          <div class="rank-row">
            <span class="rk-name">${esc(r.category)}</span>
            <span class="rk-bar"><i style="width:${Math.max(3, Math.round(r.amountCents / topMax * 100))}%"></i></span>
            <span class="rk-val">¥${fmtYuan(r.amountCents)}</span>
          </div>`).join('') : '<div class="empty" style="padding:12px"><span class="em">📉</span>这个范围还没有支出</div>'}
      </div>` : ''}
      <div class="card card-pad">
        <div class="sec-head"><span class="sec-ico">🏷️</span><span class="sec-title">${esc(st.month)} 支出分类</span>
          <span class="sec-note">按全家口径</span></div>
        ${rank.length ? rank.map((r) => `
          <div class="rank-row">
            <span class="rk-name">${esc(r.category)}</span>
            <span class="rk-bar"><i style="width:${Math.max(3, Math.round(r.amountCents / max * 100))}%"></i></span>
            <span class="rk-val">¥${fmtYuan(r.amountCents)}</span>
          </div>`).join('')
          : '<div class="empty" style="padding:16px"><span class="em">📉</span>这个月还没有支出</div>'}
      </div>`;
  }

  /* ── 记账设置（管理员） ───────────────────────────────── */

  /** ISO 时间 → 「YYYY-MM-DD HH:MM」（设置页多处用） */
  function fmtDateTimeCn(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso || '');
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /** v4.0.0 需求 7：AI 调用日志表（管理端，点「查看日志」拉取） */
  function billAiLogsHtml() {
    const logs = state.billAiLogs || [];
    const q = (state.billMeta && state.billMeta.quota) || {};
    const rows = logs.slice(0, 30).map((l) => `
      <div class="ai-log-row${l.ok ? '' : ' err'}">
        <span class="ai-log-time">${esc(fmtDateTimeCn(l.createdAt))}</span>
        <span class="ai-log-act">${esc(l.action || '-')}</span>
        <span class="ai-log-model">${esc(l.model || '-')}</span>
        <span class="ai-log-meta">图${l.images || 0} · token ${l.totalTokens || 0} · ${l.durationMs || 0}ms</span>
        ${l.ok ? '' : `<span class="ai-log-err">${esc(l.error || '失败')}</span>`}
      </div>`).join('');
    /* v4.2.0 需求 3：日志只显示**本月**（服务端按自然月过滤），跨月自动清空；
       顶部同时给出本月次数与 token 总额，和输入框下方那行口径一致。 */
    return `
      <div class="ai-logs">
        <div class="ai-logs-sum">
          <b>${esc(q.month || '本月')}</b> 已用 <b>${Number(q.used) || 0}</b> 次 ·
          消耗 <b>${Number(q.tokens) || 0}</b> token
          <span class="sec-note">（按自然月统计，跨月自动归零；历史记录仍保留在库里）</span>
        </div>
        ${rows || '<div class="empty" style="padding:10px"><span class="em">🗒️</span>本月还没有调用记录</div>'}
        ${logs.length ? `<div class="sec-note"><small>本月最近 ${logs.length} 条（新的在上）</small></div>` : ''}
      </div>`;
  }

  /**
   * v4.15.0 需求 2/3：原来的「记账设置」页签（三块折叠）拆开搬进「我的」——
   *   · 账单推送设置 → 「消息推送设置」里的「记账推送」（需求 3，含运行状态）
   *   · AI 参数配置  → 「AI 参数设置」（仅管理员，需求 2）
   *   · 分类与预算   → 「记账分类与预算」（需求 2）
   * 记账页从此只有「记账 / 明细 / 统计」三个页签，不再有独立设置入口。
   * 三块共用的取值逻辑收在 billSetCtx() 里，避免三份各自去解析 state.billMeta。
   */
  function billSetCtx() {
    const m = state.billMeta || {};
    const r = m.reports || {};          // 非管理员这里是 null → 用 {} 兜底
    const st = r.status || {};
    const budgets = m.budgets || [];
    const bmap = new Map(budgets.map((b) => [b.category, Number(b.amountCents) || 0]));
    const fmtAt = (iso) => {
      if (!iso) return '尚未发送';
      const d = new Date(iso);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
        `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    return { m, r, st, budgets, bmap, fmtAt };
  }

  /** 「记账推送」在「我的」里的摘要（折叠头右侧 / 消息提醒行内共用） */
  function billPushSummary() {
    const { r } = billSetCtx();
    if (!r || r.reportsEnabled === undefined) return '以管理员设置为准';
    return r.reportsEnabled === false
      ? '日报已关闭'
      : `每天 ${esc(r.dailyTime || '21:00')} 推送${r.monthlyReport ? ' · 月初月报' : ''}`;
  }

  /* ── v4.25.0 需求 4：记账这一类的推送渠道（个人） ──────────────
     与「待办提醒 / 内容通知」里的渠道下拉同一套语义：留空 = 沿用「我的推送方式」。
     报表是**按人发**的（每人一份），所以这一项必须是个人偏好，不是家庭设置。 */
  const CAT_CHANNELS = ['auto', 'wecom', 'feishu', 'dingtalk', 'mail', 'both'];

  /** 我在「记账」这一类上单独指定的通道；'' = 跟随全局 */
  function billChannelOf() {
    const v = String((state.prefs || {}).channel_bill || '');
    return v && PUSH_LABEL[v] ? v : '';
  }

  function billChannelSummary(me) {
    const v = billChannelOf();
    return v
      ? `我：${PUSH_LABEL[v]}`
      : `我：跟随推送方式（${PUSH_LABEL[pushChannelOf(me)] || '智能'}）`;
  }

  /** 记账渠道下拉（管理员弹窗与成员弹窗共用一份） */
  function billChannelSel() {
    const cur = billChannelOf();
    return `
      <label class="field field-sm"><span>记账推送渠道
        <span class="field-hint">（不单独指定就跟随「推送方式」）</span></span>
        <select data-act="bill-channel">
          <option value=""${!cur ? ' selected' : ''}>跟随我的推送方式（${esc(PUSH_LABEL[pushChannelOf(state.me)] || '智能')}）</option>
          ${CAT_CHANNELS.map((v) => `<option value="${v}"${cur === v ? ' selected' : ''}>${esc(PUSH_LABEL[v])}</option>`).join('')}
        </select></label>`;
  }

  /**
   * v4.25.0 需求 4：管理员弹窗里的「我自己收到的这一类走哪条通道」。
   * 管理员在「待办提醒 / 内容通知」里改的是**全家默认**，跟他自己收不收、走哪条通道是两件事，
   * 所以这里单独一块、写个人偏好（user_prefs），改一个下拉即时生效。
   */
  function myChannelSelect(kind) {
    const key = kind === 'notify' ? 'channel_notify' : 'channel_todo';
    const cur = String((state.prefs || {})[key] || '');
    return `
      <label class="field field-sm"><span>我自己收到的${kind === 'notify' ? '内容通知' : '待办提醒'}走哪条通道
        <span class="field-hint">（个人偏好，留空跟随「推送方式」；只影响你自己）</span></span>
        <select data-act="my-channel" data-kind="${kind === 'notify' ? 'notify' : 'todo'}">
          <option value=""${!cur ? ' selected' : ''}>跟随我的推送方式（${esc(PUSH_LABEL[pushChannelOf(state.me)] || '智能')}）</option>
          ${CAT_CHANNELS.map((v) => `<option value="${v}"${cur === v ? ' selected' : ''}>${esc(PUSH_LABEL[v])}</option>`).join('')}
        </select></label>`;
  }

  /** 成员也能改自己的「记账推送渠道」——报表设置那一堆仍只有管理员能改 */  function openBillChannelForm() {
    openModal({
      title: '记账推送',
      body: `${billChannelSel()}
        <div class="note-box">
          日报 / 月报按<b>每个人</b>的通道各发一份：只影响你自己收到的汇总消息，
          不改别人的，也不影响待办提醒与内容通知（那两类在「待办提醒 / 内容通知」里单独设）。
          留空 = 跟着「推送方式」走，改了这里只对这一类生效。
        </div>
        <div class="note-box">报表的发送时间、是否附带待办等由管理员统一设置。</div>`,
      foot: `<button type="button" class="btn-ghost" data-act="modal-close">关闭</button>
        <button type="button" class="btn-primary" data-act="bill-channel-save">保存</button>`,
    });
  }

  async function saveBillChannel() {
    const sel = document.querySelector('#modal-layer [data-act="bill-channel"]');
    const val = sel ? String(sel.value || '') : '';
    try {
      const out = await api('/api/prefs', { method: 'POST', body: { channel_bill: val } });
      state.prefs = out.prefs || state.prefs;
      toast(val ? `记账推送已改为「${PUSH_LABEL[val]}」` : '记账推送已改为跟随推送方式', 'ok');
      closeModal();
      render();
    } catch (err) { toast(err.message || '保存失败', 'err'); }
  }

  /**
   * 记账推送的设置表单（v4.14.0 起不再有「推送方式」，通道统一在「推送方式」那行选）。
   * v4.16.0 需求 1：整块从「我的」内联搬进**弹窗**，与待办提醒 / 内容通知一致；
   * 需求 2：「额外抄送 UserID」配置已下线 —— 企业微信收件人只看账号映射 + 各自推送方式，
   *   这里只保留一条投递状态说明，不再提供可配置字段。
   */
  function billPushBodyHtml() {
    const { r, st, fmtAt } = billSetCtx();
    const attachOn = st.attachTodo !== false;
    const sameDay = r.reportWhen === 'same_day';
    /* 说明文字随日报口径变化：附带的是「报告日的第二天」，
       当天发当天 → 明天；第二天发前一天 → 今天（也就是发送当天）。 */
    const attachHint = !attachOn ? '现在不会附带待办'
      : (sameDay
        ? '当天发送时，附上<b>第二天</b>的待办（明天要做什么）'
        : '第二天发送时，附上<b>第二天</b>的待办（也就是发送当天的待办）');
    /* v4.17.0 需求 7：这里要区分两个数 ——
       wcN = 按各自推送方式算下来**真正投得出去**的人数；
       mapN = 账号映射表里实际绑定的账号数（服务端 bondCount）。
       「投不出去」不等于「没映射」：映射了 3 个人但都只选了邮件，一样是 0。
       提示里把两个数都说清，再给一个直达账号映射的按钮。 */
    const wcN = Number(r.wecomRecipientCount) || 0;
    const mapN = state.wecom ? Number(state.wecom.bondCount) || 0 : 0;
    const wxHint = wcN
      ? `会发给 ${wcN} 位已映射的家人（严格按各自在「推送渠道设置」里选的推送方式）`
      : (mapN
        ? `账号映射里已有 ${mapN} 位家人，但目前没人符合投递条件：看看大家的推送方式是不是都选了「仅邮件」，或企业微信推送没开`
        : '账号映射还是空的：把家人的企业微信 UserID 对应到家庭账号，报表才能发到企业微信');
    return `
        ${billChannelSel()}
        <div class="row-list">
          <div class="row"><div class="r-label"><b>每日日报</b><small>把前一天的账单发给全家</small></div>
            <button type="button" class="btn-soft btn-sm" data-act="bill-reports-toggle">${r.reportsEnabled ? '已开启 · 点此关闭' : '已关闭 · 点此开启'}</button></div>
          <div class="row"><div class="r-label"><b>推送时间</b><small>HH:MM</small></div>
            <input type="time" class="inp-compact" data-act="bill-daily-time" value="${esc(r.dailyTime || '21:00')}"></div>
          <div class="row row-stack"><div class="r-label"><b>日报口径</b><small>当天发当天 / 第二天发前一天</small></div>
            <div class="segmented seg-wrap" data-act="bill-report-when">
              <button type="button" data-val="same_day" class="${r.reportWhen === 'same_day' ? 'on' : ''}">当天发当天</button>
              <button type="button" data-val="next_day" class="${r.reportWhen !== 'same_day' ? 'on' : ''}">第二天发前一天</button>
            </div></div>
          <div class="row"><div class="r-label"><b>月初月报</b><small>每月 1 号补发上月</small></div>
            <button type="button" class="btn-soft btn-sm" data-act="bill-monthly-toggle">${r.monthlyReport ? '已开启 · 点此关闭' : '已关闭 · 点此开启'}</button></div>
          <div class="row row-stack"><div class="r-label"><b>是否附带待办</b><small>${attachHint}</small></div>
            <label class="check-line"><input type="checkbox" data-act="bill-attach-todo"${attachOn ? ' checked' : ''}>
              <span>随日报 / 月报附上待办</span></label></div>
          <div class="row"><div class="r-label"><b>上次发送</b>
            <small>${esc(fmtAt(st.at))} · ${esc(st.result || '尚无记录')}${
              st.errors && st.errors.length ? ` · <span class="warn-text">${esc(st.errors[0])}</span>` : ''}</small></div>
            <button type="button" class="btn-ghost btn-sm" data-act="bill-report-test">试发</button></div>

          <div class="sub-head">企业微信收件人</div>
          <div class="row"><div class="r-label"><b>按账号映射投递</b>
            <small>${wxHint}</small></div>
            ${wcN ? '' : `<button type="button" class="btn-soft btn-sm" data-act="bill-push-goto-map">去账号映射</button>`}</div>
        </div>
        <div class="note-box bill-push-note">报表严格按每个人自己的「推送方式」投递：
          仅邮件 → 只发邮件；仅企业微信 → 只发企业微信；两者都选 → 两条都收；
          智能 → 企业微信优先、发不了才落邮件。关掉日报只影响汇总消息，不影响提醒和手动记账。</div>
        ${msgTplBlock('bill')}`;
  }

    /* —— ② AI 参数配置（沿用原来的「截图识别」整块，v4.15.0 搬进「我的」）—— */
  function billAiBodyHtml() {
    const { m, r } = billSetCtx();
    const ai = (r.ocr && r.ocr.ai) || {};
    /* ★ v4.3.2 需求 2：「自定义提示词」输入框预填**内置默认内容**。
       为什么预填而不是留空：留空时框里什么都没有，用户根本不知道内置的口径是什么，
       想微调也无从下手（只能从零写，写完还不知道对不对）。
       另外把这份默认模板另存一份到 textarea 的 data-def 上 ——
       「恢复默认」按钮直接拿它还原，不必再往返一次服务端（离线也点得动）。
       promptVal 的取值顺序：管理员存过的自定义 → 内置默认模板。 */
    const defPrompt = String(ai.defaultPrompt || '');
    const promptVal = String(ai.promptCustom || '').trim() ? String(ai.promptCustom) : defPrompt;
    const curModel = r.currentModel || {};
    const aiOpen = !!state.billAiParamsOpen;
    const q = m.quota || {};
    const rowNum = (key, label, hint, val, min, max, step) => `
          <div class="row"><div class="r-label"><b>${label}</b><small>${hint}</small></div>
            <input type="number" class="inp-compact" min="${min}" max="${max}"${step ? ` step="${step}"` : ''} inputmode="decimal"
                   data-mk="${key}" value="${esc(String(val))}"></div>`;
    const rowCheck = (key, label, hint, on) => `
          <div class="row"><div class="r-label"><b>${label}</b><small>${hint}</small></div>
            <input type="checkbox" data-mk="${key}"${on ? ' checked' : ''}></div>`;
    const rowSel = (key, label, hint, val) => `
          <div class="row"><div class="r-label"><b>${label}</b><small>${hint}</small></div>
            <select class="inp-compact" data-mk="${key}">
              <option value="auto"${val !== 'strict' ? ' selected' : ''}>自动新建</option>
              <option value="strict"${val === 'strict' ? ' selected' : ''}>只用现有（归「其他」）</option>
            </select></div>`;

    return `
        <div class="row-list">
          <div class="row"><div class="r-label"><b>AI 功能</b><small>停用后只能手动录入</small></div>
            <button type="button" class="btn-soft btn-sm" data-act="bill-ai-toggle">${r.aiEnabled ? '已开启 · 点此停用' : '已停用 · 点此开启'}</button></div>
          <div class="row"><div class="r-label"><b>本月用量</b>
            <small>${q.used || 0} / ${q.limit || 1000} 次 · ${q.tokens || 0} token${
              q.warn ? ' · <span class="warn-text">快到上限</span>' : ''}${
              q.exhausted ? ' · <span class="warn-text">已用完</span>' : ''}</small></div>
            <input type="number" class="inp-compact" min="1" max="1000000" inputmode="numeric"
                   data-act="bill-ai-limit" value="${esc(String(r.aiMonthlyLimit || 1000))}" title="月度额度上限"></div>
          <div class="row"><div class="r-label"><b>调用日志</b><small>每次的 token / 耗时 / 成败</small></div>
            <div class="row-ops">
              <button type="button" class="btn-ghost btn-sm" data-act="bill-ai-logs-open"${state.billAiLogs ? ' disabled' : ''}>展开</button>
              <button type="button" class="btn-ghost btn-sm" data-act="bill-ai-logs-close"${state.billAiLogs ? '' : ' disabled'}>收起</button>
            </div></div>
        </div>
        ${state.billAiLogs ? billAiLogsHtml() : ''}
        <!-- v4.24.0 需求 1：通用平台三件套（接口地址 + API Key + 模型 ID），
             不再限定任何一家服务商 —— 凡提供 OpenAI 兼容端点的平台都能填。 -->
        <label class="field"><span>接口地址（Base URL）<span class="field-hint">（OpenAI 兼容端点，以 /v1 结尾）</span></span>
          <input type="text" data-mk="aiBaseUrl" maxlength="300"
                 value="${esc(r.aiBaseUrl || '')}" placeholder="例如 https://api.openai.com/v1"></label>
        <label class="field"><span>API Key</span>
          <input type="password" data-mk="aiKey" placeholder="${r.hasAiKey ? `已保存（尾号 ${esc(r.aiKeyTail || '****')}），留空不改` : '在你使用的 AI 平台控制台创建'}"></label>
        <label class="field"><span>模型 ID<span class="field-hint">（须支持图片输入；与你填的平台匹配）</span></span>
          <input type="text" data-mk="aiVlModel" maxlength="64"
                 value="${esc(r.aiVlModel || '')}" placeholder="例如 gpt-4o-mini、gemini-2.5-flash、glm-4v-flash"></label>
        ${r.aiLegacy ? '<div class="note-box">检测到密钥仍保存在旧版「千问」配置里，识别照常可用。建议把上面三项重新填一遍保存，完成迁移。</div>' : ''}
        <div class="cur-model">当前模型：<b>${esc(r.aiVlModel || '')}</b>${curModel.price ? ` · ${esc(curModel.price)}` : ''}${
          curModel.vision === false ? ' <span class="warn-text">· 名字不像视觉模型</span>' : ''}</div>

        <!-- v4.3.1 需求 6：识别参数默认收拢，点标题展开 / 再点收拢（交互同「周期提醒」）。
             控件始终在 DOM 里（只是 hidden），保存时不会因为「没展开」把参数写回默认值。 -->
        <div class="ai-params${aiOpen ? ' open' : ''}">
          <button type="button" class="repeat-toggle" data-act="bill-ai-params-toggle" aria-expanded="${aiOpen ? 'true' : 'false'}">
            <span class="section-title">识别参数<span class="count-pill">${aiOpen ? '可调' : '极速档'}</span></span>
            <span class="repeat-caret">${aiOpen ? '收起' : '展开'}<i>${aiOpen ? '⌃' : '⌄'}</i></span>
          </button>
          <div class="row-list ai-params-body${aiOpen ? '' : ' hidden'}">
            <!-- v4.25.0 需求 3：思考模式 / 思考预算 / 最大输出 / 采样温度 四项已下线。
                 它们不是「各有偏好」而是「有唯一正确答案」：关思考、短输出、温度 0。
                 留着开关只会出现「有人把思考打开 ⇒ 一次识别 30 秒」。 -->
            ${rowNum('aiTimeoutS', '超时（秒）', '超时就断开并提示，不会一直等', Math.round((ai.timeoutMs || 60000) / 1000), 5, 300)}
            ${rowNum('aiRetry', '失败重试', '网络抖动时最多再试几次', ai.retry == null ? 1 : ai.retry, 0, 3)}
            ${rowCheck('aiFallback', '模型不可用时自动换默认模型', '关掉则填错模型直接报错', ai.fallback !== false)}
            ${rowSel('aiCategoryMode', '新分类的处理', '「只用现有」时新品类归入「其他」', ai.categoryMode)}
            ${rowCheck('aiImgCompress', '上传前压缩图片', '越小上传越快（官方：不影响模型耗时）', ai.imgCompress !== false)}
            ${rowNum('aiImgEdge', '图片长边', '640–2400 像素', ai.imgEdge || 1024, 640, 2400)}
            ${rowNum('aiImgQuality', '图片质量', '0.4–0.95，越低体积越小', ai.imgQuality == null ? 0.7 : ai.imgQuality, 0.4, 0.95, 0.05)}
            ${rowNum('aiImgKb', '目标体积', '超过就继续降画质（KB）', ai.imgKb || 480, 200, 4000)}
            ${rowNum('aiCatHint', '提示词里的分类条数', '列得越少提示词越短；0 = 不列', ai.catHint == null ? 8 : ai.catHint, 0, 40)}
          </div>
          <div class="note-box ai-share-note">
            <b>这一页的参数对「网页上传截图」和「企业微信发图」同时生效</b> —— 两边调的是同一个识别接口、
            同一份参数（模型 / 超时 / 重试 / 分类归一 / 提示词），改完保存即刻生效，不需要重启。
            思考模式、输出上限、采样温度这类「每次识别都必须一样」的参数已固化为<b>极速档</b>（关思考 / 短输出 / 温度 0），
            不再开放调节 —— 唯一会拖慢识别的是模型本身，觉得慢就换个更快的视觉模型。
            唯一的差别是<b>图片压缩</b>：网页端在上传前按这里的「长边 / 质量 / 目标体积」压一遍，
            企业微信发来的图是微信客户端压过的原图（服务端零依赖、不做二次编码，
            只在超过参数规格时提前告诉你），所以两边体积通常不会一模一样 ——
            但**判定用的是同一份参数**。
          </div>
          <label class="field ai-prompt-field"><span>自定义提示词<span class="field-hint">（已预填内置内容；支持 {today} 与 {categories}）</span></span>
            <textarea data-mk="aiPromptCustom" maxlength="2000" rows="5" data-def="${esc(defPrompt)}"
                      placeholder="留空即用内置默认">${esc(promptVal)}</textarea>
            <div class="ai-prompt-ops">
              <span class="field-hint">改坏了不要紧：点右边一键还原（还原后仍需点保存生效）</span>
              <button type="button" class="btn-ghost btn-sm" data-act="bill-prompt-reset">恢复默认</button>
            </div></label>
        </div>

        <div class="status-ops">
          <button type="button" class="btn-primary btn-sm" data-act="bill-save-ai">保存</button>
          ${r.hasAiKey ? '<button type="button" class="btn-ghost btn-sm" data-act="bill-clear-ai">清空密钥</button>' : ''}
          <span class="status-hint">密钥只存在你的服务器上</span>
        </div>`;
  }

  /** AI 参数在「我的」折叠头的摘要 */
  function billAiSummary() {
    const { m, r } = billSetCtx();
    if (!r || r.aiEnabled === undefined) return '仅管理员可配置';
    if (r.aiEnabled === false) return 'AI 已停用';
    return m.ocrConfigured ? `已配置 · ${r.aiVlModel || '默认模型'}` : '未配置密钥';
  }

  /* —— ③ 分类与预算 ——
     v4.12.0 需求 7：页面**只展示已设预算的分类**，没设预算的统一收进下拉框；
     选中下拉里的一项 → 立刻出现一行可填的预算（填完保存即写入）。 */
  function billCatBodyHtml() {
    const { bmap } = billSetCtx();
    const cats = billCats('expense');
    const withBudget = cats.filter((c) => bmap.has(c));
    const noBudget = cats.filter((c) => !bmap.has(c));
    const pick = state.billBudgetPick && noBudget.includes(state.billBudgetPick) ? state.billBudgetPick : '';
    const budgetRow = (c, cents) => `
      <div class="budget-row"${isDefaultCat(c) ? '' : ` data-longpress="bill-cat-del" data-kind="expense" data-cat="${esc(c)}"`}>
        <span class="bg-name">${esc(c)}${isDefaultCat(c) ? '' : '<i class="bg-tag">自定义</i>'}</span>
        <input type="text" class="cm-budget" placeholder="预算" value="${cents == null ? '' : esc(fmtYuan(cents))}"
               data-act="bill-budget" data-cat="${esc(c)}" inputmode="decimal">
        <span class="bg-unit">元/月</span>
        ${isDefaultCat(c) ? '' : `<button type="button" class="btn-ghost btn-sm bg-del" data-act="bill-cat-del"
          data-kind="expense" data-cat="${esc(c)}" title="删除这个分类">删</button>`}
      </div>`;
    return `
        <div class="budget-list">
          ${withBudget.length
            ? withBudget.map((c) => budgetRow(c, bmap.get(c))).join('')
            : '<div class="empty" style="padding:14px 0"><span class="em">💰</span>还没有设置任何预算</div>'}
          ${pick ? budgetRow(pick, null) : ''}
        </div>
        <div class="budget-add">
          <select class="inp-compact oi-cat" data-act="bill-budget-pick">
            <option value="">＋ 给某个分类设预算</option>
            ${noBudget.map((c) => `<option value="${esc(c)}"${pick === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}
          </select>
          <span class="field-hint">${noBudget.length
            ? `还有 ${noBudget.length} 个分类没设预算，选一个就开始填`
            : '所有分类都已设预算'}</span>
        </div>
        <div class="budget-tip">把金额清空再保存 = 取消该分类的预算。自定义分类可长按（电脑上右键）或点「删」删除。</div>
        <div class="cm-add">
          <input type="text" maxlength="12" placeholder="新增支出分类" data-mk="newcat-expense">
          <button type="button" class="btn-ghost btn-sm" data-act="bill-cat-add" data-kind="expense">添加</button>
        </div>
        <!-- v4.18.0 需求 1：「保存预算」从页面最底部挪到「添加分类」下方 ——
             预算行 / 新增分类都集中在上面，保存动作紧挨着它们才顺手；
             下面跟着的分类规则块（管理员）与它互不干扰。 -->
        <div class="status-ops">
          <button type="button" class="btn-primary btn-sm" data-act="bill-save-budgets">保存预算</button>
          <span class="status-hint">超出预算会在聊天里提醒</span>
        </div>
        ${state.me && state.me.is_admin ? billCatRulesHtml() : ''}`;
  }

  /* v4.17.0 需求 5：自动识别分类规则 —— 用户可维护的「关键词 → 分类」。
     一句话记账 / 截图识别 / AI 结果归一三处共用；内置关键词表仍在，用户规则优先。
     v4.18.0 需求 2：内置规则**默认预置**在设置框里（没存过自定义规则就显示内置原文），
     用户直接在预置文本上增删改；「恢复默认」一键还原成内置表。 */
  function billCatRulesHtml() {
    const rep = (state.billMeta && state.billMeta.reports) || {};
    const rules = rep.catRules || [];
    const text = rules.length
      ? rules.map((x) => `${x.cat}：${(x.kws || []).join('、')}`).join('\n')
      : String(rep.catRulesBuiltin || '');
    return `
        <div class="sub-head">自动识别分类规则</div>
        <div class="row row-stack"><div class="r-label"><b>关键词 → 分类</b>
          <small>已预置内置关键词规则，可直接增删改。每行一条，格式「分类：关键词1、关键词2」；
            最多 50 条，每条关键词最长 20 字。保存后下一句记账就按新规则归类
            （没命中规则的词仍按内置关键词表兜底）。</small></div>
          <textarea data-mk="cat-rules" rows="10" data-min-h="0" autocomplete="off"
            placeholder="餐饮：饭、餐、吃…">${esc(text)}</textarea></div>
        <div class="status-ops">
          <button type="button" class="btn-ghost btn-sm" data-act="bill-cat-rules-save">保存规则</button>
          <button type="button" class="btn-ghost btn-sm" data-act="bill-cat-rules-reset">恢复默认</button>
          <span class="status-hint">恢复默认 = 还原为内置关键词表</span>
        </div>`;
  }

  /** 保存分类规则：textarea 原文直接交给服务端解析（格式错误原样报 400 里的那句话） */
  async function saveBillCatRules(msg) {
    const el = document.querySelector('#main [data-mk="cat-rules"]')
      || document.querySelector('#modal-layer [data-mk="cat-rules"]');
    if (!el) return;
    try {
      await api('/api/bills/settings', { method: 'POST', body: { catRules: String(el.value || '') } });
      await refreshBills();
      render();
      toast(msg || '分类规则已保存', 'ok');
    } catch (err) { toast(err.message || '保存规则失败', 'err'); }
  }

  /** v4.18.0 需求 2：恢复默认 —— textarea 还原成内置规则原文，再走同一条保存链路落库 */
  async function resetBillCatRules() {
    const rep = (state.billMeta && state.billMeta.reports) || {};
    const el = document.querySelector('#main [data-mk="cat-rules"]')
      || document.querySelector('#modal-layer [data-mk="cat-rules"]');
    if (!el) return;
    el.value = String(rep.catRulesBuiltin || '');
    await saveBillCatRules('已恢复内置默认规则');
  }

  /** 分类与预算在「我的」折叠头的摘要 */
  function billCatSummary() {
    const { bmap } = billSetCtx();
    const cats = billCats('expense');
    const n = cats.filter((c) => bmap.has(c)).length;
    return n ? `${n} 个分类已设预算` : '还没有设置预算';
  }

  /* ── 记账页的交互动作 ─────────────────────────────────── */

  /** 三个数据源一起回读，最后只渲染一次（少两次无用重绘） */
  async function reloadBillAll() {
    await Promise.all([refreshBills(), refreshBillList(), refreshBillChat(), refreshBillServerDrafts()]);
    /* v4.22.0 需求 3：账单变了 → 日历缓存作废，下次进「日历查看」时重拉一次 */
    state.billCalLoaded = '';
    render();
  }

  function scrollBillChatToEnd() {
    const box = $('#bill-chat');
    if (box) box.scrollTop = box.scrollHeight;
  }

  /* 账单搜索是**服务端过滤**（账单可能多到一屏放不下，本地过滤会漏掉没加载的那些）。
     所以每敲一个字就发一次请求太浪费，按键停 320ms 再发。
     输入框本身在防抖期间不会被重绘 —— 它是 document.activeElement，
     最小重绘会主动跳过焦点所在的节点。 */
  let billQueryTimer = null;
  function billQueryDebounced() {
    if (billQueryTimer) clearTimeout(billQueryTimer);
    billQueryTimer = setTimeout(async () => {
      billQueryTimer = null;
      try { await refreshBillList(); render(); }
      catch (err) { toast(err.message || '搜索失败', 'err'); }
    }, 320);
  }

  /* ★ 「发出去以后把输入框清空」必须**显式**做，不能指望重绘去清：
     v2.0.0 换成了最小重绘，而 `<input>` 的 value 是 DOM **属性（property）**、
     不是标签属性（attribute）—— 改 value 不会体现在 outerHTML 里，
     于是 patchNode 对叶子节点「只比 outerHTML」这一步判定为「没变化」，
     原样留着刚发出去的那句话。搜索框的「清除」按钮早就踩过同一个坑（那边也是显式 el.value = ''）。 */
  function clearBillInput() {
    const inp = document.querySelector('[data-act="bill-text"]');
    if (inp) inp.value = '';
    preserveSkip = 'bill-text';          // 双保险：本次重绘别再把它回填回来
  }

  /* ★ v2.0.2（需求②）：把焦点拉回记账输入框 —— 在点击/回车的手势任务里同步执行，
     手机的系统键盘就不会收起；键盘一收一放正是「界面上下跳动」的来源。
     `preventScroll` 避免浏览器为对焦把页面滚一下（又一个跳动来源）。 */
  function keepBillFocus() {
    const inp = document.querySelector('[data-act="bill-text"]');
    if (!inp) return;
    try { inp.focus({ preventScroll: true }); } catch { inp.focus(); }
  }

  /**
   * 发一句话给服务端解析并入库。
   * @param {string} text
   * @param {{confirm?:boolean}} [opts] `confirm: true` = 用户已确认过「这是一笔重复，仍要记账」
   */
  async function billSendText(text, opts) {
    const o = opts || {};
    const t = String(text || '').trim();
    if (!t) { toast('先说一句吧，比如「今天买菜 30 元」', 'err'); return; }
    if (state.billSending) return;
    state.billSending = true;
    keepBillFocus();          // ★ 先抢回焦点再进入等待：此时还在用户手势任务里，键盘不会收
    render();
    try {
      const out = await api('/api/bills/chat', { method: 'POST', body: { text: t, confirm: !!o.confirm } });

      /* ★ 防误点重复：服务端发现「短时间内刚记过一笔相同方向、相同金额」时**不入库**，
         只回一个 needConfirm，由这里问一句 —— 用户确认后带 confirm 再发一次。
         此刻**不能清输入框**：用户若点「取消」，那句话还留在框里，方便改个数字再发。
         ★ v2.0.2 改成 await 重入：以前 `return billSendText(...)` 不等待，
         外层的 finally 会在内层还在飞行时把 billSending 提前复位，状态乱套。 */
      if (out.needConfirm) {
        state.billSending = false;
        const d = out.duplicate || {};
        const what = '支出';
        const where = [d.category, d.note].filter(Boolean).join(' · ');
        const go = window.confirm(
          `刚刚已经记过一笔相同的${what} ¥${fmtYuan(d.amountCents || 0)}${where ? `（${where}）` : ''}。\n\n确定要再记一笔吗？`,
        );
        if (!go) { render(); toast('已取消，没有重复记账'); return; }
        await billSendText(t, { confirm: true });
        return;
      }

      clearBillInput();
      // v4.0.0：本轮产生的气泡随响应带回 → 追加进本地缓存（需求 1：聊天不落库）
      appendBillChat(out.chat);
      // v4.3.2 需求 1：服务端说这笔与旧账高度相似 → 记下提示，render 时挂到页顶
      pushBillDupTip(out.bill, out.similar);
      if (!out.ok) {
        toast('这句话里没找到金额，换个说法试试', 'err');
      } else if (out.alert && out.alert.over) {
        toast(`「${out.alert.category}」本月已达预算 ¥${fmtYuan(out.alert.budgetCents)}`, 'err');
      }
      if (out.notice) toast(out.notice);
      await reloadBillAll();
      scrollBillChatToEnd();
    } catch (err) {
      toast(err.message || '记账失败', 'err');
    } finally {
      state.billSending = false;
      render();
      keepBillFocus();        // ★ 发送完成立刻把焦点还给输入框 → 键盘保持弹出，能连续录
    }
  }

  /* ── 截图识别（OCR） ───────────────────────────────────── */

  /**
   * 给 OCR 用的图片预处理（v4.0.0 需求 7：**压缩**以降 token；v4.3.0 需求 1：参数可配）。
   * AI 平台按 token 计费，分辨率越高 token 越多、识别也越慢，所以默认先缩再传：
   *   长边 1280px / 质量 0.75（金额小字仍可辨认），超过目标体积再逐级降。
   * ★ v4.3.0：这三项（长边 / 质量 / 目标体积）与「是否压缩」都由管理员在设置里调，
   *   服务端通过 /api/config 的 billOcrImage 下发 —— 改完立即生效，不必等发版。
   *   浏览器解不开（HEIC 等）且原图不超 4MB 时原样上传，识别总比报错强。
   */
  async function prepareOcrImage(file, raw) {
    const LIMIT = 4 * 1024 * 1024;
    const pref = (state.config && state.config.billOcrImage) || {};
    const compress = pref.compress !== false;               // 默认压
    const edge = Math.min(2400, Math.max(640, Number(pref.edge) || 1280));
    const quality = Math.min(0.95, Math.max(0.4, Number(pref.quality) || 0.75));
    const targetBytes = Math.min(4000, Math.max(200, Number(pref.kb) || 900)) * 1024;
    const isGif = /gif/i.test(String(file.type || '')) || /\.gif$/i.test(String(file.name || ''));
    if (isGif) return raw;                      // GIF 不动（浏览器解一帧会丢动画，OCR 也不吃）
    if (!compress) {
      // 管理员在设置里关掉了压缩：原图直传。这是他的选择，但超限时必须说清楚原因
      if (dataUrlBytes(raw) <= LIMIT) return raw;
      throw new Error('这张图超过 4MB，而设置里关闭了「上传前压缩图片」；请换小一点的图，或到设置里打开压缩');
    }
    const img = await decodeImage(raw).catch(() => null);
    if (!img) {
      if (dataUrlBytes(raw) <= LIMIT) return raw;
      throw new Error('这张图浏览器解不开，请换一张（iPhone 的 HEIC 请先在相册里导出为 JPG）');
    }
    const tries = [
      { edge, q: quality },
      { edge: Math.round(edge * 0.8), q: Math.max(0.4, quality - 0.05) },
      { edge: Math.round(edge * 0.625), q: Math.max(0.4, quality - 0.1) },
      { edge: Math.max(640, Math.round(edge * 0.5)), q: Math.max(0.4, quality - 0.15) },
    ];
    let smallest = '';
    for (const t of tries) {
      let out = '';
      try { out = encodeJpeg(img, t.edge, t.q); } catch { continue; }
      if (!smallest || out.length < smallest.length) smallest = out;
      if (dataUrlBytes(out) <= targetBytes) return out;   // 达到目标体积即可：再大纯烧 token
    }
    if (smallest && dataUrlBytes(smallest) <= LIMIT) return smallest;
    throw new Error('这张截图处理失败，请换一张');
  }

  function startBillOcr() {
    const f = $('#bill-ocr-file');
    if (f) f.click();
  }

  /**
   * 识别结果 → 打开「确认后入库」的弹窗（**不**自动写账）。
   * ★ v2.0.2（需求④）：用户上传的多数是账单列表截图，服务端现在会按行提取
   *   **全部**条目（`out.items`）。≥2 条 → 多条确认弹窗（勾选 + 逐条可改）；
   *   恰好 1 条 → 仍走旧的单条弹窗，但预填值来自逐行解析（备注更完整）；
   *   0 条 → 回退旧的整段解析，还认不出就让用户手填。
   */
  function openBillOcrConfirm(out) {
    const items = (out && out.items) || [];
    const p = (out && out.parsed) || {};
    if (items.length >= 2) {
      state.billOcrItems = {
        text: (out && out.text) || '',
        skippedIncome: (out && out.skippedIncome) || 0,
        rows: items.map((it) => ({
          on: true,
          amount: fmtYuan(it.amountCents),
          category: it.category || '其他',
          date: it.dateKey || todayKey(),
          note: it.note || '',
          platform: it.platform || '',
        })),
      };
      renderBillOcrItemsModal();
      return;
    }
    if (items.length === 1) {
      const it = items[0];
      state.billOcrDraft = {
        mode: 'ocr',
        text: (out && out.text) || '',
        kind: 'expense',
        amount: fmtYuan(it.amountCents),
        category: it.category || '其他',
        date: it.dateKey || todayKey(),
        note: it.note || '',
        platform: it.platform || '',
        parsedOk: true,
      };
      renderBillEditModal();
      return;
    }
    if (p.kind === 'income') { toast('识别到的是收入记录，已跳过（本应用只记支出）', 'err'); return; }
    state.billOcrDraft = {
      mode: 'ocr',
      text: (out && out.text) || '',
      kind: 'expense',
      amount: p.amountCents ? fmtYuan(p.amountCents) : '',
      category: p.category || '',
      date: p.dateKey || todayKey(),
      note: p.note || '',
      platform: p.platform || '',
      parsedOk: !!p.ok,
    };
    renderBillEditModal();
  }

  function openBillEdit(id) {
    const b = state.bills.filter((x) => x.id === id)[0];
    if (!b) return;
    state.billOcrDraft = {
      mode: 'edit',
      id: b.id,
      text: b.raw || '',
      kind: b.kind,
      amount: fmtYuan(b.amountCents),
      category: b.category,
      date: b.spentOn,
      note: b.note || '',
      platform: b.platform || '',
      parsedOk: true,
    };
    renderBillEditModal();
  }

  /** 把弹窗里当前的输入收进草稿（切收支类型、或直接保存时都要先收一次） */
  function collectBillDraft() {
    const d = state.billOcrDraft;
    if (!d) return;
    d.amount = modalValue('amount');
    d.category = modalValue('category');
    d.date = modalValue('date');
    d.note = modalValue('note');
    d.platform = modalValue('platform');
  }

  function renderBillEditModal() {
    const d = state.billOcrDraft;
    if (!d) return;
    const cats = billCats(d.kind);
    const cat = cats.indexOf(d.category) >= 0 ? d.category : (cats[0] || '其他');
    const isOcr = d.mode === 'ocr';
    /* v4.1.0：来自识别草稿箱的一条（'draft'）；
       v4.9.0：来自微信草稿箱的一条（'sdraft'）—— 两者共用这套表单，只有来源文案不同。 */
    const isDraft = d.mode === 'draft' || d.mode === 'sdraft';
    const isSdraft = d.mode === 'sdraft';
    const title = isOcr ? '确认识别结果'
      : (isSdraft ? '确认微信草稿入账' : (isDraft ? '确认草稿入账' : '编辑账单'));
    const raw = isOcr || (isDraft && d.text);
    openModal({
      title,
      body: `
        ${isOcr ? `<div class="note-box">识别结果<b>不会自动入库</b>，核对无误后点「确认记账」。金额、分类、日期都能直接改。</div>` : ''}
        ${isSdraft ? `<div class="note-box">这条来自<b>微信草稿箱</b>（微信里「存草稿」存的），核对无误后点「确认入账」，入账成功草稿会自动移除。</div>` : ''}
        ${isDraft && !isSdraft ? `<div class="note-box">这条来自<b>识别草稿箱</b>，核对无误后点「确认入账」，入账成功草稿会自动移除。</div>` : ''}
        ${raw ? `<div class="ocr-raw">${esc(d.text || '（没有识别到文字）')}</div>` : ''}
        <label class="field"><span>金额（元）</span>
          <input type="text" data-mk="amount" inputmode="decimal" maxlength="12"
                 value="${esc(d.amount)}" placeholder="例如 30.00"></label>
        <label class="field"><span>分类</span>
          <select data-mk="category">${cats.map((c) => `<option${c === cat ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
        <label class="field"><span>日期</span>
          <input type="date" data-mk="date" value="${esc(d.date)}"></label>
        <label class="field"><span>备注</span>
          <input type="text" data-mk="note" maxlength="60" value="${esc(d.note)}" placeholder="比如：超市买菜"></label>
        <label class="field"><span>交易平台（可选）</span>
          <input type="text" data-mk="platform" maxlength="20" value="${esc(d.platform || '')}" placeholder="比如：微信 / 支付宝"></label>
        ${!d.parsedOk ? '<div class="field-hint" style="color:var(--danger)">自动识别没找到金额，请手动填一个</div>' : ''}`,
      foot: `<button type="button" class="btn-ghost" data-act="bill-draft-cancel">取消</button>
             ${isOcr ? '<button type="button" class="btn-ghost" data-act="bill-draft-keep">存为草稿</button>' : ''}
             <button type="button" class="btn-primary" data-act="bill-draft-save">${
               isOcr ? '确认记账' : (isDraft ? '确认入账' : '保存修改')}</button>`,
    });
  }

  /** v4.1.0 需求 1：单条 OCR 结果也存进草稿箱（不入库）。 */
  function saveOcrSingleAsDraft() {
    const d = state.billOcrDraft;
    if (!d) return;
    collectBillDraft();
    appendBillDrafts([{
      amount: d.amount, category: d.category, note: d.note,
      platform: d.platform, date: d.date, text: d.text || '',
    }]);
    state.billOcrDraft = null;
    closeModal();
    render();
    toast('已存为草稿，空闲时在「识别草稿箱」里继续入账', 'ok');
  }

  /** v4.1.0 需求 1：从草稿箱打开一条草稿进编辑弹窗（确认后入账并自动删草稿）。 */
  function openBillDraft(id) {
    const r = state.billDrafts.find((x) => x.id === id);
    if (!r) { toast('这条草稿不存在了', 'err'); return; }
    state.billOcrDraft = {
      mode: 'draft', draftId: r.id, kind: 'expense',
      amount: r.amount, category: r.category, note: r.note,
      platform: r.platform || '', date: r.date || todayKey(),
      text: r.text || '', parsedOk: true,
    };
    renderBillEditModal();
  }

  async function saveBillDraft() {
    const d = state.billOcrDraft;
    if (!d) return;
    collectBillDraft();
    const yuan = Number(String(d.amount).replace(/[^\d.]/g, ''));
    if (!Number.isFinite(yuan) || yuan <= 0) { toast('请填写大于 0 的金额', 'err'); return; }
    const body = {
      kind: 'expense',        // ★ v2.0.2 只记支出（服务端也会拒绝 income）
      amount: yuan,
      category: d.category,
      note: d.note,
      platform: d.platform || '',
      spentOn: d.date,
    };
    try {
      if (d.mode === 'edit') {
        const out = await api('/api/bills/' + d.id, { method: 'PATCH', body });
        if (out.alert && out.alert.over) toast(`「${out.alert.category}」本月已达预算`, 'err');
        toast('已保存修改', 'ok');
      } else if (d.mode === 'sdraft') {
        /* v4.9.0 需求 1：微信草稿确认提交 —— 修改字段随请求带上，服务端一步完成
           「改字段 + insertBill + 草稿标记 submitted」。成功后从草稿箱移除。 */
        const out = await api('/api/bills/drafts', {
          method: 'POST',
          body: { id: d.draftId, amount: yuan, category: d.category, note: d.note, platform: d.platform || '', spentOn: d.date },
        });
        if (out.alert && out.alert.over) toast(`「${out.alert.category}」本月已达预算`, 'err');
        state.billServerDrafts = state.billServerDrafts.filter((x) => x.id !== d.draftId);
        toast('草稿已入账', 'ok');
      } else {
        const out = await api('/api/bills', { method: 'POST', body: { ...body, source: 'ocr', raw: d.text } });
        // v4.0.0：手动入库的系统气泡随响应带回 → 存进本地聊天缓存
        appendBillChat(out.chat);
        // v4.3.2 需求 1：疑似重复入账的提示（单条入账路径）
        pushBillDupTip(out.bill, out.similar);
        if (out.alert && out.alert.over) toast(`「${out.alert.category}」本月已达预算`, 'err');
        // v4.1.0：来自识别草稿箱的那条，入账成功后自动移除
        if (d.mode === 'draft') removeBillDraft(d.draftId);
        toast(d.mode === 'draft' ? '草稿已入账' : '已记账', 'ok');
      }
      state.billOcrDraft = null;
      closeModal();
      await reloadBillAll();
      scrollBillChatToEnd();
    } catch (err) { toast(err.message || '保存失败', 'err'); }
  }

  /* ── v2.0.2（需求④）：多条识别结果的确认弹窗 ─────────────── */

  /** 把弹窗里当前每行的勾选/输入收进草稿（勾选变化重绘前、保存前都要先收一次） */
  function collectOcrItems() {
    const d = state.billOcrItems;
    if (!d) return;
    d.rows.forEach((r, i) => {
      r.on = modalChecked(`oi-on-${i}`);
      r.amount = modalValue(`oi-amt-${i}`);
      r.date = modalValue(`oi-date-${i}`);
      r.note = modalValue(`oi-note-${i}`);
      r.category = modalValue(`oi-cat-${i}`);
      r.platform = modalValue(`oi-plat-${i}`);
    });
  }

  function renderBillOcrItemsModal() {
    const d = state.billOcrItems;
    if (!d) return;
    const cats = billCats('expense');
    const rows = d.rows.map((r, i) => `
      <div class="ocr-item${r.on ? '' : ' off'}">
        <label class="oi-check" title="勾选后才会计入账">
          <input type="checkbox" data-mk="oi-on-${i}" ${r.on ? 'checked' : ''}>
        </label>
        <div class="oi-main">
          <input type="text" class="oi-note" data-mk="oi-note-${i}" maxlength="60"
                 value="${esc(r.note)}" placeholder="备注（可改）">
          <div class="oi-fields">
            <input type="text" class="oi-amt" data-mk="oi-amt-${i}" inputmode="decimal" maxlength="12"
                   value="${esc(r.amount)}" placeholder="金额">
            <input type="date" class="oi-date" data-mk="oi-date-${i}" value="${esc(r.date)}">
            <select class="oi-cat" data-mk="oi-cat-${i}">${cats.map((c) => `<option${c === r.category ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>
            <input type="text" class="oi-plat" data-mk="oi-plat-${i}" maxlength="20"
                   value="${esc(r.platform || '')}" placeholder="平台">
          </div>
        </div>
      </div>`).join('');
    const n = d.rows.filter((r) => r.on).length;
    openModal({
      title: `确认识别结果（${d.rows.length} 笔）`,
      body: `
        <div class="note-box">从截图里识别到 <b>${d.rows.length}</b> 笔支出${
          d.skippedIncome ? `，另有 ${d.skippedIncome} 笔收入已跳过（只记支出）` : ''}。
          <b>不会自动入库</b>：勾选要记的、改好金额备注，再点下面的按钮一次性入账。</div>
        <div class="ocr-items">${rows}</div>
        ${d.text ? `<details class="ocr-raw-details"><summary>原始识别文字</summary><div class="ocr-raw">${esc(d.text)}</div></details>` : ''}`,
      foot: ocrItemsFootHtml(),
    });
  }

  /** 弹窗底部按钮（文案里带勾选笔数）。抽出来是为了勾选时能**原地刷新**而不是重挂弹窗 */
  function ocrItemsFootHtml() {
    const d = state.billOcrItems;
    const n = d ? d.rows.filter((r) => r.on).length : 0;
    return `<button type="button" class="btn-ghost" data-act="bill-draft-cancel">取消</button>
             <button type="button" class="btn-ghost" data-act="bill-ocr-items-draft"${n ? '' : ' disabled'}>${
               n ? `存为草稿（${n} 笔）` : '请先勾选条目'}</button>
             <button type="button" class="btn-primary" data-act="bill-ocr-items-save"${n ? '' : ' disabled'}>${
               n ? `确认记账（${n} 笔）` : '请先勾选条目'}</button>`;
  }

  /** v4.3.1 需求 3：只换底部按钮的文案/禁用态，弹窗与输入框一个都不动（消除抖动） */
  function syncOcrItemsFoot() {
    const foot = $('#modal-layer .modal-foot');
    if (foot) foot.innerHTML = ocrItemsFootHtml();
  }

  /** v4.1.0 需求 1：把勾选的条目整批存进「识别草稿箱」（不入库），空闲时再逐条修改入账。 */
  function saveBillOcrItemsAsDrafts() {
    const d = state.billOcrItems;
    if (!d) return;
    collectOcrItems();
    const rows = d.rows.filter((r) => r.on);
    if (!rows.length) { toast('先勾选要存草稿的条目', 'err'); return; }
    appendBillDrafts(rows.map((r) => ({
      amount: r.amount, category: r.category, note: r.note,
      platform: r.platform, date: r.date, text: d.text,
    })));
    state.billOcrItems = null;
    closeModal();
    render();
    toast(`已存 ${rows.length} 条草稿，空闲时在「识别草稿箱」里继续入账`, 'ok');
  }

  /** 把勾选的条目逐笔入库。逐笔而不是批量接口：复用既有的预算提醒 / 聊天气泡逻辑。 */
  async function saveBillOcrItems() {
    const d = state.billOcrItems;
    if (!d) return;
    collectOcrItems();
    const rows = d.rows.filter((r) => r.on);
    if (!rows.length) { toast('先勾选要记账的条目', 'err'); return; }
    let done = 0;
    const failed = [];
    for (const r of rows) {
      const yuan = Number(String(r.amount).replace(/[^\d.]/g, ''));
      if (!Number.isFinite(yuan) || yuan <= 0) { failed.push(`「${r.note || '未命名'}」金额不对`); continue; }
      try {
        const out = await api('/api/bills', {
          method: 'POST',
          body: { kind: 'expense', amount: yuan, category: r.category, note: r.note, platform: r.platform,
            spentOn: r.date, source: 'ocr', raw: d.text },
        });
        appendBillChat(out.chat);   // v4.0.0：气泡随响应带回，存本地缓存
        // v4.3.2 需求 1：批量入账时逐条收集疑似重复 —— 提示条会把它们并排列出来
        pushBillDupTip(out.bill, out.similar);
        done++;
      } catch (err) { failed.push(`「${r.note || '未命名'}」：${err.message || '保存失败'}`); }
    }
    state.billOcrItems = null;
    closeModal();
    await reloadBillAll();
    scrollBillChatToEnd();
    if (failed.length) toast(`已入账 ${done} 笔，${failed.length} 笔失败：${failed[0]}`, 'err');
    else toast(`已一次记入 ${done} 笔支出`, 'ok');
  }

  /* ── 导出 CSV ─────────────────────────────────────────── */

  function openBillExport() {
    openModal({
      title: '导出账单 CSV',
      body: `
        <div class="note-box">标准 CSV（UTF-8 带 BOM），Excel / WPS 双击打开不乱码。
          字段：日期、记账人、分类、备注、金额(元)、记账方式。</div>
        <label class="field"><span>起始日期（留空 = 不限）</span>
          <input type="date" data-mk="from" value="${esc(state.billFrom)}"></label>
        <label class="field"><span>结束日期（留空 = 不限）</span>
          <input type="date" data-mk="to" value="${esc(state.billTo)}"></label>
        <label class="field"><span>导出范围</span>
          <select data-mk="scope">
            <option value="all">全家（所有人记的账）</option>
            <option value="mine">只看我的</option>
          </select></label>`,
      foot: `<button type="button" class="btn-ghost" data-act="modal-close">取消</button>
             <button type="button" class="btn-primary" data-act="bill-export-go">下载</button>`,
    });
  }

  function doBillExport() {
    const from = modalValue('from');
    const to = modalValue('to');
    const scope = modalValue('scope') || 'all';
    state.billFrom = from;
    state.billTo = to;
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    qs.set('scope', scope);
    closeModal();
    // 服务端会带 Content-Disposition: attachment，所以这个链接只会触发下载，
    // 不会把用户从当前页面带走
    const a = document.createElement('a');
    a.href = assetUrl('/api/bills/export.csv?' + qs.toString());
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('已开始下载账单 CSV', 'ok');
  }

  /* ── 管理员：分类与预算 ───────────────────────────────── */

  async function addBillCategory(kind) {
    const key = 'newcat-' + kind;
    const name = modalValue(key);
    if (!String(name || '').trim()) { toast('请先填分类名称', 'err'); return; }
    try {
      const out = await api('/api/bills/categories', { method: 'POST', body: { kind, name } });
      state.billMeta.categories = out.categories;
      clearField(key);            // 加完把输入框清空，免得看起来像「没生效」又点一次
      render();
      toast('分类已添加', 'ok');
    } catch (err) { toast(err.message || '添加失败', 'err'); }
  }

  async function delBillCategory(kind, name) {
    if (!window.confirm(`确定删除分类「${name}」吗？\n\n该分类下已记的账会被移到第一个分类，账单本身不会丢。`)) return;
    try {
      const out = await api('/api/bills/categories/delete', { method: 'POST', body: { kind, name } });
      state.billMeta.categories = out.categories;
      await refreshBills();
      render();
      toast(`已删除分类（${out.moved} 笔账单已转到别的分类）`, 'ok');
    } catch (err) { toast(err.message || '删除失败', 'err'); }
  }

  async function saveBillBudgets() {
    const inputs = $$('#main [data-act="bill-budget"]');
    try {
      for (const inp of inputs) {
        const raw = String(inp.value || '').trim();
        const n = raw === '' ? 0 : Number(raw.replace(/[^\d.]/g, ''));
        if (!Number.isFinite(n) || n < 0) throw new Error(`「${inp.dataset.cat}」的预算要填数字`);
        await api('/api/bills/budgets', { method: 'POST', body: { category: inp.dataset.cat, amount: n } });
      }
      await refreshBills();
      // 保存完把下拉的选择清掉：那一行已经变成「已设预算」，不该继续留在下拉旁的待填行
      state.billBudgetPick = '';
      render();
      toast('预算已保存', 'ok');
    } catch (err) { toast(err.message || '保存预算失败', 'err'); }
  }

    /**
   * 保存 AI 平台配置 + 识别参数（v4.3.0 需求 1；v4.24.0 通用化）。
   * 一次提交全部字段：接口地址 / 模型 ID（自由填写）、密钥（留空 = 不改），以及体验参数。
   * 数值范围交给服务端校验（前端只负责「非空就发」），非法值会当场报错而不是静默回落 ——
   * 「保存成功了但值坏了」比保存失败更糟。
   */
  async function saveBillAi() {
    const key = String(modalValue('aiKey') || '').trim();
    const vl = String(modalValue('aiVlModel') || '').trim();
    const num = (k, def) => {
      const raw = String(fieldValue(k) || '').trim();
      return raw === '' ? def : Number(raw);
    };
    const body = {
      aiVlModel: vl,
      // v4.24.0 需求 1：通用平台三件套之一 —— 接口地址（OpenAI 兼容端点）
      aiBaseUrl: String(fieldValue('aiBaseUrl') || '').trim(),
      /* v4.25.0 需求 3：思考模式 / 思考预算 / 最大输出 / 采样温度不再提交 ——
         它们已退化成服务端常量（关思考 / 1024 / 0）。 */
      aiTimeoutMs: Math.round(num('aiTimeoutS', 60) * 1000),
      aiRetry: num('aiRetry', 1),
      aiFallback: fieldChecked('aiFallback'),
      aiCategoryMode: String(fieldValue('aiCategoryMode') || 'auto'),
      aiImgCompress: fieldChecked('aiImgCompress'),
      aiImgEdge: num('aiImgEdge', 1024),
      aiImgQuality: num('aiImgQuality', 0.7),
      aiImgKb: num('aiImgKb', 480),
      // v4.3.1 需求 4：提示词两项（分类条数 + 自定义模板）
      aiCatHint: num('aiCatHint', 8),
      aiPromptCustom: String(fieldValue('aiPromptCustom') || ''),
    };
    if (key) body.aiKey = key;
    /* v4.3.1：整个「截图识别」卡片只剩一个「保存」按钮（原来模型/参数各一个，容易漏点）。
       参数永远有值可提交，所以不再拦「没填东西」—— 只改参数、不动密钥也能保存。 */
    try {
      const out = await api('/api/bills/settings', { method: 'POST', body });
      await refreshBills();
      clearField('aiKey');        // 密钥不留在屏幕上
      clearField('aiVlModel');    // 值由服务端回读重绘，免得输入框里残留旧值造成误会
      render();
      const warn = (out && out.settings && out.settings.warning) || '';
      toast(warn || '配置已保存', warn ? 'err' : 'ok');
    } catch (err) { toast(err.message || '保存失败', 'err'); }
  }

  async function clearBillAi() {
    if (!window.confirm('清空后截图识别会立刻停用（一句话记账是本地解析，不受影响）。确定吗？')) return;
    try {
      await api('/api/bills/settings', { method: 'POST', body: { clearAiKey: true } });
      await refreshBills();
      render();
      toast('已清空 API Key', 'ok');
    } catch (err) { toast(err.message || '清空失败', 'err'); }
  }

  /** @returns {Promise<boolean>} 成功 true、失败 false —— 失败时调用方要把输入框还原 */
  async function saveBillDailyTime(value) {
    try {
      await api('/api/bills/settings', { method: 'POST', body: { dailyTime: value } });
      await refreshBills();
      render();
      toast('推送时间已保存', 'ok');
      return true;
    } catch (err) { toast(err.message || '保存失败', 'err'); return false; }
  }

  async function toggleBillSetting(key, label) {
    const r = (state.billMeta && state.billMeta.reports) || {};
    const body = {};
    if (key === 'reportsEnabled') body.reportsEnabled = !r.reportsEnabled;
    if (key === 'monthlyReport') body.monthlyReport = !r.monthlyReport;
    try {
      await api('/api/bills/settings', { method: 'POST', body });
      await refreshBills();
      render();
      paintBillPushForm();          // v4.16.0：弹窗开着时就地重绘，勾完立刻看到新文案
      toast(`${label}已${(key === 'reportsEnabled' ? !r.reportsEnabled : !r.monthlyReport) ? '开启' : '关闭'}`, 'ok');
    } catch (err) { toast(err.message || '保存失败', 'err'); }
  }

  async function testBillReport() {
    try {
      const out = await api('/api/bills/report/test', { method: 'POST', body: {} });
      await refreshBills();
      render();
      paintBillPushForm();
      if (out.skipped) toast(`未发送：${out.skipped}`, 'err');
      else toast(`已发送 ${out.mails} 封记账报表`, 'ok');
    } catch (err) { toast(err.message || '发送失败', 'err'); }
  }

  /** v4.16.0 需求 4：报表额外抄送名单已下线（收件人只看账号映射 + 各自推送方式） */

  /* ═══ v4.0.0：快捷短语自定义 / AI 开关与额度 / 日报时机 / 模型列表 / 调用日志 ═══ */

  /** 快捷短语编辑弹窗：点短语删掉、输入框加新的、可一键恢复出厂例句 */
  function openBillQuickEditor() {
    const quick = (state.billQuick && state.billQuick.length) ? state.billQuick : DEFAULT_BILL_QUICKS;
    openModal({
      title: '自定义快捷短语',
      body: `
        <div class="note-box">点一下短语就删掉；输入新的再点「添加」。最多 8 条、每条 30 字。
          短语按人保存，换设备也还在。</div>
        <div class="chips cats-row" id="quick-edit-list">
          ${quick.map((t) => `<button type="button" class="chip chip-del" data-act="bill-quick-del" data-text="${esc(t)}" title="点击删除">${esc(t)} ✕</button>`).join('')}
        </div>
        <label class="field"><span>新增短语</span>
          <input type="text" data-mk="new-quick" maxlength="30" placeholder="比如：停车费 15"></label>`,
      foot: `<button type="button" class="btn-ghost" data-act="modal-close">关闭</button>
             <button type="button" class="btn-ghost" data-act="bill-quick-reset">恢复出厂例句</button>
             <button type="button" class="btn-primary" data-act="bill-quick-add">添加</button>`,
    });
  }

  async function addBillQuick() {
    const v = modalValue('new-quick');
    const list = (state.billQuick && state.billQuick.length) ? state.billQuick.slice() : DEFAULT_BILL_QUICKS.slice();
    if (!String(v || '').trim()) { toast('先输入短语内容', 'err'); return; }
    list.push(v.trim());
    await saveBillQuick(list);
    if (state.billQuick.length >= 8) toast('最多 8 条，超出的没有保存', 'err');
    openBillQuickEditor();   // 重开弹窗（列表已刷新、输入框清空）
    clearField('new-quick');
  }

  async function delBillQuick(text) {
    const list = (state.billQuick && state.billQuick.length) ? state.billQuick.filter((t) => t !== text) : [];
    await saveBillQuick(list);
    openBillQuickEditor();
  }

  async function saveBillQuick(list) {
    try {
      const out = await api('/api/bills/quick', { method: 'POST', body: { phrases: list } });
      state.billQuick = out.quick || [];
      render();
      toast('快捷短语已保存', 'ok');
    } catch (err) { toast(err.message || '保存失败', 'err'); }
  }

  /** 日报内容：当天 or 第二天发前一天 */
  async function saveBillWhen(v) {
    try {
      await api('/api/bills/settings', { method: 'POST', body: { reportWhen: v } });
      /* v4.17.0 需求 1：推送时间跟着日报口径走 ——
         「当天发当天」= 报告发出时当天的账还没记完，太早发出去必然是半天的账 → 21:00；
         「第二天发前一天」= 发的是完整的昨天，早上就能看 → 07:00。
         只在「当前值 ≠ 目标值」时才动，用户手动改过的时间只在切口径那一刻被带回。 */
      const wantTime = v === 'same_day' ? '21:00' : '07:00';
      let timeNote = '';
      {
        const cur = ((state.billMeta && state.billMeta.reports) || {}).dailyTime || '21:00';
        if (cur !== wantTime) {
          await api('/api/bills/settings', { method: 'POST', body: { dailyTime: wantTime } });
          timeNote = `，推送时间也从 ${cur} 调成 ${wantTime}`;
        }
      }
      await refreshBills();
      render();
      paintBillPushForm();
      toast((v === 'same_day' ? '日报改为「当天到点发当天的」' : '日报改为「第二天发前一天的」') + timeNote, 'ok');
    } catch (err) { toast(err.message || '保存失败', 'err'); }
  }

  /** AI 总开关 */
  async function toggleAiEnabled() {
    const r = (state.billMeta && state.billMeta.reports) || {};
    try {
      await api('/api/bills/settings', { method: 'POST', body: { aiEnabled: !r.aiEnabled } });
      await refreshBills();
      render();
      toast(!r.aiEnabled ? 'AI 功能已开启' : 'AI 功能已停用（一句话记账自动降级本地解析）', 'ok');
    } catch (err) { toast(err.message || '保存失败', 'err'); }
  }

  /** 月度额度上限（change 事件里即时保存，失败还原输入框） */
  async function saveAiLimit(value, input) {
    const old = String(((state.billMeta || {}).reports || {}).aiMonthlyLimit || 1000);
    try {
      await api('/api/bills/settings', { method: 'POST', body: { aiMonthlyLimit: Number(value) } });
      await refreshBills();
      render();
      toast('AI 月度额度已保存', 'ok');
      return true;
    } catch (err) {
      toast(err.message || '保存失败', 'err');
      if (input) input.value = old;
      return false;
    }
  }

  /** 一键获取最新模型及价格列表（需求 8） */
  /** 展开**本月** AI 调用日志（v4.2.0 需求 3：服务端按自然月过滤，跨月自动清空显示） */
  async function loadAiLogs() {
    try {
      const out = await api('/api/bills/ai-logs?limit=100');
      state.billAiLogs = out.logs || [];
      render();
      if (!state.billAiLogs.length) toast(`${out.month || '本月'}还没有调用记录`);
    } catch (err) { toast(err.message || '读取日志失败', 'err'); }
  }

  /** 收起日志面板（需求 3：展开、收起两个按钮都要有） */
  function closeAiLogs() {
    state.billAiLogs = null;
    render();
  }

  /* ═══ 我的 ═══════════════════════════════════════════════ */

  /* v2.0.0（需求 7）：通知设置的中文名与摘要文案。
     「我的」页面光给一个「设置」按钮是不够的 —— 用户必须能一眼看出
     「我现在到底收不收、什么时候会静音」，否则每次都要点进去确认。 */
  const NOTIFY_KIND_CN = { todo: '待办', post: '动态', record: '记录本', comment: '评论' };

  function kindListCn(raw) {
    const all = Object.keys(NOTIFY_KIND_CN);
    if (raw === undefined || raw === null || raw === '') return '全部类型';
    const picked = String(raw).split(',').map((s) => s.trim()).filter((s) => all.includes(s));
    if (!picked.length) return '不接收任何类型';
    return picked.map((k) => NOTIFY_KIND_CN[k]).join('、');
  }

  function quietText(s, e) {
    return (s && e) ? `免打扰 ${s}–${e}` : '未设免打扰';
  }

  /** 「待办提醒」/「内容通知」两行右侧的现状摘要 */
  function prefsSummary(which) {
    const p = state.prefs || {};
    const g = state.prefsGlobal || {};
    const no = '<span class="pref-off">已关闭</span>';

    /* v4.13.0（问题 9）：管理员的这一行显示的是**全家默认**（他自己改的就是它），
       不再出现「我的」与「家庭默认」两套说法。 */
    if (state.me && state.me.is_admin) {
      if (which === 'remind') {
        if (g.remindEnabled === false) return `${no} · 全家都不再提醒`;
        const at = String(g.remindDefaultTime || '08:00');
        const adv = Number(g.advanceDays) || 0;
        return `全家默认 · ${adv > 0 ? `提前 ${adv} 天提醒` : '当天'} ${at}`;
      }
      if (g.notifyOnChange === false) return `${no} · 全家都不再通知`;
      /* v4.14.0 需求 4：不再有「汇总到 HH:MM」，
         只剩「变更即发 / 免打扰结束后合并一封」两种。 */
      return `全家默认 · ${kindListCn(g.notifyKinds)}`
        + (g.notifyQuietStart && g.notifyQuietEnd
          ? ` · 免打扰 ${g.notifyQuietStart}–${g.notifyQuietEnd} 后合并`
          : ' · 变更即发');
    }

    if (which === 'remind') {
      if (p.remind_enabled === '0') return `${no}（仅影响我自己）`;
      const q = quietText(p.remind_quiet_start, p.remind_quiet_end);
      const base = g.remindEnabled === false
        ? '<span class="pref-off">管理员已整体关闭</span>'
        : '开启';
      const mine = p.remind_enabled === '1' ? '（我单独设为开启）' : '';
      return `${base}${mine} · ${q}`;
    }

    if (p.notify_on_change === '0') return `${no}（仅影响我自己）`;
    const base = g.notifyOnChange === false
      ? '<span class="pref-off">管理员已整体关闭</span>'
      : `开启 · ${kindListCn(p.notify_kinds)}`;
    const mine = p.notify_on_change === '1' ? '（我单独设为开启）' : '';
    return `${base}${mine} · ${quietText(p.notify_quiet_start, p.notify_quiet_end)}`;
  }

  /**
   * v4.7.0 需求 2：主动提醒的推送通道。
   * 说明必须写清「企业微信发不出去时会回退邮件」——不然用户以为选了企业微信就一定收得到。
   */
  /* v4.8.0 需求 4/5：默认策略从「只用邮件」改成「优先企业微信、邮件兜底」。
     v4.13.0（问题 7）：新增 **仅企业微信**（wecom）。
     ★ 'wecom' 以前是 v4.7.0 的旧值、被折成 'auto'；现在它是正式通道，
       所以别名表清空 —— 再折一次会把「仅企业微信」显示成「智能」。 */
  const PUSH_LABEL = {
    auto: '智能（优先企业微信）',
    wecom: '仅企业微信',
    feishu: '飞书群',
    dingtalk: '钉钉群',
    mail: '邮件',
    both: '邮件 + 企业微信',
  };
  const PUSH_ALIAS = {};
  function pushChannelOf(me) {
    let v = String((me && me.push_channel) || 'auto');
    if (PUSH_ALIAS[v]) v = PUSH_ALIAS[v];
    return PUSH_LABEL[v] ? v : 'auto';
  }
  /** 这个人的企业微信到底通不通 —— 状态必须写在界面上，否则「选了智能却走邮件」没法解释 */
  function pushInfoOf(me) {
    const info = (me && me.push_info) || {};
    return { bound: !!info.bound, ready: !!info.ready, wecomUser: String(info.wecomUser || '') };
  }
  function pushChannelSummary(me) {
    const ch = pushChannelOf(me);
    const { bound, ready } = pushInfoOf(me);
    const noMail = !(me && me.notify_email);
    if (ch === 'mail') {
      return '当前：只用邮件' + (noMail ? ' · 还没设置收件邮箱，邮件发不出去' : '');
    }
    const wx = !ready ? '企业微信应用未启用'
      : !bound ? '你还没绑定企业微信账号'
        : '企业微信已绑定';
    if (ch === 'both') return `当前：邮件 + 企业微信 · ${wx}，两条都发`;
    if (ch === 'wecom') {
      return ready && bound
        ? '当前：仅企业微信 · 已绑定，失败也不会转成邮件'
        : `当前：仅企业微信 · ${ready ? '你还没绑定企业微信账号' : '企业微信应用未启用'}，这期间收不到提醒`;
    }
    /* v4.24.0 需求 2：飞书 / 钉钉是「群 Webhook」通道 —— 没有个人绑定，
       能不能收只取决于管理员配没配好机器人。 */
    const hookState = (name) => {
      const st = state.settings || null;   // 只有管理员拉得到 /api/settings；成员看不到配置细节
      if (!st) return `${name}群机器人由管理员在「推送渠道设置」里配置，没配好之前收不到`;
      const stt = name === '飞书' ? st.feishuStatus : st.dingtalkStatus;
      if (!stt || !stt.configured) return `管理员还没配置${name}群机器人，这期间收不到提醒`;
      return `管理员已配置${name}群机器人，消息会发到群里`;
    };
    if (ch === 'feishu') return `当前：飞书群 · ${hookState('飞书')}，失败不会转成邮件`;
    if (ch === 'dingtalk') return `当前：钉钉群 · ${hookState('钉钉')}，失败不会转成邮件`;
    return `当前：智能 · ${wx}${bound && ready ? '，提醒优先发到企业微信' : '，现在会走邮件'}；发不出去会自动回退邮件`;
  }

  /**
   * v4.5.0 需求 5：企业微信区块（仅管理员）。
   * 单独抽出来是为了让 meHtml 的结构一眼能看清「有哪几组设置」，
   * 而不是让企业微信的七八行把「我的」页面撑成一锅粥。
   */
  /**
   * ★ v4.28.1 需求 1：账号映射框默认把**所有家庭成员**列出来。
   *
   * 界面上的一行是「家庭账号=企业微信 UserID」—— 左边自动填好、右边留空等管理员填，
   * 打开就知道还差谁没绑；数据库里存的仍是历史上那一套 `企微UserID=家庭账号`
   * （服务端 normalizeUserMap / userMapOf 一行都没动），只有界面上的左右顺序是反的。
   *
   * 已不在家庭里的账号（成员被删过）不再列出来 —— 那种映射本来也认不到人，
   * 留着只会让人以为「这个配置还有用」。
   */
  function wecomMapText(w) {
    const bound = new Map();          // username(小写) → 企微 UserID
    for (const line of String((w && w.userMap) || '').split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i <= 0) continue;
      const wx = line.slice(0, i).trim();
      const fam = line.slice(i + 1).trim().replace(/^@/, '');
      if (wx && fam) bound.set(fam.toLowerCase(), wx);
    }
    return (state.members || [])
      .filter((m) => m && m.username)
      .map((m) => `${m.username}=${bound.get(String(m.username).toLowerCase()) || ''}`)
      .join('\n');
  }

  /* v4.12.0：企业微信从「我的页里独立一张卡」改成「推送配置」里的展开区，
     所以这里只产出内容（不带 <section> 外壳）。 */
  function wecomSectionInner() {
    const w = state.wecom;
    const statusText = !w ? '读取中…'
      : w.ready ? '已连接'
        : w.enabled ? '配置不完整' : '推送开关已关闭';
    const statusCls = w && w.ready ? 'pref-on' : 'pref-off';
    // 反代 / 飞牛网关下页面被挂在子路径上时，回调地址也要带同样的前缀，
    // 否则企业微信打过来会 404。基址来自 meta[name=fh-base]（见文件顶部 API_BASE）。
    const base = API_BASE;
    const cb = `${location.origin}${base}/api/wecom/callback`;
    const bondN = w ? Number(w.bondCount) || 0 : 0;
    /* ★ v4.16.0 需求 4：这一块按需求重排 ——
       · 没有「一句话记账」那一行了，绑定状态挪到**账号映射输入框正下方**；
       · 账号映射整块移到**回调地址上方**（它是「认人」的唯一依据，比地址更常改）；
       · 没有「默认记账账号」：记到谁名下只看映射表；
       · 没有「日报/月报同时推送到企业微信」：报表跟提醒一样遵循各自的推送方式；
       · 没有「启用企业微信接入」：推送渠道设置里的「企业微信推送」是唯一开关。 */
    return `
        <div class="row-list">
          <div class="row">
            <div class="r-label"><b>接入配置</b>
              <small>企业 ID / AgentId / Secret / Token / EncodingAESKey</small></div>
            <div class="row-ops">
              <span class="${statusCls}">${statusText}</span>
              <button type="button" class="btn-soft btn-sm" data-act="wecom-settings">配置</button>
            </div>
          </div>
          <div class="row row-stack">
            <div class="r-label"><b>账号映射</b>
              <small>左边是家庭账号（已自动列好），右边填 TA 在企业微信里的 UserID；留空 = 还没绑定。
                记账记到谁名下、报表推给谁，都只看这张表。</small></div>
            <!-- ★ v4.28.1：映射框里只有登录账号（英文），管理员未必记得谁是谁 ——
                 框上面补一行「账号 = 昵称」的对照，看一眼就知道该给哪一行填。
                 位置特意在输入框**之前**：绑定状态那句仍紧贴输入框下方，不挤走它。 -->
            <div class="wecom-map-legend">${(state.members || [])
              .map((m) => `${esc(m.username)} = ${esc(m.display_name)}`).join(' · ')}</div>
            <textarea class="wecom-map" data-mk="wc-map-inline" spellcheck="false"
                      rows="${Math.min(12, Math.max(3, (state.members || []).length + 1))}"
                      placeholder="alice=zhangsan&#10;bob=lisi">${esc(wecomMapText(w))}</textarea>
            <div class="wecom-map-state">
              <span class="${statusCls}">${bondN ? `已绑定 ${bondN} 个账号` : '还没绑定任何账号'}</span>
              <span class="wms-hint">${bondN
                ? '家人发消息、收报表都会按这里的对应关系认人。'
                : 'UserID 在企业微信管理后台「通讯录 → 成员 → 账号」里看；填好保存即可。'}</span>
            </div>
            <div class="row-ops">
              <button type="button" class="btn-soft btn-sm" data-act="wecom-map-save">保存映射</button>
            </div>
          </div>
          <div class="row">
            <div class="r-label"><b>回调地址</b>
              <small class="wecom-cb">${esc(cb)}<br>需企业微信服务器能访问到（内网穿透或公网域名）</small></div>
          </div>
        </div>
        <div class="sec-note-box"><div class="note-box">
          配好后，家人在企业微信里发「今天买菜 30 元」就能记账，发图也能识别；
          报表与催办走上面「推送方式」里给每个人选的那条通道。
        </div></div>`;
  }

  /* ── v4.5.0 需求 5：企业微信配置弹窗 ─────────────────── */

  /** 拉取企业微信配置状态（仅管理员调用；失败静默，不能影响「我的」页面渲染） */
  async function refreshWecom() {
    if (!state.me || !state.me.is_admin) return;
    try {
      const out = await api('/api/wecom');
      state.wecom = out.wecom;
    } catch {
      state.wecom = null;
    }
  }

  /* v4.10.0（差异 #42）：「关于与系统状态」的数据（进「我的」页时随其它数据一起拉） */
  async function refreshSystemStatus() {
    if (!state.me) return;
    try {
      state.systemStatus = await api('/api/me/system-status');
    } catch {
      state.systemStatus = null;
    }
  }

  /* ── v4.5.0 需求 5：企业微信配置弹窗 ───────────────────
     v4.16.0 需求 4：这个弹窗只留**接入凭证**五项。
     账号映射、回调地址、开关都搬到页面上的「企业微信推送」折叠区里了 ——
     一个弹窗里塞七件事，改个映射还得先找到「配置」按钮，是这次要修的主要毛病。 */
  function openWecomForm() {
    const w = state.wecom || {};
    openModal({
      title: '企业微信接入',
      body: `
        <div class="note-box">
          在企业微信管理后台建一个「自建应用」，把下面这些填进去；
          <b>接收消息</b>的 URL 与账号映射在外面的折叠区里设置。
        </div>
        <label class="field"><span>企业 ID（CorpId）</span>
          <input type="text" data-mk="wc-corp" maxlength="64" value="${esc(w.corpId || '')}" placeholder="ww 开头的一串字符"></label>
        <label class="field"><span>应用 AgentId</span>
          <input type="text" data-mk="wc-agent" maxlength="20" value="${esc(w.agentId || '')}" placeholder="纯数字，例如 1000002"></label>
        <label class="field"><span>应用 Secret</span>
          <input type="password" data-mk="wc-secret" maxlength="128" value=""
                 placeholder="${w.hasSecret ? '已保存，留空表示不修改' : '填应用详情里的 Secret'}"></label>
        <label class="field"><span>Token</span>
          <input type="text" data-mk="wc-token" maxlength="32" value="${esc(w.token || '')}" placeholder="接收消息设置里自己填的 Token"></label>
        <label class="field"><span>EncodingAESKey</span>
          <input type="text" data-mk="wc-aes" maxlength="43" value="${esc(w.aesKey || '')}" placeholder="43 位，点「随机获取」生成"></label>

        <!-- v4.24.0 需求 3：可信 IP 代理 —— 服务器 IP 不固定 / 在 NAT 后时，
             改走一台固定出口 IP 的中转服务器（nginx 反代，或零依赖 Node 转发脚本）。
             部署说明随「开源前整理」从仓库里移除了，界面这里也不再指向任何文档路径。 -->
        <label class="check-line" style="margin-top:10px;">
          <input type="checkbox" data-mk="wc-proxy-on"${w.proxyEnabled ? ' checked' : ''}>
          <span><b>启用可信 IP 代理</b>（把对企微 API 的请求经固定出口 IP 的中转服务器转发）</span></label>
        <label class="field"><span>代理地址<span class="field-hint">（中转机上的反代基址，转发到 qyapi.weixin.qq.com）</span></span>
          <input type="text" data-mk="wc-proxy-url" maxlength="300" value="${esc(w.proxyUrl || '')}"
                 placeholder="例如 https://relay.example.com/wecom"></label>
        <label class="field"><span>代理鉴权 Token</span>
          <input type="password" data-mk="wc-proxy-token" maxlength="128" value=""
                 placeholder="${w.hasProxyToken ? '已保存，留空表示不修改' : '自定义一串随机字符，中转机用它校验请求'}"></label>
        <div class="note-box">
          启用后：白名单里只需填<b>中转服务器的固定 IP</b>，家里服务器换网 / 换机都不用再动后台。
        </div>

        <div class="note-box">
          保存后回到企业微信后台点「保存」，它会立刻发一次验证请求。<br>
          回调地址必须是<b>企业微信服务器能访问到</b>的地址（公网域名或内网穿透），内网 IP 不行。
        </div>`,
      foot: `<button type="button" class="btn-ghost" data-act="modal-close">取消</button>
        <button type="button" class="btn-ghost" data-act="wecom-test">发测试消息</button>
        <button type="button" class="btn-primary" data-act="wecom-save">保存</button>`,
    });
  }

  /** 收集弹窗里的配置。Secret 留空 → 不提交（服务端也按「不修改」处理） */
  function wecomPayloadFromForm() {
    const body = {
      corpId: fieldValue('wc-corp').trim(),
      agentId: fieldValue('wc-agent').trim(),
      token: fieldValue('wc-token').trim(),
      aesKey: fieldValue('wc-aes').trim(),
      /* v4.24.0 需求 3：可信 IP 代理（开关总是提交；URL 提交现值；token 留空 = 不改） */
      proxyEnabled: fieldChecked('wc-proxy-on'),
      proxyUrl: fieldValue('wc-proxy-url').trim(),
    };
    const sec = fieldValue('wc-secret').trim();
    if (sec) body.secret = sec;
    const pt = fieldValue('wc-proxy-token').trim();
    if (pt) body.proxyToken = pt;
    return body;
  }

  /**
   * ★ v4.28.1 需求 1：把映射框（家庭账号=企微 UserID）回写成服务端要的
   * `企微UserID=家庭账号`，顺便把「填错的」挑出来。
   *
   * 为什么还要认另一种顺序：老版本界面上是「企微UserID=家庭账号」，
   * 有人从旧截图 / 旧笔记里粘过来时不该报错 —— 只要**另一边**是家庭成员就认。
   */
  function wecomMapPayload() {
    const el = document.querySelector('#main [data-mk="wc-map-inline"]');
    if (!el) return null;
    const byName = new Map();
    for (const m of (state.members || [])) {
      if (m && m.username) byName.set(String(m.username).toLowerCase(), m.username);
    }
    const out = [];
    const seen = new Set();
    const bad = [];
    String(el.value).split(/\r?\n/).forEach((raw, idx) => {
      const s = raw.trim();
      if (!s || s.startsWith('#')) return;
      const i = s.indexOf('=');
      if (i < 0) { bad.push(`第 ${idx + 1} 行少了「=」：${s}`); return; }
      const left = s.slice(0, i).trim().replace(/^@/, '');
      const right = s.slice(i + 1).trim().replace(/^@/, '');
      if (!left || !right) return;     // 只填了一边 = 这个人还没绑，跳过
      let fam; let wx;
      if (byName.has(left.toLowerCase())) { fam = byName.get(left.toLowerCase()); wx = right; }
      else if (byName.has(right.toLowerCase())) { fam = byName.get(right.toLowerCase()); wx = left; }
      else { bad.push(`第 ${idx + 1} 行左边不是家庭成员：${s}`); return; }
      if (seen.has(wx)) { bad.push(`企业微信账号「${wx}」填了两次`); return; }
      seen.add(wx);
      out.push(`${wx}=${fam}`);
    });
    return { value: out.join('\n'), bad };
  }

  /** v4.16.0：账号映射单独保存（它常改，不该逼着人重填五项凭证） */
  async function saveWecomMap() {
    const picked = wecomMapPayload();
    if (!picked) return;
    if (picked.bad.length) { toast(picked.bad[0], 'err'); return; }
    try {
      const out = await api('/api/wecom', { method: 'POST', body: { userMap: picked.value } });
      state.wecom = out.wecom;
      render();
      toast(`账号映射已保存${out.wecom && out.wecom.bondCount ? `（${out.wecom.bondCount} 个）` : ''}`, 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  async function saveWecom(opts) {
    const silent = !!(opts && opts.silent);
    try {
      const out = await api('/api/wecom', { method: 'POST', body: wecomPayloadFromForm() });
      state.wecom = out.wecom;
      if (!silent) {
        closeModal();
        render();
        toast('企业微信配置已保存', 'ok');
      }
      return true;
    } catch (err) {
      toast(err.message, 'err');
      return false;
    }
  }

  async function testWecom() {
    // 先把表单里的配置存下来，否则测的是上一次保存的旧值（最容易让人以为「配置没生效」）
    if (!(await saveWecom({ silent: true }))) return;
    try {
      // v4.16.0：报表收件人不再是必填项，测试消息发给应用可见范围内的第一个人（不传 = 服务端挑）
      await api('/api/wecom/test', { method: 'POST', body: {} });
      toast('测试消息已发出，请到企业微信里查看', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  /* ═══ 「我的」：7 个分区（v4.12.0 重构）═══════════════════════════
     需求把这一页拆成：外观主题 / 个人资料 / 消息提醒 / 家庭成员 / 推送配置 / 数据备份 / 系统状态。
     除「外观主题」外一律默认收起 —— 理由：这一页的控件从 8 个涨到 40 多个之后，
     不折叠的话「退出登录」要滚三屏才看得到，而它恰恰是常用的那个。

     ★ 成员权限（需求原文「成员权限仅显示外观主题、个人资料、消息提醒、家庭成员、系统状态」）：
       「推送配置」和「数据备份」只对管理员出现。前者含发件凭据、后者能整体覆盖数据，
       本来就不是「每个人自己那一摊事」。
     ★ 折叠 ≠ 藏信息：收起时标题条上有摘要（昵称/账号、开启与否、成员数、通道状态…），
       不展开也能确认「现在是什么状态」。 */
  function meFold(key, icon, title, note, inner, extraCls) {
    const open = !!(state.meOpen && state.meOpen[key]);
    return `
      <section class="card sec me-fold${open ? ' open' : ''}${extraCls ? ' ' + extraCls : ''}">
        <button type="button" class="fold-head" data-act="me-fold" data-key="${key}" aria-expanded="${open ? 'true' : 'false'}">
          <span class="sec-ico" aria-hidden="true">${icon}</span>
          <span class="sec-title">${esc(title)}</span>
          <span class="sec-note">${esc(note)}</span>
          <span class="fold-caret">${open ? '收起' : '展开'}<i>${open ? '⌃' : '⌄'}</i></span>
        </button>
        <div class="fold-body${open ? '' : ' hidden'}">${inner}</div>
      </section>`;
  }

  /** 通道状态的一句话（推送配置 / 系统状态都要用） */
  function pushConfigSummary() {
    const s = state.settings || {};
    const mail = s.pushMailEnabled !== false;
    const wc = s.pushWecomEnabled !== false;
    const fs = s.pushFeishuEnabled !== false;
    const dt = s.pushDingtalkEnabled !== false;
    /* v4.24.0 需求 2：飞书 / 钉钉也是正式通道，摘要里要能一眼看到开了几条 */
    const names = [];
    if (mail) names.push('邮件');
    if (wc) names.push('企业微信');
    if (fs) names.push('飞书');
    if (dt) names.push('钉钉');
    if (!names.length) return '所有通道都关着（不会推送）';
    if (mail && wc && !fs && !dt) return '邮件 + 企业微信都开着';
    return names.join(' + ') + ' 已开启';
  }

  function meHtml() {
    const me = state.me;
    const members = state.members.map((m) => `
      <div class="row member-row">
        ${me.is_admin
          ? `<button type="button" class="avatar-link" data-act="member-info" data-id="${m.id}"
                     title="查看 ${esc(m.display_name)} 的全部参数">${avatarHtml(m.display_name)}</button>`
          : avatarHtml(m.display_name)}
        <div class="r-label">
          <b>${esc(m.display_name)}${m.id === me.id ? ' <span class="badge">我</span>' : ''}${m.is_admin ? ' <span class="badge cat">管理员</span>' : ''}${m.record_lock_enabled ? ' <span class="badge priv">🔒 记录本已上锁</span>' : ''}</b>
          <small>@${esc(m.username)}</small>
        </div>
        ${me.is_admin && m.id !== me.id ? `
          <button type="button" class="btn-ghost btn-sm" data-act="member-lock" data-id="${m.id}"
                  data-name="${esc(m.display_name)}" data-lock="${m.record_lock_enabled ? '1' : '0'}"
                  title="重置或清空该成员的记录本访问密码">访问密码</button>
          <button type="button" class="btn-ghost btn-sm" data-act="member-reset" data-id="${m.id}" data-name="${esc(m.display_name)}">重置密码</button>
          <button type="button" class="btn-danger btn-sm" data-act="member-del" data-id="${m.id}" data-name="${esc(m.display_name)}"
                  title="删除该成员及其全部数据">删除</button>` : ''}
      </div>`).join('');

    const lockOn = me.record_lock_enabled;
    const s = state.settings || null;
    // 非管理员拿不到 /api/settings，用 prefs-global 与 /api/config 兜底显示「管理员的默认值」
    const g = state.prefsGlobal || {};
    const cfg = state.config || {};
    const sysRemindOn = s ? s.remindEnabled !== false : g.remindEnabled !== false;
    const sysRemindTime = s ? (s.remindDefaultTime || '08:00') : (g.remindDefaultTime || '08:00');
    const sysAdv = s ? (Number(s.remindAdvanceDays) || 0) : (Number(g.advanceDays) || 0);
    const sysNotifyOn = s ? s.notifyOnChange !== false : g.notifyOnChange !== false;
    /* v4.14.0 需求 4：notifyKinds / notifyDigestTime / quiet* 这几个局部变量
       原本是给「家庭默认」那块表单用的；表单在 v4.13.0 就撤掉了，
       这里一并删掉，避免 `s.notifyDigestTime` 这种「读了已下线的字段」的残留。 */
    // 待发队列 / 上次扫描结果由 remindStatusBlock / notifyStatusBlock 自己渲染（见「运行状态」）

    /* 分区标题统一走 .sec-head（图标 + 标题 + 右侧备注）—— 现在由 meFold 统一产出，
       高度在 CSS 里写成同一个值，不会有的高有的矮。 */
    const secHead = (icon, title, note) => `<div class="sec-head">
        <span class="sec-ico" aria-hidden="true">${icon}</span>
        <span class="sec-title">${esc(title)}</span>
        ${note ? `<span class="sec-note">${note}</span>` : ''}
      </div>`;

    /* —— ② 个人资料：昵称 / 头像 / 记录本密码 + 登录账号 / 修改密码 / 退出登录 ——
       需求原文：「登录账号、修改密码、退出登录归入个人资料」。
       它们本来在「数据与安全」里，但账号密码属于「我是谁」，不属于「数据怎么备份」。

       ★ v4.28.1 需求 2：改成「简洁、大气」的两组清单。
       旧版六行完全同构（左边标题 + 右边一个小按钮），既分不清哪些是资料、哪些是账号安全，
       还得逐行读小字才知道「现在是什么状态」。现在：
         · 只有两个分组标题（账号 / 安全），不加多余说明；
         · 每行右边先摆**当前值**，整行可点，行尾一个 › 就是点击暗示；
         · 「退出登录」单独一条，不和「改密码」挤在一起。
       ★ 文案顺序是刻意的：「记录本访问密码」与「已开启」之间**不留空白**，
         拼起来仍是一句「记录本访问密码已开启」（界面与测试都按这句话读）。 */
    const profItem = (o) => `<button type="button" class="prof-item${o.danger ? ' danger' : ''}" data-act="${o.act}">`
      + `<span class="pi-ico" aria-hidden="true">${o.ico}</span>`
      + `<span class="pi-main"><span class="pi-head"><b>${o.label}</b>${o.badge || ''}</span>`
      + `${o.sub ? `<small>${o.sub}</small>` : ''}</span>`
      + `${o.val ? `<span class="pi-val">${o.val}</span>` : ''}`
      + '<span class="pi-go" aria-hidden="true">›</span></button>';

    const profileBody = `
        <div class="prof">
          <div class="prof-cap">账号</div>
          <div class="prof-list">
            ${profItem({ ico: '👤', act: 'me-rename', label: '昵称',
              val: esc(me.display_name), sub: '家人看到的称呼，改完立即生效' })}
            ${profItem({ ico: '🖼️', act: 'me-avatar', label: '头像',
              val: me.avatar ? '自定义' : '默认',
              sub: me.avatar ? '已使用自定义头像' : '默认使用昵称首字' })}
            ${profItem({ ico: '@', act: 'me-username', label: '登录账号',
              val: `当前：@${esc(me.username)}`, sub: '改完用新账号登录' })}
          </div>
          <div class="prof-cap">安全</div>
          <div class="prof-list">
            ${profItem({ ico: '🔑', act: 'record-lock', label: '记录本访问密码',
              badge: `<span class="pi-badge${lockOn ? ' on' : ''}">${lockOn ? '已开启' : '未开启'}</span>`,
              sub: lockOn
                ? `${me.record_lock_custom ? '自定义密码' : '复用登录密码'} · 登录密码同样能解锁`
                : '可复用登录密码，也可以单独设一个' })}
            ${profItem({ ico: '🔒', act: 'me-password', label: '修改密码',
              sub: '改完本机退出，需要重新登录' })}
          </div>
          <button type="button" class="btn-ghost prof-exit" data-act="me-logout">退出登录</button>
        </div>`;

    /* —— ③ 消息提醒 ——
       v4.13.0（问题 9）：**不再有独立的「家庭默认」表单**。
       原来的结构是「我的接收方式」+「家庭默认（管理员可改）」两套控件，
       管理员要改个提醒时间得先搞清「这行是改我的还是改全家的」。
       现在只有一套入口：点「待办提醒 / 内容通知 → 设置」——
         · 管理员：弹窗里改的就是全家的默认值（写 /api/settings）；
         · 成员：弹窗里选「跟随管理员 / 开启 / 关闭」，跟随即沿用管理员那份。
       运行状态（消息到底发没发出去）留在这一块，管理员和成员都能看。 */
    const notifyBody = `
        <div class="sub-head">我的接收方式</div>
        <div class="row-list">
          <div class="row">
            <div class="r-label"><b>提醒收件邮箱</b>
              <small>${me.notify_email ? '当前：' + esc(me.notify_email) : '未设置 · 配置后，参加的待办到点会把提醒发给你'}</small></div>
            <button type="button" class="btn-ghost btn-sm" data-act="notify-email">设置</button>
          </div>
          <div class="row">
            <div class="r-label"><b>推送方式</b>
              <small>${pushChannelSummary(me)}</small></div>
            <button type="button" class="btn-ghost btn-sm" data-act="push-channel">设置</button>
          </div>
          <div class="row">
            <div class="r-label"><b>待办提醒</b>
              <small>${prefsSummary('remind')}</small></div>
            <button type="button" class="btn-soft btn-sm" data-act="prefs-open" data-which="remind">设置</button>
          </div>
          <div class="row">
            <div class="r-label"><b>内容通知</b>
              <small>${prefsSummary('notify')}</small></div>
            <button type="button" class="btn-soft btn-sm" data-act="prefs-open" data-which="notify">设置</button>
          </div>
          <div class="row">
            <div class="r-label"><b>记账推送</b>
              <small>${me.is_admin ? billPushSummary() : billChannelSummary(me)}</small></div>
            <button type="button" class="btn-soft btn-sm" data-act="bill-push-open">设置</button>
          </div>
          ${me.is_admin ? `
          <!-- v4.23.0 需求 5：推送日志（管理员）。所有推送逐条留痕，可一键清空。 -->
          <div class="row">
            <div class="r-label"><b>推送日志</b>
              <small>待办提醒 / 内容通知 / 记账推送 / 测试邮件的逐条记录，排查「谁没收到、为什么」</small></div>
            <button type="button" class="btn-ghost btn-sm" data-act="push-logs-open">查看</button>
          </div>` : ''}
        </div>
        <div class="sub-head">运行状态（消息到底发没发出去，在这里自己排查）</div>
        <div id="msg-run-state">
          ${remindStatusBlock(s)}
          ${notifyStatusBlock(s)}
          ${billPushStatusBlock(s)}
        </div>
        <div class="sec-note-box"><div class="note-box">${me.is_admin
          ? '你是管理员：上面「待办提醒 / 内容通知 / 记账推送 → 设置」里改的就是<b>全家的默认值</b>，保存后全家生效。成员可以选「跟随管理员」，也可以自己收窄（只能关，不能放大）。'
          : '你的「待办提醒 / 内容通知」默认<b>跟随管理员</b>；想单独关掉某一类，点右侧「设置」自己选（只能收窄，不能放大）。'}</div></div>`;

    /* —— ⑤ 推送配置（仅管理员）——
       需求原文：「发件邮箱移入推送配置并支持勾选邮件／企业微信推送后展开配置」。
       两个勾选框是**家庭级总开关**（config.pushMailEnabled / pushWecomEnabled），
       勾上立刻生效（不依赖下面的保存按钮），勾上后才展开各自的详细配置。 */
    const mailOn = s ? s.pushMailEnabled !== false : true;
    const wecomOn = s ? s.pushWecomEnabled !== false : true;
    /* v4.13.0（问题 5）：上次推送 —— 排查「怎么没收到」的第一手信息。
       记的是**最近一次**主动推送（待办提醒 / 内容通知 / 报表 / 发件箱冲刷），
       由服务端 push.deliver 每次成功后写入；刷新按钮重新拉一次设置即可。 */
    const lp = (s && s.pushLast) || null;
    const lpCh = lp && Array.isArray(lp.channels) && lp.channels.length
      ? lp.channels.map((x) => ({ wecom: '企业微信', mail: '邮件', feishu: '飞书', dingtalk: '钉钉' }[x] || x)).join(' + ')
      : '';
    const lpText = !lp
      ? '还没有推送记录（有待办提醒或内容通知发出后会记在这里）'
      : `${esc(fmtTime(lp.at) || lp.at || '')} · <b>${lp.ok ? '成功' : '未送达'}</b>`
        + ` · 渠道：${esc(lpCh || '无')}`
        + `${lp.deferred ? ` · 免打扰缓发 ${Number(lp.deferred) || 0} 条` : ''}`
        + `${lp.subject ? ` · ${esc(lp.subject)}` : ''}`
        + `${(lp.errors && lp.errors.length) ? `<br><span class="warn-text">${esc(lp.errors[0])}</span>` : ''}`;
    /* ★ v4.16.0 需求 4：邮件 / 企业微信两块改成「点标题折叠配置」。
       · 标题本身是按钮（不是整行）：勾选框和标题挨在一起时，点哪儿会开关掉通道的歧义太大；
       · 开关仍然只有勾选框那一个 —— 折叠只影响**看不看得到配置**，不影响开没开；
       · 关掉的通道不必展开（配置留着，重新勾上就回来）。 */
    /* 默认展开（和旧版一致：第一次来就能看到要填什么），点标题才收起来。
       通道关着的时候不展开 —— 关掉的配置留着但没必要占屏幕。 */
    const mailOpen = mailOn && (!state.pushOpen || state.pushOpen.mail !== false);
    const wecomOpen = wecomOn && (!state.pushOpen || state.pushOpen.wecom !== false);
    /* v4.24.0 需求 2：飞书 / 钉钉群机器人 —— 与邮件 / 企微同一套「勾选框 + 折叠配置」交互 */
    const fsOn = s ? s.pushFeishuEnabled !== false : true;
    const dtOn = s ? s.pushDingtalkEnabled !== false : true;
    const fsOpen = fsOn && (!state.pushOpen || state.pushOpen.feishu !== false);
    const dtOpen = dtOn && (!state.pushOpen || state.pushOpen.dingtalk !== false);
    const fsSt = (s && s.feishuStatus) || {};
    const dtSt = (s && s.dingtalkStatus) || {};
    /* 一块群机器人通道的配置区（飞书 / 钉钉同构，只有文案与接口名不同） */
    const hookBox = (which, label, open, on, st) => `
        <div class="row-list">
          <div class="row">
            <div class="r-label">
              <b><button type="button" class="fold-title" data-act="push-fold" data-which="${which}"
                         aria-expanded="${open ? 'true' : 'false'}">${label}推送</button>
                 <span class="fold-caret">${open ? '⌃' : '⌄'}</span></b>
              <small>${on
                ? (st.configured ? '已配置 · 群机器人建在哪个群，消息就发到哪个群' : '已开启 · 还没填 Webhook')
                : '已关闭 · 选了「' + label + '群」的家人收不到'}${
                on && !open ? ' · 点标题展开配置' : ''}</small></div>
            <label class="check-line"><input type="checkbox" data-act="push-${which}-toggle"${on ? ' checked' : ''}>
              <span>启用</span></label>
          </div>
        </div>
        <div class="push-sub${open ? '' : ' hidden'}" id="push-${which}-box">
          <div class="row-list">
            <div class="row row-stack">
              <div class="r-label"><b>Webhook 地址</b>
                <small>${st.configured ? `已配置：${esc(st.webhookMasked || '…')}` : `在${label}群里添加「自定义机器人」后复制这里的地址`}</small></div>
              <input type="text" data-mk="hook-${which}-webhook" maxlength="500"
                     value="" placeholder="${st.configured ? '已保存，留空表示不修改' : (which === 'feishu' ? 'https://open.feishu.cn/open-apis/bot/v2/hook/…' : 'https://oapi.dingtalk.com/robot/send?access_token=…')}">
            </div>
            <div class="row"><div class="r-label"><b>加签密钥</b>
              <small>${st.hasSecret ? '已保存，留空表示不修改' : `机器人的「${which === 'feishu' ? '签名校验' : '加签'}」安全设置里生成；用关键词安全设置则留空`}</small></div>
              <input type="password" data-mk="hook-${which}-secret" maxlength="100" value="" placeholder="留空不改"></div>
          </div>
          <div class="status-ops">
            <button type="button" class="btn-primary btn-sm" data-act="hooks-save" data-which="${which}">保存${label}配置</button>
            <button type="button" class="btn-ghost btn-sm" data-act="hooks-test" data-which="${which}">发测试消息</button>
          </div>
        </div>`;
    const pushBody = `
        <div class="row-list">
          <div class="row">
            <div class="r-label"><b>上次推送</b><small>${lpText}</small></div>
            <button type="button" class="btn-ghost btn-sm" data-act="push-last-refresh">刷新</button>
          </div>
          <div class="row">
            <div class="r-label">
              <b><button type="button" class="fold-title" data-act="push-fold" data-which="mail"
                         aria-expanded="${mailOpen ? 'true' : 'false'}">邮件推送</button>
                 <span class="fold-caret">${mailOpen ? '⌃' : '⌄'}</span></b>
              <small>${mailOn ? '已开启 · 走下面的发件邮箱' : '已关闭 · 提醒不会用邮件发'}${
                mailOn && !mailOpen ? ' · 点标题展开配置' : ''}</small></div>
            <label class="check-line"><input type="checkbox" data-act="push-mail-toggle"${mailOn ? ' checked' : ''}>
              <span>启用</span></label>
          </div>
        </div>
        <div class="push-sub${mailOpen ? '' : ' hidden'}" id="push-mail-box">
          <div class="row-list">
            <div class="row"><div class="r-label"><b>SMTP 服务器</b><small>QQ / 163 邮箱用默认即可</small></div>
              <input type="text" class="inp-compact" data-mk="smtpHost" maxlength="100" value="${esc((s && s.smtpHost) || 'smtp.qq.com')}"></div>
            <div class="row"><div class="r-label"><b>端口</b><small>465 = SSL（推荐）</small></div>
              <input type="number" class="inp-compact" data-mk="smtpPort" min="1" max="65535" value="${Number(s && s.smtpPort) || 465}"></div>
            <div class="row"><div class="r-label"><b>发件邮箱</b><small>提醒邮件的「发件人」</small></div>
              <input type="email" class="inp-compact" data-mk="smtpUser" maxlength="254" value="${esc((s && s.smtpUser) || '')}" placeholder="you@qq.com"></div>
            <div class="row"><div class="r-label"><b>授权码</b>
              <small>${s && s.hasSmtpPass ? '已保存，留空表示不修改' : '不是登录密码，是邮箱设置里的「授权码」'}</small></div>
              <input type="password" class="inp-compact" data-mk="smtpPass" maxlength="200" value="" placeholder="留空不改"></div>
          </div>
          <div class="status-ops">
            <button type="button" class="btn-primary btn-sm" data-act="push-save-mail">保存邮件配置</button>
            <button type="button" class="btn-ghost btn-sm" data-act="settings-test-mail">发测试邮件</button>
          </div>
        </div>
        <div class="row-list">
          <div class="row">
            <div class="r-label">
              <b><button type="button" class="fold-title" data-act="push-fold" data-which="wecom"
                         aria-expanded="${wecomOpen ? 'true' : 'false'}">企业微信推送</button>
                 <span class="fold-caret">${wecomOpen ? '⌃' : '⌄'}</span></b>
              <small>${wecomOn
                ? '已开启 · 提醒、催办、报表都走它'
                : '已关闭 · 企业微信接入整体停用（回消息也停）'}${
                wecomOn && !wecomOpen ? ' · 点标题展开配置' : ''}</small></div>
            <label class="check-line"><input type="checkbox" data-act="push-wecom-toggle"${wecomOn ? ' checked' : ''}>
              <span>启用</span></label>
          </div>
        </div>
        <div class="push-sub${wecomOpen ? '' : ' hidden'}" id="push-wecom-box">
          ${wecomSectionInner()}
        </div>
        ${hookBox('feishu', '飞书', fsOpen, fsOn, fsSt)}
        ${hookBox('dingtalk', '钉钉', dtOpen, dtOn, dtSt)}
        <div class="sec-note-box"><div class="note-box">
          关掉一个通道<b>不会删掉它的配置</b>：授权码 / 企业微信参数 / 群机器人 Webhook 都还在，重新勾上就能用，不用重填。
          飞书与钉钉是<b>群机器人</b>：消息发到群里全家可见，没有「绑定到个人」这一步。
          每个家人具体走哪条通道，在各自的「消息推送设置 → 推送方式」里选。
        </div></div>`;

    /* —— ⑥ 数据备份（仅管理员）—— */
    const backupBody = `
        <div class="row-list">
          <div class="row">
            <div class="r-label"><b>导出备份</b><small>下载一个 JSON 文件，含全部数据与图片</small></div>
            <button type="button" class="btn-soft btn-sm" data-act="backup-download">下载</button>
          </div>
          <div class="row">
            <div class="r-label"><b>从备份恢复</b><small>整体替换现有数据，不可撤销</small></div>
            <button type="button" class="btn-ghost btn-sm" data-act="backup-restore">选择文件</button>
          </div>
          <div class="row">
            <div class="r-label"><b>冷备份数据库</b><small>服务器上执行 npm run backup，直接拷单个 .db 文件</small></div>
          </div>
        </div>
        <div class="sec-note-box"><div class="note-box">数据都在服务器的一个 SQLite 文件里。<b>定期下载备份</b>，换服务器时把备份传上去恢复即可完成迁移。</div></div>
        <input type="file" accept="application/json,.json" class="hidden" id="restore-file">`;

    return `
      <div class="card me-card">
        <div class="me-head">
          <button type="button" class="avatar-btn" data-act="me-avatar" title="点击更换头像">
            ${avatarHtml(me.display_name, 'me-avatar')}
            <span class="avatar-pen" aria-hidden="true">✎</span>
          </button>
          <div class="who">
            <b>${esc(me.display_name)}</b>
            <!-- ★ v4.28.1 需求 2：身份、锁状态做成一枚枚小徽章摆在账号后面，
                 比原来一句「@mama · 管理员」更容易扫读。 -->
            <div class="me-sub"><span class="me-handle">@${esc(me.username)}</span>${me.is_admin
              ? '<span class="badge cat">管理员</span>' : ''}${lockOn
              ? '<span class="badge priv">🔒 记录本已上锁</span>' : ''}</div>
          </div>
          <button type="button" class="btn-ghost btn-sm" data-act="me-rename">改昵称</button>
        </div>
      </div>

      <!-- ① 外观主题：**唯一不折叠**的分区（需求原文）。
           三张卡片直接给出「另外两套长什么样」，看得见才好选。 -->
      <section class="card sec">
        ${secHead('🎨', '外观主题', '跟着账号走，换设备也一样')}
        <div class="theme-wrap">
          <div class="theme-grid">
            ${THEMES.map((t) => `
              <button type="button" class="theme-card${state.theme === t ? ' on' : ''}"
                      data-act="theme-pick" data-theme="${t}" aria-pressed="${state.theme === t ? 'true' : 'false'}">
                <span class="theme-swatch f-${t}"><i></i><i></i><i></i></span>
                <span class="theme-name">${THEME_META[t].name}<span class="theme-check">✓</span></span>
                <span class="theme-desc">${THEME_META[t].desc}</span>
              </button>`).join('')}
          </div>
        </div>
      </section>

      ${meFold('profile', '👤', '个人资料',
        `${esc(me.display_name)} · @${esc(me.username)}`, profileBody)}

      ${meFold('members', '👨‍👩‍👧', '家庭设置和成员', `${state.members.length} 人`, `
        ${me.is_admin && s ? `
        <div class="sub-head">家庭设置</div>
        <div class="row-list">
          <div class="row">
            <div class="r-label"><b>注册与登录</b>
              <small>注册${s.allowRegister ? '开放' : '已关闭'} · 免登录 ${s.sessionTtlHours} 小时<br>
                图片 ${esc(String(cfg.imageMaxMb || s.imageMaxMb || 10))}MB · 附件 ${esc(String(cfg.fileMaxMb || s.fileMaxMb || 20))}MB · 视频 ${esc(String(cfg.videoMaxMb || s.videoMaxMb || 50))}MB</small></div>
            <button type="button" class="btn-soft btn-sm" data-act="admin-settings">设置</button>
          </div>
        </div>` : ''}
        <div class="sub-head sub-head-row">成员（${state.members.length} 人）${
          me.is_admin ? '<span class="sub-head-hint">点头像可查看该成员的配置信息</span>' : ''}</div>
        <div class="row-list">${members}</div>`)}

      ${meFold('notify', '🔔', '消息推送设置',
        `${pushChannelSummary(me)} · 待办提醒${sysRemindOn ? '开' : '关'} · 内容通知${sysNotifyOn ? '开' : '关'}`,
        notifyBody)}

      ${me.is_admin ? meFold('push', '📮', '推送渠道设置', pushConfigSummary(), pushBody) : ''}

      ${me.is_admin ? meFold('ai', '🔍', 'AI 参数设置', billAiSummary(), billAiBodyHtml()) : ''}

      ${meFold('cat', '🏷️', '记账分类与预算', billCatSummary(), billCatBodyHtml())}

      ${me.is_admin ? meFold('backup', '💾', '数据备份', '导出 / 恢复 / 冷备', backupBody) : ''}

      ${meFold('system', 'ℹ️', '系统状态', `v${esc((state.config && state.config.version) || '?')} · 管理员默认配置`, systemStatusHtml(s, g, cfg))}

      <div class="app-foot">${brandFootHtml()}</div>`;
  }

  /* ═══ 系统状态（v4.12.0：从「关于与系统状态」扩成「管理员的默认配置一览」）═══
     需求原文：系统状态展示管理员默认配置（推送方式、各内容默认推送时间、
     家庭设置、文件视频上传限制等）。成员也能看，让「为什么我收不到提醒」
     能在界面上自己找到答案，而不是只能去问管理员。
     ★ v4.15.0 需求 4：原来是一列「粗标题 + 一长串小字」的 row，七到九行读下来
       又长又糊。现在改成两张指标卡（运行环境 / 默认推送）各四个格子，
       地址型的长值（数据库、状态）压进格子里的短文案，需要细看的留在
       「家庭设置」和「推送渠道设置」各自的分区里 —— 这里只回答「是什么」。 */
  function systemStatusHtml(s, g, cfg) {
    const st = state.systemStatus;
    const me = state.me || {};
    const ver = (state.config && state.config.version) || '?';
    const pushText = s
      ? ((s.pushMailEnabled !== false && s.pushWecomEnabled !== false) ? '邮件 + 企业微信'
        : (s.pushMailEnabled !== false ? '只用邮件' : (s.pushWecomEnabled !== false ? '只用企业微信' : '两个都关着')))
      : '跟随管理员';
    const remindTime = s ? (s.remindDefaultTime || '08:00') : ((g && g.remindDefaultTime) || '08:00');
    const advD = s ? (Number(s.remindAdvanceDays) || 0) : (Number(g && g.advanceDays) || 0);
    const quietS = s ? String(s.notifyQuietStart || '') : String((g && g.notifyQuietStart) || '');
    const quietE = s ? String(s.notifyQuietEnd || '') : String((g && g.notifyQuietEnd) || '');
    const rep = (state.billMeta && state.billMeta.reports) || null;
    const billText = !rep || rep.reportsEnabled === undefined
      ? '以管理员设置为准'
      : (rep.reportsEnabled === false ? '已关闭' : `每天 ${rep.dailyTime || '21:00'}`);
    /* 环境体检：AI 与数据库两件事最容易「悄悄坏掉」，用徽标先给结论 */
    const aiOk = !!(st && st.aiConfigured) && !!st.aiEnabled;
    const envPill = !st ? rsPill('warn', '加载中')
      : (aiOk ? rsPill('ok', '运行正常') : rsPill('warn', 'AI 未就绪'));
    return `
      <div class="sys-status">
        <div class="run-state">
          <div class="rs-head"><span class="rs-title">运行环境</span>${envPill}</div>
          <div class="rs-grid">
            ${rsCell('软件版本', `v${ver}`)}
            ${rsCell('数据库', st ? `${st.dbKind} · ${st.journalMode} · ${st.dbSizeMb}MB` : '加载中…', '', true)}
            ${rsCell('AI 截图识别', st ? (st.aiConfigured ? (st.aiEnabled ? '已配置 · 启用' : '已配置 · 停用') : '未配置') : '加载中…')}
            ${rsCell('上传上限', `图片 ${esc(String(cfg.imageMaxMb || (s && s.imageMaxMb) || 10))}MB · 附件 ${esc(String(cfg.fileMaxMb || (s && s.fileMaxMb) || 20))}MB · 视频 ${esc(String(cfg.videoMaxMb || (s && s.videoMaxMb) || 50))}MB`, '', true)}
          </div>
        </div>
        <div class="run-state">
          <div class="rs-head"><span class="rs-title">默认推送</span>
            ${(s ? s.pushMailEnabled !== false || s.pushWecomEnabled !== false : true) ? rsPill('ok', '已配置') : rsPill('off', '两个通道都关着')}</div>
          <div class="rs-grid">
            ${rsCell('推送方式', pushText + ` · 我：${PUSH_LABEL[pushChannelOf(me)] || '智能'}`, '', true)}
            ${rsCell('待办提醒', `${s ? (s.remindEnabled !== false ? '开' : '关') : ((g && g.remindEnabled !== false) ? '开' : '关')} · ${remindTime} · ${advanceLabel(advD)}`, '', true)}
            ${rsCell('内容通知', (quietS && quietE) ? `免打扰 ${quietS}–${quietE} 后合并 · 上限 ${notifyMaxPerMin()}/分` : `变更即发 · 上限 ${notifyMaxPerMin()}/分`, '', true)}
            ${rsCell('记账推送', billText)}
          </div>
        </div>
        <div class="rs-line">${s
          ? `注册${s.allowRegister ? '开放' : '已关闭'} · 免登录 ${esc(String(s.sessionTtlHours))} 小时 · 数据保存在你自己的服务器上`
          : '家庭设置仅管理员可查看'}</div>
      </div>`;
  }

  /* ═══ v4.16.0 需求 1：「记账推送」的独立弹窗 ═══════════════════
     需求原文：把记账推送改成与待办提醒、内容通知一致 —— 点设置项开独立弹窗。
     好处不只是「看起来一致」：这三个都是「一类消息发不发、什么时候发」，
     留在页面里内联展开时，一屏能同时看到三个表单，改完不知道点哪个保存是对的。
     弹窗里只有一件事，底部按钮也就只有一件事。
     ★ 弹窗开着时，里面的开关点完要**就地重绘 body**（render() 只负责主页面，
       不会碰弹窗）—— 否则勾完「每日日报」文案不变，看起来像没生效。 */
  function openBillPushForm() {
    openModal({
      title: '记账推送',
      body: billPushBodyHtml(),
      foot: `<button type="button" class="btn-ghost" data-act="modal-close">关闭</button>
        <div class="spacer"></div>
        <button type="button" class="btn-ghost" data-act="bill-report-test">试发一次</button>`,
      onMount: (layer) => { layer.dataset.modalKind = 'bill-push'; },
    });
  }

  /** 记账推送弹窗开着时，用它把表单内容刷成最新状态（不重建弹窗、不丢滚动位置） */
  function paintBillPushForm() {
    const layer = $('#modal-layer');
    if (!layer || layer.dataset.modalKind !== 'bill-push') return;
    const body = layer.querySelector('.modal-body');
    if (body) body.innerHTML = billPushBodyHtml();
  }

  /* ═══ v4.23.0 需求 5：推送日志 ═════════════════════════════
     为什么不做成页面里的一张长列表：日志是「排查时才看」的东西，
     常驻会把设置页拉得很长。放在弹窗里，查完就关。
     ★ 只展示不解释猜测：ok=false 的条目下面直接写服务端给的原因
       （没配邮箱 / 企微失败后补邮件成功 / 免打扰缓发…），不做二次翻译。 */
  const PUSH_KIND_CN = {
    remind: '待办提醒', record: '记录本提醒', notify: '内容通知',
    bill: '记账推送', outbox: '免打扰缓发', test: '测试邮件', push: '其他推送',
  };
  const PUSH_CH_CN = { mail: '邮件', wecom: '企业微信', '': '无通道' };

  function pushLogsHtml(logs) {
    if (!logs.length) {
      return `<div class="note-box">还没有推送记录。发出第一条待办提醒 / 内容通知 / 记账推送后就会出现在这里。</div>`;
    }
    return `<div class="push-logs">${logs.map((l) => `
        <div class="push-log${l.ok ? '' : ' fail'}">
          <div class="pl-head">
            <span class="pl-kind">${esc(PUSH_KIND_CN[l.kind] || l.kind || '推送')}</span>
            <span class="pl-who">${esc(l.userName || '—')}</span>
            <span class="pl-ch">${esc(PUSH_CH_CN[l.channel] || l.channel || '无通道')}</span>
            <span class="pl-ok">${l.ok ? '已发出' : '未送达'}</span>
          </div>
          <div class="pl-sub">${esc(fmtTime(l.at) || l.at || '')}${l.subject ? ` · ${esc(l.subject)}` : ''}</div>
          ${l.detail ? `<div class="pl-detail">${esc(l.detail)}</div>` : ''}
        </div>`).join('')}</div>`;
  }

  async function openPushLogs() {
    let logs = [];
    try {
      const out = await api('/api/settings/push-logs?limit=200');
      logs = (out && out.logs) || [];
    } catch (err) { toast(err.message, 'err'); return; }
    openModal({
      title: '推送日志',
      body: `<div class="note-box">最近 200 条（库里保留最近 3000 条）。「未送达」下面写着原因：
        没配发件邮箱 / 企业微信失败后已改用邮件 / 免打扰时段内缓发…</div>${pushLogsHtml(logs)}`,
      foot: `<button type="button" class="btn-danger btn-sm" data-act="push-logs-clear">清除日志</button>
        <div class="spacer"></div>
        <button type="button" class="btn-ghost" data-act="modal-close">关闭</button>`,
    });
  }

  async function clearPushLogs() {
    if (!window.confirm('确定清除全部推送日志吗？\n\n只删日志，不影响任何待办、账单或提醒设置。')) return;
    try {
      const out = await api('/api/settings/push-logs/clear', { method: 'POST' });
      toast(`已清除 ${Number(out.cleared) || 0} 条推送日志`, 'ok');
      await openPushLogs();
    } catch (err) { toast(err.message, 'err'); }
  }

  /* ═══ 弹窗 ═══════════════════════════════════════════════ */

  function openModal(opts) {
    closeModal();
    const layer = document.createElement('div');
    layer.className = 'modal-layer';
    layer.id = 'modal-layer';
    layer.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3>${esc(opts.title)}</h3>
          <button type="button" class="icon-btn" data-act="modal-close">✕</button>
        </div>
        <div class="modal-body">${opts.body}</div>
        <div class="modal-foot">${opts.foot || '<button type="button" class="btn-ghost" data-act="modal-close">关闭</button>'}</div>
      </div>`;
    layer.addEventListener('mousedown', (e) => { if (e.target === layer) closeModal(); });
    $('#modal-root').appendChild(layer);
    if (opts.onMount) opts.onMount(layer);
  }

  function closeModal() {
    const el = $('#modal-layer');
    /* v4.3.3 需求 6：关掉「新建记录」弹窗之前，先把当前内容落成草稿。
       不在这里兜一次的话，用户「敲完最后一句直接点取消/关掉」就白写了 ——
       0.8 秒的 debounce 还没到，DOM 已经没了，什么都读不到。
       `recCommitted` 由「保存成功 / 主动丢弃草稿」两条路径置位，
       避免刚保存完又把同一条存回草稿。 */
    if (el && el.dataset.recMode === 'new' && el.dataset.recCommitted !== '1') {
      try { saveRecordDraftNow(); } catch { /* 存草稿失败不能挡住关闭 */ }
    }
    if (el) el.remove();
    recViewId = null;           // 查看页随弹窗一起结束
  }

  /* ★ 取值范围是「弹窗优先，其次页面本体」。
     早先只查 `#modal-layer`，于是**记账设置页**里的两处输入框（百度 OCR 的
     API Key / Secret Key、以及「新增分类」）永远读成空字符串：
       · 保存密钥 → 「两项都空着，没有需要保存的内容」
       · 添加分类 → 「请先填分类名称」
     用户明明填了字却被告知没填，是最伤信任的一类 bug。
     这两处输入框本来就不在弹窗里（记账设置是页面里的一个视图），所以取值要覆盖页面本体。
     弹窗优先的次序不能反过来：同名 key 若同时存在于弹窗与页面，弹窗里那份才是用户正在编辑的。 */
  function fieldValue(key) {
    const el = document.querySelector(`#modal-layer [data-mk="${key}"]`)
      || document.querySelector(`#main [data-mk="${key}"]`);
    return el ? el.value : '';
  }
  function fieldChecked(key) {
    const el = document.querySelector(`#modal-layer [data-mk="${key}"]`)
      || document.querySelector(`#main [data-mk="${key}"]`);
    return !!(el && el.checked);
  }
  /* 清空某个取值字段（弹窗或页面本体）。道理同 clearBillInput：
     `<input>` 的 value 是 DOM 属性、改不动 outerHTML，最小重绘不会替你把它清掉。 */
  function clearField(key) {
    const el = document.querySelector(`#modal-layer [data-mk="${key}"]`)
      || document.querySelector(`#main [data-mk="${key}"]`);
    if (el) el.value = '';
  }

  /* 兼容旧名（调用点很多，保留薄包装而不是 `const modalValue = fieldValue`：
     函数声明会被提升，任何位置的调用都安全；const 别名有暂时性死区，
     万一以后有人在模块初始化阶段就调用它，会直接 ReferenceError）。 */
  function modalValue(key) { return fieldValue(key); }
  function modalChecked(key) { return fieldChecked(key); }

  /* ═══ 图片灯箱 ═══════════════════════════════════════════
     点开大图后可以左右切换浏览同一组图片：
       · 桌面：左右箭头按钮 / 键盘 ← → 键
       · 手机：在图片上左右滑动（横向意图明确时才拦截，不打断纵向手势）
       · 缩放：双指捏合、双击、桌面滚轮；放大后可单指/鼠标拖动查看细节
       · 动画：打开是「淡入 + 轻微放大」，切图是「滑出 + 滑入」，松手回弹带缓动
     关闭：点图片外的空白、右上角 ✕、Esc 键
     ═════════════════════════════════════════════════════════ */

  const LB_MAX_SCALE = 5;
  const LB_DBL_SCALE = 2.5;

  const lbView = {
    gallery: [], index: 0,
    scale: 1, tx: 0, ty: 0,          // 当前变换（缩放倍数 + 平移量）
    base: null,                       // 手势开始时的快照
    swiping: false, panning: false,   // 本次手势的意图
    lastTap: 0,                       // 双击判定
    closeTimer: null,                 // 「单击图片 → 延迟关闭」的定时器（能被双击取消）
  };

  const lbEl = () => $('#lightbox');
  const lbImg = () => { const el = lbEl(); return el ? el.querySelector('.lb-img') : null; };
  const lbStage = () => { const el = lbEl(); return el ? el.querySelector('.lb-stage') : null; };

  /** 把当前变换写进 style。anim 传 'none' 表示不做过渡（跟手拖动时必须瞬时） */
  function lbApply(anim) {
    const img = lbImg();
    if (!img) return;
    img.style.transition = anim === 'none'
      ? 'none'
      : 'transform .26s cubic-bezier(.22,.61,.36,1)';
    img.style.transform = `translate3d(${lbView.tx}px, ${lbView.ty}px, 0) scale(${lbView.scale})`;
  }

  /** 把平移限制在「图片边缘不跑进屏幕里」，避免拖走之后找不回来 */
  function lbClampPan() {
    const img = lbImg();
    const stage = lbStage();
    if (!img || !stage) return;
    if (lbView.scale <= 1.001) { lbView.tx = 0; lbView.ty = 0; return; }
    const r = img.getBoundingClientRect();     // 已含 scale 的实际显示尺寸
    const maxX = Math.max(0, (r.width - stage.clientWidth) / 2);
    const maxY = Math.max(0, (r.height - stage.clientHeight) / 2);
    lbView.tx = Math.max(-maxX, Math.min(maxX, lbView.tx));
    lbView.ty = Math.max(-maxY, Math.min(maxY, lbView.ty));
  }

  function lbZoomTo(scale, cx, cy, anim) {
    const stage = lbStage();
    const prev = lbView.scale;
    const next = Math.max(1, Math.min(LB_MAX_SCALE, scale));
    if (stage) {
      // 以手势中心为锚点缩放：锚点相对 stage 中心的偏移要按比例补偿
      const rect = stage.getBoundingClientRect();
      const ox = cx - (rect.left + rect.width / 2);
      const oy = cy - (rect.top + rect.height / 2);
      const k = next / prev;
      lbView.tx = ox - (ox - lbView.tx) * k;
      lbView.ty = oy - (oy - lbView.ty) * k;
    }
    lbView.scale = next;
    lbClampPan();
    lbApply(anim);
  }

  /** 从 data-gal 属性解析一组图片地址（图组由渲染时写入，用于灯箱左右切换） */
  function parseGallery(json) {
    try {
      const arr = JSON.parse(json || '[]');
      return Array.isArray(arr) ? arr.filter(Boolean) : [];
    } catch { return []; }
  }

  /** 找出图片所属的图组：同一个容器里的图片算一组 */
  function galleryOf(el) {
    const wrap = el && el.closest ? el.closest('[data-gal]') : null;
    if (wrap) {
      const gal = parseGallery(wrap.getAttribute('data-gal'));
      if (gal.length) return gal;
    }
    const one = el ? imgSrcOf(el) : '';
    return one ? [one] : [];
  }

  function ensureLightbox() {
    let el = $('#lightbox');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'lightbox';
    el.innerHTML = `
        <div class="lb-inner">
          <div class="lb-stage">
            <img class="lb-img" alt="大图预览" draggable="false">
          </div>
          <button type="button" class="lb-nav lb-prev" data-act="lb-prev" title="上一张（←）" aria-label="上一张">‹</button>
          <button type="button" class="lb-nav lb-next" data-act="lb-next" title="下一张（→）" aria-label="下一张">›</button>
          <div class="lb-counter"></div>
          <div class="lb-zoom-tip">双指缩放 · 双击放大</div>
          <button type="button" class="lb-close" data-act="lb-close" title="关闭">✕</button>
        </div>`;
    /* ★ v2.0.0 修「进入全屏后再单击出现异常行为」。
       旧写法在 `mousedown` 里关灯箱。问题是：mousedown 一关，`#lightbox` 立刻
       visibility:hidden，紧接着浏览器做 **click 的命中测试**，此刻指针下面已经是
       灯箱底下的那张缩略图（`data-act="img-view"`）—— 于是「关闭」的那一下点击
       顺手把灯箱又打开了，看起来就是「关不掉 / 闪一下又弹回来」。
       现在改成：
         · 关闭走 `click`（命中测试发生在隐藏之前，目标就是灯箱自身，不会穿透）；
         · 单击图片本身延迟 260ms 关闭，给双击缩放留出取消窗口；
         · 缩放状态下单击是「准备拖动」，不关闭；
         · 左右切换 / ✕ 按钮不参与这套判定。
       另外把原先散在两个 mousedown 监听里的逻辑合到一处 ——
       同一个元素上挂两个 mousedown，读代码的人根本看不出来它们会互相影响。 */
    const lbCancelClose = () => {
      if (lbView.closeTimer) { clearTimeout(lbView.closeTimer); lbView.closeTimer = null; }
    };
    // 桌面拖动状态。放在这里（而不是下面 mousedown 的旁边）是因为它现在被
    // 上面那个合并后的 mousedown 写入、被 window 上的 mousemove/mouseup 读取。
    let lbDrag = null;

    el.addEventListener('mousedown', (e) => {
      // 只剩一件事：放大之后的拖动查看（不 preventDefault 会选中文字/触发原生拖图）
      if (lbView.scale <= 1.001 || !e.target.closest || !e.target.closest('.lb-stage')) return;
      lbDrag = { x: e.clientX, y: e.clientY, tx: lbView.tx, ty: lbView.ty };
      el.classList.add('dragging');
      e.preventDefault();
    });

    el.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      // 翻页与关闭按钮自己会处理，别让它们顺带把灯箱关掉
      if (t.closest('.lb-nav') || t.closest('.lb-close')) { lbCancelClose(); return; }
      const onStage = !!t.closest('.lb-stage');
      if (!onStage) { lbCancelClose(); closeLightbox(); return; }
      // 放大状态下单击是拖动的前奏；双击缩放也走这里，所以不下手关闭
      if (lbView.scale > 1.001) return;
      if (lbView.closeTimer) return;
      lbView.closeTimer = setTimeout(() => { lbView.closeTimer = null; closeLightbox(); }, 260);
    });

    const touchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const touchMid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

    el.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        // 双指：进入缩放模式，同时取消可能已开始的横滑
        lbView.swiping = false;
        lbView.panning = false;
        lbView.base = { kind: 'pinch', dist: touchDist(e.touches), scale: lbView.scale, tx: lbView.tx, ty: lbView.ty };
        e.touches.length === 2 && lbEl().classList.add('zoomed');
        return;
      }
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      lbView.swiping = false;
      lbView.panning = lbView.scale > 1.001;
      lbView.base = {
        kind: lbView.panning ? 'pan' : 'swipe',
        x: t.clientX, y: t.clientY, tx: lbView.tx, ty: lbView.ty, scale: lbView.scale,
      };
    }, { passive: true });

    el.addEventListener('touchmove', (e) => {
      const b = lbView.base;
      if (!b) return;

      if (e.touches.length === 2 && b.kind === 'pinch') {
        const d = touchDist(e.touches);
        if (!b.dist) return;
        const scale = b.scale * (d / b.dist);
        const mid = touchMid(e.touches);
        lbZoomTo(scale, mid.x, mid.y, 'none');
        if (e.cancelable) e.preventDefault();
        return;
      }

      if (e.touches.length !== 1) return;
      const t = e.touches[0];

      if (b.kind === 'pan') {
        lbView.tx = b.tx + (t.clientX - b.x);
        lbView.ty = b.ty + (t.clientY - b.y);
        lbClampPan();
        lbApply('none');
        if (e.cancelable) e.preventDefault();
        return;
      }

      // 未放大：横向滑动切换，跟手位移 → 松手再决定切不切
      const dx = t.clientX - b.x;
      const dy = t.clientY - b.y;
      if (!lbView.swiping && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.3) lbView.swiping = true;
      if (lbView.swiping) {
        // 单张图时不给位移反馈（滑了也没下一张，反馈反而让人以为能滑）
        if (lbView.gallery.length > 1) {
          lbView.tx = dx;
          lbApply('none');
        }
        if (e.cancelable) e.preventDefault();
      }
    }, { passive: false });

    el.addEventListener('touchend', (e) => {
      const b = lbView.base;
      lbView.base = null;
      if (!b) return;

      if (b.kind === 'pinch') {
        // 捏合到 1 附近就归位，避免留下一点点缩放让人难受
        if (lbView.scale < 1.12) { lbView.scale = 1; lbView.tx = 0; lbView.ty = 0; lbApply(); }
        else lbApply();
        lbEl().classList.toggle('zoomed', lbView.scale > 1.001);
        return;
      }

      if (b.kind === 'pan') { lbClampPan(); lbApply(); return; }

      const t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - b.x;
      const moved = lbView.swiping;
      lbView.swiping = false;
      if (moved && Math.abs(dx) > 60 && lbView.gallery.length > 1) {
        lbStepTo(dx < 0 ? 1 : -1);
      } else {
        lbView.tx = 0; lbView.ty = 0;
        if (moved) lbApply();            // 回弹
      }

      // 双击缩放：两次轻击间隔 < 300ms 且没有明显位移
      const now = Date.now();
      if (Math.abs(dx) < 12) {
        if (now - lbView.lastTap < 300) {
          lbView.lastTap = 0;
          if (lbView.scale > 1.001) { lbView.scale = 1; lbView.tx = 0; lbView.ty = 0; lbApply(); lbEl().classList.remove('zoomed'); }
          else lbZoomTo(LB_DBL_SCALE, t.clientX, t.clientY);
          lbEl().classList.toggle('zoomed', lbView.scale > 1.001);
        } else {
          lbView.lastTap = now;
        }
      }
    });

    // 桌面：双击放大 / 还原
    el.addEventListener('dblclick', (e) => {
      if (!e.target.closest('.lb-stage')) return;
      // 双击的意思是「放大」，不是「关闭」—— 先把单击排下的那次关闭取消掉
      lbCancelClose();
      if (lbView.scale > 1.001) { lbView.scale = 1; lbView.tx = 0; lbView.ty = 0; lbApply(); }
      else lbZoomTo(LB_DBL_SCALE, e.clientX, e.clientY);
      el.classList.toggle('zoomed', lbView.scale > 1.001);
    });

    // 桌面：鼠标拖动平移（放大后才有意义）
    window.addEventListener('mousemove', (e) => {
      if (!lbDrag) return;
      lbView.tx = lbDrag.tx + (e.clientX - lbDrag.x);
      lbView.ty = lbDrag.ty + (e.clientY - lbDrag.y);
      lbClampPan();
      lbApply('none');
    });
    window.addEventListener('mouseup', () => {
      if (!lbDrag) return;
      lbDrag = null;
      const box = lbEl();
      if (box) box.classList.remove('dragging');
      lbApply();
    });

    // 桌面：滚轮缩放
    el.addEventListener('wheel', (e) => {
      if (!e.target.closest('.lb-stage')) return;
      e.preventDefault();
      lbZoomTo(lbView.scale * (e.deltaY < 0 ? 1.18 : 1 / 1.18), e.clientX, e.clientY);
      el.classList.toggle('zoomed', lbView.scale > 1.001);
    }, { passive: false });

    document.body.appendChild(el);
    return el;
  }

  function lbRender() {
    const el = lbEl();
    if (!el) return;
    const n = lbView.gallery.length;
    const img = el.querySelector('.lb-img');
    if (img) {
      img.src = assetUrl(lbView.gallery[lbView.index] || '');
      img.style.opacity = '1';
    }
    el.classList.toggle('multi', n > 1);
    el.classList.toggle('zoomed', lbView.scale > 1.001);
    const counter = el.querySelector('.lb-counter');
    if (counter) counter.textContent = n > 1 ? `${lbView.index + 1} / ${n}` : '';
  }

  /** 前后翻页（循环），不带动画（键盘/按钮连续翻页时更跟手） */
  function lbStep(delta) {
    const n = lbView.gallery.length;
    if (n < 2) return;
    lbView.index = (lbView.index + delta + n) % n;
    lbView.scale = 1; lbView.tx = 0; lbView.ty = 0;
    lbRender();
    lbApply('none');
  }

  /**
   * 带过渡动画的翻页：新图从「滑来的方向」滑入并淡入，视觉上像整张图换了一张。
   *
   * ★ 下标与序号**同步**更新，不放进 setTimeout —— 这一条是刻意的：
   *   如果把下标更新推迟到动画中段，那 200ms 里「屏幕上显示的图」与
   *   「lbView.index 记录的下标」就是错位的 —— 此时再来一次手势或一次键盘翻页，
   *   就会从错位的下标继续算，翻错张（而且是那种「偶尔才复现」的偶发 bug）。
   *   状态永远只在同一帧更新，动画只负责视觉。
   * ★ 做法：先把新图瞬时放到「滑来方向」外侧 90px 并透明，强制回流，
   *   然后再让它过渡回中心 —— 两帧之间才存在过渡。
   */
  function lbStepTo(delta) {
    const n = lbView.gallery.length;
    const img = lbImg();
    if (n < 2) return;
    if (!img) { lbStep(delta); return; }
    const dir = delta > 0 ? 1 : -1;        // 1 = 看下一张（手指往左滑）

    // 1) 状态先落地：下标 / 缩放 / 平移全部归位，序号立刻跟着变
    lbView.index = (lbView.index + delta + n) % n;
    lbView.scale = 1; lbView.tx = 0; lbView.ty = 0;
    lbRender();
    lbEl().classList.remove('zoomed');

    // 2) 新图先瞬移到外侧（transition:none），回流一帧后再过渡回中心
    img.style.transition = 'none';
    img.style.transform = `translate3d(${dir * 90}px, 0, 0) scale(1)`;
    img.style.opacity = '0';
    void img.offsetWidth;                  // 强制回流，让下面那次过渡真的从这一帧开始
    img.style.transition = 'transform .24s cubic-bezier(.22,.61,.36,1), opacity .2s ease-out';
    img.style.transform = 'translate3d(0, 0, 0) scale(1)';
    img.style.opacity = '1';
  }

  /**
   * 打开大图。
   * @param {string} src 当前这张
   * @param {string[]} [gallery] 同组图片（用于左右切换）；不传则按单图处理
   */
  function openLightbox(src, gallery) {
    const el = ensureLightbox();
    let gal = Array.isArray(gallery) ? gallery.filter(Boolean) : [];
    if (!gal.length && src) gal = [src];
    // 防御：图组里没有当前图时把当前图补到最前，避免打开后显示空白
    if (src && gal.indexOf(src) < 0) gal = [src].concat(gal);
    let idx = src ? gal.indexOf(src) : 0;
    if (idx < 0) idx = 0;
    lbView.gallery = gal;
    lbView.index = idx;
    lbView.scale = 1; lbView.tx = 0; lbView.ty = 0;
    const img = el.querySelector('.lb-img');
    if (img) { img.style.transition = 'none'; img.style.transform = 'translate3d(0,0,0) scale(1)'; }
    lbRender();
    el.classList.remove('zoomed');
    el.classList.add('show');
    // 让「淡入 + 轻微放大」的入场动画真的从初始态开始播
    void el.offsetWidth;
    el.classList.add('ready');
  }

  function closeLightbox() {
    const el = lbEl();
    // 已经排下的「单击图片延迟关闭」也一并取消，避免关掉之后又被它触发一次
    if (lbView.closeTimer) { clearTimeout(lbView.closeTimer); lbView.closeTimer = null; }
    if (!el) return;
    el.classList.remove('show');
    el.classList.remove('ready');
    el.classList.remove('multi');
    el.classList.remove('zoomed');
    lbView.gallery = [];
    lbView.index = 0;
    lbView.scale = 1; lbView.tx = 0; lbView.ty = 0;
    lbView.base = null; lbView.swiping = false;
    const img = el.querySelector('.lb-img');
    if (img) { img.removeAttribute('src'); img.style.transform = ''; }
  }

  /* ═══ 图片长按 / 右键菜单：查看大图、保存图片 ═══════════ */

  const MENU_SELECTOR = '.post-imgs img, .rec-thumbs img, .rec-view-imgs img, .thumb img, #lightbox img';
  const longPress = { timer: null, fired: false };

  function closeImgMenu() {
    const m = $('#img-menu');
    if (m) m.remove();
  }

  function openImgMenu(src, x, y, gallery) {
    closeImgMenu();
    if (!src) return;
    const menu = document.createElement('div');
    menu.id = 'img-menu';
    menu.setAttribute('data-gal', JSON.stringify(Array.isArray(gallery) && gallery.length ? gallery : [src]));
    menu.innerHTML = `
      <button type="button" data-act="img-menu-view" data-src="${esc(src)}">🔍 查看大图</button>
      <button type="button" data-act="img-menu-save" data-src="${esc(src)}">⬇️ 保存图片</button>
      <button type="button" data-act="img-menu-cancel">取消</button>`;
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  }

  function imgSrcOf(img) {
    return img.getAttribute('src') || img.src || '';
  }

  // 桌面：右键弹菜单（替代浏览器默认图片菜单，交互一致）
  document.addEventListener('contextmenu', (e) => {
    const img = e.target && e.target.closest ? e.target.closest(MENU_SELECTOR) : null;
    if (!img) return;
    e.preventDefault();
    openImgMenu(imgSrcOf(img), e.clientX, e.clientY, galleryOf(img));
  });

  // 移动端：长按 500ms 弹菜单
  document.addEventListener('touchstart', (e) => {
    const img = e.target && e.target.closest ? e.target.closest(MENU_SELECTOR) : null;
    if (!img || e.touches.length !== 1) return;
    const t = e.touches[0];
    longPress.fired = false;
    clearTimeout(longPress.timer);
    longPress.timer = setTimeout(() => {
      longPress.fired = true;
      openImgMenu(imgSrcOf(img), t.clientX, t.clientY, galleryOf(img));
    }, 500);
  }, { passive: true });
  document.addEventListener('touchmove', () => clearTimeout(longPress.timer), { passive: true });
  document.addEventListener('touchend', (e) => {
    clearTimeout(longPress.timer);
    // 长按已弹菜单时，吞掉随后的合成 click，避免误开灯箱
    if (longPress.fired) { longPress.fired = false; if (e.cancelable) e.preventDefault(); }
  }, { passive: false });
  document.addEventListener('touchcancel', () => clearTimeout(longPress.timer));

  /* ═══ 通用长按（记录本分类删除等） ═══════════════════════
     手机上长按 500ms、电脑上右键，触发 [data-longpress] 上声明的动作。
     和图片长按分开维护：两类元素可能同时存在，合在一起会互相打断计时。 */
  const lpGeneric = { timer: null, fired: false };
  const lpTarget = (e) => (e.target && e.target.closest ? e.target.closest('[data-longpress]') : null);

  function runLongPress(el) {
    if (!el) return;
    const kind = el.dataset.longpress;
    if (kind === 'rec-cat') deleteRecordCategory(el.dataset.cat);
    // v1.9.0：长按记录卡片 = 归档 / 取消归档（不是删除，记录仍在库里、仍能搜到）
    else if (kind === 'rec-archive') toggleRecordArchived(Number(el.dataset.id));
    // v2.0.0：长按账单分类 = 删除该自定义分类（预置分类不带这个属性，点不到）
    else if (kind === 'bill-cat-del') delBillCategory(el.dataset.kind, el.dataset.cat);
  }

  document.addEventListener('touchstart', (e) => {
    const el = lpTarget(e);
    if (!el || e.touches.length !== 1) return;
    // 图片长按有自己的菜单（查看大图 / 保存图片），别和卡片长按同时触发两个菜单
    if (e.target.closest && e.target.closest(MENU_SELECTOR)) return;
    lpGeneric.fired = false;
    clearTimeout(lpGeneric.timer);
    lpGeneric.timer = setTimeout(() => { lpGeneric.fired = true; runLongPress(el); }, 500);
  }, { passive: true });
  document.addEventListener('touchmove', () => clearTimeout(lpGeneric.timer), { passive: true });
  document.addEventListener('touchend', (e) => {
    clearTimeout(lpGeneric.timer);
    // 长按已触发时吞掉随后的合成 click，避免「删除」之后又顺手做了一次筛选
    if (lpGeneric.fired) { lpGeneric.fired = false; if (e.cancelable) e.preventDefault(); }
  }, { passive: false });
  document.addEventListener('touchcancel', () => clearTimeout(lpGeneric.timer));
  document.addEventListener('contextmenu', (e) => {
    const el = lpTarget(e);
    if (!el) return;
    if (e.target.closest && e.target.closest(MENU_SELECTOR)) return;   // 同上：图片走图片菜单
    e.preventDefault();
    runLongPress(el);
  });

  /* ═══ 记录本归档（v1.9.0） ═══════════════════════════════
     归档 ≠ 删除：记录仍在库里、仍能被搜索命中，只是默认列表不再展示。
     入口是长按（手机）/ 右键（桌面）记录卡片，与「长按删除分类」共用一套手势。 */

  async function toggleRecordArchived(id) {
    const r = state.records.find((x) => x.id === id);
    if (!r) return;
    const to = !r.archived;
    const word = to ? '归档' : '取消归档';
    if (!window.confirm(`确定${word}「${r.title}」吗？\n\n归档只是把它收起来，记录还在，搜索也照样能搜到。`)) return;
    try {
      await api('/api/records/' + id, { method: 'PATCH', body: { archived: to } });
      await refreshRecords();
      toast(to ? '已归档（切到「已归档」可查看）' : '已取消归档', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  /* ═══ 版块红点（v1.9.0） ═════════════════════════════════
     规则：某个版块里「别人」的最新更新时间 > 我上次查看该版块的时间 → 亮红点。
     与微信朋友圈一致：自己发的内容不给自己亮点。
     时间由服务端算（可见性已过滤），这里只负责比较与画角标。 */

  /* v4.10.0（差异 #20）：记账 Tab 也有红点 —— 家人记了新账，进记账页后消除 */
  const TAB_KIND = { calendar: 'todo', moments: 'post', records: 'record', bills: 'bill' };

  function unreadMap() {
    const l = (state.seen && state.seen.latest) || {};
    const s = (state.seen && state.seen.seen) || {};
    const out = {};
    Object.keys(TAB_KIND).forEach((tab) => {
      const k = TAB_KIND[tab];
      out[k] = !!l[k] && (!s[k] || String(l[k]) > String(s[k]));
    });
    return out;
  }

  function paintDots() {
    const u = unreadMap();
    $$('#tabbar button').forEach((b) => {
      const k = TAB_KIND[b.dataset.tab];
      b.classList.toggle('has-dot', !!(k && u[k]));
    });
  }

  async function refreshSeen() {
    try {
      const out = await api('/api/seen');
      state.seen = { latest: out.latest || {}, seen: out.seen || {} };
      paintDots();
    } catch { /* 红点是提示性的，拿不到就算了，不能影响主流程 */ }
  }

  async function markTabSeen(tab) {
    const kind = TAB_KIND[tab];
    if (!kind) return;
    // 先本地置为已读（立刻灭点），再异步落库；失败不回滚 —— 红点不值得打断用户
    state.seen.seen = state.seen.seen || {};
    state.seen.seen[kind] = new Date().toISOString();
    paintDots();
    try { await api('/api/seen', { method: 'POST', body: { kind } }); } catch { /* 忽略 */ }
  }

  /* ═══ 月份切换：左右滑动（v1.9.0） ═══════════════════════
     待办日历与「动态日历」共用这套手势，靠 data-cal 区分切的是哪一个月份。
     只认「明确偏横向」的滑动：纵向滚动列表时绝不拦截，
     否则最容易被投诉的就是「滑不动列表」。 */
  const calSwipe = { el: null, x: 0, y: 0, active: false };

  function shiftMonth(which, delta) {
    const cur = which === 'post' ? state.postCalCursor
      : which === 'bill' ? state.billCalCursor : state.cursor;
    cur.m += delta;
    if (cur.m < 0) { cur.m = 11; cur.y--; }
    if (cur.m > 11) { cur.m = 0; cur.y++; }
    state.calAnim = delta > 0 ? 'left' : 'right';    // render() 消费一次后清空
    if (which === 'bill') {
      /* v4.9.0 需求 2：记账日历翻月 —— 新月份的聚合数据要先拉回来再画 */
      state.billCalDay = '';
      state.billCalDayBills = null;
      refreshBillCalendar().then(render).catch(() => {});
    }
    render();
  }

  document.addEventListener('touchstart', (e) => {
    const grid = e.target.closest ? e.target.closest('.cal-grid[data-cal]') : null;
    if (!grid || e.touches.length !== 1) return;
    calSwipe.el = grid;
    calSwipe.x = e.touches[0].clientX;
    calSwipe.y = e.touches[0].clientY;
    calSwipe.active = false;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!calSwipe.el || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - calSwipe.x;
    const dy = e.touches[0].clientY - calSwipe.y;
    if (!calSwipe.active && Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 1.4) calSwipe.active = true;
    if (calSwipe.active && e.cancelable) e.preventDefault();
  }, { passive: false });

  document.addEventListener('touchend', (e) => {
    const grid = calSwipe.el;
    const active = calSwipe.active;
    const x0 = calSwipe.x;
    calSwipe.el = null;
    calSwipe.active = false;
    if (!grid || !active) return;
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - x0;
    if (Math.abs(dx) < 50) return;                  // 位移太小当成误触
    shiftMonth(grid.dataset.cal, dx < 0 ? 1 : -1);  // 往左滑 = 看下个月
  });
  document.addEventListener('touchcancel', () => { calSwipe.el = null; calSwipe.active = false; });

  /* ═══ 动态视频（v1.9.0） ═══════════════════════════════ */

  /* v4.10.0：视频上限后台可配（settings.upload_video_max_mb 经 /api/config 下发 videoMaxMb） */
  const maxVideoMb = () => Number(state.config.videoMaxMb)
    || Number(state.config.maxVideoMb) || 50;
  const postVideoMax = () => Number(state.config.postVideoMax) || 3;

  /** 选中的文件先本地判定「是不是视频」，别拿一张图去走视频通道 */
  const looksLikeVideo = (file) =>
    /^video\//.test(String(file.type || '')) ||
    /\.(mp4|m4v|mov|webm)$/i.test(String(file.name || ''));

  async function uploadVideo(file, onProgress) {
    const dataUrl = await readAsDataUrl(file);
    const size = dataUrlBytes(dataUrl);
    if (size > maxVideoMb() * 1024 * 1024) {
      throw new Error(`「${file.name}」有 ${fmtBytes(size)}，超过视频上限 ${maxVideoMb()}MB`);
    }
    /* v4.6.0 需求 4：封面跟视频**一起**提交，服务端把它落成 `<视频同名>.cover.jpg`。
       这样封面和视频是同生共死的，不依赖任何「路径 → 封面」的 JSON 映射 ——
       共创里的视频、旧帖里的视频，前端都能按路径约定推出封面地址（见 videoPosterOf）。
       抽帧失败（老浏览器 / 特殊编码）也不影响视频本身，只是没有封面。 */
    const coverDataUrl = await captureVideoCover(file);
    const out = await xhrUpload('/api/upload-video', {
      name: file.name, dataUrl, cover: coverDataUrl || '',
    }, onProgress);
    /* 服务端没接住侧车封面（例如视频端点是旧版）时，退回「单独上传一张图」的老路子，
       至少还能写进 posts.video_covers 映射里，别让封面就这么丢了。 */
    let cover = out && out.cover ? String(out.cover) : '';
    if (!cover && coverDataUrl) cover = await uploadVideoCover(coverDataUrl);
    /* v4.12.0 需求（动态模块）：缩略图要「上传完成即显示」。
       封面此刻已经是一份 dataURL 在手（抽帧结果），直接挂进本地封面表 —— 之后任何一次
       posterOf() 都会先命中它：0 次网络请求、不用等服务端那份图下载完。
       ★ 只在内存里，绝不写进 dataset.videoCovers（那是要提交给服务端入库的，
         塞一段 base64 进去会把库撑爆）。刷新页面后自然回落到服务端那份。 */
    if (coverDataUrl) localCovers.set(String(out.path), coverDataUrl);
    return { path: out.path, cover };
  }

  /**
   * v4.3.3 需求 8 / v4.6.0 需求 4：从视频文件抽第一帧，返回 dataURL（失败返回空串）。
   *
   * 为什么必须真的抽帧：`#t=0.1` 这个媒体片段技巧在桌面 Chrome 有效，
   * 但 iOS Safari 不认，部分安卓 WebView 在 preload=metadata 时也只解元数据、
   * 不绘制画面 —— 表现就是**手机上动态里的视频是一排黑框**（桌面看却正常）。
   * 只有 poster 是跨端可靠的。
   *
   * ★ v4.6.0 定位到的真正根因（移动端"仍然没有预览图"就是这么来的）：
   *   旧实现把抽帧挂在 `loadeddata` 上、同时设 `preload='metadata'`。这两件事互相矛盾 ——
   *   `loadeddata` 表示"已经解出第一帧的画面数据"，而 `preload='metadata'` 明确只让浏览器取
   *   容器元数据（时长、尺寸）。桌面 Chrome 会超额下载所以照样触发；**iOS Safari 严格遵守，
   *   只触发 `loadedmetadata`，`loadeddata` 永远不来** → 抽帧代码一次都没执行 → 没有 poster
   *   → 退回 `#t=0.1` → iOS 又不认这个片段 → 黑框。修法：
   *   ① 改挂 `loadedmetadata`（它一定会来），再由它去 seek 触发 `seeked`；
   *   ② `preload='auto'` + 显式 `load()`，让浏览器真的去解码；
   *   ③ 超时拆成两段（见下），既不拖慢没有解码能力的环境，又给真机足够时间。
   *
   * ★ 1.2 秒的整体超时是给 jsdom / 无解码环境准备的：那里既不会有 metadata 也不会有 seeked，
   *   不设超时就会永远挂住，把「上传视频」这个动作卡死。但真机上 1.2 秒远远不够 ——
   *   一段 30 秒的手机视频光定位关键帧就要几百毫秒。所以拆成：
   *   **1.2 秒内没拿到元数据 = 这个环境根本解不了，直接放弃**；
   *   **拿到元数据之后再给 6 秒**去取那一帧。jsdom 里第一段就到点退出，测试不会变慢。
   */
  function captureVideoCover(file) {
    return new Promise((resolve) => {
      let url = '';
      let done = false;
      let timer = null;
      let probe = null;
      const finish = (val) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        try { if (url) URL.revokeObjectURL(url); } catch { /* 忽略 */ }
        // 离屏探针必须摘掉，否则每传一段视频就在 body 里留一个 1×1 的 <video>（还会占解码器）
        try { if (probe && probe.parentNode) probe.parentNode.removeChild(probe); } catch { /* 忽略 */ }
        resolve(val || '');
      };
      // 第一段：连元数据都拿不到 → 这个环境解不了视频，立刻放弃（别拖住上传）
      timer = setTimeout(() => finish(''), 1200);
      try {
        url = URL.createObjectURL(file);
        /* ★ v4.12.0：必须把 <video> 挂进文档再抽帧。
           iOS Safari 与部分安卓 WebView 对「不在文档里」的媒体元素不保证解码出画面 ——
           drawImage 抽到的是一张纯黑帧，而且不报错。这就是「封面明明抽到了，手机上还是黑图」
           的另一半根因（前一半是 v4.6.0 修的 loadeddata/preload 矛盾）。
           容器用 .media-probe：定位到视口外、1×1、opacity:0，仍然参与布局（不是 display:none，
           那样又会被当成不可见而停止解码）。 */
        probe = document.createElement('div');
        probe.className = 'media-probe';
        probe.setAttribute('aria-hidden', 'true');
        document.body.appendChild(probe);
        const v = document.createElement('video');
        v.preload = 'auto';
        v.muted = true;
        v.playsInline = true;
        v.setAttribute('playsinline', '');
        // 抽帧只需要画面，不需要声音；挂上 muted 也避免部分安卓自动播放策略拦下解码
        v.src = url;
        probe.appendChild(v);
        let cand = [];               // v4.17.0：候选抽帧时间点（见下）
        let ci = 0;
        let drew = false;
        /** 黑帧 / 纯色帧判定（v4.17.0 需求 6 方案A）：抽约 512 个采样点算亮度 ——
            整帧全黑（avg < 6）或整帧几乎同色（极差 < 3）都算「没抽到画面」。
            读不到像素（跨域 / 无解码环境）就当「有画面」，维持原有行为。 */
        const isBlankFrame = (ctx, w, h) => {
          try {
            const data = ctx.getImageData(0, 0, w, h).data;
            const step = Math.max(4, Math.floor(data.length / 4 / 512) * 4);
            let sum = 0;
            let min = 255;
            let max = 0;
            let n = 0;
            for (let i = 0; i < data.length; i += step) {
              const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
              sum += lum;
              n++;
              if (lum < min) min = lum;
              if (lum > max) max = lum;
            }
            if (!n) return true;
            const avg = sum / n;
            return avg < 6 || (max - min) < 3;
          } catch { return false; }
        };
        const seekTo = (t) => { try { v.currentTime = t; } catch { draw(); } };
        const draw = () => {
          if (drew) return;
          try {
            const w = 480;
            const ratio = (v.videoHeight || 270) / (v.videoWidth || 480);
            const c = document.createElement('canvas');
            c.width = w;
            c.height = Math.max(1, Math.round(w * ratio));
            const ctx = c.getContext('2d');
            ctx.drawImage(v, 0, 0, c.width, c.height);
            /* 抽到黑场且还有候选时间点 → 往后换一个点再抽（不再一次失败就放弃） */
            if (isBlankFrame(ctx, c.width, c.height) && ci < cand.length - 1) {
              ci++;
              seekTo(cand[ci]);
              return;
            }
            drew = true;
            /* v4.13.0（问题 3）：先编码成 **Blob**（JPEG），再读成 dataURL 提交。
               Blob 是压缩后的真实字节，避免 toDataURL 那串 base64 在内存里多存一份；
               提交接口仍收 dataURL（JSON 通道不变），服务端落成视频的 sidecar 封面。 */
            if (typeof c.toBlob === 'function') {
              c.toBlob((blob) => {
                if (!blob) { finish(''); return; }
                try {
                  const fr = new FileReader();
                  fr.onload = () => finish(String(fr.result || ''));
                  fr.onerror = () => finish('');
                  fr.readAsDataURL(blob);
                } catch { finish(''); }
              }, 'image/jpeg', 0.72);
            } else {
              finish(c.toDataURL('image/jpeg', 0.72));
            }
          } catch { drew = true; finish(''); }
        };
        v.onloadedmetadata = () => {
          if (done) return;
          // 元数据到手 = 这个环境能解码，第二段给足 6 秒去取帧
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => finish(''), 6000);
          /* v4.17.0 需求 6 方案A：候选时间点序列 —— 10%（夹 0.15–1s）→ 25% → 中点。
             第 0 帧常常是黑场（很多手机录制的第一帧就是纯黑），一个点抽到黑场就往后换；
             极短视频（<0.6 秒）只用中点，否则夹取区间会超过片长本身、seek 到末尾反而拿到空帧。 */
          const dur = Number(v.duration) || 0;
          cand = dur > 0 && dur < 0.6 ? [dur / 2]
            : dur > 0 ? [
                Math.min(1, Math.max(0.15, dur * 0.1)),
                Math.min(Math.max(0.05, dur - 0.05), Math.max(0.3, dur * 0.25)),
                dur / 2,
              ].filter((t, i, arr) => arr.indexOf(t) === i)
              : [0.1];
          ci = 0;
          seekTo(cand[0]);
        };
        // 桌面浏览器常常直接有画面数据，别错过
        v.onloadeddata = () => { if (!done && v.currentTime > 0) draw(); };
        v.onseeked = draw;
        v.onerror = () => finish('');
        // 有些浏览器不设这个就不会主动去拉数据（尤其 iOS）
        if (typeof v.load === 'function') v.load();
      } catch { finish(''); }
    });
  }

  /** 兜底路径：把已经抽好的 dataURL 单独当图片传上去（服务端没接住侧车封面时才用） */
  async function uploadVideoCover(dataUrl) {
    if (!dataUrl) return '';
    try {
      const out = await xhrUpload('/api/upload', { name: 'video-cover.jpg', dataUrl });
      return out && out.path ? String(out.path) : '';
    } catch { return ''; }
  }

  /* v2.0.0 需求 2：给视频列表补上缩略图。
     光写 `preload="metadata"` 是不够的 —— Safari 与部分安卓浏览器在没拿到
     播放指令时只解码元数据、并不绘制任何一帧，列表里就是一排黑框。
     在地址后面挂 `#t=0.1`（媒体片段），浏览器就会**定位到 0.1 秒并把那一帧画出来**，
     这样列表里看到的是真实画面而不是黑块。
     ⚠️ 已经带 `#` 的地址不重复追加（同一份 path 可能被复用）。 */
  /* v4.6.0 需求 4：封面一律「谁上传谁抽帧、跟着视频一起落库」。
     ★ 曾经想用「路径约定」猜封面地址（x.mp4 → x.cover.jpg），最后放弃了：
       老视频根本没有这个文件，猜出来的地址只会 404 —— 而 404 的 poster 会让浏览器
       干脆什么都不画（连 #t=0.1 那一帧也不给），比「没有封面」更糟。
       所以这里只认真实存在的映射：posts.video_covers / post_contribs.video_covers。 */
  /* v4.12.0：本会话内的「抽帧结果」封面表（path → dataURL）。
     为什么需要它：服务端那份封面地址还要再走一次网络，弱网/大图下就是
     「上传完成 → 转圈 → 才出图」（PC 上尤其明显）。抽帧本来就已经拿到了 dataURL，
     直接拿它当 poster 就能做到「上传完成的那一刻缩略图就在」。
     只在内存里，刷新页面后回落到服务端那份（不影响持久化，也不改接口）。 */
  const localCovers = new Map();

  const posterOf = (src, covers) => {
    const local = localCovers.get(String(src || ''));
    if (local) return local;
    return covers && covers[src] ? String(covers[src]) : '';
  };

  const videoThumb = (src) => {
    const s = String(src || '');
    if (!s || s.indexOf('#') >= 0) return s;
    return s + '#t=0.1';
  };

  /** v4.3.3：把 [{path, cover}] 或已经是 {path: cover} 的映射统一成映射 */
  const coverMapOf = (list) => {
    if (!list) return {};
    if (!Array.isArray(list)) return list;
    const m = {};
    for (const v of list) if (v && v.path && v.cover) m[v.path] = v.cover;
    return m;
  };

  /** 视频列表的编辑器缩略（静态首帧，不自动播放）
   *  v4.3.3 需求 8：有真实封面（poster）时优先用它，并把 `#t=0.1` 去掉 ——
   *  两个都挂着会让浏览器先按片段定位一次、再用 poster 覆盖，白费一次解码。
   *  v4.12.0：有封面时把 `preload` 降成 `none`，再叠一张 `<img>` 当缩略图。
   *  原因有两个：
   *   ① `preload="metadata"` 会真的去下载视频头部（手机上动辄几 MB）+ 再解一帧，
   *      而这两件事对「看图」毫无帮助 —— 这是 PC 端「缩略图要等一会儿才出来」的来源；
   *   ② `<video poster>` 在部分安卓 WebView / 微信内置浏览器里要等元数据才肯画，
   *      而 preload=none 时元数据永远不来 → 又变回黑框。`<img>` 的解码路径最短、最可靠。 */
  function videoChipHtml(items, delAct, boxId, covers) {
    return items.map((src, i) => {
      const poster = posterOf(src, covers);
      const attr = poster ? ` poster="${esc(assetUrl(poster))}"` : '';
      const s = poster ? String(src) : videoThumb(src);
      const preload = poster ? 'none' : 'metadata';
      // 叠层用 <img>，不吃点击（pointer-events: none 写在 CSS 里），删除按钮照旧可点
      /* ★ v4.26.0：叠层 src 也必须走 assetUrl —— 网关带前缀时 poster 属性是对的、
         这张 <img> 却打到网关根路径 404，移动端就只剩一个碎图标。 */
      const coverImg = poster ? `<img class="vchip-poster" src="${esc(assetUrl(poster))}" alt="">` : '';
      return `<div class="vchip"><video src="${esc(s)}"${attr} preload="${preload}" muted playsinline></video>${coverImg}` +
        `<span class="vchip-play" aria-hidden="true">▶</span>` +
        `<button type="button" data-act="${delAct}" data-i="${i}" data-box="${boxId}">×</button></div>`;
    }).join('');
  }

  /* 视频播放器。
     v4.6.0 需求 4：除了给 <video> 挂 poster，还在它上面叠一张 <img>（窄屏/触屏才显示）。
     为什么要多这一层：`<video poster>` 在部分安卓 WebView / 微信内置浏览器里要等元数据
     才肯把 poster 画出来，而不带 preload 的远程视频在弱网下元数据要等好几秒 ——
     用户看到的就是一块黑。`<img>` 的解码路径最短、最可靠，点它就直接开播。
     桌面端不显示这层，原生控件该有的行为一点不变。 */
  const videoPlayerHtml = (items, covers) => (items && items.length
    ? `<div class="post-videos">${items.map((src, i) => {
      const poster = posterOf(src, covers);
      const attr = poster ? ` poster="${esc(assetUrl(poster))}"` : '';
      const s = poster ? String(src) : videoThumb(src);
      // v4.12.0：有封面就不预载视频数据（一屏好几段视频时，这一条能省掉全部元数据请求）
      const preload = poster ? 'none' : 'metadata';
      const coverImg = poster
        ? `<img class="pv-poster" src="${esc(assetUrl(poster))}" alt="视频预览" loading="lazy" data-act="pv-start">`
        : '';
      /* v4.26.0（P1）：这一格是 ArtPlayer 的挂载点。
         · 空 div，HTML 里不带任何播放器内容 —— 脚本没加载 / 加载失败时它就是 0 成本；
         · data-keep：让递归最小重绘**不要碰**这个子树（里面是播放器自己建的 DOM）；
         · data-key 带上序号与地址：视频被换掉时 key 变了 → 补丁算法会换成新节点，
           旧实例在 pruneArtPlayers() 里被 destroy，不会出现「换了视频还在放旧的」。 */
      const art = `<div class="pv-art" data-keep data-key="art-${i}-${esc(src)}"`
        + ` data-art-src="${esc(src)}" data-art-poster="${esc(poster)}"></div>`;
      return `<div class="pv-wrap"><video src="${esc(s)}"${attr} controls preload="${preload}" playsinline class="post-video"></video>` +
        `${coverImg}<span class="pv-play" aria-hidden="true">▶</span>${art}</div>`;
    }).join('')}</div>`
    : '');

  /* 封面图 404（旧视频没有侧车封面）时，把这张叠层摘掉 ——
     否则移动端会显示成一个碎图标，比没有封面更难看。捕获阶段接，img 的 error 不冒泡。
     v4.26.0：发布器里的 .vchip-poster 同样要摘（以前只认 .pv-poster，编辑框里留碎图标）。 */
  document.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t.classList && (t.classList.contains('pv-poster') || t.classList.contains('vchip-poster'))) {
      if (t.parentNode) t.parentNode.removeChild(t);
    }
  }, true);

  /* 「▶ 角标」在开播后要自己消失。用媒体事件而不是给 <video> 挂 data-act ——
     挂上去的话，点播放器的进度条 / 音量按钮也会走一次我们的点击处理，
     原生控件就不灵了。`play` / `pause` 不冒泡，所以必须用 capture 阶段接。 */
  document.addEventListener('play', (e) => {
    const box = e.target && e.target.closest ? e.target.closest('.pv-wrap') : null;
    if (box) box.classList.add('playing');
  }, true);
  const pvStop = (e) => {
    const box = e.target && e.target.closest ? e.target.closest('.pv-wrap') : null;
    if (box) box.classList.remove('playing');
  };
  document.addEventListener('pause', pvStop, true);
  document.addEventListener('ended', pvStop, true);

  /* ═══ v4.26.0（P1）：ArtPlayer —— 第三方播放器 ══════════════════════
   *
   * 【为什么引】原生 <video controls> 在三个端上是三套完全不同的控件：iOS 是系统浮层、
   *   安卓 Chrome 是灰色横条、微信内置又是另一套；没有倍速、没有统一的全屏、移动端
   *   手势（双击暂停 / 左右滑进度 / 长按倍速）全都得自己写。用 ~130KB 的 ArtPlayer
   *   换掉这一整摊兼容账，是我们对比 Plyr / xgplayer / Video.js 后的选择（中文文档、
   *   手势最全、MIT、零依赖、单文件）。
   *
   * 【怎么接】三条硬约束，缺一条都会变成为播放器拖累：
   *   ① 渐进增强 —— HTML 里永远先输出能播的原生 <video controls>；
   *      脚本没加载 / 加载失败 / 环境解不了，页面照常播放，只是没有花样式控件。
   *   ② 按需加载 —— 只在页面里真的出现视频时才去拉 vendor 脚本（不看不播零成本）。
   *   ③ 进入布局才挂 —— `clientWidth === 0` 说明它在一个隐藏页签里（或者根本没有布局
   *      引擎，比如 jsdom 测试环境）。这时建实例既看不见、又会占解码器，直接跳过；
   *      下次切到该页签触发 render 时会补挂。
   *
   * 【生命周期】`.pv-art[data-keep]` 是挂载点，实例存在 artLive 里：
   *   · 卡片被删 / 换页 → DOM 不在文档里 → pruneArtPlayers() 里 destroy；
   *   · 视频被换（data-key 变化）→ 补丁算法给一个新节点，旧节点同样走上面的销毁路径。
   *   不销毁的后果是每滚一次列表就多一个在后台跑定时器的实例，久了手机直接卡死。
   * ══════════════════════════════════════════════════════════════ */
  const ART_SRC = '/vendor/artplayer/artplayer.js';
  const artLive = new Map();        // .pv-art 元素 → { art, src }
  let artLoading = null;

  /** 按需加载一次（失败就是失败，不重试 —— 原生 <video> 仍然可用） */
  function ensureArtPlayer() {
    if (window.Artplayer) return Promise.resolve(window.Artplayer);
    if (artLoading) return artLoading;
    artLoading = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = assetUrl(ART_SRC);
      s.async = true;
      s.onload = () => resolve(window.Artplayer || null);
      s.onerror = () => { artLoading = null; resolve(null); };
      document.head.appendChild(s);
    });
    return artLoading;
  }

  function destroyArt(box) {
    const rec = artLive.get(box);
    if (!rec) return;
    artLive.delete(box);
    try { rec.art.destroy(); } catch { /* 实例可能已经自行销毁 */ }
    const wrap = box.parentNode;
    if (wrap && wrap.classList) wrap.classList.remove('art-on');
  }

  function pruneArtPlayers() {
    if (!artLive.size) return;
    for (const box of Array.from(artLive.keys())) {
      if (!document.body.contains(box)) destroyArt(box);
    }
  }

  /* ★ 极老 WebKit 没有 URL.revokeObjectURL（ArtPlayer 内部会调它销毁临时 blob）。
     补一个空实现，比让整个播放器初始化抛异常划算得多。 */
  if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL !== 'function') {
    URL.revokeObjectURL = () => {};
  }

  function mountArtPlayers() {
    /* 挂载点的高度靠 CSS aspect-ratio 撑（容器 0 高 → 播放器只有一条线）。
       老 WebKit（iOS 14 及更早）不支持它，这种环境就保持原生播放器 —— 能播比好看重要。 */
    if (!window.CSS || typeof CSS.supports !== 'function' || !CSS.supports('aspect-ratio', '16 / 9')) return;
    pruneArtPlayers();
    const boxes = Array.from(document.querySelectorAll('.pv-art[data-art-src]'));
    if (!boxes.length) return;
    const todo = boxes.filter((box) => {
      if (artLive.has(box)) return false;
      const wrap = box.parentNode;
      // 没进入布局（隐藏页签 / 无布局环境）就先不挂，等下次渲染
      return !!(wrap && wrap.clientWidth > 0);
    });
    if (!todo.length) return;

    ensureArtPlayer().then((AP) => {
      if (typeof AP !== 'function') return;   // 加载失败：原生播放器继续工作
      for (const box of todo) {
        if (artLive.has(box) || !document.body.contains(box)) continue;
        const wrap = box.parentNode;
        if (!wrap || !wrap.clientWidth) continue;
        const src = box.getAttribute('data-art-src') || '';
        if (!src) continue;
        const poster = box.getAttribute('data-art-poster') || '';
        try {
          /* 先让挂载点可见（.art-on 给它 16:9 的高度）再建实例：
             ArtPlayer 的高度是 100% 容器，容器 0 高的话画面只有一条线。 */
          wrap.classList.add('art-on');
          const art = new AP({
            container: box,
            url: assetUrl(src),
            poster: poster ? assetUrl(poster) : '',
            theme: '#3b7ddd',
            lang: 'zh-cn',
            autoplay: false,
            muted: false,
            volume: 0.7,
            hotkey: true,
            lock: true,
            fastForward: true,
            autoOrientation: true,
            setting: true,
            playbackRate: true,
            aspectRatio: true,
            fullscreen: true,
            fullscreenWeb: true,
            miniProgressBar: true,
            pip: true,
            airplay: true,
            // 手机端必须保留 playsinline，否则 iOS 会强行接管成全屏
            moreVideoAttr: { playsinline: true, 'webkit-playsinline': true },
          });
          artLive.set(box, { art, src });
        } catch {
          wrap.classList.remove('art-on');   // 建实例失败 → 退回原生控件，别留个空盒子
        }
      }
    });
  }

  async function saveImageToDevice(src) {
    try {
      const res = await fetch(assetUrl(src), { credentials: 'same-origin' });
      if (!res.ok) throw new Error('图片下载失败');
      const blob = await res.blob();
      const m = /([\w.-]+)\.(jpe?g|png|webp|gif)$/i.exec(src);
      const ext = m ? m[2].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
      const d = new Date();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `图片-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast('图片已开始保存', 'ok');
    } catch (err) {
      toast(err.message || '保存失败', 'err');
    }
  }

  /* ═══ 待办表单 ═══════════════════════════════════════════ */

  /* —— 时间设置的「简便模式」（v1.6.0）——
     旧版要依次点开两个时间表盘；v1.6.0 起改成「挑一个时长」，
     结束时间自动算出来，需要精确时再展开结束时间输入。
     v4.12.0：连「常用时间」那一排 chip 也去掉了（需求原文「移除常用时间点选」）——
     真正会用的人直接填 HH:MM，不用的人只是被多占一屏。TIME_QUICK 与 time-pick
     处理器一并删除，只留 DURATION_CHOICES。 */

  /** 时长选项：结束时间 = 开始 + 时长；「不限」表示不设结束时间 */
  const DURATION_CHOICES = [
    ['0', '不限时长'],
    ['30', '30 分钟'],
    ['60', '1 小时'],
    ['90', '1.5 小时'],
    ['120', '2 小时'],
    ['180', '3 小时'],
    ['__custom__', '自定义…'],
  ];

  const toMin = (hhmm) => {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const toHHMM = (mins) => `${pad(Math.floor((mins % 1440) / 60))}:${pad(mins % 60)}`;
  const addMinutes = (hhmm, n) => {
    const base = toMin(hhmm);
    return base == null ? '' : toHHMM((base + Number(n) + 1440) % 1440);
  };

  /** 由已有的开始/结束时间反推时长选项（编辑旧数据时用） */
  function durationFromTimes(start, end) {
    const a = toMin(start); const b = toMin(end);
    if (a == null || b == null || b <= a) return '0';
    const diff = b - a;
    return DURATION_CHOICES.some(([v]) => v === String(diff)) ? String(diff) : '__custom__';
  }

  /**
   * 把时长换算成结束时间，并刷新界面：
   *   · 「不限」→ 保留用户手填的结束时间（不动它）
   *   · 具体时长 → 由开始时间 + 时长算出来
   *   · 「自定义…」→ 展开结束时间输入框，让用户自己挑
   */
  function syncTimeUI(layer) {
    const start = modalValue('startTime');
    const dur = layer.dataset.duration || '0';
    const endInput = layer.querySelector('[data-mk="endTime"]');
    const exact = layer.querySelector('.time-exact');
    const custom = dur === '__custom__';
    if (exact) exact.classList.toggle('hidden', !custom);
    if (!custom && endInput) {
      const n = Number(dur) || 0;
      if (n > 0 && start) endInput.value = addMinutes(start, n);
      // n === 0（不限）时保持原值不动：可能是用户之前精确设置过的结束时间
    }
    /* v4.12.0：常用时间 chip 已移除，这里不再需要同步 chip 的选中态 */
    const hint = layer.querySelector('#time-hint');
    if (hint) {
      const end = endInput ? endInput.value : '';
      if (!start) hint.textContent = '不设具体时间，只记日期。';
      else if (end && end >= start) hint.textContent = `将记录为 ${start} – ${end}。`;
      else hint.textContent = `将记录为 ${start} 开始（未设结束时间）。`;
    }
  }

  /**
   * 待办表单。
   * ★ 打开前先拉一次成员列表：参与人是「从本家庭成员里点选」，
   *   而 state.members 平时只在「我的」页刷新，新注册的成员在这台设备上
   *   要等到切页才看得到——那会让「点选参与人」直接漏人。
   *
   * v4.12.0 按需求重排了字段顺序，理由都写在各自的位置上：
   *   ① 可见范围置顶 —— 「这件家务事给不给全家看」是动笔前就该决定的事，
   *      放在最下面往往保存完才想起来；
   *   ② 重复从一排按钮改成下拉，并和日期并排 —— 七个规则横排在手机上是两行半，
   *      而它和日期是同一个决策（「哪一天、之后怎么重复」）；
   *   ③ 常用时间点选去掉 —— 真正用的人会直接填 HH:MM，不用的人只是被多占一屏；
   *   ④ 备注收成按钮 —— 大多数待办没有备注，常驻一个空 textarea 只是视觉噪音；
   *   ⑤ 邮件提醒 + 催促合并成「提醒方式」 —— 两者本来就是「怎么提醒我」的两种强度，
   *      分成两个控件时用户会两个都填/都不填，最后谁也说不清会发生什么。
   */
  /* ═══ v4.28.2 可见范围：待办 / 动态 / 记录本三处共用的一套控件 ═══
     需求：把原来的「仅自己可见」改成「指定可见成员」——
       · 默认「全家可见」（三个创建入口的默认值都是它）；
       · 选「指定可见成员」时，默认只有自己可见，由创作者自己勾要一起看的人；
       · 没勾的人就是不可见（列表看不到、详情打不开、推送也不发给他）。
     ★ 存储口径：visibility 仍是 'family' / 'private'（不改库值，老数据零变化），
       'private' 的含义变成「我 + visible_to 里的人」；visible_to 为空 = 仅自己可见。
       所以下面这些函数都只负责**界面**与**提交字段**，判断可见性永远由服务端做。 */

  /** 除自己以外的家庭成员（自己始终可见，不出现在勾选列表里） */
  function visOthers() {
    const meId = Number((state.me && state.me.id) || 0);
    return (state.members || []).filter((m) => Number(m.id) !== meId);
  }

  /** 可见范围选择器 + 成员勾选面板。visibleTo 是 id 数组（新数据）或逗号串（兜底） */
  function visPickHtml(vis, visibleTo) {
    const priv = vis === 'private';
    const sel = new Set((Array.isArray(visibleTo) ? visibleTo : String(visibleTo || '').split(','))
      .map((x) => Number(x)).filter(Boolean));
    const others = visOthers();
    const chips = others.length
      ? others.map((m) => `<button type="button" class="chip vis-chip${sel.has(Number(m.id)) ? ' on' : ''}"
            data-act="vis-member" data-vis-id="${Number(m.id)}">${esc(m.display_name)}</button>`).join('')
      : '<span class="field-hint">家里还没有其他成员</span>';
    return `
      <div class="segmented" data-act="vis-pick">
        <button type="button" data-vis="family" class="${priv ? '' : 'on'}">👨‍👩‍👧 全家可见</button>
        <button type="button" data-vis="private" class="${priv ? 'on' : ''}">🔒 指定可见成员</button>
      </div>
      <div class="vis-members${priv ? '' : ' hidden'}" data-vis-box>
        <div class="vis-members-hint">默认只有你自己可见；勾选要一起看的家人，没勾的人看不到、也收不到推送。</div>
        <div class="chips">${chips}</div>
      </div>`;
  }

  /** 从弹窗当前状态读出 { visibility, visibleTo } —— 保存时统一用它，不各写一套 */
  function visReading(layer) {
    const visibility = layer && layer.dataset.visibility === 'private' ? 'private' : 'family';
    const ids = Array.from((layer || document).querySelectorAll('[data-act="vis-member"].on'))
      .map((b) => Number(b.dataset.visId)).filter(Boolean);
    return { visibility, visibleTo: visibility === 'private' ? ids : [] };
  }

  /** 可见性徽章文案：全家可见 / 指定 N 人 / 仅自己可见 */
  function visBadgeText(t) {
    if (!t || t.visibility !== 'private') return '';
    const n = (t.visibleTo || []).length;
    return n ? `🔒 指定 ${n} 人可见` : '🔒 仅自己可见';
  }

  /**
   * 待办弹窗里的「参与人物」联动：不可见的人置灰、不可点。
   * 需求原文：「若某成员被设为不可见，则参与人物点选处该成员显示为灰色不可选状态」。
   * ★ 只对**登记在册的成员**生效；历史手输的名字（比如没账号的「奶奶」）没有 id，
   *   无法判断可见性，保持可点 —— 否则老数据会被一条规则直接锁死。
   */
  function syncPartChips(layer) {
    if (!layer) return;
    const priv = layer.dataset.visibility === 'private';
    const allow = new Set(Array.from(layer.querySelectorAll('[data-act="vis-member"].on'))
      .map((b) => Number(b.dataset.visId)));
    const meId = Number((state.me && state.me.id) || 0);
    const idOf = new Map();
    for (const m of state.members || []) idOf.set(String(m.display_name), Number(m.id));
    const blocked = [];
    for (const chip of layer.querySelectorAll('#part-chips [data-act="part-toggle"]')) {
      const uid = idOf.get(String(chip.dataset.name || ''));
      const off = !!priv && !!uid && uid !== meId && !allow.has(uid);
      chip.classList.toggle('off', off);
      chip.disabled = off;
      chip.title = off ? '不在「指定可见成员」里，收不到这条待办的提醒' : '';
      if (off) blocked.push(String(chip.dataset.name || ''));
    }
    /* 已经选中、现在又被设成不可见的人要从参与人里摘掉：
       否则保存下去就是「参与人里有他，但他看不到这条待办」——
       服务端也不会给他发提醒（par 与可见性口径冲突），用户只会觉得「选了却没通知」。 */
    if (blocked.length) {
      const list = modalParticipants().filter((n) => !blocked.includes(n));
      if (list.length !== modalParticipants().length) setModalParticipants(list);
    }
  }

  async function openTodoForm(todo) {
    const isEdit = !!todo;
    try { await refreshMembers(); } catch { /* 拉不到就用现有列表兜底，不阻断填写 */ }
    const t = todo || {
      title: '', note: '', date: state.selected, endDate: '', endTime: '',
      /* v4.17.0 需求 4：新建待办的开始时间默认 = 消息推送设置里待办提醒的默认推送时间。
         大多数「要提醒的待办」就发生在那个点上，预填比每次手敲更省事；
         不想要的人清空即可（空 = 不带时间，催促走默认提醒时间）。 */
      startTime: myRemindTime(),
      participants: [], priority: 'normal', repeat: '', repeatRule: '', visibility: 'family', done: false,
      remind: true, remindAdvanceDays: -1, urgeMinutes: 0, urgeMaxCount: 20, urgeWindowStart: '08:00', urgeWindowEnd: '22:00',
      urgeStartAt: '',
    };
    // v4.10.0：重复规则的当前值走统一读取（repeat_rule 优先、repeat 回落）
    const curRule = Repeat.rule(t);
    const myName = state.me ? state.me.display_name : '';
    // 候选 = 本家庭全部成员 +（编辑时）该事项历史里出现过的名字。
    // 后者是旧版本手输参与人留下的，保留出来才能被取消掉，不至于变成改不掉的脏数据。
    const names = Array.from(new Set([
      ...state.members.map((m) => m.display_name),
      ...(myName ? [myName] : []),
      ...(t.participants || []),
    ]));
    // 默认选中本人：参与人才是邮件提醒的收件人，默认空着等于默认不发
    const chosen = new Set((t.participants && t.participants.length) ? t.participants : (myName ? [myName] : []));
    /* v4.12.0：提醒方式三档（邮件提醒与催促完成合并后的产物）。
       'system' 用系统配置的提醒方式（邮件 / 企业微信 / 两者），是默认值。 */
    const urgeOn = Number(t.urgeMinutes) > 0;
    /* v4.22.0 需求 1：这条待办自己设了 0–5 天 → 选「提前提醒」；-1 → 跟随系统设置 */
    const ownAdv = Number(t.remindAdvanceDays) >= 0 ? Number(t.remindAdvanceDays) : -1;
    const remindMode = t.remind === false ? 'none' : (urgeOn ? 'urge' : (ownAdv >= 0 ? 'advance' : 'system'));
    const noteOpen = !!String(t.note || '').trim();
    /* v4.23.0 需求 1 / 2：两个字段的「当前默认值」都如实写在标签上。
       · 时间：我自己设过 → 我的；没设过 → 管理员的（并明确写出是几点）；
       · 提醒方式：当前系统会走哪条通道（管理员的通道开关 + 我自己的推送方式）。 */
    const tInfo = remindTimeInfo();
    const timeSrcLabel = tInfo.mine
      ? `我的默认 ${tInfo.time}`
      : `管理员默认 ${tInfo.admin}`;
    const sysChannelLabel = (() => {
      const s = state.settings || {};
      const mail = s.pushMailEnabled !== false;
      const wc = s.pushWecomEnabled !== false;
      const base = mail && wc ? '邮件 + 企业微信'
        : mail ? '只用邮件'
          : wc ? '只用企业微信' : '两个通道都关着';
      return `${base} · 我：${PUSH_LABEL[pushChannelOf(state.me)] || '智能'}`;
    })();

    openModal({
      title: isEdit ? '编辑待办' : '添加待办',
      body: `
        <!-- ① 可见范围置顶（v4.28.2：默认全家可见；选「指定可见成员」后默认仅自己） -->
        <div class="field"><span>可见范围</span>
          ${visPickHtml(t.visibility, t.visibleTo)}
        </div>

        <label class="field"><span>要做什么</span>
          <input type="text" data-mk="title" maxlength="100" value="${esc(t.title)}" placeholder="例如：去领500万彩票奖金"></label>

        <!-- ④ 备注：默认收起，点按钮才出现输入框 -->
        <div class="field">
          <div class="todo-note-head">
            <span>备注<span class="field-hint">（可选）</span></span>
            <button type="button" class="btn-ghost btn-sm${noteOpen ? ' hidden' : ''}" data-act="todo-note-open">＋ 添加备注</button>
          </div>
          <div id="todo-note-wrap"${noteOpen ? '' : ' class="hidden"'}>
            <textarea data-mk="note" maxlength="2000" placeholder="补充说明，可留空">${esc(t.note)}</textarea>
          </div>
        </div>

        <!-- ② 日期与重复并排：同一个决策的两个面 -->
        <div class="time-row todo-date-row">
          <label class="field field-sm"><span>日期<span class="field-hint">（可留空）</span></span>
            <input type="date" data-mk="date" value="${esc(t.date)}"></label>
          <label class="field field-sm"><span>重复</span>
            <select data-mk="repeat" title="选了重复就不能跨天">
              <option value=""${!curRule ? ' selected' : ''}>不重复</option>
              <option value="daily"${curRule === 'daily' ? ' selected' : ''}>每天</option>
              <option value="weekly"${curRule === 'weekly' ? ' selected' : ''}>每周</option>
              <option value="monthly_solar"${curRule === 'monthly_solar' ? ' selected' : ''}>每月（公历）</option>
              <option value="monthly_lunar"${curRule === 'monthly_lunar' ? ' selected' : ''}>每月（农历）</option>
              <option value="yearly_solar"${curRule === 'yearly_solar' ? ' selected' : ''}>每年（公历）</option>
              <option value="yearly_lunar"${curRule === 'yearly_lunar' ? ' selected' : ''}>每年（农历）</option>
            </select></label>
        </div>
        <label class="field" id="todo-end-field"><span>结束日期<span class="field-hint">（可选：跨天待办，结束日之前的每天都出现在日历上；与重复互斥）</span></span>
          <input type="date" data-mk="endDate" value="${esc(t.endDate || '')}" min="${esc(t.date || '')}"></label>

        <!-- ③ 时间：常用时间点选已移除，直接填 / 选
             v4.23.0 需求 1：标签里的 * 直接说明「这个默认值是哪儿来的」——
               我自己设过默认时间 → 「我的默认 20:00」；
               没设过 → 「管理员默认 08:00」。
             两个值都从服务端来（个人偏好 / 家庭设置），不在前端写死。 -->
        <div class="field"><span>时间<span class="field-hint">（可选：${timeSrcLabel}）</span></span>
          <div class="time-row">
            <label class="field field-sm"><span>开始</span>
              <input type="time" data-mk="startTime" value="${esc(t.startTime)}"></label>
            <label class="field field-sm"><span>时长</span>
              <select data-mk="duration">
                ${DURATION_CHOICES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
              </select></label>
          </div>
          <label class="field field-sm time-exact hidden"><span>结束时间</span>
            <input type="time" data-mk="endTime" value="${esc(t.endTime)}"></label>
          <small class="field-hint" id="time-hint"></small>
        </div>

        <div class="field"><span>参与人物<span class="field-hint">（点一下即可选中/取消，提醒会发给选中的成员；「指定可见成员」之外的家人不可选）</span></span>
          <div class="chips" id="part-chips">
            ${names.map((n) =>
              `<button type="button" class="chip${chosen.has(n) ? ' on' : ''}" data-act="part-toggle" data-name="${esc(n)}">${esc(n)}${n === myName ? '（我）' : ''}</button>`).join('')}
          </div>
        </div>
        <div class="field"><span>重要程度</span>
          <div class="segmented" data-act="prio-pick">
            <button type="button" data-prio="low" class="${t.priority === 'low' ? 'on' : ''}">稍后</button>
            <button type="button" data-prio="normal" class="${t.priority === 'normal' ? 'on' : ''}">普通</button>
            <button type="button" data-prio="high" class="${t.priority === 'high' ? 'on' : ''}">重要</button>
          </div>
        </div>

        <!-- ⑤ 提醒方式：把「邮件提醒」和「催促完成」合成一个下拉
             v4.23.0 需求 2：标签上的 * = 当前系统的提醒方式（管理员在
             「推送渠道设置」里开的通道 + 我自己的推送方式），不再只有一句抽象说明。 -->
        <label class="field"><span>提醒方式<span class="field-hint">（*：当前 ${esc(sysChannelLabel)}）</span></span>
          <select data-mk="remindMode">
            <option value="system"${remindMode === 'system' ? ' selected' : ''}>到点提醒（跟随系统配置的提醒方式）</option>
            <option value="advance"${remindMode === 'advance' ? ' selected' : ''}>提前提醒（提前 N 天通知）</option>
            <option value="urge"${remindMode === 'urge' ? ' selected' : ''}>到点提醒 + 催促完成</option>
            <option value="none"${remindMode === 'none' ? ' selected' : ''}>不提醒</option>
          </select>
          <small class="field-hint">系统默认的提醒方式由管理员在「消息推送设置 → 推送渠道设置」里配置（邮件 / 企业微信），
            我自己的推送方式在「消息推送设置 → 推送方式」里选。</small>
        </label>

        <!-- v4.22.0 需求 1：只有选「提前提醒」才展开提前天数 -->
        <div id="advance-box" class="field advance-box${remindMode === 'advance' ? '' : ' hidden'}">
          <span>提前天数<span class="field-hint">（提前几天通知，0 = 当天）</span></span>
          <div class="time-row">
            <label class="field field-sm"><span>提前</span>
              <input type="number" data-mk="remindAdvanceDays" min="0" max="5"
                     value="${ownAdv >= 0 ? ownAdv : (Number(t.advanceDays) > 0 ? Math.min(5, Number(t.advanceDays)) : 1)}"></label>
            <span class="field-hint" style="align-self:flex-end;padding-bottom:10px">天</span>
          </div>
          <small class="field-hint">设置后<b>不再跟随</b>管理员在「家庭设置 → 待办提醒」里的全局提前天数（0–5 天）。</small>
        </div>

        <!-- 催促间隔：只有选了「催促」才出现 -->
        <div id="urge-box" class="field urge-box${remindMode === 'urge' ? '' : ' hidden'}">
          <span>催促间隔<span class="field-hint">（到点后反复提醒，直到标记完成）</span></span>
          <select data-mk="urgeMinutes">
            ${[5, 10, 15, 20, 30, 45, 60].map((m) =>
              `<option value="${m}"${Number(t.urgeMinutes) === m || (!t.urgeMinutes && m === 10) ? ' selected' : ''}>每 ${m} 分钟催一次</option>`).join('')}
          </select>
          <!-- v4.14.0 需求 5：**只留「最多催几次」**。
               原来的「开始时刻 / 静默时段」两项撤掉了 —— 催促是「到点没做完就一直催到做完」，
               自己就有时限（24 小时硬顶 + 次数上限 + 回「已完成」即停），
               再叠一层「几点到几点才催」既讲不清也容易和免打扰混淆。
               催就是从待办的开始时间起，一直催到停为止；没填开始时间时用「我的」默认提醒时间
               （v4.15.0 需求 7，服务端 urge.js 读 settings.remind_default_time，不再硬编码 09:00）。 -->
          <div class="time-row">
            <label class="field field-sm"><span>最多催几次</span>
              <input type="number" data-mk="urgeMaxCount" min="0" max="999" value="${Number(t.urgeMaxCount) || 0}"
                     title="0 = 不限次数；催够自动停"></label>
          </div>
          <small class="field-hint">从待办的开始时间起催；没填开始时间就按「我的」默认提醒时间
            ${esc(myRemindTime())} 起催。<b>企业微信</b>里回一句「已完成」就停；
            只配了邮件时照样能催，正文会告诉你去「待办」里勾一下这条，勾完就不再提醒。</small>
        </div>`,
      foot: `
        ${isEdit ? `<button type="button" class="btn-danger btn-sm" data-act="todo-delete" data-id="${t.id}">删除</button>` : ''}
        <!-- v4.20.0（审查 W-9）：重复事项的「收尾」入口。
             重复事项本来就没有完成状态，没有这个按钮的话它只会永久留在库里每天提醒一次。 -->
        ${isEdit && Repeat.rule(t) ? `<button type="button" class="btn-ghost btn-sm" data-act="todo-end-repeat" data-id="${t.id}">结束重复</button>` : ''}
        <div class="spacer"></div>
        ${isEdit && !Repeat.rule(t) ? `<button type="button" class="btn-ghost" data-act="todo-done" data-id="${t.id}">${t.done ? '标为未完成' : '标为已完成'}</button>` : ''}
        <button type="button" class="btn-primary" data-act="todo-save" data-id="${isEdit ? t.id : ''}">保存</button>`,
      onMount: (layer) => {
        layer.dataset.participants = JSON.stringify(Array.from(chosen));
        layer.dataset.priority = t.priority;
        layer.dataset.visibility = t.visibility;
        layer.dataset.repeat = curRule || '';
        // v4.10.0：选了重复 → 结束日期输入框隐藏（跨天与重复互斥）
        const syncEndField = () => {
          const f = layer.querySelector('#todo-end-field');
          if (f) f.classList.toggle('hidden', !!layer.dataset.repeat);
          // 重复事项没有完成状态，顺手把「标为已完成」按钮藏起来，避免误解
          // （v4.12.0：原先在全局 segmented 点击处理器里，跟着 repeat-pick 一起搬过来）
          const doneBtn = layer.querySelector('[data-act="todo-done"]');
          if (doneBtn) doneBtn.classList.toggle('hidden', !!layer.dataset.repeat);
        };
        syncEndField();
        // v4.12.0：重复改成下拉 → 用 change 委托（原来是一排按钮的 click 委托）
        layer.addEventListener('change', (ev) => {
          const sel = ev.target;
          if (!sel || sel.dataset.mk !== 'repeat') return;
          layer.dataset.repeat = sel.value || '';
          syncEndField();
        });
        // 提醒方式：选「催促」展开催促间隔；选「提前提醒」展开提前天数（v4.22.0）
        const syncRemind = () => {
          const mode = modalValue('remindMode');
          const urgeBox = layer.querySelector('#urge-box');
          if (urgeBox) urgeBox.classList.toggle('hidden', mode !== 'urge');
          const advBox = layer.querySelector('#advance-box');
          if (advBox) advBox.classList.toggle('hidden', mode !== 'advance');
        };
        const modeSel = layer.querySelector('[data-mk="remindMode"]');
        if (modeSel) modeSel.addEventListener('change', syncRemind);
        syncRemind();
        // 备注：点「＋ 添加备注」才出现输入框，出现后聚焦
        const noteBtn = layer.querySelector('[data-act="todo-note-open"]');
        if (noteBtn) {
          noteBtn.addEventListener('click', () => {
            const wrap = layer.querySelector('#todo-note-wrap');
            if (wrap) wrap.classList.remove('hidden');
            noteBtn.classList.add('hidden');
            const ta = layer.querySelector('[data-mk="note"]');
            if (ta) setTimeout(() => ta.focus(), 40);
          });
        }
        // 时间：按已有开始/结束时间推断出「时长」，并在示例文案里说清楚会存成什么
        layer.dataset.duration = durationFromTimes(t.startTime, t.endTime);
        const durSel = layer.querySelector('[data-mk="duration"]');
        if (durSel) durSel.value = layer.dataset.duration;
        syncTimeUI(layer);
        /* v4.28.2：进弹窗先按当前可见范围把参与人算一遍 ——
           编辑一条「指定可见成员」的待办时，没被勾的人本来就该是灰的。 */
        syncPartChips(layer);
        const first = layer.querySelector('[data-mk="title"]');
        if (first && !isEdit) setTimeout(() => first.focus(), 60);
      },
    });
  }

  function modalParticipants() {
    try { return JSON.parse($('#modal-layer').dataset.participants || '[]'); } catch { return []; }
  }
  function setModalParticipants(list) {
    $('#modal-layer').dataset.participants = JSON.stringify(list);
    $$('#modal-layer [data-act="part-toggle"]').forEach((b) => b.classList.toggle('on', list.includes(b.dataset.name)));
  }

  async function saveTodo(id) {
    const layer = $('#modal-layer');
    // 时间：以「时长」为准算出结束时间；「不限」则沿用输入框里的值（可能是精确设置过的）
    const startTime = modalValue('startTime');
    const dur = layer.dataset.duration || '0';
    let endTime = modalValue('endTime');
    if (dur !== '__custom__') {
      const n = Number(dur) || 0;
      if (n > 0) endTime = startTime ? addMinutes(startTime, n) : '';
    }
    /* v4.12.0：提醒方式三档是一个下拉，但要落成库里的两列（remind 布尔 + urge_minutes 数字）。
       三档对应的组合是固定的，别在这里做「智能推断」：
         system → remind=1, urge=0（到点发一次，走系统配置的通道）
         urge   → remind=1, urge=N（到点发一次 + 反复催：企业微信优先，只配邮件时走邮件）
         none   → remind=0, urge=0（什么都不发；此时催促字段即使有值也一并清零，
                  否则以后把 remind 打开会突然开始催，用户根本不知道哪来的） */
    const remindMode = modalValue('remindMode') || 'system';
    const remindOn = remindMode !== 'none';
    const urgeMinutes = remindMode === 'urge' ? (Number(modalValue('urgeMinutes')) || 10) : 0;
    /* v4.22.0 需求 1：「提前提醒」存自己的天数并覆盖全局；其余档位一律 -1（跟随家庭设置）。
       这样从「提前」切回「到点」时，不会把上一次的 3 天偷偷留在库里。 */
    const remindAdvanceDays = remindMode === 'advance'
      ? Math.min(5, Math.max(0, Math.round(Number(modalValue('remindAdvanceDays')) || 0)))
      : -1;
    // 不再提交 location：界面上已经没有这个字段，服务端保留旧值不动
    // （数据库里那列留着，是为了老数据不丢、回滚旧版本也安全）
    const body = {
      title: modalValue('title').trim(),
      date: modalValue('date'),
      // v4.10.0：跨天待办。选了重复 → 强制空（与服务端同一条规则）；结束早于开始在前端先拦
      endDate: layer.dataset.repeat ? '' : modalValue('endDate'),
      startTime,
      endTime,
      note: modalValue('note').trim(),
      participants: modalParticipants(),
      priority: layer.dataset.priority || 'normal',
      repeat: layer.dataset.repeat || '',
      remind: remindOn,
      remindAdvanceDays,
      // v4.6.0 需求 3：催促频率（0 = 不催）。服务端会把超范围的值夹到 1–60。
      urgeMinutes,
      // v4.14.0 需求 5：只提交「最多催几次」。
      // urge_start_at / urge_window_* 不再出现在界面上，也就不再提交 ——
      // 服务端对这三个键是「不传就保持原值」，老数据原样留着，不影响任何判断。
      urgeMaxCount: Math.max(0, Math.round(Number(modalValue('urgeMaxCount')) || 0)),
      /* v4.28.2：可见范围 + 指定可见成员一起提交。
         visibility='family' 时 visibleTo 传空数组，服务端也会强制清空。 */
      ...visReading(layer),
    };
    if (!body.title) { toast('请填写「要做什么」', 'err'); return; }
    if (body.repeat && !body.date) { toast('选择重复规则需要先设置日期', 'err'); return; }
    if (body.endDate && !body.date) { toast('设置结束日期需要先填写开始日期', 'err'); return; }
    if (body.endDate && body.endDate < body.date) { toast('结束日期不能早于开始日期', 'err'); return; }
    if (body.endTime && body.startTime && body.endTime < body.startTime) { toast('结束时间不能早于开始时间', 'err'); return; }
    try {
      if (id) await api('/api/todos/' + id, { method: 'PATCH', body });
      else await api('/api/todos', { method: 'POST', body });
      closeModal();
      await refreshTodos();
      // 提醒对象是参与人：勾了提醒却没选参与人，等于不会发信，必须说清楚
      if (body.remind && !body.participants.length) {
        toast('已保存。但没选参与人，这条待办不会发出提醒邮件', 'err');
      } else {
        toast(id ? '已保存' : '已添加到待办列表', 'ok');
      }
    } catch (err) { toast(err.message, 'err'); }
  }

  /**
   * 待办列表顶部快捷添加（一句话）。
   * v4.19.0 需求 1：默认日期 = 今天、默认「每天」重复、到点提醒（提醒时刻不填 →
   * 走「消息推送 → 待办提醒」的默认时间，与 「我的」里配的那个值同源）。
   * 为什么提醒时刻留空而不是写死：留空时服务端每次按当前配置取默认值，
   * 管理员改了默认时间，所有「没单独设时间」的待办自动跟着走。
   */
  async function quickAddTodo() {
    const input = document.querySelector('[data-act="todo-quick-input"]');
    const title = (input ? input.value : '').trim();
    if (!title) { toast('先写一句要做的事', 'err'); return; }
    input.value = '';
    try {
      await api('/api/todos', {
        method: 'POST',
        body: { title, date: todayKey(), repeat: 'daily', remind: true, quick: true },
      });
      /* v4.22.0 需求 2：一句话待办不再进「周期提醒」卡，所以这里不展开那张卡；
         它已经在上面「待办列表」里，刷新即可见。 */
      await refreshTodos();
      toast('已添加：今天起每天提醒（时间跟随「待办提醒」默认设置）', 'ok');
    } catch (err) {
      input.value = title;      // 失败回滚输入
      toast(err.message || '添加失败', 'err');
    }
  }

  /**
   * 勾选 / 取消勾选完成。
   * ★ 「已完成 → 未完成」是回退操作，容易误点（尤其是手机上一滑就点到），
   *   先弹确认再变更；「未完成 → 已完成」不打扰。
   * @returns {Promise<boolean>} 是否真的发生了变更（被用户取消则返回 false）
   */
  async function toggleTodo(id) {
    const t = state.todos.find((x) => x.id === id);
    if (!t) return false;
    const before = t.done;
    const next = !before;
    if (before === true && next === false) {
      if (!window.confirm(`确定把「${t.title}」改回「待完成」吗？`)) return false;
    }
    t.done = next;                          // 乐观更新
    render();
    try {
      const out = await api('/api/todos/' + id, { method: 'PATCH', body: { done: t.done } });
      const real = state.todos.find((x) => x.id === id);
      if (real) real.done = out.todo.done;   // 以服务端返回为准
      if (state.tab !== 'calendar') render();
      return true;
    } catch (err) {
      t.done = before;                       // 回滚
      render();
      toast(err.message || '操作失败，已回滚', 'err');
      return false;
    }
  }

  /**
   * v4.21.0 需求 2：勾选「重复事项的某一天」。
   * 与 toggleTodo 分开的理由：这是「这一次做完了」，不是「这件事从此做完了」——
   * 服务端也走不同的接口（/complete），第二天读不到今天的标记，自动回到未完成。
   */
  async function toggleTodoDay(id, dateKey) {
    const t = state.todos.find((x) => x.id === id);
    if (!t) return false;
    const day = String(dateKey || t.rowOccDate || '').slice(0, 10) || todayKey();
    /* v4.28.0：doneToday 现在表示「今天这一行代表的落点是否已完成」，
       不再要求落点必须是今天 —— 提前提醒时落点在 N 天之后。 */
    const before = !!t.doneToday;
    const next = !before;
    const isRowDay = !!t.rowOccDate && day === t.rowOccDate;
    if (!isRowDay && day !== todayKey()) {
      // 日历日面板只允许勾「今天」；提前提醒的那一行允许勾它代表的那个落点
      toast('只能勾选今天的这一次', 'err');
      return false;
    }
    if (before) {
      if (!window.confirm(`确定把「${t.title}」今天的完成改回未完成吗？`)) return false;
    }
    t.doneToday = next;                       // 乐观更新
    render();
    try {
      const out = await api('/api/todos/' + id + '/complete', {
        method: 'POST', body: { date: day, done: next },
      });
      const real = state.todos.find((x) => x.id === id);
      if (real && out.todo) {
        real.doneToday = out.todo.doneToday;
        real.rowOccDate = out.todo.rowOccDate;
        real.nextRemindKey = out.todo.nextRemindKey;
        real.nextOccurrence = out.todo.nextOccurrence;
      }
      render();
      return true;
    } catch (err) {
      t.doneToday = before;                   // 回滚
      render();
      toast(err.message || '操作失败，已回滚', 'err');
      return false;
    }
  }

  /* ═══ 图片处理 ═══════════════════════════════════════════ */

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error('读取图片失败'));
      fr.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片解析失败'));
      img.src = src;
    });
  }

  /** 上传上限：由服务端 /api/config 下发，前端提前拦一下并给出准确提示
   *  v4.12.0：字段名统一成 imageMaxMb / fileMaxMb（旧名 maxUploadMb / fileMaxMb 仍下发，
   *  这里保留回落是为了「浏览器缓存了旧 app.js、服务端已升级」这种短暂的版本错配。 */
  const maxImgMb = () => Number(state.config.imageMaxMb) || Number(state.config.maxUploadMb) || 10;
  const maxFileMb = () => Number(state.config.fileMaxMb) || 20;
  const dataUrlBytes = (dataUrl) => Math.ceil(String(dataUrl || '').length * 3 / 4);

  /** 尽力解码；浏览器解不开（HEIC 等）返回 null，由调用方给出可操作提示 */
  async function decodeImage(src) {
    try {
      return await loadImage(src);
    } catch { /* 再试第二条路 */ }
    // 少数浏览器对某些格式 Image 解不了、但 createImageBitmap 可以
    if (typeof createImageBitmap === 'function') {
      try {
        const blob = await (await fetch(assetUrl(src))).blob();
        return await createImageBitmap(blob);
      } catch { /* 还是不行为止 */ }
    }
    return null;
  }

  function encodeJpeg(img, edge, quality) {
    const w0 = img.width || img.naturalWidth || 1;
    const h0 = img.height || img.naturalHeight || 1;
    const scale = Math.min(1, edge / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  }

  /**
   * 把用户选的图片变成可上传的 dataURL。
   *
   * ★ v1.5.0 修的「动态图片上传失败」，客户端这一半：
   *   旧版在「浏览器解不开这张图」时【静默地把原文件原样发上去】，
   *   而服务端只认四种 MIME —— 用户看到的就是一句没头没尾的
   *   「只支持 JPG / PNG / WEBP / GIF 图片」，既不知道是哪张、也不知道为什么。
   *   现在：能转码就转码（必要时多压几轮），转不了就【指名道姓说清楚】并跳过这一张，
   *   其余照片照常上传，不再「一张坏图毁掉整批」。
   *
   * @throws {Error} 带用户看得懂的说明，message 可直接 toast
   */
  async function prepareImageData(file) {
    const name = file.name || '这张图片';
    const raw = await readAsDataUrl(file);

    // GIF 保留动画不转码；但也正因为不转码，超限的 GIF 只能如实告知
    if (String(file.type || '').toLowerCase() === 'image/gif') {
      if (dataUrlBytes(raw) > maxImgMb() * 1024 * 1024) {
        throw new Error(`「${name}」有 ${fmtBytes(dataUrlBytes(raw))}，超过 ${maxImgMb()}MB；GIF 无法自动压缩，请先裁剪或压缩后再上传`);
      }
      return raw;
    }

    const img = await decodeImage(raw);
    if (!img) {
      throw new Error(`「${name}」的格式浏览器无法识别，没能上传。若是 iPhone 的 HEIC 照片，请先在相册里导出为 JPG（或截图后上传）`);
    }

    // 逐级加压：正常照片第一轮就够了，超大图才会用到后面几轮
    const tries = [{ edge: 1600, q: 0.82 }, { edge: 1280, q: 0.70 }, { edge: 1024, q: 0.60 }];
    let smallest = '';
    for (const t of tries) {
      let out = '';
      try { out = encodeJpeg(img, t.edge, t.q); } catch { continue; }
      if (!smallest || out.length < smallest.length) smallest = out;
      if (dataUrlBytes(out) <= maxImgMb() * 1024 * 1024) return out;
    }
    if (!smallest) throw new Error(`「${name}」处理失败，请换一张图片再试`);
    throw new Error(`「${name}」压缩后仍有 ${fmtBytes(dataUrlBytes(smallest))}，超过 ${maxImgMb()}MB 上限，请先裁剪或换一张`);
  }

  /** 选中的图片先本地判定「是不是图片」，避免把 PDF 当图片去转码 */
  const looksLikeImage = (file) =>
    /^image\//.test(String(file.type || '')) ||
    /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif|tiff?|ico)$/i.test(String(file.name || ''));

  async function uploadImage(file, onProgress) {
    const dataUrl = await prepareImageData(file);
    const out = await xhrUpload('/api/upload', { name: file.name, dataUrl }, onProgress);
    return out.path;
  }

  /**
   * 批量上传图片：逐个走，一个失败不影响其它。
   * @param {File[]} files
   * @param {(path:string)=>void} push 每成功一张就回调一次（交给调用方放进自己的列表）
   * @param {(p:number)=>void} [onProgress] 0-1 的**整批**进度
   * @returns {{ok:number, errors:string[]}} errors 是可直接展示的「文件名 + 原因」
   */
  async function uploadImages(files, push, onProgress) {
    const errors = [];
    let ok = 0;
    const total = files.length || 1;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!looksLikeImage(f)) {
        errors.push(`「${f.name || '未命名文件'}」不是图片，已跳过`);
        if (onProgress) onProgress((i + 1) / total);
        continue;
      }
      try {
        // 整批进度 =（已完成的张数 + 当前这张的进度）/ 总张数
        push(await uploadImage(f, onProgress ? (p) => onProgress((i + p) / total) : null));
        ok++;
      } catch (err) {
        errors.push(err && err.message ? err.message : `「${f.name}」上传失败`);
      }
      if (onProgress) onProgress((i + 1) / total);
    }
    return { ok, errors };
  }

  /** 附件：不压缩、不改内容，原样上传（服务端只做类型与体积校验） */
  async function uploadAttachment(file, onProgress) {
    const dataUrl = await readAsDataUrl(file);
    const size = dataUrlBytes(dataUrl);
    if (size > maxFileMb() * 1024 * 1024) {
      throw new Error(`「${file.name}」有 ${fmtBytes(size)}，超过附件上限 ${maxFileMb()}MB`);
    }
    /* v4.13.0（问题 3）：视频附件也在**上传之前**于本地抽一帧当封面，
       和附件一起提交（服务端落成一张图片，随附件对象一起存进 records.attachments）。
       为什么服务端不做：零依赖、没有编码器；浏览器里 canvas 抽帧是唯一
       不需要 ffmpeg 的做法，且不用把整个视频再传一遍。 */
    let cover = '';
    if (looksLikeVideo(file)) {
      try { cover = await captureVideoCover(file); } catch { cover = ''; }
    }
    const body = { name: file.name, dataUrl };
    if (cover) body.cover = cover;
    return xhrUpload('/api/upload-file', body, onProgress);
  }

  /* ═══ 数据读取 ═══════════════════════════════════════════ */

  /** 增量结果合并进本地列表（技术债 G-4）。
      · 变更行按 id 覆盖；
      · ids 是服务端「现在还存在」的全集 → 本地有、ids 没有的，就是别人删掉的，直接丢；
      · doneToday 是服务端今天的完成集合 → 每行都按它校正（勾选不改 todos.updated_at）。 */
  /**
   * v4.21.0 需求 2 / v4.28.0 修正：增量合并且校正「今天这一行」的完成态。
   * · doneMarks 是服务端回的 (todoId, occDate) 二元组 —— 完成标记按落点日存，
   *   提前提醒时落点在将来，不能再用「今天的 id 集合」判断；
   * · 老服务端只回 doneToday（今天的 id 集合）时按旧口径兜底（落点就是今天）。
   */
  function mergeTodos(local, changed, ids, doneMarks, doneToday) {
    const byId = new Map();
    for (const t of (local || [])) byId.set(Number(t.id), t);
    for (const t of (changed || [])) byId.set(Number(t.id), t);
    const keep = new Set((ids || []).map(Number));
    const marks = new Map();
    for (const pair of (doneMarks || [])) {
      if (!Array.isArray(pair)) continue;
      const id = Number(pair[0]);
      if (!marks.has(id)) marks.set(id, new Set());
      marks.get(id).add(String(pair[1]));
    }
    const done = new Set((doneToday || []).map(Number));
    const out = [];
    byId.forEach((t, id) => {
      if (!keep.has(id)) return;
      const set = marks.get(id);
      const doneTodayNow = set && t.rowOccDate ? set.has(String(t.rowOccDate)) : done.has(id);
      out.push(Object.assign({}, t, { doneToday: !!doneTodayNow }));
    });
    return out;
  }

  async function refreshTodos(opts) {
    const o = opts || {};
    /* ★ v4.21.0（技术债 G-4）：自动轮询走增量（?since=游标），其余路径一律全量。
       保守起见每 5 次增量插一次全量 —— 万一哪次合并出了偏差，两分钟内自己纠正回来，
       不会出现「一直少一条」。任何异常（没有游标、服务端没回 ids、reset 标记）
       都退回全量，绝不让界面停在半份数据上。 */
    let since = '';
    if (o.incremental && !o.full && state.todoCursor) {
      state.todoIncCount = (state.todoIncCount || 0) + 1;
      if (state.todoIncCount % 5 !== 0) since = state.todoCursor;
    }
    const out = await api('/api/todos' + (since ? `?since=${encodeURIComponent(since)}` : ''));
    if (since && Array.isArray(out.ids) && !out.reset) {
      state.todos = mergeTodos(state.todos, out.todos, out.ids, out.doneMarks, out.doneToday);
    } else {
      state.todos = out.todos;
      /* 全量回来重置计数：下一次增量从「完整的一份」开始往后跟 */
      state.todoIncCount = 0;
      if (since) { await refreshTodos({ full: true }); return; }
    }
    state.todoCursor = out.now || '';
    /* v4.20.0（审查 W-9）：total 是**服务端真实条数**，不受 2000 上限影响。
       老服务端（或异常响应）没有这两个字段时按「没截断」处理，行为与升级前一致。 */
    state.todoTotal = Number(out.total) || (out.todos || []).length;
    state.todoTruncated = !!out.truncated;
    render();
  }
  async function refreshPosts() {
    const out = await api('/api/posts');
    state.posts = out.posts;
    render();
  }
  function recordsLocked() {
    // 解锁凭证只在本次打开的页面会话内有效；关闭页面再打开需重新输入密码
    return !!(state.me && state.me.record_lock_enabled && !recordsKey());
  }

  async function refreshRecords() {
    try {
      // v1.9.0：归档视图由前端显式指定，行为才可预期 ——
      // 不传参数时服务端在「搜索」场景会连归档一起搜（照顾老客户端），
      // 界面上的两个页签则各自只要自己那一半。
      const out = await api('/api/records?archived=' + (state.recShowArchived ? '1' : '0'));
      state.records = out.records;
      state.recHidden = Array.isArray(out.hiddenCategories) ? out.hiddenCategories : [];
      // 当前选中的分类如果被删掉了，退回「全部」，否则列表会一直空着
      if (state.recCategory !== '全部' && state.recHidden.includes(state.recCategory)) state.recCategory = '全部';
    } catch (err) {
      if (err.data && err.data.code === 'RECORDS_LOCKED') { state.records = []; }
      else throw err;
    }
    render();
  }

  async function unlockRecords() {
    const input = document.querySelector('#lock-pass');
    const password = input ? input.value : '';
    if (!password) { toast('请输入密码', 'err'); return; }
    try {
      const out = await api('/api/me/records-unlock', { method: 'POST', body: { password } });
      try { sessionStorage.setItem('fh-records-key', out.key || ''); } catch { /* 忽略 */ }
      await refreshRecords();
      toast('记录本已解锁（本次打开期间有效）', 'ok');
    } catch (err) {
      if (input) { input.value = ''; input.focus(); }
      toast(err.message || '解锁失败', 'err');
    }
  }
  async function refreshMembers() {
    const out = await api('/api/members');
    state.members = out.members;
    refreshAvatarMap();
  }

  /* v2.0.0：个人通知偏好。所有人都能读 —— 非管理员只是不能改全局，
     但必须看得到「全局现在是什么状态」，否则他会以为自己打开的开关没生效。 */
  async function refreshPrefs() {
    const out = await api('/api/prefs');
    state.prefs = out.prefs || {};
    state.prefsGlobal = out.global || null;
  }

  /* v2.0.0：记账。bootstrap 一次拿回分类 / 预算 / 额度 / 统计 / 我的快捷短语，少发几个来回。 */
  async function refreshBills() {
    /* v4.12.0 需求 3：统计只保留「日期范围」一个口径 ——「日期」「月份」两个输入已移除。
       首次进页面默认范围 = 本月 1 号 ~ 今天，进「统计 → 筛选查看」就有内容。 */
    if (!state.billStatFrom && !state.billStatTo) {
      const n = new Date();
      const p = (x) => String(x).padStart(2, '0');
      state.billStatFrom = `${n.getFullYear()}-${p(n.getMonth() + 1)}-01`;
      state.billStatTo = todayKey();
    }
    const qs = new URLSearchParams();
    if (state.billStatFrom && state.billStatTo) { qs.set('from', state.billStatFrom); qs.set('to', state.billStatTo); }
    const out = await api('/api/bills/bootstrap' + (qs.toString() ? `?${qs}` : ''));
    state.billMeta = {
      categories: out.categories || { expense: [], income: [] },
      defaults: out.defaults || null,
      budgets: out.budgets || [],
      quota: out.quota || null,
      ocrConfigured: !!out.ocrConfigured,
      reports: out.reports || null,
    };
    state.billStats = out.stats || null;
    state.billStatsLoaded = true;
    // v4.0.0 需求 2：我的快捷短语（服务端按人存）
    if (Array.isArray(out.quick) && out.quick.length) state.billQuick = out.quick;
    if (out.reports && out.reports.dailyTime) state.billDailyTime = out.reports.dailyTime;
    // v4.1.0：草稿箱每次同步都从 localStorage 重水合 —— 多开页签删了草稿，这边下次刷新就跟上
    loadBillDrafts();
  }

  async function refreshBillList() {
    const qs = new URLSearchParams();
    if (state.billScope === 'mine') qs.set('scope', 'mine');
    if (state.billKind) qs.set('kind', state.billKind);
    if (state.billCategory && state.billCategory !== '全部') qs.set('category', state.billCategory);
    if (state.billQuery.trim()) qs.set('q', state.billQuery.trim());
    const out = await api('/api/bills?' + qs.toString());
    state.bills = out.bills || [];
    state.billListLoaded = true;
  }

  /* ═══ v4.0.0 需求 1：聊天内容只存浏览器本地缓存（仅保留当日），服务端不再落库 ═══
     POST /api/bills/chat、/api/bills、/api/bills/ocr 的响应里都会带回本轮产生的气泡
     （`chat` 数组）—— 前端把它们追加进缓存并渲染；跨天自动清空。 */

  const BILL_CHAT_LS = 'fh-bill-chat';

  function billChatDateKey() {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
  }

  /** 从 localStorage 读今天的聊天（存的日期不是今天就当作没有 —— 只保留当日） */
  function loadBillChatCache() {
    let msgs = [];
    try {
      const raw = localStorage.getItem(BILL_CHAT_LS);
      if (raw) {
        const v = JSON.parse(raw);
        if (v && v.date === billChatDateKey() && Array.isArray(v.msgs)) msgs = v.msgs;
      }
    } catch { /* 缓存坏了就当没有 */ }
    state.billChat = msgs.slice(-200);
  }

  function saveBillChatCache() {
    try {
      localStorage.setItem(BILL_CHAT_LS, JSON.stringify({
        date: billChatDateKey(),
        msgs: state.billChat.slice(-200),
      }));
    } catch { /* 存不了就算了（隐私模式等），聊天本来就是易失的 */ }
  }

  /** 把服务端响应里带回的气泡追加进本地缓存（空数组安全） */
  function appendBillChat(arr) {
    if (!Array.isArray(arr) || !arr.length) return;
    state.billChat = state.billChat.concat(arr.filter((c) => c && c.id)).slice(-200);
    saveBillChatCache();
  }

  /** v4.0.0 起不再请求服务端历史 —— 只按日期水合本地缓存（保留函数名兼容旧调用） */
  async function refreshBillChat() {
    loadBillChatCache();
  }

  /* ═══ v4.1.0 需求 1：识别草稿箱（localStorage 持久，跨天不清） ═══
     与聊天缓存不同：草稿的意义就是「现在没空、回头再记」，所以只设总量上限，
     不按日期清理；入账成功或手动删除才移除。 */

  const BILL_DRAFTS_LS = 'fh-bill-drafts';
  const BILL_DRAFTS_MAX = 50;

  function loadBillDrafts() {
    let arr = [];
    try {
      const raw = localStorage.getItem(BILL_DRAFTS_LS);
      if (raw) {
        const v = JSON.parse(raw);
        if (Array.isArray(v)) arr = v.filter((r) => r && typeof r === 'object' && r.id);
      }
    } catch { /* 缓存坏了就当没有 */ }
    state.billDrafts = arr.slice(-BILL_DRAFTS_MAX);
  }

  function saveBillDrafts() {
    try {
      localStorage.setItem(BILL_DRAFTS_LS, JSON.stringify(state.billDrafts.slice(-BILL_DRAFTS_MAX)));
    } catch { /* 存不了就算了（隐私模式等）：本次会话内草稿仍在内存里可用 */ }
  }

  /** 把若干条 OCR 结果追加进草稿箱（自动补 id，超上限丢最旧的）。 */
  function appendBillDrafts(rows) {
    const base = Date.now().toString(36);
    rows.forEach((r, i) => {
      state.billDrafts.push({
        id: 'd' + base + '-' + i,
        amount: String(r.amount || ''),
        category: String(r.category || '其他'),
        note: String(r.note || ''),
        platform: String(r.platform || ''),
        date: String(r.date || todayKey()),
        text: String(r.text || ''),
        savedAt: new Date().toISOString(),
      });
    });
    state.billDrafts = state.billDrafts.slice(-BILL_DRAFTS_MAX);
    saveBillDrafts();
  }

  function removeBillDraft(id) {
    state.billDrafts = state.billDrafts.filter((r) => r.id !== id);
    saveBillDrafts();
  }

  async function syncNow(opts) {
    const o = opts || {};
    if (!state.me) return;
    setSync('busy');
    try {
      if (state.tab === 'calendar') await refreshTodos({ incremental: !!o.poll });
      else if (state.tab === 'moments') await refreshPosts();
      else if (state.tab === 'records') await refreshRecords();
      else if (state.tab === 'bills') {
        await refreshBills(); await refreshBillList(); await refreshBillChat();
        await refreshBillServerDrafts();          // v4.9.0 需求 1：微信草稿箱
        if (state.billView === 'cal') await refreshBillCalendar();  // v4.9.0 需求 2
        render();
      }
      else { await refreshMembers(); await refreshPrefs(); await refreshWecom(); await refreshSystemStatus(); await refreshTodos({ incremental: !!o.poll }); render(); }
      state.lastSyncAt = Date.now();
      setSync('idle');
      // v1.9.0：顺手刷新红点状态；当前正在看的版块有新内容就直接标记已读
      //（用户正盯着它看，亮着红点反而莫名其妙），只是别为此多发请求。
      await refreshSeen();
      if (unreadMap()[TAB_KIND[state.tab]]) await markTabSeen(state.tab);
    } catch (err) {
      if (err.status === 401) { handleLogoutLocally(); return; }
      setSync('offline');
      if (!o.silent) toast(err.message || '同步失败', 'err');
    }
  }

  let pollTimer = null;
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && !$('#modal-layer')) {
        /* ★ v4.3.2 需求 3：上一轮同步还没跑完就跳过这一轮。
           打包成 fpk 后接口变慢时，12 秒一次的轮询会**互相叠加** ——
           几次刷新与重绘挤在一起，观感就是「界面一顿一顿的」。
           只跳过自动轮询，用户主动触发的同步一律照跑（下拉刷新点了就得有反应）。 */
        if (state.sync === 'busy') return;
        syncNow({ silent: true, poll: true });
      }
    }, 12000);
  }

  /* ═══ 登录 / 注册 / 启动 ═════════════════════════════════ */

  function showScreen(which) {
    $('#boot-screen').classList.toggle('hidden', which !== 'boot');
    $('#auth-screen').classList.toggle('hidden', which !== 'auth');
    $('#app-screen').classList.toggle('hidden', which !== 'app');
  }

  function authError(msg) {
    const el = $('#auth-error');
    if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  /**
   * 站点名称的唯一入口：清洗 → 兜底 → 落到 APP_NAME。
   * 服务端下发的名字是**唯一数据源**（v1.8.0 起管理员可自定义），但要：
   *   ① 用出厂默认值兜底（值为空、接口失败、连的是老服务端都可能拿到空）；
   *   ② 本地再做一次和服务端同规则的清洗 —— 名字最终会进 `document.title` 和邮件标题，
   *      多一道防线不吃亏（控制字符会把标题撑成多行）。
   * v1.6.0 那版是反过来的（前端写死、不信任服务端），现在按需求改回「信任服务端」，
   * 但保留兜底，所以两种服务端都能正确显示。
   */
  function setAppName(raw) {
    const s = String(raw == null ? '' : raw)
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 20);
    APP_NAME = s || DEFAULT_APP_NAME;
    return APP_NAME;
  }

  /** 把当前名称刷到所有静态位置（标题栏、启动页、登录页、浏览器标签） */
  function refreshAppName() {
    document.title = APP_NAME;
    const boot = $('#boot-name');
    if (boot) boot.textContent = APP_NAME;
    const top = $('#topbar-title');
    if (top) top.textContent = APP_NAME;
    // v4.11.0：桌面端侧栏的品牌区也要跟着改
    const rail = $('#rail-name');
    if (rail) rail.textContent = APP_NAME;
    const auth = $('#auth-title');
    if (auth) auth.textContent = APP_NAME;
  }

  function applyConfig(cfg) {
    // ★ 合并而非整体替换：state.config 带着 maxUploadMb / maxFileMb 的兜底默认值，
    //   而旧版服务端的 /api/config 没有这两个字段；整体替换会让上传上限变 undefined，
    //   前端「这张图太大了」的本地拦截就全失效了。v1.5.0
    state.config = Object.assign({}, state.config, cfg || {});
    // ★ v1.8.0：站点名称以服务端为准。
    //   先读新字段 siteName；读不到再退回旧字段 familyName（v1.6.0 及更早只下发它）；
    //   两者都没有就保持默认值。setAppName 内部已做兜底，不会把标题刷成空。
    setAppName((state.config.siteName || state.config.familyName || ''));
    refreshAppName();
    $('#register-hint').textContent = state.config.hasUsers
      ? '注册后即可看到全家的共享内容。'
      : '你是第一位注册的家庭成员，将自动成为管理员。';
    if (!state.config.allowRegister && state.config.hasUsers) {
      $('#auth-tabs').querySelector('[data-auth-tab="register"]').classList.add('hidden');
    }
  }

  async function enterApp(user) {
    state.me = user;
    /* v4.11.0：主题跟着人走 —— 先按服务端值校正一次。
       HTML 里那段内联脚本已经按本地缓存画过一帧，所以这里正常是「值没变、不闪」。 */
    applyTheme(user && user.theme);
    refreshAvatarMap();
    showScreen('app');
    refreshAppName();
    try {
      // v2.0.0：refreshPrefs 对所有人都跑 —— 「我的 → 通知设置」是全家人都有的入口，
      // 不进这个列表的话第一次点进「我的」会看到一片「加载中」。
      const jobs = [refreshMembers(), refreshTodos(), refreshPosts(), refreshRecords(), refreshPrefs()];
      /* v4.15.0 需求 2：AI 参数 / 分类预算 / 记账推送都搬进了「我的」，
         它们的取值来自 /api/bills/bootstrap，所以首屏就得拉一次，
         否则第一次点进「我的」会看到「还没有设置预算」这种假空态。 */
      jobs.push(refreshBills().catch(() => { /* 记账数据拉不到不该挡住整个首屏 */ }));
      if (user.is_admin) { jobs.push(refreshSettings()); jobs.push(refreshWecom()); }
      jobs.push(refreshSystemStatus());
      await Promise.all(jobs);
    } catch (err) {
      if (err.status === 401) { handleLogoutLocally(); return; }
      toast(err.message || '数据加载失败', 'err');
    }
    state.lastSyncAt = Date.now();
    setSync('idle');
    /* v4.3.3 需求 6：进主界面时先把上次没发出去的动态草稿恢复出来（并给一句提示）。
       放在 render() 之前 —— 这样首屏就是「已恢复」的样子，不会先空白再闪一下。 */
    if (restorePostDraft()) state.draftNotice = 'post';
    render();
    startPolling();
  }

  async function refreshSettings() {
    try {
      const out = await api('/api/settings');
      state.settings = out.settings;
    } catch (err) {
      if (err.status !== 403) throw err;
    }
  }

  function handleLogoutLocally() {
    state.me = null;
    state.todos = [];
    state.posts = [];
    state.records = [];
    state.members = [];
    try { sessionStorage.removeItem('fh-records-key'); } catch { /* 忽略 */ }
    if (pollTimer) clearInterval(pollTimer);
    closeModal();
    showScreen('auth');
  }

  async function boot() {
    bindAvatarFallback();
    loadBillDrafts();   // v4.1.0：草稿箱先水合，进主界面就能看到
    try {
      const cfg = await api('/api/config');
      applyConfig(cfg);
    } catch { /* 配置读不到也不阻塞 */ }
    try {
      // ★ 免登录关键：先验会话，成功就直接进主界面，登录页一次都不出现
      const out = await api('/api/me');
      await enterApp(out.user);
    } catch (err) {
      if (err.status === 401) showScreen('auth');
      else { showScreen('auth'); authError('无法连接服务器，请稍后重试'); }
    }
    state.booted = true;
  }

  /* ═══ 事件绑定 ═══════════════════════════════════════════ */

  function onAuthTab(tab) {
    authError('');
    $$('#auth-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.authTab === tab));
    $('#form-login').classList.toggle('hidden', tab !== 'login');
    $('#form-register').classList.toggle('hidden', tab !== 'register');
  }

  $('#auth-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-auth-tab]');
    if (btn) onAuthTab(btn.dataset.authTab);
  });

  /* ═══ v4.26.0：找回登录密码（邮箱验证码）═══════════════════════════
   *
   * 与现有登录流程的关系（三条）：
   *   ① 完全并列：入口在登录表单里，点开是一个独立弹窗，**不改动登录本身的提交逻辑**；
   *   ② 不需要会话：两个接口都在「需要登录」的边界之外，登录不进去的人才能用它；
   *   ③ 重置成功后**不自动登录** —— 关掉弹窗、把用户名填回登录框，
   *      让用户用新密码登一次。家里电脑可能共用，少一个自动进门的机会。
   *
   * 交互上刻意「一步到位」：一个弹窗里放全 用户名 / 验证码 / 新密码，
   * 而不是分两个弹窗 —— 家人操作时来回关弹窗最容易把验证码弄丢。
   * ═══════════════════════════════════════════════════════════ */
  let fpTimer = null;

  function fpMsg(text) {
    const el = document.querySelector('#modal-layer [data-mk="fpMsg"]');
    if (el) el.textContent = text || '';
  }

  function fpStopTimer() {
    if (fpTimer) { clearInterval(fpTimer); fpTimer = null; }
  }

  /** 发送成功后的重发倒计时：既防连点，也让「等邮件」这件事有反馈 */
  function fpStartCountdown(btn, secs) {
    fpStopTimer();
    let left = secs;
    btn.disabled = true;
    btn.textContent = `重新发送（${left}s）`;
    fpTimer = setInterval(() => {
      if (!document.body.contains(btn)) { fpStopTimer(); return; }   // 弹窗已关
      left -= 1;
      if (left <= 0) {
        fpStopTimer();
        btn.disabled = false;
        btn.textContent = '重新发送';
        return;
      }
      btn.textContent = `重新发送（${left}s）`;
    }, 1000);
  }

  function openForgotForm() {
    fpStopTimer();
    openModal({
      title: '找回登录密码',
      body: `
        <div class="note-box">
          填你的<b>用户名</b>，系统会给这个账号<b>绑定的邮箱</b>发一条 6 位验证码。
          验证码 15 分钟内有效、只能用一次；10 分钟内最多发 3 次。
        </div>
        <label class="field"><span>用户名</span>
          <input type="text" data-mk="fpUser" autocomplete="username" placeholder="你的登录名"></label>
        <label class="field"><span>验证码（邮件里的 6 位数字）</span>
          <input type="text" data-mk="fpCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000"></label>
        <label class="field"><span>新密码</span>
          <input type="password" data-mk="fpPass" autocomplete="new-password" placeholder="至少 6 位"></label>
        <label class="field"><span>确认新密码</span>
          <input type="password" data-mk="fpPass2" autocomplete="new-password" placeholder="再输一次"></label>
        <p class="field-hint" data-mk="fpMsg"></p>
        <div class="note-box">
          没有绑定邮箱、或邮件一直收不到？让家里的管理员在「我的 → 家庭成员」里重置你的密码。
        </div>`,
      foot: `<button type="button" class="btn-ghost" data-act="fp-send">发送验证码</button>
        <button type="button" class="btn-primary" data-act="fp-reset">重置密码</button>`,
      onMount: (layer) => {
        const u = layer.querySelector('[data-mk="fpUser"]');
        // 登录框里已经敲了用户名就带过来，少打一遍（这也是最常见的场景：密码错了才发现忘了）
        const typed = $('#form-login') && $('#form-login').querySelector('[name="username"]');
        if (u && typed && typed.value) u.value = String(typed.value).trim();
        if (u) u.focus();
      },
    });
  }

  async function sendForgotCode() {
    const user = String(modalValue('fpUser') || '').trim();
    if (!user) { fpMsg('请先填用户名'); return; }
    const btn = document.querySelector('#modal-layer [data-act="fp-send"]');
    if (btn) btn.disabled = true;
    fpMsg('正在发送…');
    try {
      await api('/api/forgot-password', { method: 'POST', body: { username: user } });
      /* 服务端刻意不告诉我们「这个账号存不存在 / 有没有绑邮箱」，
         所以这里的文案也必须是「如果…就已经发出」——两边口径要对得上。 */
      fpMsg('如果这个用户名绑定了邮箱，验证码已经发出。几分钟内没收到，请确认用户名是否正确。');
      if (btn) fpStartCountdown(btn, 30);
    } catch (err) {
      fpMsg(err.message);
      if (btn) btn.disabled = false;
    }
  }

  async function submitForgotReset() {
    const user = String(modalValue('fpUser') || '').trim();
    const code = String(modalValue('fpCode') || '').trim();
    const p1 = String(modalValue('fpPass') || '');
    const p2 = String(modalValue('fpPass2') || '');
    if (!user) { fpMsg('请先填用户名'); return; }
    if (!/^\d{6}$/.test(code)) { fpMsg('请输入邮件里的 6 位数字验证码'); return; }
    if (p1.length < 6) { fpMsg('新密码至少 6 位'); return; }
    if (p1 !== p2) { fpMsg('两次输入的新密码不一致'); return; }
    const btn = document.querySelector('#modal-layer [data-act="fp-reset"]');
    if (btn) btn.disabled = true;
    fpMsg('正在重置…');
    try {
      await api('/api/reset-password', { method: 'POST', body: { username: user, code, password: p1 } });
      fpStopTimer();
      closeModal();
      toast('密码已重置，请用新密码登录', 'ok');
      /* 把用户名填回登录框、密码框聚焦：用户下一步就是登录，别再让他点一遍。
         注意**不**预填密码（哪怕我们刚知道它）—— 预填等于把新密码留在 DOM 里。 */
      const form = $('#form-login');
      if (form) {
        const uEl = form.querySelector('[name="username"]');
        const pEl = form.querySelector('[name="password"]');
        if (uEl) uEl.value = user;
        if (pEl) { pEl.value = ''; pEl.focus(); }
      }
    } catch (err) {
      fpMsg(err.message);
      if (btn) btn.disabled = false;
    }
  }

  $('#form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    authError('');
    const f = e.target;
    const btn = f.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(f).entries());
      const out = await api('/api/login', {
        method: 'POST',
        body: { username: String(data.username || '').trim(), password: data.password },
      });
      f.reset();
      await enterApp(out.user);
      toast(`欢迎回来，${out.user.display_name}`, 'ok');
    } catch (err) {
      authError(err.message);
    } finally { btn.disabled = false; }
  });

  $('#form-register').addEventListener('submit', async (e) => {
    e.preventDefault();
    authError('');
    const f = e.target;
    const data = Object.fromEntries(new FormData(f).entries());
    if (data.password !== data.password2) { authError('两次输入的密码不一致'); return; }
    const btn = f.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const out = await api('/api/register', {
        method: 'POST',
        body: {
          username: String(data.username || '').trim(),
          display_name: String(data.display_name || '').trim(),
          password: data.password,
        },
      });
      f.reset();
      await enterApp(out.user);
      toast(`注册成功，欢迎 ${out.user.display_name}`, 'ok');
    } catch (err) {
      authError(err.message);
    } finally { btn.disabled = false; }
  });

  $('#tabbar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    state.tab = btn.dataset.tab;
    render();
    // 点进某个版块就算「看过它了」→ 立刻灭掉它自己的红点（先本地生效，再异步落库）
    markTabSeen(state.tab);
    syncNow({ silent: true });
  });

  $('#btn-refresh').addEventListener('click', () => syncNow());

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.me) syncNow({ silent: true });
  });
  window.addEventListener('focus', () => { if (state.me) syncNow({ silent: true }); });
  window.addEventListener('online', () => { if (state.me) syncNow({ silent: true }); });
  window.addEventListener('offline', () => setSync('offline'));

  /* ═══ 输入法键盘适配 ═════════════════════════════════════
     手机上输入法弹出时，布局视口（layout viewport）不会变小，只有 visualViewport 会，
     所以仅靠 100dvh 无法保证「正在输入的内容不被键盘挡住」。这里把
     「视口被键盘顶掉的高度」写进 --kb，并加 body.kb-active，由 CSS 把弹窗整体
     上移、隐藏底部导航；再加上聚焦后把输入框滚到屏幕中间，双保险。
     ═════════════════════════════════════════════════════════ */

  function fitKeyboard() {
    const vv = window.visualViewport;
    if (!vv) return;
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty('--kb', `${kb}px`);
    document.body.classList.toggle('kb-active', kb > 90);
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fitKeyboard);
    window.visualViewport.addEventListener('scroll', fitKeyboard);
    fitKeyboard();
  }
  window.addEventListener('orientationchange', () => setTimeout(fitKeyboard, 240));

  // 聚焦任意输入框：等键盘动画结束后把它滚到屏幕中间，保证正在输入的一行可见
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (!el || !el.tagName) return;
    if (!/^(INPUT|TEXTAREA)$/.test(el.tagName)) return;
    if (['file', 'checkbox', 'radio', 'range', 'color'].includes(el.type)) return;
    setTimeout(() => {
      if (document.activeElement !== el) return;
      if (typeof el.scrollIntoView === 'function') {
        try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { el.scrollIntoView(); }
      }
    }, 280);
  });

  /* —— 统一事件委托 —— */

  document.addEventListener('click', async (e) => {
    // 图片菜单开着时，点菜单以外任意位置先收起
    const openMenu = $('#img-menu');
    if (openMenu && !e.target.closest('#img-menu')) closeImgMenu();

    const el = e.target.closest('[data-act]');
    /* v4.23.0 需求 3：动态右下角「⋯」菜单 —— 点菜单与按钮以外的任何地方先收起。
       若这一下点的是别的动作，那次动作自己会 render，菜单随之消失；
       点的是空白（没有 data-act）则这里补一次重绘，否则菜单会一直挂着。 */
    if (state.postMenu && !e.target.closest('.post-menu') && !e.target.closest('[data-act="post-more"]')) {
      state.postMenu = 0;
      if (!el) { render(); return; }
    }
    if (!el) return;
    const act = el.dataset.act;
    const id = el.dataset.id ? Number(el.dataset.id) : null;

    switch (act) {
      /* v4.26.0：忘记密码 —— 登录页入口 + 弹窗里的「发送验证码 / 重置密码」。
         放在委托入口最前面：这三个动作在登录页也能触发，不该受「必须先登录」的逻辑影响。 */
      case 'forgot-open': openForgotForm(); break;
      case 'fp-send': await sendForgotCode(); break;
      case 'fp-reset': await submitForgotReset(); break;
      /* 日历导航 */
      case 'cal-prev': {
        state.cursor.m = state.cursor.m - 1;
        if (state.cursor.m < 0) { state.cursor.m = 11; state.cursor.y--; }
        render(); break;
      }
      case 'cal-next': {
        state.cursor.m = state.cursor.m + 1;
        if (state.cursor.m > 11) { state.cursor.m = 0; state.cursor.y++; }
        render(); break;
      }
      case 'cal-today': {
        const n = new Date();
        state.cursor = { y: n.getFullYear(), m: n.getMonth() };
        state.selected = todayKey();
        render(); break;
      }
      /* v4.3.3 需求 7：点左上角年月 → 自定义年月日跳转 */
      case 'cal-jump': {
        const cur = state.cursor;
        openDateJump('todo', cur.y, cur.m + 1, Number(String(state.selected || '').slice(8, 10)) || 1);
        break;
      }
      case 'post-cal-jump': {
        const cur = state.postCalCursor;
        const sel = String(state.postCalDay || todayKey());
        openDateJump('post', cur.y, cur.m + 1, Number(sel.slice(8, 10)) || 1);
        break;
      }
      case 'date-jump-ok':
        applyDateJump(['post', 'bill'].indexOf(el.dataset.kind) >= 0 ? el.dataset.kind : 'todo');
        break;
      /* v4.9.0 需求 2：记账日历的翻月 / 回今天 / 跳转 / 点某天 */
      case 'bill-cal-prev': shiftMonth('bill', -1); break;
      case 'bill-cal-next': shiftMonth('bill', 1); break;
      case 'bill-cal-today': {
        const now = new Date();
        state.billCalCursor = { y: now.getFullYear(), m: now.getMonth() };
        state.billCalDay = '';
        state.billCalDayBills = null;
        await refreshBillCalendar();
        render();
        break;
      }
      case 'bill-cal-jump': {
        const bc = state.billCalCursor || { y: new Date().getFullYear(), m: new Date().getMonth() };
        openDateJump('bill', bc.y, bc.m + 1, Number(String(state.billCalDay || '').slice(8, 10)) || 1);
        break;
      }
      case 'bill-cal-pick': await refreshBillCalDay(el.dataset.date); break;
      case 'bill-cal-close':
        state.billCalDay = '';
        state.billCalDayBills = null;
        render();
        break;
      case 'pick-date':
        state.selected = el.dataset.date;
        render();
        break;

      /* 待办 */
      case 'todo-new': state.selected = el.dataset.date || state.selected; await openTodoForm(null); break;
      case 'todo-quick-add': await quickAddTodo(); break;
      case 'todo-edit': {
        const t = state.todos.find((x) => x.id === id);
        if (t) await openTodoForm(t);
        break;
      }
      case 'todo-toggle': toggleTodo(id); break;
      /* v4.21.0 需求 2：重复事项勾的是「这一天」 */
      case 'todo-day-toggle': await toggleTodoDay(id, el.dataset.date); break;
      case 'todo-save': saveTodo(id || null); break;
      /* v4.12.0：'time-pick'（常用时间 chip）已随需求「移除常用时间点选」一并删除。
         时间只剩「开始时间输入框 + 时长下拉」两个控件，不需要额外处理器。 */
      case 'todo-delete': {
        if (!window.confirm('确定删除这条待办吗？删除后无法恢复。')) return;
        try {
          await api('/api/todos/' + id, { method: 'DELETE' });
          closeModal();
          await refreshTodos();
          toast('已删除', 'ok');
        } catch (err) { toast(err.message, 'err'); }
        break;
      }
      case 'todo-done': {
        const changed = await toggleTodo(id);
        if (!changed) break;                         // 用户在确认框里点了取消
        const t = state.todos.find((x) => x.id === id);
        const btn = $('#modal-layer [data-act="todo-done"]');
        if (btn && t) btn.textContent = t.done ? '标为未完成' : '标为已完成';
        break;
      }
      /* v4.20.0（审查 W-9）：结束重复 —— 重复事项没有「完成」状态，
         不给一个收尾入口的话它会永久留在库里每天提醒一次（v4.19 起一句话待办
         默认每天重复，这一条就成了必须）。服务端负责清 repeat_rule 并标记完成。 */
      case 'todo-end-repeat': {
        if (!window.confirm('结束这条重复提醒吗？\n它会变回一次性待办并标记为已完成，以后不再重复提醒。')) return;
        try {
          await api(`/api/todos/${id}/end-repeat`, { method: 'POST' });
          closeModal();
          await refreshTodos();
          toast('已结束重复提醒', 'ok');
        } catch (err) { toast(err.message || '操作失败', 'err'); }
        break;
      }
      case 'todo-filter': break;
      case 'todo-more':
        state.todoShown += state.todoPageSize;
        render();
        break;
      case 'repeat-toggle':
        state.repeatOpen = !state.repeatOpen;
        render();
        break;
      case 'part-toggle': {
        const name = el.dataset.name;
        const list = modalParticipants();
        const i = list.indexOf(name);
        if (i >= 0) list.splice(i, 1); else list.push(name);
        setModalParticipants(list);
        break;
      }
      case 'prio-pick': break;
      case 'vis-pick': break;
      /* v4.28.2：「指定可见成员」里逐个勾选。勾完立刻同步参与人候选的可用状态。 */
      case 'vis-member': {
        el.classList.toggle('on');
        el.setAttribute('aria-pressed', el.classList.contains('on') ? 'true' : 'false');
        syncPartChips($('#modal-layer'));
        break;
      }

      /* 动态 */
      case 'compose-pick': $('#compose-file').click(); break;
      case 'compose-vpick': $('#compose-video-file').click(); break;
      /* v4.13.0（问题 4）：发帖表情面板 —— 展开 / 收起，选项在面板里点。
         面板开关是界面状态，必须走 render（并进 DATA_SIG.moments）。 */
      case 'compose-emoji':
        state.composeEmoji = !state.composeEmoji;
        render();
        break;
      case 'compose-emoji-pick': await insertComposeEmoji(el.dataset.emoji || ''); break;
      /* v2.0.0 需求 4：「发帖」面板收起 / 展开。
         展开后把焦点直接送进正文框 —— 少一次点击才是「整合」的意义所在。
         注：草稿存在 state.compose.text 里，收起不会丢字。 */
      case 'post-compose': {
        state.composeOpen = !state.composeOpen;
        render();
        if (state.composeOpen) {
          const ta = document.querySelector('[data-act="compose-text"]');
          if (ta) {
            ta.focus();
            try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch { /* 忽略 */ }
          }
        }
        break;
      }
      case 'compose-del':
        state.compose.images.splice(Number(el.dataset.i), 1);
        schedulePostDraft();
        render();
        break;
      case 'compose-vdel':
        state.compose.videos.splice(Number(el.dataset.i), 1);
        schedulePostDraft();
        render();
        break;
      // v1.9.0：点一下已有标签就把它加进标签输入框（已存在就跳过，别加出两个一样的）
      case 'compose-tag-add': {
        const inp = document.querySelector('[data-act="compose-tags"]');
        if (!inp) break;
        const cur = inp.value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
        const t = el.dataset.tag || '';
        if (t && !cur.includes(t)) { cur.push(t); inp.value = cur.join(' '); }
        inp.focus();
        /* v4.3.3 需求 6：点选标签也是内容变更，同步进 state 再排一次自动存草稿
           （否则「只点了标签」这种最容易被刷掉的半成品会丢） */
        state.compose.tags = inp.value;
        schedulePostDraft();
        break;
      }
      /* v4.3.3 需求 6：手动存草稿 / 丢弃草稿 */
      case 'draft-save': {
        /* 先把当前输入框里的最新内容读回 state —— 手动点「存草稿」时
           用户可能刚敲完还没触发 input 事件（比如输入法还在组合中）。 */
        const ta = document.querySelector('[data-act="compose-text"]');
        if (ta) state.compose.text = ta.value;
        const tg = document.querySelector('[data-act="compose-tags"]');
        if (tg) state.compose.tags = tg.value;
        if (savePostDraftNow()) toast('草稿已保存，下次打开会自动恢复', 'ok');
        else toast('还没有内容，无需保存', 'err');
        break;
      }
      case 'draft-drop': {
        dropDraft(POST_DRAFT_KEY);
        clearDraftHint('post');
        state.draftNotice = '';
        resetCompose();
        /* ★ 必须显式清 DOM：`<textarea>` 的 value 不在 outerHTML 里，
           而且它挂着 data-preserve —— 只改 state 再 render 的话，
           最小重绘会把「用户正在编辑的那份旧文字」原样保留，
           表现就是「点了丢弃草稿，字还在」。 */
        clearComposeInputs();
        render();
        toast('草稿已丢弃', 'ok');
        break;
      }
      /* 动态「按日历看」（v1.9.0） */
      case 'post-pick-date':
        state.postCalDay = el.dataset.date;
        render();
        break;
      case 'post-cal-prev': shiftMonth('post', -1); break;
      case 'post-cal-next': shiftMonth('post', 1); break;
      case 'post-cal-today': {
        const n = new Date();
        state.postCalCursor = { y: n.getFullYear(), m: n.getMonth() };
        state.postCalDay = todayKey();
        render();
        break;
      }
      /* 动态共创（v1.9.0） */
      case 'contrib-add': {
        state.postMenu = 0;   // v4.23.0：从菜单进来，先收起菜单再开弹窗
        const p = state.posts.find((x) => x.id === id);
        if (p) openContribForm(p);
        break;
      }
      /* v4.3.3 需求 5：编辑自己已经写下的补充内容 */
      case 'contrib-edit': {
        const p = state.posts.find((x) => x.id === Number(el.dataset.post));
        const c = p && (p.contributions || []).find((x) => x.id === id);
        if (p && c) openContribForm(p, c);
        break;
      }
      case 'contrib-save': await saveContribution(id, Number(el.dataset.cid) || 0); break;
      case 'contrib-img-add': { const f = $('#contrib-file'); if (f) f.click(); break; }
      case 'contrib-video-add': { const f = $('#contrib-video-file'); if (f) f.click(); break; }
      case 'contrib-img-del': {
        const layer = $('#modal-layer');
        if (!layer) break;
        let imgs = [];
        try { imgs = JSON.parse(layer.dataset.images || '[]'); } catch { /* 忽略 */ }
        imgs.splice(Number(el.dataset.i), 1);
        layer.dataset.images = JSON.stringify(imgs);
        const box = document.querySelector('#contrib-imgs');
        if (box) box.innerHTML = postThumbHtml(imgs, 'contrib-img-del');
        break;
      }
      case 'contrib-video-del': {
        const layer = $('#modal-layer');
        if (!layer) break;
        let vids = [];
        let covers = {};
        try { vids = JSON.parse(layer.dataset.videos || '[]'); } catch { /* 忽略 */ }
        try { covers = JSON.parse(layer.dataset.videoCovers || '{}'); } catch { /* 忽略 */ }
        const gone = vids.splice(Number(el.dataset.i), 1)[0];
        // v4.6.0：删掉视频时把它的封面也一起摘掉，免得旧封面跟着新列表漂移
        if (gone && covers[gone]) delete covers[gone];
        layer.dataset.videos = JSON.stringify(vids);
        layer.dataset.videoCovers = JSON.stringify(covers);
        const box = document.querySelector('#contrib-videos');
        if (box) box.innerHTML = videoChipHtml(vids, 'contrib-video-del', '', covers);
        break;
      }
      case 'contrib-del': {
        if (!window.confirm('确定删除这条补充内容吗？')) return;
        try {
          await api('/api/contribs/' + id, { method: 'DELETE' });
          await refreshPosts();
          toast('已删除', 'ok');
        } catch (err) { toast(err.message, 'err'); }
        break;
      }
      /* 记录本：归档视图切换（v1.9.0） */
      case 'rec-arch-view': break;      // 由分段控件处理器负责
      case 'post-view': break;          // 同上
      /* v4.28.2：动态发布区的可见范围。原来的一个「🔒 仅自己可见」开关
         换成「全家可见 / 指定可见成员」两档；切到指定时清空名单
         —— 需求要求「默认仅自己可见」，不能沿用上一帖勾过的人。 */
      case 'compose-vis':
        if (el.dataset.vis === 'private') {
          if (state.compose.visibility !== 'private') state.compose.visibleTo = [];
          state.compose.visibility = 'private';
        } else {
          state.compose.visibility = 'family';
          state.compose.visibleTo = [];
        }
        render(); break;
      case 'compose-vis-member': {
        const uid = Number(el.dataset.visId) || 0;
        const cur = (state.compose.visibleTo || []).map(Number);
        const i = cur.indexOf(uid);
        if (i >= 0) cur.splice(i, 1); else cur.push(uid);
        state.compose.visibleTo = cur;
        render();
        break;
      }
      case 'compose-publish': await publishPost(); break;
      case 'post-edit': {
        state.postMenu = 0;   // v4.23.0：从菜单进来，先收起菜单
        const p = state.posts.find((x) => x.id === id);
        if (!p) break;
        // 服务端会再校验一次；这里只是不给非作者显示入口，顺带挡掉伪造的点击
        if (!p.mine) { toast('只能编辑自己发布的动态', 'err'); break; }
        openPostForm(p);
        break;
      }
      case 'post-save': await savePost(id); break;
      case 'post-img-add': {
        const f = $('#post-file');
        if (f) f.click();
        break;
      }
      case 'post-img-del': {
        const layer = $('#modal-layer');
        if (!layer) break;
        let imgs = [];
        try { imgs = JSON.parse(layer.dataset.images || '[]'); } catch { /* 忽略 */ }
        imgs.splice(Number(el.dataset.i), 1);
        layer.dataset.images = JSON.stringify(imgs);
        renderPostThumbs(imgs);
        break;
      }
      case 'post-video-add': { const f = $('#post-video-file'); if (f) f.click(); break; }
      case 'post-video-del': {
        const layer = $('#modal-layer');
        if (!layer) break;
        let vids = [];
        try { vids = JSON.parse(layer.dataset.videos || '[]'); } catch { /* 忽略 */ }
        vids.splice(Number(el.dataset.i), 1);
        layer.dataset.videos = JSON.stringify(vids);
        renderPostVideos(vids);
        break;
      }
      // 编辑表单里点选已有标签 → 追加到标签输入框
      case 'form-tag-add': {
        const inp = document.querySelector('#modal-layer [data-mk="tags"]');
        if (!inp) break;
        const cur = inp.value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
        const t = el.dataset.tag || '';
        if (t && !cur.includes(t)) { cur.push(t); inp.value = cur.join(' '); }
        break;
      }
      case 'post-del': {
        state.postMenu = 0;
        if (!window.confirm('确定删除这条动态吗？其下评论也会一起删除。')) return;
        try {
          await api('/api/posts/' + id, { method: 'DELETE' });
          await refreshPosts();
          toast('已删除', 'ok');
        } catch (err) { toast(err.message, 'err'); }
        break;
      }
      case 'comment-send': await sendComment(id); break;

      /* ── v4.3.3 需求 1：点赞 / 回复 / 表情 ────────────────
         全部就地操作（改 DOM + dataset），不经过 render()：
         这块区域里始终有一个可能正在输入的评论框，整块重绘会打断输入。 */
      case 'like-toggle': await toggleLike(el); break;
      /* v4.23.0 需求 3：右下角「⋯」菜单与「评论」展开 */
      case 'post-more': {
        const pid = Number(el.dataset.id) || 0;
        state.postMenu = Number(state.postMenu) === pid ? 0 : pid;
        render();
        break;
      }
      case 'post-comment-open': {
        const pid = Number(el.dataset.id) || 0;
        state.postMenu = 0;
        state.postOpen = Object.assign({}, state.postOpen, {
          [pid]: Object.assign({}, state.postOpen[pid], { comments: true }),
        });
        render();
        // 展开后把焦点送进输入框（少一次点击）；节点可能还没挂上，等一帧
        setTimeout(() => {
          const inp = document.querySelector(`[data-act="comment-input"][data-id="${pid}"]`);
          if (inp) inp.focus();
        }, 40);
        break;
      }
      case 'comment-reply': {
        /* ★ 「回复」按钮长在评论节点里（.comment-list 内部），而输入框在它的**兄弟**层
           `.comment-form`。所以不能 closest('.comment-form')（永远是 null），
           要先上到 .comments 再取表单 —— 首跑就是这里找错了，点了没反应。 */
        const box = el.closest('.comments');
        const form = box && box.querySelector('.comment-form');
        if (!form) break;
        form.dataset.replyTo = el.dataset.cid || '';
        form.dataset.replyName = el.dataset.name || '';
        let chip = form.querySelector('.reply-chip');
        if (!chip) {
          chip = document.createElement('div');
          chip.className = 'reply-chip';
          form.insertBefore(chip, form.firstChild);
        }
        chip.innerHTML = `回复 ${esc(el.dataset.name || '')}`
          + '<button type="button" data-act="comment-reply-cancel">取消</button>';
        const input = form.querySelector('[data-act="comment-input"]');
        if (input) {
          input.placeholder = `回复 ${el.dataset.name || ''}…`;
          input.focus();
        }
        break;
      }
      case 'comment-reply-cancel': {
        const form = el.closest('.comment-form');
        if (!form) break;
        form.dataset.replyTo = '';
        form.dataset.replyName = '';
        const chip = form.querySelector('.reply-chip');
        if (chip) chip.remove();
        const input = form.querySelector('[data-act="comment-input"]');
        if (input) input.placeholder = '写下你的评论…';
        break;
      }
      case 'emoji-toggle': {
        const form = el.closest('.comment-form');
        if (!form) break;
        const exist = form.querySelector('.emoji-panel');
        if (exist) { exist.remove(); break; }
        const panel = document.createElement('div');
        panel.className = 'emoji-panel';
        panel.innerHTML = COMMENT_EMOJIS
          .map((e) => `<button type="button" data-act="emoji-pick" data-emoji="${e}">${e}</button>`).join('');
        form.appendChild(panel);
        break;
      }
      case 'emoji-pick': {
        const form = el.closest('.comment-form');
        const input = form && form.querySelector('[data-act="comment-input"]');
        if (input) {
          input.value += el.dataset.emoji || '';
          input.focus();
        }
        break;
      }
      /* ★ v4.15.0 需求 6：搜索框下面那排标签在**发帖状态下**是「选标签」而不是「筛动态」。
         点一下加进这次发布、再点一下取消；标签栏左侧的说明文字会同步变，
         所以同一个按钮两种含义不会让人猜。 */
      case 'post-tag': {
        const t = el.dataset.tag || '';
        if (state.composeOpen) {
          const inp = document.querySelector('[data-act="compose-tags"]');
          const cur = String(state.compose.tags || '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
          const i = cur.indexOf(t);
          if (i >= 0) cur.splice(i, 1); else if (t) cur.push(t);
          state.compose.tags = cur.join(' ');
          if (inp) inp.value = state.compose.tags;   // <input> 的 value 不在 outerHTML 里，必须显式写回
          schedulePostDraft();
          render();
          break;
        }
        state.postTag = t;
        render();
        break;
      }
      case 'post-q-clear': {
        // 主动清空：连 DOM 里那份旧文字一起作废，否则会被输入态保护又填回去
        clearSearchInput('post-query');
        state.postQuery = '';
        render();
        break;
      }
      case 'todo-q-clear': {
        clearSearchInput('todo-query');
        state.todoQuery = '';
        state.todoShown = state.todoPageSize;
        state.repeatOpen = false;      // 关键词没了，「周期提醒」也跟着收起
        render();
        break;
      }
      case 'rec-q-clear': {
        clearSearchInput('rec-query');
        state.recQuery = '';
        render();
        break;
      }
      // 点图片：连同它所在的图组一起打开，进入灯箱后即可左右切换
      case 'img-view': openLightbox(el.dataset.src || el.getAttribute('src') || '', galleryOf(el)); break;
      /* v4.6.0 需求 4：移动端那层封面图被点 → 直接开播。
         播起来之后 .pv-wrap.playing 会把封面层藏掉（CSS 里做），原生控件就露出来了。 */
      case 'pv-start': {
        const wrap = el.closest('.pv-wrap');
        const v = wrap && wrap.querySelector('video');
        if (v) { try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch { /* 交给原生控件 */ } }
        break;
      }
      case 'lb-close': closeLightbox(); break;
      case 'lb-prev': lbStep(-1); break;
      case 'lb-next': lbStep(1); break;
      case 'img-menu-view': {
        const gal = parseGallery(el.closest('#img-menu') ? el.closest('#img-menu').getAttribute('data-gal') : '');
        closeImgMenu();
        openLightbox(el.dataset.src || '', gal);
        break;
      }
      case 'img-menu-save': closeImgMenu(); saveImageToDevice(el.dataset.src || ''); break;
      case 'img-menu-cancel': closeImgMenu(); break;
      case 'rec-img-add': { const f = $('#rec-file'); if (f) f.click(); break; }
      case 'rec-att-add': { const f = $('#rec-att-file'); if (f) f.click(); break; }
      case 'rec-att-del': {
        const layer = $('#modal-layer');
        if (!layer) break;
        let atts = [];
        try { atts = JSON.parse(layer.dataset.attachments || '[]'); } catch { /* 忽略 */ }
        const removed = atts.splice(Number(el.dataset.i), 1)[0];
        layer.dataset.attachments = JSON.stringify(atts);
        renderRecordAtts(atts);
        scheduleRecordDraft();   // v4.3.3 需求 6：附件增删也算内容变更
        // 只从这条记录里摘掉引用，服务器上的文件不删：别的记录可能还在用它，
        // 而且删文件是不可逆的，家庭记录本不适合做这种「顺手清理」。
        if (removed) toast('已移除附件（点保存后生效）', 'ok');
        break;
      }
      case 'attach-download': {
        // 走「先拦住、再自己造一个 a 下载」的路子：
        // 附件链接嵌在整卡可点的记录卡里，直接放行会同时触发 rec-open 打开查看页。
        e.preventDefault();
        const url = el.dataset.url || el.getAttribute('href');
        if (!url) break;
        const a = document.createElement('a');
        a.href = url;
        a.setAttribute('download', '');
        document.body.appendChild(a);
        a.click();
        a.remove();
        break;
      }
      case 'rec-img-del': {
        const layer = $('#modal-layer');
        if (!layer) break;
        let imgs = [];
        try { imgs = JSON.parse(layer.dataset.images || '[]'); } catch { /* 忽略 */ }
        imgs.splice(Number(el.dataset.i), 1);
        layer.dataset.images = JSON.stringify(imgs);
        renderRecordThumbs(imgs);
        scheduleRecordDraft();   // v4.3.3 需求 6
        break;
      }
      case 'comment-del': {
        try {
          await api('/api/comments/' + id, { method: 'DELETE' });
          await refreshPosts();
        } catch (err) { toast(err.message, 'err'); }
        break;
      }

      /* 记录本 */
      case 'rec-new': openRecordForm(null); break;
      /* v4.3.3 需求 6：丢弃记录本草稿 → 清掉本地那份，再原地重开一个空白表单 */
      case 'rec-draft-drop': {
        dropDraft(REC_DRAFT_KEY);
        const lay = $('#modal-layer');
        if (lay) lay.dataset.recCommitted = '1';   // 别再被 closeModal 写回来
        closeModal();
        openRecordForm(null);
        toast('草稿已丢弃', 'ok');
        break;
      }
      /* v4.16.0 需求 5：勾选项。
         旧版在 textarea 上按光标切行；现在内容区的真身在 contenteditable 里，
         统一改成「读 → 改 Markdown → 写回编辑区并落到行尾」，行为可预期：
         新勾选项永远接在最后一条**未勾选**项之后（与"勾完自动下沉"配套）。 */
      case 'rec-check-insert': {
        const lay = $('#modal-layer');
        const ta = lay && lay.querySelector('[data-mk="content"]');
        const ed = lay && lay.querySelector('#rec-editor');
        if (!ta) break;
        recSyncContent();                       // 别丢最后一次输入
        const lines = String(ta.value || '').split('\n');
        let lastOpen = -1;
        lines.forEach((l, k) => { if (/^☐ /.test(l)) lastOpen = k; });
        if (lastOpen >= 0) lines.splice(lastOpen + 1, 0, '☐ ');
        else if (lines.length === 1 && !lines[0].trim()) lines[0] = '☐ ';
        else lines.push('☐ ');
        ta.value = lines.join('\n');
        if (ed) {
          ed.innerHTML = recMdToEditorHtml(ta.value);
          // 光标落到新加的勾选框后面，接着打字就是这条的内容
          const blocks = ed.querySelectorAll('div');
          const last = blocks[blocks.length - 1];
          if (last) {
            const r = document.createRange();
            r.selectNodeContents(last);
            r.collapse(false);
            const sel = window.getSelection && window.getSelection();
            if (sel) { sel.removeAllRanges(); sel.addRange(r); }
            if (typeof last.scrollIntoView === 'function') last.scrollIntoView({ block: 'nearest' });
          }
          if (typeof ed.focus === 'function') ed.focus();
        }
        scheduleRecordDraft();
        break;
      }
      /* v4.16.0 需求 4：工具栏只剩「序号列表」一种格式动作（图片 / 勾选框走各自入口）。
         用 execCommand 而不是自己实现选区 —— 它仍然是唯一「在所有浏览器里
         都能正确处理选区」的接口（已废弃但未移除）。jsdom 里没有 execCommand，
         那就只提示一句，不影响别的功能。 */
      case 'rec-fmt': {
        const lay = $('#modal-layer');
        const ed = lay && lay.querySelector('#rec-editor');
        if (!ed) break;
        const fmt = String(el.dataset.fmt || '');
        if (fmt !== 'insertOrderedList') break;   // 其余富文本格式已下线
        if (typeof document.execCommand !== 'function') {
          toast('当前环境不支持列表编辑', 'err');
          break;
        }
        if (typeof ed.focus === 'function') ed.focus();
        document.execCommand(fmt, false, null);
        recSyncContent();
        scheduleRecordDraft();
        break;
      }
      /* v4.16.0 需求 4：往正文里插一张图片 —— 打开选图框，真正的上传与插入
         在下面的 rec-inline-file change 处理里做。 */
      case 'rec-img-insert': {
        const lay = $('#modal-layer');
        const inp = lay && lay.querySelector('#rec-inline-file');
        if (inp && typeof inp.click === 'function') inp.click();
        break;
      }
      case 'records-unlock': await unlockRecords(); break;
      case 'record-lock': openRecordLockForm(); break;
      /* v2.0.0 需求 7：个人通知设置（所有人都能进） */
      /* v4.13.0（问题 9）：同一个入口，按角色给不同的弹窗 ——
         管理员改的是全家默认（原来那块独立的「家庭默认」表单已撤掉），
         成员改的是自己那份（跟随管理员 / 开启 / 关闭）。 */
      case 'prefs-open': {
        const which = el.dataset.which === 'notify' ? 'notify' : 'remind';
        if (state.me && state.me.is_admin) {
          if (which === 'notify') openAdminNotifyForm(); else openAdminRemindForm();
        } else {
          prefsDraft = null;
          openPrefsForm();
        }
        break;
      }
      case 'admin-msg-save': await saveAdminMsgForm(el.dataset.which === 'notify' ? 'notify' : 'remind'); break;
      /* v4.21.0 需求 1：消息模板逐条保存 / 恢复默认（三个板块共用同一套动作） */
      case 'msg-tpl-save': await saveMsgTpl(el.dataset.key || ''); break;
      case 'msg-tpl-reset': await resetMsgTpl(el.dataset.key || ''); break;
      case 'prefs-cancel': closePrefsForm(); break;
      case 'prefs-save': await savePrefs(); break;
      case 'prefs-clear-quiet': {
        const layer = $('#modal-layer');
        if (layer) {
          const a = layer.querySelector(`input[data-pref="${el.dataset.sk}"]`);
          const b = layer.querySelector(`input[data-pref="${el.dataset.ek}"]`);
          if (a) a.value = '';
          if (b) b.value = '';
        }
        if (prefsDraft) { prefsDraft[el.dataset.sk] = ''; prefsDraft[el.dataset.ek] = ''; }
        toast('已清空，点保存后生效', 'ok');
        break;
      }
      case 'prefs-kinds-follow': {
        if (prefsDraft) prefsDraft.notify_kinds = '';
        openPrefsForm();
        break;
      }
      /* 「自己指定」：从管理员当前那份名单起步（见 openPrefsForm 里 kindsStart 的注释）。
         ★ 没有这个入口的话，「通知内容」会永远停在「跟随管理员」上 ——
         那几个勾选框只在「自己指定」状态下才渲染，用户根本点不到，
         等于「不能自定义通知内容」，与需求 7 正面冲突。 */
      case 'prefs-kinds-pick': {
        if (prefsDraft) {
          const g = state.prefsGlobal || {};
          prefsDraft.notify_kinds = String(g.notifyKinds || '').trim()
            || Object.keys(NOTIFY_KIND_CN).join(',');
        }
        openPrefsForm();
        break;
      }
      case 'notify-email': openNotifyEmailForm(); break;
      /* v4.7.0 需求 2：推送方式（邮件 / 企业微信 / 两者）。
         保存分支在下方主 switch（与 notify-email-save 放在一起），这里只开弹窗 ——
         同一个 case 写两遍会让前一处变成死代码。 */
      case 'push-channel': openPushChannelForm(); break;
      /* v4.11.0：换主题。乐观更新在 pickTheme 里，这里只负责触发。 */
      case 'theme-pick': await pickTheme(el.dataset.theme); break;
      case 'admin-settings':
        // 先拉一次设置：提醒运行状态是「上次扫描」的快照，打开时取最新的才有诊断价值
        await refreshSettings();
        openAdminSettings();
        break;
      /* v4.5.0 需求 5：企业微信接入 */
      case 'wecom-settings':
        await refreshWecom();
        openWecomForm();
        break;
      case 'wecom-save': await saveWecom(); break;
      case 'wecom-test': await testWecom(); break;
      case 'rec-open': {
        // 先看，不直接进编辑态；要点「编辑」才进表单，避免手滑改到重要信息
        const r = state.records.find((x) => x.id === id);
        if (r) openRecordView(r.id);
        break;
      }
      case 'rec-edit': {
        const r = state.records.find((x) => x.id === id);
        if (!r) break;
        closeModal();
        openRecordForm(r);
        break;
      }
      case 'rec-cat': state.recCategory = el.dataset.cat; render(); break;
      case 'rec-check-item': {
        const r = state.records.find((x) => x.id === id);
        if (!r) break;
        const lines = String(r.content || '').split('\n');
        const i = Number(el.dataset.line);
        const line = lines[i];
        if (line == null) break;
        const m = /^([☐☑]) (.*)$/.exec(line);
        if (!m) break;
        lines[i] = `${m[1] === '☑' ? '☐' : '☑'} ${m[2]}`;
        /* v4.12.0 需求：勾选完成后自动沉到「未勾选项之后」。
           清单的阅读顺序应该是「还要做的在上、做完的在下」—— 否则勾完一条它就原地卡在
           第一屏，越往后越得翻着找。做法是**只重排 checkbox 占的那些位置**，
           普通文本行一概不动（用户排好的段落顺序不能被悄悄改掉）。 */
        const slots = [];
        lines.forEach((l, k) => { if (/^[☐☑] /.test(l)) slots.push(k); });
        const boxes = slots.map((k) => lines[k]);
        const sorted = boxes.filter((l) => l.startsWith('☐ ')).concat(boxes.filter((l) => l.startsWith('☑ ')));
        slots.forEach((k, n) => { lines[k] = sorted[n]; });
        const newContent = lines.join('\n');
        try {
          const out = await api('/api/records/' + id, { method: 'PATCH', body: { content: newContent } });
          r.content = out.record.content;
          render();
          recRefreshView();      // 勾选是在查看页里点的，查看页也要跟着变
        } catch (err) { toast(err.message, 'err'); }
        break;
      }
      case 'rec-save': await saveRecord(id || null); break;
      case 'rec-delete': {
        if (!window.confirm('确定删除这条记录吗？删除后无法恢复。')) return;
        try {
          await api('/api/records/' + id, { method: 'DELETE' });
          closeModal();
          await refreshRecords();
          toast('已删除', 'ok');
        } catch (err) { toast(err.message, 'err'); }
        break;
      }

      /* 我的 */
      /* v2.0.0 家庭记账 */
      case 'bill-view': {
        // 这几个按钮挂在 .segmented 上，值在子元素的 data-view 上 → 要回溯一层
        const vb = e.target.closest('[data-view]');
        if (vb) state.billView = vb.dataset.view || state.billView;
        // v4.12.0：'cal' 已并入统计，老状态进来时按「统计 → 日历查看」处理
        if (state.billView === 'cal') { state.billView = 'stats'; state.billStatsView = 'calendar'; }
        if (state.billView === 'list') {
          /* v4.22.0 需求 3：数据已在内存里就直接渲染，不再为「切回来看看」发一次请求 */
          if (!state.billListLoaded) await refreshBillList();
        }
        if (state.billView === 'stats') {
          if (!state.billStatsLoaded) await refreshBills();
          if (state.billStatsView === 'calendar' && state.billCalLoaded !== currentBillCalKey()) {
            await refreshBillCalendar();
          }
        }
        render();
        break;
      }
      /* v4.12.0 需求 3：统计下的「筛选查看 / 日历查看」 */
      case 'bill-stats-view': {
        const b = e.target.closest('[data-view]');
        if (b) state.billStatsView = b.dataset.view === 'calendar' ? 'calendar' : 'filter';
        if (state.billStatsView === 'calendar' && state.billCalLoaded !== currentBillCalKey()) {
          await refreshBillCalendar();
        }
        render();
        break;
      }
      /* v4.15.0 需求 2：原来「设置」页签的三块折叠已搬进「我的」，
         `bill-set-toggle` 这个动作随之删除（折叠改由 meFold 统一负责）。 */
      /* v4.12.0 需求 7：从下拉里给某个分类加预算 */
      case 'bill-budget-pick':
        state.billBudgetPick = el.value || '';
        render();
        break;
      /* v4.12.0 需求 5：是否附带待办（默认勾选） */
      case 'bill-attach-todo': {
        try {
          await api('/api/bills/settings', { method: 'POST', body: { attachTodo: !!el.checked } });
          await refreshBills();
          render();
          paintBillPushForm();
          toast(el.checked ? '日报 / 月报会附带待办' : '日报 / 月报不再附带待办', 'ok');
        } catch (err) { toast(err.message, 'err'); render(); }
        break;
      }
      case 'bill-scope': {
        const b = e.target.closest('[data-scope]');
        if (b) {
          state.billScope = b.dataset.scope === 'mine' ? 'mine' : 'all';
          await refreshBillList();
          render();
        }
        break;
      }
      case 'bill-cat':
        state.billCategory = el.dataset.cat || '全部';
        await refreshBillList();
        render();
        break;
      case 'bill-q-clear':
        clearSearchInput('bill-query');
        state.billQuery = '';
        await refreshBillList();
        render();
        break;
      case 'bill-send': {
        const inp = document.querySelector('[data-act="bill-text"]');
        await billSendText(inp ? inp.value : '');
        break;
      }
      case 'bill-quick': {
        const inp = document.querySelector('[data-act="bill-text"]');
        if (inp) { inp.value = el.dataset.text || ''; inp.focus(); }
        break;
      }
      case 'bill-ocr': startBillOcr(); break;
      // v2.0.2 只记支出：弹窗里的「支出/收入」切换已随收入功能一起下线
      case 'bill-draft-cancel': state.billOcrDraft = null; state.billOcrItems = null; closeModal(); break;
      case 'bill-draft-save': await saveBillDraft(); break;
      case 'bill-ocr-items-save': await saveBillOcrItems(); break;
      /* v4.1.0 需求 1：识别结果一键存为草稿（多条弹窗整批 / 单条弹窗一条） */
      case 'bill-ocr-items-draft': saveBillOcrItemsAsDrafts(); break;
      case 'bill-draft-keep': saveOcrSingleAsDraft(); break;
      case 'bill-draft-open': openBillDraft(el.dataset.id); break;
      case 'bill-draft-del':
        removeBillDraft(el.dataset.id);
        render();
        toast('草稿已删除', 'ok');
        break;
      /* v4.9.0 需求 1：微信草稿箱的打开 / 删除 */
      case 'bill-sdraft-open': openBillSdraft(Number(el.dataset.id)); break;
      case 'bill-sdraft-del': {
        if (!window.confirm('确定删除这条微信草稿吗？删除后无法恢复。')) break;
        try {
          await api('/api/bills/drafts/' + Number(el.dataset.id), { method: 'DELETE' });
          state.billServerDrafts = state.billServerDrafts.filter((x) => x.id !== Number(el.dataset.id));
          render();
          toast('草稿已删除', 'ok');
        } catch (err) { toast(err.message || '删除失败', 'err'); }
        break;
      }
      case 'bill-edit': openBillEdit(Number(el.dataset.id)); break;
      case 'bill-del': {
        if (!window.confirm('确定删除这笔账单吗？删除后无法恢复。')) break;
        try {
          await api('/api/bills/' + Number(el.dataset.id), { method: 'DELETE' });
          await reloadBillAll();
          toast('已删除', 'ok');
        } catch (err) { toast(err.message || '删除失败', 'err'); }
        break;
      }
      case 'bill-export': openBillExport(); break;
      case 'bill-export-go': doBillExport(); break;
      case 'bill-cat-add': await addBillCategory(el.dataset.kind); break;
      case 'bill-cat-rules-save': await saveBillCatRules(); break;   // v4.17.0 需求 5
      case 'bill-cat-rules-reset': await resetBillCatRules(); break; // v4.18.0 需求 2：恢复内置默认规则
      case 'bill-cat-del': await delBillCategory(el.dataset.kind, el.dataset.cat); break;
      case 'bill-save-budgets': await saveBillBudgets(); break;
      case 'bill-save-ai': await saveBillAi(); break;
      case 'bill-clear-ai': await clearBillAi(); break;
      /* ★ v4.3.2 需求 1：疑似重复提示条上的两个动作。
         「删掉刚记的这笔」走既有的 DELETE 接口（权限/可见性校验都在服务端），
         删除后连同提示条一起收掉；「保留」只是把提示条收掉，账目一字不动。 */
      case 'bill-dup-del': {
        const id = Number(el.dataset.id);
        try {
          await api('/api/bills/' + id, { method: 'DELETE' });
          toast('已删掉刚记的那笔', 'ok');
        } catch (err) { toast(err.message || '删除失败', 'err'); }
        dropBillDupTip(id);
        await reloadBillAll();
        break;
      }
      case 'bill-dup-ignore': dropBillDupTip(Number(el.dataset.id)); render(); break;
      /* ★ v4.3.2 需求 2：「恢复默认」——把自定义提示词框还原成内置默认模板。
         两点讲究：
           · 只改 DOM 的 value、**不 render()**。render 会按「已保存的配置」重建整个
             设置视图，用户刚在别的参数行里改到一半的内容会被一起冲掉；
             还原提示词是纯界面动作，就地改掉最安全。
           · 必须写 `ta.value`。光改 HTML 属性（attribute）不会反映到用户看到的框里 ——
             `<input>`/`<textarea>` 的实时值是 property，不是 attribute。
         还原后仍需用户点「保存」才落库：这里只是把内容准备好，不替用户做决定。 */
      case 'bill-prompt-reset': {
        const ta = document.querySelector('#modal-layer [data-mk="aiPromptCustom"]')
          || document.querySelector('#main [data-mk="aiPromptCustom"]');
        if (!ta) break;
        ta.value = ta.dataset.def || '';
        toast('已恢复为默认提示词，点「保存」后生效', 'ok');
        break;
      }
      case 'bill-reports-toggle': await toggleBillSetting('reportsEnabled', '日报推送'); break;
      case 'bill-monthly-toggle': await toggleBillSetting('monthlyReport', '月报推送'); break;
      case 'bill-report-test': await testBillReport(); break;
      /* v4.16.0 需求 1：记账推送改成独立弹窗（与待办提醒 / 内容通知一致） */
      case 'bill-push-open': {
        /* v4.25.0 需求 4：成员也能进这个菜单 —— 但只能改「我这一类的推送渠道」，
           报表时间 / 月报 / 附带待办那一堆仍然只有管理员能改。 */
        if (!(state.me && state.me.is_admin)) { openBillChannelForm(); break; }
        try { await refreshBills(); } catch { /* 用现有数据也能开 */ }
        try { await refreshWecom(); } catch { /* 抄送名单读不到就留空 */ }
        openBillPushForm();
        break;
      }
      case 'bill-channel-save': await saveBillChannel(); break;
      case 'bill-report-to-save': break;   // v4.16.0 需求 2：抄送名单已下线（老 client 残留事件，忽略）
      /* v4.13.0 修复（问题 1）：账单推送设置里的「配置」按钮原来只有渲染、没有动作，
         点了完全没反应。现在跳到「我的 → 推送配置」并把它展开、滚到眼前。
         非管理员看不到推送配置，给一句明确的话，别让人以为是按钮坏了。 */
      case 'open-push-config':
      case 'push-hint-goto': await gotoPushConfig(); break;
      /* v4.17.0 需求 7：记账推送弹窗里的「去账号映射」—— 关掉本弹窗，
         打开「我的 → 推送配置」并保证企业微信区是展开的，最后把光标放到映射输入框上。 */
      case 'bill-push-goto-map': {
        const admin = state.me && state.me.is_admin;
        closeModal();
        if (!admin) { toast('推送渠道只有管理员能修改', 'err'); break; }
        state.pushOpen = Object.assign({}, state.pushOpen, { wecom: true });
        await gotoPushConfig();
        const map = document.querySelector('#main [data-mk="wc-map-inline"]');
        if (map) {
          if (typeof map.scrollIntoView === 'function') {
            try { map.scrollIntoView({ block: 'center' }); } catch { /* 老浏览器忽略 */ }
          }
          map.focus();
        }
        break;
      }
      /* ═══ v4.0.0 ═══ */
      case 'bill-quick-edit': openBillQuickEditor(); break;
      case 'bill-quick-add': await addBillQuick(); break;
      case 'bill-quick-del': await delBillQuick(el.dataset.text || ''); break;
      case 'bill-quick-reset': await saveBillQuick(DEFAULT_BILL_QUICKS); break;
      case 'bill-report-when': {
        const b = e.target.closest('[data-val]');
        if (b) await saveBillWhen(b.dataset.val === 'same_day' ? 'same_day' : 'next_day');
        break;
      }
      case 'bill-ai-toggle': await toggleAiEnabled(); break;
      /* v4.3.1 需求 6：识别参数区展开 / 收拢（交互参考「周期提醒」，默认收拢） */
      case 'bill-ai-params-toggle': state.billAiParamsOpen = !state.billAiParamsOpen; render(); break;
      /* v4.2.0 需求 3：日志面板要「展开 + 收起」两个按钮（旧名 bill-ai-logs 保留兼容） */
      case 'bill-ai-logs':
      case 'bill-ai-logs-open': await loadAiLogs(); break;
      case 'bill-ai-logs-close': closeAiLogs(); break;
      case 'bill-range-apply': await refreshBills(); render(); break;
      /* v4.15.0 需求 5：「本月」按钮已去掉（默认范围就是本月 1 号到今天，
         想回到本月清空日期即可）—— bill-range-month 这个动作随之下线。 */
      case 'bill-range-clear':
        state.billStatFrom = ''; state.billStatTo = '';
        await refreshBills(); render();
        break;

      case 'backup-download': {
        try {
          /* v4.20.0（审查 C-1）：导出是**管理员职能**，非管理员会拿到 403。
             这里把服务端那句人话原样透出来，而不是笼统的「导出失败」——
             否则家人点一下只会看到「导出失败」，无从知道该找谁。 */
          const res = await fetch(API_BASE + '/api/backup', { credentials: 'same-origin' });
          if (!res.ok) {
            let msg = '导出失败';
            try {
              const d = await res.json();
              if (d && d.error) msg = d.error;
            } catch { /* 响应不是 JSON 就沿用默认文案 */ }
            throw new Error(msg);
          }
          const blob = await res.blob();
          const cd = res.headers.get('Content-Disposition') || '';
          const m = /filename="([^"]+)"/.exec(cd);
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = m ? m[1] : 'family-hub-backup.json';
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 4000);
          toast('备份已开始下载', 'ok');
        } catch (err) { toast(err.message, 'err'); }
        break;
      }
      case 'backup-restore': $('#restore-file').click(); break;
      case 'me-logout': {
        if (!window.confirm('确定退出登录吗？')) return;
        try { await api('/api/logout', { method: 'POST' }); } catch { /* 忽略 */ }
        handleLogoutLocally();
        toast('已退出登录', 'ok');
        break;
      }
      case 'me-rename': openRenameForm(); break;
      case 'me-password': openPasswordForm(); break;
      case 'me-username': openUsernameForm(); break;
      case 'member-reset': openResetForm(id, el.dataset.name); break;
      /* v4.28.0：点成员头像 → 查看他的全部可配置参数（仅管理员可见的入口） */
      case 'member-info': await openMemberInfo(id); break;
      /* v4.10.0：删除成员（管理员）。★ 二次确认是需求原文：
         弹确认框写清「删的是谁、数据会一并删除、不可恢复」，确认后才发请求。 */
      case 'member-del': {
        const name = el.dataset.name || '该成员';
        if (!window.confirm(
          `确定删除成员「${name}」吗？\n\n`
          + '该成员发布的待办、动态、评论、记录与账单等全部数据会一并删除，\n'
          + '删除后无法恢复。请确认这是你想要做的操作。',
        )) break;
        try {
          await api('/api/members/' + Number(el.dataset.id), { method: 'DELETE' });
          await refreshMembers();
          render();
          toast(`已删除成员「${name}」`, 'ok');
        } catch (err) { toast(err.message || '删除失败', 'err'); }
        break;
      }
      case 'member-lock': openMemberLockForm(id, el.dataset.name, el.dataset.lock === '1'); break;
      case 'modal-close': closeModal(); break;
      default: break;
    }
  });

  /* 分段控件的选中态 */
  document.addEventListener('click', (e) => {
    const seg = e.target.closest('.segmented[data-act]');
    if (!seg) return;
    const btn = e.target.closest('button');
    if (!btn) return;
    const act = seg.dataset.act;
    $$('button', seg).forEach((b) => b.classList.toggle('on', b === btn));
    const layer = $('#modal-layer');
    if (act === 'prio-pick' && layer) layer.dataset.priority = btn.dataset.prio;
    if (act === 'vis-pick' && layer) {
      /* v4.28.2：可见范围切换。成员面板跟着显隐；参与人里的不可见成员立刻置灰。
         ★ 不在这里清空已勾的成员：从「指定」切回「全家」再切回来时，
           用户刚才勾的人应该还在（切到全家时服务端会忽略 visibleTo）。 */
      layer.dataset.visibility = btn.dataset.vis === 'private' ? 'private' : 'family';
      const box = layer.querySelector('[data-vis-box]');
      if (box) box.classList.toggle('hidden', layer.dataset.visibility !== 'private');
      syncPartChips(layer);
    }
    /* v4.12.0：「重复」已从按钮组改成弹窗内自己的 <select>，
       它的选中态与副作用（隐藏「标为已完成」）都搬去了 openTodoForm 的 change 监听里，
       这里不再有 repeat-pick 分支。 */
    // v1.9.0：动态页「动态流 / 按日历看」切换（不在弹窗里，所以不依赖 layer）
    if (act === 'post-view' && btn.dataset.view) {
      state.postView = btn.dataset.view;
      if (state.postView === 'calendar' && !state.postCalDay) state.postCalDay = todayKey();
      render();
    }
    // v4.9.0 需求 3：日历页签「待办列表 / 日历」切换 —— 交互与 post-view 完全一致
    if (act === 'todo-view' && btn.dataset.view) {
      state.todoView = btn.dataset.view === 'calendar' ? 'calendar' : 'list';
      render();
    }
    // v1.9.0：记录本「当前记录 / 已归档」切换 —— 两个列表是两次不同的请求，必须重新拉
    if (act === 'rec-arch-view') {
      const to = btn.dataset.arch === '1';
      if (to !== state.recShowArchived) {
        state.recShowArchived = to;
        state.recCategory = '全部';
        refreshRecords().catch((err) => toast(err.message, 'err'));
      }
    }
    if (act === 'lock-mode-pick' && layer) {
      layer.dataset.mode = btn.dataset.mode;
      const isCustom = btn.dataset.mode === 'custom';
      const changing = layer.dataset.changing === '1';
      const hint = layer.querySelector('#lock-mode-hint span');
      if (hint) {
        // 只有「首次开启」时那个唯一输入框才兼作新密码，文案得跟着变
        hint.textContent = isCustom ? '设置访问密码（至少 4 位）' : '输入登录密码以确认开启';
      }
      // 「改密码」时选自定义才展开「新访问密码」；改回复用登录密码就把它收起来
      const newPw = layer.querySelector('#lock-new-pw');
      if (newPw) newPw.classList.toggle('hidden', !(changing && isCustom));
    }
    if (act === 'set-register-pick' && layer) layer.dataset.allowRegister = btn.dataset.reg;
    /* v4.12.0：家庭设置弹窗只剩「基础配置」，set-remind-pick / set-notify-pick 两种分段控件
       随「待办提醒 / 内容通知」一起搬去了「我的 → 消息提醒」，那里用的是 <select>，不需要这里处理。 */
    if (act === 'todo-filter') { state.todoFilter = btn.dataset.filter; state.todoShown = state.todoPageSize; render(); }
  });

  /* 输入框：搜索用即时过滤，评论 Enter 发送 */
  document.addEventListener('input', (e) => {
    const t = e.target;
    /* v4.13.0（问题 4）：带 data-autogrow 的多行输入框随内容长高。
       ★ 必须写在下面那个 data-mk 的 early-return 之前 ——
         记录本弹窗里的内容框带的是 data-mk，走不到后面的主体逻辑。 */
    if (t && t.tagName === 'TEXTAREA' && t.dataset && t.dataset.autogrow !== undefined) autoGrow(t);
    // 设置弹窗里的控件带的是 data-mk 而不是 data-act。提前天数 / 默认提醒时间一改，
    // 示例文案就跟着变，管理员不必先保存就能确认「到底哪一天会发出提醒」。
    if (t && t.dataset && t.dataset.mk && t.closest && t.closest('#modal-layer')) {
      // 待办表单的开始/结束时间一改，就重算结束时间与示例文案
      if (t.dataset.mk === 'startTime' || t.dataset.mk === 'endTime') {
        const layer = $('#modal-layer');
        if (layer) syncTimeUI(layer);
      }
      /* v4.3.3 需求 6：记录本「新建」弹窗里的标题 / 内容，
         每次输入都排一次自动存草稿（debounce 0.8 秒，不会真的频繁写 localStorage）。
         ★ 必须写在这个 early-return 之前 —— 弹窗里的输入框带的是 data-mk 而不是
         data-act，下面的主体逻辑根本走不到这里（首跑就是因为这个没存上）。 */
      if (recordDraftActive() && (t.dataset.mk === 'title' || t.dataset.mk === 'content')) {
        scheduleRecordDraft();
      }
      return;
    }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    /* v4.17.0 需求 3：编辑页图片备注 —— 输入即写回 dataset.images，
       绝不触发 render（整页重绘会重建编辑区、丢掉输入光标）。
       老数据是纯字符串路径，第一次写备注时升级成 {src, note}。 */
    if (act === 'rec-img-note') {
      const layer = $('#modal-layer');
      if (!layer) return;
      let imgs = [];
      try { imgs = JSON.parse(layer.dataset.images || '[]'); } catch { /* 忽略 */ }
      const i = Number(el.dataset.i);
      if (imgs[i] != null) {
        const src = recImgSrc(imgs[i]);
        imgs[i] = { src, note: String(el.value || '').trim().slice(0, 60) };
        layer.dataset.images = JSON.stringify(imgs);
        scheduleRecordDraft();
      }
      return;
    }
    if (act === 'todo-query') {
      syncSearchBar(el);
      state.todoQuery = el.value;
      state.todoShown = state.todoPageSize;
      // 搜索时自动展开「周期提醒」：搜到了却还藏在收起状态里，比不能搜更让人困惑
      state.repeatOpen = !!el.value.trim();
      render();
    }
    if (act === 'rec-query') { syncSearchBar(el); state.recQuery = el.value; render(); }
    /* v2.0.0 记账：搜索框 / 统计日期月份。日期与月份用的是 change 事件，
       这里只处理搜索框（边打边筛）。 */
    if (act === 'bill-query') { syncSearchBar(el); state.billQuery = el.value; billQueryDebounced(); }
    /* v2.0.0 需求 4：发帖草稿落到 state 里。
       以前草稿只活在 DOM 的 data-preserve 里，一旦「发帖」面板收起（DOM 里没有这个
       textarea 了），敲了一半的字就没了。写进 state 之后，收起 / 展开 / 切页签
       都不会丢，而且重新展开时是从 state 回填的。 */
    /* v4.3.3 需求 6：这里只改 state 不 render（重绘会打断输入），
       顺带排一次 0.8 秒的自动存草稿 —— 页面被突然刷掉时也不会丢。 */
    if (act === 'compose-text') { state.compose.text = el.value; schedulePostDraft(); }
    if (act === 'compose-tags') { state.compose.tags = el.value; schedulePostDraft(); }
    if (act === 'post-query') {
      syncSearchBar(el);
      state.postQuery = el.value;
      render();
      // 重新渲染后光标会丢，把焦点与光标还给搜索框，否则连打第二个字就断了
      const box = document.querySelector('[data-act="post-query"]');
      if (box && document.activeElement !== box) {
        box.focus();
        try { box.setSelectionRange(box.value.length, box.value.length); } catch { /* 忽略 */ }
      }
    }
    /* v4.3.3 需求 6：记录本「新建」弹窗里的标题 / 内容 / 自定义分类，
       每次输入都排一次自动存草稿（debounce 0.8 秒，不会真的频繁写 localStorage）。 */
    if (recordDraftActive()) {
      const mk = el.dataset && el.dataset.mk;
      if (mk === 'title' || mk === 'content' || el.id === 'rec-cat-input') scheduleRecordDraft();
    }
  });

  /* 每页条数设置 / 待办时长选择 / 记账统计维度 */
  document.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.dataset && el.dataset.act === 'todo-page-size') {
      const n = Number(el.value);
      if (PAGE_SIZES.includes(n)) {
        state.todoPageSize = n;
        state.todoShown = n;
        try { localStorage.setItem('fh-todo-page-size', String(n)); } catch { /* 忽略 */ }
        render();
      }
      return;
    }
    // 时长：写进 modal 的 dataset（保存时据此算结束时间）
    if (el.dataset && el.dataset.mk === 'duration') {
      const layer = $('#modal-layer');
      if (!layer) return;
      layer.dataset.duration = el.value;
      // 主动选「不限时长」= 明确不要结束时间，这时才清空
      if (el.value === '0') {
        const end = layer.querySelector('[data-mk="endTime"]');
        if (end) end.value = '';
      }
      syncTimeUI(layer);
      return;
    }
    /* v2.0.0 记账：统计卡上的日期 / 月份。
       这两个是「按日期/按月」两个视图各自的选择，改动要重新统计一次（服务端算的，
       前端算不出「家庭成员各人」的口径），所以走 refreshBills 而不是本地重算。 */
    if (el.dataset && el.dataset.act === 'bill-date') {
      const v = String(el.value || '');
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { state.billDate = v; await refreshBills(); render(); }
      return;
    }
    if (el.dataset && el.dataset.act === 'bill-month') {
      const v = String(el.value || '');
      if (/^\d{4}-\d{2}$/.test(v)) { state.billMonth = v; await refreshBills(); render(); }
      return;
    }
    /* v4.0.0 需求 4：日期范围筛选。选完只记下值（改两次日期只发一次请求），
       点「按范围筛选」才真正刷新统计；「清除筛选」恢复整月口径。 */
    if (el.dataset && el.dataset.act === 'bill-stat-from') {
      const v = String(el.value || '');
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { state.billStatFrom = v; render(); }
      return;
    }
    if (el.dataset && el.dataset.act === 'bill-stat-to') {
      const v = String(el.value || '');
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { state.billStatTo = v; render(); }
      return;
    }
    // v4.0.0 需求 7：AI 月度额度上限，改完即时落库，失败还原
    if (el.dataset && el.dataset.act === 'bill-ai-limit') {
      await saveAiLimit(el.value, el);
      return;
    }
    // 管理员改推送时间：改完即时落库（不必再点保存），失败要把输入框还原成旧值
    if (el.dataset && el.dataset.act === 'bill-daily-time') {
      const old = (state.billMeta && state.billMeta.reports && state.billMeta.reports.dailyTime) || '21:00';
      const okTime = await saveBillDailyTime(el.value);
      if (!okTime) el.value = old;
      return;
    }
    /* v4.3.1 需求 3：OCR 多条确认里勾选/取消某一条 —— **原地更新**，不重挂弹窗。
       旧实现是「收一遍值 → renderBillOcrItemsModal()」，而 openModal 会先 closeModal
       再新建整个弹窗：弹窗重挂 + 滚动位置回到顶部 + 入场动画重放 —— 用户看到的就是
       「每点一下页面抖一下」。现在只改这一行与底部按钮，输入框的值本来就在 DOM 里，
       保存时 collectOcrItems 照旧收一遍，全程无需刷新即可生效。 */
    if (el.dataset && /^oi-on-/.test(String(el.dataset.mk || ''))) {
      const d = state.billOcrItems;
      if (d) {
        const i = Number(String(el.dataset.mk).slice('oi-on-'.length));
        const row = d.rows[i];
        if (row) row.on = !!el.checked;
        const item = el.closest('.ocr-item');
        if (item) item.classList.toggle('off', !el.checked);
        syncOcrItemsFoot();
      }
      return;
    }
    // 预算输入框不在这里提交：一张卡里十来个输入框，逐字保存会打出一串请求，
    // 由「添加分类」下方的「保存预算」一次性提交（见 saveBillBudgets）。
  });

  /* v2.0.2（需求②）：点「发送 / 快捷例句」不许把输入框的焦点抢走 ——
     手机上焦点一离开输入框，系统键盘就会收起；键盘一收一放又把布局顶一下，
     连续录入时界面就上下跳。mousedown 阶段 preventDefault 是标准做法：
     只阻止「抢焦点」，click 事件照常触发，不影响发送。 */
  document.addEventListener('mousedown', (e) => {
    if (!e.target || !e.target.closest) return;
    if (e.target.closest('[data-act="bill-send"],[data-act="bill-quick"]')) e.preventDefault();
  });

  /* v4.0.0 需求③：键盘弹出时输入框要及时「跟着上移」。
     根因：手机上键盘弹出是带动画的（约 250–300ms），布局视口收缩完成后浏览器
     不一定把焦点元素滚进可视区（尤其 sticky 输入行 + 页面本身已在底部的场景）。
     修法：聚焦记账输入框后等键盘动画结束，再把输入框 scrollIntoView 到屏幕中部，
     同时把聊天流滚到底 —— 输入框永远悬在键盘上沿，不被遮挡。 */
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (!el || !el.dataset || el.dataset.act !== 'bill-text') return;
    setTimeout(() => {
      if (!el.isConnected) return;          // 等待期间界面可能重绘，节点已换新就别动旧节点
      // 老浏览器 / jsdom 没有 scrollIntoView：没有就只滚聊天流，不要抛异常
      if (typeof el.scrollIntoView === 'function') {
        try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
        catch { el.scrollIntoView(); }
      }
      const box = document.querySelector('#bill-chat');
      if (box) box.scrollTop = box.scrollHeight;
    }, 300);
  });

  document.addEventListener('keydown', (e) => {
    // 灯箱开着时：← → 切换上/下一张（多图才生效）
    const lbEl = $('#lightbox');
    if (lbEl && lbEl.classList.contains('show')) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); lbStep(-1); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); lbStep(1); return; }
    }
    // Esc 关闭图片灯箱
    if (e.key === 'Escape') { closeLightbox(); return; }
    // 记录本内容区：当前行带勾选框时，回车后下一行自动生成勾选框
    if (e.target && e.target.dataset && e.target.dataset.mk === 'content' && e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      const ta = e.target;
      const pos = ta.selectionStart;
      const before = ta.value.slice(0, pos);
      const lineStart = before.lastIndexOf('\n') + 1;
      const curLine = before.slice(lineStart);
      if (/^[☐☑] /.test(curLine)) {
        e.preventDefault();
        if (/^[☐☑] ?$/.test(curLine)) {
          // 当前行只有勾选框没内容 → 删掉前缀，退出勾选列表
          ta.value = before.slice(0, lineStart) + ta.value.slice(pos);
          ta.setSelectionRange(lineStart, lineStart);
        } else {
          const ins = '\n☐ ';
          ta.value = before + ins + ta.value.slice(pos);
          const newPos = pos + ins.length;
          ta.setSelectionRange(newPos, newPos);
        }
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
    }
    // 解锁输入框回车 = 解锁
    if (e.target && e.target.id === 'lock-pass' && e.key === 'Enter') {
      e.preventDefault();
      unlockRecords();
      return;
    }
    // 快捷添加待办：回车 = 添加
    if (e.target && e.target.dataset && e.target.dataset.act === 'todo-quick-input' && e.key === 'Enter') {
      e.preventDefault();
      quickAddTodo();
      return;
    }
    // v2.0.0 记账：输入框里回车 = 发送（聊天式记账最自然的操作就是回一下）
    if (e.target && e.target.dataset && e.target.dataset.act === 'bill-text' && e.key === 'Enter') {
      e.preventDefault();
      billSendText(e.target.value);
      return;
    }
    const el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) return;
    if (e.key === 'Enter' && el.dataset.act === 'comment-input') {
      e.preventDefault();
      sendComment(Number(el.dataset.id));
    }
    if (e.key === 'Enter' && el.dataset.act === 'compose-text' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      publishPost();
    }
  });

  /* ═══ v2.0.0：个人通知设置弹窗里的「三态开关」与「通知内容」勾选 ═══
     这两类控件故意不带 data-act —— 它们只在弹窗里存在，而且每点一下就整体重绘弹窗，
     混进主点击分发器会把 60 多个 case 的语义搅乱。 */

  document.addEventListener('click', (e) => {
    const seg = e.target.closest ? e.target.closest('#modal-layer .prefs-tri [data-val]') : null;
    if (!seg) return;
    const wrap = seg.closest('[data-pref]');
    if (!wrap || !prefsDraft) return;
    // ★ 先把刚敲进去的免打扰时间收进草稿再重绘：重绘是用草稿出模板的，
    //   不收的话「填了时间 → 顺手点一下开关」会把刚填的时间吞掉。
    collectPrefsTimes();
    prefsDraft[wrap.dataset.pref] = seg.dataset.val;
    /* 「内容通知」选「开启」= 我要收 → 顺手把「通知内容」从「跟随」推进到「自己指定」，
       否则勾选框不渲染，用户会以为「开了却选不了类型」。 */
    if (wrap.dataset.pref === 'notify_on_change' && seg.dataset.val === '1' && !prefsDraft.notify_kinds) {
      const g = state.prefsGlobal || {};
      prefsDraft.notify_kinds = String(g.notifyKinds || '').trim() || Object.keys(NOTIFY_KIND_CN).join(',');
    }
    openPrefsForm();
  });

  document.addEventListener('change', (e) => {
    const box = e.target;
    if (!box || !box.dataset || box.dataset.pref !== 'kind' || !prefsDraft) return;
    const layer = $('#modal-layer');
    if (!layer) return;
    // 一旦手动勾选过，「跟随管理员」就自动变成「自己指定」——
    // 把当前勾选结果整份存下来（含「一个都不勾 = 明确不要」这种情形）
    const picked = $$('#modal-layer input[data-pref="kind"]').filter((x) => x.checked).map((x) => x.value);
    prefsDraft.notify_kinds = picked.length ? picked.join(',') : 'none';
  });

  /* v4.25.0 需求 4：管理员弹窗里「我自己这一类走哪条通道」的下拉，改完即时落库（个人偏好） */
  document.addEventListener('change', async (e) => {
    const el = e.target;
    if (!el || !el.dataset || el.dataset.act !== 'my-channel') return;
    const key = el.dataset.kind === 'notify' ? 'channel_notify' : 'channel_todo';
    const body = {};
    body[key] = String(el.value || '');
    try {
      const out = await api('/api/prefs', { method: 'POST', body });
      state.prefs = out.prefs || state.prefs;
      toast(el.value ? `已改为「${PUSH_LABEL[el.value]}」` : '已改为跟随推送方式', 'ok');
    } catch (err) { toast(err.message || '保存失败', 'err'); }
  });

  /* v4.25.0 需求 4：管理员「记账推送」弹窗里的渠道下拉即时生效。
     那个弹窗里的开关本来就是「点一下就落库」，没有底部保存按钮 —— 这一项跟着同样的节奏。 */
  document.addEventListener('change', async (e) => {
    const el = e.target;
    if (!el || !el.dataset || el.dataset.act !== 'bill-channel') return;
    const layer = $('#modal-layer');
    if (!layer || layer.dataset.modalKind !== 'bill-push') return;
    const val = String(el.value || '');
    try {
      const out = await api('/api/prefs', { method: 'POST', body: { channel_bill: val } });
      state.prefs = out.prefs || state.prefs;
      toast(val ? `记账推送已改为「${PUSH_LABEL[val]}」` : '记账推送已改为跟随推送方式', 'ok');
    } catch (err) { toast(err.message || '保存失败', 'err'); }
  });

  /* 文件选择 */
  document.addEventListener('change', async (e) => {
    const el = e.target;

    /** 统一的收尾提示：成功几张、失败哪张、为什么 —— 不再一句笼统的「上传失败」。
        全部成功时不弹 toast：进度条自己会显示「完成」，再弹一个是重复噪音。 */
    const report = (r, unit) => {
      if (!r.errors.length) return;
      const head = r.ok ? `${r.ok} ${unit}成功，${r.errors.length} 个失败：` : '上传失败：';
      toast(head + r.errors[0], 'err');
      if (r.errors.length > 1) r.errors.slice(1).forEach((m) => toast(m, 'err'));
    };

    /* v4.3.0 需求 1：模型 ID 改成一个可自由输入的文本框（带 datalist 预设），
       不再有「自定义模型 ID…」下拉项 —— 旧的 prompt 分支与自定义框分支一并移除。 */

    if (el.id === 'compose-file') {
      const files = Array.prototype.slice.call(el.files || []);
      el.value = '';
      if (!files.length) return;
      if (state.compose.images.length + files.length > 9) { toast('最多 9 张图片', 'err'); return; }
      state.composeOpen = true;
      const p = progressPanel(`正在处理 ${files.length} 张图片…`);
      const r = await uploadImages(files, (path) => state.compose.images.push({ path }), (v) => p.set(v));
      if (r.errors.length) p.fail(`${r.ok}/${files.length} 张成功`); else p.done('图片上传完成');
      if (state.tab === 'moments') render();
      report(r, '张图片');
    }

    /* v1.9.0：视频不做压缩，原样上传（浏览器端压缩视频不现实，也让画质白丢）。
       上传前先在本地判大小，省得把几十 MB 传上去再被服务端拒回来。
       v2.0.0：视频是唯一「大到能看出等待」的一类，进度条在这里最有价值。 */
    if (el.id === 'compose-video-file') {
      const files = Array.prototype.slice.call(el.files || []);
      el.value = '';
      if (!files.length) return;
      if (state.compose.videos.length + files.length > postVideoMax()) {
        toast(`一条动态最多 ${postVideoMax()} 段视频`, 'err');
        return;
      }
      state.composeOpen = true;
      const p = progressPanel(`正在上传 ${files.length} 段视频…`);
      let ok = 0; const errors = []; const total = files.length;
      for (let i = 0; i < total; i++) {
        const f = files[i];
        if (!looksLikeVideo(f)) { errors.push(`「${f.name || '未命名'}」不是视频，已跳过`); p.set((i + 1) / total); continue; }
        try {
          const up = await uploadVideo(f, (v) => p.set((i + v) / total));
          state.compose.videos.push({ path: up.path, cover: up.cover || '' });
          ok++;
        } catch (err) { errors.push(err && err.message ? err.message : `「${f.name}」上传失败`); }
        p.set((i + 1) / total);
      }
      if (errors.length) p.fail(`${ok}/${total} 段成功`); else p.done('视频上传完成');
      if (state.tab === 'moments') render();
      report({ ok, errors }, '段视频');
    }

    if (el.id === 'post-video-file') {
      const files = Array.prototype.slice.call(el.files || []);
      el.value = '';
      if (!files.length) return;
      const layer = $('#modal-layer');
      if (!layer) return;
      let vids = [];
      let covers = {};
      try { vids = JSON.parse(layer.dataset.videos || '[]'); } catch { /* 忽略 */ }
      try { covers = JSON.parse(layer.dataset.videoCovers || '{}'); } catch { /* 忽略 */ }
      if (vids.length + files.length > postVideoMax()) { toast(`最多 ${postVideoMax()} 段视频`, 'err'); return; }
      const p = progressPanel(`正在上传 ${files.length} 段视频…`);
      let ok = 0; const errors = []; const total = files.length;
      for (let i = 0; i < total; i++) {
        const f = files[i];
        if (!looksLikeVideo(f)) { errors.push(`「${f.name || '未命名'}」不是视频，已跳过`); p.set((i + 1) / total); continue; }
        try {
          // v4.6.0：封面跟着视频一起收下；编辑已有动态时也要能把新视频的封面写进去
          const up = await uploadVideo(f, (v) => p.set((i + v) / total));
          vids.push(up.path);
          if (up.cover) covers[up.path] = up.cover;
          ok++;
        } catch (err) { errors.push(err && err.message ? err.message : `「${f.name}」上传失败`); }
        p.set((i + 1) / total);
      }
      layer.dataset.videos = JSON.stringify(vids);
      layer.dataset.videoCovers = JSON.stringify(covers);
      renderPostVideos(vids, covers);
      if (errors.length) p.fail(`${ok}/${total} 段成功`); else p.done('视频上传完成');
      report({ ok, errors }, '段视频');
    }

    if (el.id === 'contrib-file') {
      const files = Array.prototype.slice.call(el.files || []);
      el.value = '';
      if (!files.length) return;
      const layer = $('#modal-layer');
      if (!layer) return;
      let imgs = [];
      try { imgs = JSON.parse(layer.dataset.images || '[]'); } catch { /* 忽略 */ }
      if (imgs.length + files.length > 9) { toast('最多 9 张图片', 'err'); return; }
      const p = progressPanel(`正在处理 ${files.length} 张图片…`);
      const r = await uploadImages(files, (path) => imgs.push(path), (v) => p.set(v));
      layer.dataset.images = JSON.stringify(imgs);
      const box = document.querySelector('#contrib-imgs');
      if (box) box.innerHTML = postThumbHtml(imgs, 'contrib-img-del');
      if (r.errors.length) p.fail(`${r.ok}/${files.length} 张成功`); else p.done('图片上传完成');
      report(r, '张图片');
    }

    if (el.id === 'contrib-video-file') {
      const files = Array.prototype.slice.call(el.files || []);
      el.value = '';
      if (!files.length) return;
      const layer = $('#modal-layer');
      if (!layer) return;
      let vids = [];
      let covers = {};
      try { vids = JSON.parse(layer.dataset.videos || '[]'); } catch { /* 忽略 */ }
      try { covers = JSON.parse(layer.dataset.videoCovers || '{}'); } catch { /* 忽略 */ }
      if (vids.length + files.length > postVideoMax()) { toast(`最多 ${postVideoMax()} 段视频`, 'err'); return; }
      const p = progressPanel(`正在上传 ${files.length} 段视频…`);
      let ok = 0; const errors = []; const total = files.length;
      for (let i = 0; i < total; i++) {
        const f = files[i];
        if (!looksLikeVideo(f)) { errors.push(`「${f.name || '未命名'}」不是视频，已跳过`); p.set((i + 1) / total); continue; }
        try {
          // v4.3.3：uploadVideo 返回 { path, cover }；v4.6.0 起封面也存进共创（移动端要 poster）
          const up = await uploadVideo(f, (v) => p.set((i + v) / total));
          vids.push(up.path);
          if (up.cover) covers[up.path] = up.cover;
          ok++;
        } catch (err) { errors.push(err && err.message ? err.message : `「${f.name}」上传失败`); }
        p.set((i + 1) / total);
      }
      layer.dataset.videos = JSON.stringify(vids);
      layer.dataset.videoCovers = JSON.stringify(covers);
      const box = document.querySelector('#contrib-videos');
      if (box) box.innerHTML = videoChipHtml(vids, 'contrib-video-del', '', covers);
      if (errors.length) p.fail(`${ok}/${total} 段成功`); else p.done('视频上传完成');
      report({ ok, errors }, '段视频');
    }

    if (el.id === 'post-file') {
      const files = Array.prototype.slice.call(el.files || []);
      el.value = '';
      if (!files.length) return;
      const layer = $('#modal-layer');
      if (!layer) return;
      let imgs = [];
      try { imgs = JSON.parse(layer.dataset.images || '[]'); } catch { /* 忽略 */ }
      if (imgs.length + files.length > 9) { toast('最多 9 张图片', 'err'); return; }
      const p = progressPanel(`正在处理 ${files.length} 张图片…`);
      const r = await uploadImages(files, (path) => imgs.push(path), (v) => p.set(v));
      layer.dataset.images = JSON.stringify(imgs);
      renderPostThumbs(imgs);
      if (r.errors.length) p.fail(`${r.ok}/${files.length} 张成功`); else p.done('图片上传完成');
      report(r, '张图片');
    }

    if (el.id === 'rec-file') {
      const files = Array.prototype.slice.call(el.files || []);
      el.value = '';
      if (!files.length) return;
      const layer = $('#modal-layer');
      if (!layer) return;
      let imgs = [];
      try { imgs = JSON.parse(layer.dataset.images || '[]'); } catch { /* 忽略 */ }
      if (imgs.length + files.length > 9) { toast('最多 9 张图片', 'err'); return; }
      const p = progressPanel(`正在处理 ${files.length} 张图片…`);
      /* v4.17.0 需求 3：记录本图片统一存 {src, note}（备注可空）——
         落库 / 草稿 / 展示三条链路形态一致。动态（contrib/post）两处保持字符串。 */
      const r = await uploadImages(files, (path) => imgs.push({ src: path, note: '' }), (v) => p.set(v));
      layer.dataset.images = JSON.stringify(imgs);
      renderRecordThumbs(imgs);
      scheduleRecordDraft();   // v4.3.3 需求 6
      if (r.errors.length) p.fail(`${r.ok}/${files.length} 张成功`); else p.done('图片上传完成');
      report(r, '张图片');
    }

    /* 记录本正文插图（v4.16.0 需求 4）：图片文件走 /api/upload 落在服务器磁盘
       （与动态图片同一套存储与校验），正文里只写 `![图](路径)` 这一个引用 ——
       数据库里的 content 始终是纯文本，绝不存图片字节。 */
    if (el.id === 'rec-inline-file') {
      const file = (el.files || [])[0];
      el.value = '';
      if (!file) return;
      const layer = $('#modal-layer');
      const ed = layer && layer.querySelector('#rec-editor');
      if (!ed) return;
      const p = progressPanel('正在上传图片…');
      try {
        const src = String(await uploadImage(file, (v) => p.set(v)) || '');
        if (!/^\/api\//.test(src)) throw new Error('上传返回的图片地址不合法');
        const img = document.createElement('img');
        img.className = 'rec-img';
        img.src = src;
        img.alt = '图片';
        ed.focus();
        const sel = window.getSelection && window.getSelection();
        let placed = false;
        if (sel && sel.rangeCount) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          range.insertNode(img);
          range.setStartAfter(img);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
          placed = true;
        }
        if (!placed) ed.appendChild(img);
        p.done('图片已插入正文');
        recSyncContent();
        scheduleRecordDraft();
      } catch (err) {
        p.fail('图片上传失败');
        toast(err && err.message ? err.message : '图片上传失败', 'err');
      }
      return;
    }

    // 记录本附件（PDF / Office / 压缩包…）
    if (el.id === 'rec-att-file') {
      const files = Array.prototype.slice.call(el.files || []);
      el.value = '';
      if (!files.length) return;
      const layer = $('#modal-layer');
      if (!layer) return;
      let atts = [];
      try { atts = JSON.parse(layer.dataset.attachments || '[]'); } catch { /* 忽略 */ }
      if (atts.length + files.length > 10) { toast('最多 10 个附件', 'err'); return; }
      const errors = [];
      let ok = 0;
      const total = files.length;
      const p = progressPanel(`正在上传 ${total} 个附件…`);
      for (let i = 0; i < total; i++) {
        try { atts.push(await uploadAttachment(files[i], (v) => p.set((i + v) / total))); ok++; }
        catch (err) { errors.push(err && err.message ? err.message : `「${files[i].name}」上传失败`); }
        p.set((i + 1) / total);
      }
      layer.dataset.attachments = JSON.stringify(atts);
      renderRecordAtts(atts);
      scheduleRecordDraft();   // v4.3.3 需求 6
      if (errors.length) p.fail(`${ok}/${total} 个成功`); else p.done('附件上传完成');
      if (!errors.length) toast(`已添加 ${ok} 个附件`, 'ok');
      else {
        toast((ok ? `${ok} 个成功，${errors.length} 个失败：` : '上传失败：') + errors[0], 'err');
        errors.slice(1).forEach((m) => toast(m, 'err'));
      }
    }

    /* v2.0.0：账单截图识别。识别完**只是打开确认弹窗**，入库要用户点「确认记账」。
       v4.3.1 需求 4：① 识别期间按钮变 ⏳ 且禁用，重复提交直接拦掉（连点会各发一次请求，
       耗时与费用都翻倍）；② 进度条带实时秒数与阶段文案 —— 模型侧 5~15s 很正常，
       没有反馈的等待最容易被当成卡死。 */
    if (el.id === 'bill-ocr-file') {
      const file = (el.files || [])[0];
      el.value = '';
      if (!file) return;
      if (!looksLikeImage(file)) { toast('请选择一张账单截图', 'err'); return; }
      if (state.billOcrBusy) { toast('上一张还在识别中，请稍等', 'err'); return; }
      state.billOcrBusy = true;
      render();
      const p = progressPanel('正在压缩图片…', { tick: true });
      try {
        const raw = await readAsDataUrl(file);
        const dataUrl = await prepareOcrImage(file, raw);
        p.label('正在识别截图…');
        const startedAt = Date.now();
        const out = await api('/api/bills/ocr', { method: 'POST', body: { dataUrl } });
        /* v4.25.0 需求 1：把耗时如实显示出来（服务端已经算好 modelMs / totalMs）。
           为什么要显示：识别慢的时候，用户第一反应是「是不是坏了」；
           给出秒数 + 「模型 X 秒」就能分清是模型慢还是网络慢，也知道换模型有没有用。 */
        const secs = ((out.timings && out.timings.totalMs) || (Date.now() - startedAt)) / 1000;
        const secsText = secs >= 1 ? `${secs.toFixed(1)} 秒` : '不到 1 秒';
        p.done(out.cached
          ? `识别完成 · 同一张图刚识别过，直接复用（${secsText}）`
          : `识别完成 · ${secsText}${out.timings && out.timings.modelMs
            ? `（模型 ${(out.timings.modelMs / 1000).toFixed(1)} 秒）` : ''}`);
        appendBillChat(out.chat);   // v4.0.0：额度预警气泡随响应带回，存本地缓存
        if (out.notice) toast(out.notice);
        openBillOcrConfirm(out);
        // 额度用掉了 1 次，界面上的计数要立刻跟着变
        await refreshBills();
      } catch (err) {
        p.fail(err.message || '识别失败');
        toast(err.message || '识别失败', 'err');
        await refreshBills();
      } finally {
        state.billOcrBusy = false;
        render();
      }
    }

    if (el.id === 'avatar-file') {
      const file = (el.files || [])[0];
      el.value = '';
      if (!file) return;
      const p = progressPanel('正在上传头像…');
      try { await uploadAvatar(file, (v) => p.set(v)); p.done('头像上传完成'); }
      catch (err) { p.fail(err.message || '头像上传失败'); toast(err.message || '头像上传失败', 'err'); }
    }

    if (el.id === 'restore-file') {
      const file = (el.files || [])[0];
      el.value = '';
      if (!file) return;
      if (!window.confirm('恢复会用备份文件整体替换当前全部数据，且无法撤销。确定继续吗？')) return;
      try {
        const text = await file.text();
        const payload = JSON.parse(text);
        const out = await api('/api/restore', { method: 'POST', body: payload });
        const r = out.restored;
        toast(`恢复完成：事项 ${r.todos} · 动态 ${r.posts} · 评论 ${r.comments} · 记录 ${r.records}`, 'ok');
        window.alert('数据已恢复，需要重新登录。');
        handleLogoutLocally();
      } catch (err) { toast('恢复失败：' + err.message, 'err'); }
    }
  });

  /* ═══ 动态相关动作 ═══════════════════════════════════════ */

  /**
   * 发布后清空输入框。
   * 注意：渲染用的是 innerHTML 整体替换 + 「输入态保护」会把旧值还原回来，
   * 所以必须在新 DOM 生成之后显式清空，否则会出现「发布成功但文字还在框里」。
   */
  /* 草稿对象只有一个来源：任何「清空草稿」的动作都必须走这里。
     ★ v2.0.0 加「草稿角标」时踩过一次：发布成功后原来是**整体替换** state.compose 的，
     替换出来的对象少了 text / tags 两个字段，而渲染时要读 state.compose.text.trim()
     算角标 → `Cannot read properties of undefined (reading 'trim')`，
     整个动态页白屏（jsdom 里表现为「发布后回显」超时，不报后端错误）。 */
  /* ═══ 草稿（v4.3.3 需求 6）══════════════════════════════

     落在 localStorage，不放服务端：
       草稿是「还没想好要不要发」的半成品，属于个人临时状态 ——
       放服务端要加表、要处理多设备冲突，更要紧的是**草稿不该被家人看到**。
       本地存最贴合语义，也与 v4.1.0 的账单草稿（fh-bill-drafts）同一套心智。

     两层保障：
       ① 手动「存草稿」：用户明确要留着；
       ② 自动保存：输入停顿 0.8 秒、图片/视频增删、页面卸载（beforeunload）各写一次。
          页面异常刷新后重新打开，内容**自动恢复**并给一句提示，不用用户做任何操作。

     ★ 空内容不写草稿（顺手清掉旧的）—— 否则用户清空输入框后，下次打开
       会被一份空草稿「恢复」成展开状态，看起来像界面自己乱动。 */

  const POST_DRAFT_KEY = 'fh-post-draft';
  const REC_DRAFT_KEY = 'fh-record-draft';
  /* ★ 两个定时器要分开：共用一个的话，在记录本里打字会把动态那边还没落盘的
     草稿计时器顶掉（反之亦然），谁先谁后被吞完全看操作顺序。 */
  let postDraftTimer = null;
  let recDraftTimer = null;

  function readDraft(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const d = JSON.parse(raw);
      return d && typeof d === 'object' ? d : null;
    } catch { return null; }
  }
  function writeDraft(key, obj) {
    try { localStorage.setItem(key, JSON.stringify(obj)); } catch { /* 配额满 / 隐私模式：不影响发布 */ }
  }
  function dropDraft(key) {
    try { localStorage.removeItem(key); } catch { /* 忽略 */ }
  }

  const composeDraftPayload = () => ({
    /* ★ uid 必须带上：这是同一台设备上全家共用的浏览器，
       不带 uid 的话换个账号登录会看到上一个人的草稿（草稿不该被家人看到）。 */
    uid: state.me ? Number(state.me.id) || 0 : 0,
    text: String(state.compose.text || ''),
    tags: String(state.compose.tags || ''),
    images: (state.compose.images || []).slice(0, 9),
    videos: (state.compose.videos || []).slice(0, 3),
    visibility: state.compose.visibility || 'family',
    /* v4.28.2：草稿也要记住「指定可见成员」—— 否则半成品被恢复后
       会悄悄变成「全家可见」，那等于把用户明确加过锁的内容放开了。 */
    visibleTo: (state.compose.visibleTo || []).slice(0, 50),
    at: new Date().toISOString(),
  });
  const draftIsEmpty = (d) => !d
    || (!String(d.text || '').trim() && !String(d.tags || '').trim()
      && !(Array.isArray(d.images) ? d.images.length : 0)
      && !(Array.isArray(d.videos) ? d.videos.length : 0));

  function savePostDraftNow() {
    if (postDraftTimer) { clearTimeout(postDraftTimer); postDraftTimer = null; }
    const d = composeDraftPayload();
    if (draftIsEmpty(d)) { dropDraft(POST_DRAFT_KEY); clearDraftHint('post'); return false; }
    writeDraft(POST_DRAFT_KEY, d);
    markDraftSaved('post');
    return true;
  }
  function schedulePostDraft() {
    if (postDraftTimer) clearTimeout(postDraftTimer);
    markDraftPending('post');
    postDraftTimer = setTimeout(() => { postDraftTimer = null; savePostDraftNow(); }, 800);
  }
  /** 清掉某一个草稿提示（丢弃草稿 / 发布成功） */
  function clearDraftHint(kind) {
    const k = kind === 'rec' ? 'rec' : 'post';
    state.draftState = Object.assign({}, state.draftState, { [k]: { pending: false, at: '' } });
    paintDraftHint(k);
  }

  /** 启动时恢复动态草稿。当前已有内容时不覆盖（以免把刚写的东西冲掉）。 */
  function restorePostDraft() {
    const d = readDraft(POST_DRAFT_KEY);
    if (draftIsEmpty(d)) return false;
    /* 别人的草稿直接丢掉（同一台设备换账号登录），不提示、也不恢复 ——
       草稿本来就不该被家人看到。 */
    const myUid = state.me ? Number(state.me.id) || 0 : 0;
    if (d.uid && myUid && Number(d.uid) !== myUid) { dropDraft(POST_DRAFT_KEY); return false; }
    if (!draftIsEmpty(composeDraftPayload())) return false;
    state.compose = {
      images: (Array.isArray(d.images) ? d.images : []).filter((x) => x && x.path),
      videos: (Array.isArray(d.videos) ? d.videos : []).filter((x) => x && x.path),
      visibility: d.visibility === 'private' ? 'private' : 'family',
      visibleTo: (Array.isArray(d.visibleTo) ? d.visibleTo : []).map(Number).filter(Boolean),
      text: String(d.text || ''),
      tags: String(d.tags || ''),
    };
    if (state.postView !== 'calendar') state.composeOpen = true;
    return true;
  }

  /* ── 记录本草稿：只在「新建」时启用。
     编辑已有记录不存草稿 —— 否则你打开一条旧记录随手改两个字又关掉，
     下次新建会莫名其妙带出它的内容。 */
  function recordDraftActive() {
    const layer = $('#modal-layer');
    return !!layer && layer.dataset.recMode === 'new';
  }

  function saveRecordDraftNow() {
    if (!recordDraftActive()) return false;
    const layer = $('#modal-layer');
    if (!layer) return false;
    if (recDraftTimer) { clearTimeout(recDraftTimer); recDraftTimer = null; }
    let images = [];
    let attachments = [];
    try { images = JSON.parse(layer.dataset.images || '[]'); } catch { /* 忽略 */ }
    try { attachments = JSON.parse(layer.dataset.attachments || '[]'); } catch { /* 忽略 */ }
    recSyncContent();          // v4.16.0：先让编辑器内容落到 textarea 上，草稿才不丢最后一次输入
    const d = {
      uid: state.me ? Number(state.me.id) || 0 : 0,
      title: modalValue('title').trim(),
      content: modalValue('content'),
      category: layer.dataset.category || '通用',
      images,
      attachments,
      visibility: layer.dataset.visibility || 'family',
      visibleTo: visReading(layer).visibleTo,
      pinned: layer.dataset.pinned === '1',
      at: new Date().toISOString(),
    };
    if (!d.title && !String(d.content || '').trim() && !images.length && !attachments.length) {
      dropDraft(REC_DRAFT_KEY);
      clearDraftHint('rec');
      return false;
    }
    writeDraft(REC_DRAFT_KEY, d);
    markDraftSaved('rec');
    return true;
  }

  function scheduleRecordDraft() {
    if (recDraftTimer) clearTimeout(recDraftTimer);
    markDraftPending('rec');
    recDraftTimer = setTimeout(() => { recDraftTimer = null; saveRecordDraftNow(); }, 800);
  }

  /* 页面被关掉 / 刷新（含异常崩溃前的卸载）时再兜一次：
     正常情况下 0.8 秒的 debounce 已经写过了，但「敲完最后一个字立刻关页面」
     是最常见的漏写场景。 */
  window.addEventListener('beforeunload', () => {
    savePostDraftNow();
    saveRecordDraftNow();
  });

  function resetCompose(visibility) {
    state.compose = {
      images: [],
      videos: [],
      visibility: visibility || state.compose.visibility || 'family',
      visibleTo: [],
      text: '',
      tags: '',
    };
  }

  function clearComposeInputs() {
    const ta = document.querySelector('[data-act="compose-text"]');
    const tg = document.querySelector('[data-act="compose-tags"]');
    if (ta) ta.value = '';
    if (tg) tg.value = '';
  }

  /* v4.13.0（问题 4）：把表情插到光标处（有选区则替换选区）。
     ★ 不 render：面板要一直开着，用户常常连点几个表情；
       写回 state 再排一次草稿保存就够了。 */
  function insertComposeEmoji(ch) {
    const e = String(ch || '');
    if (!e) return;
    const ta = document.querySelector('[data-act="compose-text"]');
    if (!ta) return;
    const start = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
    const end = ta.selectionEnd == null ? start : ta.selectionEnd;
    const next = `${ta.value.slice(0, start)}${e}${ta.value.slice(end)}`;
    ta.value = next;
    state.compose.text = next;
    try {
      ta.focus();
      const at = start + e.length;
      ta.setSelectionRange(at, at);
    } catch { /* 老浏览器忽略 */ }
    autoGrow(ta);
    schedulePostDraft();
  }

  async function publishPost() {
    const ta = document.querySelector('[data-act="compose-text"]');
    const content = (ta ? ta.value : '').trim();
    const images = state.compose.images.map((i) => i.path);
    const videos = (state.compose.videos || []).map((v) => v.path);
    // v4.3.3 需求 8：视频封面一起提交（没有封面就不传，服务端按空对象处理）
    const videoCovers = coverMapOf(state.compose.videos);
    const tagInput = document.querySelector('[data-act="compose-tags"]');
    const tags = (tagInput ? tagInput.value : '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 10);
    if (!content && !images.length && !videos.length) { toast('写点什么，或选张图片 / 一段视频吧', 'err'); return; }
    try {
      await api('/api/posts', {
        method: 'POST',
        body: {
          content, images, videos, tags,
          videoCovers,
          /* v4.28.2：可见范围与「指定可见成员」。动态发布区不是弹窗，
             所以这里直接取 state（弹窗里才有 layer.dataset）。 */
          visibility: state.compose.visibility || 'family',
          visibleTo: (state.compose.visibleTo || []).slice(0, 50),
        },
      });
      /* v4.28.2：发布成功后**回到「全家可见」**，不沿用上一条的可见范围。
         沿用会很危险：上一条若是「指定可见成员」，resetCompose 会把名单清空，
         下一条就变成「private + 空名单 = 仅自己可见」，而按钮只是一行小字的变化，
         用户几乎不会察觉 —— 然后困惑「为什么没人回我」。
         默认值按需求就是全家可见，每次重新确认一次更安全。 */
      resetCompose('family');
      /* v4.3.3 需求 6：发布成功 = 草稿使命完成，删掉本地那份，
         否则下次打开会把刚发出去的内容又「恢复」成一条半成品。 */
      dropDraft(POST_DRAFT_KEY);
      clearDraftHint('post');
      state.draftNotice = '';
      state.postTag = '';                                // 清掉标签筛选，保证刚发的动态一定能看到
      await refreshPosts();
      clearComposeInputs();
      toast('已发布', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  /* v4.3.3 需求 1：评论里可插入的表情（零素材依赖 —— 用系统 emoji，
     不存在「贴图包没加载出来」这种失败态，也不会把图片体积算进首屏）。 */
  const COMMENT_EMOJIS = [
    '😀', '😄', '😁', '😊', '🥰', '😍', '🤩', '😘', '😎', '🤗',
    '😌', '😂', '🤣', '😅', '🙂', '😉', '😇', '🥳', '😭', '😢',
    '😤', '😡', '🤔', '😴', '🤤', '🤭', '🙃', '😬', '🤯', '🥺',
    '👍', '👎', '👏', '🙏', '💪', '🤝', '❤️', '💔', '💯', '🎉',
    '🎂', '🌹', '🌟', '🔥', '✨', '☀️', '🌙', '🍚', '🍜', '☕',
    '🎁', '🚗', '🏠', '🐶', '🐱', '🌳',
  ];
  /* v4.13.0（问题 4）：发帖输入框也用同一份表情清单 —— 零素材依赖，
     不会出现「贴图包没加载出来」的失败态，也不占首屏体积。 */
  const COMPOSE_EMOJIS = COMMENT_EMOJIS;

  async function sendComment(postId) {
    const input = document.querySelector(`[data-act="comment-input"][data-id="${postId}"]`);
    if (!input) return;
    const form = input.closest('.comment-form');
    const content = input.value.trim();
    if (!content) return;
    /* v4.3.3 需求 1：回复关系挂在表单的 dataset 上（点「回复」时写入）。
       为什么不用全局 state：评论表单是就地操作的，走 state 会触发一次整块重绘，
       而重绘恰好会打断「正在输入」的输入框（最小重绘也只保护握着焦点的那个节点，
       回复条与面板会跟着一起重建）。 */
    const parentId = Number(form && form.dataset.replyTo) || 0;
    input.value = '';
    if (form) {
      form.dataset.replyTo = '';
      form.dataset.replyName = '';
      const chip = form.querySelector('.reply-chip');
      if (chip) chip.remove();
    }
    try {
      await api('/api/comments', { method: 'POST', body: { postId, content, parentId } });
      await refreshPosts();
    } catch (err) {
      input.value = content;
      toast(err.message, 'err');
    }
  }

  /**
   * 点赞 / 取消赞（v4.3.3 需求 1）。
   * 用接口返回的完整赞列表**局部更新** state 再 render，不整页重拉：
   * 点赞是高频操作，每点一次都拉一遍全量动态会让界面明显卡一下
   * （尤其在 NAS 上，这正是 v4.3.2 花大力气优化掉的体感）。
   */
  async function toggleLike(el) {
    const postId = Number(el.dataset.id);
    const target = el.dataset.target === 'comment' ? 'comment' : 'post';
    const targetId = target === 'comment' ? (Number(el.dataset.tid) || 0) : 0;
    try {
      const r = await api('/api/likes', { method: 'POST', body: { postId, target, targetId } });
      const p = state.posts.find((x) => x.id === postId);
      if (!p) return;
      if (target === 'comment') {
        const c = (p.comments || []).find((x) => x.id === targetId);
        if (c) { c.likes = r.likes; c.likeCount = r.count; c.liked = r.liked; }
      } else {
        p.likes = r.likes;
        p.likeCount = r.count;
        p.liked = r.liked;
        // v4.23.0：点赞是从「⋯」菜单里点的，点完把菜单收起来；
        // 同时点赞行会因为 liked=true 自动出现（朋友圈同款反馈）
        state.postMenu = 0;
      }
      render();
    } catch (err) { toast(err.message, 'err'); }
  }

  /* ── 编辑动态（仅发布人） ───────────────────────────────
     权限在服务端硬校验（非作者一律 403），前端只负责不显示入口。 */

  function postThumbHtml(imgs, delAct) {
    const act = delAct || 'post-img-del';
    return imgs.map((src, i) =>
      `<div class="thumb"><img src="${esc(assetUrl(src))}" alt=""><button type="button" data-act="${act}" data-i="${i}">×</button></div>`).join('');
  }

  function renderPostThumbs(imgs) {
    const box = document.querySelector('#post-imgs');
    if (box) box.innerHTML = postThumbHtml(imgs);
  }

  function renderPostVideos(list, covers) {
    const box = document.querySelector('#post-videos');
    if (box) box.innerHTML = videoChipHtml(list, 'post-video-del', '', covers);
  }

  function openPostForm(post) {
    const p = post;
    openModal({
      title: '编辑动态',
      body: `
        <label class="field"><span>内容</span>
          <textarea data-mk="content" maxlength="5000" placeholder="记录此刻的生活…">${esc(p.content)}</textarea></label>
        <div class="field"><span>图片</span>
          <div class="composer-imgs" id="post-imgs">${postThumbHtml(p.images)}</div>
          <button type="button" class="btn-ghost btn-sm" data-act="post-img-add">＋ 图片</button>
          <input type="file" accept="image/*" multiple class="hidden" id="post-file">
        </div>
        <div class="field"><span>视频<span class="field-hint">（浏览器能播放的 MP4 / MOV / WebM，单段上限 ${maxVideoMb()}MB）</span></span>
          <div class="composer-videos" id="post-videos">${videoChipHtml(p.videos || [], 'post-video-del', '', p.videoCovers)}</div>
          <button type="button" class="btn-ghost btn-sm" data-act="post-video-add">＋ 视频</button>
          <input type="file" accept="video/*" multiple class="hidden" id="post-video-file">
        </div>
        <label class="field"><span>标签（用逗号或空格分隔）</span>
          <input type="text" data-mk="tags" maxlength="80" value="${esc(p.tags.join(' '))}" placeholder="例如：出游 美食"></label>
        ${allPostTags().length ? `<div class="field"><span>点选已有标签</span>
          <div class="tag-pick">${allPostTags().slice(0, 12).map((t) =>
            `<button type="button" class="chip" data-act="form-tag-add" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</div>
        </div>` : ''}
        <div class="field"><span>谁能看到</span>
          ${visPickHtml(p.visibility, p.visibleTo)}
        </div>`,
      foot: `
        <div class="spacer"></div>
        <button type="button" class="btn-ghost" data-act="modal-close">取消</button>
        <button type="button" class="btn-primary" data-act="post-save" data-id="${p.id}">保存</button>`,
      onMount: (layer) => {
        layer.dataset.images = JSON.stringify(p.images || []);
        layer.dataset.videos = JSON.stringify(p.videos || []);
        layer.dataset.videoCovers = JSON.stringify(p.videoCovers || {});
        layer.dataset.visibility = p.visibility;
      },
    });
  }

  async function savePost(id) {
    const layer = $('#modal-layer');
    let images = [];
    let videos = [];
    let videoCovers = {};
    try { images = JSON.parse(layer.dataset.images || '[]'); } catch { /* 忽略 */ }
    try { videos = JSON.parse(layer.dataset.videos || '[]'); } catch { /* 忽略 */ }
    // v4.6.0 需求 4：编辑时新加的视频也要带上封面（服务端会与旧映射合并、并剔除失效项）
    try { videoCovers = JSON.parse(layer.dataset.videoCovers || '{}'); } catch { /* 忽略 */ }
    const body = {
      content: modalValue('content').trim(),
      tags: modalValue('tags').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 10),
      images,
      videos,
      videoCovers,
      ...visReading(layer),
    };
    if (!body.content && !images.length && !videos.length) { toast('写点什么，或选张图片 / 一段视频吧', 'err'); return; }
    try {
      await api('/api/posts/' + id, { method: 'PATCH', body });
      closeModal();
      await refreshPosts();
      toast('已保存', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  /* ═══ 动态共创（v1.9.0，需求 9） ════════════════════════
     家人对**别人的**动态追加文字 / 图片 / 视频，每条留痕。
     权限由服务端收口（私密动态不可共创、非贡献者不可删），这里只管界面。 */

  /* v4.3.3 需求 5：「一起写」支持编辑已有内容。
     传 contrib 就是编辑，不传就是追加。权限在服务端硬校验（只有作者本人能改），
     前端只负责「不给自己没权限的条目显示编辑按钮」——
     动态作者对别人的补充只有删除权，没有改写权。 */
  function openContribForm(post, contrib) {
    const p = post;
    const c = contrib || null;
    const isEdit = !!c;
    const imgs = isEdit ? (c.images || []) : [];
    const vids = isEdit ? (c.videos || []) : [];
    // v4.6.0 需求 4：共创视频的封面映射（与帖子同一套口径，服务端列名 post_contribs.video_covers）
    const covers = (isEdit && c.videoCovers) ? c.videoCovers : {};
    openModal({
      title: isEdit ? '编辑补充内容' : `一起写 · ${p.ownerName}的动态`,
      body: `
        <div class="field"><span>补充内容</span>
          <textarea data-mk="content" maxlength="2000" placeholder="补充一段说明、续写、或者加几张照片…">${esc(isEdit ? c.content : '')}</textarea></div>
        <div class="field"><span>图片</span>
          <div class="composer-imgs" id="contrib-imgs">${imgs.length ? postThumbHtml(imgs, 'contrib-img-del') : ''}</div>
          <button type="button" class="btn-ghost btn-sm" data-act="contrib-img-add">＋ 图片</button>
          <input type="file" accept="image/*" multiple class="hidden" id="contrib-file">
        </div>
        <div class="field"><span>视频<span class="field-hint">（单段上限 ${maxVideoMb()}MB）</span></span>
          <div class="composer-videos" id="contrib-videos">${vids.length ? videoChipHtml(vids, 'contrib-video-del', '', covers) : ''}</div>
          <button type="button" class="btn-ghost btn-sm" data-act="contrib-video-add">＋ 视频</button>
          <input type="file" accept="video/*" multiple class="hidden" id="contrib-video-file">
        </div>
        <small class="field-hint">${isEdit
          ? '改完之后这条会标注「已编辑」，家人能看出内容后来动过。'
          : '补充的内容会显示在这条动态下方，并标注是你加的。'}</small>`,
      foot: `
        <div class="spacer"></div>
        <button type="button" class="btn-ghost" data-act="modal-close">取消</button>
        <button type="button" class="btn-primary" data-act="contrib-save" data-id="${p.id}" data-cid="${isEdit ? c.id : ''}">${isEdit ? '保存修改' : '添加'}</button>`,
      onMount: (layer) => {
        layer.dataset.images = JSON.stringify(imgs);
        layer.dataset.videos = JSON.stringify(vids);
        layer.dataset.videoCovers = JSON.stringify(covers);
      },
    });
  }

  async function saveContribution(postId, contribId) {
    const layer = $('#modal-layer');
    if (!layer) return;
    let images = [];
    let videos = [];
    let videoCovers = {};
    try { images = JSON.parse(layer.dataset.images || '[]'); } catch { /* 忽略 */ }
    try { videos = JSON.parse(layer.dataset.videos || '[]'); } catch { /* 忽略 */ }
    try { videoCovers = JSON.parse(layer.dataset.videoCovers || '{}'); } catch { /* 忽略 */ }
    const content = modalValue('content').trim();
    if (!content && !images.length && !videos.length) { toast('写点什么，或加张图片 / 一段视频吧', 'err'); return; }
    try {
      if (contribId) {
        await api(`/api/contribs/${contribId}`, { method: 'PATCH', body: { content, images, videos, videoCovers } });
        closeModal();
        await refreshPosts();
        toast('已保存修改', 'ok');
        return;
      }
      await api(`/api/posts/${postId}/contrib`, { method: 'POST', body: { content, images, videos, videoCovers } });
      closeModal();
      await refreshPosts();
      toast('已添加，家人都能看到你的补充', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  /* ═══ 记录本表单 ═════════════════════════════════════════ */

  /* 编辑态缩略图。v4.17.0 需求 3：
     ① 图片可点击预览大图（img-view + 组容器 data-gal，旧版点了没反应）；
     ② 每张图下面有一条「备注」输入框 —— 输入即写回 dataset.images，随保存一起落库。 */
  function recThumbHtml(imgs) {
    return imgs.map((im, i) => {
      const src = recImgSrc(im);
      const note = recImgNote(im);
      return `<div class="thumb has-note">`
        + `<img src="${esc(assetUrl(src))}" alt="" data-act="img-view" data-src="${esc(src)}" title="点击放大">`
        + `<button type="button" data-act="rec-img-del" data-i="${i}" title="移除">×</button>`
        + `<input type="text" class="thumb-note" data-act="rec-img-note" data-i="${i}" maxlength="60"`
        + ` placeholder="备注…" value="${esc(note)}" title="给这张图写点说明，会显示在查看页图片下方">`
        + `</div>`;
    }).join('');
  }

  function renderRecordThumbs(imgs) {
    const box = document.querySelector('#rec-imgs');
    if (!box) return;
    box.innerHTML = recThumbHtml(imgs);
    /* 灯箱图组要跟着列表走：增删图后重写一次（img-view 翻页看的是它） */
    box.setAttribute('data-gal', JSON.stringify(imgs.map(recImgSrc)));
  }

  /* ── 记录本附件（v1.5.0） ─────────────────────────────── */

  function recAttHtml(atts) {
    if (!atts.length) return '<div class="attach-empty">还没有附件</div>';
    return atts.map((a, i) =>
      `<span class="attach-chip" title="${esc(a.name)}">` +
      `${a.cover ? `<img class="att-thumb" src="${esc(a.cover)}" alt="" loading="lazy">` : `<span class="att-ico">${fileIcon(a.name)}</span>`}` +
      `<span class="att-name">${esc(a.name)}</span>` +
      `<span class="att-size">${esc(fmtBytes(a.size))}</span>` +
      `<button type="button" class="att-del" data-act="rec-att-del" data-i="${i}" title="移除">×</button>` +
      '</span>').join('');
  }

  function renderRecordAtts(atts) {
    const box = document.querySelector('#rec-atts');
    if (box) box.innerHTML = recAttHtml(atts);
  }

  function openRecordForm(rec) {
    const isEdit = !!rec;
    /* v4.3.3 需求 6：**新建**时才认本地草稿。编辑已有记录不碰草稿 ——
       否则你打开一条旧记录改两个字又关掉，下次新建会莫名带出它的内容。
       页面异常刷新后重新点「新建」，未保存的内容会自动回来，不用用户做任何操作。 */
    const draft = isEdit ? null : readDraft(REC_DRAFT_KEY);
    const draftUid = draft ? Number(draft.uid) || 0 : 0;
    const myUid = state.me ? Number(state.me.id) || 0 : 0;
    /* 别人的记录本草稿同样直接丢掉（同一台设备换账号） */
    const draftOwned = !draftUid || !myUid || draftUid === myUid;
    if (draft && !draftOwned) dropDraft(REC_DRAFT_KEY);
    const draftOk = draftOwned && !!draft && (
      String(draft.title || '').trim() || String(draft.content || '').trim()
      || (Array.isArray(draft.images) && draft.images.length)
      || (Array.isArray(draft.attachments) && draft.attachments.length));
    const r = rec || (draftOk ? {
      title: String(draft.title || ''),
      content: String(draft.content || ''),
      category: String(draft.category || '通用'),
      images: (Array.isArray(draft.images) ? draft.images : []).filter(Boolean),
      attachments: (Array.isArray(draft.attachments) ? draft.attachments : []).filter(Boolean),
      pinned: !!draft.pinned,
      visibility: draft.visibility === 'private' ? 'private' : 'family',
      visibleTo: (Array.isArray(draft.visibleTo) ? draft.visibleTo : []).map(Number).filter(Boolean),
    } : {
      title: '', content: '', category: '通用', images: [], attachments: [],
      pinned: false, visibility: 'family', visibleTo: [],
    });
    const cats = recordCategories();
    const curCat = r.category || '通用';
    const preset = cats.includes(curCat) ? curCat : '__custom__';
    openModal({
      title: isEdit ? '编辑记录' : '新建重点记录',
      body: `
        ${draftOk ? `<div class="draft-bar">
          <span class="grow">📝 已恢复上次未保存的内容</span>
          <button type="button" class="drop" data-act="rec-draft-drop">丢弃草稿</button>
        </div>` : ''}
        <!-- v4.14.0 需求 1：「谁能看到」与「提醒」搬到标题上方。
             这两项是**保存前就要定的归属与打扰**，先定好再写内容，比写完再回头勾更顺；
             移动端也不用为了改可见性滑到表单最底。 -->
        <div class="rec-head-fields">
          <div class="field"><span>谁能看到</span>
            ${visPickHtml(r.visibility, r.visibleTo)}
          </div>
          ${recRemindBlock(r)}
        </div>
        <label class="field"><span>标题</span>
          <input type="text" data-mk="title" maxlength="120" value="${esc(r.title)}" placeholder="例如：户口本存放位置"></label>
        <div class="field"><span>分类<span class="field-hint">（选一个，或在下面自己输入）</span></span>
          <div class="chips" id="rec-cats">
            ${cats.map((c) =>
              `<button type="button" class="chip${c === curCat ? ' on' : ''}" data-act="rec-cat-pick" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
            <button type="button" class="chip${preset === '__custom__' ? ' on' : ''}" data-act="rec-cat-pick" data-cat="__custom__">✏️ 自定义</button>
          </div>
          <input type="text" id="rec-cat-input" maxlength="20" placeholder="输入新分类，如「家电」「保险」"
                 value="${preset === '__custom__' && curCat !== '通用' ? esc(curCat) : ''}"
                 class="${preset === '__custom__' ? '' : 'hidden'}" style="margin-top:8px">
        </div>
        <div class="field"><span>内容<span class="field-hint">（支持图片、勾选框、序号列表）</span></span>
          <!-- ★ v4.16.0 需求 4：正文只保留三种结构化能力 —— 图片 / 勾选框 / 序号列表，
               其余富文本（加粗 / 斜体 / 下划线 / 删除线 / 高亮 / 代码 / 无序列表）全部下线。
               真正的取值仍走下面那个**隐藏的 textarea**（data-mk="content"）：
               保存 / 自动存草稿 / 测试脚本都只认它，编辑区每次输入就把内容同步进去。
               图片不进数据库：文件上传到服务器磁盘（与动态图片同一套存储），
               正文里只写「感叹号 + 方括号 + 圆括号路径」这一个图片引用。 -->
          <div class="rec-editor-bar">
            <button type="button" class="fmt-btn" data-act="rec-img-insert" title="插入一张图片（文件存服务器，正文里只记路径）">🖼 图片</button>
            <button type="button" class="fmt-btn" data-act="rec-fmt" data-fmt="insertOrderedList" title="序号列表">1. 序号</button>
            <button type="button" class="fmt-btn" data-act="rec-check-insert" title="插入一条勾选项">☐ 勾选框</button>
            <input type="file" accept="image/*" class="hidden" id="rec-inline-file">
          </div>
          <div id="rec-editor" class="rec-editor-rt" contenteditable="true" role="textbox"
               aria-multiline="true" data-placeholder="把重要信息写清楚，长期保存"></div>
          <textarea data-mk="content" maxlength="20000" class="rec-editor hidden" aria-hidden="true" tabindex="-1"></textarea>
          <small class="field-hint">勾选行的行首是 ☐，回车会自动续一行勾选框；粘贴的内容只保留文字；图片单独存在服务器，正文里只记路径。</small></div>
        <div class="field"><span>图片<span class="field-hint">（单个不超过 ${maxImgMb()}MB，会自动压缩）</span></span>
          <div class="composer-imgs" id="rec-imgs" data-gal="${esc(JSON.stringify((r.images || []).map(recImgSrc)))}">${recThumbHtml(r.images || [])}</div>
          <button type="button" class="btn-ghost btn-sm" data-act="rec-img-add">＋ 图片</button>
          <input type="file" accept="image/*" multiple class="hidden" id="rec-file">
        </div>
        <div class="field"><span>附件<span class="field-hint">（PDF / Word / Excel / PPT / 压缩包 / 音视频 / 文本，单个不超过 ${maxFileMb()}MB，最多 10 个）</span></span>
          <div class="attach-edit-list" id="rec-atts">${recAttHtml(r.attachments || [])}</div>
          <button type="button" class="btn-ghost btn-sm" data-act="rec-att-add">＋ 添加附件</button>
          <input type="file" multiple class="hidden" id="rec-att-file">
        </div>
        <div class="field"><span>置顶</span>
          <div class="segmented" data-act="rec-pin-pick">
            <button type="button" data-pin="0" class="${r.pinned ? '' : 'on'}">普通</button>
            <button type="button" data-pin="1" class="${r.pinned ? 'on' : ''}">★ 置顶</button>
          </div>
        </div>`,
      foot: `
        ${isEdit ? '<button type="button" class="btn-danger btn-sm" data-act="rec-delete" data-id="' + r.id + '">删除</button>' : ''}
        <div class="spacer"></div>
        ${isEdit ? '' : '<span class="draft-hint hidden" id="rec-draft-hint"></span>'}
        <button type="button" class="btn-primary" data-act="rec-save" data-id="${isEdit ? r.id : ''}">保存</button>`,
      onMount: (layer) => {
        /* v4.3.3 需求 6：标出这次弹窗是「新建」还是「编辑」—— 只有新建才自动存草稿 */
        layer.dataset.recMode = isEdit ? 'edit' : 'new';
        // v4.13.0：新建时把上次的草稿保存时间显示出来（编辑态没有草稿提示）
        if (!isEdit) paintDraftHint('rec');
        layer.dataset.category = curCat;
        layer.dataset.visibility = r.visibility;
        layer.dataset.pinned = r.pinned ? '1' : '0';
        layer.dataset.images = JSON.stringify(r.images || []);
        layer.dataset.attachments = JSON.stringify(r.attachments || []);
        // v4.12.0：提醒开关控制三个子项显隐（默认收起，因为默认就是不提醒）
        const remCb = layer.querySelector('[data-mk="recRemind"]');
        if (remCb) {
          remCb.addEventListener('change', () => {
            const wrap = layer.querySelector('#rec-remind-wrap');
            if (wrap) wrap.classList.toggle('hidden', !remCb.checked);
          });
        }
        /* ★ v4.16.0 需求 5：富文本编辑区的初始化。
           三件事必须在这里做（而不是写在 HTML 里）：
             ① 把已有正文（Markdown 子集）填进编辑区并镜像到 textarea；
             ② 输入 / 粘贴 / 回车都同步回 textarea，否则保存到的是上一次的内容；
             ③ 回车续勾选框 —— 原来 textarea 上靠"手写 ☐"的体验不能丢。 */
        const ed = layer.querySelector('#rec-editor');
        const ta = layer.querySelector('[data-mk="content"]');
        if (ed && ta) {
          ta.value = String(r.content || '');           // 唯一取值口径的初值
          ed.innerHTML = recMdToEditorHtml(ta.value);
          const sync = () => {
            ta.value = recEditorToMd(ed);
            scheduleRecordDraft();                      // 边写边存草稿（0.8s 去抖）
          };
          ed.addEventListener('input', sync);
          // 粘贴一律降级成纯文本：避免把外部 HTML（含样式/标签）带进可编辑区
          ed.addEventListener('paste', (ev) => {
            const cd = ev.clipboardData || window.clipboardData;
            const txt = cd ? cd.getData('text/plain') : '';
            if (txt == null) return;
            ev.preventDefault();
            if (typeof document.execCommand === 'function') document.execCommand('insertText', false, txt);
            else { ed.textContent += txt; sync(); }
          });
          // 回车续勾选框：当前行以 ☐ / ☑ 开头时，新行自动补一个 ☐
          ed.addEventListener('keydown', (ev) => {
            if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return;
            const sel = window.getSelection && window.getSelection();
            if (!sel || !sel.rangeCount) return;
            const node = sel.anchorNode;
            const base = node && (node.nodeType === 1 ? node : node.parentNode);
            const host = (base && base.closest && (base.closest('div,li,p') || ed)) || ed;
            if (!/^\s*[☐☑]\s/.test(String(host.textContent || ''))) return;
            ev.preventDefault();
            if (typeof document.execCommand === 'function') {
              document.execCommand('insertText', false, '\n☐ ');
              sync();
            }
          });
          /* 测试 / 老代码仍可能直接给 textarea 赋值再触发 input（setValue 就是这么干的）：
             这时把编辑区按新内容重建。真人不会往隐藏框里打字，所以不存在反向打架。 */
          ta.addEventListener('input', () => {
            ed.innerHTML = recMdToEditorHtml(ta.value);
          });
        }
      },
    });
  }

  /**
   * v4.12.0 需求（记录本）：提醒开关 + 三个子项。
   *   · 默认**不提醒**（记录本是长期信息，不是待办）；
   *   · 打开后才出现「提醒时间 / 提前提醒天数 / 提醒方式」；
   *   · 三项的默认值都是「跟随系统」，与「家庭设置 → 待办提醒」同一套语义：
   *       提醒时间   空串 = 用 remindDefaultTime
   *       提前天数   -1   = 用 remindAdvanceDays
   *       提醒方式   空串 = 用这个人自己的推送通道（我的 → 推送配置）
   * 服务端 recordRemindPatch() 是这些默认值的最终裁判，这里只做界面。
   */
  function recRemindBlock(r) {
    const sys = state.settings || {};
    const sysTime = String(sys.remindDefaultTime || '08:00');
    const sysAdv = Number(sys.remindAdvanceDays) || 0;
    const on = !!r.remind;
    const curAdv = (r.remindAdvanceDays == null || r.remindAdvanceDays < 0) ? -1 : Number(r.remindAdvanceDays);
    const curCh = String(r.remindChannel || '');
    /* ★ v4.15.0 需求 1：「跟随系统」的选项文字里原来塞了整句 pushChannelSummary
       （「当前：智能 · 企业微信应用未启用，现在会走邮件；发不出去会自动回退邮件」），
       手机上一个 <select> 里放 30 多个汉字：Chrome 会按**最长选项**算最小内容宽度，
       在 320~360px 屏上直接把「提醒方式」这一行顶出弹窗右边界。
       现在选项只说「跟随系统」，当前通道走下面的 .field-hint 说明。 */
    const chLabel = { '': '跟随系统', mail: '只用邮件', wecom: '只用企业微信', both: '邮件 + 企业微信' };
    return `
      <div class="field">
        <div class="rec-remind-head">
          <span>提醒<span class="field-hint">（可选：到点发一条提醒给<b>我自己</b>）</span></span>
          <label class="check-line"><input type="checkbox" data-mk="recRemind"${on ? ' checked' : ''}>
            <span>开启提醒</span></label>
        </div>
        <div id="rec-remind-wrap" class="${on ? '' : 'hidden'}">
          <div class="time-row">
            <label class="field field-sm"><span>提醒时间</span>
              <input type="time" data-mk="recRemindTime" value="${esc(r.remindTime || '')}"></label>
            <label class="field field-sm"><span>提前提醒</span>
              <select data-mk="recRemindAdvance">
                <option value="-1"${curAdv < 0 ? ' selected' : ''}>跟随系统（${esc(sysTime)} ${esc(advanceLabel(sysAdv))}）</option>
                ${ADVANCE_CHOICES.map((n) =>
                  `<option value="${n}"${curAdv === n ? ' selected' : ''}>${esc(advanceLabel(n))}</option>`).join('')}
              </select></label>
          </div>
          <label class="field field-sm"><span>提醒方式</span>
            <select data-mk="recRemindChannel">
              ${['', 'mail', 'wecom', 'both'].map((v) =>
                `<option value="${v}"${curCh === v ? ' selected' : ''}>${esc(chLabel[v])}</option>`).join('')}
            </select></label>
          <small class="field-hint" id="rec-remind-hint">留空 = 跟随系统：默认 ${esc(sysTime)}·
            ${esc(advanceLabel(sysAdv))}；${esc(pushChannelSummary(state.me))}。到点只发一次，发完不再重复。</small>
        </div>
      </div>`;
  }

  /** 从表单读出分类：选了「自定义」就以输入框为准 */
  function formCategory(layer) {    const custom = layer.querySelector('#rec-cat-input');
    if (layer.dataset.category === '__custom__') {
      const v = (custom ? custom.value : '').trim();
      return v || '通用';
    }
    return layer.dataset.category || '通用';
  }

  async function saveRecord(id) {
    const layer = $('#modal-layer');
    let images = [];
    let attachments = [];
    try { images = JSON.parse(layer.dataset.images || '[]'); } catch { /* 忽略 */ }
    try { attachments = JSON.parse(layer.dataset.attachments || '[]'); } catch { /* 忽略 */ }
    recSyncContent();          // v4.16.0：富文本编辑区 → 隐藏 textarea（唯一取值口径）
    const body = {
      title: modalValue('title').trim(),
      content: modalValue('content').trim(),
      category: formCategory(layer),
      // 标签功能已移除（v1.5.0）：不再提交 tags，老数据保持原样不动
      images,
      attachments,
      pinned: layer.dataset.pinned === '1',
      ...visReading(layer),
      /* v4.12.0：记录本提醒。三处「跟随系统」都用「缺省值」表达：
         remindTime 空串 / remindAdvanceDays -1 / remindChannel 空串。
         服务端 recordRemindPatch() 认这几个值，不会把它们当成「用户填了空」。 */
      remind: modalChecked('recRemind'),
      remindTime: modalValue('recRemindTime'),
      remindAdvanceDays: Number(modalValue('recRemindAdvance') || -1),
      remindChannel: modalValue('recRemindChannel'),
    };
    if (!body.title) { toast('请填写标题', 'err'); return; }
    if (!body.category) { toast('请填写或选择一个分类', 'err'); return; }
    try {
      if (id) await api('/api/records/' + id, { method: 'PATCH', body });
      else await api('/api/records', { method: 'POST', body });
      /* v4.3.3 需求 6：保存成功 = 草稿用完了，删掉本地的，
         否则下次新建会把刚存下的这条又「恢复」成草稿。
         `recCommitted` 让 closeModal 不要再把它写回草稿。 */
      layer.dataset.recCommitted = '1';
      dropDraft(REC_DRAFT_KEY);
      closeModal();
      await refreshRecords();
      toast(id ? '已保存' : '已添加记录', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  /* ═══ 我的 · 表单 ════════════════════════════════════════ */

  /* v2.0.0（需求 7）个人通知设置。
     编辑中的草稿放在 prefsDraft 里，每次改一个开关就用草稿重开一次弹窗 ——
     这样「点一下就变」而不会丢掉别人刚改的那几项（不用等保存就能看到结果）。
     保存时才 POST，成功后用服务端返回的 prefs 覆盖 state（单一事实来源）。 */
  let prefsDraft = null;

  function closePrefsForm() {
    prefsDraft = null;
    closeModal();
  }

  /* ── v4.13.0（问题 9）：管理员的「消息提醒 → 设置」──────────────
     管理员没有「我个人的提醒」这一层 —— 他改的就是全家的默认值。
     入口仍是消息提醒里那两行，弹窗内容换成家庭默认的键（写 /api/settings）。
     这样「家庭默认」这一区块可以整块撤掉，界面少一套控件、也少一个概念。 */
  /* ═══ v4.21.0 需求 1：消息模板编辑块（W-7 第一刀切片：实现在 public/msg-tpl.js）═══
     需求原文：把各类推送消息模板提取成可配置项、系统默认模板预置、支持一键恢复默认，
     并按板块归类到「待办提醒 / 内容通知 / 记账推送」三个设置弹窗里。
     ★ 为什么模板卡片自带「保存 / 恢复默认」，而不是并入弹窗底部那个「保存」：
       记账推送弹窗是**逐项即时生效**的（开关点一下就落库），底部根本没有保存按钮；
       三处统一成「卡片自己管自己」，交互才一致，也不会出现「改了模板忘了点弹窗底部」。
     ★ data-tpl 而不是 data-mk：全局的 document input 监听器只认 data-mk，
       用它的话每敲一个字都会被当成设置项处理。
     ★ 技术债 W-7：这一块的渲染 / 保存 / 恢复默认已经搬到独立外链脚本 msg-tpl.js，
       依赖用「传进去」的方式（esc / api / toast / 读写 settings），不靠闭包偷看，
       所以它是可独立测试、可继续再拆的单元。这里只留薄适配层，调用点一个都没改。 */
  const MsgTplUI = window.MsgTplUI({
    esc,
    api,
    toast,
    getTemplates: () => (state.settings && state.settings.msgTemplates) || null,
    setSettings: (next) => { state.settings = next; },
  });
  const msgTplBlock = (group) => MsgTplUI.block(group);
  const paintMsgTplCard = (key) => MsgTplUI.paint(key);
  const saveMsgTpl = (key) => MsgTplUI.save(key);
  const resetMsgTpl = (key) => MsgTplUI.reset(key);

  function openAdminRemindForm() {
    const s = state.settings || {};
    const g = state.prefsGlobal || {};
    const on = s.remindEnabled !== undefined ? s.remindEnabled !== false : g.remindEnabled !== false;
    const time = String(s.remindDefaultTime || g.remindDefaultTime || '08:00');
    const adv = Number(s.remindAdvanceDays != null ? s.remindAdvanceDays : g.advanceDays) || 0;
    openModal({
      title: '待办提醒 · 全家默认',
      body: `
        <label class="field"><span>待办到点时是否提醒</span>
          <select data-mk="aRemindOn">
            <option value="1"${on ? ' selected' : ''}>开启（到点提醒）</option>
            <option value="0"${on ? '' : ' selected'}>关闭（全家都不再提醒）</option>
          </select></label>
        <label class="field"><span>默认提醒时间</span>
          <input type="time" data-mk="aRemindTime" value="${esc(time)}">
          <small class="field-hint">待办没有开始时间时按这个点提醒。</small></label>
        <label class="field"><span>提前提醒天数</span>
          <select data-mk="aAdvance">
            ${ADVANCE_CHOICES.map((n) => `<option value="${n}"${adv === n ? ' selected' : ''}>${esc(advanceLabel(n))}</option>`).join('')}
          </select></label>
        ${myChannelSelect('todo')}
        ${msgTplBlock('remind')}
        <div class="note-box">成员可以在自己的「待办提醒」里选「跟随管理员」或「关闭」，关掉只影响他自己。
          免打扰时段是每个人自己的，在成员自己的设置里选。</div>`,
      foot: `<button type="button" class="btn-ghost" data-act="modal-close">取消</button>
        <button type="button" class="btn-primary" data-act="admin-msg-save" data-which="remind">保存</button>`,
    });
  }

  function openAdminNotifyForm() {
    const s = state.settings || {};
    const g = state.prefsGlobal || {};
    const on = s.notifyOnChange !== undefined ? s.notifyOnChange !== false : g.notifyOnChange !== false;
    const allKinds = (g.notifyKindsAll && g.notifyKindsAll.length) ? g.notifyKindsAll : Object.keys(NOTIFY_KIND_CN);
    const cur = Array.isArray(s.notifyKinds) ? s.notifyKinds
      : (Array.isArray(g.notifyKinds) ? g.notifyKinds : allKinds.slice());
    /* v4.14.0 需求 4：「汇总时间」这一项撤掉了。
       现在只有「免打扰时段」一个时间概念：
         · 留空 → 有变更就立刻提醒（限流 20 封/分 + 3 分钟同一条去重照旧）；
         · 填了 → 期间攒着，免打扰一结束就合并成一封发出去。
       少一个下拉，就少一种「设了 20:30 结果一整天没消息」的困惑。 */
    /* ★ 空值也是值（v4.26.0 修）：原来写 `s.notifyQuietStart || g.notifyQuietStart`，
       而 `g`（state.prefsGlobal）是一次 /api/prefs 的快照 —— 如果那次请求比刚才的
       「保存」更早发出、却更晚返回，它会把旧值刷回来。于是「清空免打扰 → 保存成功 →
       重开弹窗又看到 22:00–08:00」，家里人以为没清掉，再点一次保存反而把旧值写回库。
       改成按「键有没有定义」判断：settings 里定义了就以它为准，`''` 也算定义。 */
    const pickQuiet = (k) => (s[k] !== undefined && s[k] !== null)
      ? String(s[k]) : String(g[k] || '');
    const quietS = pickQuiet('notifyQuietStart');
    const quietE = pickQuiet('notifyQuietEnd');
    openModal({
      title: '内容通知 · 全家默认',
      body: `
        <label class="field"><span>家人新增 / 修改内容时是否通知</span>
          <select data-mk="aNotifyOn">
            <option value="1"${on ? ' selected' : ''}>开启通知</option>
            <option value="0"${on ? '' : ' selected'}>关闭通知（全家都不再通知）</option>
          </select></label>
        <div class="field"><span>通知哪些内容</span>
          <div class="kind-grid">
            ${allKinds.map((k) => `<label class="check-line"><input type="checkbox" data-mk="akind-${k}"${cur.includes(k) ? ' checked' : ''}><span>${esc(kindLabel(k))}</span></label>`).join('')}
          </div>
        </div>
        <div class="field"><span>免打扰时段<span class="field-hint">（留空 = 不启用，有变更就立刻提醒）</span></span>
          <div class="time-grid">
            <label><span>开始</span><input type="time" data-mk="aQuietStart" value="${esc(quietS)}"></label>
            <label><span>结束</span><input type="time" data-mk="aQuietEnd" value="${esc(quietE)}"></label>
          </div>
          <small class="field-hint">这段时间内不发通知（可跨零点），期间的变更攒着，
            <b>免打扰一结束就合并成一封</b>发出去。只填一个或起止同一时刻按「未启用」处理。</small></div>
        <!-- v4.15.0 需求 8：防轰炸阈值从写死的 20 封/分改成可调。
             调大 = 短时间内允许发更多封（人多、改得勤的时候有用）；
             调小 = 更保守，宁可漏一点也不炸邮箱。 -->
        <div class="field"><span>防轰炸上限<span class="field-hint">（一分钟最多发几封，1–500）</span></span>
          <div class="row"><div class="r-label"><b>每分钟最多</b>
            <small>超过就暂停发送、只计数不补发；默认 20 封</small></div>
            <input type="number" class="inp-compact" data-mk="aMaxPerMin" min="1" max="500" inputmode="numeric"
                   value="${esc(String(Number(s.notifyMaxPerMin || g.notifyMaxPerMin || 20)))}"></div></div>
        ${myChannelSelect('notify')}
        ${msgTplBlock('notify')}
        <div class="note-box">成员可以选「跟随管理员」，也可以自己指定要收哪几类（只能收窄）。</div>`,
      foot: `<button type="button" class="btn-ghost" data-act="modal-close">取消</button>
        <button type="button" class="btn-primary" data-act="admin-msg-save" data-which="notify">保存</button>`,
    });
  }

  /** 保存管理员从「消息提醒」弹窗里改的那一组家庭默认 */
  async function saveAdminMsgForm(which) {
    const body = {};
    if (which === 'remind') {
      const t = modalValue('aRemindTime').trim();
      if (t && !timeOk(t)) { toast('提醒时间格式不正确', 'err'); return; }
      body.remindEnabled = modalValue('aRemindOn') !== '0';
      body.remindDefaultTime = t || '08:00';
      body.remindAdvanceDays = Number(modalValue('aAdvance')) || 0;
    } else {
      const qs = modalValue('aQuietStart').trim();
      const qe = modalValue('aQuietEnd').trim();
      if (qs && !timeOk(qs)) { toast('免打扰开始时间格式不正确', 'err'); return; }
      if (qe && !timeOk(qe)) { toast('免打扰结束时间格式不正确', 'err'); return; }
      body.notifyOnChange = modalValue('aNotifyOn') !== '0';
      body.notifyKinds = $$('#modal-layer [data-mk^="akind-"]').filter((el) => el.checked)
        .map((el) => el.dataset.mk.slice(6));
      // v4.14.0：不再提交 notifyDigestTime（服务端也会忽略这个字段）
      body.notifyQuietStart = qs;
      body.notifyQuietEnd = qe;
      // v4.15.0 需求 8：防轰炸阈值（1–500，服务端也会再校一次）
      const mx = Number(modalValue('aMaxPerMin'));
      if (!Number.isFinite(mx) || mx < 1 || mx > 500) { toast('防轰炸上限需在 1 ~ 500 之间', 'err'); return; }
      body.notifyMaxPerMin = Math.round(mx);
    }
    try {
      const out = await api('/api/settings', { method: 'POST', body });
      state.settings = out.settings;
      closeModal();
      render();
      toast('已保存，全家生效', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  function openPrefsForm() {
    const g = state.prefsGlobal || {};
    const p = state.prefs || {};
    if (!prefsDraft) prefsDraft = Object.assign({}, p);
    const d = prefsDraft;

    const tri = (key, cur) => `
      <div class="segmented seg-wrap prefs-tri" data-pref="${key}">
        <button type="button" data-val="" class="${cur === '' || cur == null ? 'on' : ''}">跟随管理员</button>
        <button type="button" data-val="1" class="${cur === '1' ? 'on' : ''}">开启</button>
        <button type="button" data-val="0" class="${cur === '0' ? 'on' : ''}">关闭</button>
      </div>`;

    const globalLine = (text, on) =>
      `<div class="prefs-global">管理员的当前设置：<b class="${on ? '' : 'pref-off'}">${esc(text)}</b></div>`;

    const quietRow = (sk, ek) => `
      <div class="prefs-quiet">
        <label class="field field-sm"><span>免打扰开始</span>
          <input type="time" data-pref="${sk}" value="${esc(d[sk] || '')}"></label>
        <span class="prefs-dash">–</span>
        <label class="field field-sm"><span>免打扰结束</span>
          <input type="time" data-pref="${ek}" value="${esc(d[ek] || '')}"></label>
        <button type="button" class="btn-ghost btn-sm" data-act="prefs-clear-quiet" data-sk="${sk}" data-ek="${ek}">清空</button>
      </div>
      <div class="field-hint">留空表示不启用。跨零点也可以，比如 22:00 – 07:00。</div>`;

    // 通知类型：只在「自己指定」时才需要选，跟随管理员时直接显示管理员的名单
    const kindsCur = d.notify_kinds;
    const kindsAll = Object.keys(NOTIFY_KIND_CN);
    /* ★ 「自己指定」的起步名单 = 管理员现在的那份（而不是空）。
       如果从「一个都不勾」起步，用户会以为设置坏了：明明只想去掉一类，却要先把四类全部勾回来。 */
    const kindsStart = String(g.notifyKinds || '').trim() || kindsAll.join(',');
    const picked = (kindsCur === undefined || kindsCur === '')
      ? null                                     // null = 跟随
      : String(kindsCur).split(',').map((s) => s.trim()).filter((s) => kindsAll.includes(s));
    const kindBoxes = kindsAll.map((k) => `
      <label class="prefs-kind"><input type="checkbox" data-pref="kind" value="${k}"
        ${picked && picked.includes(k) ? 'checked' : ''}> ${NOTIFY_KIND_CN[k]}</label>`).join('');

    /* v4.25.0 需求 4：三类内容各自的推送渠道。'' = 跟随「我的推送方式」——这就是默认行为，
       所以老用户打开看到的永远是「跟随」，除非他自己动过。 */
    const chanSel = (key, cur) => `
      <label class="field field-sm"><span>这一类的推送渠道
        <span class="field-hint">（不单独指定就跟随「推送方式」）</span></span>
        <select data-pref="${key}">
          <option value=""${!cur ? ' selected' : ''}>跟随我的推送方式（${esc(PUSH_LABEL[pushChannelOf(state.me)] || '智能')}）</option>
          ${['auto', 'wecom', 'feishu', 'dingtalk', 'mail', 'both'].map((v) => `
            <option value="${v}"${cur === v ? ' selected' : ''}>${esc(PUSH_LABEL[v])}</option>`).join('')}
        </select></label>`;

    const body = `
      <div class="prefs-block">
        <div class="prefs-title">📋 待办提醒</div>
        <div class="prefs-sub">参加的待办到点时，要不要把提醒邮件发到我的收件邮箱。</div>
        ${tri('remind_enabled', d.remind_enabled)}
        ${globalLine(g.remindEnabled === false ? '已整体关闭' : '已开启', g.remindEnabled !== false)}
        <!-- v4.23.0 需求 1：个人默认提醒时间。只影响「新建待办」表单的预填，
             留空 = 跟随管理员（标签上会显示管理员设的是几点）。 -->
        <label class="field field-sm"><span>默认提醒时间
          <span class="field-hint">（新建待办时预填；留空跟随管理员 ${esc(String(g.remindDefaultTime || '08:00'))}）</span></span>
          <input type="time" data-pref="remind_default_time" value="${esc(d.remind_default_time || '')}"></label>
        ${chanSel('channel_todo', d.channel_todo)}
        ${quietRow('remind_quiet_start', 'remind_quiet_end')}
      </div>

      <div class="prefs-block">
        <div class="prefs-title">💬 内容通知</div>
        <div class="prefs-sub">家里别人新增待办 / 发动态 / 存记录本 / 评论时，要不要通知我。</div>
        ${tri('notify_on_change', d.notify_on_change)}
        ${globalLine(g.notifyOnChange === false ? '已整体关闭' : '已开启', g.notifyOnChange !== false)}
        <div class="prefs-kinds">
          <div class="prefs-kinds-head">
            <span>通知内容</span>
            <button type="button" class="btn-ghost btn-sm" data-act="prefs-kinds-follow"
              ${picked === null ? 'disabled' : ''}>跟随管理员</button>
          </div>
          ${picked === null
            ? `<div class="prefs-global">跟随管理员：<b>${esc(kindListCn(g.notifyKinds))}</b>
                 <button type="button" class="btn-ghost btn-sm" data-act="prefs-kinds-pick">自己指定</button></div>`
            : `<div class="prefs-kind-row">${kindBoxes}</div>`}
        </div>
        ${chanSel('channel_notify', d.channel_notify)}
        ${quietRow('notify_quiet_start', 'notify_quiet_end')}
        <!-- v4.15.0 需求 8：防轰炸上限是**家庭级**设置（管理员改），
             成员这边只读展示「现在是多少」，免得看到「已跳过 N 封」却不知道从哪调。 -->
        <div class="field-hint">防轰炸：内容通知一分钟最多发 <b>${notifyMaxPerMin()}</b> 封
          （管理员可在「我的 → 消息推送设置 → 内容通知 → 设置」里调整）。</div>
      </div>`;

    openModal({
      title: '通知设置',
      body,
      foot: `<button type="button" class="btn-ghost" data-act="prefs-cancel">取消</button>
             <button type="button" class="btn-primary" data-act="prefs-save">保存</button>`,
    });
  }

  /** 读一遍弹窗里的免打扰时间与渠道下拉，写回草稿（改时间不需要重开弹窗） */
  function collectPrefsTimes() {
    $$('#modal-layer [data-pref]').forEach((el) => {
      const k = el.dataset.pref;
      if (k === 'kind') return;
      if (el.tagName === 'INPUT' && el.type === 'time') prefsDraft[k] = el.value;
      // v4.25.0 需求 4：三类内容各自推送渠道的下拉框
      if (el.tagName === 'SELECT') prefsDraft[k] = el.value;
    });
  }

  async function savePrefs() {
    if (!prefsDraft) return;
    collectPrefsTimes();
    const body = {};
    /* v4.25.0 需求 4：三类内容各自的推送渠道（空串 = 删掉这一行，沿用「我的推送方式」）。
       记账那一项在「记账推送」弹窗里单独保存，不在这里提交 —— 这里传空会把人家改过的覆盖掉。 */
    ['channel_todo', 'channel_notify'].forEach((k) => {
      body[k] = prefsDraft[k] || '';
    });
    ['remind_enabled', 'notify_on_change'].forEach((k) => {
      const v = prefsDraft[k];
      body[k] = (v === '1' || v === '0') ? v : '';
    });
    ['remind_quiet_start', 'remind_quiet_end', 'notify_quiet_start', 'notify_quiet_end'].forEach((k) => {
      body[k] = prefsDraft[k] || '';
    });
    // v4.23.0 需求 1：个人默认提醒时间（空 = 跟随管理员）
    body.remind_default_time = prefsDraft.remind_default_time || '';
    // 没在「通知内容」那一栏做过选择就是跟随（空串 = 删掉这一行）
    body.notify_kinds = prefsDraft.notify_kinds === undefined ? '' : (prefsDraft.notify_kinds || '');
    try {
      const out = await api('/api/prefs', { method: 'POST', body });
      state.prefs = out.prefs || {};
      prefsDraft = null;
      closeModal();
      render();
      toast('通知设置已保存', 'ok');
    } catch (err) { toast(err.message || '保存失败', 'err'); }
  }

  function openRenameForm() {
    openModal({
      title: '修改昵称',
      body: `<label class="field"><span>昵称</span>
        <input type="text" data-mk="display_name" maxlength="20" value="${esc(state.me.display_name)}"></label>`,
      foot: `<button type="button" class="btn-ghost" data-act="modal-close">取消</button>
        <button type="button" class="btn-primary" data-act="rename-save">保存</button>`,
    });
  }

  function openPasswordForm() {
    openModal({
      title: '修改密码',
      body: `
        <label class="field"><span>当前密码</span><input type="password" data-mk="old_password"></label>
        <label class="field"><span>新密码（至少 6 位）</span><input type="password" data-mk="new_password"></label>`,
      foot: `<button type="button" class="btn-ghost" data-act="modal-close">取消</button>
        <button type="button" class="btn-primary" data-act="password-save">确认修改</button>`,
    });
  }

  /* v1.9.0：修改自己的登录账号。
     ★ 必须验当前密码 —— 用户名是登录凭据的一半，光有已登录的会话不该能改它。
     ★ 改完**不踢会话**：会话表只存 user_id，用户名变了也不影响已登录的设备；
       如果这里强行退出登录，用户改完立刻被踢出去，反而像是「改坏了」。 */
  function openUsernameForm() {
    openModal({
      title: '修改登录账号',
      body: `
        <label class="field"><span>新登录账号（2-20 位中英文、数字或下划线）</span>
          <input type="text" data-mk="username" maxlength="20" value="${esc(state.me.username)}"
                 autocomplete="off" spellcheck="false"></label>
        <label class="field"><span>当前密码</span>
          <input type="password" data-mk="cur_password" autocomplete="new-password"></label>
        <div class="note-box">改完以后，其他设备下次登录要用新账号；已经登录的设备不受影响。
          如果记不住新账号，可以先用管理员账号在「家庭成员」里看 @账号。</div>`,
      foot: `<button type="button" class="btn-ghost" data-act="modal-close">取消</button>
        <button type="button" class="btn-primary" data-act="username-save">确认修改</button>`,
    });
  }

  /* ═══ v4.28.0：管理员查看某个成员的**全部可配置参数** ═══════════
     为什么需要：家人说「我收不到提醒」时，管理员过去只能隔着屏幕猜 ——
     收件邮箱填了没、推送方式选了哪条、个人是不是把提醒关了、企微绑没绑，
     每一条都在不同页面、还都是「他本人才能看到」的。
     现在点一下头像就能看到全部生效值（含「跟随全局」时实际取到了什么）。
     ★ 只读：这里是排查工具，改别人的设置仍然走各自的入口，避免误改。 */
  function memberKv(k, v, tone) {
    const text = String(v == null ? '' : v);
    return `<div class="kv-row"><span class="k">${esc(k)}</span>`
      + `<span class="v${tone ? ' ' + tone : ''}">${esc(text || '—')}</span></div>`;
  }

  function memberKvGroup(title, rows) {
    const body = rows.filter(Boolean).join('');
    if (!body) return '';
    return `<div class="sub-head">${esc(title)}</div><div class="member-kv">${body}</div>`;
  }

  async function openMemberInfo(memberId) {
    const id = Number(memberId);
    if (!id) return;
    let out;
    try {
      out = await api('/api/members/' + id);
    } catch (err) {
      toast(err.message || '读取成员参数失败', 'err');
      return;
    }
    const m = out.member || {};
    const p = out.prefs || {};
    const e = out.effective || {};
    const g = out.global || {};
    const ch = out.channelsReady || {};
    const bind = out.bind || {};
    const cnt = out.counts || {};
    const label = (v) => PUSH_LABEL[v] || PUSH_LABEL.auto;
    const yn = (v) => (v ? '开' : '关');
    const tone = (v) => (v ? 'on' : 'off');
    const themeName = m.theme && THEME_META[m.theme] ? THEME_META[m.theme].name : '默认主题';
    const kindCn = { todo: '待办', post: '动态', record: '记录本', comment: '评论' };
    const kinds = Array.isArray(e.notifyKinds) ? e.notifyKinds : [];
    const quiet = (s, en) => (s || en ? `${s || '—'} – ${en || '—'}` : '未设');
    const readyCn = (x) => (!x ? '未知' : !x.ready ? '未配置 / 未启用' : x.enabled ? '已就绪' : '已配置但被家庭开关关掉');

    openModal({
      title: `成员参数 · ${m.display_name || m.username || ''}`,
      body: `
        ${memberKvGroup('账号与身份', [
          memberKv('昵称', m.display_name),
          memberKv('登录账号', '@' + String(m.username || '')),
          memberKv('角色', m.is_admin ? '管理员' : '普通成员', m.is_admin ? 'on' : ''),
          memberKv('界面主题', themeName),
          memberKv('创建时间', m.created_at ? String(m.created_at).slice(0, 10) : ''),
          memberKv('自定义头像', m.avatar ? '已上传' : '未上传（用昵称首字）'),
        ])}
        ${memberKvGroup('登录与安全', [
          memberKv('记录本访问密码', m.record_lock_enabled
            ? `已开启（${m.record_lock_custom ? '自定义密码' : '复用登录密码'}）` : '未开启', m.record_lock_enabled ? 'on' : 'off'),
          memberKv('企业微信绑定', bind.bound ? String(bind.wecomUser || '已绑定') : '未绑定', bind.bound ? 'on' : 'off'),
          memberKv('企业微信应用', readyCn({ ready: bind.ready, enabled: ch.wecom && ch.wecom.enabled })),
        ])}
        ${memberKvGroup('推送通道', [
          memberKv('推送方式（默认通道）', label(m.push_channel)),
          memberKv('待办类通道（含记录本提醒）', label(e.channels && e.channels.todo)),
          memberKv('内容通知通道', label(e.channels && e.channels.notify)),
          memberKv('记账推送通道', label(e.channels && e.channels.bill)),
          memberKv('收件邮箱', m.notify_email || '未设置', m.notify_email ? '' : 'off'),
          memberKv('邮件通道', readyCn(ch.mail)),
          memberKv('企业微信通道', readyCn(ch.wecom)),
          memberKv('飞书通道', readyCn(ch.feishu)),
          memberKv('钉钉通道', readyCn(ch.dingtalk)),
        ])}
        ${memberKvGroup('待办提醒', [
          memberKv('全家总开关', yn(g.remindEnabled), tone(g.remindEnabled)),
          memberKv('个人开关', p.remind_enabled == null ? '跟随全家' : yn(p.remind_enabled !== '0')),
          memberKv('实际是否收提醒', yn(e.remindEnabled), tone(e.remindEnabled)),
          memberKv('默认提醒时间', e.remindDefaultTime || g.remindDefaultTime || '08:00'),
          memberKv('提前提醒（家庭设置）', Number(g.advanceDays) > 0 ? `提前 ${g.advanceDays} 天` : '当天'),
          memberKv('免打扰', quiet(e.remindQuietStart, e.remindQuietEnd)),
        ])}
        ${memberKvGroup('内容通知', [
          memberKv('全家总开关', yn(g.notifyOnChange), tone(g.notifyOnChange)),
          memberKv('个人开关', p.notify_on_change == null ? '跟随全家' : yn(p.notify_on_change !== '0')),
          memberKv('实际是否收通知', yn(e.notifyOnChange), tone(e.notifyOnChange)),
          memberKv('接收类型', kinds.length ? kinds.map((k) => kindCn[k] || k).join(' / ') : '全部（跟随全家）'),
          memberKv('免打扰', quiet(p.notify_quiet_start, p.notify_quiet_end)),
          memberKv('每分钟上限（全家）', `${Number(g.notifyMaxPerMin) || 20} 条`),
        ])}
        ${memberKvGroup('数据概览', [
          memberKv('待办', `${Number(cnt.todos) || 0} 条`),
          memberKv('记录本', `${Number(cnt.records) || 0} 条`),
          memberKv('动态', `${Number(cnt.posts) || 0} 条`),
          memberKv('账单', `${Number(cnt.bills) || 0} 笔`),
        ])}
        <div class="note-box" style="margin-top:12px">这里是当前生效的值：个人没有单独设置的项目，显示的是他从家庭设置里取到的默认值。本页只读，修改仍请到对应入口操作。</div>`,
      foot: '<button type="button" class="btn-ghost" data-act="modal-close">关闭</button>',
    });
  }

  function openResetForm(memberId, name) {
    openModal({
      title: `为 ${name} 重置密码`,
      body: `
        <div class="note-box">重置后该成员在其它设备上的登录会立即失效，请把新密码告诉他本人。</div>
        <label class="field"><span>新密码（至少 6 位）</span><input type="password" data-mk="new_password"></label>`,
      foot: `<button type="button" class="btn-ghost" data-act="modal-close">取消</button>
        <button type="button" class="btn-primary" data-act="member-reset-save" data-id="${memberId}">确认重置</button>`,
    });
  }

  /* —— 管理员处理家庭成员的「记录本访问密码」 ——
     场景：成员自己设了自定义访问密码又忘了，家里没有邮件服务，只能由管理员兜底。
     两种操作：重置为登录密码 / 清空并关闭。 */

  function openMemberLockForm(memberId, name, lockOn) {
    openModal({
      title: `${name} · 记录本访问密码`,
      body: `
        <div class="note-box">当前状态：${lockOn
          ? '已开启 —— 该成员打开记录本需要先输入访问密码。'
          : '未开启 —— 该成员打开记录本无需密码。'}</div>
        <div class="row-list">
          <div class="row">
            <div class="r-label"><b>重置为登录密码</b>
              <small>清掉自定义访问密码，改用 TA 自己的登录密码解锁（TA 忘记自定义密码时用这个）</small></div>
            <button type="button" class="btn-soft btn-sm" data-act="member-lock-do" data-id="${memberId}" data-action="reset">重置</button>
          </div>
          <div class="row">
            <div class="r-label"><b>清空并关闭</b>
              <small>关闭记录本访问密码，打开记录本不再需要输入密码</small></div>
            <button type="button" class="btn-danger btn-sm" data-act="member-lock-do" data-id="${memberId}" data-action="off">清空</button>
          </div>
        </div>
        <div class="note-box">两种操作都会让 TA 已登录设备上的解锁状态立即失效，需要重新输入一次密码。</div>`,
      foot: '<button type="button" class="btn-ghost" data-act="modal-close">关闭</button>',
    });
  }

  async function adminMemberLock(memberId, action) {
    const tip = action === 'reset'
      ? '确定把该成员的自定义访问密码重置为「使用登录密码」吗？'
      : '确定清空并关闭该成员的记录本访问密码吗？';
    if (!window.confirm(tip)) return;
    try {
      await api(`/api/members/${memberId}/record-lock`, { method: 'POST', body: { action } });
      closeModal();
      await refreshMembers();
      render();
      toast(action === 'reset' ? '已重置为登录密码' : '已清空并关闭访问密码', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  /* —— 记录本访问密码 —— */

  /**
   * 记录本访问密码弹窗（v1.7.0 重做）
   *  · 未开启：选「复用登录密码 / 自定义密码」后开启。
   *  · 已开启：同一弹窗里既能**改**（换自定义密码 / 改回复用登录密码）也能**关**。
   *    两种情况都只需填一个「当前密码」——**原访问密码或登录密码都认**（v1.7.0 起）。
   *  ⚠️ 校验用的输入框固定叫 data-mk="lockpw"（首次开启时它同时就是新密码），
   *     改密码时的「新密码」另起一个 data-mk="newlockpw"，两者别混。
   */
  function openRecordLockForm() {
    const on = !!state.me.record_lock_enabled;
    const custom = !!state.me.record_lock_custom;
    const modePicker = `
      <div class="field"><span>${on ? '修改为' : '密码方式'}</span>
        <div class="segmented" data-act="lock-mode-pick">
          <button type="button" data-mode="login" class="${custom ? '' : 'on'}">复用登录密码</button>
          <button type="button" data-mode="custom" class="${custom ? 'on' : ''}">自定义密码</button>
        </div>
      </div>`;
    const body = on ? `
        <div class="note-box">记录本已上锁。可以改访问密码，也可以直接关闭校验；关闭后打开记录本不再需要密码。
          <br>「当前密码」填<b>原访问密码或登录密码</b>都可以。</div>
        <label class="field"><span>当前密码（原访问密码或登录密码）</span>
          <input type="password" data-mk="lockpw" autocomplete="off"></label>
        ${modePicker}
        <label class="field${custom ? '' : ' hidden'}" id="lock-new-pw"><span>新访问密码（至少 4 位）</span>
          <input type="password" data-mk="newlockpw" autocomplete="new-password"></label>`
      : `
        <div class="note-box">开启后，每次打开记录本都需要先输入密码解锁；关闭页面再打开也要重新输入（解锁只在本次打开期间有效）。可以选择复用登录密码，或单独设一个访问密码。</div>
        ${modePicker}
        <label class="field" id="lock-mode-hint"><span>输入登录密码以确认开启</span>
          <input type="password" data-mk="lockpw" autocomplete="off"></label>`;
    openModal({
      title: on ? '记录本访问密码' : '开启记录本访问密码',
      body,
      foot: on
        ? `<button type="button" class="btn-ghost" data-act="modal-close">取消</button>
           <button type="button" class="btn-ghost" data-act="lock-disable-save">关闭校验</button>
           <button type="button" class="btn-primary" data-act="lock-enable-save">保存修改</button>`
        : `<button type="button" class="btn-ghost" data-act="modal-close">取消</button>
           <button type="button" class="btn-primary" data-act="lock-enable-save">开启校验</button>`,
      onMount: (layer) => {
        layer.dataset.mode = custom ? 'custom' : 'login';
        layer.dataset.changing = on ? '1' : '0';
      },
    });
  }

  async function saveRecordLock(enable) {
    const layer = $('#modal-layer');
    if (!layer) return;
    const pw = modalValue('lockpw');
    const mode = layer.dataset.mode || 'login';
    const changing = layer.dataset.changing === '1';
    let body;
    if (enable) {
      body = changing
        // 改密码：先证明「进得来」（原访问密码或登录密码），再决定改成什么
        ? { enabled: true, mode, currentPassword: pw, password: mode === 'custom' ? modalValue('newlockpw') : '' }
        // 首次开启：lockpw 本身就是「登录密码」或「新设的访问密码」
        : { enabled: true, mode, password: pw };
    } else {
      body = { enabled: false, currentPassword: pw };
    }
    if (enable && changing && mode === 'custom' && String(body.password || '').length < 4) {
      toast('新访问密码至少 4 位', 'err');
      return;
    }
    if (!enable || changing || mode === 'login') {
      if (!pw) { toast('请输入当前密码', 'err'); return; }
    }
    try {
      const out = await api('/api/me/records-lock', { method: 'POST', body });
      state.me = out.user;
      closeModal();
      render();
      toast(!enable ? '记录本访问密码已关闭'
        : changing ? '访问密码已修改' : '记录本已上锁，下次打开需先解锁', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  /* —— 提醒收件邮箱（管理员与普通用户都可在「我的」页配置自己的） —— */

  function openNotifyEmailForm() {
    const cur = state.me.notify_email || '';
    openModal({
      title: '提醒收件邮箱',
      body: `
        <label class="field"><span>收件邮箱（留空表示不接收提醒）</span>
          <input type="email" data-mk="email" maxlength="254" value="${esc(cur)}" placeholder="例如：xxxx@qq.com"></label>
        <div class="note-box">待办到点时，系统会把提醒邮件发到这个邮箱。只有你参与（被列为参与人）的待办才会提醒你。</div>`,
      foot: `<button type="button" class="btn-ghost" data-act="modal-close">取消</button>
        <button type="button" class="btn-primary" data-act="notify-email-save">保存</button>`,
      onMount: (layer) => { const f = layer.querySelector('[data-mk="email"]'); if (f && !cur) setTimeout(() => f.focus(), 60); },
    });
  }

  async function saveNotifyEmail() {
    const email = modalValue('email').trim();
    try {
      const out = await api('/api/me/notify-email', { method: 'POST', body: { email } });
      state.me = out.user;
      closeModal();
      render();
      toast(email ? '收件邮箱已保存' : '已清除收件邮箱', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  /* —— v4.7.0 需求 2：推送方式（邮件 / 企业微信 / 两者） —— */

  /**
   * v4.13.0（问题 1/7）：跳到「我的 → 推送配置」并展开。
   * 三处复用：账单推送设置里的「配置」、推送方式保存后的提醒弹窗、系统状态。
   */
  async function gotoPushConfig() {
    if (!state.me || !state.me.is_admin) {
      toast('推送渠道只有管理员能修改', 'err');
      return;
    }
    state.tab = 'me';
    state.meOpen = Object.assign({}, state.meOpen, { push: true });
    render();
    const fold = document.querySelector('#view-me [data-act="me-fold"][data-key="push"]');
    const box = fold && fold.closest('.me-fold');
    if (box && typeof box.scrollIntoView === 'function') {
      try { box.scrollIntoView({ block: 'center' }); } catch { /* 老浏览器忽略 */ }
    }
  }

  /** 选完推送方式后的「配置提醒」：说清这种方式还差什么，并给一个直达入口 */
  function openPushChannelHint(ch) {
    const { bound, ready, wecomUser } = pushInfoOf(state.me);
    const needMail = ch === 'mail' || ch === 'both';
    const needWx = ch === 'wecom' || ch === 'both';
    const isHook = ch === 'feishu' || ch === 'dingtalk';
    const hookLabel = ch === 'feishu' ? '飞书' : '钉钉';
    const blocks = [];
    if (needMail) {
      blocks.push(`<div class="note-box">
        <b>邮件推送需要先配好发件邮箱</b>：服务器、端口、发件邮箱、授权码四项都要填，
        否则邮件发不出去。这项是<b>家庭级</b>配置，只有管理员能改。</div>`);
    }
    if (isHook) {
      const st = (state.settings || null);
      const hookSt = st ? (ch === 'feishu' ? st.feishuStatus : st.dingtalkStatus) : null;
      blocks.push(`<div class="note-box">
        <b>${hookLabel}群推送需要管理员先建一个群机器人</b>：在${hookLabel}群里添加「自定义机器人」，
        把 Webhook 地址填进「推送渠道设置 → ${hookLabel}推送」。<br>
        当前：${st
          ? (hookSt && hookSt.configured ? '已配置 · 消息会发到群里，全家可见' : '<span class="warn-text">还没配置 Webhook</span>')
          : '配置由管理员维护（成员看不到详情）'}。</div>`);
    }
    if (needWx) {
      blocks.push(`<div class="note-box">
        <b>企业微信推送需要两件事</b>：① 管理员启用企业微信应用（CorpID / Secret / AgentID）；
        ② 把你的企业微信 UserID 对应到你的家庭账号。<br>
        当前：${ready ? '应用已启用' : '<span class="warn-text">应用未启用</span>'} ·
        ${bound ? `已绑定（UserID：${esc(wecomUser)}）` : '<span class="warn-text">还没绑定</span>'}</div>`);
    }
    if (!blocks.length) return;
    openModal({
      title: isHook ? `还要配置${hookLabel}群机器人`
        : ch === 'mail' ? '还要配置邮件' : (ch === 'wecom' ? '还要绑定企业微信' : '两条通道都要配'),
      body: `${blocks.join('')}
        <div class="note-box">你可以先去配置，也可以先这样用 —— 没配好之前这条通道发不出消息，
        界面上会一直标注原因，不会静默丢失。</div>`,
      foot: `${state.me && state.me.is_admin ? '<button type="button" class="btn-ghost" data-act="push-hint-goto">去推送配置</button>' : ''}
        <button type="button" class="btn-primary" data-act="modal-close">知道了</button>`,
    });
  }

  /**
   * v4.25.0 需求 2：**区分已启用 / 未启用**的推送渠道。
   *
   * 数据来自两处：
   *   · `state.me.push_channels`（服务端 withPushInfo 下发，成员也能拿到）—— 家庭开关 + 是否配置齐全；
   *   · `state.settings`（仅管理员）—— 用来把「未启用」细化成「总开关关着」还是「还没配」。
   * 没有 settings 时（成员）就说「由管理员配置」，不猜。
   */
  function channelStatusOf(ch) {
    const pc = (state.me && state.me.push_channels) || {};
    const s = state.settings || null;
    const adminNote = !s;
    const base = (name, offKey, offText, noCfgText) => {
      const st = pc[name];
      const enabled = st ? !!st.enabled : null;
      if (enabled === true) return { enabled: true, text: '已启用' };
      const off = s ? s[offKey] === false : false;
      return {
        enabled: false,
        text: off ? `未启用：${offText}` : (adminNote ? `未启用（${noCfgText}，由管理员配置）` : `未启用：${noCfgText}`),
      };
    };
    if (ch === 'mail') return base('mail', 'pushMailEnabled', '「邮件推送」总开关关着', '还没配发件邮箱');
    if (ch === 'wecom') return base('wecom', 'pushWecomEnabled', '「企业微信推送」总开关关着', '企业微信应用未启用');
    if (ch === 'feishu') return base('feishu', 'pushFeishuEnabled', '「飞书推送」总开关关着', '还没配飞书群机器人');
    if (ch === 'dingtalk') return base('dingtalk', 'pushDingtalkEnabled', '「钉钉推送」总开关关着', '还没配钉钉群机器人');
    if (ch === 'both') {
      const a = base('wecom', 'pushWecomEnabled', '「企业微信推送」总开关关着', '企业微信应用未启用');
      const b = base('mail', 'pushMailEnabled', '「邮件推送」总开关关着', '还没配发件邮箱');
      /* 文案口径必须与上面四项一致（都以「未启用：」开头），否则弹窗里这一条看起来像另一种状态。 */
      return { enabled: a.enabled && b.enabled, text: a.enabled && b.enabled ? '两条都已启用' : '未启用：邮件与企业微信没有同时启用' };
    }
    /* auto = 智能路由：只要有一条即时通道能用就算可用 */
    const wx = (pc.wecom && pc.wecom.enabled) || false;
    const ml = (pc.mail && pc.mail.enabled) || false;
    return wx || ml
      ? { enabled: true, text: wx ? '已启用（优先企业微信）' : '已启用（走邮件）' }
      : { enabled: false, text: '未启用：企业微信与邮件都不能用' };
  }

  function openPushChannelForm() {
    const cur = pushChannelOf(state.me);
    const { bound, ready } = pushInfoOf(state.me);
    const bindLine = !ready
      ? '企业微信应用还没启用，选「智能」时目前会走邮件。'
      : bound
        ? `已绑定企业微信账号（UserID：${esc(pushInfoOf(state.me).wecomUser)}）。`
        : '你还没绑定企业微信账号 —— 需要管理员在下方「企业微信」区块里把你的企业微信 UserID 对应到你的家庭账号，绑定后才会真正发到企业微信。';
    /* v4.25.0 需求 2：每个选项后面直接标状态 —— 不用选完才知道「这条根本发不出去」。 */
    const OPTS = [
      ['auto', '智能（推荐）· 优先企业微信，发不出去自动回退邮件'],
      ['wecom', '仅企业微信 · 只发企微，失败不转邮件'],
      ['feishu', '飞书群 · 发到管理员配置的飞书群机器人'],
      ['dingtalk', '钉钉群 · 发到管理员配置的钉钉群机器人'],
      ['mail', '只用邮件'],
      ['both', '邮件 + 企业微信（两条都发）'],
    ];
    const optHtml = OPTS.map(([v, label]) => {
      const st = channelStatusOf(v);
      const tag = st.enabled ? '（已启用）' : `（${esc(st.text)}）`;
      return `<option value="${v}"${cur === v ? ' selected' : ''}>${esc(label)}${tag}</option>`;
    }).join('');
    const onList = OPTS.map(([v]) => v).filter((v) => channelStatusOf(v).enabled)
      .map((v) => PUSH_LABEL[v]).filter(Boolean);
    const offList = ['wecom', 'feishu', 'dingtalk', 'mail'].filter((v) => !channelStatusOf(v).enabled)
      .map((v) => PUSH_LABEL[v]);
    openModal({
      title: '推送方式',
      body: `
        <div class="note-box">
          <b>已启用</b>：${onList.length ? esc(onList.join('、')) : '<span class="warn-text">暂无（管理员还没配好任何通道）</span>'}<br>
          <b>未启用</b>：${offList.length ? esc(offList.join('、')) : '无'}
          <br><span class="field-hint">未启用的通道也可以先选上 —— 管理员配置好之后自动生效，不用回来重选。
            想知道每条为什么没启用，看下面选项括号里的原因。</span>
        </div>
        <label class="field"><span>待办提醒与内容通知发到哪里</span>
          <select data-mk="pushChannel">${optHtml}</select></label>
        <div class="note-box">
          <b>智能（默认）</b>：先发企业微信；没绑定、应用没启用或发送失败时，<b>自动回退邮件</b>，不会漏消息。<br>
          <b>仅企业微信</b>：只走企业微信，<b>失败也不发邮件</b> —— 确定自己只看企微、不想邮箱收到时才选它。<br>
          <b>飞书群 / 钉钉群</b>：发到管理员配好的群机器人所在的群里，<b>全家可见</b>；机器人没配好或发送失败不会转成邮件。<br>
          <b>只用邮件</b>：完全不经即时消息。<br>
          <b>两条都发</b>：同一份内容同时到邮箱和企业微信。<br>
          无论选哪种，<b>各条通道看到的消息内容完全一样</b>：同样的标题、同样的正文。<br>
          这一项是<b>全局默认</b>；待办 / 内容 / 记账三类还可以在各自的设置里单独指定通道（不指定就跟着这里走）。
        </div>
        <div class="note-box">${bindLine}</div>`,
      foot: `<button type="button" class="btn-ghost" data-act="modal-close">取消</button>
        <button type="button" class="btn-primary" data-act="push-channel-save">保存</button>`,
    });
  }

  async function savePushChannel() {
    const channel = modalValue('pushChannel');
    try {
      const out = await api('/api/me/push-channel', { method: 'POST', body: { channel } });
      state.me = out.user;
      closeModal();
      render();
      const ch = pushChannelOf(state.me);
      toast(`推送方式已改为「${PUSH_LABEL[ch]}」`, 'ok');
      /* v4.13.0（问题 7）：选完方式就把「这种方式还差什么」摆出来 ——
         以前选完只是存了一下，用户并不知道自己还没配发件邮箱 / 还没绑定企微。 */
      openPushChannelHint(ch);
    } catch (err) { toast(err.message, 'err'); }
  }

  /* —— 自定义头像（v1.6.0） —— */

  function openAvatarForm() {
    const has = !!(state.me && state.me.avatar);
    openModal({
      title: '更换头像',
      body: `
        <div class="avatar-preview">${avatarHtml(state.me.display_name, 'me-avatar')}</div>
        <div class="note-box">选一张照片作为你的头像：会自动按中心裁成方形并压缩，不用自己先处理。
          头像会出现在「我的」、动态与评论里，家里人都能看到。</div>
        <div class="row-list">
          <div class="row">
            <div class="r-label"><b>上传新头像</b><small>支持 JPG / PNG，单张不超过 ${maxImgMb()}MB</small></div>
            <button type="button" class="btn-soft btn-sm" data-act="avatar-pick">选择图片</button>
          </div>
          ${has ? `<div class="row">
            <div class="r-label"><b>恢复默认头像</b><small>改回「昵称首字」的彩色圆</small></div>
            <button type="button" class="btn-ghost btn-sm" data-act="avatar-reset">恢复默认</button>
          </div>` : ''}
        </div>
        <input type="file" accept="image/*" class="hidden" id="avatar-file">`,
      foot: '<button type="button" class="btn-ghost" data-act="modal-close">关闭</button>',
    });
  }

  /** 头像专用压缩：中心裁成正方形 + 缩到 256px，体积很小，不必走通用图片通道 */
  function encodeAvatar(img, size, quality) {
    const w0 = img.width || img.naturalWidth || 1;
    const h0 = img.height || img.naturalHeight || 1;
    const side = Math.max(1, Math.min(w0, h0));
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    canvas.getContext('2d').drawImage(img, (w0 - side) / 2, (h0 - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', quality);
  }

  async function uploadAvatar(file, onProgress) {
    const name = file.name || '这张图片';
    if (!looksLikeImage(file)) throw new Error(`「${name}」不是图片，请选择 JPG / PNG`);
    const raw = await readAsDataUrl(file);
    const img = await decodeImage(raw);
    if (!img) throw new Error(`「${name}」浏览器无法识别，请换成 JPG / PNG（iPhone 的 HEIC 请先导出为 JPG）`);
    // 先按 256 压，个别图仍偏大时再压到 160
    let out = '';
    try { out = encodeAvatar(img, 256, 0.82); } catch { /* 交给下一档 */ }
    if (!out || dataUrlBytes(out) > maxImgMb() * 1024 * 1024) out = encodeAvatar(img, 160, 0.7);
    const res = await xhrUpload('/api/me/avatar', { dataUrl: out }, onProgress);
    state.me = res.user;
    await refreshMembers();
    closeModal();
    render();
    toast('头像已更新', 'ok');
  }

  async function resetAvatar() {
    try {
      const out = await api('/api/me/avatar', { method: 'POST', body: {} });
      state.me = out.user;
      await refreshMembers();
      closeModal();
      render();
      toast('已恢复默认头像', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  /* —— 管理员家庭设置 —— */

  const TTL_CHOICES = [12, 24, 72, 168, 720, 8760];
  const ttlLabel = (h) => (h >= 24 ? `${h / 24} 天` : `${h} 小时`);

  /* 时区：待办上的日期/时间按这里选的时区理解。容器是 UTC 也不受影响 —— 提醒时刻
     不再依赖服务器本地时区（这正是不改这项会「提醒晚 8 小时」的原因）。 */
  const TZ_CHOICES = [
    [480, '东八区 · 北京时间（UTC+8）'],
    [540, '东九区 · 东京 / 首尔（UTC+9）'],
    [420, '东七区 · 曼谷 / 雅加达（UTC+7）'],
    [0, 'UTC · 伦敦（冬令时）'],
    [-300, '美国东部（UTC-5）'],
    [-480, '美国太平洋（UTC-8）'],
  ];

  /** 提醒运行状态区块：提醒是后台行为，必须把「上一轮发生了什么」摊开给管理员看。
   *  v1.7.0 精简：原来 4~5 行压到 3 行 —— 「开关」与「发件配置」并成一行、
   *  扫描时间与扫描条数并成一行、按钮旁的长说明缩成一句话。
   *  信息一条没少，整块高度约为原来的三分之二。
   *  ★ v4.14.0 需求 3：再改一次形态 —— 原来每条都是「粗标题 + 一长串小字」，
   *    行数一多就变成一大片灰字堆叠，扫读全靠逐行读。
   *    现在拆成「一行状态徽标 + 四格指标 + 最多两句补充」：
   *    时间 / 条数 / 封数 / 人数各占一格，长解释压到下面单独一行（没有就不占位）。 */
  /**
   * 运行状态的一格指标。值可能很长（日期时间），用 CSS 单行省略，
   * 不让它把栅格撑破 —— 三格变两行比「一格很宽、旁边空着」更难读。
   */
  function rsCell(label, value, tone, wide) {
    return `<div class="rs-cell${wide ? ' wide' : ''}"><span>${esc(label)}</span>`
      + `<b class="${tone || ''}" title="${esc(value)}">${esc(value)}</b></div>`;
  }

  /** 状态徽标的三种语气：正常 / 需要注意 / 已关闭 */
  const RS_PILL = {
    ok: ['ok', '正常运行'],
    warn: ['warn', '需要处理'],
    off: ['off', '已关闭'],
  };
  function rsPill(tone, text) {
    const t = RS_PILL[tone] || RS_PILL.ok;
    return `<span class="rs-pill ${t[0]}">${esc(text || t[1])}</span>`;
  }

  function remindStatusBlock(s) {
    /* ★ v4.12.0：「运行状态」从「家庭设置」弹窗搬进「我的 → 消息提醒」，
       而「我的」是**登录后第一眼就会渲染**的页面 —— 它的 s（state.settings）
       在 /api/settings 回来之前是 null。以前这段代码只在弹窗里用（那时 s 一定有值），
       搬过来后 `s.remindStatus` 会在冷启动/刚登录时抛 TypeError，
       把整个 meHtml 打断（结果是「我的」页空白，甚至卡在登录页）。这里补 null 兜底。 */
    if (!s) {
      return `<div id="remind-status" class="run-state">
          <div class="rs-head"><span class="rs-title">待办提醒</span><span class="rs-pill">加载中…</span></div>
        </div>`;
    }
    const st = s.remindStatus || {};
    const fmt = (iso) => {
      if (!iso) return '尚未扫描';
      const d = new Date(iso);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    const smtpReady = !!(s.smtpUser && s.hasSmtpPass);
    const sent = Number(st.sent) || 0;
    const checked = Number(st.checked) || 0;
    const recipients = Number(st.recipients) || 0;
    const waiting = Number(st.waiting) || 0;
    const expired = Number(st.expired) || 0;
    const pill = !s.remindEnabled ? rsPill('off', '已关闭')
      : (smtpReady ? rsPill('ok', '正常运行') : rsPill('warn', '发件未配置'));

    // 补充说明：把「等邮箱 / 超时 / 失败」这些真需要人动手的事各占一行，没有就不渲染
    const notes = [];
    if (!smtpReady) {
      notes.push({ tone: 'warn', text: '发件邮箱还没保存，到点的提醒发不出去。到「推送配置 → 邮件推送」里填好授权码。' });
    }
    if (waiting) notes.push({ tone: '', text: `${waiting} 条在等参与人配置收件邮箱，配好后下一轮自动补发。` });
    if (expired) notes.push({ tone: '', text: `${expired} 条已超过 48 小时，不再补发。` });
    if (st.errors && st.errors.length) {
      notes.push({ tone: 'danger', text: st.errors.slice(0, 2).join('；') });
    }

    return `<div id="remind-status" class="run-state">
        <div class="rs-head">
          <span class="rs-title">待办提醒</span>
          ${pill}
        </div>
        <div class="rs-grid">
          ${rsCell('上次扫描', fmt(st.at))}
          ${rsCell('检查待办', checked ? `${checked} 条` : '—')}
          ${rsCell('发出提醒', `${sent} 封`)}
          ${rsCell('送达人数', recipients ? `${recipients} 人` : '—')}
        </div>
        ${notes.map((n) => `<div class="rs-line ${n.tone}">${esc(n.text)}</div>`).join('')}
        <div class="status-ops">
          <button type="button" class="btn-ghost btn-sm" data-act="settings-rescan">立即重新扫描</button>
          <span class="status-hint">重查 48 小时内被标记、却没发出去的提醒</span>
        </div>
      </div>`;
  }

  /** 内容变更通知的运行状态：和提醒一样是后台行为，把最近结果摊开给管理员看。
   *  v1.7.0 精简：类型名单并进开关行、去掉多余换行，整块压到 3 行。
   *  ★ v4.14.0 需求 3：与提醒同款「徽标 + 四格指标 + 单行补充」，两块并排看齐。 */
  function notifyStatusBlock(s) {
    /* 同上：s 为 null 时（刚登录、/api/settings 还没回来）不能直接解引用 */
    if (!s) {
      return `<div id="notify-status" class="run-state">
          <div class="rs-head"><span class="rs-title">内容通知</span><span class="rs-pill">加载中…</span></div>
        </div>`;
    }
    const st = s.notifyStatus || {};
    const fmt = (iso) => {
      if (!iso) return '尚未发出';
      const d = new Date(iso);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    const kinds = Array.isArray(st.kinds) && st.kinds.length
      ? st.kinds.map((k) => kindLabel(k)).join('、')
      : '全部类型';
    const sent = Number(st.sent) || 0;
    /* 待发队列 = 免打扰期间攒下的条数。全站免打扰进内存队列（pending），
       个人免打扰进发件箱（outbox），两个加起来才是「现在到底压了多少条」。 */
    const q = s.notifyQueue || {};
    const pendingN = (Number(q.pending) || 0) + (Number(q.outbox) || 0);
    const off = s.notifyOnChange === false;
    const notes = [];
    // 发送时机：v4.14.0 起只有「立即发」和「免打扰期间攒着」两种
    notes.push({ tone: '', text: `发送时机：${notifyTimingSummary(s)}` });
    if (pendingN && q.nextAt) {
      /* ★ 这里不能用 fmtTime()：它是「刚刚 / 3 小时前」这种**过去**口径，
         而此刻是「预计几点发」——未来时间会被算成负差、显示成「刚刚」。
         直接取本地 HH:MM，与设置里填的免打扰结束时刻对得上。 */
      const due = new Date(q.nextAt);
      const hhmm = Number.isNaN(due.getTime()) ? ''
        : `${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')}`;
      if (hhmm) notes.push({ tone: '', text: `${pendingN} 条会合并成一封，预计 ${hhmm} 发出。` });
    }
    if (Number(st.dropped)) notes.push({ tone: 'warn', text: `超过每分钟 ${notifyMaxPerMin()} 封的上限，已跳过 ${Number(st.dropped)} 封（防轰炸，可在「内容通知 → 设置」里调整上限）。` });
    if (st.errors && st.errors.length) notes.push({ tone: 'danger', text: st.errors.slice(0, 2).join('；') });

    return `<div id="notify-status" class="run-state">
        <div class="rs-head">
          <span class="rs-title">内容通知</span>
          ${off ? rsPill('off', '已关闭') : rsPill('ok', '已开启')}
        </div>
        <div class="rs-grid">
          ${rsCell('上次通知', fmt(st.at))}
          ${rsCell('已发出', `${sent} 封`)}
          ${rsCell('待发队列', pendingN ? `${pendingN} 条` : '无')}
          ${rsCell('生效类型', kinds, '', true)}
        </div>
        ${notes.map((n) => `<div class="rs-line ${n.tone}">${esc(n.text)}</div>`).join('')}
      </div>`;
  }

  /* 内容变更通知的四种类型。后端 notify.ALL_KINDS 是权威名单（随 /api/settings 的
     notifyKindsAll 下发），这里的表只负责中文名，缺了就用英文键兜底。 */
  const KIND_LABELS = { todo: '待办事项', post: '动态', record: '记录本', comment: '评论' };
  const kindLabel = (k) => KIND_LABELS[k] || k;

  /** v4.15.0 需求 8：当前生效的防轰炸上限（管理员 settings 优先，成员读全局快照） */
  function notifyMaxPerMin() {
    const s = state.settings || null;
    const g = state.prefsGlobal || null;
    const n = Number((s && s.notifyMaxPerMin) || (g && g.notifyMaxPerMin) || 20);
    return Number.isFinite(n) && n >= 1 ? Math.round(n) : 20;
  }

  /** v4.15.0 需求 3：记账推送（账单日报 / 月报）的运行状态 —— 与上面两块同款形态。
   *  数据来自 `/api/bills/bootstrap` 的 reports（只有管理员下发），
   *  所以成员这边 `state.billMeta.reports` 是 null，整块直接不渲染。 */
  function billPushStatusBlock(s) {
    const rep = (state.billMeta && state.billMeta.reports) || null;
    if (!rep) return '';
    const st = rep.status || {};
    const on = rep.reportsEnabled !== false;
    const at = (iso) => {
      if (!iso) return '尚未发送';
      const d = new Date(iso);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    const failed = /失败|错误|error/i.test(String(st.result || ''));
    const notes = [];
    if (!on) notes.push({ tone: '', text: '日报已关闭，全家都不会收到账单汇总；手动记账不受影响。' });
    if (failed) notes.push({ tone: 'danger', text: String(st.result || '') });
    if (st.errors && st.errors.length) notes.push({ tone: 'danger', text: st.errors.slice(0, 2).join('；') });
    if (on && !failed) {
      notes.push({ tone: '', text: `每天 ${esc(rep.dailyTime || '21:00')} 发一次前一天账单给全家${
        rep.monthlyReport ? '，每月 1 号另发一份月报' : ''}。` });
    }
    /* v4.16.0 需求 4：企业微信这条腿按账号映射投递，一个都没映射就等于发不出去 ——
       这是最容易「看起来开着、其实收不到」的情况，直接在运行状态里点出来。 */
    if (on && rep.channels && rep.channels.wecom && !(Number(rep.wecomRecipientCount) > 0)) {
      notes.push({ tone: 'warn', text: '企业微信还没有可投递的家人：去「推送渠道设置 → 企业微信推送 → 账号映射」对应一下。' });
    }
    return `<div id="bill-push-status" class="run-state">
        <div class="rs-head">
          <span class="rs-title">记账推送</span>
          ${on ? rsPill('ok', '已开启') : rsPill('off', '已关闭')}
        </div>
        <div class="rs-grid">
          ${rsCell('推送时间', rep.dailyTime || '21:00')}
          ${rsCell('日报口径', rep.reportWhen === 'same_day' ? '当天发当天' : '第二天发前一天')}
          ${rsCell('上次发送', at(st.at))}
          ${rsCell('发送结果', st.result || '尚无记录', failed ? 'danger' : '', true)}
        </div>
        ${notes.map((n) => `<div class="rs-line ${n.tone}">${esc(n.text)}</div>`).join('')}
      </div>`;
  }

  /* 提前提醒可选 0-5 天。0 = 当天。 */
  const ADVANCE_CHOICES = [0, 1, 2, 3, 4, 5];
  const advanceLabel = (n) => (Number(n) > 0 ? `提前 ${Number(n)} 天` : '当天提醒');

  /** v4.15.0 需求 7：「我的」默认提醒时间 —— 我这一侧实际生效的那个值。
   *  管理员读自己的 settings，成员读管理员下发的 prefsGlobal；都没有就 08:00。
   *  催促在「没填开始时间」时用的就是它（服务端 urge.js 读的是同一个 settings 键）。 */
  /* v4.23.0 需求 1：新建待办时表单预填的「开始时间」。
     优先级：我自己设的默认时间 → 管理员在「家庭设置 → 待办提醒」里设的默认时间 → 08:00。
     ★ 个人默认时间**只用于预填**：不参与服务端调度，同一条待办对所有参与人仍是同一时刻。
     来源（mine / admin）由 remindTimeInfo() 一并给出，标签上要如实说明「这是谁的默认值」。 */
  function remindTimeInfo() {
    const s = state.settings || null;
    const g = state.prefsGlobal || null;
    const adminRaw = s ? String(s.remindDefaultTime || '') : String((g && g.remindDefaultTime) || '');
    const admin = /^([01]\d|2[0-3]):[0-5]\d$/.test(adminRaw) ? adminRaw : '08:00';
    const mineRaw = String((state.prefs && state.prefs.remind_default_time) || '');
    const mine = /^([01]\d|2[0-3]):[0-5]\d$/.test(mineRaw) ? mineRaw : '';
    return { time: mine || admin, mine: !!mine, admin };
  }

  function myRemindTime() {
    return remindTimeInfo().time;
  }

  /** 「我的」页上的一句话摘要：让管理员不进弹窗也知道提醒会怎么发 */
  function remindSummary(s) {
    const adv = Number(s && s.remindAdvanceDays) || 0;
    const t = (s && s.remindDefaultTime) || '08:00';
    return adv > 0 ? `提前 ${adv} 天 ${t}` : `当天 ${t}`;
  }

  /** 「提前提醒怎么算」的实时示例：让管理员一眼确认设置真的会按提前时间触发 */
  function advanceHint(adv, time) {
    const n = Number(adv) || 0;
    const t = String(time || '08:00');
    if (n <= 0) return `待办日期当天 ${t} 提醒（没有开始时间时按这个时间）。`;
    // 用「今天 + 20 天」举例，避免跨月造成困惑；这里只做文案示意，不参与真实计算
    const d = new Date();
    d.setDate(d.getDate() + 20 + n);
    const ev = `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
    const r = new Date();
    r.setDate(r.getDate() + 20);
    const rm = `${r.getMonth() + 1} 月 ${r.getDate()} 日`;
    return `举例：待办日期是 ${ev}，就会在 ${rm} ${t} 发出提醒（提前 ${n} 天）。`;
  }

  /* —— v1.9.0：内容变更提醒的「什么时候发」 ——
     与 src/notify.js 的 nextSendMoment 保持同一套语义：两个都空 = 立即发；
     免打扰起止相同（或只填一半）= 视为未启用，避免「全天静音」这种不可见的坑。 */
  const timeOk = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
  const quietOn = (s) => timeOk(s && s.notifyQuietStart) && timeOk(s && s.notifyQuietEnd)
    && s.notifyQuietStart !== s.notifyQuietEnd;

  /** 一句话说清「通知什么时候发」。
   *  v4.14.0 需求 4：只有两种形态 —— 变更即发 / 免打扰结束后合并一封。
   *  「汇总时间」这一档已经下线，这里不能再出现「攒到 HH:MM」。 */
  function notifyTimingSummary(s) {
    const quiet = quietOn(s) ? `${s.notifyQuietStart}–${s.notifyQuietEnd}` : '';
    if (!quiet) return '一有变更就立刻提醒';
    return `免打扰 ${quiet}，期间的变更结束后合并成一封`;
  }

  /* ═══ 家庭设置 = 基础配置（v4.12.0 需求 8）═══════════════════════
     需求原文：「家庭设置仅保留基础分类」。原来这里有 5 个页签
     （基础 / 待办提醒 / 内容通知 / 发件邮箱 / 运行状态），
     后四个全是「消息怎么发」的事，已经搬到「我的 → 消息提醒 / 推送配置」。
     留在这里的是「这个家叫什么名字、能不能让新人注册、文件能传多大」——
     这些才是「家庭」本身的基础配置，而且和「谁收到什么通知」互不相关。 */
  function openAdminSettings() {
    const s = state.settings || {
      // 拉设置失败时的兜底：名称沿用前端当前值，确保输入框里有东西、不会被清空
      siteName: APP_NAME,
      defaultSiteName: DEFAULT_APP_NAME,
      siteNameMax: 20,
      allowRegister: state.config.allowRegister,
      sessionTtlHours: 24,
      tzOffsetMinutes: 480,
      imageMaxMb: 10,
      fileMaxMb: 20,
      videoMaxMb: 50,
    };
    openModal({
      title: '家庭设置 · 基础配置',
      body: `
        <div class="set-pane on" data-pane="base">
          <div class="field"><span>站点名称（显示在标题栏、登录页与提醒邮件上）</span>
            <div class="part-add">
              <input type="text" data-mk="siteName" maxlength="${Number(s.siteNameMax) || 20}"
                     value="${esc(s.siteName || DEFAULT_APP_NAME)}"
                     placeholder="${esc(s.defaultSiteName || DEFAULT_APP_NAME)}">
              <button type="button" class="btn-ghost btn-sm" data-act="settings-site-reset">恢复默认</button>
            </div>
            <small class="field-hint">对所有家庭成员生效，保存后立即刷新标题栏；留空即为默认的「${esc(s.defaultSiteName || DEFAULT_APP_NAME)}」。</small>
          </div>
          <div class="field"><span>新成员自助注册</span>
            <div class="segmented" data-act="set-register-pick">
              <button type="button" data-reg="1" class="${s.allowRegister ? 'on' : ''}">允许注册</button>
              <button type="button" data-reg="0" class="${!s.allowRegister ? 'on' : ''}">关闭注册</button>
            </div>
          </div>
          <label class="field"><span>免登录有效期（登录一次后，多久内再打开无需登录）</span>
            <select data-mk="ttl">
              ${TTL_CHOICES.map((h) => `<option value="${h}"${Number(s.sessionTtlHours) === h ? ' selected' : ''}>${ttlLabel(h)}</option>`).join('')}
            </select></label>
          <label class="field"><span>时区（待办日期 / 时间按哪个时区理解）</span>
            <select data-mk="tzOffset">
              ${TZ_CHOICES.map(([v, label]) => `<option value="${v}"${Number(s.tzOffsetMinutes) === v ? ' selected' : ''}>${label}</option>`).join('')}
            </select></label>

          <div class="sub-head">上传大小限制（三个上限各自独立）</div>
          <label class="field"><span>图片上限（1-100 MB）</span>
            <input type="number" data-mk="imageMaxMb" min="1" max="100" step="1"
                   value="${Number(s.imageMaxMb) || 10}" inputmode="numeric">
            <small class="field-hint">动态与记录本的图片。前端会先压缩，正常几百 KB；
              这里放宽是为了照顾「原图不压缩」的少数场景。</small></label>
          <label class="field"><span>附件上限（1-200 MB）</span>
            <input type="number" data-mk="fileMaxMb" min="1" max="200" step="1"
                   value="${Number(s.fileMaxMb) || 20}" inputmode="numeric">
            <small class="field-hint">记录本的附件（PDF / Word / Excel / PPT / 压缩包 / 音视频 / 文本）。</small></label>
          <label class="field"><span>视频上限（5-500 MB）</span>
            <input type="number" data-mk="videoMaxMb" min="5" max="500" step="5"
                   value="${Number(s.videoMaxMb) || 50}" inputmode="numeric">
            <small class="field-hint">动态里单个视频文件。改大之后服务端请求体上限会跟着放宽，不用重启。</small></label>

          <!-- v4.28.0：设置界面也能按人排查 —— 点成员头像看他的全部可配置参数。
               放在这里是因为「为什么他收不到提醒」通常就是在这个页面被发现的。 -->
          <div class="sub-head">成员参数（点头像查看）</div>
          <div class="row-list">
            ${(state.members || []).map((m) => `
              <div class="row member-row">
                <button type="button" class="avatar-link" data-act="member-info" data-id="${m.id}"
                        title="查看 ${esc(m.display_name)} 的全部参数">${avatarHtml(m.display_name)}</button>
                <div class="r-label"><b>${esc(m.display_name)}${m.is_admin ? ' <span class="badge cat">管理员</span>' : ''}</b>
                  <small>@${esc(m.username)}</small></div>
                <button type="button" class="btn-ghost btn-sm" data-act="member-info" data-id="${m.id}">查看参数</button>
              </div>`).join('')}
          </div>
          <small class="field-hint">打开成员参数会关闭本窗口，本页未保存的修改不会保留。</small>
        </div>`,
      foot: `<button type="button" class="btn-ghost" data-act="modal-close">取消</button>
        <button type="button" class="btn-primary" data-act="settings-save">保存</button>`,
      onMount: (layer) => {
        layer.dataset.allowRegister = s.allowRegister ? '1' : '0';
        layer.dataset.tab = 'base';
      },
    });
  }

  /** 切换设置弹窗的页签：只切 CSS 可见性，绝不重建 DOM（否则表单里未保存的内容会丢） */
  function switchSetTab(name) {
    const layer = $('#modal-layer');
    if (!layer) return;
    layer.dataset.tab = name;
    layer.querySelectorAll('.set-tab').forEach((b) => {
      b.classList.toggle('on', b.dataset.tab === name);
    });
    layer.querySelectorAll('.set-pane').forEach((p) => {
      p.classList.toggle('on', p.dataset.pane === name);
    });
    const body = layer.querySelector('.modal-body');
    if (body) body.scrollTop = 0;
  }

  /* v4.12.0：updateAdvanceHint() 随「家庭设置 → 待办提醒」页签一起下线
     （那个页签已并入「我的 → 消息提醒」，用的是 <select> + 就地文案，
     不再需要在输入时刷新示例）。 */

  /* ── 「我的」页内嵌设置的两组保存逻辑（v4.12.0）──────────────
     为什么不复用 saveAdminSettings()：那个函数按「家庭设置弹窗」取整表单，
     一旦把控件搬到页面本体，它的 `layer.dataset.xxx` 就全是 undefined。
     拆成两个只提交自己那几个键的函数，服务端对每个键都有 `!= null` 守卫，
     所以「只提交一部分」是安全的（不会把别的设置覆盖成默认值）。 */

  /** 取页面本体里的控件值（#main，不是弹窗） */
  function pageValue(key) {
    const el = document.querySelector(`#main [data-mk="${key}"]`);
    return el ? el.value : '';
  }

  /* v4.14.0：`saveMessageDefaults()` 连同 `case 'msg-save'` 一起删掉了。
     v4.13.0（问题 9）撤掉「家庭默认」整块表单后，它就再也没有触发入口，
     却还在读 gRemindEnabled / gDigestTime 这些**已经不存在的控件**——
     留着就是一颗「哪天有人手滑恢复按钮就 TypeError」的雷。 */


  /** 保存「推送配置 → 邮件」：只提交 SMTP 四个键 */
  async function saveMailConfig() {
    const pass = pageValue('smtpPass');
    const body = {
      smtpHost: pageValue('smtpHost').trim() || 'smtp.qq.com',
      smtpPort: Number(pageValue('smtpPort')) || 465,
      smtpUser: pageValue('smtpUser').trim(),
    };
    if (pass) body.smtpPass = pass;          // 留空 = 不修改已保存的授权码
    try {
      const out = await api('/api/settings', { method: 'POST', body });
      state.settings = out.settings;
      // 授权码输入框要显式清空：<input> 的 value 不在 outerHTML 里，最小重绘不会替你清
      render();
      toast('发件邮箱已保存', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  async function saveAdminSettings() {
    const layer = $('#modal-layer');
    const body = {
      // 站点名称（v1.8.0）：空串 = 恢复默认。服务端会清洗并按上限截断。
      siteName: modalValue('siteName').replace(/[\r\n\t]/g, ' ').trim(),
      allowRegister: layer && layer.dataset.allowRegister !== '0',
      sessionTtlHours: Number(modalValue('ttl')),
      tzOffsetMinutes: Number(modalValue('tzOffset')),
      /* v4.12.0 需求 2：三个上传上限都进基础配置。
         服务端各自有范围校验（图片 1-100 / 附件 1-200 / 视频 5-500），越界会直接报错，
         前端不在这里重复判断一遍 —— 「保存成功了但没生效」比报错更糟。 */
      imageMaxMb: Number(modalValue('imageMaxMb')) || 10,
      fileMaxMb: Number(modalValue('fileMaxMb')) || 20,
      videoMaxMb: Number(modalValue('videoMaxMb')) || 50,
    };
    try {
      const out = await api('/api/settings', { method: 'POST', body });
      state.settings = out.settings;
      state.config.allowRegister = out.settings.allowRegister;
      /* 上传上限也要就地更新 state.config：不清的话「家庭设置」里改大了，
         这一台设备上仍然按旧值在本地就拦下来，用户会以为没生效。 */
      state.config.imageMaxMb = out.settings.imageMaxMb;
      state.config.fileMaxMb = out.settings.fileMaxMb;
      state.config.videoMaxMb = out.settings.videoMaxMb;
      // 站点名称会改到顶栏 / 页脚 / 浏览器标签等静态 DOM 上，render() 覆盖不到它们，
      // 必须在这里显式刷一次（服务端已是清洗后的最终值，再走一遍 setAppName 做兜底）。
      setAppName(out.settings.siteName);
      refreshAppName();
      closeModal();
      render();
      toast('基础配置已保存，全家生效', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  /** 管理端手动触发一次扫描，并把状态区块就地刷新（不丢未保存的表单内容）
   *  v4.12.0：「运行状态」从家庭设置弹窗搬到了「我的 → 消息提醒」的页面本体里，
   *  所以查找与替换都要同时覆盖 #modal-layer 与 #main。 */
  async function rescanReminders() {
    const btn = document.querySelector('#modal-layer [data-act="settings-rescan"], #main [data-act="settings-rescan"]');
    if (btn) { btn.disabled = true; btn.textContent = '扫描中…'; }
    try {
      const out = await api('/api/settings/rescan-remind', { method: 'POST', body: {} });
      state.settings = out.settings;
      const holder = document.querySelector('#modal-layer #remind-status, #main #remind-status');
      if (holder) holder.outerHTML = remindStatusBlock(out.settings);
      else render();
      const r = out.result || {};
      const tips = [];
      if (out.reset) tips.push(`放开 ${out.reset} 条待重算`);
      if (r.sent) tips.push(`已发出 ${r.sent} 封`);
      if (r.waiting) tips.push(`${r.waiting} 条等参与人配收件邮箱`);
      if (r.errors && r.errors.length) tips.push(`失败：${r.errors[0]}`);
      toast(tips.length ? `扫描完成：${tips.join('；')}` : '扫描完成：没有需要发送的提醒', r.sent ? 'ok' : 'err');
    } catch (err) { toast(err.message, 'err'); }
    const btn2 = document.querySelector('#modal-layer [data-act="settings-rescan"], #main [data-act="settings-rescan"]');
    if (btn2) { btn2.disabled = false; btn2.textContent = '立即重新扫描'; }
  }

  async function sendTestMail() {
    const btn = document.querySelector('#modal-layer [data-act="settings-test-mail"], #main [data-act="settings-test-mail"]');
    if (btn) { btn.disabled = true; btn.textContent = '发送中…'; }
    try {
      const out = await api('/api/settings/test-mail', { method: 'POST', body: {
        to: modalValue('testTo').trim(),
        host: modalValue('smtpHost').trim(),
        port: Number(modalValue('smtpPort')) || 465,
        user: modalValue('smtpUser').trim(),
        pass: modalValue('smtpPass'),        // 留空则服务端沿用已保存的授权码
      } });
      if (out.settings) {
        state.settings = out.settings;
        const holder = document.querySelector('#modal-layer #remind-status, #main #remind-status');
        if (holder) holder.outerHTML = remindStatusBlock(out.settings);
      }
      render();
      toast('测试邮件已发送，发件配置也已保存，待办提醒已生效（注意垃圾箱）', 'ok');
    } catch (err) { toast(err.message, 'err'); }
    if (btn) { btn.disabled = false; btn.textContent = '发送测试'; }
  }

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    switch (el.dataset.act) {
      case 'rename-save': {
        try {
          const out = await api('/api/me/profile', { method: 'POST', body: { display_name: modalValue('display_name').trim() } });
          state.me = out.user;
          await refreshMembers();
          closeModal();
          render();
          toast('昵称已更新', 'ok');
        } catch (err) { toast(err.message, 'err'); }
        break;
      }
      case 'password-save': {
        try {
          await api('/api/me/password', { method: 'POST', body: { old_password: modalValue('old_password'), new_password: modalValue('new_password') } });
          closeModal();
          toast('密码已修改，请重新登录', 'ok');
          window.alert('密码已修改，需要重新登录。');
          handleLogoutLocally();
        } catch (err) { toast(err.message, 'err'); }
        break;
      }
      case 'username-save': {
        const next = modalValue('username').trim();
        const pass = modalValue('cur_password');
        if (!next) { toast('请输入新的登录账号', 'err'); break; }
        if (!pass) { toast('请输入当前密码以确认身份', 'err'); break; }
        try {
          const out = await api('/api/me/username', { method: 'POST', body: { username: next, password: pass } });
          // 服务端返回的是清洗后的最终值（trim + 大小写按用户输入原样保留）
          if (out.user) state.me = out.user;
          // 成员列表里也带着 @账号，一起刷新，免得「我的」页显示新账号、成员列表还是旧的
          await refreshMembers();
          closeModal();
          render();
          toast(`登录账号已改为 @${state.me.username}`, 'ok');
        } catch (err) { toast(err.message, 'err'); }
        break;
      }
      case 'member-reset-save': {
        try {
          await api(`/api/members/${el.dataset.id}/reset-password`, { method: 'POST', body: { new_password: modalValue('new_password') } });
          closeModal();
          toast('密码已重置，请告知本人', 'ok');
        } catch (err) { toast(err.message, 'err'); }
        break;
      }
      case 'member-lock-do': await adminMemberLock(Number(el.dataset.id), el.dataset.action); break;
      case 'me-avatar': openAvatarForm(); break;
      case 'avatar-pick': { const f = $('#modal-layer #avatar-file'); if (f) f.click(); break; }
      case 'avatar-reset': await resetAvatar(); break;
      case 'lock-enable-save': await saveRecordLock(true); break;
      case 'lock-disable-save': await saveRecordLock(false); break;
      case 'notify-email-save': await saveNotifyEmail(); break;
      case 'push-channel-save': await savePushChannel(); break;
      /* v4.23.0 需求 5：推送日志（管理员查看 / 清除） */
      case 'push-logs-open': await openPushLogs(); break;
      case 'push-logs-clear': await clearPushLogs(); break;
      /* v4.13.0（问题 5）：重新拉一次「上次推送」——它每发一条就变，页面不会自己更新 */
      case 'push-last-refresh':
        await refreshSettings();
        render();
        toast('已刷新上次推送状态', 'ok');
        break;
      case 'settings-site-reset': {
        // 「恢复默认」= 把输入框清空（placeholder 会显示默认名），
        // 真正的重置发生在保存时：空串 → 服务端把 site_name 写成空值。
        // 这里**不立即保存**，跟其它表单项一样，点了「保存」才生效。
        const input = document.querySelector('#modal-layer [data-mk="siteName"]');
        if (input) { input.value = ''; input.focus(); }
        toast('已填入默认名称，点「保存」后生效', 'ok');
        break;
      }
      case 'settings-save': await saveAdminSettings(); break;

      /* v4.12.0： 「我的」页各分区的折叠切换（外观主题不折叠，所以没有它）
         v4.15.0：分区扩到 9 个；展开「AI 参数 / 分类预算 / 消息推送」时顺手重拉一次
         记账 bootstrap —— 预算和报表状态可能是别人刚改的，避免展开看到旧值。 */
      case 'me-fold': {
        const k = el.dataset.key || '';
        if (!k) break;
        const willOpen = !state.meOpen[k];
        state.meOpen = Object.assign({}, state.meOpen, { [k]: willOpen });
        if (willOpen && (k === 'ai' || k === 'cat' || k === 'notify')) {
          try { await refreshBills(); } catch { /* 拉不到就用现有数据渲染 */ }
        }
        render();
        break;
      }
      /* v4.16.0 需求 4：点「邮件推送 / 企业微信推送」标题折叠对应的配置区。
         注意只切**显示**，不动开关 —— 开关仍是右边那个勾选框，两者别混在一起。 */
      case 'push-fold': {
        const which = el.dataset.which === 'wecom' ? 'wecom' : 'mail';
        const prev = !state.pushOpen || state.pushOpen[which] !== false;
        state.pushOpen = Object.assign({}, state.pushOpen, { [which]: !prev });
        render();
        break;
      }
      /* v4.16.0 需求 4：账号映射单独保存（常改的一项，不该逼着人重填五项凭证） */
      case 'wecom-map-save': await saveWecomMap(); break;
      /* v4.12.0：推送配置的两个家庭级总开关。勾上/取消**立刻生效**并展开配置区，
         不等下面的「保存」——「勾了没反应」是最容易让人重复操作的一种体验。 */
      case 'push-mail-toggle':
      case 'push-wecom-toggle':
      case 'push-feishu-toggle':
      case 'push-dingtalk-toggle': {
        const act = el.dataset.act;
        const which = { 'push-mail-toggle': 'mail', 'push-wecom-toggle': 'wecom',
          'push-feishu-toggle': 'feishu', 'push-dingtalk-toggle': 'dingtalk' }[act];
        const key = { mail: 'pushMailEnabled', wecom: 'pushWecomEnabled',
          feishu: 'pushFeishuEnabled', dingtalk: 'pushDingtalkEnabled' }[which];
        const body = { [key]: !!el.checked };
        try {
          const out = await api('/api/settings', { method: 'POST', body });
          state.settings = out.settings;
          /* 勾上时顺手展开配置区：用户下一步一定是去填参数（关掉时保持折叠，省屏幕） */
          if (el.checked) {
            state.pushOpen = Object.assign({}, state.pushOpen, { [which]: true });
          }
          /* 企业微信的开关同时就是接入开关，状态徽标要跟着变 */
          if (which === 'wecom') { try { await refreshWecom(); } catch { /* 拉不到就先渲染现有状态 */ } }
          render();
          const label = { mail: '邮件', wecom: '企业微信', feishu: '飞书', dingtalk: '钉钉' }[which];
          const extra = which === 'wecom'
            ? (el.checked ? '' : '（回消息与推送都停）')
            : (el.checked ? '' : '（配置保留）');
          toast(`${label}推送已${el.checked ? '开启' : '关闭'}${extra}`, 'ok');
        } catch (err) { toast(err.message, 'err'); }
        break;
      }
      /* v4.24.0 需求 2：保存 / 测试飞书与钉钉的群机器人配置。
         secret 走「留空 = 不修改」，与企微 Secret 同一套约定。 */
      case 'hooks-save': {
        const which = el.dataset.which;
        const body = {};
        const wh = String(fieldValue(`hook-${which}-webhook`) || '').trim();
        const sec = String(fieldValue(`hook-${which}-secret`) || '').trim();
        if (wh) body.webhook = wh;
        if (sec) body.secret = sec;
        try {
          const out = await api(`/api/hooks/${which}`, { method: 'POST', body });
          const stKey = which === 'feishu' ? 'feishuStatus' : 'dingtalkStatus';
          state.settings = Object.assign({}, state.settings, { [stKey]: out[which] });
          clearField(`hook-${which}-webhook`);
          clearField(`hook-${which}-secret`);
          render();
          toast(`${which === 'feishu' ? '飞书' : '钉钉'}配置已保存`, 'ok');
        } catch (err) { toast(err.message || '保存失败', 'err'); }
        break;
      }
      case 'hooks-test': {
        const which = el.dataset.which;
        const label = which === 'feishu' ? '飞书' : '钉钉';
        try {
          el.disabled = true;
          await api(`/api/hooks/${which}/test`, { method: 'POST', body: {} });
          toast(`${label}测试消息已发送，到群里看看`, 'ok');
        } catch (err) { toast(err.message || '发送失败', 'err'); }
        finally { el.disabled = false; }
        break;
      }
      /* 推送配置里的「保存邮件配置」：只提交 SMTP 那几个键，不动别的设置 */
      case 'push-save-mail': await saveMailConfig(); break;

      case 'settings-test-mail': await sendTestMail(); break;
      case 'settings-rescan': await rescanReminders(); break;
      case 'set-tab': switchSetTab(el.dataset.tab); break;
      case 'notify-kind-all':
      case 'notify-kind-none': {
        // 只改复选框状态，不动 DOM 结构：这样「全不选」之后仍能再勾回来
        // v4.12.0：通知类型已从「家庭设置弹窗」移到「我的 → 消息提醒」，所以要同时覆盖两处
        const on = el.dataset.act === 'notify-kind-all';
        $$('#modal-layer [data-mk^="kind-"], #main [data-mk^="kind-"]').forEach((c) => { c.checked = on; });
        break;
      }
      case 'rec-cat-pick': {
        const layer = $('#modal-layer');
        if (!layer) break;
        const cat = el.dataset.cat;
        layer.dataset.category = cat;
        $$('#rec-cats .chip').forEach((c) => c.classList.toggle('on', c === el));
        // 选「自定义」才显示输入框，并聚焦；选预设分类则收起输入框
        const input = layer.querySelector('#rec-cat-input');
        if (input) {
          const custom = cat === '__custom__';
          input.classList.toggle('hidden', !custom);
          if (custom) setTimeout(() => input.focus(), 40);
        }
        break;
      }
      default: break;
    }
  });

  document.addEventListener('click', (e) => {
    /* v4.28.2：可见范围统一走 `vis-pick`（上面那个通用处理器）；
       这里只剩「置顶」这一组分段按钮 —— 旧的 rec-vis-pick / post-vis-pick 已合并掉。 */
    const seg = e.target.closest('.segmented[data-act="rec-pin-pick"]');
    if (!seg) return;
    const btn = e.target.closest('button');
    if (!btn) return;
    const layer = $('#modal-layer');
    if (!layer) return;
    layer.dataset.pinned = btn.dataset.pin;
  });

  /* ── 启动 ─────────────────────────────────────────────── */

  boot();
})();
