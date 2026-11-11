#!/usr/bin/env node
'use strict';
/**
 * 企业微信 API 中转（可信 IP 代理）· 零依赖 Node 实现
 * ────────────────────────────────────────────────────────────────────────
 * 解决什么问题
 *   企业微信要求「调用 API 的服务器 IP」在自建应用的 **企业可信 IP** 白名单里。
 *   家里的 NAS / 小主机常在 NAT 后面、或者宽带是动态 IP，白名单根本维护不过来。
 *   把本脚本跑在一台**固定公网 IP** 的云服务器上，白名单只留这一台；
 *   家里的「我们一家」把所有 qyapi 请求改经它转发。
 *
 * 它是怎么被调用的（与 family-hub/src/wecom.js 的 apiBaseOf 对齐）
 *   原请求： https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=…&corpsecret=…
 *   改走后： https://relay.example.com/wecom/cgi-bin/gettoken?corpid=…&corpsecret=…
 *           请求头带 X-FH-Proxy-Token: <你设置的令牌>
 *   也就是说：只需在「我们一家 → 我的 → 推送渠道设置 → 企业微信推送 → 配置」
 *             里把「代理地址」填成 https://relay.example.com/wecom 即可。
 *
 * 只做单向转发
 *   企业微信**回调**我们（用户发消息 → 我们的服务）是反方向，永远不走这里：
 *   回调地址必须由企业微信服务器直接访问到你的家宽/域名。
 *
 * 用法
 *   PROXY_TOKEN='换成你自己的长随机串' PORT=8080 node wecom-relay.js
 *
 *   可选环境变量
 *     PROXY_TOKEN  必填。请求头 X-FH-Proxy-Token 必须与它一致，否则 401。
 *     PORT         监听端口，默认 8080。
 *     HOST         监听地址，默认 127.0.0.1（前面由 nginx/Caddy 终止 TLS）。
 *                  要让它直接对外可写 0.0.0.0，但那样务必自己上 TLS。
 *     PREFIX       对外路径前缀，默认 /wecom，必须与界面里的「代理地址」结尾一致。
 *     UPSTREAM     上游，默认 https://qyapi.weixin.qq.com（自测时可指向本地假服务）。
 *
 * 安全约束（都不是装饰）
 *   1. 只放行 /cgi-bin/ 下的路径 —— 否则它就是一个任何人都能用的开放代理。
 *   2. 令牌比较用 crypto.timingSafeEqual，避免按字符提前返回造成的时序泄漏。
 *   3. 不记录 URL —— query 里带着 corpsecret，写进日志等于把密钥留在磁盘上。
 *   4. 上游永远走 https，且**不接受**调用方改目标主机。
 */
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const PREFIX = (process.env.PREFIX || '/wecom').replace(/\/+$/, '');
const UPSTREAM = (process.env.UPSTREAM || 'https://qyapi.weixin.qq.com').replace(/\/+$/, '');
const TOKEN = String(process.env.PROXY_TOKEN || '');

// 只转发企业微信的 API 路径，避免变成通用代理
const ALLOW_PATH = /^\/cgi-bin\/[A-Za-z0-9_./-]+$/;

function tokenOk(given) {
  if (!TOKEN) return true;                       // 没设令牌 = 不校验（仅供内网自测）
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(TOKEN, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function fail(res, code, msg) {
  const body = JSON.stringify({ errcode: code * -1, errmsg: msg });
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  // 健康检查：给云厂商的探活 / 自己 curl 用，不需要令牌
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  if (!req.url.startsWith(PREFIX + '/')) return fail(res, 404, 'path not found');
  if (!tokenOk(req.headers['x-fh-proxy-token'])) return fail(res, 401, 'proxy token mismatch');

  const rest = req.url.slice(PREFIX.length);     // /cgi-bin/gettoken?…
  const path = rest.split('?')[0];
  if (!ALLOW_PATH.test(path)) return fail(res, 403, 'only /cgi-bin/* is allowed');

  let target;
  try {
    target = new URL(UPSTREAM + rest);
  } catch {
    return fail(res, 400, 'bad upstream url');
  }

  // 只带必要的头：Authorization / Cookie 之类一律不透传
  const headers = { 'Content-Type': req.headers['content-type'] || 'application/json' };
  if (req.headers['content-length']) headers['Content-Length'] = req.headers['content-length'];

  const up = https.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || 443,
    path: target.pathname + target.search,
    method: req.method,
    headers,
    timeout: 15000,
  }, (ur) => {
    res.writeHead(ur.statusCode || 502, ur.headers);
    ur.pipe(res);
  });

  up.on('timeout', () => { up.destroy(new Error('upstream timeout')); });
  up.on('error', (e) => {
    // 只打错误类型，不打 URL（query 里有 corpsecret）
    console.error('[relay] upstream error:', e.code || e.message);
    if (!res.headersSent) fail(res, 502, 'upstream unreachable');
    else res.end();
  });

  req.pipe(up);
});

server.headersTimeout = 20000;
server.requestTimeout = 25000;

server.listen(PORT, HOST, () => {
  console.log(`[relay] listening on http://${HOST}:${PORT}${PREFIX}  ->  ${UPSTREAM}`);
  if (!TOKEN) console.warn('[relay] 警告：未设置 PROXY_TOKEN，任何请求都会被转发。生产环境务必设置。');
});
