ArtPlayer 5.4.0
===============

文件：artplayer.js（单文件、已压缩，134KB）
来源：https://github.com/zhw2590582/ArtPlayer
协议：MIT License，Copyright (c) 2017-2026 Harvey Zhao

为什么把这份文件放进仓库（而不是用 CDN）：
  1. 页面 CSP 是 `script-src 'self'` —— 外部 CDN 一律被浏览器拒绝执行；
  2. 这是家用 NAS / 内网部署，出网可能根本不通；
  3. 播放器属于「基础能力」，不能因为上游 CDN 抖动就整个视频功能不可用。

升级方式（保持版本号与文件同步更新）：
  curl -sSL -o public/vendor/artplayer/artplayer.js https://unpkg.com/artplayer@5/dist/artplayer.js
  然后把本文件里的版本号改掉。
