# 指纹与隐写

这一页解释网关为什么值得夹在你和上游之间。

## 两种 Key 策略

每把 `sk-gw-` Key 有一个指纹策略：

| 策略 | 网关做什么 | 用在哪 |
|---|---|---|
| `claude_code` | **校验**客户端头：UA 必须是 `claude-cli/*`、`x-app` 必须是 `cli` 等，缺头直接 403 | 真 Claude Code 客户端 |
| `passthrough` | **不校验**，但网关**强制注入**规范 UA / `x-app` / `x-claude-code-session-id` | Cursor、Cherry Studio、各种 SDK |

`x-claude-code-session-id` 由 API Key 主键派生，所以**同一把 Key 跨请求稳定**——
这正是「指纹稳定化」的落点：上游看到的始终是同一个人、同一个会话形态。

## 请求头保真度

网关按客户端**发来的原始顺序**重建请求头，只动必要的值：

| 动作 | 头 |
|---|---|
| 原样保留（含位置） | `user-agent`、`x-app`、`x-claude-code-session-id`、7 个 `x-stainless-*`、`anthropic-version`、`accept`、`accept-encoding` 等 |
| 原地替换（位置不变） | `authorization` / `x-api-key` → 换成号的凭据 |
| 原地改值 | `host` → 真实上游 |
| 按实际体长重算 | `content-length` |

实测：真 Claude Code 发 21 个头，网关转给上游也是 21 个，**同名、同序、同值**，
只有 `authorization` 的值换成号池凭据、`host` 指向上游、`anthropic-beta` 追加一项。

### 为什么顺序也要管

HTTP 头顺序本身是可观测的指纹。早先的实现把 `authorization` 删掉再追加，
它就从第 2 位掉到了倒数第 4 位 —— 头集合完全正确，顺序却露了馅。
现在按 `req.rawHeaders` 逐对重建，替换类的头在原下标就地改写。

### 传输分帧也要一致

早期实现把 `content-length` 当逐跳头丢掉，Node 于是退回 `transfer-encoding: chunked`。
真 Claude Code 发的是 `content-length`。现在按实际体长显式设置。

### `anthropic-beta` 必须求并集，不能覆盖

Claude Code 会带三个能力标志：

```text
claude-code-20250219,interleaved-thinking-2025-05-14,tool-search-tool-2025-10-19
```

而订阅 OAuth 账号自己的凭据里也要加 `oauth-2025-04-20`。如果按同名覆盖，
前三个就全丢了 —— 请求体里的 `thinking` 与 tool search 都依赖它们，
上游会拒或者行为异常。所以这里实现的是并集：

```text
进: claude-code-20250219,interleaved-thinking-2025-05-14,tool-search-tool-2025-10-19
出: claude-code-20250219,interleaved-thinking-2025-05-14,tool-search-tool-2025-10-19,oauth-2025-04-20
```

另外 `accept` 只兜底不覆盖：真 Claude Code 发的是 `application/json`，
替它改成 `text/event-stream` 会多一个可被识别的差异。

> 协议层要不要对齐、Anthropic 到底靠什么判断客户端，见 [Anthropic 检测面](anthropic-detection.md)。
> 这一节只讲 TLS 这一层。

## TLS 指纹

TLS ClientHello 是最难对齐的一层，因为它由运行时决定，不是参数能完全控制的。
实测同一台机器、同一个 TLS 服务端，真 Claude Code 与三种通道：

| 通道 | 密码套件 | 曲线 | 点格式 | 扩展 | JA3 |
|---|---|---|---|---|---|
| **真 Claude Code**（基准） | 17 | `11ec 1d 17 18` | `0` | 12 | `5260242a2eb12c71995767c24569bff5` |
| Node `node:https` + 钉套件 | 17 | `11ec 1d 17 1e 18 19 100 101` | `0-1-2` | 11 | `10ece698233123fa8829a8b2a7de6db1` |
| **Bun** `node:https` + 钉套件 | 17 | `11ec 1d 17 18` | `0` | 10 | `c33df997f0ea608c617c58df7ad5f1f6` |
| **Bun** `fetch` | 17 | `11ec 1d 17 18` | `0` | **12** | `5260242a2eb12c71995767c24569bff5` |

### 密码套件已经对齐

`TLS_CIPHERS` 默认把出站套件钉成 BoringSSL 那一份（17 个，顺序也一致），Node 从 52 个缩到 17 个。
想退回 Node 默认：`TLS_CIPHERS=default`。

### 曲线与点格式只有 Bun 对得上

Node 的 OpenSSL 发 8 条曲线、点格式 `0-1-2`；Bun 的 BoringSSL 发 4 条、点格式 `0`，
与真 Claude Code 一致。这一层 Node 不暴露、改不了 —— 所以**跑 Bun 是拿这一层的前提**。

### 只有 Bun 的 fetch 能拿到完全一致的 JA3

Bun 的 `node:https` 少 `status_request(5)` 与 `signed_certificate_timestamp(18)` 两个扩展
（`requestOCSP: true` 在 Bun 上被忽略，`Bun.connect` 也不带这两个）。
只有 `fetch` 走的是 Chrome 级配置，12 个扩展全对，JA3 与真客户端一字不差。

### fetch 的代价

因为 `fetch` 要付出两个代价：

1. **请求头被重排** —— Bun 的 `Headers` 会重排自定义头，而真 Claude Code 的头序是插入序。
   实测 `x-claude-code-session-id` 会跑到 `anthropic-beta` 后面去。
2. **不支持出站代理** —— SOCKS5 直接报 `UnsupportedProxyProtocol`，
   HTTP 代理只发绝对形式请求（CONNECT 隧道用不了）。

头序是确定性信号，代理是硬需求。但 Anthropic 官方网关文档**从头到尾没提过 TLS 指纹或头序**，
而 JA3 是 Cloudflare 那一层会看的东西（api.anthropic.com 就在 Cloudflare 后面）。
既然用户的目标是 TLS 指纹对齐，默认就让给 JA3 —— 想要头序显式设 `TRANSPORT=https`。所以：

所以 `auto` 的规则是**能拿 JA3 就拿**：

| `TRANSPORT` | 解析成 | 用在 |
|---|---|---|
| `auto`（默认） | Bun 且（没配代理，或代理是 http/https）-> `fetch`；否则 `https` | 默认就是最好指纹 |
| `https` | `node:https` | 头序优先、或需要出站代理时显式写死 |
| `fetch` | `fetch` | 强制走 fetch（Bun 上） |

启动日志会打出解析后的通道，以及为什么不是 fetch。

### 走不通的路（都试过）

| 试法 | 结果 |
|---|---|
| `Bun.connect` 加 `requestOCSP: true` | 对 ClientHello **毫无影响**，仍是 10 扩展 |
| `Bun.connect` 加 `ALPNProtocols` | 直接抛 `TLSOptions.ALPNProtocols must be of type string, ArrayBuffer, or null` |
| `fetch` 传普通对象 / `Headers.set` / `Headers.append` | 三种都重排，控制不了 |

也就是说「完全一致的 JA3」只有 `fetch` 一条入口，没有别的办法。

### 用 IP 还是域名，JA3 会不一样

抓取器绑在 `127.0.0.1` 上时两边都不发 SNI，比出来是 12 扩展、
JA3 `5260242a2eb12c71995767c24569bff5`；换成域名（`localhost`）两边都发 SNI，
变成 13 扩展、JA3 `1523504b38f0fae0d881d4b6554aac1b`。**两个基线都对，但要对同一个**。
生产环境走的是域名，所以真正要看的是后面那个。

想自己复现这张表：`node test/tls-probe.ts 3199` 起抓取器，把各个通道指过去即可。

## 隐写拦截

### 背景

Claude Code **2.1.91–2.1.196** 在 `ANTHROPIC_BASE_URL` 不是官方地址时，
会把「是否中国时区 / 是否命中域名名单」用隐写写进提示词的日期行。

### 标记对照表

| 码位 | 含义 |
|---|---|
| `U+0027` 普通单引号 | 未命中任何名单 |
| `U+2019` 右单引号 | 命中域名名单 |
| `U+02BC` 修饰字母撇号 | 命中 AI 实验室关键词 |
| `U+02B9` 修饰字母角分符 | 两者都命中 |
| 日期分隔符是**斜杠** | 中国时区标记 |

### 日期行在哪

**不在 `system` 数组里**，而在首条用户消息的 `<system-reminder>` 块里：

```text
<system-reminder>
Today's date is 2026-10-09.
</system-reminder>
```

干净的样子就是上面这样：`Today` 后面是普通 ASCII 撇号，日期分隔符是连字符。

### 检测策略

- `U+2019` **只在日期位置**判定，避免误伤提示词散文里正常的排版撇号
  （Claude Code 的系统提示词里本来就有一处 `it's` 用的是 `U+2019`）
- `U+02BC` / `U+02B9` 全局扫，正常文本里不该出现
- 命中后的行为由 `STEGO_MODE` 决定，默认 `block`：请求**不转发上游**，
  直接返回 400，并在响应体里讲清楚命中了哪一条、为什么、怎么处理

### 现状

2.1.293 **已经移除了这套代码**（实测抓包确认日期行干净）。但旧版本仍在流传，检测留着不亏。

### 怎么检查你自己的版本

把 Claude Code 指到一个本地抓包服务器（仓库里就有，见[开发](development.md)的抓包脚本一节），
看日期行里 `Today` 后面那个字符的码位与日期分隔符。

## 请求 ID

每个请求生成 `req_` 加 26 位 base64url，与 Claude Code 自身校验的
`^req_[A-Za-z0-9_-]{1,36}## 请求 ID

每个请求生成 `req_` 加 26 位 base64url，与 Claude Code 自身校验的
`^req_[A-Za-z0-9_-]{1,36} 同形。

**只放响应体，不进响应头** —— 加响应头会改变成功响应的字节，容易被看出中转。

```json
{
  "type": "error",
  "error": {
    "type": "...",
    "message": "...",
    "code": "...",
    "request_id": "req_..."
  },
  "request_id": "req_..."
}
```

默认 `REQ_ID_IN_RESPONSE=error`，成功响应保持原样透传；成功请求的 ID 只进日志。

## metadata.user_id：一个号一台设备

真 Claude Code 每次请求都带 `metadata.user_id`，是一个 **JSON 字符串**（二进制 @216149412，原文引用）：

```js
device_id: tI(),
account_uuid: Le(a.CLAUDE_CODE_REMOTE) && a.CLAUDE_CODE_ACCOUNT_UUID || oN()?.accountUuid || Dn()?.accountUuid || "",
session_id: K(),
```

实测抓到的样子：

```json
{"device_id":"a9560fe7b981ffb5e975ae92397185d74c62105e12010efdd0f1760c0abbfb6c","account_uuid":"","session_id":"d9eb1b8f-8829-465a-b833-f5097370171c"}
```

`device_id` 是 64 位十六进制、**跨会话恒定** —— 换 IP、换网络都带不走它。

### 问题

号池里多个人共用同一个号时，上游会看到**同一个号上飘着一堆不同的 device_id**：
一会儿是甲机器的，一会儿是乙机器的。这既不像正常用户（一个人的设备是固定的），
也把本来无关的人通过同一个号关联到了一起。

### 做法

网关给**每个号**生成一个专属 `device_id`（首次用到时生成，落库，之后不变），
转发前把 `metadata.user_id` 里的 `device_id` 换成这个值。

| 字段 | 怎么处理 |
|---|---|
| `device_id` | 换成**该号专属**的值，跨请求、跨会话恒定 |
| `account_uuid` | `device` 模式保持客户端原值；`full` 模式写成该号的 uuid |
| `session_id` | 保持客户端原值 —— 会话本来就该变 |
| 其余键（`ti`、`parent_session_id`、`tk`） | 原样保留，键序照真 Claude Code 的来 |

客户端**没带** `metadata.user_id` 时会补一个（`session_id` 取
`x-claude-code-session-id` 头）—— 真 Claude Code 每次都带，不带反而是特征。

`REWRITE_USER_ID` 控制：`off` / `device`（默认）/ `full`。

### 代价

改写意味着**请求体不再逐字节等于客户端发来的内容**。这是刻意的：
`metadata` 不参与 prompt cache，也不影响模型输出，只影响上游对设备身份的归并。
要恢复逐字节透传就把 `REWRITE_USER_ID` 设为 `off`。

## /v1/models 不受守卫

`GET /v1/models`（以及 HEAD）**不守卫**，缺什么头网关自己补。

守卫的目的是让上游看到的「客户端身份」稳定，那是**推理请求**的事。`/v1/models` 只是拉个清单，
没有推理、没有账号风险，却因为要求 Claude Code 身份头把 curl / 探活 / 监控全挡在外面，得不偿失。

所以这条路径直接放行，同时把 `User-Agent` / `x-app` / `anthropic-version` / `anthropic-beta` /
`x-claude-code-session-id` 全补成 Claude Code 的样子。`POST /v1/models` 与 `/v1/messages` 仍然守卫。

## 遇到 403「请求头校验失败」怎么办

绑定 `claude_code` 指纹策略的 Key，网关会拒绝看起来不像 Claude Code 的客户端，
以免账号因为异常客户端被上游风控。裸 `curl` 就会撞上：

```json
{"error":{"message":"请求头校验失败：缺少或不匹配 Claude Code 头 [user-agent, x-app]。...",
 "type":"permission_error","code":"header_guard_rejected"}}
```

两种改法：

1. **请求里带上身份头**（真 Claude Code 本来就会带）：

   ```bash
   curl http://<落地机>:8080/v1/models \
     -H "Authorization: Bearer sk-gw-..." \
     -H "User-Agent: claude-cli/2.1.293 (external, cli)" \
     -H "x-app: cli"
   ```

   `anthropic-version`、`anthropic-beta`、`x-claude-code-session-id` 不用管，网关注入。

2. **调试用客户端**（curl / Postman / 第三方 SDK）：在面板把该 Key 的指纹策略改成 `passthrough`。
   网关仍会补齐规范头，只是不再因为缺头拒绝。

### 为什么 session-id 不由客户端提供

`x-claude-code-session-id` 是网关从种子（API Key 主键或网关令牌）派生的，
目的是**同一个调用方跨请求稳定**。要求客户端提供它只会得到随机值，稳定性直接没了 ——
所以它属于「网关注入」而不是「客户端必填」。
