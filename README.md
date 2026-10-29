# CLIProxyAPI Pi 供应商

本包把本机或远端的 CLIProxyAPI 注册为 Pi 供应商。供应商 ID 是 `cliproxyapi`，显示名是 CLIProxyAPI。目录查询和对话请求都发往同一把 API Key 所在的 HTTP 或 HTTPS 前缀。

安装后在 Pi 里执行 `/cliproxyapi config`，依次填写 base URL 和 API Key。未填写时，默认前缀是 `http://127.0.0.1:8317/v1`，只作为本机便利值，不是接入条件。

本包与 [@router-for-me/pi-cliproxyapi-provider](https://github.com/router-for-me/pi-cliproxyapi-provider) 的差别在接入点。官方包同样收集 base URL 和 API Key，默认值和示例是 `http://127.0.0.1:8317`，随后把推理地址改写成 `{root}/backend-api/`，再由 Pi 请求 `{inference}/codex/responses`。本包不插入 `/backend-api/`，不要求地址位于 loopback，也不读取 `CLIPROXYAPI_ALLOW_REMOTE`。用户写下的前缀原样保留，包括路径中已经带有 `/backend-api` 的情况。

实现边界见 [迁移方案](docs/pi-plugin-migration.md)。Node.js 版本要求 `>=22.19.0`。

## 安装

从 npm 安装到用户设置：

```sh
pi install npm:@gray0128/pi-cliproxyapi-provider
```

仅安装到当前项目（写入 `.pi/settings.json`）：

```sh
pi install npm:@gray0128/pi-cliproxyapi-provider -l
```

从本地源码目录安装：

```sh
pi install /absolute/path/to/cap2pi
```

本地开发临时加载（仅对当次进程生效）：

```sh
pi -e .
```

`pi list` 只列出已经写入设置的扩展。`-e` 只对当次进程生效。

不得与下列扩展同时启用。它们使用同一个供应商 ID，后加载的注册会覆盖先加载的注册：

- `pi-cliproxyapi-provider`
- `@hank-warren/pi-cliproxyapi-provider`
- `@izhimu/pi-cliproxyapi-provider`

## 配置

`/cliproxyapi config` 需要在 Pi 界面中运行。先询问 base URL，再询问 API Key。API Key 留空表示不发送 Bearer。取消输入不会写文件。base URL 为空或不是 HTTP、HTTPS 地址时不写文件。

用户级文件路径是 `{agentDir}/pi-cliproxyapi-provider/config.json`。`agentDir` 来自 `PI_CODING_AGENT_DIR`，否则是 `~/.pi/agent`。目录模式 `0700`，文件模式 `0600`。该文件可以保存 base URL、API Key 和附加请求头。

环境变量覆盖用户级文件：

| 变量 | 作用 |
| --- | --- |
| `CLIPROXYAPI_BASE_URL` | 覆盖 base URL。非法值不会退回 `127.0.0.1` |
| `CLIPROXYAPI_API_KEY` | 覆盖 API Key。变量存在但为空时表示不发送 Bearer |
| `CLIPROXYAPI_AUTH_REQUIRED` | `1`、`true`、`yes` 为需要密钥；`0`、`false`、`no` 为不需要 |
| `CLIPROXYAPI_PROVIDER_ID` | 覆盖供应商 ID。非法值退回 `cliproxyapi` |

供应商 ID 在扩展加载时读取一次。修改 `CLIPROXYAPI_PROVIDER_ID` 或用户文件中的 `providerId` 后需要重启 Pi。base URL 和 API Key 在每次刷新和每次对话前重新读取。

`authRequired` 为 true 且最终没有 API Key 时，Pi 将该供应商视为未配置，不拉取目录，选择器不列出模型。

项目级文件是 `{cwd}/.pi/pi-cliproxyapi-provider/config.json`。它只能替换 `excludedModels`、`modelOverrides`、`metadataSources`、`openRouterModelsURL`、`liteLlmModelsURL` 和 `modelsDevURL`。项目文件中的 `baseUrl`、`apiKey` 和 `headers` 会被忽略。扩展不会把 API Key 或 base URL 写入项目级文件、Git 仓库或模型快照。

用户级 JSON 无法解析时，扩展不使用默认本机地址。项目级 JSON 无法解析时，保留用户级配置，并在状态里显示错误。

## 目录与协议

每次允许联网的刷新都会重新请求目录。两条请求并行发出：

- `{前缀}/models?client_version=pi`
- `{前缀}/models`

按去掉首尾空白后的模型 ID 合并，来源字段是 `slug`、`id` 或 `model`。已有的非空字段优先。`visibility` 为 `hide` 的条目不进入列表。`excludedModels` 支持 `*` 通配。单次响应超过 4 MiB 时中止并失败，已发布的列表保留。请求使用 `redirect: error`，Bearer 不会跟随跳转到另一台主机。一侧失败时使用另一侧；两侧都失败时不发布空列表。

模型按目录中的 ID 和所有者选择 Pi 内置协议。`modelOverrides` 不能改变协议。

| 条件 | 协议 |
| --- | --- |
| ID 含 Claude，且所有者或 ID 前缀是 `anthropic` | `anthropic-messages` |
| ID 在 Pi 内置 `openai-codex` 目录中，或匹配 `gpt-5.5`、`gpt-5.6`、`gpt-6` | `openai-responses` |
| 其余模型 | `openai-completions` |

ID 既没有 `anthropic` 所有者，也没有 `anthropic/` 前缀时，Claude 模型使用 `openai-completions`。`gpt-5.4`、`gpt-5.50`、`gpt-6.1` 不走上面的代号规则，除非该 ID 已在 `openai-codex` 目录中。分类不使用展示名，也不探测上游。

类型检查对照 `@earendil-works/pi-ai@1.3.0`。本机 Pi 1.4.0 同样把模型上的 base URL 交给对应 SDK。`openai-completions` 继续请求 `{前缀}/chat/completions`，`openai-responses` 继续请求 `{前缀}/responses`。`anthropic-messages` 会去掉前缀末尾的一个 `/v1`，再由 SDK 追加 `/v1/messages`。这些后缀是宿主 SDK 的拼接规则，尚未对运行中的 CLIProxyAPI 复测。复测之前不要把请求改到 `/backend-api/` 或 `/codex/responses`。Responses 的 `strict`、Claude 关闭思考的映射，以及 `supportsDeveloperRole`，都保持关闭。

没有 API Key 且 `authRequired` 为 false 时，目录请求和对话请求都不带 `Authorization`。配置了 API Key 时，两类请求都带这一把 Bearer。

元数据校准的默认来源是 `pi-ai`、`models.dev` 和 `litellm`。`models.dev` 的内存缓存默认 24 小时。`metadataCacheTtlMs` 为 `0` 时，`models.dev` 也不再使用缓存。`/cliproxyapi refresh` 会重拉目录；未过期的元数据缓存仍可继续使用。

成功的联网刷新会写入 `{agentDir}/pi-cliproxyapi-provider/snapshot.json`，模式 `0600`。快照保存拉取时间、模型 ID、协议、窗口、输出上限、输入模态、推理档位和价格，不保存 base URL、API Key 或请求头。离线恢复时按当前配置重新计算每个协议的 base URL。刷新失败不覆盖快照，选择器保留上一份列表。首次启动且没有快照时，列表为空，不因此阻止 Pi 启动。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/cliproxyapi status` | 显示端点、密钥是否已配置、目录来源、模型数量和最近一次错误 |
| `/cliproxyapi refresh` | 强制重拉目录。失败时保留上一份模型 |
| `/cliproxyapi models` | 只读列出模型 ID、协议、窗口、输出上限和推理档位 |
| `/cliproxyapi config` | 写入 base URL 和 API Key，然后刷新 |

`/cliproxyapi models` 不提供编辑。模型覆盖写在配置文件的 `modelOverrides` 中，可改名称、窗口、输出上限、输入模态和推理档位，不能改协议。

## 检查

```sh
npm run check
```

`npm run check` 依次运行 `npm run typecheck` 和 `npm test`。测试不访问外网。类型检查使用 `@earendil-works/pi-ai@1.3.0` 和 `@earendil-works/pi-coding-agent@1.3.0`。发布工作流使用同一条命令。

## 发布

发布由 GitHub Actions 工作流 `.github/workflows/release.yml` 完成。触发条件是推送 `v` 开头的标签。标签去掉前缀 `v` 之后必须等于 `package.json` 的 `version`。两者不一致时，工作流失败，不发布到 npm，也不创建 GitHub Release。

工作流在公开仓库的 GitHub 托管 runner 上安装依赖，并运行 `npm run check`。检查通过后，工作流通过 OpenID Connect（OIDC）可信发布执行 `npm publish`，然后创建同名 GitHub Release，并附上打包文件。

首次发布前，把该包的 GitHub Actions 可信发布者设为仓库 `gray0128/cap2pi`、工作流文件 `release.yml`，并允许直接 `npm publish`。不要把 npm token 写入仓库或 GitHub Secrets。当前版本 `0.1.1` 已经在 npm 上。下一次发布先提高 `version`，再推送对应标签。不要用已经发布或已被 npm 占用的版本号重新推送标签。

```sh
git tag "v$(node -p "require('./package.json').version")"
git push origin "v$(node -p "require('./package.json').version")"
```
