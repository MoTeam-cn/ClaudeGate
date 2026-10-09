# 架构

## 一次请求的完整路径

以 `POST /v1/messages` 为例：

```text
 1. 进入 server.ts 的请求处理
 2. 建 RequestMeta + RequestTracker，用 WeakMap 挂在 res 上
 3. 路由匹配（预建的 Map 索引，不做线性扫描）
 4. 鉴权 middleware/auth.ts —— 识别 sk-gw- / gw1. / sk-ant- 三种令牌，得出 AuthState
 5. 指纹守卫 guard.ts —— 按 Key 策略校验或注入规范头
 6. 配额 middleware/quota.ts —— 限速与每日额度（可控开关，默认关）
 7. 读 body（readJson，受 MAX_BODY_BYTES 限制）
 8. 隐写体检 security/inspect.ts —— block / strip / log / off
 9. Key 策略检查 —— 协议白名单、模型白名单
10. proxy.ts callUpstream
      a. scheduler.pick()  挑号（粘性 → 绑定 → 轮询）
      b. credentials.ensure()  必要时刷新令牌（并发去重）
      c. buildUpstreamHeaders()  注入凭据，其余头保真
      d. upstreamRequest()  经 Agent（含代理）发出
11. noteUpstream() —— 记下用了哪个号，观测限流响应头
12. 响应
      · 错误：读完错误体，判额度耗尽，原样回给客户端
      · 流式：pipeUpstream 边收边发，旁路嗅探器抽 usage
      · 非流式：读完整 JSON，抽 usage，再原样回
13. res.once("close") → finalize
      · 写请求日志
      · 提交配额（被拦的请求不提交）
      · 向调度器汇报成功 / 失败 / 额度耗尽
```

## 模块地图

```text
src/
  index.ts              入口：监听、启动日志、优雅退出
  server.ts             装配：路由表、每请求上下文、记账、收尾落库
  config.ts             环境变量解析与运行时设置热应用
  ids.ts                请求 ID 与会话键派生
  guard.ts              按 Key 的指纹守卫与规范头注入
  proxy.ts              上游调用：挑号 + 注入凭据
  upstream.ts           连接池、TLS 指纹、SSE 转发、用量嗅探、响应头白名单
  oauth.ts              OAuth PKCE、令牌刷新、beta 并集
  tokens.ts             自签网关令牌（gw1.）
  models.ts             模型别名映射

  net/
    proxy.ts            出站代理：http / https / socks5 / socks5h
    request.ts          代理感知的 HTTP 客户端（替掉全局 fetch）

  security/
    stego.ts            隐写检测与清洗
    inspect.ts          请求体检裁决

  store/
    db.ts               SQLite 打开、建表、老库补列迁移
    accounts.ts         号池账号 CRUD 与状态机
    apikeys.ts          API Key（sha256 存储）与每日用量
    logs.ts             请求日志与运行日志（批量写）
    settings.ts         键值设置

  pool/
    scheduler.ts        会话粘性 + 加权轮询 + 故障转移 + 耗尽封印与复活
    credentials.ts      按账号的令牌刷新（并发去重）
    usage.ts            上游用量查询与限流响应头观测
    exhaustion.ts       额度耗尽判定
    observe.ts          上游响应观测：记账号、抓错误类型、判耗尽

  middleware/
    auth.ts             三种令牌 + 策略检查 + 拒绝响应
    quota.ts            限速与每日额度

  routes/               admin / auth / anthropic / openai / panel
  panel/                单页面板（原生 JS，无构建）与后端 API
  translate/            OpenAI ↔ Anthropic 双向转译
  http/                 body 读取、响应助手、上下文、错误页
```

## 存储

SQLite（`node:sqlite`，WAL 模式，`busy_timeout` 5000）。五张表：

| 表 | 内容 |
|---|---|
| `accounts` | 号池账号：凭据、状态、冷却、耗尽封印、用量快照、限流观测 |
| `api_keys` | API Key（只存 sha256 与前缀）、指纹策略、白名单、配额开关 |
| `api_key_usage` | 按 Key 按天的请求数与四维 token |
| `request_logs` | 每请求一行：来源、协议、模型、账号、状态、耗时、token、拦截原因 |
| `runtime_logs` | 进程级事件 |
| `settings` | 面板可改的运行时设置 |

表结构变更由启动时的迁移处理：先建表（`CREATE TABLE IF NOT EXISTS`），
再按 `PRAGMA table_info` 探测缺列并 `ALTER TABLE` 补上。老库直接能用。

`node:sqlite` 是同步 API，所以日志走批量写（运行日志 400ms、用量 3s 落一次），
避免每个请求都阻塞事件循环。

## 调度策略

挑号顺序：

1. **Key 绑定** —— 如果这把 Key 绑了固定账号，优先用
2. **会话粘性** —— 同一会话键优先复用上次的号（30 分钟 TTL，上限 4096 条）
3. **加权轮询** —— 按 `weight` 展开成槽位依次取

健康判定：状态为 `active` 且不在冷却期。额度耗尽的号单独排除，
到重置时刻由调度器在下次挑号时按需复活（先用已读出的账号列表判断有没有到期的，有才写库）。

失败汇报决定冷却时长：

| 上游返回 | 冷却 |
|---|---|
| 401 / 403 | 10 分钟 |
| 429 | 1 分钟 |
| 5xx | 30 秒 |
| 4xx 客户端错误 | 不牵连账号 |
| 额度耗尽 | 封印到重置时刻，最长 6 小时 |

## 并发与背压

- **不启 cluster** —— 单进程足够，也避免多进程争 SQLite 写锁
- **SSE 背压**：`pipeUpstream` 用 `stream.pipeline`；下游写不动时
  （`res.write()` 返回 false）暂停上游，`drain` 后恢复，不会把内存堆爆
- **连接复用**：到上游是 keep-alive Agent，固定 TLS 版本与 ALPN，`maxSockets` 可调
- **令牌刷新去重**：同一账号并发触发刷新只会真的刷一次

## 响应头转发

白名单 + 前缀放行，不是无脑透传：

| 动作 | 头 |
|---|---|
| 放行 | 白名单内的头 + 所有 `anthropic-ratelimit-*` 前缀 |
| 丢弃 | `set-cookie`、`anthropic-organization-id`、上游内部调试头 |
| 兜底补 | 没有 `cache-control` 就补 `no-store`；没有 `content-type` 就补 `application/json` |

响应体本身**逐字节透传**，`usage` 四维完整保留。
