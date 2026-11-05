# 1panel + Node.js 转发：企业微信「可信 IP」代理部署步骤

适用场景：中转云服务器上装的是 **1panel** 面板，不想手写 nginx 配置，  
用面板的「运行环境（Node.js）」跑一个约 40 行的零依赖转发脚本。

> 原理一句话：family-hub 把发往 `qyapi.weixin.qq.com` 的请求改发到  
> `https://你的域名/cgi-bin/...`，请求头带 `X-FH-Proxy-Token: <Token>`；  
> 中转机校验 Token 后原样转发给企业微信。企业微信后台的可信 IP 白名单里  
> **只填中转机的公网 IP**，家里宽带换 IP 也不用再管。  
> 回调方向（企业微信 → family-hub）不走这条链路，不受影响。

---

## 〇、前置准备

| 项     | 要求                                                      |
| ----- | ------------------------------------------------------- |
| 云服务器  | 任意一台有**固定公网 IP** 的云主机（阿里云 / 腾讯云 / 哪家都行），已装 1panel       |
| 域名    | 一个子域名（下文用 `relay.example.com` 代替），A 记录解析到云服务器公网 IP      |
| Token | 在任意机器上执行 `openssl rand -hex 24` 生成一串随机字符，后文记作 `你的Token` |

> 没有域名也可以：直接用 `http://服务器IP:8443` 作代理地址（脚本自带鉴权），  
> 但强烈建议走域名 + HTTPS（企微媒体文件、长内容都不想裸奔）。



---

## 一、上传转发脚本

1panel → **文件** → 进入 `/opt` → 新建目录 `wecom-relay` → 在该目录新建文件 `wecom-relay.js`，内容：

```js
// wecom-relay.js —— 企业微信 API 透明代理（零依赖，Node >= 18）
// 兼容两种代理地址：https://relay.example.com 与 https://relay.example.com/wecom
const http = require('http');
const https = require('https');
const { URL } = require('url');

const TOKEN = process.env.TOKEN || '';
const PORT = Number(process.env.PORT) || 8443;
const UPSTREAM = 'qyapi.weixin.qq.com';

http.createServer((req, res) => {
  if (req.headers['x-fh-proxy-token'] !== TOKEN) { res.writeHead(403); return res.end(); }
  // 剥掉可选的 /wecom 前缀（family-hub 的「代理地址」带不带它都能用）
  const path = req.url.replace(/^\/wecom(?=\/)/, '');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const up = new URL(`https://${UPSTREAM}${path}`);
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
}).listen(PORT, '127.0.0.1', () => console.log(`wecom relay on 127.0.0.1:${PORT}`));
```

要点：

- 监听 `127.0.0.1` 而不是 `0.0.0.0` —— 外部只能通过面板的反代站点进来，端口本身不对公网暴露；
- 请求头不带正确 Token 一律 403，不会被人白嫖当开放代理。

---

## 二、创建 Node.js 运行环境

1panel → **网站 → 运行环境 → Node.js → 创建运行环境**（旧版入口可能是「网站 → Node.js 项目」）：

| 字段           | 填什么                                             |
| ------------ | ----------------------------------------------- |
| 名称           | `wecom-relay`                                   |
| 源码目录         | `/opt/wecom-relay`                              |
| Node 版本      | 选可用的最新 LTS（≥ 18 即可）                             |
| 启动命令 / 入口文件  | `node wecom-relay.js`（或只填入口文件 `wecom-relay.js`） |
| 应用端口         | `8443`                                          |
| 外部映射端口       | 默认即可（反代走 127.0.0.1:8443，无需对公网开）                 |
| 环境变量         | `TOKEN=你的Token`、`PORT=8443`（两条分开填）              |
| 构建命令 / 启动前命令 | 留空（零依赖，不需要 npm install）                         |

创建后点「启动」，状态应为「运行中」。若日志页看到 `wecom relay on 127.0.0.1:8443` 即成功。

> 各版本字段名略有差异，核心就三件事：**源码目录指向脚本、端口 8443、环境变量带上 TOKEN**。  
> 若你的 1panel 版本没有「运行环境」功能，见文末「备选：systemd 托管」。

---

## 三、建站并反代到转发服务

若创建运行环境时已自动生成站点，直接进下一步改域名；否则：

1panel → **网站 → 创建网站 → 反向代理**：

| 字段   | 填什么                     |
| ---- | ----------------------- |
| 主域名  | `relay.example.com`     |
| 代号   | `wecom-relay`           |
| 代理地址 | `http://127.0.0.1:8443` |

保存后进入该站点设置，确认反代生效。

**不要在反代设置里加任何「代理前缀 / 路径改写」**——脚本收到的路径就是  
`/cgi-bin/...`，原样转发即可（脚本里那行前缀剥离只是兜底，正常用不到）。

---

## 四、申请 HTTPS 证书并开启强制 HTTPS

1. 1panel → **网站 → 证书 → 申请证书**：
   - 域名填 `relay.example.com`；
   - 验证方式选 **HTTP**（站点已建好，选这个最省事）或 DNS（按你的 DNS 服务商选）；
   - 申请入口选「从LetsEncrypt获取」，勾选刚建的 `wecom-relay` 站点。
2. 申请成功后：**网站 → wecom-relay → HTTPS** → 选择该证书 → 勾选 **强制 HTTPS** → 保存。

此后 `http://relay.example.com/...` 会自动跳到 `https://`。

---

## 五、放行端口

两处都要放（缺一不可）：

1. **1panel 防火墙**：主机 → 防火墙 → 放行 `80`、`443`（HTTP 验证签证书要 80）；
2. **云厂商安全组**：控制台里同样放行 `80`、`443` 入方向。

> 8443 **不需要**对公网放行——脚本只监听 127.0.0.1，外部流量全部走 443 的反代站点。



---

## 六、服务器上先自测（不接 family-hub 就能测）

1panel → **终端**（或 SSH 上去），执行两条：

```bash
# ① 不带 Token → 应返回 HTTP 403（鉴权在工作）
curl -i "https://relay.example.com/cgi-bin/gettoken?corpid=x&corpsecret=y"

# ② 带 Token → 应返回企业微信的 JSON（errcode 40013/41004 之类都算转发成功，
#    参数是假的当然报错，关键是不再是 403）
curl -i -H "X-FH-Proxy-Token: 你的Token" \
  "https://relay.example.com/cgi-bin/gettoken?corpid=x&corpsecret=y"
```

两条都符合预期，中转机就绪。

---

## 七、family-hub 应用侧填写

家庭服务器上：**我的 → 推送渠道设置 → 企业微信推送 → 配置**：

1. 勾选 **启用可信 IP 代理**；
2. **代理地址**：`https://relay.example.com`（不要以 `/` 结尾；填 `https://relay.example.com/wecom` 也可以，脚本两者兼容）；
3. **代理 Token**：填 `你的Token`（已在用的老 Token 留空 = 不修改）；
4. 保存 → 点 **「发测试消息」**。

---

## 八、企业微信后台加可信 IP

管理后台 → 应用管理 → 你的自建应用 → **开发者接口 → 企业可信 IP**：  
把**云服务器的公网 IP** 加进去（就这一个 IP，家庭宽带 IP 不用加）。

---

## 九、验证清单

1. family-hub「发测试消息」成功，企微群里收到消息；
2. 把中转机环境变量里的 Token 故意改错重启 → family-hub 应报「403 / 发送失败」，  
   改回来再测又成功 —— 说明鉴权真的在工作；
3. 家庭服务器换网络（换宽带 / 换场地）后**无需**改任何配置，直接还能发；
4. 手机企微里发「咖啡 12 元」→ 记账回执正常（回调不走代理，不受影响）。

---

## 十、常见问题排查

| 现象                                           | 原因                     | 处理                                                          |
| -------------------------------------------- | ---------------------- | ----------------------------------------------------------- |
| 测试消息报 403                                    | Token 不一致              | 核对运行环境环境变量 `TOKEN` 与应用侧「代理 Token」是否同一串；改过环境变量要**重启运行环境**    |
| 报 502 / 连不上                                  | Node 服务没起来             | 运行环境页看状态与日志；确认监听 127.0.0.1:8443                             |
| 证书申请失败                                       | 80 端口没放行 / 解析未生效       | 放行 80（面板+安全组两处）；`ping relay.example.com` 确认解析已指向本机          |
| 企微报 `60020 not allow to access from your ip` | 可信 IP 白名单没加或加错         | 后台填的必须是**云服务器公网 IP**（在云控制台看，不是 1panel 显示的内网 IP）             |
| 换了 Token 后一直失败                               | 应用侧 Token「留空 = 不修改」    | 想换 Token 时必须在应用侧把新 Token 重新填一遍                              |
| 时通时断                                         | 云服务器安全组只放行了部分端口 / 证书过期 | 检查安全组 80/443；1panel 证书列表看到期时间（Let's Encrypt 自动续期需站点在申请时已勾选） |

---

## 备选：不用面板运行环境，systemd 托管

若你的 1panel 版本没有 Node.js 运行环境，SSH 上去三步（脚本同上，放到 `/opt/wecom-relay/`）：

```bash
# 1) 写服务文件（先把两个「你的Token/路径」替换掉）
cat > /etc/systemd/system/wecom-relay.service <<'EOF'
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
EOF

# 2) 启动并设开机自启
systemctl enable --now wecom-relay

# 3) 看状态
systemctl status wecom-relay --no-pager
```

1panel 侧照旧只做「建站反代到 127.0.0.1:8443 + 证书」。

---

## 安全注意

- 只放行到 `qyapi.weixin.qq.com:443` 的出站就够了，中转机别干别的；
- Token 用长随机串（`openssl rand -hex 24`），泄露了就换（换完应用侧要重填）；
- 脚本只转发，不做任何改写；不用 `X-Forwarded-For` 之类头，企微侧看不到你家里的 IP。
