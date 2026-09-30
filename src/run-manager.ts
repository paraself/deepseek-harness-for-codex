import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, readlink, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";
import {
  buildHarnessWebCommand,
  authenticateExternalWebService,
  inspectRuntime,
  resolveAllowedRoots,
  resolveDataDirectory,
  resolveExternalWebService,
  type ExternalWebService,
  type HarnessCommand,
} from "./runtime.js";
import { ConnectionSetup, type SetupSnapshot } from "./setup.js";
import type { ApprovalRequest, RunSnapshot, RunStatus, ServiceSnapshot, ServiceStatus, StartRunInput, StartServiceInput, WriteBoundaryReport } from "./types.js";

const READY_PATTERN = /dsh web: (http:\/\/[^\s]+)/;
const STARTUP_TIMEOUT_MS = 120_000;
const CANCEL_GRACE_MS = 5_000;
const MAX_LOG_CHARACTERS = 100_000;
const TITLE_PREFIX = "[codex] ";
// ponytail: 最多等待两分钟；若标题模型的超时更长，再按实际配置延长。
const TITLE_WAIT_MS = 120_000;
const DEEP_DOCTOR_MARKER = "DSH_SANDBOX_READY";
const DEEP_DOCTOR_TASK = `DSH_MCP_SANDBOX_DIAGNOSTIC
Do not inspect or modify repository files. In the current workspace-write sandbox, use Python tempfile.TemporaryDirectory() with its default location. Inside it create a file, write a random string, read it back, verify it, and allow the context manager to delete the directory. Reply exactly ${DEEP_DOCTOR_MARKER} only after every operation succeeds. If any operation fails, report the original error and do not include the success marker.`;

interface ServiceRecord {
  serviceId: string;
  workspace: string;
  status: ServiceStatus;
  webUrl: string | null;
  browserUrl: string | null;
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
  webUrl: string | null;
  status: RunStatus;
  recovered: boolean;
  approval: ApprovalRequest | null;
  allowedWritePaths: string[] | null;
  writeBaseline: Record<string, string> | null;
  writeBoundary: WriteBoundaryReport | null;
  cancelRequested: boolean;
  startedAt: Date;
  finishedAt: Date | null;
  assistantText: string;
  lastEventSeq: number;
  error: string | null;
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

interface PersistedRun {
  schemaVersion: 1;
  runId: string;
  serviceId: string;
  sessionId: string;
  sessionReused: boolean;
  startEventSeq: number;
  workspace: string;
  status: RunStatus;
  cancelRequested: boolean;
  startedAt: string;
  finishedAt: string | null;
  lastEventSeq: number;
  ownerPid: number;
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

export interface DoctorInput {
  deep?: boolean | undefined;
  workspace?: string | undefined;
}

function defaultSpawnProcess(command: HarnessCommand): ChildProcess {
  return crossSpawn(command.command, command.args, {
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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

function pendingApproval(events: HistoryEvent[]): ApprovalRequest | null {
  const pending = new Map<string, ApprovalRequest>();
  for (const { event } of events) {
    if (event.type === "approval/asked" && typeof event.data === "object" && event.data !== null) {
      const data = event.data as Record<string, unknown>;
      if (typeof data.id === "string" && typeof data.toolName === "string") {
        pending.set(data.id, {
          id: data.id,
          toolName: data.toolName,
          reason: typeof data.reason === "string" ? data.reason : null,
        });
      }
    } else if (event.type === "approval/decided" && typeof event.data === "object" && event.data !== null) {
      const id = (event.data as Record<string, unknown>).id;
      if (typeof id === "string") pending.delete(id);
    }
  }
  return [...pending.values()].at(-1) ?? null;
}

function lastTurnEnd(events: HistoryEvent[]): { kind: string; details: unknown } | null {
  const ended = [...events].reverse().find(({ event }) => event.type === "turn/end");
  if (ended === undefined || typeof ended.event.data !== "object" || ended.event.data === null) return null;
  const reason = (ended.event.data as Record<string, unknown>).reason;
  if (typeof reason === "string") {
    if (reason === "stop") return { kind: "completed", details: reason };
    if (reason === "cancelled") return { kind: "aborted", details: reason };
    return { kind: reason, details: reason };
  }
  if (typeof reason === "object" && reason !== null && typeof (reason as Record<string, unknown>).kind === "string") {
    return { kind: (reason as Record<string, unknown>).kind as string, details: reason };
  }
  return { kind: "unknown", details: reason };
}

function runRevision(run: RunRecord): string {
  return JSON.stringify([
    run.status,
    run.cancelRequested,
    run.finishedAt?.toISOString() ?? null,
    run.assistantText,
    run.lastEventSeq,
    run.error,
    run.approval,
    run.writeBoundary,
  ]);
}

function redactServiceLog(value: string): string {
  return value
    .replace(/([?&]token=)[^&#\s"']+/giu, "$1<redacted>")
    .replace(/((?:set-)?cookie\s*:\s*)[^\r\n]+/giu, "$1<redacted>");
}

function hasSandboxToolEvidence(events: HistoryEvent[]): boolean {
  const calls = new Set<string>();
  for (const { event } of events) {
    if (event.type !== "tool/call" || typeof event.data !== "object" || event.data === null) continue;
    const data = event.data as Record<string, unknown>;
    if (typeof data.callId === "string" && typeof data.arguments === "string" && data.arguments.includes("TemporaryDirectory")) {
      calls.add(data.callId);
    }
  }
  return events.some(({ event }) => {
    if (event.type !== "tool/result" || typeof event.data !== "object" || event.data === null) return false;
    const data = event.data as Record<string, unknown>;
    if (data.error !== undefined || typeof data.message !== "object" || data.message === null) return false;
    const content = (data.message as Record<string, unknown>).content;
    if (!Array.isArray(content)) return false;
    return content.some((block) => {
      if (typeof block !== "object" || block === null) return false;
      const result = block as Record<string, unknown>;
      return result.type === "tool-result" && result.isError !== true && typeof result.toolCallId === "string" && calls.has(result.toolCallId);
    });
  });
}

function normalizeWritePaths(paths: string[]): string[] {
  return [...new Set(paths.map((value) => {
    const candidate = value.trim().replaceAll("\\", "/");
    if (candidate === "." || /^\.\/+$/u.test(candidate)) return ".";
    const segments = candidate.split("/").filter((segment) => segment !== "" && segment !== ".");
    if (!candidate || isAbsolute(candidate) || /^[A-Za-z]:/u.test(candidate) || segments.includes("..")) {
      throw new Error(`allowedWritePaths must contain workspace-relative paths without '..': ${value}`);
    }
    return segments.join("/");
  }))];
}

function pathAllowed(path: string, allowed: string[]): boolean {
  const comparablePath = process.platform === "win32" ? path.toLowerCase() : path;
  return allowed.some((prefix) => {
    if (prefix === ".") return true;
    const comparablePrefix = process.platform === "win32" ? prefix.toLowerCase() : prefix;
    return comparablePath === comparablePrefix || comparablePath.startsWith(`${comparablePrefix}/`);
  });
}

async function runGit(workspace: string, args: string[]): Promise<string> {
  return new Promise<string>((resolveOutput, reject) => {
    const child = crossSpawn("git", ["-C", workspace, ...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolveOutput(stdout);
      else reject(new Error(`git ${args[0] ?? "command"} failed: ${stderr.trim() || `exit ${String(code)}`}`));
    });
  });
}

async function pathFingerprint(workspace: string, path: string): Promise<string> {
  const absolute = join(workspace, ...path.split("/"));
  try {
    const metadata = await lstat(absolute);
    const indexEntry = await runGit(workspace, ["ls-files", "-s", "--", path]);
    const hash = createHash("sha256").update(`${String(metadata.mode)}\0${indexEntry}\0`);
    if (metadata.isSymbolicLink()) return hash.update(`symlink\0${await readlink(absolute)}`).digest("hex");
    if (metadata.isDirectory()) return hash.update("directory").digest("hex");
    return hash.update(await readFile(absolute)).digest("hex");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      const indexEntry = await runGit(workspace, ["ls-files", "-s", "--", path]);
      return `<missing>\0${indexEntry}`;
    }
    throw error;
  }
}

async function captureGitChanges(workspace: string): Promise<Record<string, string>> {
  const topLevel = (await runGit(workspace, ["rev-parse", "--show-toplevel"])).trim();
  if (await realpath(topLevel) !== workspace) {
    throw new Error("allowedWritePaths currently requires workspace to be the Git repository root.");
  }
  const listing = await runGit(workspace, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const snapshot: Record<string, string> = {};
  for (const path of listing.split("\0").filter(Boolean)) {
    const normalized = path.replaceAll("\\", "/");
    snapshot[normalized] = await pathFingerprint(workspace, normalized);
  }
  return snapshot;
}

async function validateWritePath(workspace: string, path: string): Promise<void> {
  let ancestor = resolve(workspace, ...path.split("/"));
  while (true) {
    try {
      const existing = await realpath(ancestor);
      if (!isWithin(workspace, existing)) throw new Error(`allowedWritePaths escapes the workspace through a symbolic link: ${path}`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

/** Owns visible local Harness Web services and tasks submitted into their sessions. */
export class RunManager {
  private readonly services = new Map<string, ServiceRecord>();
  private readonly serviceByWorkspace = new Map<string, string>();
  private readonly starts = new Map<string, Promise<ServiceRecord>>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly ownedRunIds = new Set<string>();
  private readonly activeSessions = new Set<string>();
  private readonly dataDirectory: string;
  private readonly allowedRoots: string[];
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly connectionSetup: ConnectionSetup;
  private readonly commandFactory: NonNullable<RunManagerOptions["commandFactory"]>;
  private readonly spawnProcess: NonNullable<RunManagerOptions["spawnProcess"]>;
  private readonly openBrowserImpl: NonNullable<RunManagerOptions["openBrowser"]>;
  private stateLoaded = false;
  private stateLoad: Promise<void> | null = null;
  private stateWrite: Promise<void> = Promise.resolve();

  public constructor(options: RunManagerOptions = {}) {
    this.dataDirectory = resolve(options.dataDirectory ?? resolveDataDirectory());
    const configuredRoots = options.allowedRoots ?? resolveAllowedRoots();
    const relativeRoot = configuredRoots.find((root) => !isAbsolute(root));
    if (relativeRoot !== undefined) throw new Error(`Workspace root must be absolute: ${relativeRoot}`);
    this.allowedRoots = configuredRoots.map((root) => resolve(root));
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
        await this.openBrowserImpl(service.browserUrl ?? service.webUrl);
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
    await this.openBrowserImpl(service.browserUrl ?? service.webUrl);
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
        if (run.serviceId === serviceId && (run.status === "running" || run.status === "needs_approval")) await this.cancel(run.runId);
      }
      await this.terminate(service);
    }
    return this.serviceSnapshot(service);
  }

  /** Starts or continues a Web session and submits the task through Harness RPC. */
  public async start(input: StartRunInput): Promise<RunSnapshot> {
    await this.ensureStateLoaded();
    const task = input.task.trim();
    if (!task) throw new Error("task must not be empty.");
    if (task.length > 100_000) throw new Error("task exceeds the 100,000 character limit.");
    const workspace = await this.resolveWorkspace(input.workspace);
    const allowedWritePaths = input.allowedWritePaths === undefined ? null : normalizeWritePaths(input.allowedWritePaths);
    if (allowedWritePaths !== null) {
      if (allowedWritePaths.length === 0) throw new Error("allowedWritePaths must not be empty when provided.");
      await Promise.all(allowedWritePaths.map(async (path) => validateWritePath(workspace, path)));
    }
    const writeBaseline = allowedWritePaths === null ? null : await captureGitChanges(workspace);
    const serviceSnapshot = await this.startService({ workspace, openBrowser: false });
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
      recovered: false,
      approval: null,
      allowedWritePaths,
      writeBaseline,
      writeBoundary: null,
      cancelRequested: false,
      startedAt: new Date(),
      finishedAt: null,
      assistantText: "",
      lastEventSeq: startEventSeq,
      error: null,
    };
    this.runs.set(run.runId, run);
    this.ownedRunIds.add(run.runId);
    try {
      await this.persistRun(run);
    } catch (error) {
      this.runs.delete(run.runId);
      this.ownedRunIds.delete(run.runId);
      this.activeSessions.delete(activeSessionKey);
      throw error;
    }
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
      run.status = "failed";
      run.error = `Harness rejected the task before it started: ${errorText(error)}`;
      run.finishedAt = new Date();
      this.releaseSession(run);
      await this.persistRun(run);
      throw error;
    }
    if (input.openBrowser ?? false) {
      try {
        await this.openService(service.serviceId);
      } catch (error) {
        service.browserError = errorText(error);
      }
    }
    if (!run.sessionReused) void this.prefixSessionTitle(service, sessionId);
    return this.refresh(run);
  }

  /** Lists runs and refreshes their observable Web session state. */
  public async list(): Promise<RunSnapshot[]> {
    await this.ensureStateLoaded();
    return Promise.all([...this.runs.values()].map(async (run) => this.refresh(run)));
  }

  /** Reads a run from the same Web session shown to the user. */
  public async get(runId: string): Promise<RunSnapshot> {
    await this.ensureStateLoaded();
    return this.refresh(this.requireRun(runId));
  }

  /** Polls the Web session for up to 30 seconds. */
  public async wait(runId: string, timeoutMs: number): Promise<RunSnapshot> {
    await this.ensureStateLoaded();
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
    await this.ensureStateLoaded();
    const run = this.requireRun(runId);
    if (run.recovered && !this.ownedRunIds.has(run.runId) && (run.status === "running" || run.status === "needs_approval")) {
      throw new Error("Run is owned by another active MCP process and cannot be cancelled here.");
    }
    if (run.status === "running" || run.status === "needs_approval") {
      run.cancelRequested = true;
      const service = this.requireService(run.serviceId);
      await this.rpc<{ accepted: true }>(service, "session/cancel", { request: { sessionId: run.sessionId } });
    }
    return this.refresh(run);
  }

  /** Stops all Web services before the MCP server exits. */
  public async close(): Promise<void> {
    await this.connectionSetup.close();
    await this.ensureStateLoaded();
    for (const run of this.runs.values()) {
      if (!this.ownedRunIds.has(run.runId) || (run.status !== "running" && run.status !== "needs_approval")) continue;
      run.status = "failed";
      run.error = "MCP closed before completion could be confirmed.";
      run.finishedAt = new Date();
      this.releaseSession(run);
      await this.auditWriteBoundary(run);
      await this.persistRun(run);
    }
    await Promise.all([...this.services.values()].map(async (service) => {
      if (service.status === "running" || service.status === "starting") await this.terminate(service);
    }));
  }

  /** Checks local prerequisites, optionally including a real Harness sandbox turn. */
  public async doctor(input: DoctorInput = {}): Promise<Record<string, unknown>> {
    const configuredExternalUrl = await this.configuredExternalUrl();
    const quick = inspectRuntime(configuredExternalUrl === undefined
      ? process.env
      : { ...process.env, DSH_MCP_WEB_URL: configuredExternalUrl });
    if (input.deep !== true) return quick;
    const warnings = [...(quick.warnings as Array<{ code: string; message: string }>)];
    if (!input.workspace) {
      warnings.push({ code: "deep_workspace_required", message: "doctor deep mode requires an absolute workspace path." });
      return {
        ...quick,
        mode: "deep",
        ready: false,
        credentialReady: null,
        serviceReady: false,
        sandboxReady: false,
        warnings,
      };
    }

    let serviceId: string | null = null;
    let stopLaunchedService = false;
    let credentialReady: boolean | null = null;
    let serviceReady = false;
    let sandboxReady = false;
    let diagnosticRunId: string | null = null;
    let diagnosticSessionId: string | null = null;
    let diagnosticRunStatus: RunStatus | null = null;
    let diagnosticToolEvidence = false;
    try {
      const existingIds = new Set(this.listServices().map((service) => service.serviceId));
      const service = await this.startService({ workspace: input.workspace, openBrowser: false });
      serviceId = service.serviceId;
      serviceReady = true;
      const serviceRecord = this.requireService(service.serviceId);
      stopLaunchedService = !existingIds.has(service.serviceId) && serviceRecord.child !== null;
      const started = await this.start({ task: DEEP_DOCTOR_TASK, workspace: input.workspace, openBrowser: false });
      diagnosticRunId = started.runId;
      diagnosticSessionId = started.sessionId;
      const completed = await this.wait(started.runId, 30_000);
      diagnosticRunStatus = completed.status;
      if (completed.status === "succeeded") {
        credentialReady = true;
        diagnosticToolEvidence = hasSandboxToolEvidence(await this.readRunEvents(this.requireRun(started.runId)));
        sandboxReady = completed.assistantText.trim() === DEEP_DOCTOR_MARKER && diagnosticToolEvidence;
        if (!sandboxReady) {
          warnings.push({
            code: "sandbox_diagnostic_unconfirmed",
            message: "Harness completed the diagnostic turn without both the exact success marker and a successful TemporaryDirectory tool-call record.",
          });
        }
      } else {
        const details = completed.error ?? completed.assistantText;
        credentialReady = completed.status === "needs_approval" || completed.status === "blocked"
          ? true
          : /(?:api[ -]?key|credential|unauthorized|\b401\b|\b403\b)/iu.test(details) ? false : null;
        warnings.push({
          code: completed.status === "needs_approval" ? "sandbox_diagnostic_needs_approval" : "sandbox_diagnostic_failed",
          message: details || `Harness diagnostic ended with status ${completed.status}.`,
        });
      }
    } catch (error) {
      const message = errorText(error);
      credentialReady = /(?:api[ -]?key|credential|unauthorized|\b401\b|\b403\b)/iu.test(message) ? false : null;
      warnings.push({ code: "deep_diagnostic_failed", message });
    } finally {
      if (diagnosticRunId !== null) {
        const diagnostic = this.runs.get(diagnosticRunId);
        if (diagnostic !== undefined && (diagnostic.status === "running" || diagnostic.status === "needs_approval")) {
          try {
            let cleanup = await this.cancel(diagnosticRunId);
            const cleanupDeadline = Date.now() + 5_000;
            while ((cleanup.status === "running" || cleanup.status === "needs_approval") && Date.now() < cleanupDeadline) {
              await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, Math.min(this.pollIntervalMs, 250)));
              cleanup = await this.refresh(diagnostic);
            }
            diagnosticRunStatus = cleanup.status;
            if (cleanup.status === "running" || cleanup.status === "needs_approval") {
              warnings.push({
                code: "sandbox_diagnostic_cleanup_unconfirmed",
                message: "Harness accepted diagnostic cancellation, but the session still appeared active after 5 seconds.",
              });
            }
          } catch (error) {
            warnings.push({ code: "sandbox_diagnostic_cleanup_failed", message: errorText(error) });
          }
        }
      }
      if (stopLaunchedService && serviceId !== null) {
        try { await this.stopService(serviceId); } catch { /* Preserve the diagnostic result. */ }
      }
    }
    const runtimeReady = quick.runtimeReady === true;
    return {
      ...quick,
      mode: "deep",
      ready: runtimeReady && credentialReady === true && serviceReady && sandboxReady,
      runtimeReady,
      credentialReady,
      serviceReady,
      sandboxReady,
      diagnosticRunId,
      diagnosticSessionId,
      diagnosticRunStatus,
      diagnosticToolEvidence,
      warnings,
    };
  }

  private async attachService(workspace: string, external: ExternalWebService, sourceUrl: string): Promise<ServiceRecord> {
    const cookie = await authenticateExternalWebService(external);

    const service: ServiceRecord = {
      serviceId: randomUUID(),
      workspace,
      status: "running",
      webUrl: external.webUrl,
      browserUrl: sourceUrl,
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
      browserUrl: null,
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
    let startupLog = "";
    const ready = new Promise<string>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error(`Harness Web service did not become ready within ${String(this.startupTimeoutMs)}ms.`)), this.startupTimeoutMs);
      const onChunk = (chunk: string): void => {
        startupLog = `${startupLog}${chunk}`.slice(-MAX_LOG_CHARACTERS);
        service.log = redactServiceLog(startupLog);
        const url = READY_PATTERN.exec(startupLog)?.[1];
        if (url !== undefined && service.status === "starting") {
          clearTimeout(timer);
          resolveReady(url);
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
      const readyUrl = await ready;
      const external = resolveExternalWebService({ DSH_MCP_WEB_URL: readyUrl });
      if (external === undefined) throw new Error("Harness Web service did not provide a usable loopback URL.");
      service.cookie = await authenticateExternalWebService(external);
      service.webUrl = external.webUrl;
      service.browserUrl = readyUrl;
      service.apiUrl = external.webUrl;
      service.status = "running";
      return service;
    } catch (error) {
      this.serviceByWorkspace.delete(workspace);
      if (child.exitCode === null) await this.terminate(service);
      service.status = "failed";
      throw error;
    }
  }

  private async refresh(run: RunRecord): Promise<RunSnapshot> {
    if (run.status !== "running" && run.status !== "needs_approval") return this.runSnapshot(run);
    if (run.recovered && !this.ownedRunIds.has(run.runId)) return this.runSnapshot(run);
    const previousRevision = runRevision(run);
    const service = this.requireService(run.serviceId);
    if (service.status !== "running") {
      run.status = "failed";
      run.error = "Harness Web service stopped before the task completed.";
      run.finishedAt = new Date();
      this.releaseSession(run);
      await this.auditWriteBoundary(run);
      await this.persistRun(run);
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
      const turnEnd = lastTurnEnd(events);
      run.approval = pendingApproval(events);
      if (agentError !== undefined) {
        run.status = "failed";
        run.error = recordText(agentError.event.data) ?? "DeepSeek Harness reported an agent error.";
        run.finishedAt = new Date();
      } else if (run.cancelRequested && (summary === undefined || !summary.running)) {
        run.status = "cancelled";
        run.finishedAt = new Date();
      } else if (turnEnd !== null && !summary.running) {
        if (turnEnd.kind === "completed") {
          run.status = "succeeded";
        } else if (turnEnd.kind === "blocked") {
          run.status = "blocked";
          run.error = recordText(turnEnd.details) ?? "DeepSeek Harness ended the turn as blocked.";
        } else if (turnEnd.kind === "aborted" && run.cancelRequested) {
          run.status = "cancelled";
        } else {
          run.status = "failed";
          run.error = recordText(turnEnd.details) ?? `DeepSeek Harness ended the turn with reason ${turnEnd.kind}.`;
        }
        run.finishedAt = new Date();
      } else if (run.approval !== null) {
        run.status = "needs_approval";
      } else {
        run.status = "running";
      }
      if (run.status !== "running" && run.status !== "needs_approval") {
        this.releaseSession(run);
        await this.auditWriteBoundary(run);
      }
    } catch (error) {
      run.error = errorText(error);
    }
    if (runRevision(run) !== previousRevision) await this.persistRun(run);
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

  private async readRunEvents(run: RunRecord): Promise<HistoryEvent[]> {
    const service = this.requireService(run.serviceId);
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
    return page.records.filter((entry) => entry.event.seq > run.startEventSeq);
  }

  private async rpc<T>(service: ServiceRecord, method: string, args: Record<string, unknown>): Promise<T> {
    if (service.apiUrl === null) throw new Error("Harness Web service has no API URL.");
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

  private async ensureStateLoaded(): Promise<void> {
    if (this.stateLoaded) return;
    this.stateLoad ??= this.loadState();
    await this.stateLoad;
  }

  private async loadState(): Promise<void> {
    try {
      const directory = join(this.dataDirectory, "runs-v1");
      const entries = await readdir(directory, { withFileTypes: true });
      const validStatuses: RunStatus[] = ["running", "needs_approval", "blocked", "succeeded", "failed", "cancelled"];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        let item: Partial<PersistedRun>;
        try {
          item = JSON.parse(await readFile(join(directory, entry.name), "utf8")) as Partial<PersistedRun>;
        } catch {
          continue;
        }
        if (
          item.schemaVersion !== 1
          || typeof item.runId !== "string"
          || typeof item.serviceId !== "string"
          || typeof item.sessionId !== "string"
          || typeof item.workspace !== "string"
          || typeof item.status !== "string"
          || !validStatuses.includes(item.status as RunStatus)
          || typeof item.startedAt !== "string"
        ) continue;
        const startedAt = new Date(item.startedAt);
        const persistedFinishedAt = item.finishedAt === null || item.finishedAt === undefined ? null : new Date(item.finishedAt);
        if (Number.isNaN(startedAt.getTime()) || (persistedFinishedAt !== null && Number.isNaN(persistedFinishedAt.getTime()))) continue;
        let workspace: string;
        try {
          workspace = await this.resolveWorkspace(item.workspace);
        } catch {
          continue;
        }
        const interrupted = item.status === "running" || item.status === "needs_approval";
        const ownerActive = interrupted
          && typeof item.ownerPid === "number"
          && Number.isSafeInteger(item.ownerPid)
          && item.ownerPid > 0
          && processIsAlive(item.ownerPid);
        const abandoned = interrupted && !ownerActive;
        const finishedAt = abandoned
          ? new Date()
          : persistedFinishedAt;
        this.runs.set(item.runId, {
          runId: item.runId,
          serviceId: item.serviceId,
          sessionId: item.sessionId,
          sessionReused: item.sessionReused === true,
          startEventSeq: typeof item.startEventSeq === "number" ? item.startEventSeq : -1,
          task: "[task text was not persisted]",
          workspace,
          webUrl: null,
          status: abandoned ? "failed" : item.status as RunStatus,
          recovered: true,
          approval: null,
          allowedWritePaths: null,
          writeBaseline: null,
          writeBoundary: null,
          cancelRequested: item.cancelRequested === true,
          startedAt,
          finishedAt,
          assistantText: "",
          lastEventSeq: typeof item.lastEventSeq === "number" ? item.lastEventSeq : -1,
          error: abandoned
            ? "MCP restarted before completion could be confirmed."
            : null,
        });
        if (abandoned) this.ownedRunIds.add(item.runId);
      }
      for (const run of this.runs.values()) {
        if (this.ownedRunIds.has(run.runId)) await this.persistRun(run);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // A corrupt or unsupported state file must not prevent the MCP server from starting.
      }
    } finally {
      this.stateLoaded = true;
    }
  }

  private async persistRun(run: RunRecord): Promise<void> {
    if (!this.ownedRunIds.has(run.runId)) return;
    const state: PersistedRun = {
      schemaVersion: 1,
      runId: run.runId,
      serviceId: run.serviceId,
      sessionId: run.sessionId,
      sessionReused: run.sessionReused,
      startEventSeq: run.startEventSeq,
      workspace: run.workspace,
      status: run.status,
      cancelRequested: run.cancelRequested,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      lastEventSeq: run.lastEventSeq,
      ownerPid: process.pid,
    };
    const action = async (): Promise<void> => {
      const directory = join(this.dataDirectory, "runs-v1");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const filename = `${createHash("sha256").update(run.runId).digest("hex")}.json`;
      const target = join(directory, filename);
      const temporary = `${target}.${String(process.pid)}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      try { await chmod(temporary, 0o600); } catch { /* Windows ACLs do not map directly to POSIX modes. */ }
      await rename(temporary, target);
    };
    this.stateWrite = this.stateWrite.then(action, action);
    await this.stateWrite;
  }

  private async auditWriteBoundary(run: RunRecord): Promise<void> {
    if (run.allowedWritePaths === null || run.writeBoundary !== null) return;
    const limitations = [
      "Reports Git-visible tracked and untracked paths only; ignored files are not inspected.",
      "This is a post-run audit and does not prevent writes while the run is active.",
    ];
    if (run.writeBaseline === null) {
      run.writeBoundary = {
        checked: false,
        violations: [],
        error: "The MCP process restarted before the write-boundary audit completed.",
        limitations,
      };
      return;
    }
    try {
      const current = await captureGitChanges(run.workspace);
      const paths = new Set([...Object.keys(run.writeBaseline), ...Object.keys(current)]);
      const violations: string[] = [];
      for (const path of paths) {
        const before = run.writeBaseline[path];
        const after = current[path] ?? await pathFingerprint(run.workspace, path);
        if (before !== after && !pathAllowed(path, run.allowedWritePaths)) violations.push(path);
      }
      run.writeBoundary = {
        checked: true,
        violations: violations.sort(),
        error: null,
        limitations,
      };
    } catch (error) {
      run.writeBoundary = {
        checked: false,
        violations: [],
        error: errorText(error),
        limitations,
      };
    }
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
      recovered: run.recovered,
      approval: run.approval,
      writeBoundary: run.writeBoundary,
      cancelRequested: run.cancelRequested,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      assistantText: run.assistantText,
      lastEventSeq: run.lastEventSeq,
      error: run.error,
    };
  }
}
