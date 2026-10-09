# 部署

> 镜像基于 `oven/bun`。不是因为 Bun 快，是因为它的 TLS 是 BoringSSL ——
> 出站 ClientHello 的曲线与点格式才和真 Claude Code 对得上。见[指纹](fingerprint.md)。

依赖锁定用 `bun.lock`（不是 `package-lock.json`）。仓库里两份都留着：
前者给 CI 的 `test-bun` 与 Docker 构建，后者给 `npm ci`。
构建走的是 `bun install --frozen-lockfile`，所以 `bun.lock` 必须一起 COPY 进镜像。

CI 里有一条 `docker` 作业会真构建并推送镜像，所以 COPY 路径、`USER bun`、`HEALTHCHECK`
这些只跑 `bun test` 测不到的东西，至少能保证构建得过。
**但它不会起容器** —— 容器能不能真跑起来，第一次 `docker run` 时自己看一眼日志。

## 系统要求

- 直接跑源码要 Node **22.6+**；Docker 镜像里跑的是 **Bun 1**，不依赖 Node
- 一个到上游能稳定出网的落地机
- 约 100 MB 磁盘（代码 + 依赖）；数据库大小取决于日志保留策略

## 直接跑（systemd）

```bash
sudo useradd -r -s /usr/sbin/nologin claude-gw
sudo mkdir -p /opt/claudegate
sudo rsync -a --exclude node_modules --exclude data ./ /opt/claudegate/
sudo chown -R claude-gw:claude-gw /opt/claudegate
cd /opt/claudegate && sudo -u claude-gw npm ci --omit=dev
sudo cp deploy/claude-gateway.service /etc/systemd/system/
sudo systemctl enable --now claude-gateway
```

单元文件里已经带了 `NODE_OPTIONS=--disable-warning=ExperimentalWarning`、`LimitNOFILE=65535`
与 `MemoryMax=1G`。

## Docker

镜像由 GitHub Actions 自动构建推到 GHCR：

```
ghcr.io/moteam-cn/claudegate:latest
```

仓库是私有的，所以**包默认也是私有的**。两种走法二选一：

- 把包改成公开：GitHub → 组织 → Packages → claudegate → Package settings → Change visibility → Public
- 保持私有，先登录（PAT 需要 `read:packages`）：

```bash
echo <你的PAT> | docker login ghcr.io -u <你的GitHub用户名> --password-stdin
```

### 一键启动

```bash
docker run -d --name claudegate --restart unless-stopped \
  -p 27666:8800 \
  -v claudegate-data:/data \
  -e PUBLIC_URL=http://你的内网地址:27666 \
  -e UPSTREAM_PROXY=socks5h://user:pass@proxy.example.com:1080 \
  ghcr.io/moteam-cn/claudegate:latest
```

左边是宿主机端口，随便改；**右边 8800 是容器内端口，不要动**（镜像里 `PORT=8800`）。

起来之后：

```bash
docker logs claudegate 2>&1 | grep -A 6 '面板登录密钥'
```

那串 `cgk_` 开头的就是面板登录密钥，**只在首次启动打印这一次**。收好它，
然后开 `http://你的内网地址:27666/panel`。

### 出站代理

`UPSTREAM_PROXY` 就是网关到 Anthropic 的出口。容器里 `127.0.0.1` 指的是容器自己，
不是宿主机 —— 代理跑在宿主机上时要写 `host.docker.internal`：

```bash
  -e UPSTREAM_PROXY=http://host.docker.internal:7890 \
  --add-host host.docker.internal:host-gateway \
```

Linux 上必须加 `--add-host`，`host.docker.internal` 不会自动解析。
代理失效时网关**直接报错，不会回退直连** —— 这是故意的，见[代理](proxy.md)。

### compose

```bash
cp .env.example .env      # 改 PUBLIC_URL 等
docker compose -f deploy/docker-compose.yml up -d
```

compose 里已经把宿主机端口映射到 27666。注意它 `env_file` 指向 `../.env`，
那个文件不存在时 compose 会直接报错 —— 不用就把它注释掉。

镜像的几个事实：

- 两阶段构建，运行阶段**只带编译产物**（项目零运行时依赖，`node_modules` 都不用装）
- 以非 root 用户 `bun` 运行
- 数据都在 `/data` 卷里；**主密钥在 `/data/admin.json`，卷丢了就要重新派发登录密钥**
- 自带 `HEALTHCHECK`，用 `bun` 打 `/healthz`
- 默认 `PORT=8800`、`HOST=0.0.0.0`、`DATA_DIR=/data`
- 容器内数据目录是 `/data` 而不是默认的 `./data`，所以主密钥**不会**镜像到 `.env`（`.env` 在容器里也不持久）。想让 `.env` 也有，把宿主的 `.env` 挂进 `/app/.env`

### 镜像标签

| 标签 | 什么时候更新 |
|---|---|
| `latest` | 默认分支每次推送 |
| `main` | 同上，分支名标签 |
| `sha-<完整 commit>` | 每次推送，用来精确回滚 |
| `v1.2.3` / `v1.2` | 打 `v*` tag 时 |

镜像带 provenance 与 SBOM 认证。

### 私有包怎么拉

仓库是私有的，GHCR 包默认跟着私有。要拉需要：

```bash
echo <带 read:packages 的 PAT> | docker login ghcr.io -u <用户名> --password-stdin
```

或者去 package 设置里把可见性改成 public。

## 反向代理

### Caddy

SSE **必须关缓冲**，否则流式响应会被攒成一大块：

```text
gw.example.com {
    reverse_proxy 127.0.0.1:8800 {
        flush_interval -1
    }
}
```

### Nginx

```nginx
location / {
    proxy_pass http://127.0.0.1:8800;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP $remote_addr;
}
```

放在反代后面时保持 `TRUST_PROXY=true`，否则日志里的客户端 IP 全是反代地址。

## 升级

```bash
docker compose -f deploy/docker-compose.yml pull
docker compose -f deploy/docker-compose.yml up -d
```

数据库表结构变更由启动时的迁移自动处理（缺列会 `ALTER TABLE` 补上），不用手工动库。

## 备份

停不停服都行，直接拷数据目录 / 卷：

```bash
docker run --rm -v claudegate-data:/data -v $(pwd):/backup alpine \
  tar czf /backup/claudegate-$(date +%F).tar.gz -C /data .
```

## 上生产前的检查单

- [ ] `data/admin.json` 与 `.env` 都在备份范围里（前者存主密钥，删了要重新派发）
- [ ] 首次启动日志里的面板登录密钥已经存到密码管理器，日志本身没有外泄
- [ ] `PUBLIC_URL` 是真实对外地址
- [ ] TLS 已经由反代终止，SSE 缓冲已关
- [ ] 号池里至少两个可用账号（只有一个的话故障转移没意义）
- [ ] 出口 IP 已固定（配了[出站代理](proxy.md)或机器本身固定）
- [ ] 读过[已知风险](risks.md)
