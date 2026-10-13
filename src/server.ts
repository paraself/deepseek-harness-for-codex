import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestId } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { inspectRuntime } from "./runtime.js";
import { RunManager } from "./run-manager.js";
import type { SetupInputHandler } from "./setup.js";

const runIdSchema = z.string().uuid().describe("Run identifier returned by start_run.");
const serviceIdSchema = z.string().uuid().describe("Service identifier returned by start_service or start_run.");

function result(value: object) {
  const structuredContent: Record<string, unknown> = { ...value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/** Creates the MCP tool surface over a local run manager. */
export function createMcpServer(manager: RunManager = new RunManager()): McpServer {
  const server = new McpServer(
    { name: "deepseek-harness-for-codex", version: "0.4.2" },
    {
      instructions:
        "On first use, start_service or start_run asks for settings through an MCP form. The plugin receives and saves the authentication URL directly; never ask for it through chat or tool arguments. If the user cancels, leave settings unchanged. Do not open the Harness session page unless the user explicitly requests it.",
    },
  );

  const setupInput = (requestId: RequestId, toolSignal: AbortSignal): SetupInputHandler => async (request, signal) => {
    if (!server.server.getClientCapabilities()?.elicitation?.form) throw new Error("This MCP client does not support setup forms. Update Codex or configure DSH_MCP_WEB_URL locally.");
    try {
      return await server.server.elicitInput(request, { relatedRequestId: requestId, signal: AbortSignal.any([signal, toolSignal]), timeout: 600_000 });
    } catch { throw new Error("The setup form was interrupted or timed out. Call open_setup to try again."); }
  };

  server.registerTool(
    "start_service",
    {
      title: "Start the local DeepSeek Harness Web UI",
      description: "On first use, collect connection settings through the client's MCP form. Once configured, start or reuse Harness Web for an absolute workspace.",
      inputSchema: {
        workspace: z.string().min(1).describe("Absolute repository path served by DeepSeek Harness."),
        openBrowser: z.boolean().default(false).describe("Open the Harness page after readiness. Keep false unless the user explicitly requested it."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input, extra) => {
      try {
        const setup = await manager.ensureConnection(setupInput(extra.requestId, extra.signal), extra.signal);
        if (extra.signal.aborted) throw new Error("The setup request was cancelled.");
        return result(setup.status === "configured" ? await manager.startService(input) : setup);
      } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "open_setup",
    {
      title: "Open DeepSeek Harness connection settings",
      description: "Open the client's MCP form to change the saved DSH connection and auto-archive setting. Authentication input goes directly to the plugin, not through tool arguments.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (_input, extra) => {
      try { return result(await manager.openSetup(setupInput(extra.requestId, extra.signal), extra.signal)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "wait_setup",
    {
      title: "Wait for DeepSeek Harness connection setup",
      description: "Wait up to 30 seconds for an open MCP setup form to finish. Returns no credentials.",
      inputSchema: { timeoutMs: z.number().int().min(0).max(30_000).default(30_000) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => result(await manager.waitSetup(input.timeoutMs)),
  );

  server.registerTool(
    "open_service",
    {
      title: "Open the DeepSeek Harness page",
      description: "Open an already running Harness Web service in the user's default browser.",
      inputSchema: { serviceId: serviceIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      try { return result(await manager.openService(input.serviceId)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "list_services",
    {
      title: "List local DeepSeek Harness Web services",
      description: "List Web services started by the current MCP server and their visible URLs.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => result({ services: manager.listServices() }),
  );

  server.registerTool(
    "stop_service",
    {
      title: "Stop a DeepSeek Harness Web service",
      description: "Cancel active sessions and stop the local Harness Web service process.",
      inputSchema: { serviceId: serviceIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try { return result(await manager.stopService(input.serviceId)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "doctor",
    {
      title: "Check local DeepSeek Harness prerequisites",
      description: "Check Node, npx, runtime package, credentials visibility, data location, and workspace restrictions without downloading anything.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const setup = await manager.connectionStatus();
      const externalUrl = await manager.configuredExternalUrl();
      return result({
        ...inspectRuntime(externalUrl === undefined ? process.env : { ...process.env, DSH_MCP_WEB_URL: externalUrl }),
        setupStatus: setup.status,
        connectionMode: setup.mode,
      });
    },
  );

  server.registerTool(
    "start_run",
    {
      title: "Start a local DeepSeek Harness run",
      description: "On first use, collect connection settings through the client's MCP form. Once configured, create or continue a visible Harness session and return its runId and webUrl.",
      inputSchema: {
        task: z.string().min(1).max(100_000).describe("Complete implementation task, constraints, and acceptance checks for DeepSeek Harness."),
        workspace: z.string().min(1).describe("Absolute path of the repository DeepSeek Harness may inspect and modify."),
        sessionId: z.string().min(1).optional().describe("Completed Harness session to continue. Pass a sessionId returned by an earlier run in this workspace, or omit it to create a new session."),
        openBrowser: z.boolean().default(false).describe("Open the live Harness Web page. Keep false unless the user explicitly requested it."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input, extra) => {
      try {
        const setup = await manager.ensureConnection(setupInput(extra.requestId, extra.signal), extra.signal);
        if (extra.signal.aborted) throw new Error("The setup request was cancelled.");
        return result(setup.status === "configured" ? await manager.start(input) : setup);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_run",
    {
      title: "Read a DeepSeek Harness run",
      description: "Read the current state and assistant response from the same Harness Web session shown to the user.",
      inputSchema: {
        runId: runIdSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        return result(await manager.get(input.runId));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "wait_run",
    {
      title: "Wait for DeepSeek Harness output",
      description: "Poll the visible Harness Web session for up to 30 seconds and return its current status and assistant response.",
      inputSchema: {
        runId: runIdSchema,
        timeoutMs: z.number().int().min(0).max(30_000).default(30_000),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        return result(await manager.wait(input.runId, input.timeoutMs));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_runs",
    {
      title: "List local DeepSeek Harness runs",
      description: "List runs started by the current MCP server process, including session IDs Codex may choose to continue in a later start_run call.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => result({ runs: await manager.list() }),
  );

  server.registerTool(
    "cancel_run",
    {
      title: "Cancel a local DeepSeek Harness run",
      description: "Cancel the agent turn in its visible Web session while keeping the Harness Web UI running.",
      inputSchema: { runId: runIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        return result(await manager.cancel(input.runId));
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}
