import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunManager } from "../src/run-manager.js";
import type { HarnessCommand } from "../src/runtime.js";
import { createMcpServer } from "../src/server.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-harness.mjs");
const openBrowser = vi.fn(async () => undefined);

describe("MCP server", () => {
  let temporaryRoot: string;
  let workspace: string;
  let manager: RunManager;
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;

  beforeEach(async () => {
    openBrowser.mockClear();
    temporaryRoot = await mkdtemp(join(tmpdir(), "deep-seek-harness-mcp-server-"));
    workspace = join(temporaryRoot, "workspace");
    await mkdir(workspace);
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
    server = createMcpServer(manager);
    client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await manager.close();
    await server.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("advertises the complete orchestration surface", async () => {
    const response = await client.listTools();
    expect(response.tools.map((tool) => tool.name).sort()).toEqual([
      "cancel_run",
      "doctor",
      "get_run",
      "list_runs",
      "list_services",
      "open_service",
      "open_setup",
      "start_run",
      "start_service",
      "stop_service",
      "wait_run",
      "wait_setup",
    ]);
  });

  it("starts and waits for a local run through MCP", async () => {
    const firstUse = await client.callTool({
      name: "start_run",
      arguments: { task: "MCP task", workspace },
    });
    expect(firstUse.structuredContent).toMatchObject({ status: "pending", mode: null });
    const setupUrl = (firstUse.structuredContent as { setupUrl: string }).setupUrl;
    expect(openBrowser).toHaveBeenCalledWith(setupUrl);
    expect(manager.listServices()).toHaveLength(0);
    const pageResponse = await fetch(setupUrl);
    expect(pageResponse.headers.get("referrer-policy")).toBe("same-origin");
    const page = await pageResponse.text();
    expect(page).toContain("连接已有服务");
    expect(page).toContain("由插件启动新服务");
    const choice = await fetch(setupUrl, {
      method: "POST",
      headers: { origin: new URL(setupUrl).origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ mode: "managed" }),
    });
    expect(choice.status).toBe(200);
    expect((await client.callTool({ name: "wait_setup", arguments: { timeoutMs: 2_000 } })).structuredContent)
      .toMatchObject({ status: "configured", mode: "managed" });

    const start = await client.callTool({
      name: "start_run",
      arguments: { task: "MCP task", workspace },
    });
    expect(start.isError).not.toBe(true);
    const runId = (start.structuredContent as { runId: string }).runId;

    const wait = await client.callTool({
      name: "wait_run",
      arguments: { runId, timeoutMs: 2_000 },
    });

    expect(wait.isError).not.toBe(true);
    expect(wait.structuredContent).toMatchObject({
      runId,
      status: "succeeded",
      assistantText: "completed:MCP task",
    });

    const sessionId = (start.structuredContent as { sessionId: string }).sessionId;
    const followUp = await client.callTool({
      name: "start_run",
      arguments: { task: "MCP follow-up", workspace, sessionId },
    });
    expect(followUp.isError).not.toBe(true);
    expect(followUp.structuredContent).toMatchObject({ sessionId, sessionReused: true });

    const followUpRunId = (followUp.structuredContent as { runId: string }).runId;
    const followUpWait = await client.callTool({
      name: "wait_run",
      arguments: { runId: followUpRunId, timeoutMs: 2_000 },
    });
    expect(followUpWait.structuredContent).toMatchObject({
      status: "succeeded",
      assistantText: "completed:MCP follow-up",
    });
    expect(openBrowser).toHaveBeenCalledTimes(1);
  });

  it("returns a tool error for an invalid workspace", async () => {
    const setup = await manager.ensureConnection();
    await fetch(setup.setupUrl!, {
      method: "POST",
      headers: { origin: new URL(setup.setupUrl!).origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ mode: "managed" }),
    });
    const response = await client.callTool({
      name: "start_run",
      arguments: { task: "task", workspace: "." },
    });

    expect(response.isError).toBe(true);
    expect(response.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("absolute path") }),
    ]);
  });

  it("opens one setup page for concurrent first-use calls", async () => {
    const [first, second] = await Promise.all([
      client.callTool({ name: "start_service", arguments: { workspace } }),
      client.callTool({ name: "start_service", arguments: { workspace } }),
    ]);
    expect((first.structuredContent as { setupUrl: string }).setupUrl)
      .toBe((second.structuredContent as { setupUrl: string }).setupUrl);
    expect(openBrowser).toHaveBeenCalledTimes(1);
  });

  it("connects to an existing service through the browser form and keeps its token private", async () => {
    const host = new RunManager({
      dataDirectory: join(temporaryRoot, "host-data"),
      allowedRoots: [temporaryRoot],
      startupTimeoutMs: 2_000,
      commandFactory: ({ workspace: cwd }): HarnessCommand => ({
        command: process.execPath,
        args: [fixture],
        cwd,
        env: { ...process.env, FAKE_DSH_AUTH_TOKEN: "test-token" },
      }),
    });
    try {
      const existing = await host.startService({ workspace });
      const firstUse = await client.callTool({ name: "start_service", arguments: { workspace } });
      const setupUrl = (firstUse.structuredContent as { setupUrl: string }).setupUrl;
      expect(firstUse.structuredContent).toMatchObject({ status: "pending" });

      const badOrigin = await fetch(setupUrl, {
        method: "POST",
        headers: { origin: "http://evil.invalid", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ mode: "external", url: existing.webUrl! }),
      });
      expect(badOrigin.status).toBe(403);

      const remote = await fetch(setupUrl, {
        method: "POST",
        headers: { origin: new URL(setupUrl).origin, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ mode: "external", url: "https://example.com/?token=not-local" }),
      });
      expect(remote.status).toBe(400);

      const saved = await fetch(setupUrl, {
        method: "POST",
        redirect: "manual",
        headers: { origin: new URL(setupUrl).origin, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ mode: "external", url: existing.webUrl! }),
      });
      expect(saved.status).toBe(303);
      expect(saved.headers.get("location")).toBe(existing.webUrl);
      expect(saved.headers.get("referrer-policy")).toBe("no-referrer");
      const ready = await client.callTool({ name: "wait_setup", arguments: { timeoutMs: 2_000 } });
      expect(ready.structuredContent).toMatchObject({
        status: "configured", mode: "external", externalWebUrl: new URL(existing.webUrl!).origin,
      });
      expect(JSON.stringify(ready)).not.toContain("test-token");
      const doctor = await client.callTool({ name: "doctor", arguments: {} });
      expect(JSON.stringify(doctor)).not.toContain("test-token");

      const attached = await client.callTool({ name: "start_service", arguments: { workspace } });
      expect(attached.structuredContent).toMatchObject({
        status: "running", webUrl: new URL(existing.webUrl!).origin, processId: null,
      });
      expect(JSON.stringify(await client.callTool({ name: "list_services", arguments: {} }))).not.toContain("test-token");
      expect(host.listServices()[0]?.status).toBe("running");
      if (process.platform !== "win32") {
        expect((await stat(join(temporaryRoot, "data", "connection.json"))).mode & 0o777).toBe(0o600);
      }
      const restarted = new RunManager({ dataDirectory: join(temporaryRoot, "data"), allowedRoots: [temporaryRoot] });
      expect(await restarted.connectionStatus()).toMatchObject({ status: "configured", mode: "external" });
      await restarted.close();
    } finally {
      await host.close();
    }
  });
});
