import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
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
    client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { mode: "managed", autoArchiveSuccessfulRuns: false } }));
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

  it("collects settings through a native MCP form without opening a browser", async () => {
    const requests: unknown[] = [];
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      requests.push(request.params);
      return { action: "accept", content: { mode: "managed", autoArchiveSuccessfulRuns: true } };
    });
    const response = await client.callTool({ name: "open_setup", arguments: {} });
    expect(response.structuredContent).toMatchObject({ status: "configured", mode: "managed", autoArchiveSuccessfulRuns: true, setupUrl: null });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ mode: "form", requestedSchema: { required: ["mode", "autoArchiveSuccessfulRuns"] } });
    expect(openBrowser).not.toHaveBeenCalled();
    expect(manager.listServices()).toHaveLength(0);
  });

  it("leaves settings and services untouched when the native form is cancelled", async () => {
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "cancel" }));
    const response = await client.callTool({ name: "start_service", arguments: { workspace } });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ status: "required", mode: null });
    expect(manager.listServices()).toHaveLength(0);
    expect(openBrowser).not.toHaveBeenCalled();
    await expect(readFile(join(temporaryRoot, "data", "connection.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns an actionable error without opening a page when form elicitation is unsupported", async () => {
    await client.close();
    await server.close();
    server = createMcpServer(manager);
    client = new Client({ name: "legacy-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const response = await client.callTool({ name: "open_setup", arguments: {} });
    expect(response.isError).toBe(true);
    expect(response.content).toEqual([expect.objectContaining({ text: expect.stringContaining("does not support setup forms") })]);
    expect(openBrowser).not.toHaveBeenCalled();
    expect(manager.listServices()).toHaveLength(0);
  });

  it("does not save or start when the caller cancels after submitting the form", async () => {
    let finishAuthentication!: () => void;
    const authentication = new Promise<Response>((resolve) => { finishAuthentication = () => resolve(new Response(null, { status: 303, headers: { "set-cookie": "auth=fixture-cookie" } })); });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => authentication).mockResolvedValue(new Response(null, { status: 200 }));
    const controller = new AbortController();
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { mode: "external", url: "http://localhost:3080/?token=fixture-secret", autoArchiveSuccessfulRuns: false } }));
    try {
      const calling = client.callTool({ name: "start_service", arguments: { workspace } }, undefined, { signal: controller.signal });
      const cancelled = expect(calling).rejects.toThrow();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      controller.abort();
      await cancelled;
      finishAuthentication();
      await vi.waitFor(async () => expect(await manager.connectionStatus()).toMatchObject({ status: "required" }));
      expect(manager.listServices()).toHaveLength(0);
      await expect(readFile(join(temporaryRoot, "data", "connection.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { fetchMock.mockRestore(); }
  });

  it("starts and waits for a local run through MCP", async () => {
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
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("returns a tool error for an invalid workspace", async () => {
    const response = await client.callTool({
      name: "start_run",
      arguments: { task: "task", workspace: "." },
    });

    expect(response.isError).toBe(true);
    expect(response.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("absolute path") }),
    ]);
  });

  it("opens one MCP form for concurrent first-use calls", async () => {
    const requests = vi.fn(async () => ({ action: "accept" as const, content: { mode: "managed", autoArchiveSuccessfulRuns: false } }));
    client.setRequestHandler(ElicitRequestSchema, requests);
    const [first, second] = await Promise.all([
      client.callTool({ name: "start_service", arguments: { workspace } }),
      client.callTool({ name: "start_service", arguments: { workspace } }),
    ]);
    expect(first.structuredContent).toMatchObject({ status: "running" });
    expect(second.structuredContent).toMatchObject({ serviceId: (first.structuredContent as { serviceId: string }).serviceId });
    expect(requests).toHaveBeenCalledTimes(1);
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("receives a native form URL directly and keeps its token out of requests and tool results", async () => {
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
      const authUrl = `${new URL(existing.webUrl!).origin}/?token=test-token`;
      const requests: unknown[] = [];
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        requests.push(request.params);
        return { action: "accept", content: { mode: "external", url: authUrl, autoArchiveSuccessfulRuns: true } };
      });
      const saved = await client.callTool({ name: "open_setup", arguments: {} });
      expect(saved.structuredContent).toMatchObject({ status: "configured", mode: "external", autoArchiveSuccessfulRuns: true });
      expect(JSON.stringify([requests, saved])).not.toContain("test-token");
      expect(JSON.parse(await readFile(join(temporaryRoot, "data", "connection.json"), "utf8"))).toEqual({ mode: "external", url: authUrl, autoArchiveSuccessfulRuns: true });
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
      await client.callTool({ name: "open_service", arguments: { serviceId: (attached.structuredContent as { serviceId: string }).serviceId } });
      expect(openBrowser).toHaveBeenLastCalledWith(authUrl);
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
