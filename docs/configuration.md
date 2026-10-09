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
| `ADMIN_TOKEN` | 空 | **逃生口**。留空时首次启动自动派发面板登录密钥并在日志里打印一次；显式设了就完全接管，不派发也不打印 |
| `ADMIN_SECRET` | 空 | 主密钥。留空则首次启动生成，写进 `data/admin.json` 并镜像到 `.env`。改它会让登录密钥重新派生并再打印一次 |
| `CG_ENV_FILE` | 工作目录的 `.env` | 读哪个 .env。设成空字符串表示既不读也不写（测试用） |
| `TOKEN_TTL_DAYS` | `365` | 自签网关令牌有效期 |

## 上游

| 变量 | 默认 | 说明 |
|---|---|---|
| `UPSTREAM_BASE` | `https://api.anthropic.com` | 上游地址 |
| `UPSTREAM_PROXY` | 空 | 出站代理，见[出站代理](proxy.md) |
| `IP_CHECK` | `block` | 出口自检。启动时带代理与不带代理各查一次出口 IP，两次相同说明请求没走代理。`block` 拒绝启动 / `warn` 只告警 / `off` 跳过。查不出结论（如内网无直连出口）不算失败 |
| `IP_CHECK_URL` | `https://ipinfo.io/json` | 出口自检用的 IP 回显服务。返回 `{ip:"..."}` / `{query:"..."}` 或纯 IP 文本都可以 |
| `TLS_MIN` / `TLS_MAX` | `TLSv1.2` / `TLSv1.3` | 到上游的 TLS 版本范围，**不要随意改**，它是指纹的一部分 |
| `REWRITE_USER_ID` | `device` | `metadata.user_id` 重写模式：`off` 不动 / `device` 只换 device_id / `full` 连 account_uuid 一起 |
| `TRANSPORT` | `auto` | 上游通道。`auto` = Bun 且（没配代理或代理是 http/https）时走 `fetch`（JA3 与真 Claude Code 逐位一致，代价是请求头被重排），否则走 `node:https`（保头序、支持 SOCKS5 但 JA3 对不上）。要头序优先就显式设 `https` |
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
| `GUARD_REQUIRE` | `user-agent,x-app` | 要求客户端提供的头。只该放「表明自己是 Claude Code」的身份头；`anthropic-version` / `anthropic-beta` / `x-claude-code-session-id` 由网关注入 —— session-id 是从 Key 种子派生的，让客户端提供只会被塞随机值，反而破坏跨请求稳定性 |
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
| `OAUTH_MODE` | `claude_ai` | `claude_ai` 建订阅账号、走 Bearer 推理，**保留 OAuth 令牌以便查订阅额度**；`console` 会把令牌兑换成 API Key（兑换失败直接报错，不会静默降级成订阅号）；`design` 走设计版客户端 |
| `OAUTH_CLIENT_ID` / `OAUTH_SCOPES` / `OAUTH_AUTHORIZE_URL` / `OAUTH_TOKEN_URL` | 内置 | 一般不用改 |
| `OAUTH_MANUAL_REDIRECT` | 官方回调页 | 手动粘贴授权码时的回调地址 |
| `OAUTH_PROFILE_URL` | `https://api.anthropic.com/api/oauth/profile` | 订阅账号档案端点。用来把「账号 1」这种占位名换成真实用户名（`account.display_name` / `full_name`），拿不到就退回占位名，不影响建号 |

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
  admin.json         面板登录密钥的 scrypt 哈希与主密钥（0600；删掉它会重新派发）
```

备份直接拷整个目录即可。

## 模型目录

`/v1/models` 返回的清单不再写死在代码里 —— 网关从 **Claude Code 自己用的那份远端目录** 拉取：

```
https://downloads.claude.ai/model-catalog/v1/catalog.json
```

这个地址是从 Claude Code 二进制里还原出来的（旁边还有 `schema.json` 定义形状，
以及 `raw-sig.json` 做 RSASSA-PKCS1-v1_5 / SHA-512 签名校验；网关不验签，只取数据）。

目录里每个模型长这样：

```json
{ "id": "claude-haiku-4-5", "family": "haiku", "display_name": "Haiku 4.5",
  "provider_ids": { "first_party": "claude-haiku-4-5-20251001" },
  "context": { "window": 200000 }, "max_output_tokens": { "default": 32000 } }
```

`id` 是家族名，`provider_ids.first_party` 才是真正发给上游的 id。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MODEL_CATALOG_URL` | `https://downloads.claude.ai/model-catalog/v1/catalog.json` | 目录地址 |
| `MODEL_CATALOG_TTL_MS` | `21600000`（6 小时） | 多久算过期 |
| `MODEL_VALIDATION` | `strict` | 消息接口是否校验模型 |

### 缓存怎么走

1. 启动时先从磁盘缓存装上（`<DATA_DIR>/model-catalog.json`），装不上就用内置清单。
2. 进程内只留一份快照。`/v1/models` **永远读内存**，不会为了这个请求出网。
3. 快照过期时，下一次访问会**在后台**刷一次，当前请求照旧用旧数据返回。
4. 拉不到就保留旧清单，并把原因记在面板的「模型目录」卡片上。

面板「设置 → 模型目录」能看到来源、条数、版本、上次拉取时间，也有「重新拉取」按钮。

### 模型校验

`MODEL_VALIDATION=strict`（默认）时，`/v1/messages` 与 `/v1/chat/completions` 的 `model`
必须在当前清单里，否则：

```json
{ "type": "error", "error": { "type": "invalid_request_error",
  "code": "model_not_found", "message": "model \"gpt-9-ultra\" 不在可用模型清单里。…" } }
```

认这几种写法：

- 家族 id：`claude-opus-5`
- 规范 id：`claude-haiku-4-5-20251001`
- 别名：`opus` / `sonnet` / `haiku` / `gpt-4o` …
- 带 `[1m]` 后缀：`claude-opus-5[1m]`（Claude Code 的 1M 上下文写法）
- 日期后缀可省：`claude-haiku-4-5` 等价于 `claude-haiku-4-5-20251001`

（最后两条跟 Claude Code 自己一致 —— 它匹配模型时会 `replace(/-\d{8}$/, "")`。）

校验读的是**当前快照**：目录刷新后，新出现的模型立刻可用，消失的立刻被拒。
想完全关掉就设 `MODEL_VALIDATION=off`。
