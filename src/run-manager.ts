import { createHash, randomUUID } from "node:crypto";
import { realpath, mkdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  buildHarnessWebCommand,
  authenticateExternalWebService,
  resolveAllowedRoots,
  resolveDataDirectory,
  resolveExternalWebService,
  type ExternalWebService,
  type HarnessCommand,
} from "./runtime.js";
import { ConnectionSetup, type SetupSnapshot } from "./setup.js";
import type { RunSnapshot, RunStatus, ServiceSnapshot, ServiceStatus, StartRunInput, StartServiceInput } from "./types.js";

const READY_PATTERN = /dsh web: (http:\/\/[^\s]+)/;
const STARTUP_TIMEOUT_MS = 120_000;
const CANCEL_GRACE_MS = 5_000;
const MAX_LOG_CHARACTERS = 100_000;
const TITLE_PREFIX = "[codex] ";
// ponytail: 最多等待两分钟；若标题模型的超时更长，再按实际配置延长。
const TITLE_WAIT_MS = 120_000;

interface ServiceRecord {
  serviceId: string;
  workspace: string;
  status: ServiceStatus;
  webUrl: string | null;
  apiUrl: string | null;
  browserOpened: boolean;
  browserError: string | null;
  startedAt: Date;
  stoppedAt: Date | null;
  child: ChildProcess | null;
  cookie: string | null;
  sourceUrl: string | null;
  log: string;
}

interface RunRecord {
  runId: string;
  serviceId: string;
  sessionId: string;
  sessionReused: boolean;
  startEventSeq: number;
  task: string;
  workspace: string;
  webUrl: string;
  status: RunStatus;
  cancelRequested: boolean;
  startedAt: Date;
  finishedAt: Date | null;
  assistantText: string;
  lastEventSeq: number;
  error: string | null;
  sessionArchived: boolean;
  archiveError: string | null;
}

interface RpcEnvelope<T> {
  result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
}

interface SessionSummary {
  sessionId: string;
  running: boolean;
  blank: boolean;
  projections?: { asOfSeq: number };
}

interface HistoryEvent {
  event: { type: string; seq: number; data: unknown };
}

/** Options for replacing process, browser, and Web command creation in tests. */
export interface RunManagerOptions {
  dataDirectory?: string;
  allowedRoots?: string[];
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  externalWebUrl?: string;
  commandFactory?: (input: { workspace: string; serviceHome: string }) => HarnessCommand;
  spawnProcess?: (command: HarnessCommand) => ChildProcess;
  openBrowser?: (url: string) => Promise<void>;
}

function defaultSpawnProcess(command: HarnessCommand): ChildProcess {
  return spawn(command.command, command.args, {
    cwd: command.cwd,
    env: command.env,
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { shell: false, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with code ${String(code)}`)));
  });
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return typeof record.message === "string" ? record.message : typeof record.error === "string" ? record.error : null;
}

function assistantText(events: HistoryEvent[]): string {
  const blocks: string[] = [];
  for (const { event } of events) {
    if (event.type !== "assistant/message" || typeof event.data !== "object" || event.data === null) continue;
    const message = (event.data as Record<string, unknown>).message;
    if (typeof message !== "object" || message === null) continue;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "text") {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") blocks.push(text);
      }
    }
  }
  return blocks.join("\n");
}

/** Owns visible local Harness Web services and tasks submitted into their sessions. */
export class RunManager {
  private readonly services = new Map<string, ServiceRecord>();
  private readonly serviceByWorkspace = new Map<string, string>();
  private readonly starts = new Map<string, Promise<ServiceRecord>>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly activeSessions = new Set<string>();
  private readonly dataDirectory: string;
  private readonly allowedRoots: string[];
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly connectionSetup: ConnectionSetup;
  private readonly commandFactory: NonNullable<RunManagerOptions["commandFactory"]>;
  private readonly spawnProcess: NonNullable<RunManagerOptions["spawnProcess"]>;
  private readonly openBrowserImpl: NonNullable<RunManagerOptions["openBrowser"]>;

  public constructor(options: RunManagerOptions = {}) {
    this.dataDirectory = resolve(options.dataDirectory ?? resolveDataDirectory());
    this.allowedRoots = (options.allowedRoots ?? resolveAllowedRoots()).map((root) => resolve(root));
    this.startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? 400;
    this.commandFactory = options.commandFactory ?? ((input) => buildHarnessWebCommand(input));
    this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
    this.openBrowserImpl = options.openBrowser ?? defaultOpenBrowser;
    this.connectionSetup = new ConnectionSetup(this.dataDirectory, this.openBrowserImpl, options.externalWebUrl);
  }

  /** Opens first-use setup only when no connection choice exists. */
  public async ensureConnection(): Promise<SetupSnapshot> {
    return this.connectionSetup.open();
  }

  /** Reopens the local setup page to change a saved choice. */
  public async openSetup(): Promise<SetupSnapshot> {
    if (this.activeSessions.size > 0) throw new Error("Finish active Harness runs before changing the connection.");
    return this.connectionSetup.open(true);
  }

  public async waitSetup(timeoutMs: number): Promise<SetupSnapshot> {
    return this.connectionSetup.wait(timeoutMs);
  }

  public async connectionStatus(): Promise<SetupSnapshot> {
    return this.connectionSetup.state();
  }

  public async configuredExternalUrl(): Promise<string | undefined> {
    const choice = await this.connectionSetup.getChoice();
    return choice?.mode === "external" ? choice.url : undefined;
  }

  /** Starts or reuses the Harness Web service for an absolute workspace. */
  public async startService(input: StartServiceInput): Promise<ServiceSnapshot> {
    const workspace = await this.resolveWorkspace(input.workspace);
    const choice = await this.connectionSetup.getChoice();
    const sourceUrl = choice?.mode === "external" ? choice.url : null;
    const external = sourceUrl === null ? undefined : resolveExternalWebService({ DSH_MCP_WEB_URL: sourceUrl });
    let service = this.serviceForWorkspace(workspace);
    if (service !== undefined && service.sourceUrl !== sourceUrl) {
      const serviceId = service.serviceId;
      if ([...this.runs.values()].some((run) => run.serviceId === serviceId && run.status === "running")) {
        throw new Error("Finish active Harness runs before changing the connection.");
      }
      await this.terminate(service);
      service = undefined;
    }
    if (service === undefined) {
      const pending = this.starts.get(workspace) ?? (external === undefined
        ? this.launchService(workspace)
        : this.attachService(workspace, external, sourceUrl!));
      this.starts.set(workspace, pending);
      try {
        service = await pending;
      } finally {
        this.starts.delete(workspace);
      }
    }
    if ((input.openBrowser ?? false) && service.webUrl !== null) {
      try {
        await this.openBrowserImpl(service.sourceUrl ?? service.webUrl);
        service.browserOpened = true;
        service.browserError = null;
      } catch (error) {
        service.browserError = errorText(error);
      }
    }
    return this.serviceSnapshot(service);
  }

  /** Opens an already running service in the user's default browser. */
  public async openService(serviceId: string): Promise<ServiceSnapshot> {
    const service = this.requireService(serviceId);
    if (service.status !== "running" || service.webUrl === null) throw new Error("Harness Web service is not running.");
    await this.openBrowserImpl(service.sourceUrl ?? service.webUrl);
    service.browserOpened = true;
    service.browserError = null;
    return this.serviceSnapshot(service);
  }

  /** Lists services tracked by the current MCP server. */
  public listServices(): ServiceSnapshot[] {
    return [...this.services.values()].map((service) => this.serviceSnapshot(service));
  }

  /** Stops one Web service and its active sessions. */
  public async stopService(serviceId: string): Promise<ServiceSnapshot> {
    const service = this.requireService(serviceId);
    if (service.status === "running" || service.status === "starting") {
      for (const run of this.runs.values()) {
        if (run.serviceId === serviceId && run.status === "running") await this.cancel(run.runId);
      }
      await this.terminate(service);
    }
    return this.serviceSnapshot(service);
  }

  /** Starts or continues a Web session and submits the task through Harness RPC. */
  public async start(input: StartRunInput): Promise<RunSnapshot> {
    const task = input.task.trim();
    if (!task) throw new Error("task must not be empty.");
    if (task.length > 100_000) throw new Error("task exceeds the 100,000 character limit.");
    const serviceSnapshot = await this.startService({ workspace: input.workspace, openBrowser: false });
    if (serviceSnapshot.webUrl === null) throw new Error("Harness Web service did not provide a URL.");
    const service = this.requireService(serviceSnapshot.serviceId);
    const workspaceResult = await this.rpc<{ workspace: { workspaceId: string } }>(service, "workspace/create", {
      request: { path: service.workspace },
    });
    const requestedSessionId = input.sessionId?.trim();
    let sessionId: string;
    let startEventSeq = -1;
    if (requestedSessionId === undefined || requestedSessionId === "") {
      const session = await this.rpc<{ sessionId: string }>(service, "session/create", {
        request: { workspaceId: workspaceResult.workspace.workspaceId },
      });
      sessionId = session.sessionId;
    } else {
      const list = await this.rpc<{ items: SessionSummary[] }>(service, "session/list", { _request: {} });
      const summary = list.items.find((item) => item.sessionId === requestedSessionId);
      if (summary === undefined) throw new Error(`Unknown sessionId for this workspace: ${requestedSessionId}`);
      if (summary.running) throw new Error(`Harness session is still running: ${requestedSessionId}`);
      sessionId = requestedSessionId;
      startEventSeq = summary.projections?.asOfSeq ?? -1;
    }
    const activeSessionKey = `${service.serviceId}:${sessionId}`;
    if (this.activeSessions.has(activeSessionKey)) throw new Error(`Harness session already has an active MCP run: ${sessionId}`);
    this.activeSessions.add(activeSessionKey);
    try {
      await this.rpc<{ accepted: true }>(service, "session/prompt", {
        request: {
          requestId: randomUUID(),
          sessionId,
          mode: "queue",
          content: [{ type: "text", text: task }],
        },
      });
    } catch (error) {
      this.activeSessions.delete(activeSessionKey);
      throw error;
    }
    if (input.openBrowser ?? false) {
      try {
        await this.openService(service.serviceId);
      } catch (error) {
        service.browserError = errorText(error);
      }
    }
    const run: RunRecord = {
      runId: randomUUID(),
      serviceId: service.serviceId,
      sessionId,
      sessionReused: requestedSessionId !== undefined && requestedSessionId !== "",
      startEventSeq,
      task,
      workspace: service.workspace,
      webUrl: serviceSnapshot.webUrl,
      status: "running",
      cancelRequested: false,
      startedAt: new Date(),
      finishedAt: null,
      assistantText: "",
      lastEventSeq: startEventSeq,
      error: null,
      sessionArchived: false,
      archiveError: null,
    };
    this.runs.set(run.runId, run);
    if (!run.sessionReused) void this.prefixSessionTitle(service, sessionId);
    return this.refresh(run);
  }

  /** Lists runs and refreshes their observable Web session state. */
  public async list(): Promise<RunSnapshot[]> {
    return Promise.all([...this.runs.values()].map(async (run) => this.refresh(run)));
  }

  /** Reads a run from the same Web session shown to the user. */
  public async get(runId: string): Promise<RunSnapshot> {
    return this.refresh(this.requireRun(runId));
  }

  /** Polls the Web session for up to 30 seconds. */
  public async wait(runId: string, timeoutMs: number): Promise<RunSnapshot> {
    const run = this.requireRun(runId);
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 0), 30_000);
    let snapshot = await this.refresh(run);
    while (snapshot.status === "running" && Date.now() < deadline) {
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now()))));
      snapshot = await this.refresh(run);
    }
    return snapshot;
  }

  /** Cancels the Harness agent turn without stopping the visible Web service. */
  public async cancel(runId: string): Promise<RunSnapshot> {
    const run = this.requireRun(runId);
    if (run.status === "running") {
      run.cancelRequested = true;
      const service = this.requireService(run.serviceId);
      await this.rpc<{ accepted: true }>(service, "session/cancel", { request: { sessionId: run.sessionId } });
    }
    return this.refresh(run);
  }

  /** Stops all Web services before the MCP server exits. */
  public async close(): Promise<void> {
    await this.connectionSetup.close();
    await Promise.all([...this.services.values()].map(async (service) => {
      if (service.status === "running" || service.status === "starting") await this.terminate(service);
    }));
  }

  private async attachService(workspace: string, external: ExternalWebService, sourceUrl: string): Promise<ServiceRecord> {
    const cookie = await authenticateExternalWebService(external);

    const service: ServiceRecord = {
      serviceId: randomUUID(),
      workspace,
      status: "running",
      webUrl: external.webUrl,
      apiUrl: external.webUrl,
      browserOpened: false,
      browserError: null,
      startedAt: new Date(),
      stoppedAt: null,
      child: null,
      cookie,
      sourceUrl,
      log: `Attached to existing Harness Web service at ${external.webUrl}.`,
    };
    this.services.set(service.serviceId, service);
    this.serviceByWorkspace.set(workspace, service.serviceId);
    return service;
  }

  private async launchService(workspace: string): Promise<ServiceRecord> {
    const serviceId = randomUUID();
    const workspaceKey = createHash("sha256").update(workspace).digest("hex").slice(0, 24);
    const serviceHome = join(this.dataDirectory, "services", workspaceKey);
    await mkdir(serviceHome, { recursive: true, mode: 0o700 });
    const command = this.commandFactory({ workspace, serviceHome });
    const child = this.spawnProcess(command);
    const service: ServiceRecord = {
      serviceId,
      workspace,
      status: "starting",
      webUrl: null,
      apiUrl: null,
      browserOpened: false,
      browserError: null,
      startedAt: new Date(),
      stoppedAt: null,
      child,
      cookie: null,
      sourceUrl: null,
      log: "",
    };
    this.services.set(serviceId, service);
    this.serviceByWorkspace.set(workspace, serviceId);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const ready = new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error(`Harness Web service did not become ready within ${String(this.startupTimeoutMs)}ms.`)), this.startupTimeoutMs);
      const onChunk = (chunk: string): void => {
        service.log = `${service.log}${chunk}`.slice(-MAX_LOG_CHARACTERS);
        const url = READY_PATTERN.exec(service.log)?.[1];
        if (url !== undefined && service.status === "starting") {
          clearTimeout(timer);
          service.webUrl = url;
          service.status = "running";
          resolveReady();
        }
      };
      child.stdout?.on("data", onChunk);
      child.stderr?.on("data", onChunk);
      child.once("error", (error) => {
        clearTimeout(timer);
        service.status = "failed";
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        service.stoppedAt = new Date();
        if (service.status === "starting") {
          service.status = "failed";
          reject(new Error(`Harness Web service exited before readiness (code ${String(code)}, signal ${String(signal)}). ${service.log}`));
        } else if (service.status === "running") {
          service.status = code === 0 ? "stopped" : "failed";
        }
      });
    });
    try {
      await ready;
      const external = resolveExternalWebService({ DSH_MCP_WEB_URL: service.webUrl ?? "" });
      if (external === undefined) throw new Error("Harness Web service did not provide a URL.");
      service.cookie = await authenticateExternalWebService(external);
      service.apiUrl = external.webUrl;
      return service;
    } catch (error) {
      this.serviceByWorkspace.delete(workspace);
      if (child.exitCode === null) await this.terminate(service);
      service.status = "failed";
      throw error;
    }
  }

  private async refresh(run: RunRecord): Promise<RunSnapshot> {
    if (run.status !== "running") return this.runSnapshot(run);
    const service = this.requireService(run.serviceId);
    if (service.status !== "running") {
      run.status = "failed";
      run.error = "Harness Web service stopped before the task completed.";
      run.finishedAt = new Date();
      this.releaseSession(run);
      return this.runSnapshot(run);
    }
    try {
      const list = await this.rpc<{ items: SessionSummary[] }>(service, "session/list", { _request: {} });
      const summary = list.items.find((item) => item.sessionId === run.sessionId);
      if (summary === undefined) throw new Error(`Harness session disappeared: ${run.sessionId}`);
      const page = await this.rpc<{ records: HistoryEvent[] }>(service, "session/page", {
        request: {
          address: { kind: "session", sessionId: run.sessionId },
          throughSeq: summary.projections?.asOfSeq ?? -1,
          maxMessages: 50,
        },
      });
      const events = page.records.filter((entry) => entry.event.seq > run.startEventSeq);
      run.lastEventSeq = events.reduce((highest, entry) => Math.max(highest, entry.event.seq), run.lastEventSeq);
      run.assistantText = assistantText(events);
      const agentError = [...events].reverse().find((entry) => entry.event.type === "agent/error");
      const turnEnded = events.some((entry) => entry.event.type === "turn/end");
      if (agentError !== undefined) {
        run.status = "failed";
        run.error = recordText(agentError.event.data) ?? "DeepSeek Harness reported an agent error.";
        run.finishedAt = new Date();
      } else if (run.cancelRequested && (summary === undefined || !summary.running)) {
        run.status = "cancelled";
        run.finishedAt = new Date();
      } else if (turnEnded && (summary === undefined || !summary.running)) {
        run.status = "succeeded";
        run.finishedAt = new Date();
      }
      if (run.status === "succeeded" && !run.sessionReused) {
        const choice = await this.connectionSetup.getChoice();
        if (choice?.autoArchiveSuccessfulRuns) {
          try {
            await this.rpc(service, "workspace/archiveSession", { request: { sessionId: run.sessionId } });
            run.sessionArchived = true;
          } catch (error) {
            run.archiveError = errorText(error);
          }
        }
      }
      if (run.status !== "running") this.releaseSession(run);
    } catch (error) {
      run.error = errorText(error);
    }
    return this.runSnapshot(run);
  }

  private async prefixSessionTitle(service: ServiceRecord, sessionId: string): Promise<void> {
    const deadline = Date.now() + TITLE_WAIT_MS;
    let fallback: string | undefined;
    let providerStarted = false;
    let turnEnded = false;
    while (service.status === "running" && Date.now() < deadline) {
      try {
        const list = await this.rpc<{ items: SessionSummary[] }>(service, "session/list", { _request: {} });
        const summary = list.items.find((item) => item.sessionId === sessionId);
        if (summary === undefined) return;
        const page = await this.rpc<{ records: HistoryEvent[] }>(service, "session/page", {
          request: { address: { kind: "session", sessionId }, throughSeq: summary.projections?.asOfSeq ?? -1, maxMessages: 50 },
        });
        for (const { event } of page.records) {
          if (event.type === "session/title-llm-request") providerStarted = true;
          if (event.type === "turn/end") turnEnded = true;
          if (event.type === "session/title" && typeof event.data === "object" && event.data !== null) {
            const { title, source } = event.data as { title?: unknown; source?: { kind?: string } };
            if (typeof title === "string" && source?.kind === "provider") {
              await this.rpc(service, "session/rename", { request: { sessionId, title: `${TITLE_PREFIX}${title}` } });
              return;
            }
            if (typeof title === "string" && source?.kind === "fallback") fallback = title;
          }
        }
        if (fallback !== undefined && turnEnded && !providerStarted) break;
      } catch {
        // 标题更新失败不应中断智能体任务；下一轮会重试。
      }
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 1_000));
    }
    if (fallback !== undefined && service.status === "running") {
      try {
        await this.rpc(service, "session/rename", { request: { sessionId, title: `${TITLE_PREFIX}${fallback}` } });
      } catch {
        // 重命名失败时保留 DSH 原标题。
      }
    }
  }

  private async rpc<T>(service: ServiceRecord, method: string, args: Record<string, unknown>): Promise<T> {
    if (service.apiUrl === null) throw new Error("Harness Web service has no URL.");
    const response = await fetch(`${service.apiUrl}/api/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(service.cookie === null ? {} : { cookie: service.cookie }),
      },
      body: JSON.stringify({ type: "client-request", rpcId: `mcp-${randomUUID()}`, method, payload: { args } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`${method} failed over HTTP ${String(response.status)}: ${await response.text()}`);
    const body = await response.json() as RpcEnvelope<T>;
    if (!body.result.ok) throw new Error(`${method} failed: ${body.result.error.code}: ${body.result.error.message}`);
    return body.result.value;
  }

  private async resolveWorkspace(input: string): Promise<string> {
    if (!isAbsolute(input)) throw new Error("workspace must be an absolute path.");
    const workspace = await realpath(input);
    if (!(await stat(workspace)).isDirectory()) throw new Error("workspace must point to a directory.");
    if (this.allowedRoots.length > 0) {
      const roots = await Promise.all(this.allowedRoots.map(async (root) => realpath(root)));
      if (!roots.some((root) => isWithin(root, workspace))) throw new Error("workspace is outside DSH_MCP_WORKSPACE_ROOTS.");
    }
    return workspace;
  }

  private serviceForWorkspace(workspace: string): ServiceRecord | undefined {
    const id = this.serviceByWorkspace.get(workspace);
    const service = id === undefined ? undefined : this.services.get(id);
    return service?.status === "running" && service.apiUrl !== null ? service : undefined;
  }

  private requireService(serviceId: string): ServiceRecord {
    const service = this.services.get(serviceId);
    if (service === undefined) throw new Error(`Unknown serviceId: ${serviceId}`);
    return service;
  }

  private requireRun(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (run === undefined) throw new Error(`Unknown runId: ${runId}`);
    return run;
  }

  private releaseSession(run: RunRecord): void {
    this.activeSessions.delete(`${run.serviceId}:${run.sessionId}`);
  }

  private async terminate(service: ServiceRecord): Promise<void> {
    const child = service.child;
    if (child === null) {
      service.status = "stopped";
      service.stoppedAt = new Date();
      this.serviceByWorkspace.delete(service.workspace);
      return;
    }
    if (child.exitCode !== null) return;
    const closed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
    if (process.platform !== "win32" && child.pid !== undefined) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    } else {
      child.kill("SIGTERM");
    }
    await Promise.race([closed, new Promise<void>((resolveWait) => setTimeout(resolveWait, CANCEL_GRACE_MS))]);
    if (child.exitCode === null) child.kill("SIGKILL");
    service.status = "stopped";
    service.stoppedAt = new Date();
    this.serviceByWorkspace.delete(service.workspace);
  }

  private serviceSnapshot(service: ServiceRecord): ServiceSnapshot {
    return {
      serviceId: service.serviceId,
      workspace: service.workspace,
      status: service.status,
      webUrl: service.webUrl,
      browserOpened: service.browserOpened,
      browserError: service.browserError,
      startedAt: service.startedAt.toISOString(),
      stoppedAt: service.stoppedAt?.toISOString() ?? null,
      processId: service.child?.pid ?? null,
      logTail: service.log.slice(-4_000),
    };
  }

  private runSnapshot(run: RunRecord): RunSnapshot {
    return {
      runId: run.runId,
      serviceId: run.serviceId,
      sessionId: run.sessionId,
      sessionReused: run.sessionReused,
      task: run.task,
      workspace: run.workspace,
      webUrl: run.webUrl,
      status: run.status,
      cancelRequested: run.cancelRequested,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      assistantText: run.assistantText,
      lastEventSeq: run.lastEventSeq,
      error: run.error,
      sessionArchived: run.sessionArchived,
      archiveError: run.archiveError,
    };
  }
}
