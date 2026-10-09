# Anthropic 靠什么判断「你是不是官方 Claude Code」

> 结论先行：**在协议层，它基本不判断。** 官方文档明确把网关当成受支持的一等部署方式，
> 并逐条列出网关该转发什么。真正会让号出事的是**账号行为**，不是 TLS 指纹。

这份文档的依据全部可复现：官方网关兼容指南、Claude Code 2.1.293 二进制的字符串、
以及把真客户端指到本地抓包服务器抓下来的一份原始头。

## 一、官方是支持网关的，不是要抓它

官方《Claude Code gateway compatibility guide》原话（原文引用）：

> **Anthropic Messages format**: the developer sets `ANTHROPIC_BASE_URL` to your gateway.
> Claude Code treats the gateway as the Claude API and **can't tell which upstream you forward to**.

同一页还写着：Anthropic 不背书、不维护、不审计第三方网关产品。也就是说，
「用网关」本身不是违规项。文档里唯一的功能性限制是：走网关的会话不适用 HIPAA 配置。

所以**不要把精力花在「伪装成官方客户端」上**——那个检测在协议层并不存在。
要花精力的是下面第五节的账号行为。

## 二、官方要求网关转发什么

### 请求头

| 头 | 官方要求 |
|---|---|
| `anthropic-version` | **原样转发** |
| `anthropic-beta` | **原样转发**。原文：don't allowlist individual values, because the set changes with Claude Code releases |
| `anthropic-workspace-id` | 仅当上游是 Claude Platform on AWS 时原样转发 |
| `Authorization` / `x-api-key` | 网关可以消费（换成自己的上游凭据） |
| `x-claude-code-session-id` / `-agent-id` / `-parent-agent-id` | 网关可以消费，用于按会话或子代理归因成本 |
| 其他（含 `x-stainless-*`） | 文档没点名，属于「网关可自行消费或忽略」 |

### 响应头

| 头 | 为什么 |
|---|---|
| `content-type` | 流式必须是 `text/event-stream`，否则客户端判定流坏了 |
| `retry-after` | 必须是整数秒而不是 HTTP 日期；大于 60 会直接放弃重试 |
| `x-should-retry` | 原样透传，客户端据此决定是否重试 |
| `anthropic-ratelimit-unified-*` | 原样透传，客户端据此展示额度并区分「计划限额」与「临时限流」 |

错误响应体也必须原样转发，客户端的「能力被拒后自动降级重试」依赖上游的错误措辞。

### 启动探测

原文引用：Anthropic Messages 格式的网关会收到一条 `HEAD /api/hello` 连接预热探测，
「网关可以直接拒绝而不影响任何功能」。配了 HTTP 代理或客户端证书时 Claude Code 会跳过它。

本网关照 `api.anthropic.com` 的真实响应回：200 加 `{"message": "hello"}`（20 字节）。
能拒绝，但 404 与 200 是可观测差异，顺手对齐更省事。

### 明确不要做的两件事

1. **不要改写请求体**。原文：a gateway that rewrites or redacts request bodies for content
   inspection breaks the pairing the same way stripping does, so **inspect without modifying**。
   能力字段和它的 beta 头是成对的，改一边就会 400。
2. **不要白名单化头或字段**。原文：treat the headers and body fields as open lists, not closed ones。
   今天没见过的 `anthropic-*` 头与请求体字段，明天就会来。

## 三、官方客户端实际发的头（抓包原样）

把 Claude Code 2.1.293 指到本地抓包服务器，一次 `POST /v1/messages?beta=true` 收到 21 个请求头，
顺序如下（HTTP/1.1，未经任何中间层）：

```text
 1. Accept: application/json
 2. Authorization: Bearer <凭据>
 3. Content-Type: application/json
 4. User-Agent: claude-cli/2.1.293 (external, sdk-cli)
 5. X-Claude-Code-Session-Id: <uuid>
 6. X-Stainless-Arch: x64
 7. X-Stainless-Lang: js
 8. X-Stainless-OS: Windows
 9. X-Stainless-Package-Version: 0.128.0
10. X-Stainless-Retry-Count: 0
11. X-Stainless-Runtime: node
12. X-Stainless-Runtime-Version: v26.3.0
13. X-Stainless-Timeout: 600
14. anthropic-beta: claude-code-20250219,interleaved-thinking-2025-05-14,
                   thinking-token-count-2026-05-13,context-management-2025-06-27,
                   prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,
                   mid-conversation-tool-changes-2026-07-01,advanced-tool-use-2025-11-20,
                   effort-2025-11-24,dangerous-tool-use-2026-09-03,afk-mode-2026-01-31
15. anthropic-dangerous-direct-browser-access: true
16. anthropic-version: 2023-06-01
17. x-app: cli
18. Connection: keep-alive
19. Host: <目标>
20. Accept-Encoding: gzip, deflate, br, zstd
21. Content-Length: <body 长度>
```

几条值得注意的：

- **`X-Stainless-*` 是发的**。这 8 个头来自 Anthropic 的 TypeScript SDK（Stainless 生成），
  官方网关文档没提它们，但漏掉就是可观测差异。本网关默认全透传。
- **`anthropic-dangerous-direct-browser-access: true`** 恒发，即使用的是终端而不是浏览器。
- **`x-app: cli`**，后台会话是 `cli-bg`。二进制原文引用：
  `function bw(){return{"x-app":Nt()?"cli-bg":"cli","User-Agent":W0(),[eRt]:K()}}`。
- **User-Agent 的构造**（原文引用）：
  `claude-cli/${VERSION} (external, ${CLAUDE_CODE_ENTRYPOINT ?? cli}${agent-sdk/...}${client-app/...}${workload/...})`。
  我们的抓包里是 `(external, sdk-cli)` —— `sdk-cli` 来自 `CLAUDE_CODE_ENTRYPOINT`。
- **没有 `x-stainless-helper`**：它被 SDK 主动剥掉了（二进制里在删除集合里）。

请求体顶层字段：`model`、`messages`、`system`、`tools`、`metadata`、
`max_tokens`、`thinking`、`context_management`、`safeguards`、`output_config`、`stream`。
其中 `metadata.user_id` 是嵌套 JSON 字符串，含 `device_id` / `account_uuid` / `session_id`。

## 四、二进制里与「客户端身份」有关的开关

| 开关 | 作用 |
|---|---|
| `CLAUDE_CODE_ADDITIONAL_PROTECTION` | 为真时加一个头 `x-anthropic-additional-protection: true` |
| `CLAUDE_CODE_GATEWAY_HINT_HEADERS` | 见下 |
| `CLAUDE_CODE_ENTRYPOINT` / `CLAUDE_AGENT_SDK_VERSION` / `CLAUDE_AGENT_SDK_CLIENT_APP` | 拼进 User-Agent |

### 网关提示头（默认不发）

这是一组**路由提示**，不是身份证明：`x-claude-code-request-class`、
`x-claude-code-agent-type`、`x-claude-code-compaction`、
`x-claude-code-context-compacted`、`x-claude-code-prev-tool-durations`、
`x-claude-code-prompt-id`。

官方规则：直连 Anthropic 时默认发；**指向自定义 base URL 时默认不发**（怕中间层拒绝未知头），
要收得让用户设 `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`。本网关不需要它们，默认也不去要。

### 二进制里的「客户端保护头」集合

原文引用：`EP=new Set(["x-app",eRt,"x-claude-code-agent-id","x-claude-code-parent-agent-id",Hgr,ZCt,Fgr,"x-anthropic-additional-protection",$gr])`。
这个集合的用途是**禁止用户通过 `ANTHROPIC_CUSTOM_HEADERS` 覆盖这几个头**
（同处源码：`get isUserSupplied(){return this.source!=="claude-code"}`）。
也就是说 Anthropic 在客户端侧保护自己的指纹头不被用户改，而不是在服务端比对它们。

### 二进制里的 firstParty 判定

原文引用：`function Pe(){if(co()||hen()||yen())return"gateway";return a.CLAUDE_CODE_USE_BEDROCK?"bedrock":...:"firstParty"}`。
三个 `gateway` 判定函数分别是 `gatewayAuth()`、`gatewayServerProcess()`、
`gatewayRequiredByHostPolicy()` —— 全指 Anthropic 自家的 Cloud Gateway（企业托管那套），
**与你把 `ANTHROPIC_BASE_URL` 指向哪个自建网关无关**。

## 五、那到底什么会让你号出事

协议层既然不判定，风险就集中在**账号行为**上，按重要性排：

1. **多账号共用出口 IP**。这是最容易出事的：同 IP 下十几个订阅号并发跑，行为特征极明显。
   本网关的[出站代理](proxy.md)就是为这个准备的——每个号一个出口，或者至少一组一个。
2. **device_id 不稳定**。同一个号在多个 device_id 之间跳，或者多个号共用一个 device_id，
   两种都很显眼。本网关按号固定，见[指纹](fingerprint.md)。
3. **凭据跨机复用**。同一个 refresh_token 在两台机器上同时用，会触发 token 轮换冲突。
   所以别把同一个号同时挂到多个网关实例。
4. **请求节奏**。真人用 Claude Code 是有停顿的；脚本化的稳定 QPS 很容易被区分。

至于 TLS 指纹：它是**加分项而不是决定项**。同源 ClientHello 让流量在网络层看起来正常，
但服务端要判定一个号是否被滥用，看的是账号维度的时间序列，不是单个连接的握手。

## 六、JA3 的边界（别把它当成全部）

JA3 只覆盖 ClientHello 五个字段（版本、套件、扩展、曲线、点格式）的拼接哈希。它**不覆盖**：

- **扩展顺序**。JA3 先排序再哈希，所以顺序不同也可能同值。
- **ALPN 的具体取值顺序**、GREASE 值、padding 扩展长度。
- **HTTP/2 帧层**（SETTINGS 参数、窗口大小、伪头顺序、优先级）。这是与 JA3 完全独立的一层。
- **TLS 1.3 的 key_share 与 signature_algorithms**。
- **JA4**，它的设计目的就是补上 JA3 的排序问题。

四条路各自的实测值（同一台机器、同一个抓取器、同一个目标 IP）：

| 通道 | JA3 | 套件 | 扩展 | 曲线 | 点格式 |
|---|---|---|---|---|---|
| **真 Claude Code**（基准，对 IP 无 SNI） | `5260242a2eb12c71995767c24569bff5` | 17 | 12 | `11ec-1d-17-18` | `0` |
| Bun `fetch`（对 IP 无 SNI） | `5260242a2eb12c71995767c24569bff5` | 17 | 12 | `11ec-1d-17-18` | `0` |
| **真 Claude Code**（对域名，带 SNI） | `1523504b38f0fae0d881d4b6554aac1b` | 17 | 13 | `11ec-1d-17-18` | `0` |
| **Bun `fetch` 经 HTTP CONNECT 代理**（对域名，带 SNI） | `1523504b38f0fae0d881d4b6554aac1b` | 17 | 13 | `11ec-1d-17-18` | `0` |
| Bun `node:https` + 钉套件 | `c33df997f0ea608c617c58df7ad5f1f6` | 17 | 10 | `11ec-1d-17-18` | `0` |
| Node `node:https` + 钉套件 | `10ece698233123fa8829a8b2a7de6db1` | 17 | 11 | 8 条 | `0-1-2` |
| Bun `Bun.connect` | `117e3a479f24fc1d38052d156be91f71` | 17 | 10 | `11ec-1d-17-18` | `0` |

所以 `auto` 在 Bun 且没配代理时走 `fetch`，默认就是对齐的那条。

测量说明：抓取器绑在 `127.0.0.1` 上，所以 SNI 在两边都是缺的；换成真实域名后
两边都会补上 SNI，扩展集合会各自多一项，但相对差异不变。

本网关目前做到的是：**密码套件列表逐位一致、曲线一致、点格式一致、扩展集合一致**，
JA3 与真客户端相同。**扩展顺序与 HTTP/2 帧层没有对齐**，如实写在这里。
要不要继续往下做，取决于你怎么看待第五节的结论——如果风险主要来自账号行为，
在 HTTP/2 帧层继续投入的收益很小。

## 七、本机的一个实测发现

这台机器的 `~/.claude/settings.json` 里设了两个环境变量：
`CLAUDE_CODE_DISABLE_NONCE` 与 `CLAUDE_CODE_DISABLE_CLIENT_CONTEXT`。

在 Claude Code 2.1.293 的二进制里**搜不到这两个名字**（`DISABLE_NONCE` 0 次，
`CLIENT_CONTEXT` 0 次）。它们在这版里是空操作，不会带来任何保护，
也不会减少任何被检测面。留着无害，但不要以为它们关掉了什么。

## 八、本网关的对照实现

| 官方要求 | 本网关 |
|---|---|
| `HEAD /api/hello` 有响应 | 200 加与真端点逐字节相同的 body，见 `src/server.ts` 的 `hello()` |
| `anthropic-version` / `anthropic-beta` 原样转发 | 从 `req.rawHeaders` 重建，保序保大小写；beta 只做并集不做白名单 |
| 请求头保真 | 21 个抓包头逐位回放，见 `test/gateway-contract.test.ts` |
| 请求体不改写 | 只重写 `metadata.user_id` 的 `device_id`，其余原样 |
| 响应头透传 | 黑名单式丢弃，只丢逐跳头与真解压过的 `content-encoding` |
| `retry-after` / `x-should-retry` / `anthropic-ratelimit-unified-*` | 全部透传，有断言 |
| 错误响应体原样 | 是 |

## 参考

- [Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol)
- [Auto mode classifier request charges](https://code.claude.com/docs/en/auto-mode-classifier-billing)
- [Other LLM gateways](https://code.claude.com/docs/en/llm-gateway)
