# ClaudeGate

把多个 Claude 账号聚合成一个号池，对外只暴露标准的 **Anthropic** 与 **OpenAI** 协议，
并顺手把指纹、时区、隐写标记这些风控面收干净。

零运行时依赖 —— 只用 Node 内置模块（含 `node:sqlite`）。TypeScript 直跑，也可以编译后部署。

## 它能做什么

| 能力 | 说明 |
|---|---|
| **号池调度** | 会话粘性 + 加权轮询 + 故障转移，单号限流不拖累整体 |
| **指纹稳定化** | 按 API Key 选策略；第三方客户端被强制补成 Claude Code 的样子 |
| **隐写拦截** | 拦下旧版 Claude Code 把「中国时区 / 命中域名名单」回传上游的标记 |
| **用量与额度** | token 四维统计，可查上游用量，额度耗尽自动封印账号、到点自动恢复 |
| **出站代理** | `http` / `https` / `socks5` / `socks5h`，用于固定出口 IP |
| **面板** | 号池、API Key、请求日志、运行日志、设置；启动一次之后全在面板里操作 |

## 快速开始

```bash
node -v                 # 需要 22.6+；node:sqlite 在 23.4+ 免标志
cp .env.example .env    # 至少改 ADMIN_TOKEN 与 PUBLIC_URL
npm start
```

打开 `http://127.0.0.1:8080/panel` 就是面板 —— 首次进入会弹窗问管理员令牌，填了存在浏览器本地，之后免填。

Docker：

```bash
docker run -d --name claudegate --restart unless-stopped \
  -p 8800:8800 -v claudegate-data:/data \
  -e ADMIN_TOKEN=<足够长的随机值> \
  ghcr.io/moteam-cn/claudegate:latest
```

## 文档

| 文档 | 内容 |
|---|---|
| [快速开始](docs/getting-started.md) | 启动、面板导览、对外接口、两种客户端接入 |
| [配置](docs/configuration.md) | 全部环境变量与面板可改项 |
| [部署](docs/deployment.md) | systemd、Docker、GHCR、反向代理 |
| [Anthropic 检测面](docs/anthropic-detection.md) | 官方网关契约、真实抓包头清单、JA3 的边界 |
| [指纹与隐写](docs/fingerprint.md) | 两种 Key 策略、规范头注入、隐写码位表、请求 ID |
| [用量与额度](docs/usage-quota.md) | token 统计、上游用量查询、额度耗尽封印与恢复 |
| [出站代理](docs/proxy.md) | 四种代理协议、覆盖范围、排查 |
| [面板](docs/panel.md) | 零依赖单页面板的结构与六个痛点怎么解的 |
| [架构](docs/architecture.md) | 请求生命周期、模块地图、存储与调度 |
| [开发](docs/development.md) | 命令、测试构成、抓包脚本、踩过的坑 |
| [已知风险](docs/risks.md) | 条款、版本、安全注意事项 |
| [设计规格](docs/SPEC.md) | 锁定的设计规格与实现状态 |

## 许可

Apache-2.0，见 [LICENSE](LICENSE)。

用之前请读一遍[已知风险](docs/risks.md)。
