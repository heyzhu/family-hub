/* ═══════════════════════════════════════════════════════════════════════
   我们一家 · 首屏主题预热（v4.11.0）
   ---------------------------------------------------------------------
   做什么：在样式表之前，按 localStorage 里缓存的上一套主题把 <html data-theme>
          先定下来，避免「先按默认米白画一帧、再跳成用户主题」的闪色。
          服务端主题（users.theme）在 /api/me 回来后由 app.js 无条件校正，
          所以这里**只读缓存、不发请求、不写库**。

   ★ 为什么是独立文件，而不是写在 index.html 的内联 <script> 里：
     server.js 的 CSP 是 `script-src 'self'`，浏览器会直接拒绝执行内联脚本。
     内联写法看着最省事，实际一行都不会跑 —— v4.11 初版就踩了这个坑：
     登录页永远停在默认米白（因为此时还没有 /api/me 可以校正），
     切过主题的用户退出登录后会看到明显的「先亮一下再变」。
     外链同源脚本既过 CSP，又能保证第一帧就是对的颜色。

   ★ 加载顺序不能动：必须排在 styles.css 之前。
     放后面就变成「先按默认色画完，再改属性」—— 该闪的还是闪。
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var THEMES = ['forest', 'paper', 'ocean'];
  // 与 styles.css 里各主题的 --paper 保持一致：手机地址栏跟着底色走，才不会「奶油页面 + 白地址栏」
  var BAR = { forest: '#f4f8f5', paper: '#faf7f2', ocean: '#f5f8fd' };

  var picked = null;
  try {
    picked = localStorage.getItem('fh_theme');
  } catch (e) {
    /* 隐私模式 / 禁用存储：读不到就用 HTML 上写死的默认主题，不报错 */
    return;
  }

  // 脏值（旧版本残留、手工改过）一律不认，交给默认主题兜底
  if (THEMES.indexOf(picked) < 0) return;

  document.documentElement.setAttribute('data-theme', picked);

  var meta = document.getElementById('theme-color');
  if (meta) meta.setAttribute('content', BAR[picked]);
})();
