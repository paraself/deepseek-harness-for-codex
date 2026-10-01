# DeepSeek Harness for Codex

<p align="center">
  <a href="./README.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  <img src="./assets/icon.png" width="128" alt="DeepSeek Harness for Codex icon">
</p>

DeepSeek Harness for Codex lets Codex start [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) locally, return a clickable live-session link, delegate work to it, and then independently review the resulting workspace changes.

![DeepSeek Harness for Codex demo](./imgs/examples.gif)

## Quick start

Use the Codex plugin unless you specifically need a standalone MCP server. The plugin installs both the MCP tools and the instructions that tell Codex to review Harness's work independently.

### 1. Check the requirements

- Node.js 22 or later, including `npx`
- A Codex client with plugin support
- A DeepSeek API key

Put the API key in the target repository's ignored `.env` file:

```dotenv
DEEPSEEK_API_KEY=your-key
```

Do not commit this file. You can instead provide `DEEPSEEK_API_KEY` to the environment that starts Codex, or configure the key later in the opened Harness page under **Settings → Models**.

### 2. Install the plugin

Copy these two commands into a terminal:

```sh
codex plugin marketplace add paraself/deepseek-harness-for-codex --ref main
codex plugin add deepseek-harness@deepseek-harness-for-codex
```

On macOS, if `codex` is not found or another global installation shadows the desktop client, use the executable bundled with the app:

```sh
CODEX_APP_BIN="/Applications/ChatGPT.app/Contents/Resources/codex"
"$CODEX_APP_BIN" plugin marketplace add paraself/deepseek-harness-for-codex --ref main
"$CODEX_APP_BIN" plugin add deepseek-harness@deepseek-harness-for-codex
```

### 3. Start a new Codex task

Plugins are loaded when a task starts. Create a new task in Codex and ask it to use DeepSeek Harness, for example:

> Use DeepSeek Harness to implement this change in a visible local session. Open the setup page on first use; give me the live Harness session link, then review the diff and run the relevant checks yourself.

On first use, the plugin opens a local setup page. Choose an existing DSH Web service by pasting its full startup authentication URL, or let the plugin start a new service; the page also controls whether successful new sessions are archived automatically. The choice is saved locally. Codex then submits the task, follows the visible session, and independently verifies the result. Later tasks do not automatically open the session page. No separate MCP registration is needed.

The MCP server is included with the plugin, so startup does not download it. Managed mode may still download the Harness npm package on its first run.

For an existing service, the setup page verifies the full authentication URL, including `?token=...`, saves it only in the plugin's private local data file, then redirects the browser to that service to sign in. MCP tools return only the token-free address to Codex. `DSH_MCP_WEB_URL` remains available as an environment override. `stop_service` and MCP shutdown only detach from an external DSH service. If DSH restarts with a new URL, ask Codex to call `open_setup` and update it.

## Migrating from the old name

The project was renamed from `deepseek-harness-mcp` to `deepseek-harness-for-codex`. If you installed the old plugin, remove its plugin and marketplace before following the installation steps above:

```sh
codex plugin remove deepseek-harness-mcp@deepseek-harness
codex plugin marketplace remove deepseek-harness
```

The old npm package is not replaced automatically. The default data directory remains `~/.deep-seek-harness-mcp`, so the new installation can continue using existing local Harness settings and sessions.

## Update

Refresh the marketplace and reinstall the plugin, then start a new Codex task:

```sh
codex plugin marketplace upgrade deepseek-harness-for-codex
codex plugin add deepseek-harness@deepseek-harness-for-codex
```

## Uninstall

```sh
codex plugin remove deepseek-harness@deepseek-harness-for-codex
codex plugin marketplace remove deepseek-harness-for-codex
```

## Standalone MCP installation

Use this only when you need the MCP tools without the plugin's delegation instructions and Codex UI entry:

```sh
npm install --global 'github:paraself/deepseek-harness-for-codex#paraself-v0.4.1-bundled-mcp.1'
codex mcp add deepseek-harness -- deepseek-harness-for-codex
```

Start a new Codex task after registration.

## How it works

The plugin launches its bundled MCP server directly. Without a saved choice, the first `start_run` or `start_service` opens a loopback-only setup page. After the user chooses, Codex retries the call. Managed mode runs `@deepseek-ai/dsh web --port 0`; existing-service mode connects to the chosen Web service without launching another DSH process.

Each run is fresh and asynchronous:

1. Codex calls `start_run` with an absolute workspace and a complete task. If first-use setup is pending, it waits with `wait_setup` and retries the call after configuration.
2. The MCP server starts or reuses Harness Web, submits a visible session, and returns its page URL to Codex.
3. Codex presents a clickable link; the user opens it when needed while Codex follows the same session with `wait_run` or `get_run`.
4. Codex inspects the resulting diff and runs its own verification.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `doctor` | Check Node, npx, package selection, credential visibility, data location, and workspace restrictions. |
| `open_setup` | Open the local setup page to change the connection choice. |
| `wait_setup` | Wait up to 30 seconds for the setup page to save a choice. |
| `start_service` | Start or reuse Harness Web for a workspace and return its URL without opening the browser by default. |
| `open_service` | Open a running Harness page when the user explicitly requests it. |
| `list_services` | List local Harness Web services and URLs. |
| `stop_service` | Stop a Harness Web service. |
| `start_run` | Create a new visible session or continue a completed session selected by Codex, then submit a task. |
| `wait_run` | Wait up to 30 seconds for the visible session. |
| `get_run` | Read state and assistant text from the Web session. |
| `list_runs` | List runs owned by the current MCP server process. |
| `cancel_run` | Cancel the agent turn while keeping Web available. |

The first-use setup page opens automatically. Selecting an existing service redirects the browser there to sign in; later runs do not automatically open the session page. Both `start_service` and `start_run` still default `openBrowser` to `false`. Codex should render the returned `webUrl` as a clickable link and use `open_service` only when the user asks it to open the session page.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DSH_MCP_DATA_DIR` | `~/.deep-seek-harness-mcp` | Persistent per-workspace Harness Web settings and sessions. |
| `DSH_MCP_WORKSPACE_ROOTS` | unrestricted | Platform-delimited absolute roots that may be passed to `start_run`. |
| `DSH_MCP_HARNESS_PACKAGE` | `@deepseek-ai/dsh@0.1.5-rc.2` | Exact npm package used for the local Harness process. |
| `DSH_MCP_NPX_COMMAND` | `npx` | Alternate path to `npx`. |
| `DSH_MCP_WEB_URL` | unset | Optional override of the saved choice; use the full loopback authentication URL printed at DSH startup. |
| `DSH_MCP_AUTO_ARCHIVE` | unset | Optional `true`/`false` override for the setup-page archive switch; when enabled, only successful newly-created sessions are archived. |
| `DSH_PERMISSION_MODE` | `workspace-write` | DeepSeek Harness permission mode. |
| `DEEPSEEK_BASE_URL` | provider default | Optional DeepSeek-compatible API endpoint. |

The setup page saves the choice in `DSH_MCP_DATA_DIR/connection.json`. Failed, cancelled, and reused sessions are not archived; an archive failure leaves the run successful and is returned as `archiveError`. On Unix, a file containing a token is created with `0600` permissions and must not be committed. Telemetry is disabled for Harness child processes by default. The Web service binds to loopback and selects a free port. Session data remains in the configured data directory for local audit.

## Security model

`start_run` is a write-capable tool. The server requires an existing absolute workspace, resolves symlinks, uses argv instead of a shell, and can restrict allowed roots with `DSH_MCP_WORKSPACE_ROOTS`. Harness Web stays on loopback. The default permission mode is `workspace-write`; this project does not silently enable unrestricted host access.

## Session model

Every `start_run` lets Codex choose the session. Omitting `sessionId` creates a new visible Harness session. Passing a completed `sessionId` from an earlier run continues that conversation while returning only the new turn's output. A running session cannot be reused concurrently. The Web service is reused for later tasks in the same workspace until `stop_service` or MCP shutdown.

## Local development

Clone this repository, build the npm package, then add the checkout as a local marketplace:

```sh
npm install
npm run check
codex plugin marketplace add /absolute/path/to/deepseek-harness-for-codex
codex plugin add deepseek-harness@deepseek-harness-for-codex
```

The installed plugin starts `plugins/deepseek-harness/dist/bin.mjs` directly without contacting GitHub at startup. For local MCP development, run `npm run build` and execute that file.

## Publishing the npm package

This repository publishes the public, unscoped `deepseek-harness-for-codex` package to the official npm registry. `npm publish` automatically runs the typecheck, test, and build gate. The package includes `plugins/deepseek-harness/dist/`, both README files, the demo GIF, `LICENSE`, and the package manifest.

Authenticate and verify the account:

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

Inspect the release, publish it, and verify the executable:

```sh
npm run release:check
npm publish
npm view deepseek-harness-for-codex version --registry=https://registry.npmjs.org/
npx --yes --package=deepseek-harness-for-codex@<published-version> -- deepseek-harness-for-codex
```

An npm version cannot be overwritten. For later releases, update references in `package.json`, `.mcp.json`, and the MCP server metadata together, then run `npm version patch`, `npm version minor`, or `npm version major` before publishing.
