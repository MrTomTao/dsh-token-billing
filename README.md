# dsh-token-billing

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web GUI 用的 **会话 token 计费插件**：在会话标题栏显示本次会话的实时花费，点开可以看输入 / 缓存命中 / 缓存写入 / 输出 / 推理的分项、按模型的账单，以及当前用的是高峰还是空闲时段价。旁边还有一枚**账户余额徽标**，显示那个为这些 token 付钱的 DeepSeek 钱包还剩多少。

它是一个真正的插件包（不是一个临时脚本）：Host 半注册一个 `tokenBilling` 会话投影负责算钱，并开一条只读的余额路由；浏览器半只负责显示，自己不碰任何密钥。

```
会话标题栏右侧： ●  ¥0.0132  13.4k   ● 余额 ¥342.18
                 │        │
                 │        └── 点一下（28px 官方头部控件规格）
                 │            ┌──────────────────────────────────────┐
                 │            │ DeepSeek 开放平台账户        [刷新] ×│
                 │            ├──────────────────────────────────────┤
                 │            │ ¥342.18                              │
                 │            │ API Key 对应的账户 · 更新于 14:07:31 │
                 │            │ 账户总余额                  ¥342.18   │
                 │            │ 充值余额                    ¥342.18   │
                 │            │ 赠送余额                        ¥0    │
                 │            │ 每 60 秒自动刷新。余额是账户可用额度，│
                 │            │ 与旁边的本会话花费是两回事。          │
                 │            └──────────────────────────────────────┘
                 └── 点一下
                ┌──────────────────────────────────────┐
                │ 本会话 Token 计费  [高峰计价] [¥CNY] ×│
                ├──────────────────────────────────────┤
                │ ¥0.0132                              │
                │ 13.4k tokens · 3 次调用 · 2 轮        │
                │ 输入 · 未命中缓存              1.0k  │
                │ 输入 · 缓存命中               10.0k  │
                │ 输出                          2.4k  │
                │ 其中推理                        500  │
                ├──────────────────────────────────────┤
                │ 按模型                                │
                │ deepseek-flash      13.4k · 3 次 ¥0.0132
                ├──────────────────────────────────────┤
                │ 官方价目（人民币 / 百万 tokens）      │
                │ deepseek-flash   命中 ¥0.04 · 未命中 ¥2 · 输出 ¥8
                │ deepseek-v4-pro  命中 ¥0.30 · 未命中 ¥9 · 输出 ¥27
                └──────────────────────────────────────┘
```

面板皮肤、分项网格、芯片几何都照搬官方组件（`stat-dialog.module.css` / `ui-primitives` 的 `Tag`），token 与依据见文末「已知限制」。

## 安装

需要：DSH（Web / `web` profile）· Node 22+ · `pnpm` 在 PATH 上（`dsh plugin` 会转发给它）。

```sh
# 1) 从目录安装（推荐先这样试）
dsh plugin --profile web add C:\path\to\dsh-token-billing

# 或者从其他人给你的 tarball 安装
dsh plugin --profile web add ./dsh-token-billing-0.2.0.tgz
```

`dsh plugin add` 会做两件事：把这个包作为依赖装进 profile，并因为它声明了 `dsh.bundle` 而把 `cordis.patch.yml` 里那一行加进组合层。

> **装 tarball 就别删那个 tarball。** profile 记住的是文件的**路径**（例如 `file:C:/…/dsh-token-billing-0.2.0.tgz`），文件一旦不在了，后续任何 `dsh plugin` / `pnpm install` 都会以 `ENOENT` 失败（作者实测踩过一次；恢复方式是先 `dsh plugin --profile <name> remove dsh-token-billing` 去掉失效引用，再重新 `add`）。把它放在稳定目录，或者直接装目录 / 从 npm / 从 git 装，就没有这个约束。

> **从目录（`link:`）安装时，插件目录自己必须有 `node_modules`。** `dsh plugin add <目录>` 装出来的是 `link:` 依赖，而 pnpm **不会**为 `link:` 依赖安装它自己的依赖；运行时又是从被链接目录的真实路径去解析 `zod` 的。所以目录里没有 `node_modules` 时，profile 的 `node_modules` 里不会有 `zod`，插件的 `import { z } from 'zod'` 也解析不到 —— 后果是**整行不激活**：
>
> ```
> dsh: warning: 1 entry did not activate
> token-billing (dsh-token-billing): failed to import
> ```
>
> 徽标会**整枚消失**（不是显示 `--`）。修法就是在插件目录跑一次 `pnpm install`（作者实测踩过一次）。tarball / npm / git 安装没有这个问题，因为那时依赖装在 profile 里。

```sh
# 2) 不启动也可以先看组合层（注意：--dump-config 会重写 profile 里的 cordis.yml，需要该目录可写）
dsh --profile web --dump-config   # 应该能看到 "# == dsh-token-billing" 这一层

# 3) 想确认它能被真正挂载，又不启服务器：--help 会组装并挂载整棵插件树但不绑定端口
dsh --profile web --help          # 有任何包解析不到、或某一行始终不激活，这里会报出来

# 4) 重启该 profile —— 运行中的 profile 不会热更新 bundle 集合
```

重启后打开任意会话，标题栏右侧就会出现那两枚徽标。本会话还没有账单记录时花费显示 `¥--`，发出第一条模型回复后立即变成实际金额（投影是推送式的，不需要刷新页面）；余额徽标在第一次查询返回后显示金额。

**卸载**：`dsh plugin --profile web remove dsh-token-billing`（依赖和组合层一起移除），然后重启。

### 手工安装（不用 bundle 机制）

任何 profile 都能手工加这一行，效果一样：

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- insert:
    - id: token-billing
      name: dsh-token-billing
```

前提是这个包在 profile 的 `node_modules` 里能解析到（例如它已作为依赖装进该 profile，或放在 DSH 的模块回退目录下）。

## 价格怎么算

- **单价来源**：官方价目表原文，不联网抓取。人民币来自[中文页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)，美元来自[英文页](https://api-docs.deepseek.com/quick_start/pricing)。两个币种在面板里一键切换，两套数字都是官方原文（**不是**汇率换算）。
- **峰值判定**：**逐条记录**按它自己的发生时间判定。高峰是北京时间周一至周五 09:00–12:00、14:00–18:00，空闲时段一律乘 0.5（官方页写明空闲价是高峰价的一半）。所以跨过高峰边界的会话，每一笔都按它真实发生的档位计费。
- **四个互不重叠的桶**：未命中缓存的输入、缓存命中的输入、缓存写入、输出。`reasoning` 已经含在 `output` 里（官方 `completion_tokens` 包含推理），只做展示、不重复计费。缓存写入按未命中输入价计（DeepSeek 不单独收缓存写入费）。
- **重试**：与官方 `tokenUsage` 投影同一套采样规则 —— 同一个 turn/step 的再次上报是**替换**而不是累加，`llm/retry-started` 会关闭替换位。这样徽标上的 token 数与 GUI 里既有的用量面板保持一致。
- **未定价模型**：按 Flash 价估算，并在明细里打「估算」标签，不会静默算成 0。
- **旧模型名**：`deepseek-chat`、`deepseek-reasoner`、`deepseek-v4-flash` 等归一映射到现行价格行。

内置默认（高峰价，单位：每百万 tokens）：

| 币种 | 模型 | 缓存命中 | 缓存未命中 | 输出 |
| --- | --- | --- | --- | --- |
| CNY | `deepseek-flash` | ¥0.04 | ¥2 | ¥8 |
| CNY | `deepseek-v4-pro` | ¥0.30 | ¥9 | ¥27 |
| USD | `deepseek-flash` | $0.006 | $0.3 | $1.2 |
| USD | `deepseek-v4-pro` | $0.044 | $1.32 | $3.96 |

> 官方声明价格可能调整。看到变动就按下面任一种方式改，别改 `lib/`。

## 余额怎么来

余额不是算出来的，是**问出来的**，而且只有 Host 半去问。浏览器半只调用本包自己的一条同源只读路由（`GET /token-billing/balance`），拿到的是数字，不是凭据 —— 页面里既没有 API Key，也没有任何指向 DeepSeek 的跨站请求。

Host 半按这个顺序取数：

1. **已登录的 DeepSeek 账号**（`ctx.deepseekAccount.getBalance()`）。这是**设置 → 账户**里显示的那个平台账号，取到的是「充值余额 + 赠送余额」两个钱包；它们本来分列，总额是插件自己加的。
2. **API Key 对应的账户**：用 `ctx.credentials` 解析 `DEEPSEEK_API_KEY`（或配置里指定的名字），再请求 `GET https://api.deepseek.com/user/balance`。这一条不需要授权任何账号，只要有可用的 Key 就行。

两条路都取不到时，徽标显示 `余额 --`，面板里说明原因（没登录也没 Key / 网络不通 / 接口超时 / 接口拒绝 / 返回无法识别），**不会把失败显示成 ¥0**。

其他行为：

- **有缓存。** 成功结果在 Host 端复用 `refreshMs`（默认 60 秒），失败结果复用 `failureMs`（默认 15 秒）。所以多个徽标、多个标签页合起来每次刷新周期最多打一次上游接口；面板上的「刷新」按钮会带 `?refresh=1` 跳过缓存。
- **浏览器只轮询自己家。** 页面每 `refreshMs` 请求一次本地路由，不直连 DeepSeek。
- **Key 每次现解析。** 在设置里轮换 Key 后，下一次查询就会用新值，不需要重启。
- **可以关掉。** `balance.enabled: false` 时 Host 半不查询上游，只回一个「已关闭」的答复，浏览器半据此**整枚隐藏**余额徽标（而不是留一个永远坏掉的徽标）。

## 改价格

### 方式一：组合配置（不改代码，推荐）

价格是**组合配置**，不是硬编码。在自己的 profile patch 里覆盖这一行即可 —— patch 会**整体替换**该行的 `config`，所以要把用到的键写全：

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: token-billing
  config:
    prices:
      CNY:
        deepseek-flash: { hit: 0.04, miss: 2, output: 8 }
        deepseek-v4-pro: { hit: 0.3, miss: 9, output: 27 }
        my-local-model: { hit: 0.1, miss: 1.5, output: 6 }   # 新增一行
      USD:
        deepseek-flash: { hit: 0.006, miss: 0.3, output: 1.2 }
    aliases:
      my-gateway-model: deepseek-flash                       # 把自定义路由映射到已有价目
```

没写的键继续用内置默认值。改完重启 profile，**历史账单会立刻按新价重算**（折叠状态里只有 token，没有任何金额，所以改价不会让缓存失效、也不需要重放日志）。

### 余额也可以在同一行里配

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: token-billing
  config:
    balance:
      enabled: true                                        # false = 不查上游，隐藏余额徽标
      apiKeyEnv: DEEPSEEK_API_KEY                           # 用哪个凭据引用去解析 API Key
      baseUrl: https://api.deepseek.com                     # 自建网关就改成自己的地址
      path: /user/balance
      refreshMs: 60000                                      # 成功结果缓存多久
      failureMs: 15000                                      # 失败结果缓存多久
      timeoutMs: 10000
      route: /token-billing/balance                         # 浏览器读数的同源路由
```

同样地，**patch 会整体替换 `config`**，所以覆盖余额时别把 `prices` / `aliases` 弄丢；只想改价格就只写 `prices` / `aliases` 即可（余额键会回到默认值）。

### 方式二：改内置默认值（要重新构建）

改 `src/host.js` 顶部的 `DEFAULT_PRICES` / `DEFAULT_ALIASES`，然后：

```sh
node build.mjs      # 重新生成 lib/
```

## 分享给别人

```sh
npm pack            # 或 pnpm pack → dsh-token-billing-0.2.0.tgz
```

对方 `dsh plugin --profile <name> add ./dsh-token-billing-0.2.0.tgz` 即可。也可以直接发目录 / 发布到 npm / `dsh plugin add github:you/dsh-token-billing`。

- **tarball 里已经带好构建产物**（`lib/`），所以对方安装时**不需要**构建权限、不需要允许 `prepare` 脚本、不需要联网（`zod` 是唯一依赖，pnpm 会装）。
- 从 git 安装拉的是源码而不是产物。本包带 `prepare: node build.mjs`，它只用 Node 内建模块，在没有网、没有 monorepo 的环境里也能跑；不过 pnpm ≥10 会要求对方显式允许该包的构建脚本（`allowBuilds`），这是「允许在本机执行该包的代码」，让对方自行判断。发 tarball 可以完全避开这一步。

## 这个包长什么样

```
dsh-token-billing/
├── package.json          dsh.bundle（组合层）+ dsh.client（浏览器半）
├── cordis.patch.yml      插入那一行；注释里写了怎么覆盖价格与余额
├── src/host.js           Host 半源码：tokenBilling 会话投影（含价目与折叠）+ 余额路由
├── src/client.js         浏览器半源码：两枚徽标 + 两个面板（CJS bundle 主体）
├── build.mjs             零依赖构建：拼出 lib/index.js 与 lib/client.js
├── lib/                  构建产物（提交/发布的就是它，装的时候直接读它）
│   ├── index.js          ← src/host.js
│   └── client.js         ← src/client.js 包上 window.__ModuleLoader__.load({...})
└── test/projection.test.mjs   34 个用例：折叠、计价、配置覆盖、余额两条取数路径与缓存、bundle 装载与渲染
```

### 为什么这样切分

- **算钱在 Host，显示在 Client。** Host 半用 `ctx.sessionProjections.register()` 注册一个 `tokenBilling` 投影单元（和官方 `sessionStats`、`tokenUsage` 同一套机制）。投影是纯函数折叠 + 框架负责派发，所以：durable 日志就是唯一事实来源、分页和压缩都不会改变数字、结果会按 `session.seq` 缓存、并且**天然推送到浏览器**（`useProjection('tokenBilling')`）。
- **账目零 RPC，余额一条路由。** 花费全程走投影，没有自定义接口；余额是外部状态（随时会变、还会被别处的消费改变），投影那种「日志折叠」模型不适用，所以它走 Host 自己的一条同源只读路由。**密钥永远不出 Host**：浏览器拿到的只有数字，也不存在跨站请求与 CORS 问题。
- **折叠状态里没有金额。** 状态只存 token 与高峰/空闲的拆分，价格通过 `wire.view` 在出线时套用 —— 这就是「改价不用重放日志」的原因。余额同理不进任何折叠状态。
- **浏览器半是手写的 CJS bundle。** `lib/client.js` 复刻了 `packages/client/tsdown.client.ts` 的产物契约（`window.__ModuleLoader__.load({ id, factory: (require) => {...} })`，classic script，`require` 只取基线模块 `react` / `react-dom`）。这样整包零构建依赖：不需要 TypeScript、不需要 tsdown、不需要 monorepo。两个面板都用 `ReactDOM.createPortal` 挂到 `document.body`（官方 stats 面板也是这个做法），所以不会被标题栏裁掉，也不需要跨入口共享 store。

## 开发

```sh
pnpm install             # 或 npm install —— 本包只有一个运行时依赖
node build.mjs           # 改完 src/ 后重新生成 lib/
pnpm test                # = node test/projection.test.mjs
```

- **依赖只有 `zod`，而且它是必需的**：投影注册表的契约本身就是 zod schema（`stateSchema` / `wire.viewSchema`）—— 框架在恢复持久化折叠状态、以及每次把 wire 值发给浏览器之前，都会调用它们的 `.parse()`。装进 profile 时由 `dsh plugin add` 跑 pnpm 自动装上；裸目录里要跑构建或测试，先 `pnpm install`。
- `node_modules/` 与 `pnpm-lock.yaml` 只服务**本地开发**：`files` 白名单里没有它们，不会进 tarball。建议把 `pnpm-lock.yaml` 提交到仓库，安装才可复现。
- 改动 `src/` 之后**一定要重新 `build.mjs`** —— 运行时读的是 `lib/`，不是 `src/`。`build.mjs` 会拒绝把含 `import`/`export` 语句的浏览器主体打进 bundle（那种文件会被模块加载器判为解析失败）。
- 用 `pnpm test` / `node test/projection.test.mjs` 跑；别用 `node --test test/`，它会为每个测试文件 spawn 子进程，在受限沙箱里会因管道 `EPERM` 失败。

## 已知限制

- **文案是中文写死的**，没有接 locale 字典（接了就要引入 `ctx.locale` 与字典注册）。要英文界面直接改 `src/client.js` 里的字符串并重新构建。
- **币种只有 CNY / USD** 两套（官方就这两套）。要加第三个币种：在 `src/host.js` 的 `DEFAULT_PRICES` 和 `CURRENCIES` 里加上，并在 `src/client.js` 的 `symbolOf` 里给出符号。
- **不自动抓官网价格。** 页面结构一变抓取就断，宁可让价格是显式配置。价格变动请按上面的「改价格」处理。
- **只覆盖会话内用量。** 不做跨会话汇总、不做预算拦截（拦截属于 gate，不属于展示）。想加的话，同样可以走一个 Host 投影 + 另一个 entry。
- **余额是「现在剩多少」，不是「本会话花了多少」。** 两者来自不同事实源：花费由会话日志折叠而来，余额是每次现查的外部快照。余额不会随投影推送更新，只按 `refreshMs` 轮询，所以刚发生的大额消费可能要过几十秒才反映在徽标上；想立刻看就点面板里的「刷新」（它会跳过 Host 端缓存）。
- **余额有两条取数路径，取到哪条取决于账户形态。** 登录了 DeepSeek 账号走平台接口（充值 / 赠送两个钱包分列，总额由插件相加）；只有 API Key 就走 `GET /user/balance`（官方直接给出总额与两个分项）。两条都拿不到时显示 `--` 并说明原因，**绝不会把失败显示成 ¥0**。
- **余额徽标要求 Web 表面。** 它读的是 Host 半注册在 `webServer` 上的同源路由；纯终端 / ACP 环境里路由不存在，徽标也不会出现（Host 半用 `ctx.inject(['webServer'], …)` 注册，缺这个服务时插件照常加载，投影仍然工作）。
- **依赖 `conversation.session.header.utilities` 这个 slot**（由 `@deepseek-ai/dsh-client-ui-conversation` 声明）。纯终端 / ACP 等没有 Web 会话头的界面看不到徽标；Host 半的投影仍然照常工作，`tokenBilling` 键对其他消费者（例如自定义视图）也是可读的。
- **`--dump-config` 不是只读的**：它会重写 profile 里的 `cordis.yml`，在受限环境下需要该目录写权限。
- **样式对齐官方头部控件**：徽标按同 slot 官方按钮的规格写（28px 行高、`0.5px solid var(--dsw-alias-border-l4)` 发丝边框、`14px` 胶囊圆角、11px/400 字号、hover 用 `--dsw-alias-interactive-bg-hover` 铺底），规格抄自 `packages/client/ui-open-in-app/src/client/OpenInAppAction.module.css`。注意 `--dsw-alias-border-l4`、`--dsw-alias-interactive-bg-hover`、`--dsw-font-family` **不在**运行时 token 查询/覆盖列表里（那份列表只暴露 13 个 alias，边框类只有 `-l1`/`-l2`），但它们在上游主题表里真实存在、官方组件也在用，因此在页面里能正常解析；只是不能用 `theme.overrideTokens` 覆盖它们。

## License

MIT，见 [LICENSE](./LICENSE)。
