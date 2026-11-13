#!/usr/bin/env bash
# 我们一家 · 构建并打包 Docker 镜像
#
#   bash scripts/build-image.sh                  # 构建 + 导出 dist/family-hub-<版本>.tar
#   bash scripts/build-image.sh --no-save        # 只构建，不导出
#   bash scripts/build-image.sh --gzip           # 额外导出一份 .tar.gz（传服务器更快）
#   bash scripts/build-image.sh --platform linux/amd64    # 指定目标架构（跨架构构建）
#
# 产物：
#   dist/family-hub-<版本>.tar        可直接 docker load 的镜像包
#   dist/SHA256SUMS                   校验和
#
# 服务器侧（离线安装，无需外网、无需源码）：
#   scp dist/family-hub-*.tar user@server:/tmp/
#   ssh user@server
#   docker load -i /tmp/family-hub-<版本>.tar
#   # 再把 docker-compose.yml + .env.docker.example 拷过去，然后：
#   mkdir -p data && sudo chown -R 1000:1000 data
#   docker compose up -d
#
# 用 bash 执行（脚本用了 bash 数组；若被 sh 调用会自动切回 bash）。

# 被 sh / dash 调用时自动切回 bash，避免数组语法与 pipefail 报错
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

IMAGE_NAME="family-hub"
SAVE=1
GZIP=0
PLATFORM=""

# 版本号取自 package.json，避免两处手改不一致
# 注意：管道末端是 head，会提前关闭管道使 sed 收到 SIGPIPE；在 set -o pipefail 下会被判为失败，
#       所以这里用 || true 兜住（取到的仍是第一行，结果不受影响）
VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -n 1 || true)"
VERSION="${VERSION:-4.28.1}"

while [ $# -gt 0 ]; do
  case "$1" in
    --no-save) SAVE=0 ;;
    --gzip)    GZIP=1 ;;
    --platform) PLATFORM="${2:-}"; shift ;;
    -h|--help)
      # 打印文件头部的注释块作为用法说明
      awk 'NR>1 { if (/^#/) { sub(/^# ?/, ""); print } else { exit } }' "$0"
      exit 0 ;;
    *) echo "未知参数：$1（用 --help 看用法）" >&2; exit 2 ;;
  esac
  shift
done

if ! command -v docker >/dev/null 2>&1; then
  echo "❌ 找不到 docker 命令。" >&2
  echo "   Windows/macOS：装 Docker Desktop 后重开终端。" >&2
  echo "   Linux：装 docker-ce 后确认当前用户在 docker 组（newgrp docker 或重新登录）。" >&2
  echo "   另一条路：把源码传到服务器，直接在服务器上 docker compose up -d --build。" >&2
  exit 1
fi

echo ""
echo "我们一家 · 构建镜像"
echo "────────────────────────────────────────────"
echo "  版本      $VERSION"
if [ -n "$PLATFORM" ]; then echo "  平台      $PLATFORM"; fi
echo "  构建目录  $ROOT"
echo ""

BUILD_ARGS=(build -t "$IMAGE_NAME:$VERSION" -t "$IMAGE_NAME:latest" --build-arg "APP_VERSION=$VERSION")
if [ -n "$PLATFORM" ]; then BUILD_ARGS+=(--platform "$PLATFORM"); fi

docker "${BUILD_ARGS[@]}" .

echo ""
echo "✔ 镜像构建完成："
docker images --filter "reference=$IMAGE_NAME" --format '  {{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}'

if [ "$SAVE" -eq 0 ]; then
  echo ""
  echo "  （已跳过导出。本地直接用：docker compose up -d）"
  exit 0
fi

DIST="$ROOT/dist"
mkdir -p "$DIST"
TAR="$DIST/$IMAGE_NAME-$VERSION.tar"

echo ""
echo "正在导出镜像包（node:22-alpine 基础层约 150MB，稍等）…"
SAVE_ARGS=(save -o "$TAR")
if [ -n "$PLATFORM" ]; then SAVE_ARGS+=(--platform "$PLATFORM"); fi
docker "${SAVE_ARGS[@]}" "$IMAGE_NAME:$VERSION" "$IMAGE_NAME:latest"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else openssl dgst -sha256 "$1" | sed 's/.*= //'
  fi
}

SUM="$(sha256_of "$TAR")"
echo "$SUM  $(basename "$TAR")" > "$DIST/SHA256SUMS"

if [ "$GZIP" -eq 1 ]; then
  echo "正在压缩…"
  gzip -k -f "$TAR"
  SUM_GZ="$(sha256_of "$TAR.gz")"
  echo "$SUM_GZ  $(basename "$TAR.gz")" >> "$DIST/SHA256SUMS"
fi

echo ""
echo "────────────────────────────────────────────"
echo "  镜像包    $TAR  ($(du -h "$TAR" | cut -f1))"
if [ "$GZIP" -eq 1 ]; then echo "  压缩包    $TAR.gz  ($(du -h "$TAR.gz" | cut -f1))"; fi
echo "  校验和    $DIST/SHA256SUMS"
echo "            $SUM"
echo "────────────────────────────────────────────"
echo ""
echo "部署到服务器："
echo "  1) 上传镜像包（以及 docker-compose.yml、.env.docker.example）"
echo "       scp $DIST/$IMAGE_NAME-$VERSION.tar docker-compose.yml .env.docker.example  user@server:/tmp/"
echo "  2) 服务器上导入镜像"
echo "       docker load -i /tmp/$IMAGE_NAME-$VERSION.tar"
echo "  3) 放好 compose 文件并启动"
echo "       mkdir -p /srv/family-hub && cd /srv/family-hub"
echo "       cp /tmp/docker-compose.yml . && cp /tmp/.env.docker.example .env"
echo "       mkdir -p data && sudo chown -R 1000:1000 data"
echo "       docker compose up -d"
echo ""
echo "  校验完整性：sha256sum -c SHA256SUMS"
echo ""
