# 快速开始

## 前置条件

- **Node 22.6+**（用到了原生 TypeScript 直跑）
- `node:sqlite`：Node 22.5–23.3 需要 `--experimental-sqlite`，23.4+ 免标志
- 一个能出网的落地机（要固定出口 IP 就再配个[出站代理](proxy.md)）

## 启动

```bash
cp .env.example .env
```

至少要改两项：

- `ADMIN_TOKEN` —— 面板与 `/token` 的管理员令牌，**不设等于面板没有鉴权**
- `PUBLIC_URL` —— 对外展示用的地址，面板和文档里会引用它

```bash
npm start
```

启动日志会打印号池账号数、API Key 数、隐写模式与面板地址。打开：

```text
http://127.0.0.1:8080/panel
```

## 面板导览

设计意图是**只启动一次，剩下全在面板里做**：

| 页签 | 能做什么 |
|---|---|
| **概览** | 号池健康度、今日请求与 token、被拦截数、冷却中与额度耗尽的账号清单 |
| **号池** | OAuth 一键登录加号、粘贴 refresh_token、批量导入、导入 Console API Key；每个号显示用量进度条；可查用量、复位、立即恢复 |
| **API Key** | 发 Key、设指纹策略、绑协议白名单 / 模型白名单 / 固定账号、开关配额与限速 |
| **请求日志** | 按结果 / 协议 / 关键词过滤；被拦截的行红色底纹并写明原因；token 按「入 / 出 / 缓存」三列展示 |
| **运行日志** | 进程级事件：登录、令牌刷新、账号冷却、额度封印 |
| **设置** | 守卫模式、隐写模式、请求 ID 回传位置、日志保留策略 —— 写库并热生效 |

## 对外接口

| 协议 | 路径 | 认证 |
|---|---|---|
| Anthropic | `POST /v1/messages`（含 SSE） | `Authorization: Bearer <key>` 或 `x-api-key: <key>` |
| Anthropic | `POST /v1/messages/count_tokens` | 同上 |
| OpenAI | `POST /v1/chat/completions`（含 SSE） | `Authorization: Bearer <key>` |
| OpenAI | `GET /v1/models` | 同上 |
| 运维 | `GET /healthz` | 无 |
| 面板 | `/panel` | 不要令牌（静态外壳） |
| 面板接口 | `/panel/api` | `x-admin-token` 头，或 `?key=<ADMIN_TOKEN>`（留给 curl） |

## 三种令牌

网关认三种形态的令牌，行为完全不同：

| 形态 | 来源 | 行为 |
|---|---|---|
| `sk-gw-...` | 面板发放 | 按这把 Key 的配置决定指纹策略、配额、模型与协议白名单、绑定账号 |
| `gw1....` | `/token` 自签 | 走 Claude Code 指纹守卫，适合 Claude Code 直连 |
| `sk-ant-...` | 你自己的 Console Key | 直接透传上游，**不进号池、不记账** |

## Claude Code 接入

```bash
export CLAUDE_CODE_USE_GATEWAY=1
export ANTHROPIC_BASE_URL=https://gw.example.com
export ANTHROPIC_AUTH_TOKEN=<面板里发的 sk-gw- 或 /token 拿到的网关令牌>
```

> 注意：`~/.claude/settings.json` 里的 `env` 块**优先级高于 shell 环境变量**。
> 如果你在 settings.json 里写死了 `ANTHROPIC_BASE_URL`，改环境变量是不生效的，
> 要么改那份文件，要么用 `--settings` 传一份临时配置。

## OpenAI 兼容客户端接入

```text
base_url = https://gw.example.com/v1
api_key  = sk-gw-...
model    = claude-sonnet-4-5-20250929
```

也认一些常见别名，例如 `gpt-4o` 映射到 Sonnet 4.5、`o3` 映射到 Opus 4.5。

## 下一步

- 想让第三方客户端看起来像 Claude Code → [指纹与隐写](fingerprint.md)
- 想让号池别被单个号拖垮 → [用量与额度](usage-quota.md)
- 想固定出口 IP → [出站代理](proxy.md)
- 准备上生产 → [部署](deployment.md) 与 [已知风险](risks.md)
