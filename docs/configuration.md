# 配置

全部配置项都在 `.env.example` 里有注释版本，这里做分组说明。

## 配置优先级

```text
面板里改的设置（写进 SQLite）  >  .env / 环境变量  >  代码内默认值
```

面板可改的六项：`guardMode`、`stegoMode`、`reqIdInResponse`、`injectMissing`、
`logRetentionDays`、`runtimeLogMax`。改完立即生效，重启也保留。

## 监听

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8080` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PUBLIC_URL` | 无 | 对外展示地址，面板与文档里引用 |
| `TRUST_PROXY` | `true` | 是否信任 `x-forwarded-for` / `x-real-ip`；放在反代后面保持 true |

## 安全

| 变量 | 默认 | 说明 |
|---|---|---|
| `SECRET` | 空 | 网关令牌签名密钥；留空则首次启动生成到 `data/secret` |
| `ADMIN_TOKEN` | 无 | **必填**，面板与 `/token` 的鉴权令牌 |
| `TOKEN_TTL_DAYS` | `365` | 自签网关令牌有效期 |

## 上游

| 变量 | 默认 | 说明 |
|---|---|---|
| `UPSTREAM_BASE` | `https://api.anthropic.com` | 上游地址 |
| `UPSTREAM_PROXY` | 空 | 出站代理，见[出站代理](proxy.md) |
| `TLS_MIN` / `TLS_MAX` | `TLSv1.2` / `TLSv1.3` | 到上游的 TLS 版本范围，**不要随意改**，它是指纹的一部分 |
| `REWRITE_USER_ID` | `device` | `metadata.user_id` 重写模式：`off` 不动 / `device` 只换 device_id / `full` 连 account_uuid 一起 |
| `TRANSPORT` | `auto` | 上游通道。`auto` = Bun 且没配代理时走 `fetch`（JA3 与真 Claude Code 逐位一致，代价是请求头被重排），否则走 `node:https`（保头序、支持全部代理但 JA3 对不上）。要头序优先就显式设 `https` |
| `TLS_CIPHERS` | BoringSSL 那 17 个 | 出站密码套件。默认与真 Claude Code 一致；填 `default` 退回 Node 自带 52 个 |
| `UPSTREAM_ALPN` | `http/1.1` | ALPN 协议列表，同上 |
| `UPSTREAM_TIMEOUT_MS` | `600000` | 上游请求超时 |
| `UPSTREAM_MAX_SOCKETS` | `64` | 到上游的最大并发连接，按落地机内存与上游限额调 |

## 占用与限流

| 变量 | 默认 | 说明 |
|---|---|---|
| `MAX_BODY_BYTES` | 32 MiB | 单请求体上限 |
| `SHUTDOWN_GRACE_MS` | `5000` | 优雅退出宽限期 |

## 指纹守卫

| 变量 | 默认 | 说明 |
|---|---|---|
| `GUARD_MODE` | `strict` | `strict` 缺头直接 403 / `lenient` 缺头放行并告警 / `off` 不校验。**只对指纹策略为 `claude_code` 的 Key 生效** |
| `GUARD_REQUIRE` | 四个头 | 要求存在的头：`user-agent,x-app,anthropic-version,x-claude-code-session-id` |
| `INJECT_MISSING` | `false` | 为缺失的头注入规范值。指纹策略为 `passthrough` 的 Key 一律强制注入，与此开关无关 |

细节见[指纹与隐写](fingerprint.md)。

## 隐写拦截

| 变量 | 默认 | 说明 |
|---|---|---|
| `STEGO_MODE` | `block` | `block` 拒绝并说明原因 / `strip` 清洗后转发 / `log` 只记录 / `off` 不检测 |

## 请求 ID

| 变量 | 默认 | 说明 |
|---|---|---|
| `REQ_ID_IN_RESPONSE` | `error` | `error` 只有错误响应带 / `always` 成功响应也带 / `off` 不带 |

默认 `error` 是为了让成功响应保持字节级原样透传。

## OAuth

| 变量 | 默认 | 说明 |
|---|---|---|
| `OAUTH_MODE` | `claude_ai` | `claude_ai` 订阅账号走 Bearer 推理 / `console` 兑换 API Key / `design` |
| `OAUTH_CLIENT_ID` / `OAUTH_SCOPES` / `OAUTH_AUTHORIZE_URL` / `OAUTH_TOKEN_URL` | 内置 | 一般不用改 |
| `OAUTH_MANUAL_REDIRECT` | 官方回调页 | 手动粘贴授权码时的回调地址 |

## 模型与其他

| 变量 | 默认 | 说明 |
|---|---|---|
| `DEFAULT_MODEL` | `claude-sonnet-4-5-20250929` | 客户端没给模型时用 |
| `MAX_TOKENS_DEFAULT` | `8192` | 客户端没给 `max_tokens` 时用 |
| `DATA_DIR` | `./data` | SQLite 与密钥存放目录 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## 数据目录

`DATA_DIR` 下有：

```text
data/
  gateway.db         SQLite：账号、API Key、请求日志、运行日志、设置
  gateway.db-wal     预写日志（WAL 模式）
  secret             自动生成的签名密钥（如果 .env 里没给 SECRET）
```

备份直接拷整个目录即可。
