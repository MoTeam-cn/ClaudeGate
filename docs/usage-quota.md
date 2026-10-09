# 用量与额度

## token 统计

四个维度都记：

- `input_tokens`
- `output_tokens`
- `cache_creation_input_tokens`
- `cache_read_input_tokens`

非流式直接从响应体读。流式由旁路嗅探器从 SSE 里抽——**只看不改字节**。

面板的请求日志按「入 / 出 / 缓存」三列展示；Key 的每日额度把缓存也算进去。

### 一个实现细节

流式用量**必须在每个分片上同步抄进记账对象**，不能等 `await` 之后统一赋值。

原因：`ServerResponse` 的 `close` 事件（落库时机）可能早于 `await` 之后的代码，
收尾时再写就来不及了。这个竞态会让流式请求的 token 全是 0，是测试跑出来的。

## 查询上游用量

| 账号类型 | 查法 |
|---|---|
| 订阅 OAuth | `GET /api/oauth/usage`，返回 `five_hour` / `seven_day` / `seven_day_opus` / `seven_day_sonnet` 等窗口的 `utilization` 与 `resets_at`，还有 `extra_usage` |
| Console API Key | **没有这个接口**。改从每次响应的 `anthropic-ratelimit-*` 头里观察各维度的 `limit` / `remaining` / `reset` |

面板号池页有「查用量」按钮，每个窗口显示百分比进度条与重置时间。
Console Key 查询会明确告诉你「只有订阅 OAuth 账号才有用量接口」，不是静默失败。

## 额度耗尽：封印而不是冷却

上游判定额度用尽时会返回这些信号：

| 信号 | 含义 |
|---|---|
| `billing_error` | 官方文案「usage limit reached — check plan」 |
| 消息含 `credit balance is too low` | 余额不足 |
| 消息含 `usage credits are required` / `extra usage is required` | 没开用量额度 |
| 消息含 `reached your specified ... usage limits` | 触达自定义上限 |
| 429 且 `anthropic-ratelimit-unified-status: rejected` | 限流窗口已打满 |

命中后账号状态变成 `exhausted`，调度器**直接跳过**它，并记下恢复时刻。

### 恢复时刻怎么定

1. 取 `anthropic-ratelimit-unified-5h-reset` 与 `-7d-reset` 里**最早**的那个
2. 再**封顶到 6 小时** —— 免得因为 7 天窗口把号一次关太久，到点后自然会再试探一次
3. 到期后调度器在下次挑号时**自动放回**，不用人工干预
4. 面板也可以「立即恢复」手动解除

### 和普通 429 的区别

这是两条路，别混：

| 情况 | 处理 |
|---|---|
| 普通 429（限流） | 冷却 1 分钟 |
| 额度耗尽 | 封印到重置时刻，最长 6 小时 |
| 401 / 403（认证类） | 冷却 10 分钟 |
| 5xx | 冷却 30 秒 |

### 溢出额度的原因也会带出来

如果上游给了 `anthropic-ratelimit-unified-overage-disabled-reason`，它会拼进封印原因，
让你一眼看出是没开溢出额度（`overage_not_provisioned`）、组织被禁（`org_level_disabled`）、
还是某个成员额度为零（`member_zero_credit_limit`）等等。

## 面板上的操作

| 位置 | 操作 |
|---|---|
| 号池 · 每行 | 「查用量」拉一次上游用量；「恢复」解除封印 |
| 号池 · 底部 | 「查询全部用量」「全部解除耗尽」「全部解除冷却」 |
| 概览 | 「额度耗尽」计数与清单卡片，每项可单独恢复 |
| 请求日志 | token 按「入 / 出 / 缓存」三列；被拦截的行红色底纹 |

## 计费口径

只有**真的转发到上游**的请求才计入 Key 的用量。

被网关拦下的请求（守卫、隐写、配额）不计入——否则会出现「因为超了额度所以被拦，
被拦的请求又推高额度」的自锁死循环。
