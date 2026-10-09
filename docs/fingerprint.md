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

网关转发请求头时只做三件事，其余逐字节保留：

| 动作 | 头 |
|---|---|
| 原样保留 | `user-agent`、`x-app`、`x-claude-code-session-id`、7 个 `x-stainless-*`、`anthropic-version`、`accept`、`accept-encoding` 等 |
| 替换 | `authorization` / `x-api-key` → 换成号的凭据 |
| 重算 | `host`、`content-length` |

有一个坑值得单独说：**`anthropic-beta` 必须求并集，不能覆盖**。

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
`^req_[A-Za-z0-9_-]{1,36}$^{Q} 同形。

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

## 一个还没做的点

`metadata.user_id` 里嵌着一个 `device_id`，是跨会话恒定的 64 位十六进制指纹：

```json
{"device_id":"a9560f...","account_uuid":"","session_id":"..."}
```

**换 IP 带不走它**。网关当前原样透传。要切断与历史身份的关联需要改写这个字段，
那会改变上游看到的账号画像，属于独立决策，默认不做。
