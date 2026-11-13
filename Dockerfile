# 我们一家 —— 容器镜像
#
# 本项目零第三方运行时依赖（原生 http + Node 内置 node:sqlite），
# 因此镜像里没有 npm install、没有原生模块编译，构建只需要几秒。
#
#   docker build -t family-hub:4.28.1 .
#   docker run -d --name family-hub -p 3455:3455 -v "$PWD/data:/data" family-hub:4.28.1
#
# 推荐用 docker compose 部署，见同目录 docker-compose.yml。
# 数据全部落在 /data 卷里（family.db + uploads/），备份就是备份这个目录。

FROM node:22-alpine

# ★ 时区数据不是可选项。
# Alpine 基础镜像【不含】时区数据库，此时 TZ=Asia/Shanghai 会被静默忽略、容器回落到 UTC，
# 而待办的日期与时间是家里人按北京时间填的 —— 结果就是待办提醒整体晚 8 小时才发出，
# 表现为「测试邮件能收到，待办提醒却一直不来」。装上 tzdata 才能让 TZ 真正生效。
RUN apk add --no-cache tzdata

ARG APP_VERSION=4.28.1
LABEL org.opencontainers.image.title="family-hub" \
      org.opencontainers.image.description="我们一家 —— 万年历待办 / 图文动态 / 重点事项记录本" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

WORKDIR /app

# 零运行时依赖，源码拷进去就能跑（.dockerignore 已排除 data/ 与本地杂项）
COPY --chown=node:node . .

# 容器内统一把数据放到 /data 卷；显式声明而非依赖默认值，便于对照排查
ENV NODE_ENV=production \
    PORT=3455 \
    HOST=0.0.0.0 \
    DB_PATH=/data/family.db \
    UPLOAD_DIR=/data/uploads \
    SESSION_TTL_HOURS=24 \
    MAX_UPLOAD_MB=10 \
    TRUST_PROXY=1 \
    TZ=Asia/Shanghai \
    TZ_OFFSET_MINUTES=480

VOLUME ["/data"]
EXPOSE 3455

# 数据目录属主给 node（容器内以 uid 1000 运行），入口脚本会再做一次可写性检查
RUN mkdir -p /data \
 && chown -R node:node /data \
 && chmod +x /app/docker-entrypoint.sh
USER node

# 健康检查打的是 /api/config —— 它属于公开接口，不需要登录，
# 所以「容器健康」不会被登录态影响（若换成需要鉴权的接口，容器会永远 unhealthy）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3455)+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

STOPSIGNAL SIGTERM
ENTRYPOINT ["/app/docker-entrypoint.sh"]
