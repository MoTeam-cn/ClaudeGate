# syntax=docker/dockerfile:1

# 用 Bun 跑，不是因为它快，是因为它的 TLS 是 BoringSSL —— 出站 ClientHello
# 与真 Claude Code 同源。Node 的 OpenSSL 在密码套件、曲线、点格式上都对不齐。
# 详见 docs/fingerprint.md 的 TLS 一节。

# ---------- 构建 ----------
FROM oven/bun:1-alpine AS build
WORKDIR /app

# 先只拷依赖清单，让这层能被缓存住
COPY package.json package-lock.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN bunx tsc

# ---------- 运行 ----------
FROM oven/bun:1-alpine AS runtime

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8800 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info

WORKDIR /app

# 零运行时依赖，只要编译产物
COPY package.json ./
COPY --from=build /app/dist ./dist

RUN mkdir -p /data && chown -R bun:bun /data

USER bun

EXPOSE 8800
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8800)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "dist/src/index.js"]
