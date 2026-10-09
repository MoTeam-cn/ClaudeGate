# 出站代理

> **代理不影响 TLS 指纹。** CONNECT 是透明隧道，TLS 端到端握到 Anthropic，
> 指纹是网关自己的。实测「Bun fetch 经 HTTP CONNECT 代理」与真 Claude Code 的
> JA3 完全一致。唯一不行的是 SOCKS5 —— Bun 的 fetch 直接报 `UnsupportedProxyProtocol`，
> 这时会退回 `node:https` 通道，代理照常可用但 JA3 对不上。
> 详见[指纹](fingerprint.md)。

落地机要固定出口 IP，或者机器本身出不去时，配 `UPSTREAM_PROXY` 就行。

## 支持的协议

| 写法 | 行为 |
|---|---|
| `http://user:pass@host:port` | 标准 HTTP 代理，CONNECT 隧道 |
| `https://user:pass@host:port` | 代理本身走 TLS，再在隧道里发 CONNECT |
| `socks5://user:pass@host:port` | **本地**解析域名，按 IP 连 |
| `socks5h://user:pass@host:port` | 把域名**交给代理**解析（推荐，不泄露 DNS） |

用户名密码都是可选的，支持 URL 编码（`%40` 这类）。

`socks4` / `socks4a` 不支持，配了会在启动时直接报错退出，不会静默降级。

## 环境变量回退

`UPSTREAM_PROXY` 为空时，依次回退：

```text
UPSTREAM_PROXY  →  ALL_PROXY  →  HTTPS_PROXY  →  HTTP_PROXY
```

所以如果你机器上已经有标准的代理环境变量，什么都不用配就能用上。

## 覆盖范围

代理作用于**所有出站请求**，不只是推理请求：

| 走代理的 | 说明 |
|---|---|
| `/v1/messages` 推理 | 主链路 |
| OAuth 授权码兑换 | 登录时 |
| 令牌刷新 | 订阅号过期时 |
| 用量查询 | 面板「查用量」 |

后三项原本用的是全局 `fetch`，而 `fetch` 走 undici、**不认我们的 Agent，会静默绕过代理**——
这些恰恰都在墙外。现在统一走 `src/net/request.ts`。

## TLS 在哪一层做

**在隧道里做，不是在代理里做。**

流程是：连代理 → 打通隧道 → 在隧道里对上游做 TLS 握手。

所以上游看到的仍然是我们自己的 TLS 指纹与 ALPN，代理只负责搬运字节。
配代理不会改变你在上游眼里的 TLS 特征。

## 排查

| 现象 | 多半是 |
|---|---|
| 启动就报「出站代理配置有误」 | 协议写错或端口超范围，日志里有具体原因 |
| 502 且日志里有 SOCKS5 错误码 | 看错误码：`主机不可达` 是代理解析不了域名，`目标拒绝连接` 是代理出不去 |
| 502 且提示认证失败 | SOCKS5 用户名密码不对 |
| 一直超时 | 代理地址不通，或 `UPSTREAM_TIMEOUT_MS` 太小 |
| 配了代理但流量没走代理 | 检查是不是有别的进程覆盖了环境变量；启动日志会打印「出站代理 socks5h://user:***@host:port」 |

启动日志里的代理地址**密码是打码的**。

## 一个 Node 的坑

实现上有个反直觉的地方值得记一下：

```js
new http.Agent({ createConnection: fn })   // Node 会静默忽略这个选项
agent.createConnection = fn                 // 必须在实例上赋值
```

写成前者的话，代理配置看起来生效了、请求也返回 200，但**实际上一直在裸连**。
这个问题是测试里「代理一条连接都没收到」才暴露出来的。
