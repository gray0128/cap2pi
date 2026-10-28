# 将 CLIProxyAPI 供应商迁移为 Pi 插件

本文给后续实现定边界。它说明 `@gray0128/dsh-cliproxyapi-provider` 今天如何工作、Pi 宿主要求插件如何注册模型，以及截图中的同类包各自解决了哪一段。第 14 节的决定已经确认，实现按该节执行。

读者是准备在本仓库落地 Pi 包的开发者。先读第 1 节和第 6 节，再按第 12 节的顺序实现。

事实来源限于 2026-10-28 读到的本地文件和包页面。CLIProxyAPI 各协议的具体 base path 未对运行中的实例复测，文中相关路径都标了待实测。

## 1. 结论

在本仓库做成一个可 `pi install` 的扩展包，包名建议 `@gray0128/pi-cliproxyapi-provider`。接入点是用户配置的 base URL 和 API Key，公网、内网和本机都使用同一套配置。目录发现、双端点合并、合成字段识别、推理档位归一、模型过滤和按模型覆盖，从 DSH 插件的 `src/catalog.js` 与 `src/metadata.js` 迁入。这两个文件没有 DSH 依赖。

这是与官方 [@router-for-me/pi-cliproxyapi-provider](https://github.com/router-for-me/pi-cliproxyapi-provider) 的接入面差别。该仓库 README 也收集 baseUrl 和 apiKey，默认值和示例是 `http://127.0.0.1:8317`；它把任意输入改写成 `{root}/backend-api/`，再让 Pi 请求 `{inference}/codex/responses`。远端 OpenAI 兼容部署通常只提供 `https://host/v1` 和一把 key，没有这条路径。本项目把用户写下的前缀原样当作目录和对话的接入点，不改写到 `backend-api`，也不因为地址不在 loopback 而拒绝。

请求仍交给 Pi 自带的 API 实现，扩展不编写 `streamSimple`。第一版按第 7 节为每个模型选择内置协议，不把全部模型写成 `openai-responses`。provider ID 使用 `cliproxyapi`。富目录查询使用 `client_version=pi`。已确认项记录在第 14 节。DSH 只能在 `llm-pi-ai` 的一条 profile 上写一个 `api`，那是宿主限制，不必带到 Pi。

`/cliproxyapi config` 一次写入 base URL 和 API Key，环境变量 `CLIPROXYAPI_BASE_URL` 与 `CLIPROXYAPI_API_KEY` 覆盖文件。模型列表用 `refreshModels` 以替换方式发布：上游删掉的模型从选择器消失，刷新失败时保留上一份列表。

不改 `/Users/libo/Documents/github/dsh-cliproxyapi-provider` 的发布形态。那个包继续服务 DeepSeek Harness `0.2.1-rc.3`。

## 2. 现在的 DSH 插件做什么

`@gray0128/dsh-cliproxyapi-provider@0.0.5` 是 DeepSeek Harness 的 Web 插件，派生自 [router-for-me/dsh-cliproxyapi-provider](https://github.com/router-for-me/dsh-cliproxyapi-provider)。它不自己发对话请求。`cordis.patch.yml` 只插入 `id` 为 `llm-cliproxyapi` 的条目；`src/index.js` 把发现结果写入内置 `llm-pi-ai` 配置的 `providers.CLIProxyAPI`。路由和流式请求由 `@deepseek-ai/dsh-llm-pi-ai` 执行，profile 的 `api` 固定为 `openai-responses`。

一次发现做四件事：

1. 并行请求 `{baseURL}/models?client_version=dsh-cliproxyapi-provider` 和 `{baseURL}/models`。Codex 形态是 `{ models: [...] }`，标准形态是 `{ data: [...] }`。按去空白后的 `slug ?? id ?? model` 合并，主目录里已有的非空字段优先。任一侧失败、超时或过滤后为空时，使用另一侧。
2. 把条目收成 `id`、`name`、`contextWindow`、`maxTokens`、`input`、`reasoningEfforts`。`visibility === 'hide'` 的条目跳过。未显式覆盖 `maxTokens` 时，结果不超过 `contextWindow`。
3. 识别合成目录后再校准。触发条件包括固定的 Codex 推理模板、空的 `supported_reasoning_levels`、以及等于窗口或窗口 90% 的 `maxTokens`。数据源顺序默认是内置 `@earendil-works/pi-ai` 模型库、OpenRouter Models API、LiteLLM 参数库。远程源有超时、内存 TTL 和失败时继续使用旧缓存。校准失败不阻断发现。
4. 用 schemastery 校验生成的 profile，再以 JSON Patch 写回 `llm-pi-ai`。API Key 存在凭据 `DSH_CLIPROXY_API_KEY`，不进配置文件。没有密钥时写入 `Authorization: Bearer dsh-cliproxyapi-no-key`，让宿主仍把该 profile 当成可发送。

刷新由插件自己的定时器驱动，默认 5 分钟。失败从 3 秒指数退避到 60 秒，同一条错误只记一次。`client.js` 是 Harness Web 的设置页：填写 Base URL 和 API Key，调用宿主的 `discoverModels`，再写入初始 profile。

配置项和默认值：

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `defaultContextWindow` | `262144` | 目录没有窗口时使用 |
| `defaultMaxTokens` | `32768` | 目录没有输出上限时使用 |
| `defaultInput` | `["text"]` | 目录没有输入模态时使用 |
| `excludedModels` | `[]` | 按模型 ID 隐藏，`*` 为通配 |
| `modelOverrides` | `{}` | 覆盖 `name`、`contextWindow`、`maxTokens`、`input`、`reasoningEfforts` |
| `metadataSources` | `["pi-ai", "openrouter", "litellm"]` | 校准源及顺序；`[]` 关闭校准 |
| `openRouterModelsURL` | OpenRouter `/api/v1/models` | 可替换 |
| `liteLlmModelsURL` | LiteLLM `model_prices_and_context_window.json` | 可替换 |
| `metadataTimeoutMs` | `8000` | 单个远程元数据请求超时 |
| `metadataCacheTtlMs` | `3600000` | 内存缓存；`0` 表示每次重拉 |
| `headers` | `{}` | 目录请求和模型请求的附加头 |
| `fetchTimeoutMs` | `15000` | 单次目录请求超时 |
| `retryInitialMs` | `3000` | 首次重试延迟 |
| `retryMaxMs` | `60000` | 重试延迟上限 |
| `refreshIntervalMs` | `300000` | 定期刷新；`0` 关闭 |

推理档位先收录标准名 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，再补别名。`none` 映到 `off`，线上值仍是 `none`；`ultra` 只在 `max` 还没被标准名占用时映到 `max`。空表或只含 `off` 的表表示非推理模型，不写出 `reasoningEfforts`。

## 3. Pi 宿主要求什么

本地对照实现是 `pi-workbuddy-connect` 所依赖的 `@earendil-works/pi-coding-agent@1.3.0` 和 `@earendil-works/pi-ai@1.3.0`。公开说明见 [Custom Providers](https://pi.dev/docs/latest/custom-provider) 与 [Extensions](https://pi.dev/docs/latest/extensions)。下面只记实现要遵守的契约。

包是一个 npm 包。`package.json` 含 `keywords` 里的 `pi-package`，以及：

```json
{
  "type": "module",
  "pi": {
    "extensions": ["./src/index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*"
  },
  "engines": { "node": ">=22.19.0" }
}
```

Pi 用 jiti 加载 TypeScript，发布包不必先编译。安装命令是 `pi install npm:<name>`、`pi install git:<repo>` 或 `pi install <目录>`。开发时用 `pi -e <目录>`。

扩展默认导出工厂函数，参数类型是 `ExtensionAPI`。工厂可以是 async，Pi 会等它结束再继续启动，因此这里注册的供应商对 `pi --list-models` 可见。工厂里不做长生命周期的事：不启定时器、不连 WebSocket、不拉常驻子进程。部分启动路径只加载扩展、不进入会话。

注册有两种形式：

- `pi.registerProvider(provider)` 接收 `@earendil-works/pi-ai` 的完整 `Provider`。动态列表由 `refreshModels` 通过 `context.publish({ update, persist })` 安装。`getModels()` 同步返回最近一次结果。
- `pi.registerProvider(name, config)` 接收遗留的 `ProviderConfig`。`refreshModels` 返回 `ProviderModelConfig[]`，Pi 用这份列表替换该注册当前的模型。

`ProviderModelConfig` 可以在模型上单独写 `api`、`baseUrl`、`reasoning`、`thinkingLevelMap`、`compat`、`contextWindow`、`maxTokens`、`input` 和 `cost`。`thinkingLevelMap` 里某个档位为 `null` 时，选择器隐藏该档位。`cost` 必填，单位是每百万 token 的价格。

`refreshModels` 的上下文里有已解析凭据、上次持久化的目录、`allowNetwork`、`force` 和 `signal`。阻塞 I/O 使用这个 `signal`。`allowNetwork === false` 时只恢复已保存的目录。

原生 `Provider.fetchModels` 会把新目录并进静态基线，上游下架的模型会留在选择器里。`pi-workbuddy-connect` 因此先注册原生 provider，再用第二条 `ProviderConfig.refreshModels` 做整表替换。本插件要的是替换语义，采用同一做法。

`models.json` 仍属于用户。扩展不读写它。Pi 文档写明 `models.json` 叠在已注册 provider 之上；2026-04 的 issue #2956 曾报告 `registerProvider()` 清掉同名自定义模型。实现时用 1.3.0 实测当前叠加结果，不把该 issue 当成今天的行为。

## 4. 参照的 Pi 包

截图里的包都是 CLIProxyAPI 的 Pi 扩展。下表只记录 2026-10-28 从 [pi.dev/packages](https://pi.dev/packages) 读到的版本和页面陈述。`@samrito/pi-cliproxyapi-provider` 的简介与 `pi-cliproxyapi-provider` 相同，未另读 README，不把它当成独立设计。

| 包 | 页面版本 | 页面所述行为 | 本方案采纳的部分 |
| --- | --- | --- | --- |
| `pi-cliproxyapi-provider`（0xrichardh，0.15.58，2026-10-09） | 约 5.5 MB，扩展入口 `./extensions` | 一个 provider。`/v1/models` 发现可用性，models.dev 补价格和限额。默认 `openai-completions`；GPT-5.6 / GPT-6 走 `openai-responses`；Claude 走 `anthropic-messages`。`/cliproxyapi config` 写 `~/.pi/agent/pi-cliproxyapi-provider/config.json`。启动用本地快照，目录后台刷新，models.dev 手动刷新。项目配置只接受别名、回退 provider 和有界覆盖。 | 单 provider、按模型选择内置 `api`、配置与密钥分开、启动先用上一份快照、覆盖只允许有界字段 |
| `@hank-warren/pi-cliproxyapi-provider`（0.5.0，2026-10-13） | 160.7 KB，入口 `./index.ts` | 上述包在 `0.15.23` 的 fork。去掉约 4.7 MB 的 models.dev 种子，首跑元数据改读当前 Pi 内置目录。Claude 在 `anthropic` owner 下保留每轮 effort 和对话中途的 system / tool 更新。空的 CPA effort 列表，以及 `low/medium/high/xhigh` 这组 gpt-5.5 模板，不当成真实档位。 | 不捆绑大种子；档位优先信 CPA 的可用列表；识别并忽略合成模板。这两点与现有 `metadata.js` 的方向一致 |
| `@izhimu/pi-cliproxyapi-provider`（1.4.24-1，2026-10-28） | 167.5 KB，入口 `./extensions/index.ts` 与 `./extensions/tps.ts` | 把登录做成仅 OAuth，以便一次收集 base URL 和 API Key。目录地址是 `{root}/v1/models?client_version=pi`，推理地址收成 `{root}/backend-api/`，再由 Pi 请求 `{inference}/codex/responses`。另有 Fast、`/pause`、TUI 耗时和 TPS，以及压缩后关闭 Codex WebSocket。密钥会写入 `~/.pi/agent/cliproxyapi.json`。这些 URL 改写与 [router-for-me/pi-cliproxyapi-provider](https://github.com/router-for-me/pi-cliproxyapi-provider) 的 README 一致。 | 只采纳「没有缓存时同步拉目录、有缓存时先注册再后台刷新」和 `client_version=pi`。不采纳 `backend-api`、Fast、暂停和 WebSocket |
| `@islee23520/pi-cliproxy-api-provider`（1.5.1，2026-08-28） | 65.8 KB，入口 `./index.ts` | 同一仓库同时是 Pi 扩展和 Grok 插件。Pi 侧只读 `CLIPROXY_API_KEY` 与 `CLIPROXY_BASE_URL`，默认拒绝非本机地址，目录请求不跟随重定向。窗口和推理来自共享的 `model-catalog.json`，模型 ID 仍来自 `/v1/models`。Grok 侧改写 `config.toml` 里带标记的区块。 | 只采纳目录请求不跟随重定向，以及密钥不进入 Git 仓库。不采纳「非本机地址默认拒绝」。不实现 Grok 的 TOML 写入 |

另外两份本地实现只提供结构，不提供 CLIProxyAPI 协议：

- `pi-workbuddy-connect` 展示原生 provider 加替换型 overlay，以及 `/workbuddy refresh` 调用 `ctx.modelRegistry.refresh({ providers })`。请求仍进 `openAICompletionsApi()`，扩展只补凭据、请求头和网关拒绝的字段。
- `memctl` 的 `plugins/pi` 展示最小包清单：`pi.extensions`、`keywords`、peer 依赖、`pi install` / `pi remove`。它不注册模型。

## 5. 不照搬的做法

下列做法在参照包里存在，但不进入本插件。

- 不把用户填写的地址改写成 `{root}/backend-api/`，也不把对话固定发到 `/codex/responses`。官方包用这层改写对接本机 CLIProxyAPI 的 Codex 面。本项目保留用户写下的 OpenAI 兼容前缀，远端和本机走同一条配置。
- 不把 base URL 和 API Key 伪装成 Pi 的 OAuth 账号登录。官方包这样做，是因为内置 `/login` 的 API Key 路径只有一个字段。本项目用 `/cliproxyapi config` 一次保存这两项。
- 不默认拒绝 loopback 以外的 URL，也不设置 `CLIPROXYAPI_ALLOW_REMOTE` 这类开关。用户写下的 `http:` 或 `https:` 地址就是接入点。
- 不在仓库里放数 MB 的 models.dev 快照。运行中的 Pi 已经带有内置模型库，`metadata.js` 的 `buildPiAiMetadataIndex` 就是读这份库。
- 不在第一版做 Fast、请求暂停、页脚 TPS、压缩后关 WebSocket、Grok `config.toml` 标记块。这些不改变「发现模型并交给内置 API」这条主路径。
- 不移植 `client.js`、`cordis.patch.yml` 和 DSH 凭据名 `DSH_CLIPROXY_API_KEY`。
- 不移植无密钥时的占位头 `Bearer dsh-cliproxyapi-no-key`。DSH 用它满足 profile 必须有鉴权头的检查。Pi 允许无密钥的本机服务在 `apiKey.resolve()` 里报告为已配置。占位 Bearer 会被校验密钥的代理拒绝。

## 6. 目标行为

扩展注册一个 provider，默认 ID 是 `cliproxyapi`，显示名是 `CLIProxyAPI`。ID 可用配置或 `CLIPROXYAPI_PROVIDER_ID` 改掉。同一 Pi 进程里只能有一个扩展注册这个 ID；与 `pi-cliproxyapi-provider`、`@hank-warren/pi-cliproxyapi-provider`、`@izhimu/pi-cliproxyapi-provider` 同时安装时，后加载的注册会冲突或互相覆盖。

```mermaid
flowchart LR
  A["工厂：读配置，注册 provider"] --> B["getModels 返回上一份快照"]
  B --> C["refreshModels"]
  C --> D["Codex 富目录 与 /models"]
  D --> E["按模型 ID 合并"]
  E --> F["识别合成字段并校准"]
  F --> G["过滤、覆盖、选择 api"]
  G --> H["publish 替换当前列表"]
```

发现步骤与 DSH 相同，输出改成 Pi 的模型配置：

1. 规范化 base URL。用户填写的值是 OpenAI 兼容前缀，去掉末尾斜杠，只接受 `http:` 和 `https:`。未配置时使用 `http://127.0.0.1:8317/v1`。已配置的公网、内网和本机地址都原样保留，不改写成 loopback，也不改写成 `/backend-api/`。
2. 并行拉取富目录和标准目录。富目录查询串使用 `client_version=pi`。若对实际 CLIProxyAPI 实例实测后，只有 `client_version=dsh-cliproxyapi-provider` 返回带 `supported_reasoning_levels` 的目录，再改查询值，合并逻辑不变。响应体上限 4 MiB，两侧各自计超时。合并规则沿用 `mergeCatalogPayloads`。
3. 用现有规则生成窗口、输出上限、输入模态和推理档位，再应用 `excludedModels` 与 `modelOverrides`。
4. 仅当条目看起来是合成值时才查校准源。源的优先级在第 8 节。
5. 为每个模型选择 `api` 和该协议的 base URL，填上完整的 `thinkingLevelMap` 和 `cost`。
6. `context.publish` 替换内存列表。网络刷新成功后把模型元数据写入快照；快照不含 API Key。

`refreshModels` 抛错时不调用 `publish`，选择器继续显示上一份列表。没有任何历史且首次刷新失败时，provider 仍在，模型列表为空，`/cliproxyapi status` 写出失败原因。

## 7. 协议分流

第一版实现本节。一个 provider 内部按模型选择 Pi 已有的 `api`。扩展不实现流。不把全部模型固定为 `openai-responses`。

| 模型 | `api` | 原因 |
| --- | --- | --- |
| Claude，且目录 owner 是 `anthropic` | `anthropic-messages` | 签名 thinking 和每轮 effort 只在 Messages 形态里保留。依据是 hank-warren 对 CLIProxyAPI 8.0.3 及以后的说明 |
| Codex 路线上的 GPT-5.5、GPT-5.6、GPT-6，以及当前 Pi 的 `openai-codex` 目录中出现的 ID | `openai-responses` | Responses 回传 Pi 能读取的 usage。依据是 0xrichardh 与 hank-warren 的包说明 |
| 其余聊天模型 | `openai-completions` | 混合目录的默认协议，与上述两个包一致 |

分类只看模型 ID 和目录里的 owner / 渠道前缀，不发探测对话。对不上的模型留在 `openai-completions`。`modelOverrides` 不能改 `api`：协议选错会让内置适配器组出代理拒绝的请求体，这个字段保持由扩展拥有。

各 `api` 的路径都相对用户填写的前缀推导，远端和本机使用同一函数。具体后缀待对实际 CLIProxyAPI 实例实测后再写死。在实测完成前，路径只出现在这一个函数里。

已知需要核对的兼容位，来自参照包已经踩过的差异，不在未复现时打开：

- Responses 函数工具是否要带 `strict: null`。0xrichardh 0.15.58 的说明写了 CPA Responses 需要它，否则可选工具参数会丢。
- Claude 的 `off` 是否等于 `thinking.type = disabled`。hank-warren 写明只有部分 Claude 接受；Fable 5.x 与 Opus 5 会拒绝。
- `supportsDeveloperRole`。WorkBuddy 网关会拒绝 `developer` 角色；CLIProxyAPI 是否拒绝，以实测为准。

这些差异若被实测确认，优先用模型上的 `compat` 或请求前事件修正。只有内置适配器无法表达时才包一层 `stream`，并且仍然调用对应的内置 API。

## 8. 元数据校准

保留 `metadata.js` 的触发条件：CPA 给出的窗口、输出上限或推理档位是模板值时才替换对应字段。CPA 已经给出的非空真实字段保持优先。匹配键继续用 `candidateKeysForModelId`，不用展示名。

建议的数据源顺序：

1. `pi-ai`：读取当前进程里 `@earendil-works/pi-ai` 的内置目录，沿用 `buildPiAiMetadataIndex`。Pi 升级后新模型随之可见，不用发版带一份拷贝。
2. `models.dev`：补价格、输入阶梯和内置目录没有的限额。缓存 24 小时，超时后继续用上一份。不把种子 JSON 提交进仓库。
3. `litellm`：保留现有 URL 与解析，作为前两源都没有命中时的来源。

`metadataSources` 仍可配置，默认 `["pi-ai", "models.dev", "litellm"]`。设为 `[]` 时只使用 CPA 目录和插件默认值。OpenRouter 从默认顺序中拿掉，因为它和 models.dev 重叠；配置里仍可写回 `openrouter`，解析器保留。

`reasoningEfforts` 转成 Pi 的 `thinkingLevelMap` 时覆盖全部标准档位。CPA 列出的档位映到线上值，没列出的档位写 `null`。`off` 的线上值沿用现有映射 `none`，但是否对当前 `api` 发送，由第 7 节的实测决定。空表或只有 `off` 时设 `reasoning: false`，不附 `thinkingLevelMap`。

`cost` 在校准源有价格时写入；没有价格时写 `{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`。发现不因缺少价格失败。价格是目录标价，不是 CLIProxyAPI 的实际计费。

## 9. 配置、密钥和刷新

用户级配置放在 `~/.pi/agent/pi-cliproxyapi-provider/config.json`，模式 `0600`。这里保存 `baseUrl`、`apiKey` 和 `headers`。项目级 `.pi/pi-cliproxyapi-provider/config.json` 只覆盖 `excludedModels`、`modelOverrides`、`metadataSources` 和元数据 URL，禁止写入 `baseUrl`、`apiKey` 和 `headers`，避免仓库带上远端地址或密钥。

环境变量覆盖用户级文件：`CLIPROXYAPI_BASE_URL`、`CLIPROXYAPI_API_KEY`、`CLIPROXYAPI_PROVIDER_ID`、`CLIPROXYAPI_AUTH_REQUIRED`。没有 `CLIPROXYAPI_ALLOW_REMOTE`。

`/cliproxyapi config` 依次询问 base URL 和 API Key，并写入用户级文件。API Key 留空表示该端点不使用 Bearer。`authRequired` 默认 false；设为 true 且最终没有密钥时，provider 对 Pi 显示为未配置，选择器不列出模型。密钥的生效顺序是环境变量，然后是用户级文件里的 `apiKey`。

目录和对话请求使用解析后的那一个 base URL 和那一把 key。请求 `redirect: "error"`，避免 Bearer 跟着跳转离开用户配置的主机。快照文件只存模型元数据和拉取时间。

刷新不移植 DSH 的常驻定时器。Pi 在启动和 `/model` 刷新时调用 `refreshModels`。另外提供：

| 命令 | 作用 |
| --- | --- |
| `/cliproxyapi status` | 生效的 base URL 主机、是否已配置密钥、目录来源、模型数、最近一次错误 |
| `/cliproxyapi refresh` | 调用 `modelRegistry.refresh`，强制重拉目录和过期元数据 |
| `/cliproxyapi models` | 列出生效的 `api`、窗口、输出上限和推理档位 |

`/cliproxyapi models` 的编辑能力和 DSH 的 `modelOverrides` 对齐，但只接受 `name`、`contextWindow`、`maxTokens`、`input`、`reasoning`。推理覆盖使用 `false` 或档位表，非法档位在保存时拒绝。第一版可以只读列表，编辑留到命令的第二步；字段范围现在定死，避免以后开放 `api` 覆盖。

DSH 的 5 分钟周期不是 Pi 的宿主能力。若后续要自动刷新，挂在 `session_start`，在 `session_shutdown` 取消，并且默认关闭。工厂函数里不创建这个定时器。

## 10. 不变量

下列条目是实现完成后必须成立的检查。违反时目录合并、请求或密钥会出错。

1. 合并两条目录时，主键必须是去首尾空白后的模型 ID，即 `slug ?? id ?? model`。按展示名合并会造成同名渠道串数据。
2. 未设置 `modelOverrides[id].maxTokens` 时，写出的 `maxTokens` 必须小于或等于 `contextWindow`。
3. 单次目录响应超过 4 MiB 时必须中止读取并失败。失败后保留上一份已发布列表。
4. `refreshModels` 失败时禁止用空数组调用 `publish`。上游不再返回的模型，只在一次成功刷新的结果里消失。
5. 模型快照、Git 仓库和项目级配置禁止包含 API Key 与 base URL。密钥只出现在环境变量或模式为 `0600` 的用户级配置文件。
6. 用户配置的 `http:` 或 `https:` base URL 必须原样作为目录和对话的接入点。禁止改写成 `127.0.0.1`，禁止改写成 `/backend-api/`，禁止因为主机不是 loopback 而拒绝。
7. 扩展禁止读写 `~/.pi/agent/models.json`。
8. 工厂函数禁止启动定时器、WebSocket 和子进程。
9. `modelOverrides` 禁止改变模型的 `api`。

## 11. 仓库布局

代码放在本仓库，不在 DSH 插件仓库里替换 `package.json` 的 `dsh` 字段。那样会破坏 `npx @deepseek-ai/dsh plugin add`。

```text
package.json
tsconfig.json
README.md
src/index.ts        工厂、注册、命令
src/config.ts       用户级 base URL 与 API Key、环境变量覆盖
src/catalog.ts      由 src/catalog.js 迁入
src/metadata.ts     由 src/metadata.js 迁入，补 models.dev
src/models.ts       收成 ProviderModelConfig，选择 api
src/endpoints.ts    base URL 与各 api 的路径
test/catalog.test.ts
test/metadata.test.ts
test/models.test.ts
docs/pi-plugin-migration.md
```

测试沿用 DSH 仓库里 `test/catalog.test.js` 与 `test/metadata.test.js` 的断言，改成 `node --test` 直接运行 TypeScript，与 `pi-workbuddy-connect` 相同。不增加运行时依赖。类型检查使用 1.3.0 的 peer 类型。

`catalog.ts` 和 `metadata.ts` 不 import Pi 的扩展 API，便于单测不启动 Pi。`index.ts` 只做组装。

## 12. 实施顺序

每一步都可以单独验证。前一步的检查没过时不进入下一步。

1. 包清单和空工厂。`pi -e .` 能加载，`pi list` 能看到扩展，不注册模型。
2. 迁入 `catalog.ts`，跑通双端点合并、隐藏、过滤、覆盖和推理别名的现有测试。
3. 迁入 `metadata.ts`，跑通合成字段识别和键匹配的现有测试。此步仍不访问网络。
4. `models.ts` 把一条目录收成 `ProviderModelConfig`，包括 `thinkingLevelMap` 和按第 7 节选择的 `api`。用固定夹具断言，不连代理。
5. `config.ts` 接受任意 `http:` / `https:` base URL，包括非 loopback。环境变量覆盖用户级文件。项目配置里的 `baseUrl` 和 `apiKey` 被忽略。
6. `index.ts` 注册 provider 和三条命令。用假 `/models` 服务器分别放在 loopback 和非 loopback 主机名上，确认请求打到配置的主机，成功发布，失败保留旧列表，下架模型消失，快照不含密钥。
7. 对运行中的 CLIProxyAPI 各做一轮 Claude、Codex GPT、普通聊天模型的带工具对话，把第 7 节的路径和兼容位记进 `endpoints.ts` 的注释和测试。

## 13. 验收

- `pi install <本仓库绝对路径>` 之后重启，`/model` 中出现 `cliproxyapi/<模型 id>`。
- 未配置时的默认 base URL `http://127.0.0.1:8317/v1` 在代理未启动时不阻止 Pi 启动；status 能看到最近一次错误。
- 把 base URL 配成 `https://proxy.example.com/v1` 并写入 API Key 后，目录请求和对话请求都发往该主机，路径中不出现 `backend-api`，也不回落到 `127.0.0.1`。重启后这两项仍然生效。`CLIPROXYAPI_BASE_URL` 与 `CLIPROXYAPI_API_KEY` 能覆盖文件中的值。
- 代理返回富目录和标准目录时，同一 ID 的输出上限来自有该字段的一侧，推理档位里 `max` 优先于 `ultra`。
- `excludedModels` 含 `*-preview` 时，对应模型不在选择器中，刷新后仍然不在。
- 无密钥且 `authRequired` 为 false 时，请求不带 `Authorization`。
- 有密钥时，目录请求和对话请求都带这一个 Bearer，且 `redirect` 失败不会把密钥发到另一主机。
- 拔掉代理后再执行 `/cliproxyapi refresh`，选择器仍是上一份模型，status 有新的错误。
- 代理去掉一个模型后再刷新，该模型从选择器消失。
- `npm test` 覆盖目录合并、合成校准、协议选择和配置优先级，不依赖外网。

## 14. 已确认决定

2026-10-28 确认，按原建议执行。实现和 README 以此为准。

1. 协议分流进入第一版。按第 7 节为每个模型选择 `anthropic-messages`、`openai-responses` 或 `openai-completions`。不把全部模型写成 `openai-responses`。
2. provider ID 使用 `cliproxyapi`，显示名使用 `CLIProxyAPI`。README 写明不得与 `pi-cliproxyapi-provider`、`@hank-warren/pi-cliproxyapi-provider`、`@izhimu/pi-cliproxyapi-provider` 同时启用。不另起 `cpa-dsh` 之类的 ID。
3. 富目录查询使用 `client_version=pi`。若对实际 CLIProxyAPI 实例实测后，只有 `client_version=dsh-cliproxyapi-provider` 返回带 `supported_reasoning_levels` 的目录，再把查询值改回后者。合并逻辑不变。
4. 远端 CLIProxyAPI 是一等接入目标。用户配置的 base URL 和 API Key 对公网、内网和本机同样生效。不默认拒绝非 loopback 地址，不把地址改写成 `{root}/backend-api/`。确认日期 2026-10-28。

## 15. 来源

- DSH 插件：`/Users/libo/Documents/github/dsh-cliproxyapi-provider` 的 `package.json`、`README.md`、`src/index.js`、`src/catalog.js`、`src/metadata.js`、`client.js`、`docs/model-parameter-adaptation-plan.md`。
- Pi 类型：`pi-workbuddy-connect/node_modules/@earendil-works/pi-coding-agent@1.3.0` 的 `dist/core/extensions/types.d.ts`、`dist/core/pi-manifest.d.ts`，以及 `@earendil-works/pi-ai@1.3.0` 的 `dist/models.d.ts`。
- 本地注册写法：`pi-workbuddy-connect/src/index.ts`、`src/models.ts`。
- 包页面：`pi-cliproxyapi-provider@0.15.58`、`@hank-warren/pi-cliproxyapi-provider@0.5.0`、`@izhimu/pi-cliproxyapi-provider@1.4.24-1`、`@islee23520/pi-cliproxy-api-provider@1.5.1`，读取日期 2026-10-28。
- 官方 Pi 包的地址改写： [router-for-me/pi-cliproxyapi-provider 的 README](https://github.com/router-for-me/pi-cliproxyapi-provider/blob/main/README.md)，读取日期 2026-10-28。其中 baseUrl 默认 `http://127.0.0.1:8317`，推理地址收成 `{root}/backend-api/`，Pi 再请求 `{inference}/codex/responses`。
