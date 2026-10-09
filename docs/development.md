# 开发

## 命令

```bash
npm start           # 直跑 TypeScript（原生类型擦除，无需构建）
npm run dev         # 带 --watch
npm run typecheck   # tsc --noEmit
npm test            # 全部测试
npm run build       # 产出 dist/，之后 node dist/src/index.js
npm run test:stream # 流式真实性探针：记录每个分片到达时刻
```

单独的测试套件：

```bash
npm run test:smoke     # 端到端：协议转译、鉴权、白名单、配额、面板 API
npm run test:stego     # 隐写检测与清洗
npm run test:pool      # 号池 CRUD、调度粘性/轮询/故障转移、面板 API
npm run test:usage     # token 计数、用量归一化、额度耗尽与恢复
npm run test:headers   # 上游请求头保真度
npm run test:proxy     # 四种出站代理
```

## 测试构成

| 套件 | 断言数 | 覆盖 |
|---|---|---|
| smoke | 84 | 端到端主链路 |
| stego | 56 | 四个码位、日期位置、清洗、模式切换 |
| pool | 95 | 号池与调度 |
| usage | 74 | 四维 token、用量归一化、限流头、封印与恢复 |
| userid | 33 | 按号固定 device_id、键序、补齐、额外键保留、off 模式 |
| headers | 29 | beta 并集、头顺序逐位一致、凭据头原地改名、第三方客户端补规范头 |
| proxy | 27 | CONNECT 与 SOCKS5、认证、域名解析策略、故障 |
| **合计** | **398** | |

测试全部监听 0 端口（随机端口），互不冲突，可以并行跑。

## 代码约定

- **零运行时依赖**。只用 Node 内置模块。`dependencies` 是空的，加依赖前先想想能不能自己写
- **TypeScript 直跑**。`tsconfig` 开了 `erasableSyntaxOnly`，所以不能用
  `enum`、命名空间、构造函数参数属性这些需要生成代码的语法
- 导入带 `.ts` 后缀（`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`）
- 类型导入必须写 `import type`（`verbatimModuleSyntax`）
- 面板是单文件原生 JS，**不用模板字符串**（用 `+` 拼接），因为整页是在一个
  JS 字符串里生成的

## 抓包脚本

仓库里有三个脚本，用来验证「真 Claude Code 到底发了什么」：

```bash
# 1. 起一个冒充 Anthropic 的抓包服务器
$env:PROBE_PORT="3100"; node test/capture-raw.ts
#    它把收到的每个请求原样写进 probe-raw/raw.jsonl

# 2. 让 Claude Code 指向它
claude --settings <一份把 ANTHROPIC_BASE_URL 指到 127.0.0.1:3100 的配置> -p "hi"

# 3. 把抓到的请求打进网关，逐头对比进出差异
node test/capture-compare.ts probe-raw/raw.jsonl
```

第三步会打印一张表：每个请求头「客户端发的 / 网关转给上游的 / 判定」，
外加**请求头顺序逐位对比**与 HTTP 版本对比。

```bash
# 4. 抓 TLS ClientHello 指纹（JA3），两边分别抓一次
node test/tls-probe.ts 3199
#    它只读第一个 TLS 记录就断开，所以自签证书不用管
#    把网关和 Claude Code 分别指到 127.0.0.1:3199，各抓一份对比
```

> 比对顺序时**必须按原始顺序重放**。如果拿 `req.headers` 那个对象重发，
> Node 会把 `Host` / `Connection` 补到末尾，量出来的是假差异 —— 这个坑踩过。

> 改 Claude Code 指向**必须用 `--settings`**。`~/.claude/settings.json` 里的 `env` 块
> 优先级高于 shell 环境变量，只改环境变量是不生效的。

## 踩过的坑

留着给以后的人（包括我自己）：

### 1. Agent 的 createConnection 会被静默忽略

```js
new http.Agent({ createConnection: fn })   // 无效
agent.createConnection = fn                 // 必须这样
```

写成前者的话，代理配置看起来生效、请求也返回 200，但实际一直在裸连。
是测试里「代理一条连接都没收到」才发现的。

### 2. 自定义隧道 socket 必须 resume

SOCKS5 握手期间为了不丢字节一直 `pause()`，交出去之前必须 `resume()`，
否则 Agent 挂上 `data` 监听也收不到数据，请求永远挂着。
HTTP CONNECT 路径没这问题（那条 socket 从没 pause 过），所以只测 CONNECT 会漏。

### 3. 正则里的斜杠要转义

```js
/^[a-zA-Z][a-zA-Z0-9+.-]*:///.test(s)    // 正则提前闭合，// 变注释，结果恒真
/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)  // 正确
```

用普通模板字符串写补丁时 `\/` 会被吃掉，要改用 `String.raw`。

### 4. 流式用量要每片同步抄

不能等 `await` 之后统一赋值 —— `res` 的 `close`（落库时机）可能抢先，
结果流式请求 token 全是 0。

### 5. anthropic-beta 只能并集

按同名覆盖会丢掉 `claude-code-20250219` 等标志，请求体里的 `thinking`
与 tool search 就失去声明了。

### 6. 头顺序：删了再加就跑到末尾

替换 `authorization` 时如果先 `delete` 再赋值，它会从第 2 位掉到倒数第 4 位。
头集合完全正确，顺序却变了 —— 而顺序本身是可观测的。
必须按 `req.rawHeaders` 逐对重建、在原下标就地改写。

### 7. content-length 别当逐跳头丢掉

丢了 Node 就退回 `transfer-encoding: chunked`，而真 Claude Code 发的是 `content-length`。
分帧方式同样是可观测的。要么按实际体长显式设置，要么让它原样流过。

### 8. 量顺序的时候别用 headers 对象重放

对比脚本如果拿 `req.headers`（解析后的对象）重建请求，Node 会把
`Host` / `Connection` 补到末尾，于是量出一个**根本不存在的差异**，
然后你去改一个没坏的地方。重放必须用 `rawHeaders` 逐对建对象。

## 加一个测试

往 `test/run-all.ts` 的 `files` 数组里加路径，再在 `package.json` 加一个
`test:<名字>` 脚本。测试文件的约定是：自己起 mock 上游、自己挑 0 端口、
结束时清理临时目录、最后打印 `PASS n  FAIL n` 并按失败数设置退出码。
