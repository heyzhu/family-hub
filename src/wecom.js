'use strict';
/**
 * 企业微信自建应用接入（v4.5.0 需求 5）
 *
 * ★ 这一层**只做协议与传输**，不认识任何业务：
 *     · URL 验证（GET echostr）
 *     · 消息体解密 / 被动回复加密（AES-256-CBC + 自定义 PKCS#7）
 *     · 签名校验（sha1）
 *     · 取 access_token、发文本消息
 *   「收到一句话就记一笔账」这类业务编排放在 api.js，
 *   「日报月报推到企业微信」由 bills.js 调用本模块的 pushText。
 *
 * ★ 依赖只有 db / config / node:crypto / 全局 fetch。
 *   绝对不能 require bills / api / reminders / notify —— bills 要 require 本模块推送报表，
 *   反向依赖会成环，拿到的是半成品 exports（本项目在 ocr.js ↔ bills.js 上踩过）。
 */

const crypto = require('node:crypto');
const { db } = require('./db');
const config = require('./config');

/* ═══ 配置 ══════════════════════════════════════════════════ */

/**
 * 配置键白名单。settings 是 key-value 表，读的时候只认这几个键 ——
 * 其它 wecom_* 键（未来版本 / 手工写库留下的）一律不参与，行为可预期。
 */
const CONFIG_KEYS = [
  'wecom_enabled',        // 兼容键（v4.16.0 起由 push_wecom_enabled 派生，见 loadConfig）
  'wecom_corp_id',        // 企业 ID（我的企业 → 企业信息 → 企业 ID）
  'wecom_agent_id',       // 应用 AgentId
  'wecom_secret',         // 应用 Secret
  'wecom_token',          // 接收消息 → Token
  'wecom_aes_key',        // 接收消息 → EncodingAESKey（43 位）
  'wecom_user_map',       // 多行「企业微信 UserID=家庭账号」映射（唯一认人依据）
  /* v4.24.0 需求 3：可信 IP 代理 —— 家里服务器 IP 经常变 / 在 NAT 后面，
     每次都去企业微信后台改白名单不现实。启用后所有对 qyapi 的请求改经
     一台「固定出口 IP」的中转服务器转发，白名单里只留中转机的 IP。 */
  'wecom_proxy_enabled',  // '1' = 启用代理
  'wecom_proxy_url',      // 代理基址（如 https://relay.example.com/wecom，转发到 qyapi.weixin.qq.com）
  'wecom_proxy_token',    // 代理鉴权 token（请求头 X-FH-Proxy-Token，中转机校验）
];

const CONFIG_DEFAULTS = {
  wecom_enabled: '0',
  wecom_corp_id: '',
  wecom_agent_id: '',
  wecom_secret: '',
  wecom_token: '',
  wecom_aes_key: '',
  wecom_user_map: '',
  wecom_proxy_enabled: '0',
  wecom_proxy_url: '',
  wecom_proxy_token: '',
};

/** 读配置（只读白名单键，其余保持默认） */
function loadConfig() {
  const map = { ...CONFIG_DEFAULTS };
  // settings 是极小的 key-value 表，整表读回来再过滤比写 LIKE ESCAPE 更不容易出错
  for (const r of db.all('SELECT key, value FROM settings')) {
    if (Object.prototype.hasOwnProperty.call(map, r.key)) map[r.key] = String(r.value == null ? '' : r.value);
  }
  const aesKey = map.wecom_aes_key.trim();
  /* ★ v4.16.0 需求 4：**开关只剩一个** —— 「我的 → 推送渠道设置 → 企业微信推送」那个勾选框。
     这里的 enabled 由它派生，不再单独读写 wecom_enabled：
       · 关掉推送开关 = 企业微信整体停用（不再回消息、不再推提醒/报表）；
       · 打开但五项配置不齐 → enabled 为真、isReady 为假，界面显示「配置不完整」。
     老库里的 wecom_enabled='0' 在 migrate() 里做一次性折算（见 db.js 的 wecom_switch_unified）。 */
  return {
    enabled: config.pushWecomEnabled !== false,
    corpId: map.wecom_corp_id.trim(),
    agentId: map.wecom_agent_id.trim(),
    secret: map.wecom_secret.trim(),
    token: map.wecom_token.trim(),
    aesKey,
    userMap: map.wecom_user_map,
    /* v4.24.0 需求 3：可信 IP 代理 */
    proxyEnabled: map.wecom_proxy_enabled === '1',
    proxyUrl: map.wecom_proxy_url.trim(),
    proxyToken: map.wecom_proxy_token.trim(),
  };
}

/** 保存配置（只写认识字段；没传的字段保持原值） */
function saveConfig(patch) {
  const put = (key, value) => db.run(
    'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
  const b = patch || {};
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

  /* v4.16.0 需求 4：enabled 与「推送渠道设置」的企业微信开关是同一个概念 ——
     传 enabled 时两处一起写，老调用方（含旧脚本/测试）改一处不会只改半边。
     wecom_enabled 保留写入只为让回滚到 4.15 时行为一致。 */
  if (b.enabled != null) {
    const on = !!b.enabled;
    put('wecom_enabled', on ? '1' : '0');
    put('push_wecom_enabled', on ? '1' : '0');
    config.pushWecomEnabled = on;
  }
  if (b.corpId != null) put('wecom_corp_id', str(b.corpId, 64));
  if (b.agentId != null) {
    const id = str(b.agentId, 20);
    if (id && !/^\d+$/.test(id)) throw badRequest('应用 AgentId 应为纯数字');
    put('wecom_agent_id', id);
  }
  if (b.secret != null) put('wecom_secret', str(b.secret, 128));
  if (b.token != null) {
    const t = str(b.token, 32);
    if (t && !/^[A-Za-z0-9]{3,32}$/.test(t)) throw badRequest('Token 只能是 3-32 位字母或数字');
    put('wecom_token', t);
  }
  if (b.aesKey != null) {
    const k = str(b.aesKey, 43);
    // EncodingAESKey 固定 43 位，末尾补一个 '=' 后是 32 字节密钥。
    // 长度不对就直接拒绝 —— 否则等到回调真来了才报「解密失败」，很难排查。
    if (k && !/^[A-Za-z0-9+/]{43}$/.test(k)) throw badRequest('EncodingAESKey 必须是 43 位（含字母、数字、+ 和 /）');
    put('wecom_aes_key', k);
  }
  /* ★ v4.16.0：「默认记账账号」已下线 —— 记到谁名下只看账号映射（userMap）。
     旧 client 仍可能带上 billUser / reportPush，这里直接忽略，不再写库，
     免得升级后还留着一份「看起来还有用」的僵尸配置。 */
  if (b.userMap != null) put('wecom_user_map', normalizeUserMap(b.userMap));
  /* v4.24.0 需求 3：可信 IP 代理配置。
     · proxyEnabled 传布尔（也可以传 '1'/'0'，脚本友好）；
     · proxyUrl 必须是 http(s) 地址，末尾斜杠归一（拼路径时不会出双斜杠）；
     · proxyToken 只存不回传 —— 留空 = 不修改（与 Secret 同一套约定）。 */
  if (b.proxyEnabled != null) {
    const on = b.proxyEnabled === true || b.proxyEnabled === '1';
    put('wecom_proxy_enabled', on ? '1' : '0');
  }
  if (b.proxyUrl != null) {
    let u = str(b.proxyUrl, 300);
    if (u && !/^https?:\/\/.+/i.test(u)) throw badRequest('代理地址要以 http(s):// 开头');
    u = u.replace(/\/+$/, '');
    put('wecom_proxy_url', u);
  }
  if (b.proxyToken != null) {
    const t = str(b.proxyToken, 128);
    if (t && !/^[A-Za-z0-9_-]{6,128}$/.test(t)) throw badRequest('代理鉴权 Token 只能是 6-128 位字母、数字、下划线或连字符');
    put('wecom_proxy_token', t);
  }
  /* v4.16.0：「额外抄送 UserID」（wecom_report_to）已下线 —— 企业微信报表只发给
     账号映射里、且推送方式包含企业微信的家人；旧 client 传 reportTo 直接忽略。 */
  return loadConfig();
}

/** 「企业微信UserID=家庭账号」多行映射：去空行、去重（后者覆盖前者）、限长 */
function normalizeUserMap(raw) {
  const lines = String(raw == null ? '' : raw).split(/\r?\n/);
  const seen = new Map();
  for (const line of lines) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i <= 0) continue;
    const wx = s.slice(0, i).trim().slice(0, 64);
    const fh = s.slice(i + 1).trim().replace(/^@/, '').slice(0, 64);
    if (!wx || !fh) continue;
    seen.set(wx, fh);
  }
  return Array.from(seen, ([k, v]) => `${k}=${v}`).join('\n');
}

/** 解析映射表 → Map<wxUserId, username> */
function userMapOf(cfg) {
  const map = new Map();
  for (const line of String((cfg && cfg.userMap) || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    map.set(line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^@/, ''));
  }
  return map;
}

function badRequest(msg) {
  const err = new Error(msg);
  err.status = 400;
  return err;
}

/** 配置是否齐到「能收消息」的程度 */
function isReady(cfg) {
  const c = cfg || loadConfig();
  return !!(c.enabled && c.corpId && c.agentId && c.secret && c.token && c.aesKey);
}

/** 回调地址（对外展示用：管理员要把它填进企业微信后台） */
function callbackPath() {
  return '/api/wecom/callback';
}

/* ═══ 签名 / 加解密 ═════════════════════════════════════════ */

/** sha1(sort(token, timestamp, nonce, encrypt)) —— 企业微信 WXBizMsgCrypt 的约定 */
function signature(token, timestamp, nonce, encrypt) {
  const raw = [String(token), String(timestamp), String(nonce), String(encrypt)].sort().join('');
  return crypto.createHash('sha1').update(raw, 'utf8').digest('hex');
}

function timingEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/** EncodingAESKey(43) → 32 字节 AES key */
function aesKeyBuffer(aesKey) {
  const key = Buffer.from(String(aesKey || '') + '=', 'base64');
  if (key.length !== 32) throw new Error('EncodingAESKey 长度不正确（应为 43 位）');
  return key;
}

/**
 * 解密一段密文。
 * 明文结构：random(16) + msg_len(4, 大端) + msg + receiveid
 * 填充是**企业微信自己的 PKCS#7**（块大小 32），不是 Node 默认的 16 ——
 * 所以必须关掉自动去填充，自己按尾字节裁。
 */
function decrypt(encrypt, aesKey, receiveId) {
  const key = aesKeyBuffer(aesKey);
  const iv = key.subarray(0, 16);
  const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
  d.setAutoPadding(false);
  let buf = Buffer.concat([d.update(Buffer.from(String(encrypt), 'base64')), d.final()]);

  const pad = buf[buf.length - 1];
  if (!pad || pad > 32) throw new Error('密文填充不合法');
  buf = buf.subarray(0, buf.length - pad);
  if (buf.length < 20) throw new Error('密文长度不合法');

  const msgLen = buf.readUInt32BE(16);
  if (msgLen < 0 || 20 + msgLen > buf.length) throw new Error('密文消息长度不合法');
  const msg = buf.subarray(20, 20 + msgLen).toString('utf8');
  const gotId = buf.subarray(20 + msgLen).toString('utf8');
  // ★ receiveid 必须等于自己的 corpId：这是「这段密文确实是发给我的」的物理证明，
  //   只验签名不验它的话，别人家的回调密文也能解出内容来。
  if (receiveId && gotId !== receiveId) throw new Error('receiveid 不匹配（密文不是发给本企业的）');
  return msg;
}

/** 加密一段明文（被动回复用） */
function encrypt(msg, aesKey, receiveId) {
  const key = aesKeyBuffer(aesKey);
  const iv = key.subarray(0, 16);
  const body = Buffer.from(String(msg), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  let buf = Buffer.concat([crypto.randomBytes(16), len, body, Buffer.from(String(receiveId || ''), 'utf8')]);
  const pad = 32 - (buf.length % 32);          // 恰好整除时补 32，不是 0
  buf = Buffer.concat([buf, Buffer.alloc(pad, pad)]);
  const c = crypto.createCipheriv('aes-256-cbc', key, iv);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(buf), c.final()]).toString('base64');
}

/** 从 XML 里取一个标签的值（支持 CDATA）。企业微信的报文结构固定，不需要完整 XML 解析器 */
function xmlPick(xml, tag) {
  const re = new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</${tag}>`, 'i');
  const m = re.exec(String(xml || ''));
  if (!m) return '';
  return m[1] != null ? m[1] : String(m[2] || '').trim();
}

/* ═══ 回调入口的两个动作 ════════════════════════════════════ */

/**
 * GET 验证回调地址。
 * 企业微信要求原样返回解密后的 echostr（纯文本，不加引号、不加 XML）。
 * @returns {{ok:boolean, echo?:string, error?:string}}
 */
function verifyCallback(cfg, query) {
  const q = query || {};
  const token = cfg.token;
  const sig = String(q.msg_signature || q.signature || '');
  const ts = String(q.timestamp || '');
  const nonce = String(q.nonce || '');
  const echostr = String(q.echostr || '');
  if (!echostr) return { ok: false, error: '缺少 echostr' };
  if (!timingEqual(sig, signature(token, ts, nonce, echostr))) return { ok: false, error: '签名不匹配' };
  try {
    return { ok: true, echo: decrypt(echostr, cfg.aesKey, cfg.corpId) };
  } catch (err) {
    return { ok: false, error: `解密失败：${err.message}` };
  }
}

/**
 * POST 收消息：验签 → 解密 → 返回消息对象。
 * @returns {{ok:boolean, msg?:object, error?:string}}
 */
function readMessage(cfg, query, rawXml) {
  const q = query || {};
  const encrypt = xmlPick(rawXml, 'Encrypt');
  if (!encrypt) return { ok: false, error: '报文里没有 Encrypt 节点' };
  const sig = String(q.msg_signature || '');
  if (!timingEqual(sig, signature(cfg.token, q.timestamp, q.nonce, encrypt))) {
    return { ok: false, error: '签名不匹配' };
  }
  let plain;
  try {
    plain = decrypt(encrypt, cfg.aesKey, cfg.corpId);
  } catch (err) {
    return { ok: false, error: `解密失败：${err.message}` };
  }
  return {
    ok: true,
    msg: {
      toUser: xmlPick(plain, 'ToUserName'),
      fromUser: xmlPick(plain, 'FromUserName'),
      createTime: Number(xmlPick(plain, 'CreateTime')) || 0,
      msgType: (xmlPick(plain, 'MsgType') || '').toLowerCase(),
      content: xmlPick(plain, 'Content'),
      msgId: xmlPick(plain, 'MsgId'),
      /* v4.6.0 需求 2：图片消息的正文不在 XML 里，只有一个 MediaId 和临时 PicUrl。
         要拿真字节必须用 MediaId 去 media/get 换（见 downloadMedia）。 */
      mediaId: xmlPick(plain, 'MediaId'),
      picUrl: xmlPick(plain, 'PicUrl'),
      format: xmlPick(plain, 'Format'),
      agentId: xmlPick(plain, 'AgentID'),
      event: (xmlPick(plain, 'Event') || '').toLowerCase(),
      eventKey: xmlPick(plain, 'EventKey'),
    },
  };
}

/**
 * 构造被动回复报文。
 * 企业微信收到这个 XML 后会把内容推给用户 —— 比「先回空串再主动发消息」可靠得多，
 * 也不受 access_token 配额与网络抖动影响。
 */
function buildReply(cfg, plainXml) {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(8).toString('hex');
  // ★ 变量名不能叫 encrypt：会遮蔽同名的 encrypt() 函数，在初始化前引用就是 TDZ 报错
  const cipher = encrypt(plainXml, cfg.aesKey, cfg.corpId);
  const sig = signature(cfg.token, ts, nonce, cipher);
  return '<xml>'
    + `<Encrypt><![CDATA[${cipher}]]></Encrypt>`
    + `<MsgSignature><![CDATA[${sig}]]></MsgSignature>`
    + `<TimeStamp>${ts}</TimeStamp>`
    + `<Nonce><![CDATA[${nonce}]]></Nonce>`
    + '</xml>';
}

/** 文本消息的明文 XML */
function textXml(msg, content) {
  const safe = String(content || '').replace(/]]>/g, ']]&gt;');
  return '<xml>'
    + `<ToUserName><![CDATA[${msg.fromUser}]]></ToUserName>`
    + `<FromUserName><![CDATA[${msg.toUser}]]></FromUserName>`
    + `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>`
    + '<MsgType><![CDATA[text]]></MsgType>'
    + `<Content><![CDATA[${safe}]]></Content>`
    + '</xml>';
}

/* ═══ 主动发消息 ═══════════════════════════════════════════ */

const API_BASE = 'https://qyapi.weixin.qq.com';
// access_token 有效期 7200 秒，提前 5 分钟换新；缓存按 corpId+secret 区分，
// 管理员改完 secret 立刻生效，不会继续用旧企业的 token。
let tokenCache = { key: '', token: '', expireAt: 0 };
let tokenPending = null;

/* ── v4.24.0 需求 3：可信 IP 代理 ─────────────────────────────
   企业微信要求「调用 API 的服务器 IP」在应用的可信 IP 白名单里。
   家庭服务器常常在 NAT / 动态 IP 后面，白名单维护不过来 ——
   启用代理后，所有对 qyapi 的请求改发到「中转云服务器」（固定出口 IP）：
     · 请求地址 = proxyUrl + 原路径（如 https://relay.example.com/wecom/cgi-bin/gettoken?…）；
     · 请求头带 X-FH-Proxy-Token: <token>，中转机校验通过才转发；
     · 中转机只做透明反向代理（nginx / Node 都行），部署步骤见 docs/wecom-proxy.md。
   ★ 回调（企业微信 → 我们）不走代理：回调地址是公网能访问到的本机地址，方向相反。 */
function apiBaseOf(cfg) {
  if (cfg && cfg.proxyEnabled && cfg.proxyUrl) return String(cfg.proxyUrl).replace(/\/+$/, '');
  return API_BASE;
}
function proxyHeaders(cfg) {
  if (cfg && cfg.proxyEnabled && cfg.proxyToken) {
    return { 'X-FH-Proxy-Token': cfg.proxyToken };
  }
  return {};
}

function httpTimeout(ms) {
  return AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
}

async function fetchJson(url, init, ms) {
  const res = await fetch(url, { ...(init || {}), signal: httpTimeout(ms || 8000) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 交给下面统一报错 */ }
  if (!json) throw new Error(`企业微信接口返回了非 JSON（HTTP ${res.status}）`);
  return json;
}

async function getAccessToken(cfg) {
  const key = `${cfg.corpId}|${cfg.secret}|${cfg.proxyUrl || ''}`;
  const now = Date.now();
  if (tokenCache.key === key && tokenCache.token && now < tokenCache.expireAt) return tokenCache.token;
  if (tokenPending && tokenPending.key === key) return tokenPending.promise;
  const promise = (async () => {
    const url = `${apiBaseOf(cfg)}/cgi-bin/gettoken?corpid=${encodeURIComponent(cfg.corpId)}`
      + `&corpsecret=${encodeURIComponent(cfg.secret)}`;
    const j = await fetchJson(url, { method: 'GET', headers: proxyHeaders(cfg) });
    if (!j.access_token) {
      throw new Error(`取 access_token 失败：${j.errcode || '?'} ${j.errmsg || ''}`.trim());
    }
    const ttl = Math.max(60, (Number(j.expires_in) || 7200) - 300);
    tokenCache = { key, token: j.access_token, expireAt: now + ttl * 1000 };
    return j.access_token;
  })();
  tokenPending = { key, promise };
  try { return await promise; } finally { tokenPending = null; }
}

/**
 * 发一条文本消息。
 * @param {object} cfg 由 loadConfig() 得到
 * @param {{toUser?:string, content:string}} opts
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
/**
 * v4.10.0（差异 #26）：常见错误码的人话提示。
 * 这些码反复出现在「配置错了」的场景里，只回一串数字等于没说：
 *   81013  userid 不存在（绑定关系失效 / 拼错）
 *   60020  本机 IP 不在应用可信 IP 白名单里
 *   45009  接口调用超过限流（发得太频繁）
 */
function friendlyError(errcode) {
  switch (Number(errcode)) {
    case 81013: return '企业微信说这个 UserID 不存在（绑定关系可能已失效，请到网页端重新绑定）';
    case 60020: return '服务器 IP 不在应用的「企业可信 IP」白名单里：可到企业微信后台把当前 IP 加进白名单，或在「企业微信接入 → 是否启用代理」里改走固定出口 IP 的中转服务器（见 docs/wecom-proxy.md）';
    case 45009: return '发送太频繁，触发了企业微信的接口限流，稍等一会儿会自动恢复';
    default: return '';
  }
}

async function sendText(cfg, opts) {
  const c = cfg || loadConfig();
  const o = opts || {};
  if (!isReady(c)) return { ok: false, error: '企业微信未配置完整' };
  const content = String(o.content || '').slice(0, 2000);
  if (!content) return { ok: false, error: '内容为空' };
  try {
    const token = await getAccessToken(c);
    const j = await fetchJson(
      `${apiBaseOf(c)}/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...proxyHeaders(c) },
        body: JSON.stringify({
          touser: o.toUser || '@all',
          msgtype: 'text',
          agentid: Number(c.agentId) || 0,
          text: { content },
          safe: 0,
        }),
      },
    );
    if (Number(j.errcode) !== 0) {
      const hint = friendlyError(j.errcode);
      return {
        ok: false,
        error: `发送失败：${j.errcode} ${j.errmsg || ''}`.trim(),
        errcode: Number(j.errcode) || 0,
        // 人话提示单独给一个字段：调用方（催促 / 推送）可以选择展示，日志里也有据可查
        hint,
        errorText: hint ? `${hint}（${j.errcode}）` : `发送失败：${j.errcode} ${j.errmsg || ''}`.trim(),
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || '网络错误' };
  }
}

/**
 * 企业微信能不能发**主动推送**（bills.js 报表 / urge 催促 / notify 用）。
 *
 * v4.16.0 需求 4：「日报 / 月报推送」那个独立的勾选框已经撤掉，
 * 报表跟待办提醒、内容通知一样，遵循「消息推送设置」里的推送方式 ——
 * 也就是说：开关只有一个（推送渠道设置的企业微信推送），配置齐就能发。
 * ★ 保留这个函数名是为了不动调用点；语义从「报表开关」变成「推送就绪」。
 */
function reportEnabled(cfg) {
  const c = cfg || loadConfig();
  return isReady(c);
}

/** 报表推一条文本（失败不抛，返回结果；调用方只需要计数） */
async function pushText(text, opts) {
  const c = loadConfig();
  if (!reportEnabled(c)) return { ok: false, error: '企业微信未配置完整或推送开关已关闭' };
  return sendText(c, { toUser: (opts && opts.toUser) || '', content: text });
}

/**
 * 取一条消息里的临时素材。
 *
 * 为什么需要它：图片消息的 XML 里**没有图片内容**，只有一个 `MediaId`
 * （PicUrl 是带鉴权的临时地址，不能直接当公网图片用）。要拿到真正的字节，
 * 必须拿 access_token 去 `cgi-bin/media/get` 换。
 *
 * @returns {Promise<{buffer:Buffer, contentType:string}>}
 */
async function downloadMedia(mediaId, opts) {
  const c = (opts && opts.cfg) || loadConfig();
  const id = String(mediaId || '').trim();
  if (!id) throw new Error('缺少 media_id');
  if (!isReady(c)) throw new Error('企业微信未配置完整');
  const token = await getAccessToken(c);
  const url = `${apiBaseOf(c)}/cgi-bin/media/get?access_token=${encodeURIComponent(token)}`
    + `&media_id=${encodeURIComponent(id)}`;
  // 图片可能慢一点，给 15 秒；超时必须有，否则回调会被拖死（代理生效时同样带鉴权头）
  const res = await fetch(url, {
    signal: httpTimeout((opts && opts.timeoutMs) || 15000),
    headers: proxyHeaders(c),
  });
  const ct = String(res.headers.get('content-type') || '');
  /* ★ 出错时企业微信返回的是 **JSON**（errcode/errmsg），HTTP 状态还是 200 ——
     不看 content-type 直接 arrayBuffer 会得到一段 JSON 文本当图片，最后在识别时
     报"不是有效图片"，排查方向就全错了。 */
  if (/json|text\/plain/i.test(ct)) {
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* 保持 j = null */ }
    const code = (j && j.errcode) || '?';
    const msg = (j && j.errmsg) || text.slice(0, 120);
    throw new Error(`取图片失败（${code}）：${msg}`.trim());
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('取到的图片是空的');
  return { buffer, contentType: ct || 'image/jpeg' };
}

/** 测试连通性：发一条测试消息（设置页「发测试消息」按钮用） */
async function sendTest(toUser) {
  const c = loadConfig();
  if (!isReady(c)) return { ok: false, error: '请先把企业 ID / AgentId / Secret / Token / EncodingAESKey 填完并保存' };
  return sendText(c, {
    toUser: String(toUser || '').trim() || '@all',
    content: `【${config.siteName}】企业微信接入成功，这条消息来自「我的 → 企业微信」的发送测试。`,
  });
}

module.exports = {
  CONFIG_KEYS,
  CONFIG_DEFAULTS,
  loadConfig,
  saveConfig,
  normalizeUserMap,
  userMapOf,
  isReady,
  friendlyError,
  callbackPath,
  signature,
  decrypt,
  encrypt,
  xmlPick,
  verifyCallback,
  readMessage,
  buildReply,
  textXml,
  getAccessToken,
  /* v4.24.0 需求 3：可信 IP 代理（测试用它核对出站地址与鉴权头） */
  apiBaseOf,
  proxyHeaders,
  sendText,
  downloadMedia,
  reportEnabled,
  pushText,
  sendTest,
};
