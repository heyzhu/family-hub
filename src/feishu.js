'use strict';
/**
 * 飞书群机器人推送（v4.24.0 需求 2）。
 *
 * ★ 定位与 wecom.js 一致：这一层只做协议与传输（webhook + 加签 + 发文本），
 *   不认识任何业务。「发给谁、什么时候发、免打扰怎么算」都在 push.deliver 里裁决；
 *   本模块只回答「这条文本怎么送进飞书群」。
 *
 * 与企业微信的本质差别：飞书「自定义机器人」是**群 Webhook**，没有 UserID 的概念 ——
 *   · 全家共用一个机器人 → 一次投递全家可见，多人选「飞书」时**只发一条**（push 内部按通道去重）；
 *   · 因此「绑定 / 映射」那套东西对飞书不存在，isReady 只看 Webhook 是否填了。
 *
 * 加签（官方「签名校验」）：HMAC-SHA256，**密钥为空**、内容为 `${timestamp}\n${secret}`，
 *   结果 base64 后放进 body 的 `sign` 字段，`timestamp` 为秒级时间戳。
 *
 * 零依赖：node:crypto + 全局 fetch。绝不 require push / bills / api（会成环）。
 */

const crypto = require('node:crypto');
const { db } = require('./db');
const config = require('./config');

/** 配置键白名单（settings 是 key-value 表，只认这几个键） */
const CONFIG_KEYS = ['feishu_webhook', 'feishu_secret'];

const CONFIG_DEFAULTS = {
  feishu_webhook: '',
  feishu_secret: '',
};

/** 读配置（enabled 由「推送渠道设置 → 飞书推送」的总开关派生，见 config.pushFeishuEnabled） */
function loadConfig() {
  const map = { ...CONFIG_DEFAULTS };
  for (const r of db.all('SELECT key, value FROM settings')) {
    if (Object.prototype.hasOwnProperty.call(map, r.key)) map[r.key] = String(r.value == null ? '' : r.value);
  }
  return {
    enabled: config.pushFeishuEnabled !== false,
    webhook: map.feishu_webhook.trim(),
    secret: map.feishu_secret.trim(),
  };
}

/** 保存配置（只写认识字段；webhook 必须是 https 的 open.feishu.cn 链接形状） */
function saveConfig(patch) {
  const put = (key, value) => db.run(
    'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
  const b = patch || {};
  if (b.webhook != null) {
    const u = String(b.webhook).trim().slice(0, 500);
    if (u && !/^https:\/\/open\.feishu\.cn\//i.test(u)) {
      throw badRequest('飞书 Webhook 应是 https://open.feishu.cn/open-apis/bot/v2/hook/… 开头的地址');
    }
    put('feishu_webhook', u);
  }
  if (b.secret != null) {
    const s = String(b.secret).trim().slice(0, 64);
    if (s && !/^[A-Za-z0-9]{8,64}$/.test(s)) throw badRequest('飞书加签密钥应是 8-64 位字母或数字（机器人「签名校验」里生成）');
    put('feishu_secret', s);
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

/** 加签：string_to_sign = `${ts}\n${secret}`，HMAC-SHA256 **空密钥**，base64 */
function sign(secret, ts) {
  return crypto.createHmac('sha256', '')
    .update(`${ts}\n${String(secret || '')}`, 'utf8')
    .digest('base64');
}

/** 常见错误码的人话提示 */
function friendlyError(code) {
  switch (Number(code)) {
    case 9499: return '飞书说签名校验失败：检查「加签密钥」是否和机器人后台一致（时间不同步也会报这个）';
    case 19021: return '飞书说请求体不合法：通常是文本内容为空或超长';
    case 23001: return '飞书机器人已被关闭或移出群聊，请到群设置里重新检查机器人状态';
    default: return '';
  }
}

/**
 * 发一条文本进群。
 * @param {object} cfg loadConfig() 的结果
 * @param {{content:string}} opts 内容（会做截断保护，飞书上限约 150KB，这里按 4000 字收口）
 * @returns {Promise<{ok:boolean, error?:string, errorText?:string}>}
 */
async function sendText(cfg, opts) {
  const c = cfg || loadConfig();
  const o = opts || {};
  if (!c.webhook) return { ok: false, error: '飞书机器人未配置：先填 Webhook 地址' };
  const content = String(o.content || '').slice(0, 4000);
  if (!content) return { ok: false, error: '内容为空' };
  const body = { msg_type: 'text', content: { text: content } };
  if (c.secret) {
    body.timestamp = String(Math.floor(Date.now() / 1000));
    body.sign = sign(c.secret, body.timestamp);
  }
  try {
    const res = await fetch(c.webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
    });
    const text = await res.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch { /* 交给下面统一报错 */ }
    if (!j) return { ok: false, error: `飞书接口返回了非 JSON（HTTP ${res.status}）` };
    // 新版返回 {code:0,msg:'success'}；旧版自定义机器人返回 {StatusCode:0, StatusMsg:'success'}
    const code = Number(j.code != null ? j.code : (j.StatusCode != null ? j.StatusCode : j.code_no));
    if (code !== 0) {
      const hint = friendlyError(code);
      const raw = `${code} ${j.msg || j.StatusMsg || ''}`.trim();
      return { ok: false, error: `发送失败：${raw}`, errorText: hint ? `${hint}（${code}）` : `发送失败：${raw}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || '网络错误' };
  }
}

/** 测试连通性（设置页「发测试消息」按钮用） */
async function sendTest() {
  const c = loadConfig();
  if (!c.webhook) return { ok: false, error: '请先填飞书机器人的 Webhook 地址并保存' };
  return sendText(c, {
    content: `【${config.siteName}】飞书推送已接通，这条消息来自「我的 → 推送渠道设置 → 飞书推送」的发送测试。`,
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
