# 部署

## 系统要求

- Node **22.6+**（Docker 镜像用的是 Node 24）
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

```bash
docker pull ghcr.io/moteam-cn/claudegate:latest

docker run -d --name claudegate --restart unless-stopped \
  -p 8800:8800 \
  -v claudegate-data:/data \
  -e ADMIN_TOKEN=<足够长的随机值> \
  -e PUBLIC_URL=https://gw.example.com \
  -e UPSTREAM_PROXY=socks5h://user:pass@proxy.example.com:1080 \
  ghcr.io/moteam-cn/claudegate:latest
```

或者用仓库里的 compose：

```bash
cp .env.example .env      # 改 ADMIN_TOKEN 等
docker compose -f deploy/docker-compose.yml up -d
```

镜像的几个事实：

- 两阶段构建，运行阶段**只带编译产物**（项目零运行时依赖，`node_modules` 都不用装）
- 以非 root 用户 `node` 运行
- 数据都在 `/data` 卷里
- 自带 `HEALTHCHECK`，打的是 `/healthz`
- 默认 `PORT=8800`、`HOST=0.0.0.0`、`DATA_DIR=/data`

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

- [ ] `ADMIN_TOKEN` 是足够长的随机值，且没有提交进仓库
- [ ] `PUBLIC_URL` 是真实对外地址
- [ ] TLS 已经由反代终止，SSE 缓冲已关
- [ ] 号池里至少两个可用账号（只有一个的话故障转移没意义）
- [ ] 出口 IP 已固定（配了[出站代理](proxy.md)或机器本身固定）
- [ ] 读过[已知风险](risks.md)
