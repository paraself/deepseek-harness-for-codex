# DeepSeek Harness for Codex

<p align="center">
  <a href="./README.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  <img src="./assets/icon.png" width="128" alt="DeepSeek Harness for Codex icon">
</p>

Let Codex connect to or start local [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness), delegate tasks, return clickable live Web session links, and independently check actual changes and test results. This README describes [main in the paraself fork](https://github.com/paraself/deepseek-harness-for-codex).

![DeepSeek Harness for Codex demo](./imgs/examples.gif)

## Features

- Connect to existing DSH Web or let the plugin start a local service.
- Run tasks in visible sessions; create new sessions or continue completed conversations.
- Optionally archive successful new sessions and remove empty workspace registrations created by the plugin.
- The plugin includes the MCP server and delegation workflow; Codex independently verifies the result.

## Installation

You need a Codex client with plugin support, Node.js 22 or later (including `npx`), and a DeepSeek API key.

```sh
codex plugin marketplace add paraself/deepseek-harness-for-codex --ref main
codex plugin add deepseek-harness@deepseek-harness-for-codex
```

Restart Codex after installation to load the new plugin code. On macOS, if `codex` is missing or points to another installation, use the Codex CLI supplied with your current desktop client; its path depends on the client and installation. No separate MCP registration is needed.

For a plugin-managed service, you can put the API key in an uncommitted `.env` file at the target repository root:

```dotenv
DEEPSEEK_API_KEY=your-key
```

Alternatively, pass `DEEPSEEK_API_KEY` to the environment that starts Codex, or configure it in Harness under **Settings → Models**. For an existing service, configure its own Models settings or startup environment; it may not read the target repository `.env`.

## First-use setup

Open the native connection settings in the DeepSeek Harness plugin details page in Codex. The panel calls the plugin directly and works in Full Access without a chat elicitation. Other clients that allow MCP forms can still configure their first `start_run` or `start_service` through a form; cancelling saves nothing and starts no service.

| Connection | Action and behavior |
| --- | --- |
| Existing DSH Web | Paste the full authentication URL from the current DSH startup (including `?token=...`) into the native settings, never into chat. Enter or blur validates and saves it; failure preserves the previous settings. Entering a URL switches to the existing service. |
| Plugin-managed service | The plugin runs `dsh web --port 0`; the first run may download the Harness npm package. The MCP server itself is already bundled. |

The panel also offers automatic archiving of successful new sessions and cleanup of empty workspaces created by the plugin. Choices are saved locally. The chat reads the latest configuration even when the settings page uses another plugin process. `open_setup` explains the native entry; it does not open a window or indicate a successful update.

The authentication URL input is blank on every read; leaving it blank does not remove the saved credential. Input goes directly from the native UI to the plugin. Settings tools are app-only and hidden from the model; their results and errors never echo the token. The input is an ordinary text control. The Codex client still handles the input and may record local logs.

When saving fails, the URL field description shows the reason and next step, distinguishing rejected authentication, connection failures, timeouts, unexpected responses, and local write failures. Codex may also show a generic error. A successful save clears the previous failure reason.

A chat form may be automatically declined by the client before it appears; that does not mean the user declined it. Use native plugin settings without changing the permission policy.

## Daily use

Give Codex a complete task, constraints, and acceptance criteria, for example:

> Use DeepSeek Harness to implement this change. Give me the live session link, then review the actual diff and run the relevant checks yourself.

Codex calls `start_run`, presents the returned `webUrl`, follows the result with `wait_run` or `get_run`, and independently verifies it. Tasks do not automatically open session pages; open the link yourself or explicitly ask Codex to use `open_service`. If the browser is not signed in, `open_service` uses the privately stored authentication URL to open it, while tool results still return only the sanitized address.

Omitting `sessionId` creates a new session. Passing a `sessionId` from a completed run continues that conversation and returns only the new turn's output. A running session cannot be reused concurrently. Services remain available for reuse; `stop_service` cancels active tasks and stops plugin-managed services, but only disconnects from an external service without stopping its process.

## Update

```sh
codex plugin marketplace upgrade deepseek-harness-for-codex
codex plugin add deepseek-harness@deepseek-harness-for-codex
```

Restart Codex after updating to load the new code. The following reference sections cover configuration, migration, and development.

<details>
<summary>MCP tools (12 model tools and 2 native settings tools)</summary>

| Tool | Purpose |
| --- | --- |
| `doctor` | Check Node, npx, package selection, credential visibility, data location, and workspace restrictions without downloads. |
| `open_setup` | Explain the native settings entry in the plugin details page; does not open a window. |
| `settings_read` / `settings_update` | App-only native UI tools for redacted settings and partial updates; hidden from the model. |
| `wait_setup` | Wait up to 30 seconds for an already open setup form to finish. |
| `start_service` | Start or reuse Web for a workspace and return its URL; does not open the browser by default. |
| `open_service` | Open a running Harness page when the user explicitly requests it. |
| `list_services` | List services managed by the current MCP process and their URLs. |
| `stop_service` | Cancel active tasks; stop a managed service or disconnect from an external service. |
| `start_run` | Create a new session or continue a completed session, submit a task, and return `runId` and `webUrl`. |
| `wait_run` | Wait up to 30 seconds for a session result. |
| `get_run` | Read session state and assistant output. |
| `list_runs` | List runs created by the current MCP process. |
| `cancel_run` | Cancel the current agent turn while keeping Web available. |

</details>

<details>
<summary>Configuration, permissions, and automatic cleanup</summary>

| Variable | Default | Meaning |
| --- | --- | --- |
| `DSH_MCP_DATA_DIR` | `PLUGIN_DATA`, then `~/.deep-seek-harness-mcp` | Local settings and session data; an explicit value takes priority. |
| `DSH_MCP_WORKSPACE_ROOTS` | unrestricted | Allowed absolute roots, separated by the platform's path delimiter. |
| `DSH_MCP_HARNESS_PACKAGE` | `@deepseek-ai/dsh@0.1.5-rc.2` | npm package version for plugin-managed services. |
| `DSH_MCP_NPX_COMMAND` | `npx` (`npx.cmd` on Windows) | Alternate npx path. |
| `DSH_MCP_WEB_URL` | unset | Full loopback authentication URL overriding the saved connection choice. |
| `DSH_MCP_AUTO_ARCHIVE` | unset | `true`/`false` override for the archive and cleanup switch; off by default. |
| `DSH_PERMISSION_MODE` | `workspace-write` | Permission mode for plugin-managed Harness. |
| `DEEPSEEK_BASE_URL` | provider default | Optional DeepSeek-compatible API endpoint. |

Environment variables override corresponding settings. Choices remain in `connection.json` in the data directory, and existing configurations still work. Token-containing files are created with `0600` permissions on Unix and must not be committed. Tools return token-free URLs and redact authentication tokens from startup logs and connection errors.

Automatic archiving applies only to successful new sessions; failed, cancelled, and reused sessions are not archived. Cleanup then removes only workspace registrations **created by the current MCP process**, requiring every session in the workspace to be archived and no running sessions or active plugin tasks. Existing workspaces and those with unarchived sessions remain. Removal affects only sidebar registration: directories, files, and session history remain. Archive or cleanup errors are recorded in `archiveError` without changing a successful run's status.

DSH has no atomic delete-if-empty operation; a session created by another client between checking and deletion may become ungrouped.

`start_run` can modify files and requires an existing absolute workspace, resolving symlinks. Use `DSH_MCP_WORKSPACE_ROOTS` to restrict access; processes are launched with argv. Managed Web binds only to loopback and selects a free port; Harness child-process telemetry is disabled by default.

</details>

<details>
<summary>Old-name migration and uninstall</summary>

If you installed `deepseek-harness-mcp`, remove the old plugin and marketplace, then follow Installation above:

```sh
codex plugin remove deepseek-harness-mcp@deepseek-harness
codex plugin marketplace remove deepseek-harness
```

The old npm package is not replaced automatically. The final data-directory fallback remains `~/.deep-seek-harness-mcp`; using the same directory retains existing settings and sessions. To uninstall the current plugin:

```sh
codex plugin remove deepseek-harness@deepseek-harness-for-codex
codex plugin marketplace remove deepseek-harness-for-codex
```

</details>

<details>
<summary>Standalone MCP installation</summary>

For MCP tools alone, install from the fork's main branch. This does not include the plugin delegation workflow or Codex UI entry:

```sh
npm install --global 'github:paraself/deepseek-harness-for-codex#main'
codex mcp add deepseek-harness -- deepseek-harness-for-codex
```

Restart Codex after registration. Use main to follow fork updates.

</details>

<details>
<summary>Local development and npm publishing</summary>

After cloning, run `npm ci`, `npm run check`, and `npm run build`, then add the checkout as a local marketplace:

```sh
codex plugin marketplace add /absolute/path/to/deepseek-harness-for-codex
codex plugin add deepseek-harness@deepseek-harness-for-codex
```

The plugin runs `plugins/deepseek-harness/dist/bin.mjs` directly without contacting GitHub at startup. For local MCP development, execute this file after building. Restart Codex to load updates.

The npm package is named `deepseek-harness-for-codex` and publishes to `https://registry.npmjs.org/`.

Before publishing, confirm your account with `npm login` and `npm whoami`, run `npm run release:check` to check tests and package contents, then run `npm publish`. `prepublishOnly` automatically runs `npm run check` (typecheck, tests, build, and bundle checks); this README does not imply that the fork's main has been published to npm.

</details>
