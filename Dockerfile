# syntax=docker/dockerfile:1

# ---------- 构建 ----------
FROM node:24-alpine AS build
WORKDIR /app

# 先只拷依赖清单，让这层能被缓存住
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ---------- 运行 ----------
FROM node:24-alpine AS runtime

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8800 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

WORKDIR /app

# 零运行时依赖，只要编译产物
COPY package.json ./
COPY --from=build /app/dist ./dist

RUN mkdir -p /data && chown -R node:node /data

USER node

EXPOSE 8800
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8800)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/index.js"]
