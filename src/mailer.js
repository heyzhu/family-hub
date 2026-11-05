'use strict';
/**
 * 极简 SMTP 客户端（零第三方依赖，只用 node:net / node:tls）。
 *
 * 面向 QQ 邮箱设计：
 *   - smtp.qq.com，端口 465（SSL 直连）或 587（STARTTLS）；
 *   - 密码填「授权码」，不是 QQ 登录密码；
 *   - AUTH LOGIN 明文流程由 TLS 通道保护。
 *
 * 也兼容其它标准 SMTP 服务（163 / 126 / Gmail 等）。
 */
const net = require('node:net');
const tls = require('node:tls');

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

/** RFC 2047 B 编码：主题 / 昵称里出现中文时使用 */
function encodeHeader(text) {
  const s = String(text || '');
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;
}

class SmtpError extends Error {}

/**
 * 建立连接。secure=true → TLS 直连；否则先明文连接，由调用方决定是否 STARTTLS。
 */
function connectSocket({ host, port, secure }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const sock = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    sock.setTimeout(20000);
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      if (err) { try { sock.destroy(); } catch { /* 忽略 */ } reject(err); }
      else resolve(val);
    };
    sock.once('error', (err) => done(new SmtpError(`无法连接 SMTP 服务器：${err.message}`)));
    sock.once('timeout', () => done(new SmtpError('连接 SMTP 服务器超时')));
    const readyEv = secure ? 'secureConnect' : 'connect';
    sock.once(readyEv, () => done(null, sock));
  });
}

/**
 * 把 socket 包装成「一条命令一个回复」的客户端。
 * SMTP 回复可能是多行（EHLO），以「ddd 」空格结尾的行表示结束，「ddd-」表示未完。
 */
function makeClient(socket) {
  let buf = '';
  let cur = null;          // 当前正在收集的回复行
  let pending = null;      // { resolve, reject }

  const fail = (err) => {
    const p = pending;
    pending = null; cur = null;
    if (p) p.reject(err);
  };

  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (!pending) continue;
      cur.push(line);
      if (/^\d{3} /.test(line)) {
        const code = Number(line.slice(0, 3));
        const p = pending;
        pending = null;
        if (code >= 400) p.reject(new SmtpError(`SMTP ${code}：${line.slice(4)}`));
        else p.resolve({ code, lines: cur });
      } else if (!/^\d{3}-/.test(line)) {
        fail(new SmtpError(`SMTP 回复格式异常：${line}`));
      }
    }
  });
  socket.on('error', (err) => fail(new SmtpError(`SMTP 连接错误：${err.message}`)));
  socket.on('timeout', () => fail(new SmtpError('SMTP 响应超时')));
  socket.on('close', () => fail(new SmtpError('SMTP 连接被关闭')));

  /** 等待服务器主动发来的一条回复（如连接问候 220） */
  const ready = () => new Promise((resolve, reject) => {
    pending = { resolve, reject };
    cur = [];
    // 若数据已先于 ready() 到达，重新扫描缓冲
    let idx;
    while ((idx = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      cur.push(line);
      if (/^\d{3} /.test(line)) {
        const code = Number(line.slice(0, 3));
        const p = pending;
        pending = null;
        if (code >= 400) { reject(new SmtpError(`SMTP ${code}：${line.slice(4)}`)); return; }
        resolve({ code, lines: cur });
        return;
      }
    }
  });

  const cmd = (text) => new Promise((resolve, reject) => {
    pending = { resolve, reject };
    cur = [];
    socket.write(text + '\r\n');
  });

  return { ready, cmd, socket };
}

/** 明文端口升级为 TLS（STARTTLS），返回新的客户端 */
function upgradeTls(client, host) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ socket: client.socket, servername: host }, () => resolve(makeClient(sock)));
    sock.once('error', (err) => reject(new SmtpError(`STARTTLS 升级失败：${err.message}`)));
  });
}

/** base64 正文按 76 字符折行 */
function wrapB64(text) {
  const enc = b64(text);
  return enc.match(/.{1,76}/g).join('\r\n');
}

/**
 * 拼 MIME 正文。
 *  - 只有 text：直接 text/plain（与旧版本完全一致，任何客户端都能读）
 *  - 同时有 text + html：multipart/alternative，收件端自己挑能显示的 ——
 *    支持 HTML 的邮箱看排版，不支持的自动回落到纯文本。
 * 两部分都用 base64，避免中文/长行被 SMTP 行宽限制切断。
 */
function buildBody({ text, html, boundary }) {
  if (!html) {
    return [
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrapB64(text),
    ];
  }
  return [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    '这是一封多格式邮件，请使用支持 HTML 的邮件客户端查看。',
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapB64(text),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapB64(html),
    '',
    `--${boundary}--`,
  ];
}

/**
 * 发送一封邮件（纯文本，或 text + html 双格式）。
 * @param {object} o {host, port, secure, user, pass, to:string|string[], subject, text, html?, fromName}
 */
async function sendMail(o) {
  const host = String(o.host || 'smtp.qq.com');
  const port = Number(o.port || 465);
  const secure = o.secure != null ? !!o.secure : port === 465;
  const user = String(o.user || '').trim();
  const pass = String(o.pass || '');
  const fromName = String(o.fromName || '').trim();
  const to = (Array.isArray(o.to) ? o.to : String(o.to || '').split(','))
    .map((s) => s.trim()).filter(Boolean);
  if (!user || !pass) throw new SmtpError('发件邮箱或授权码未配置');
  if (!to.length) throw new SmtpError('没有收件邮箱');

  let client = makeClient(await connectSocket({ host, port, secure }));
  try {
    const greet = await client.ready();
    if (greet.code !== 220) throw new SmtpError('SMTP 服务器问候异常');

    await client.cmd(`EHLO family-hub`);

    if (!secure) {
      let upgraded = false;
      try {
        const r = await client.cmd('STARTTLS');
        if (r.code === 220) {
          client = await upgradeTls(client, host);
          await client.cmd('EHLO family-hub');
          upgraded = true;
        }
      } catch (err) {
        throw new SmtpError(`该端口需要 STARTTLS 加密但服务器不支持：${err.message}（建议改用 465 端口）`);
      }
      if (!upgraded) throw new SmtpError('SMTP 服务器要求加密连接，请改用 465 端口');
    }

    // AUTH LOGIN
    const a1 = await client.cmd('AUTH LOGIN');
    if (a1.code !== 334) throw new SmtpError('SMTP 服务器不支持 AUTH LOGIN 认证');
    await client.cmd(b64(user));                       // Username: → 334
    const a3 = await client.cmd(b64(pass));            // Password: → 235
    if (a3.code !== 235) throw new SmtpError('SMTP 认证失败：请检查发件邮箱与授权码');

    await client.cmd(`MAIL FROM:<${user}>`);
    for (const addr of to) await client.cmd(`RCPT TO:<${addr}>`);

    const data = await client.cmd('DATA');
    if (data.code !== 354) throw new SmtpError('SMTP 服务器拒绝进入 DATA 阶段');

    const from = fromName
      ? `${encodeHeader(fromName)} <${user}>`
      : `<${user}>`;
    const boundary = `----=_Part_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
    const msg = [
      `From: ${from}`,
      `To: ${to.join(', ')}`,
      `Subject: ${encodeHeader(o.subject || '(无主题)')}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      ...buildBody({ text: String(o.text || ''), html: o.html ? String(o.html) : '', boundary }),
    ].join('\r\n');
    /* ★ v4.20.0（审查 W-5）：DATA 阶段必须做 **dot-stuffing**。
       RFC 5321 规定：正文里以 `.` 开头的行要写成 `..`，否则服务器把单独一个 `.`
       当作「邮件结束」提前截断。正文含用户可控内容（待办标题、账单备注、记录本正文），
       虽然触发概率低（要恰好有一行以点开头），但一旦发生就是
       「提醒邮件莫名只剩前半段」这种极难排查的问题。
       ★ 必须在拼结束符 `.` **之前**替换，且只处理行首（`\r\n.`）。 */
    const stuffed = msg.replace(/\r\n\./g, '\r\n..');
    // 边界情况：正文第一行就以 `.` 开头（msg 开头即 '\r\n.'？不会 —— msg 首行是 From:），
    // 但 html/text 段可能整体以点开头，上面的规则已覆盖（前面一定有换行）。
    await client.cmd(stuffed + '\r\n.');
    await client.cmd('QUIT').catch(() => { /* 服务器可能直接断开 */ });
    try { client.socket.end(); } catch { /* 忽略 */ }
    return { to };
  } catch (err) {
    try { client.socket.destroy(); } catch { /* 忽略 */ }
    throw err;
  }
}

module.exports = { sendMail, buildBody, wrapB64, SmtpError };
