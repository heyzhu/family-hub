'use strict';
/**
 * 飞书群机器人推送（v4.24.0 需求 2）。
 *
 * ★ 定位与 wecom.js 一致：这一层只做协议与传输（webhook + 加签 + 发文本），
 *   不认识任何业务。「发给谁、什么时候发、免打扰怎么算」都在 push.deliver 里裁决；
 *   本模块只回答「这条文本怎么送进钉钉群」。
 *
 * 与企业微信的本质差别：钉钉「自定义机器人」是**群 Webhook**，没有 UserID 的概念 ——
 *   · 全家共用一个机器人 → 一次投递全家可见，多人选「钉钉」时**只发一条**（push 内部按通道去重）；
 *   · 因此「绑定 / 映射」那套东西对钉钉不存在，isReady 只看 Webhook 是否填了。
 *
 * 加签（官方「加签」安全设置）：HMAC-SHA256，**密钥为加签密钥本身**、
 *   内容为 `${timestamp}\n${secret}`（毫秒时间戳），base64 后 URL 编码，
 *   以 `&timestamp=<ms>&sign=<...>` 拼在 Webhook 地址上。
 *
 * 零依赖：node:crypto + 全局 fetch。绝不 require push / bills / api（会成环）。
 */

const crypto = require('node:crypto');
const { db } = require('./db');
const config = require('./config');

/** 配置键白名单（settings 是 key-value 表，只认这几个键） */
const CONFIG_KEYS = ['dingtalk_webhook', 'dingtalk_secret'];

const CONFIG_DEFAULTS = {
  dingtalk_webhook: '',
  dingtalk_secret: '',
};

/** 读配置（enabled 由「推送渠道设置 → 钉钉推送」的总开关派生，见 config.pushDingtalkEnabled） */
function loadConfig() {
  const map = { ...CONFIG_DEFAULTS };
  for (const r of db.all('SELECT key, value FROM settings')) {
    if (Object.prototype.hasOwnProperty.call(map, r.key)) map[r.key] = String(r.value == null ? '' : r.value);
  }
  return {
    enabled: config.pushDingtalkEnabled !== false,
    webhook: map.dingtalk_webhook.trim(),
    secret: map.dingtalk_secret.trim(),
  };
}

/** 保存配置（只写认识字段；webhook 必须是 https 的 oapi.dingtalk.com 链接形状） */
function saveConfig(patch) {
  const put = (key, value) => db.run(
    'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
  const b = patch || {};
  if (b.webhook != null) {
    const u = String(b.webhook).trim().slice(0, 500);
    if (u && !/^https:\/\/oapi\.dingtalk\.com\//i.test(u)) {
      throw badRequest('钉钉 Webhook 应是 https://oapi.dingtalk.com/robot/send?access_token=… 开头的地址');
    }
    put('dingtalk_webhook', u);
  }
  if (b.secret != null) {
    const s = String(b.secret).trim().slice(0, 100);
    // 官方「加签」密钥固定以 SEC 开头；放宽到纯字母数字只是给手工生成的密钥留口子
    if (s && !/^SEC[A-Za-z0-9]{6,97}$/.test(s) && !/^[A-Za-z0-9]{8,100}$/.test(s)) {
      throw badRequest('钉钉加签密钥应以 SEC 开头（机器人「加签」安全设置里生成）');
    }
    put('dingtalk_secret', s);
  }
  return loadConfig();
}

function badRequest(msg) {
  const err = new Error(msg);
  err.status = 400;
  return err;
}

/** 配置是否齐到「能发消息」的程度（群机器人没有绑定概念，看 Webhook 就够） */
function isReady(cfg) {
  const c = cfg || loadConfig();
  return !!(c.enabled && c.webhook);
}

/** 加签：string_to_sign = `${ts}\n${secret}`，HMAC-SHA256 密钥 = secret，base64 后 URL 编码 */
function sign(secret, ts) {
  return encodeURIComponent(
    crypto.createHmac('sha256', String(secret || ''))
      .update(`${ts}\n${String(secret || '')}`, 'utf8')
      .digest('base64'),
  );
}

/** 常见错误码的人话提示 */
function friendlyError(code) {
  switch (Number(code)) {
    case 310000: return '钉钉说签名不匹配：检查「加签密钥」是否和机器人后台一致（服务器时间偏差太大也会报这个）';
    case 1301: return '钉钉机器人关键词不匹配：消息里没有包含安全设置里配置的关键词';
    default: return '';
  }
}

/**
 * 发一条文本进群。
 * @param {object} cfg loadConfig() 的结果
 * @param {{content:string}} opts 内容（钉钉文本消息上限约 20000 字节，按 4000 字收口）
 * @returns {Promise<{ok:boolean, error?:string, errorText?:string}>}
 */
async function sendText(cfg, opts) {
  const c = cfg || loadConfig();
  const o = opts || {};
  if (!c.webhook) return { ok: false, error: '钉钉机器人未配置：先填 Webhook 地址' };
  const content = String(o.content || '').slice(0, 4000);
  if (!content) return { ok: false, error: '内容为空' };
  let url = c.webhook;
  if (c.secret) {
    const ts = Date.now();
    url += (url.includes('?') ? '&' : '?') + `timestamp=${ts}&sign=${sign(c.secret, ts)}`;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content } }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
    });
    const text = await res.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch { /* 交给下面统一报错 */ }
    if (!j) return { ok: false, error: `钉钉接口返回了非 JSON（HTTP ${res.status}）` };
    if (Number(j.errcode) !== 0) {
      const hint = friendlyError(j.errcode);
      const raw = `${j.errcode} ${j.errmsg || ''}`.trim();
      return { ok: false, error: `发送失败：${raw}`, errorText: hint ? `${hint}（${j.errcode}）` : `发送失败：${raw}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || '网络错误' };
  }
}

/** 测试连通性（设置页「发测试消息」按钮用） */
async function sendTest() {
  const c = loadConfig();
  if (!c.webhook) return { ok: false, error: '请先填钉钉机器人的 Webhook 地址并保存' };
  return sendText(c, {
    content: `【${config.siteName}】钉钉推送已接通，这条消息来自「我的 → 推送渠道设置 → 钉钉推送」的发送测试。`,
  });
}

module.exports = {
  CONFIG_KEYS,
  CONFIG_DEFAULTS,
  loadConfig,
  saveConfig,
  isReady,
  sign,
  friendlyError,
  sendText,
  sendTest,
};
