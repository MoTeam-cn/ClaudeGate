# claude-gateway

Anthropic **号池网关**：把多个 Claude 账号聚合成一个池子，对外只暴露标准的
Anthropic 与 OpenAI 协议，并顺手把「指纹 / 时区 / 隐写标记」这些风控面收干净。

零运行时依赖 —— 只用 Node 内置模块（含 node:sqlite）。TypeScript 直跑，无需构建。

---

## 它解决什么

| 问题 | 做法 |
|---|---|
| 单号容易被打到限流或封 | 号池 + 会话粘性 + 轮询 + 故障转移（401/403 冷却 10 分钟，429 冷却 1 分钟） |
| Claude Code 的隐写标记把「中国用户 / 中转站」回传上游 | 检测 U+2019 / U+02BC / U+02B9 与斜杠日期，默认直接拦截并说明原因 |
| 第三方客户端被上游一眼看出 | 按 API Key 选择指纹策略；passthrough 的 Key 由网关强制注入规范 UA / x-app / session-id |
| 出问题查不到是哪条请求 | 每个请求一个 req-id，进响应体也进 SQLite；请求日志标出被拦截的记录 |
| 想给不同人不同权限 | API Key 可绑协议白名单、模型白名单、固定账号、限速与每日额度（可控开关） |

## 快速开始

    # Node 22.6+（node:sqlite 在 22.5-23.3 需要 --experimental-sqlite，23.4+ 免标志）
    node -v

    cp .env.example .env
    # 至少改两项：ADMIN_TOKEN 与 PUBLIC_URL
    npm start

打开 http://127.0.0.1:8080/panel?key=<ADMIN_TOKEN> 就是面板。**启动一次之后所有事都在面板里做**：

- **号池**：OAuth 一键登录加号、粘贴 refresh_token、批量导入、导入 Console API Key
- **API Key**：发 Key、设指纹策略、绑协议/模型/账号、开关配额与限速
- **请求日志**：按结果/协议/关键词过滤，被拦截的行红色底纹并写明原因
- **运行日志**：进程级事件（登录、刷新、冷却、错误）
- **设置**：守卫模式、隐写模式、请求 ID 回传位置、日志保留策略（写库，热生效）

## 对外接口

| 协议 | 路径 | 认证 |
|---|---|---|
| Anthropic | POST /v1/messages（含 SSE） | Authorization: Bearer <key> 或 x-api-key: <key> |
| Anthropic | POST /v1/messages/count_tokens | 同上 |
| OpenAI | POST /v1/chat/completions（含 SSE） | Authorization: Bearer <key> |
| OpenAI | GET /v1/models | 同上 |

三种令牌都认：

- sk-gw-...  面板发放的 API Key（按 Key 决定指纹策略、配额、白名单）
- gw1....    网关自签令牌（Claude Code 直连场景，走 Claude Code 指纹守卫）
- sk-ant-... 直接把上游 Console Key 透传（不进号池，不记账）

### Claude Code 接入

    export CLAUDE_CODE_USE_GATEWAY=1
    export ANTHROPIC_BASE_URL=https://gw.example.com
    export ANTHROPIC_AUTH_TOKEN=<面板里发的 sk-gw- 或 /token 拿到的网关令牌>

### OpenAI 兼容客户端接入

    base_url = https://gw.example.com/v1
    api_key  = sk-gw-...
    model    = claude-sonnet-4-5-20250929（也认 gpt-4o / o3 等别名）

## 指纹策略：两种 Key

| 策略 | 行为 | 用在哪 |
|---|---|---|
| claude_code | 要求 UA 为 claude-cli/*、x-app 为 cli 等；缺头直接 403 | 真 Claude Code 客户端 |
| passthrough | 不校验客户端头，但网关**强制注入**规范 UA / x-app / session-id | Cursor、Cherry Studio、各种 SDK |

session-id 由 API Key 主键派生，所以同一把 Key 跨请求稳定 —— 这正是「指纹稳定化」的落点。

## 隐写拦截

Claude Code 2.1.91–2.1.196 在 ANTHROPIC_BASE_URL 非官方时，会把「是否中国时区 / 是否命中域名名单」
用隐写写进系统提示词的日期行：

| 码位 | 含义 |
|---|---|
| U+0027 正常单引号 | 未命中任何名单 |
| U+2019 右单引号 | 命中域名名单 |
| U+02BC 修饰字母撇号 | 命中 AI 实验室关键词 |
| U+02B9 修饰字母角分符 | 两者都命中 |
| 日期分隔符是斜杠 | 中国时区标记 |

网关检测这几项，默认 STEGO_MODE=block —— 请求**不转发上游**，直接返回 400 并在响应体里讲清楚原因。
2.1.293 已经移除了这套代码，但旧版本仍在流传，检测留着不亏。

## 用量与额度

### token 统计

四个维度都记：`input_tokens`、`output_tokens`、`cache_creation_input_tokens`、
`cache_read_input_tokens`。非流式从响应体读，流式由旁路嗅探器从 SSE 里抽（只看不改字节），
**每个分片同步抄进记账对象**——因为响应的 close 事件可能早于 `await` 之后，收尾时再赋值就来不及落库。
面板的请求日志按「入 / 出 / 缓存」三列展示，Key 的每日额度把缓存也算进去。

### 查询上游用量

| 账号类型 | 查法 |
|---|---|
| 订阅 OAuth | `GET /api/oauth/usage`，返回 `five_hour` / `seven_day` 等窗口的 utilization 与 resets_at，还有 extra_usage |
| Console API Key | 没有用量接口。改从每次响应的 `anthropic-ratelimit-*` 头里观察各维度的 limit / remaining / reset |

面板号池页有「查用量」按钮，每个窗口显示百分比进度条与重置时间。

### 额度耗尽：标记、禁用、自动恢复

上游判定额度用尽时会返回这些信号，网关据此**把账号封印而不是只冷却几分钟**：

| 信号 | 含义 |
|---|---|
| `billing_error` | 官方文案「usage limit reached — check plan」 |
| 消息含 `credit balance is too low` | 余额不足 |
| 消息含 `usage credits are required` / `extra usage is required` | 没开用量额度 |
| 消息含 `reached your specified ... usage limits` | 触达自定义上限 |
| 429 且 `anthropic-ratelimit-unified-status: rejected` | 限流窗口已打满 |

命中后账号状态变 `exhausted`，调度器直接跳过，并记下恢复时刻：

- 恢复时刻取 `anthropic-ratelimit-unified-5h-reset` / `-7d-reset` 里**最早**的那个
- 再封顶到 6 小时——免得因为 7 天窗口把号一次关太久，到点后自然会再试探一次
- 到期后调度器在下次挑号时自动放回，不用人工干预
- 面板可以「立即恢复」手动解除

这跟普通 429 是两条路：普通限流只冷却 1 分钟，额度耗尽才封印到重置。

## 出站代理

落地机要固定出口 IP，或者机器本身出不去时，配 `UPSTREAM_PROXY` 就行。四种都支持：

| 写法 | 行为 |
|---|---|
| `http://user:pass@host:port` | 标准 HTTP 代理，CONNECT 隧道 |
| `https://user:pass@host:port` | 代理本身走 TLS，再在隧道里发 CONNECT |
| `socks5://user:pass@host:port` | 本地解析域名，按 IP 连 |
| `socks5h://user:pass@host:port` | 把域名交给代理解析（推荐，不泄露 DNS） |

`UPSTREAM_PROXY` 为空时依次回退 `ALL_PROXY` / `HTTPS_PROXY` / `HTTP_PROXY`。

两个容易踩的点，这里都已经处理好：

- **OAuth 兑换、令牌刷新、用量查询也走代理。** 这些原本用全局 `fetch`，而 `fetch` 走 undici、
  不认我们的 Agent，会静默绕过代理——现在统一走 `src/net/request.ts`。
- **TLS 在隧道里做，不是在代理里做。** 上游看到的仍然是我们自己的 TLS 指纹与 ALPN，
  代理只负责搬运字节。

## 请求 ID

每个请求生成 req_ 加 26 位 base64url（与 Claude Code 自身校验的 ^req_[A-Za-z0-9_-]{1,36}$ 同形）。
**只放响应体、不进响应头**：

    { "type": "error",
      "error": { "type": "...", "message": "...", "code": "...", "request_id": "req_..." },
      "request_id": "req_..." }

默认 REQ_ID_IN_RESPONSE=error，成功响应保持原样透传不被改写；成功请求的 ID 只进日志。

## 配置

见 .env.example。面板里可改的六项（guardMode / stegoMode / reqIdInResponse / injectMissing /
logRetentionDays / runtimeLogMax）写进数据库，启动时优先于 .env。

## 部署

    # 落地机（Debian/Ubuntu 示例）
    sudo useradd -r -s /usr/sbin/nologin claude-gw
    sudo mkdir -p /opt/claude-gateway
    sudo rsync -a --exclude node_modules --exclude data ./ /opt/claude-gateway/
    sudo chown -R claude-gw:claude-gw /opt/claude-gateway
    cd /opt/claude-gateway && sudo -u claude-gw npm ci --omit=dev
    sudo cp deploy/claude-gateway.service /etc/systemd/system/
    sudo systemctl enable --now claude-gateway

### Docker

镜像由 GitHub Actions 自动构建推到 GHCR：

    docker pull ghcr.io/moteam-cn/claudegate:latest
    docker run -d --name claudegate --restart unless-stopped \
      -p 8800:8800 \
      -v claudegate-data:/data \
      -e ADMIN_TOKEN=换成一串足够长的随机值 \
      -e PUBLIC_URL=https://gw.example.com \
      -e UPSTREAM_PROXY=socks5h://user:pass@proxy.example.com:1080 \
      ghcr.io/moteam-cn/claudegate:latest

或者用仓库里的 compose：

    cp .env.example .env   # 改 ADMIN_TOKEN 等
    docker compose -f deploy/docker-compose.yml up -d

数据都在 `/data` 卷里（SQLite）。镜像里带 `HEALTHCHECK`，打的是 `/healthz`。

### Caddy 反代（SSE 必须关缓冲）

    gw.example.com {
        reverse_proxy 127.0.0.1:8800 {
            flush_interval -1
        }
    }

## 开发

    npm run typecheck   # tsc --noEmit
    npm test            # 全部测试：smoke + stego + pool + usage + headers + proxy
    npm run test:stream # 流式真实性探针（记录每个分片到达时刻）
    npm run build       # 产出 dist/，node dist/src/index.js 可跑

测试覆盖 354 项断言：协议转译、SSE、守卫、隐写、号池 CRUD、调度粘性/轮询/故障转移、
API Key 鉴权、模型与协议白名单、配额开关与限速、面板 API、请求与运行日志、
token 四维计数（流式与非流式）、用量响应归一化、限流头观测、额度耗尽判定与自动/手动恢复、
上游请求头保真度（anthropic-beta 并集）、四种出站代理（含 SOCKS5 认证与域名解析策略）。

## 模块地图

    src/
      index.ts              入口（监听 + 优雅退出）
      server.ts             装配：路由表、每请求上下文、记账、收尾落库
      config.ts             环境变量与运行时设置
      ids.ts                请求 ID 与会话键派生
      guard.ts              按 Key 的指纹守卫与规范头注入
      proxy.ts              上游调用：挑号 + 注入凭据
      upstream.ts           连接池、TLS 指纹、SSE 转发、用量嗅探
      net/proxy.ts          出站代理：http / https / socks5 / socks5h
      net/request.ts        代理感知的 HTTP 客户端（替掉全局 fetch）
      oauth.ts              OAuth PKCE 与令牌刷新原语
      security/stego.ts     隐写检测与清洗
      security/inspect.ts   请求体检裁决
      store/                SQLite：db / accounts / apikeys / logs / settings
      pool/scheduler.ts     会话粘性 + 加权轮询 + 故障转移 + 耗尽账号封印与复活
      pool/credentials.ts   按账号的令牌刷新（并发去重）
      pool/usage.ts         上游用量查询与限流响应头观测
      pool/exhaustion.ts    额度耗尽判定
      pool/observe.ts       上游响应观测：记账号、抓错误类型、判耗尽
      middleware/           auth（三种令牌 + 策略）/ quota（限速与额度）
      routes/               admin / auth / anthropic / openai / panel
      panel/                单页面板（原生 JS，无构建）与后端 API
      translate/            OpenAI ↔ Anthropic 双向转译

## 已知风险

- Anthropic 2026-02-19 更新文档，禁止第三方使用 Free/Pro/Max 订阅的 OAuth 令牌代路由请求，
  要求改用 Console API Key。号池默认走订阅 OAuth，属条款灰色地带，由使用者自担。
- node:sqlite 在 Node 22.5–23.3 需要 --experimental-sqlite；23.4+ 默认可用。
- 隐写检测基于已知机制，上游若改手法需要同步更新 src/security/stego.ts 的规则表。
- `metadata.user_id` 里的 `device_id` 是跨会话恒定的 64 位十六进制指纹，换 IP 带不走。
  网关当前原样透传；要切断与历史身份的关联需要改写该字段，属独立决策，默认不做。
