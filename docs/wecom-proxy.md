# 企业微信「可信 IP」代理部署指南

## 为什么需要它

企业微信要求调用 API（发消息 / 取图片 / 取 access_token）的服务器 IP 在应用的
**「企业可信 IP」白名单**里。家庭服务器通常有两个困境：

- 在 NAT / 光猫桥接后面，出口 IP 是运营商动态分配的，**隔几天就变**；
- 换宽带、换机器、搬 NAS，白名单就得跟着改。

启用代理后，family-hub 对 `qyapi.weixin.qq.com` 的所有请求改发给一台
**固定出口 IP 的中转云服务器**，由它透明转发。企业微信后台的白名单里
**只需要填中转机的 IP**，一劳永逸。

> 方向说明：只有「我们 → 企业微信」的 API 调用走代理。
> 「企业微信 → 我们」的回调（收消息）走的是你在后台填的回调地址，与代理无关。
>
> 中转机用 **1panel 面板**管理的，直接看图文步骤版：[wecom-proxy-1panel.md](wecom-proxy-1panel.md)。

## 应用侧怎么配

「我的 → 推送渠道设置 → 企业微信推送 → 配置」里：

1. 勾选 **启用可信 IP 代理**；
2. **代理地址**：填中转机上的反代基址，例如 `https://relay.example.com/wecom`
   （不要以 `/` 结尾）；
3. **代理鉴权 Token**：自定义一串随机字符（6–128 位字母数字下划线连字符），
   中转机用它校验请求，防止你的代理被人白嫖；
4. 保存后点「发测试消息」验证。

原理：family-hub 把

```
https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=…
```

改发为

```
https://relay.example.com/wecom/cgi-bin/message/send?access_token=…
X-FH-Proxy-Token: <你填的 Token>
```

中转机校验 Token 后原样转发到 `qyapi.weixin.qq.com`。

## 中转机部署方案 A：nginx（推荐）

前提：一台有固定公网 IP 的云服务器，已装 nginx，有域名与 HTTPS 证书
（推荐 certbot 免费签一个）。

```nginx
# /etc/nginx/conf.d/wecom-proxy.conf
server {
    listen 443 ssl;
    server_name relay.example.com;

    ssl_certificate     /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

    # 只开放 /wecom/ 这一个前缀，别把整台机器变成开放代理
    location /wecom/ {
        # ★ 鉴权：把下面的 Token 换成你在 family-hub 里填的那串
        if ($http_x_fh_proxy_token != "你的Token") {
            return 403;
        }

        # 透传到企业微信（注意末尾的 /：/wecom/cgi-bin/... → /cgi-bin/...）
        proxy_pass https://qyapi.weixin.qq.com/;
        proxy_set_header Host qyapi.weixin.qq.com;
        proxy_ssl_server_name on;
        proxy_ssl_protocols TLSv1.2 TLSv1.3;

        # 企业微信返回过 JSON / 图片 / 文件流，都不缓存、不限长
        proxy_buffering off;
        proxy_read_timeout 30s;
    }
}
```

```bash
nginx -t && systemctl reload nginx
```

然后在企业微信后台把这个中转机的公网 IP 加进应用的「企业可信 IP」。

## 中转机部署方案 B：Node 脚本（不想装 nginx 时）

一个约 40 行的零依赖转发脚本，`node wecom-relay.js` 即可跑：

```js
// wecom-relay.js —— 企业微信 API 透明代理（零依赖）
// 用法：TOKEN=你的Token PORT=8443 node wecom-relay.js
const http = require('http');
const https = require('https');
const { URL } = require('url');

const TOKEN = process.env.TOKEN || '';
const PORT = Number(process.env.PORT) || 8443;
const UPSTREAM = 'qyapi.weixin.qq.com';

http.createServer((req, res) => {
  if (req.headers['x-fh-proxy-token'] !== TOKEN) { res.writeHead(403); return res.end(); }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const up = new URL(`https://${UPSTREAM}${req.url}`);
    const ureq = https.request(up, {
      method: req.method,
      headers: { host: UPSTREAM, 'content-type': req.headers['content-type'] || 'application/json' },
    }, (ures) => {
      res.writeHead(ures.statusCode, ures.headers);
      ures.pipe(res);
    });
    ureq.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
    if (chunks.length) ureq.write(Buffer.concat(chunks));
    ureq.end();
  });
}).listen(PORT, () => console.log(`wecom relay on :${PORT}`));
```

用 systemd 守护：

```ini
# /etc/systemd/system/wecom-relay.service
[Unit]
Description=family-hub wecom api relay
After=network.target

[Service]
Environment=TOKEN=你的Token
Environment=PORT=8443
ExecStart=/usr/bin/node /opt/wecom-relay/wecom-relay.js
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now wecom-relay
```

生产环境建议在前面再挂一层 nginx + HTTPS（脚本本身是 HTTP），
或者用 caddy 一行自动 HTTPS：

```
relay.example.com {
  reverse_proxy /wecom/* https://qyapi.weixin.qq.com {
    header_up Host qyapi.weixin.qq.com
    @denied not header X-FH-Proxy-Token 你的Token
    # caddy 的拦截写法：先在 route 里判断，这里从简，务必加鉴权
  }
}
```

> caddy 的鉴权建议直接用 nginx 方案的 if 判断思路（caddy 用 `@denied` matcher + `abort`），
> 不熟悉的话优先选 nginx。

## 验证清单

1. family-hub 侧「发测试消息」成功；
2. 故意把中转机 Token 改错 → family-hub 侧应报「403 / 发送失败」，
   说明鉴权真的在工作；
3. 企业微信后台可信 IP 只填中转机 IP，家里服务器换网后**无需**再改任何配置；
4. 手机在企微里发一句「咖啡 12 元」，记账回执正常（回调不走代理，不受影响）。

## 安全注意

- 中转机只开放 `/wecom/` 前缀，**不要**做无鉴权的全站转发；
- Token 用长随机串（`openssl rand -hex 24` 生成）；
- 中转机只放行到 `qyapi.weixin.qq.com:443` 的出站，别的都不用开。
