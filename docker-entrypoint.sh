#!/bin/sh
# 容器启动入口：确保数据目录存在且可写，然后把服务交给 node（exec 让信号直达，docker stop 能优雅退出）。
# 建表逻辑在服务内部（src/schema.sql 幂等执行），这里只负责目录与权限。
set -e

DATA_DIR="$(dirname "${DB_PATH:-/data/family.db}")"
IMG_DIR="${UPLOAD_DIR:-/data/uploads}"

mkdir -p "$DATA_DIR" "$IMG_DIR" 2>/dev/null || true

if [ ! -w "$DATA_DIR" ]; then
  echo "❌ 数据目录不可写：$DATA_DIR" >&2
  echo "" >&2
  echo "   容器内以 node 用户（uid 1000）运行，而该目录的属主不是它。" >&2
  echo "   常见原因：宿主机上 data/ 目录是 docker 用 root 自动创建的。" >&2
  echo "" >&2
  echo "   在宿主机执行（把路径换成你的实际挂载目录）：" >&2
  echo "     sudo chown -R 1000:1000 ./data" >&2
  echo "     docker compose restart" >&2
  echo "" >&2
  echo "   或直接看是哪个目录没权限：" >&2
  echo "     ls -ld ./data" >&2
  exit 1
fi

# 站点名称 v1.8.0 起可由管理员自定义、存在数据库里，入口脚本这里读不到它的当前值
# （此时服务还没起来），所以横幅改成中性文案 —— 真实站名由 server.js 启动后打印。
echo "🏠 家庭共享服务 · 数据目录 $DATA_DIR"
echo "🖼  图片目录 $IMG_DIR"
# 时区自检：如果这里打出来的时间是 UTC，说明镜像缺少时区数据，
# 待办提醒会整体偏移（这正是「测试邮件能收到、待办提醒不来」的常见原因）。
echo "🕐 时区 TZ=${TZ:-未设置} · 容器当前时间 $(date '+%Y-%m-%d %H:%M:%S %z')"
echo "   待办提醒按偏移 TZ_OFFSET_MINUTES=${TZ_OFFSET_MINUTES:-480} 分钟换算（480 = 东八区）"

exec node server.js
