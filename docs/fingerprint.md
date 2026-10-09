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

## TLS 指纹

这是**唯一无法完全对齐**的一层。实测两边对同一个 TLS 服务端发出的 ClientHello：

| | 网关（Node / OpenSSL） | Claude Code（Bun / BoringSSL） |
|---|---|---|
| 密码套件 | 默认 52 个 | 17 个 |
| 扩展 | 11 个 | 12 个 |
| JA3 | `a44663b9db6ccaa680f6174478197a2f` | `5260242a2eb12c71995767c24569bff5` |

**套件列表已经对齐。** 网关默认把出站套件钉成 BoringSSL 那一份（17 个，顺序也一致），
JA3 从 `a44663b9…` 收敛到 `10ece698233123fa8829a8b2a7de6db1`。

**剩下对不齐的**，因为 Node 不暴露扩展顺序与曲线列表：

| 差异 | 网关 | Claude Code |
|---|---|---|
| 曲线列表 | `11ec 1d 17 1e 18 19 100 101`（8 个） | `11ec 1d 17 18`（4 个） |
| 点格式 | `0-1-2` | `0` |
| 独有扩展 | `renegotiation_info`、`encrypt_then_mac` | `status_request`、`signed_certificate_timestamp` |

要抹平这一层只能换 TLS 实现（BoringSSL / curl-impersonate 之类），不是 Node 参数能解决的。
实际影响也有限：JA3 是 Node/OpenSSL 的服务端指纹，在互联网上极其常见，
它说明「这是个服务端客户端」，而不是「这是个罕见可疑客户端」。

想退回 Node 默认套件（例如出站代理只支持老套件）：`TLS_CIPHERS=default`。


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
