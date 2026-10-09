# claude-gateway 规格（锁定版）

决策日期 2026-10-09。以下为已拍板项，实现以此为准。

## 1. 锁定决策

| # | 议题 | 决策 |
|---|---|---|
| 1 | 请求头守卫 | **按 Key 区分**：绑定了 Claude Code 指纹的 Key 走 strict 守卫；其他 Key 不守卫，但由网关注入规范指纹（UA / x-app / session-id / 去隐写） |
| 2 | 隐写命中 | **直接 Block**，响应体里说明本次为什么报错；同时按请求 ID 记录日志 |
| 3 | 号池导入 | 面板逐个 OAuth 登录 + 批量粘贴 refresh_token + 导入 Console API Key 列表（不做 ~/.claude 凭据文件导入） |
| 4 | 调度策略 | **会话粘性 + 轮询**：同一会话尽量固定一个号，号挂了才切；新会话轮询分配 |
| 5 | 日志存储 | **SQLite**，用 Node 内置 node:sqlite（零外部依赖） |
| 6 | 面板鉴权 | **首次启动自动派发登录密钥**，日志打印一次；登录密钥由主密钥单向派生，盘上只存 scrypt 哈希；面板内可重置。`ADMIN_TOKEN` 仅作逃生口 |
| 7 | 配额限速 | 支持限速与额度，但**做成可控开关**，默认关闭 |
| 8 | 号池凭据 | 订阅 OAuth 与 Console API Key **都支持**，默认订阅 OAuth |

## 2. 请求 ID 约定

- 每个请求生成一个 ID，格式为 req_ 加 26 个 base64url 字符。
  之所以用 req_ 前缀：Claude Code 自身校验的是 ^req_[A-Za-z0-9_-]{1,36}$，
  沿用同一形状便于客户端日志与服务端日志两侧对齐。
- **不进响应头**。按决策只放在**响应体**里：
  - 顶层 request_id 字段
  - 同时放进 error.request_id，方便各类 SDK 取用
- 成功响应默认不改写上游响应体（保证 Anthropic 原生透传保真）；
  成功请求的 ID 只进日志，靠日志检索定位。
  需要成功响应也带 ID 时，把 REQ_ID_IN_RESPONSE 设为 always。

## 3. 隐写拦截约定

检测规则（来自对 Claude Code 2.1.91 至 2.1.196 隐写标记机制的还原）：

| 规则 | 判定 |
|---|---|
| Today 与 s date is 之间的撇号不是 U+0027 | 命中，按码位区分含义 |
| 日期分隔符是斜杠而不是连字符 | 命中，表示中国时区标记 |
| 文本里出现 U+02BC 或 U+02B9 | 命中（这两个字符在正常文本里几乎不会出现） |

四个撇号的语义：

| 码位 | 含义 |
|---|---|
| U+0027 正常单引号 | 未命中任何名单 |
| U+2019 右单引号 | 命中域名名单 |
| U+02BC 修饰字母撇号 | 命中 AI 实验室关键词 |
| U+02B9 修饰字母角分符 | 两者都命中 |

拦截时响应体给出可读原因，例如：检测到 Claude Code 隐写标记，Today 后的撇号是 U+2019，
表示本机域名命中域名名单；该标记会把用户地域与中转站信息回传上游，已拦截。

STEGO_MODE 三档，默认 block：

| 值 | 行为 |
|---|---|
| block | 拒绝请求，返回错误（默认） |
| strip | 清洗标记后转发，仍记录日志 |
| log | 只记录，不改请求 |

## 4. 错误响应形状

Anthropic 路径：

    {
      "type": "error",
      "error": { "type": "...", "message": "...", "request_id": "req_..." },
      "request_id": "req_..."
    }

OpenAI 路径：

    {
      "error": { "message": "...", "type": "...", "code": "...", "param": null, "request_id": "req_..." },
      "request_id": "req_..."
    }

## 5. 模块规划

    src/
      ids.ts                请求 ID
      security/
        stego.ts            隐写检测与清洗
        inspect.ts          请求体检（隐写 + 指纹），产出裁决
      store/
        db.ts               node:sqlite 打开与建表
        accounts.ts         号池
        apikeys.ts          API Key
        logs.ts             请求日志与运行日志
      pool/
        scheduler.ts        会话粘性 + 轮询
      middleware/
        apikey.ts           Key 鉴权 + 守卫策略 + 配额
      panel/
        html.ts             单页（原生 JS，无构建）
        api.ts              面板后端接口
      routes/               对外协议路由

## 6. 分阶段交付

1. **第一阶段**：请求 ID + 隐写检测与拦截 + 测试
2. 第二阶段：SQLite 存储层（号池 / Key / 日志）
3. 第三阶段：调度器 + 按 Key 守卫 + 配额开关
4. 第四阶段：面板（登录、号池、Key、日志、设置）
5. 第五阶段：文档、部署、全量回归

## 7. 已知风险

- Anthropic 2026-02-19 更新文档，禁止第三方使用 Free/Pro/Max 订阅的 OAuth 令牌代路由请求，
  要求改用 Console API Key。号池默认走订阅 OAuth，属条款灰色地带，由使用者自担。
- node:sqlite 在 Node 22.5 至 23.3 需要 --experimental-sqlite 标志；Node 23.4 及以上默认可用。
- 隐写检测基于已知机制。若上游改变手法，需要同步更新 src/security/stego.ts 的规则表。

---

## 8. 实现状态（2026-10-09 收尾）

五个阶段全部交付，tsc --noEmit 0 错误，309 项断言全绿（smoke 84 + stego 56 + pool 95 + usage 74）。

| 阶段 | 内容 | 状态 |
|---|---|---|
| 一 | 请求 ID + 隐写检测拦截 | 完成 |
| 二 | SQLite 存储层（号池 / API Key / 请求日志 / 运行日志 / 设置） | 完成 |
| 三 | 调度器 + 按 Key 守卫 + 可控配额 | 完成 |
| 四 | 内置管理面板 | 完成 |
| 五 | 文档与部署 | 完成 |

## 9. 实现期补充的约定

### 配额只统计真正转发出去的请求
被守卫、隐写或配额自己拦下的请求不计入用量。否则被拒的请求会不断推高自己的计数，形成自锁。

### 用量写入攒批
node:sqlite 是同步 API，会阻塞事件循环。运行日志与 API Key 用量都先在内存攒批，
分别每 400ms 与 3s 落库；面板读用量时走 quota.usageToday，把攒批中的增量也算进去。

### 面板接口形状
面板只有一个 JSON 端点 /panel/api，动作走 action 查询参数（GET 读、POST 写），
避免为此引入路径参数路由。管理员密钥用 `X-Admin-Token` 头传递；`?key=` 仅保留给脚本。密钥首次启动自动派发并在日志打印一次，主密钥存 `data/admin.json` 并镜像到 `.env`，登录密钥由主密钥单向派生，面板内可重置。
面板返回的账号视图绝不包含 access_token / refresh_token / api_key 原文，只回布尔与预览。

### 号池的账号计数
账号请求数不逐请求更新（避免每请求一次写），面板的统计一律从 request_logs 聚合。

### 老数据迁移
启动时若号池为空且存在 data/credential.json，自动把它迁成一个账号，升级不丢登录态。

### 故障转移语义
上游返回 401 / 403 / 429 / 5xx 才冷却账号（分别 10 分钟 / 10 分钟 / 1 分钟 / 30 秒）；
4xx 里的客户端错误不牵连账号。冷却期内调度器跳过该号，并清掉指向它的会话粘性。

---

## 10. 用量与额度（2026-10-09 补充）

### 需求
1. token 与 usage 统计要准
2. 支持去上游查 API Key 额度
3. OAuth 账号也要能看用量
4. 特定错误码要标记账号并禁用，到额度重置或手动启用才恢复

### 上游能力（从 Claude Code 2.1.293 二进制还原）
- **OAuth 用量**：GET /api/oauth/usage
  - 响应：subscription_type、rate_limits_available、
    rate_limits{ five_hour / seven_day / seven_day_opus / seven_day_sonnet /
    seven_day_oauth_apps / seven_day_overage_included } 各含 utilization 与 resets_at，
    extra_usage{ is_enabled, monthly_limit, used_credits, utilization, currency }，
    以及 limits[] 数组（status 取 allowed / allowed_warning / rejected）
  - 该接口对 API Key、Bedrock、Vertex 会话不适用，rate_limits 恒为 null
- **限流响应头**（只出现在订阅流量上）
  - anthropic-ratelimit-unified-status：allowed / allowed_warning / rejected
  - anthropic-ratelimit-unified-5h-reset、-7d-reset：unix 秒
  - anthropic-ratelimit-unified-grace-5h-utilization、-7d-utilization
  - anthropic-ratelimit-unified-overage-disabled-reason：
    overage_not_provisioned / org_level_disabled / org_level_disabled_until / out_of_credits /
    seat_tier_level_disabled / member_level_disabled / seat_tier_zero_credit_limit /
    group_zero_credit_limit / member_zero_credit_limit / org_service_level_disabled /
    no_limits_configured / fetch_error / unknown
  - anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}
- **额度耗尽的错误分类**（取自客户端自身的分类表）
  - billing_error（官方文案 usage limit reached — check plan）
  - 消息含 credit balance is too low
  - 消息含 usage credits are required / extra usage is required
  - 消息含 reached your specified ... usage limits
  - 429 且 unified-status 为 rejected

### 实现约定
- 记账四维：input_tokens、output_tokens、cache_creation_input_tokens、cache_read_input_tokens
- 流式用量必须在每个分片上同步抄进记账对象。原因：ServerResponse 的 close 事件可能早于
  await 之后的赋值，收尾时再写就来不及落库（这是测试跑出来的竞态）
- 账号新增状态 exhausted，与 error / disabled 并列
- 恢复时刻取 5h / 7d 重置里最早的一个，再封顶 6 小时；到期由调度器在挑号时按需复活，
  不做时间节流（节流会让刚到点的号多关一会儿）
- Console API Key 没有用量接口，改为从响应头观察并落库；面板对这类账号明确显示「查询失败」原因
- 面板动作新增 account.usage（查用量，可单个或全部）与 account.revive（解除封印，可单个或全部）
- 手动「启用」一个 exhausted 账号时，同时清空封印，不需要额外点一次恢复
