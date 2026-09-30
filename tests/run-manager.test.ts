import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunManager } from "../src/run-manager.js";
import type { HarnessCommand } from "../src/runtime.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-harness.mjs");

describe("RunManager Web orchestration", () => {
  let temporaryRoot: string;
  let workspace: string;
  let manager: RunManager;
  const openBrowser = vi.fn(async () => undefined);

  function git(cwd: string, args: string[]): void {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
    if (result.status !== 0) throw new Error(result.stderr || `git exited with ${String(result.status)}`);
  }

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "deepseek-harness-mcp-"));
    workspace = join(temporaryRoot, "workspace");
    await mkdir(workspace);
    openBrowser.mockClear();
    manager = new RunManager({
      dataDirectory: join(temporaryRoot, "data"),
      allowedRoots: [temporaryRoot],
      startupTimeoutMs: 2_000,
      pollIntervalMs: 10,
      openBrowser,
      commandFactory: ({ workspace: cwd }): HarnessCommand => ({
        command: process.execPath,
        args: [fixture],
        cwd,
        env: { ...process.env },
      }),
    });
  });

  afterEach(async () => {
    await manager.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("starts the Web service and opens its page", async () => {
    const service = await manager.startService({ workspace, openBrowser: true });

    expect(service.status).toBe("running");
    expect(service.webUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(service.browserOpened).toBe(true);
    expect(openBrowser).toHaveBeenCalledWith(service.webUrl);
    expect((await fetch(service.webUrl!)).status).toBe(200);
  });

  it("starts the Web service without opening its page by default", async () => {
    const service = await manager.startService({ workspace });

    expect(service.status).toBe("running");
    expect(service.webUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(service.browserOpened).toBe(false);
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("authenticates a token-protected Web service started by the manager", async () => {
    await manager.close();
    manager = new RunManager({
      dataDirectory: join(temporaryRoot, "authenticated-launch-data"),
      allowedRoots: [temporaryRoot],
      startupTimeoutMs: 2_000,
      pollIntervalMs: 10,
      openBrowser,
      commandFactory: ({ workspace: cwd }): HarnessCommand => ({
        command: process.execPath,
        args: [fixture],
        cwd,
        env: { ...process.env, FAKE_DSH_AUTH_TOKEN: "launch-token" },
      }),
    });

    const started = await manager.start({ task: "authenticated task", workspace });

    expect(started.webUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(JSON.stringify(manager.listServices())).not.toContain("launch-token");
    expect(manager.listServices()[0]?.logTail).not.toContain("launch-token");
    expect(manager.listServices()[0]?.logTail).not.toContain("fake_dsh");
    expect((await manager.wait(started.runId, 2_000)).status).toBe("succeeded");
  });

  it("submits the task into the visible Web session", async () => {
    const started = await manager.start({ task: "implement feature", workspace, openBrowser: true });
    expect(started.status).toBe("running");
    expect(started.webUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(started.sessionId).toBe("session-1");
    expect(started.sessionReused).toBe(false);

    const completed = await manager.wait(started.runId, 2_000);
    expect(completed.status).toBe("succeeded");
    expect(completed.assistantText).toBe("completed:implement feature");
    expect(completed.lastEventSeq).toBeGreaterThanOrEqual(3);
  });

  it("prefixes the generated title after the DSH title provider finishes", async () => {
    const started = await manager.start({ task: "title-provider", workspace });
    await manager.wait(started.runId, 2_000);

    await vi.waitFor(async () => {
      const response = await fetch(`${started.webUrl}/api/session/list`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId: "title-test", method: "session/list", payload: { args: { _request: {} } } }),
      });
      const body = await response.json() as { result: { value: { items: Array<{ sessionId: string; projections: { values: { title: string } } }> } } };
      expect(body.result.value.items.find((item) => item.sessionId === started.sessionId)?.projections.values.title).toBe("[codex] generated title");
    }, { timeout: 3_000 });
  });

  it("prefixes DSH's fallback title when no title provider runs", async () => {
    const started = await manager.start({ task: "title-fallback", workspace });
    await manager.wait(started.runId, 2_000);

    await vi.waitFor(async () => {
      const response = await fetch(`${started.webUrl}/api/session/list`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId: "fallback-test", method: "session/list", payload: { args: { _request: {} } } }),
      });
      const body = await response.json() as { result: { value: { items: Array<{ sessionId: string; projections: { values: { title: string } } }> } } };
      expect(body.result.value.items.find((item) => item.sessionId === started.sessionId)?.projections.values.title).toBe("[codex] fallback title");
    }, { timeout: 3_000 });
  });

  it("reuses one Web service for later tasks in the workspace", async () => {
    const first = await manager.start({ task: "first", workspace });
    const second = await manager.start({ task: "second", workspace });

    expect(second.serviceId).toBe(first.serviceId);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(manager.listServices()).toHaveLength(1);
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("authenticates a plugin-managed Web service before making RPC calls", async () => {
    const authenticated = new RunManager({
      dataDirectory: join(temporaryRoot, "managed-auth-data"),
      allowedRoots: [temporaryRoot],
      startupTimeoutMs: 2_000,
      pollIntervalMs: 10,
      openBrowser,
      commandFactory: ({ workspace: cwd }): HarnessCommand => ({
        command: process.execPath,
        args: [fixture],
        cwd,
        env: { ...process.env, FAKE_DSH_AUTH_TOKEN: "test-token" },
      }),
    });
    try {
      const started = await authenticated.start({ task: "authenticated task", workspace });
      expect(JSON.stringify(started)).not.toContain("test-token");
      expect(JSON.stringify(authenticated.listServices())).not.toContain("test-token");
      expect((await authenticated.wait(started.runId, 2_000)).status).toBe("succeeded");
      await authenticated.openService(started.serviceId);
      expect(openBrowser).toHaveBeenCalledWith(`${started.webUrl}/?token=test-token`);
    } finally {
      await authenticated.close();
    }
  });

  it("attaches to an existing Web service without owning its process", async () => {
    const authenticatedHost = new RunManager({
      dataDirectory: join(temporaryRoot, "authenticated-host-data"),
      allowedRoots: [temporaryRoot],
      startupTimeoutMs: 2_000,
      commandFactory: ({ workspace: cwd }): HarnessCommand => ({
        command: process.execPath,
        args: [fixture],
        cwd,
        env: { ...process.env, FAKE_DSH_AUTH_TOKEN: "test-token" },
      }),
    });
    const host = await authenticatedHost.startService({ workspace });
    const authenticationUrl = new URL(host.webUrl!);
    authenticationUrl.searchParams.set("token", "test-token");
    const spawnProcess = vi.fn(() => { throw new Error("must not spawn"); });
    const attached = new RunManager({
      dataDirectory: join(temporaryRoot, "attached-data"),
      allowedRoots: [temporaryRoot],
      externalWebUrl: authenticationUrl.href,
      pollIntervalMs: 10,
      spawnProcess,
    });

    try {
      const started = await attached.start({ task: "external task", workspace });
      expect(started.webUrl).toBe(authenticationUrl.origin);
      expect(JSON.stringify(attached.listServices())).not.toContain("test-token");
      expect(attached.listServices()[0]?.processId).toBeNull();
      expect((await attached.wait(started.runId, 2_000)).status).toBe("succeeded");
      await attached.stopService(started.serviceId);
      expect(authenticatedHost.listServices()[0]?.status).toBe("running");
      expect(spawnProcess).not.toHaveBeenCalled();
    } finally {
      await attached.close();
      await authenticatedHost.close();
    }
  });

  it("lets the caller continue a completed session without returning earlier output", async () => {
    const first = await manager.start({ task: "first", workspace, openBrowser: false });
    await manager.wait(first.runId, 2_000);

    const second = await manager.start({
      task: "follow-up",
      workspace,
      sessionId: first.sessionId,
      openBrowser: false,
    });
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.sessionReused).toBe(true);

    const completed = await manager.wait(second.runId, 2_000);
    expect(completed.status).toBe("succeeded");
    expect(completed.assistantText).toBe("completed:follow-up");
    expect(completed.lastEventSeq).toBeGreaterThanOrEqual(6);
  });

  it("rejects reuse while the selected session is running", async () => {
    const first = await manager.start({ task: "first", workspace, openBrowser: false });

    await expect(manager.start({
      task: "overlap",
      workspace,
      sessionId: first.sessionId,
      openBrowser: false,
    })).rejects.toThrow("still running");
  });

  it("cancels a run but keeps its Web service alive", async () => {
    const started = await manager.start({ task: "long task", workspace, openBrowser: false });
    const cancelled = await manager.cancel(started.runId);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelRequested).toBe(true);
    expect(manager.listServices()[0]?.status).toBe("running");
  });

  it("returns structured approval and blocked states", async () => {
    const approvalRun = await manager.start({ task: "request approval", workspace });
    const awaiting = await manager.wait(approvalRun.runId, 2_000);
    expect(awaiting).toMatchObject({
      status: "needs_approval",
      approval: { id: "approval-1", toolName: "pwsh", reason: "Needs elevated access" },
    });
    await manager.cancel(approvalRun.runId);

    const blockedRun = await manager.start({ task: "be blocked", workspace });
    const blocked = await manager.wait(blockedRun.runId, 2_000);
    expect(blocked.status).toBe("blocked");
    expect(blocked.error).toContain("blocked");
  });

  it.each([
    ["end with error", "failed"],
    ["end with max tokens", "failed"],
    ["end interrupted", "failed"],
    ["end aborted", "failed"],
  ])("does not treat %s as success", async (task, status) => {
    const started = await manager.start({ task, workspace });
    const completed = await manager.wait(started.runId, 2_000);
    expect(completed.status).toBe(status);
    expect(completed.error).toContain("reason");
  });

  it("restores persisted runs without persisting service credentials", async () => {
    const dataDirectory = join(temporaryRoot, "persistent-data");
    await manager.close();
    manager = new RunManager({
      dataDirectory,
      allowedRoots: [temporaryRoot],
      startupTimeoutMs: 2_000,
      pollIntervalMs: 10,
      openBrowser,
      commandFactory: ({ workspace: cwd }): HarnessCommand => ({
        command: process.execPath,
        args: [fixture],
        cwd,
        env: { ...process.env, FAKE_DSH_AUTH_TOKEN: "never-persist-this-token" },
      }),
    });
    const started = await manager.start({ task: "persist me", workspace });
    await manager.wait(started.runId, 2_000);
    await manager.close();

    const stateFiles = await readdir(join(dataDirectory, "runs-v1"));
    expect(stateFiles).toHaveLength(1);
    const stateText = await readFile(join(dataDirectory, "runs-v1", stateFiles[0]!), "utf8");
    expect(stateText).not.toContain("never-persist-this-token");
    expect(stateText).not.toContain("fake_dsh");
    expect(stateText).not.toContain("persist me");

    manager = new RunManager({ dataDirectory, allowedRoots: [temporaryRoot] });
    const restored = await manager.list();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      runId: started.runId,
      sessionId: started.sessionId,
      status: "succeeded",
      recovered: true,
      webUrl: null,
      task: "[task text was not persisted]",
      assistantText: "",
    });
  });

  it("keeps runs from concurrent MCP managers in separate state files", async () => {
    const dataDirectory = join(temporaryRoot, "shared-data");
    await manager.close();
    const options = {
      dataDirectory,
      allowedRoots: [temporaryRoot],
      startupTimeoutMs: 2_000,
      pollIntervalMs: 10,
      commandFactory: ({ workspace: cwd }: { workspace: string }): HarnessCommand => ({
        command: process.execPath,
        args: [fixture],
        cwd,
        env: { ...process.env },
      }),
    };
    const firstManager = new RunManager(options);
    const secondManager = new RunManager(options);
    try {
      const first = await firstManager.start({ task: "first process", workspace });
      const second = await secondManager.start({ task: "second process", workspace });
      await Promise.all([
        firstManager.wait(first.runId, 2_000),
        secondManager.wait(second.runId, 2_000),
      ]);
    } finally {
      await Promise.all([firstManager.close(), secondManager.close()]);
    }

    const stateFiles = await readdir(join(dataDirectory, "runs-v1"));
    expect(stateFiles).toHaveLength(2);
    manager = new RunManager({ dataDirectory, allowedRoots: [temporaryRoot] });
    expect(await manager.list()).toHaveLength(2);
  });

  it("reports Git-visible changes outside allowed write paths", async () => {
    await writeFile(join(workspace, "allowed.txt"), "before\n");
    await writeFile(join(workspace, "outside.txt"), "before\n");
    git(workspace, ["init"]);
    git(workspace, ["add", "."]);
    git(workspace, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "baseline"]);

    const started = await manager.start({
      task: "request approval",
      workspace,
      allowedWritePaths: ["allowed.txt"],
    });
    await manager.wait(started.runId, 2_000);
    await writeFile(join(workspace, "allowed.txt"), "after\n");
    await writeFile(join(workspace, "outside.txt"), "after\n");
    git(workspace, ["add", "."]);
    git(workspace, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "task changes"]);

    const cancelled = await manager.cancel(started.runId);
    expect(cancelled.writeBoundary).toMatchObject({
      checked: true,
      violations: ["outside.txt"],
      error: null,
    });
  });

  it("treats a dot write boundary as the whole workspace", async () => {
    await writeFile(join(workspace, "outside.txt"), "before\n");
    git(workspace, ["init"]);
    git(workspace, ["add", "."]);
    git(workspace, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "baseline"]);

    const started = await manager.start({ task: "request approval", workspace, allowedWritePaths: ["."] });
    await manager.wait(started.runId, 2_000);
    await writeFile(join(workspace, "outside.txt"), "after\n");

    const cancelled = await manager.cancel(started.runId);
    expect(cancelled.writeBoundary).toMatchObject({ checked: true, violations: [], error: null });
  });

  it("rejects traversal in allowed write paths", async () => {
    await expect(manager.start({
      task: "task",
      workspace,
      allowedWritePaths: ["../outside"],
    })).rejects.toThrow("workspace-relative paths");
  });

  it("rejects relative and out-of-policy workspaces", async () => {
    await expect(manager.startService({ workspace: "." })).rejects.toThrow("absolute path");
    const outside = await mkdtemp(join(tmpdir(), "deepseek-harness-outside-"));
    try {
      await expect(manager.startService({ workspace: outside })).rejects.toThrow("outside DSH_MCP_WORKSPACE_ROOTS");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
