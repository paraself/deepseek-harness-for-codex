# DeepSeek Harness for Codex

<p align="center">
  <strong>简体中文</strong> · <a href="./README.en.md">English</a>
</p>

<p align="center">
  <img src="./assets/icon.png" width="128" alt="DeepSeek Harness for Codex 图标">
</p>

让 Codex 连接或启动本地 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)，委派任务、返回可点击的实时 Web 会话链接，并独立检查实际变更和测试结果。本 README 对应 [paraself fork 的 main 分支](https://github.com/paraself/deepseek-harness-for-codex)。

![DeepSeek Harness for Codex 演示](./imgs/examples.gif)

## 功能

- 连接已有 DSH Web，或由插件启动本地服务。
- 在可见会话中执行任务，支持新建会话和继续已完成的对话。
- 可选：成功后自动归档新建会话，并清理插件新建的空工作区登记。
- 插件包含 MCP 服务和委派工作流；Codex 负责独立验收。

## 安装

需要支持插件的 Codex 客户端、Node.js 22 或更高版本（包含 `npx`），以及 DeepSeek API Key。

```sh
codex plugin marketplace add paraself/deepseek-harness-for-codex --ref main
codex plugin add deepseek-harness@deepseek-harness-for-codex
```

安装后重启 Codex，确保加载新插件代码。若 macOS 上找不到 `codex` 或命令指向其他安装，请使用当前桌面客户端配套的 Codex CLI；路径取决于客户端和安装位置。无需另外注册 MCP。

由插件启动服务时，API Key 可以放在目标仓库根目录中不提交到 Git 的 `.env` 文件里：

```dotenv
DEEPSEEK_API_KEY=your-key
```

也可以将 `DEEPSEEK_API_KEY` 注入启动 Codex 的环境，或在 Harness 的 **Settings → Models** 配置。连接已有服务时，应在该 DSH 服务自身的 Models 设置或启动环境中配置，目标仓库的 `.env` 不保证被其读取。

## 首次设置

在 Codex 的 DeepSeek Harness 插件详情页打开原生连接设置。该面板直接调用插件，不依赖聊天中的 MCP 弹窗，在全权限模式下也可设置。其他支持 MCP 表单的客户端仍可在首次调用 `start_run` 或 `start_service` 时填写表单；取消时不保存、不启动服务。

| 连接方式 | 操作与影响 |
| --- | --- |
| 已有 DSH Web | 在原生设置面板中粘贴本次 DSH 启动时输出的完整认证 URL（含 `?token=...`），不要贴进聊天。按 Enter 或移开焦点后验证并保存；认证失败时保留旧配置。输入 URL 会切换到已有服务。 |
| 插件启动服务 | 插件运行 `dsh web --port 0`；首次可能下载 Harness npm 包，MCP 本身已随插件安装。 |

面板也可开启“成功后自动归档新建会话，并清理插件新建的空工作区”。选择保存在本地；设置页与聊天使用不同插件进程时，聊天也会读取最新配置。`open_setup` 仅说明原生设置入口，不会自动打开窗口，也不代表设置成功。

认证 URL 输入框每次读取均为空；留空不会删除旧凭据。输入通过原生设置 UI 直接返回插件，设置工具只对应用可见，不作为模型问答答案，也不回显 token 到错误或工具结果。输入框是普通文本控件；Codex 客户端仍会接触输入，可能记录本地日志。

保存失败时，URL 输入框下方会显示具体原因和处理办法，区分认证被拒绝、无法连接、超时、响应异常和本地写入失败。Codex 可能同时显示通用错误提示；成功保存后清除上次失败原因。

新的 URL 验证并保存成功后，该行标题显示“✅ URL 已验证并保存”，下方显示保存时间、脱敏地址，并说明输入框清空是正常行为。成功提示保留到下一次设置操作；空白提交或修改其他设置不会显示 URL 保存成功。

聊天中的表单可能被客户端自动拒绝，此时不代表用户点击了拒绝。使用插件详情页的原生设置即可，无需改变权限策略。

## 日常使用

在 Codex 中提出完整任务、约束和验收要求，例如：

> 使用 DeepSeek Harness 实现这个需求。把实时会话链接发给我，完成后检查实际 diff 并运行相关测试。

Codex 调用 `start_run`，展示返回的 `webUrl`，通过 `wait_run` 或 `get_run` 跟踪结果，最后独立验证。任务不会自动打开会话页；需要时手动打开链接，或明确要求 Codex 使用 `open_service`。若浏览器尚未登录，`open_service` 可使用插件私下保存的认证 URL 打开页面，工具结果仍只返回脱敏地址。

省略 `sessionId` 会新建会话；传入之前已完成运行的 `sessionId` 可继续原对话，只返回本轮新增输出。运行中的会话不能并发复用。服务会持续复用；`stop_service` 会取消活动任务，并停止插件启动的服务，对已有外部服务只断开连接、不停止其进程。

## 更新

```sh
codex plugin marketplace upgrade deepseek-harness-for-codex
codex plugin add deepseek-harness@deepseek-harness-for-codex
```

更新后重启 Codex 以加载新代码。以下参考内容供配置、迁移或开发时使用。

<details>
<summary>MCP 工具（12 个模型工具和 2 个原生设置工具）</summary>

| 工具 | 用途 |
| --- | --- |
| `doctor` | 检查 Node、npx、包版本、凭据可见性、数据目录和工作区限制，不下载包。 |
| `open_setup` | 说明插件详情页原生设置入口；不自动打开窗口。 |
| `settings_read` / `settings_update` | 原生设置 UI 专用工具；返回脱敏设置，接收变更字段。对模型隐藏。 |
| `wait_setup` | 等待已打开的设置表单完成，单次最多 30 秒。 |
| `start_service` | 为工作区启动或复用 Web 服务，返回链接；默认不打开浏览器。 |
| `open_service` | 在用户明确要求时打开正在运行的 Harness 页面。 |
| `list_services` | 列出当前 MCP 进程管理的服务及链接。 |
| `stop_service` | 取消活动任务；停止插件启动的服务，或断开外部服务连接。 |
| `start_run` | 新建会话或继续已完成的会话，提交任务并返回 `runId` 和 `webUrl`。 |
| `wait_run` | 等待会话结果，单次最多 30 秒。 |
| `get_run` | 读取会话状态和助手输出。 |
| `list_runs` | 列出当前 MCP 进程创建的运行记录。 |
| `cancel_run` | 取消当前 agent turn，保留 Web 服务。 |

</details>

<details>
<summary>配置、权限与自动清理</summary>

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_MCP_DATA_DIR` | `PLUGIN_DATA`，否则 `~/.deep-seek-harness-mcp` | 本地设置和会话数据目录；显式设置此变量优先。 |
| `DSH_MCP_WORKSPACE_ROOTS` | 不限制 | 允许访问的绝对根目录列表，使用当前平台的路径分隔符。 |
| `DSH_MCP_HARNESS_PACKAGE` | `@deepseek-ai/dsh@0.1.5-rc.2` | 插件启动服务时使用的 npm 包版本。 |
| `DSH_MCP_NPX_COMMAND` | `npx`（Windows 为 `npx.cmd`） | 自定义 npx 路径。 |
| `DSH_MCP_WEB_URL` | 未设置 | 用完整回环认证 URL 覆盖保存的连接选择。 |
| `DSH_MCP_AUTO_ARCHIVE` | 未设置 | `true`/`false` 覆盖保存的归档与清理开关，默认关闭。 |
| `DSH_PERMISSION_MODE` | `workspace-write` | 插件启动的 Harness 的权限模式。 |
| `DEEPSEEK_BASE_URL` | 服务商默认值 | 可选的 DeepSeek 兼容 API 地址。 |

环境变量覆盖对应设置。设置仍保存在数据目录的 `connection.json`，旧配置继续有效；含 Token 的文件在 Unix 上以 `0600` 权限创建，不得提交。工具返回不含 Token 的地址，启动日志和连接错误也会脱敏。

开启自动归档后，仅归档成功的新建会话，失败、取消和复用的会话不归档。随后只清理**当前 MCP 进程自己创建**的工作区登记，要求其中所有会话均已归档，且没有运行中会话或本插件活动任务。原有工作区及仍有未归档会话的工作区保留。清理只移除侧栏登记，磁盘目录、文件和会话历史保留；归档或清理失败记录在 `archiveError`，不改变运行的成功状态。

DSH 尚无原子的“空时删除”接口；其他客户端在检查与删除之间创建的会话可能移到未分组。

`start_run` 可修改文件，要求已存在的绝对工作区路径并解析符号链接。可用 `DSH_MCP_WORKSPACE_ROOTS` 限制范围；进程通过 argv 启动。插件启动的 Web 服务仅监听回环地址、自动选端口，Harness 子进程默认关闭遥测。

</details>

<details>
<summary>旧名称迁移与卸载</summary>

安装过 `deepseek-harness-mcp` 时，先移除旧插件和市场，再按“安装”重新安装：

```sh
codex plugin remove deepseek-harness-mcp@deepseek-harness
codex plugin marketplace remove deepseek-harness
```

旧 npm 包不会自动替换；数据目录的最后回退仍为 `~/.deep-seek-harness-mcp`；使用相同数据目录可继续使用原有设置和会话。卸载当前插件：

```sh
codex plugin remove deepseek-harness@deepseek-harness-for-codex
codex plugin marketplace remove deepseek-harness-for-codex
```

</details>

<details>
<summary>独立安装 MCP</summary>

只需要 MCP 工具时，可从 fork 的 main 安装，不包含插件委派工作流和 Codex UI 入口：

```sh
npm install --global 'github:paraself/deepseek-harness-for-codex#main'
codex mcp add deepseek-harness -- deepseek-harness-for-codex
```

注册后重启 Codex。使用 main 可跟随 fork 更新。

</details>

<details>
<summary>本地开发与 npm 发布</summary>

克隆后执行 `npm ci`、`npm run check`、`npm run build`，再将本地仓库加入插件市场：

```sh
codex plugin marketplace add /absolute/path/to/deepseek-harness-for-codex
codex plugin add deepseek-harness@deepseek-harness-for-codex
```

插件直接运行 `plugins/deepseek-harness/dist/bin.mjs`，启动时不访问 GitHub；本地 MCP 开发可在构建后直接执行该文件。重启 Codex 加载更新。

npm 包名为 `deepseek-harness-for-codex`，发布到 `https://registry.npmjs.org/`。

发布前使用 `npm login`、`npm whoami` 确认账号，运行 `npm run release:check` 检查测试和打包内容，再执行 `npm publish`。`prepublishOnly` 自动执行 `npm run check`（类型检查、测试、构建及构建产物检查）；本 README 不代表 fork 的 main 已发布到 npm。

</details>
