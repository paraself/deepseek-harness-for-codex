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
      "settings_read",
      "settings_update",
      "start_run",
      "start_service",
      "stop_service",
      "wait_run",
      "wait_setup",
    ]);
  });

  it("still supports a first-use MCP form for clients that allow it", async () => {
    const requests: unknown[] = [];
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      requests.push(request.params);
      return { action: "accept", content: { mode: "managed", autoArchiveSuccessfulRuns: true } };
    });
    const response = await client.callTool({ name: "start_service", arguments: { workspace } });
    expect(response.structuredContent).toMatchObject({ status: "running" });
    expect(await manager.connectionStatus()).toMatchObject({ status: "configured", mode: "managed", autoArchiveSuccessfulRuns: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ mode: "form", requestedSchema: { required: ["mode", "autoArchiveSuccessfulRuns"] } });
    expect(openBrowser).not.toHaveBeenCalled();
    expect(manager.listServices()).toHaveLength(1);
  });

  it("advertises app-only native settings with a valid schema and no saved token", async () => {
    expect(client.getServerCapabilities()?.experimental?.["openai/settings"]).toEqual({ readTool: "settings_read", updateTool: "settings_update" });
    const tools = (await client.listTools()).tools.filter((tool) => tool.name.startsWith("settings_"));
    expect(tools).toHaveLength(2);
    for (const tool of tools) expect(tool._meta).toMatchObject({ ui: { visibility: ["app"] } });
    expect(tools.find((tool) => tool.name === "settings_read")?.outputSchema?.required).toEqual(expect.arrayContaining(["schema", "values"]));
    const read = await client.callTool({ name: "settings_read", arguments: {} });
    expect(read.structuredContent).toMatchObject({
      schema: { type: "object", properties: { mode: { type: "string", enum: ["复用已有 DSH", "由插件启动"] }, url: { type: "string" }, autoArchiveSuccessfulRuns: { type: "boolean" } } },
      values: { mode: "复用已有 DSH", url: "", autoArchiveSuccessfulRuns: false },
    });
    await expect(readFile(join(temporaryRoot, "data", "connection.json"))).rejects.toMatchObject({ code: "ENOENT" });
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

  it("shows the native settings entry without claiming a window opened or requesting an elicitation", async () => {
    await client.callTool({ name: "settings_update", arguments: { set: { mode: "由插件启动" } } });
    const configPath = join(temporaryRoot, "data", "connection.json");
    const saved = await readFile(configPath, "utf8");
    const input = vi.fn(async () => ({ action: "decline" as const }));
    client.setRequestHandler(ElicitRequestSchema, input);
    const response = await client.callTool({ name: "open_setup", arguments: {} });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ settingsSurface: "plugin-details", message: expect.stringContaining("插件详情") });
    expect(response.structuredContent).not.toHaveProperty("status");
    expect(input).not.toHaveBeenCalled();
    expect(await readFile(configPath, "utf8")).toBe(saved);
    expect(manager.listServices()).toHaveLength(0);
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("reports a declined form instead of silently continuing a first-use call", async () => {
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "decline" }));
    const response = await client.callTool({ name: "start_service", arguments: { workspace } });
    expect(response.isError).toBe(true);
    expect(response.content).toEqual([expect.objectContaining({ text: expect.stringContaining("declined") })]);
    expect(manager.listServices()).toHaveLength(0);
    await expect(readFile(join(temporaryRoot, "data", "connection.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns an actionable error without opening a page when form elicitation is unsupported", async () => {
    await client.close();
    await server.close();
    server = createMcpServer(manager);
    client = new Client({ name: "legacy-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const response = await client.callTool({ name: "start_service", arguments: { workspace } });
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

  it("preserves connection settings when an update is submitted during an active run", async () => {
    await client.callTool({ name: "settings_update", arguments: { set: { mode: "由插件启动" } } });
    const configPath = join(temporaryRoot, "data", "connection.json");
    const saved = await readFile(configPath, "utf8");
    const started = await client.callTool({ name: "start_run", arguments: { task: "long task", workspace } });
    expect(started.isError).not.toBe(true);
    const updated = await client.callTool({ name: "settings_update", arguments: { set: { autoArchiveSuccessfulRuns: true } } });
    expect(updated.isError).toBe(true);
    expect(updated.content).toEqual([expect.objectContaining({ text: expect.stringContaining("active Harness runs") })]);
    expect(await readFile(configPath, "utf8")).toBe(saved);
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

  it("receives a settings URL directly without an elicitation and keeps its token out of tool results", async () => {
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
      const saved = await client.callTool({ name: "settings_update", arguments: { set: { url: authUrl, autoArchiveSuccessfulRuns: true } } });
      expect(saved.structuredContent).toMatchObject({ values: { mode: "复用已有 DSH", url: "", autoArchiveSuccessfulRuns: true } });
      expect(requests).toHaveLength(0);
      expect(JSON.stringify([requests, saved])).not.toContain("test-token");
      const confirmation = await client.callTool({ name: "settings_read", arguments: {} });
      const urlField = (confirmation.structuredContent as { schema: { properties: { url: { title: string; description: string } } } }).schema.properties.url;
      expect(urlField.title).toBe("✅ URL 已验证并保存");
      expect(urlField.description).toMatch(/保存时间：\d{4}/);
      expect(urlField.description).toContain(new URL(existing.webUrl!).origin);
      expect(urlField.description).toContain("输入框已清空，无需重复填写");
      expect(JSON.stringify(confirmation)).not.toContain("test-token");
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

  it("rejects invalid native updates without changing settings or starting a service", async () => {
    const saved = await client.callTool({ name: "settings_update", arguments: { set: { mode: "由插件启动" } } });
    expect(saved.isError).not.toBe(true);
    const configPath = join(temporaryRoot, "data", "connection.json");
    const previous = await readFile(configPath, "utf8");
    const response = await client.callTool({ name: "settings_update", arguments: { set: { url: "https://example.com/?token=fixture-secret" } } });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response)).not.toContain("fixture-secret");
    expect(await readFile(configPath, "utf8")).toBe(previous);
    expect(manager.listServices()).toHaveLength(0);
  });

  it("shows a rejected token below the URL after the native client re-reads settings and clears it after a successful retry", async () => {
    await client.callTool({ name: "settings_update", arguments: { set: { mode: "由插件启动" } } });
    const configPath = join(temporaryRoot, "data", "connection.json");
    const saved = await readFile(configPath, "utf8");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));
    try {
      const failed = await client.callTool({ name: "settings_update", arguments: { set: { url: "http://localhost:3080/?token=fixture-secret" } } });
      expect(failed.isError).toBe(true);
      for (let i = 0; i < 2; i++) {
        const read = await client.callTool({ name: "settings_read", arguments: {} });
        const definition = read.structuredContent as { schema: { properties: { url: { description: string } } }; values: { url: string } };
        expect(definition.schema.properties.url.description).toContain("上次保存失败");
        expect(definition.schema.properties.url.description).toContain("HTTP 401");
        expect(definition.schema.properties.url.description).toContain("原配置未更改");
        expect(definition.values.url).toBe("");
        expect(JSON.stringify([failed, read])).not.toContain("fixture-secret");
      }
      expect(await readFile(configPath, "utf8")).toBe(saved);
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 303, headers: { "set-cookie": "auth=fixture-cookie" } }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));
      const retry = await client.callTool({ name: "settings_update", arguments: { set: { url: "http://localhost:3080/?token=fixture-secret" } } });
      expect(retry.isError).not.toBe(true);
      const read = await client.callTool({ name: "settings_read", arguments: {} });
      expect(JSON.stringify(read)).not.toContain("上次保存失败");
      expect(JSON.stringify([retry, read])).not.toContain("fixture-secret");
    } finally { fetchMock.mockRestore(); }
  });

  it.each([
    { kind: "blank input", set: { url: "  " }, fails: false },
    { kind: "archive change", set: { autoArchiveSuccessfulRuns: true }, fails: false },
    { kind: "rejected replacement", set: { url: "http://localhost:3080/?token=fixture-rejected" }, fails: true },
  ])("keeps URL success feedback through re-reads and replaces it on $kind", async ({ set, fails }) => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 303, headers: { "set-cookie": "auth=fixture-cookie" } }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValue(new Response(null, { status: 401 }));
    try {
      const initial = await client.callTool({ name: "settings_read", arguments: {} });
      expect(JSON.stringify(initial)).not.toContain("✅ URL 已验证并保存");
      const saved = await client.callTool({ name: "settings_update", arguments: { set: { url: "http://localhost:3080/?token=fixture-secret" } } });
      expect(saved.isError).not.toBe(true);
      for (let i = 0; i < 2; i++) {
        const read = await client.callTool({ name: "settings_read", arguments: {} });
        expect(JSON.stringify(read)).toContain("✅ URL 已验证并保存");
        expect(JSON.stringify(read)).not.toContain("fixture-secret");
        expect(read.structuredContent).toMatchObject({ values: { url: "" } });
      }
      const next = await client.callTool({ name: "settings_update", arguments: { set } });
      expect(next.isError === true).toBe(fails);
      const refreshed = await client.callTool({ name: "settings_read", arguments: {} });
      expect(JSON.stringify(refreshed)).not.toContain("✅ URL 已验证并保存");
      expect(JSON.stringify([next, refreshed])).not.toContain("fixture-rejected");
      if (fails) expect(JSON.stringify(refreshed)).toContain("上次保存失败");
      expect(JSON.parse(await readFile(join(temporaryRoot, "data", "connection.json"), "utf8"))).toMatchObject({ url: "http://localhost:3080/?token=fixture-secret" });
    } finally { fetchMock.mockRestore(); }
  });

  it("does not restore an older URL confirmation after a newer settings operation", async () => {
    const update = manager.updateConnectionSettings.bind(manager);
    let resume: (() => void) | undefined;
    let saved!: () => void;
    const stored = new Promise<void>((resolve) => { saved = resolve; });
    const release = new Promise<void>((resolve) => { resume = resolve; });
    const delayed = vi.spyOn(manager, "updateConnectionSettings").mockImplementationOnce(async (...args) => {
      const snapshot = await update(...args);
      saved();
      await release;
      return snapshot;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 303, headers: { "set-cookie": "auth=fixture-cookie" } }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const older = client.callTool({ name: "settings_update", arguments: { set: { url: "http://localhost:3080/?token=fixture-secret" } } });
    try {
      await stored;
      const newer = await client.callTool({ name: "settings_update", arguments: { set: { autoArchiveSuccessfulRuns: true } } });
      expect(newer.isError).not.toBe(true);
      resume!();
      expect((await older).isError).not.toBe(true);
      const read = await client.callTool({ name: "settings_read", arguments: {} });
      expect(JSON.stringify(read)).not.toContain("✅ URL 已验证并保存");
      expect(read.structuredContent).toMatchObject({ values: { autoArchiveSuccessfulRuns: true } });
    } finally {
      resume?.();
      await older;
      delayed.mockRestore();
      fetchMock.mockRestore();
    }
  });
});
