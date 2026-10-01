import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

  it("archives a newly-created successful session when enabled", async () => {
    await mkdir(join(temporaryRoot, "data"));
    await writeFile(join(temporaryRoot, "data", "connection.json"), JSON.stringify({ mode: "managed", autoArchiveSuccessfulRuns: true }));

    const started = await manager.start({ task: "archive me", workspace });
    const completed = await manager.wait(started.runId, 2_000);

    expect(completed.status).toBe("succeeded");
    expect(completed.sessionArchived).toBe(true);

    const response = await fetch(`${started.webUrl}/api/session/list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "archive-test", method: "session/list", payload: { args: { _request: {} } } }),
    });
    const body = await response.json() as { result: { value: { items: Array<{ sessionId: string }> } } };
    expect(body.result.value.items.some((item) => item.sessionId === started.sessionId)).toBe(false);
  });

  it("does not archive failed or cancelled runs", async () => {
    await mkdir(join(temporaryRoot, "data"));
    await writeFile(join(temporaryRoot, "data", "connection.json"), JSON.stringify({ mode: "managed", autoArchiveSuccessfulRuns: true }));

    const failed = await manager.start({ task: "fail", workspace });
    const failedResult = await manager.wait(failed.runId, 2_000);
    expect(failedResult.status).toBe("failed");
    expect(failedResult.sessionArchived).toBe(false);

    const cancelled = await manager.start({ task: "long task", workspace });
    const cancelledResult = await manager.cancel(cancelled.runId);
    expect(cancelledResult.status).toBe("cancelled");
    expect(cancelledResult.sessionArchived).toBe(false);
  });

  it("keeps a successful reused session visible", async () => {
    const first = await manager.start({ task: "first", workspace });
    await manager.wait(first.runId, 2_000);
    const serviceUrl = manager.listServices()[0]?.webUrl;
    expect(serviceUrl).not.toBeNull();

    const dataDirectory = join(temporaryRoot, "attached-data");
    await mkdir(dataDirectory);
    await writeFile(join(dataDirectory, "connection.json"), JSON.stringify({
      mode: "external",
      url: serviceUrl,
      autoArchiveSuccessfulRuns: true,
    }));
    const attached = new RunManager({
      dataDirectory,
      allowedRoots: [temporaryRoot],
      pollIntervalMs: 10,
      spawnProcess: vi.fn(() => { throw new Error("must not spawn"); }),
    });
    try {
      const continued = await attached.start({ task: "follow-up", workspace, sessionId: first.sessionId });
      const completed = await attached.wait(continued.runId, 2_000);
      expect(completed.status).toBe("succeeded");
      expect(completed.sessionReused).toBe(true);
      expect(completed.sessionArchived).toBe(false);
    } finally {
      await attached.close();
    }
  });

  it("reports archive errors without failing the run", async () => {
    await mkdir(join(temporaryRoot, "data"));
    await writeFile(join(temporaryRoot, "data", "connection.json"), JSON.stringify({ mode: "managed", autoArchiveSuccessfulRuns: true }));
    process.env.FAKE_DSH_ARCHIVE_ERROR = "1";
    try {
      const started = await manager.start({ task: "archive error", workspace });
      const completed = await manager.wait(started.runId, 2_000);
      expect(completed.status).toBe("succeeded");
      expect(completed.sessionArchived).toBe(false);
      expect(completed.archiveError).toContain("archive unavailable");
    } finally {
      delete process.env.FAKE_DSH_ARCHIVE_ERROR;
    }
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
      expect((await authenticated.wait(started.runId, 2_000)).status).toBe("succeeded");
      await authenticated.openService(started.serviceId);
      expect(openBrowser).toHaveBeenCalledWith(started.webUrl);
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
    const spawnProcess = vi.fn(() => { throw new Error("must not spawn"); });
    const attached = new RunManager({
      dataDirectory: join(temporaryRoot, "attached-data"),
      allowedRoots: [temporaryRoot],
      externalWebUrl: host.webUrl!,
      pollIntervalMs: 10,
      spawnProcess,
    });

    try {
      const started = await attached.start({ task: "external task", workspace });
      expect(started.webUrl).toBe(new URL(host.webUrl!).origin);
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
