---
name: deepseek-harness
description: Start the local DeepSeek Harness Web UI, provide a clickable session link, delegate a scoped coding task into the visible Web session, then independently review and verify the workspace changes. Use when the user asks Codex to use, show, control, or hand work to DeepSeek Harness, including requests phrased as "use dsh" or "用 dsh".
---

# DeepSeek Harness

Use the `deepseek-harness` MCP tools to run DeepSeek Harness locally through its Web UI. The user must be able to watch the same session that Codex controls. Codex remains responsible for the task outcome and must inspect the changed files and run appropriate verification itself.

## Workflow

1. Call quick `doctor` before the first run in a task. Explain failed prerequisites and security warnings. Use `deep: true` with the target workspace only when the user asks for end-to-end diagnostics or quick checks cannot explain a failure; deep mode starts a real model turn, may use credits, and creates local session data. A DeepSeek API key may come from the MCP environment, the target workspace's uncommitted `.env` file, or the Harness Web Models settings.
2. Inspect the target repository enough to write a concrete delegation prompt. Include the requested outcome, relevant repository instructions, scope limits, and acceptance checks. Do not include credentials.
3. Decide whether the attempt needs a new Harness session or should continue a completed one. Omit `sessionId` for independent work or a clean retry. Pass the earlier run's `sessionId` for a direct follow-up or correction that benefits from the existing conversation. Never reuse a running session or a session from another workspace.
4. Call `start_run` with `openBrowser: false` and the chosen `sessionId`, if any. When the user supplied an explicit file scope, pass matching workspace-relative `allowedWritePaths` for post-run auditing. If it returns `status: "pending"`, first-use connection setup has opened in the browser. Show `setupUrl` only if the page did not open. Never request or pass the authentication URL through chat or MCP tool arguments. Call `wait_setup` in intervals of at most 30 seconds until it returns `status: "configured"`, then submit the task once by retrying the same `start_run` input. A managed service starts only after this choice.
5. Show the returned `webUrl` as a clickable Markdown link so the user can open the live Harness session when they choose. State whether `sessionReused` is true. Do not call `open_service` unless the user explicitly asks Codex to open the session page. Use `open_setup` only when the user asks to change the saved connection choice.
6. Call `wait_run` with a timeout of at most 30 seconds until the run is `succeeded`, `failed`, `blocked`, `cancelled`, or `needs_approval`. The browser and MCP observe the same session ID and history. Return structured approval details to the user immediately; after the user decides in Harness Web, use `get_run` or `wait_run` again to refresh the same run.
7. Treat the Harness response as a handoff report, not proof. Inspect the actual workspace diff, preserve unrelated user changes, and run the smallest checks that cover the change.
8. If review finds a concrete defect, choose whether to continue the completed session for context or start a clean correction session, state the defect and failed check precisely, and review the correction again.
9. Use `cancel_run` to cancel an unsafe or obsolete turn while leaving the Web page available. Use `stop_service` only when the local server is no longer needed.

## Safety

- Harness Web starts as a loopback-only local child process and receives access to the requested workspace. Do not pass a broader directory than needed.
- The local setup page persists the existing service's authentication URL in the plugin data directory. Never echo its token into Codex messages, logs, or repository files.
- Treat a returned Web URL containing `?token=` as sensitive. Do not copy it into files, logs, commits, or unrelated messages.
- `allowedWritePaths` reports Git-visible out-of-scope changes after a run; it is not a write-prevention sandbox and does not inspect ignored files.
- The default permission mode is `workspace-write`. Do not switch to `danger-full-access` unless the user explicitly authorizes that broader access.
- Do not ask Harness to commit, push, publish, deploy, or contact external systems unless the user explicitly requested that action.
