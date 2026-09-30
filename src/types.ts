/** Lifecycle state for one task submitted through the Harness Web service. */
export type RunStatus = "running" | "needs_approval" | "blocked" | "succeeded" | "failed" | "cancelled";

/** Structured user approval request reported by DeepSeek Harness. */
export interface ApprovalRequest {
  id: string;
  toolName: string;
  reason: string | null;
}

/** Advisory Git-based report for caller-supplied write paths. */
export interface WriteBoundaryReport {
  checked: boolean;
  violations: string[];
  error: string | null;
  limitations: string[];
}

/** Lifecycle state for a local Harness Web service. */
export type ServiceStatus = "starting" | "running" | "stopped" | "failed";

/** Public state of one local Harness Web service. */
export interface ServiceSnapshot {
  serviceId: string;
  workspace: string;
  status: ServiceStatus;
  webUrl: string | null;
  browserOpened: boolean;
  browserError: string | null;
  startedAt: string;
  stoppedAt: string | null;
  processId: number | null;
  logTail: string;
}

/** Public state returned to MCP clients for one visible Web session task. */
export interface RunSnapshot {
  runId: string;
  serviceId: string;
  sessionId: string;
  sessionReused: boolean;
  task: string;
  workspace: string;
  webUrl: string | null;
  status: RunStatus;
  recovered: boolean;
  approval: ApprovalRequest | null;
  writeBoundary: WriteBoundaryReport | null;
  cancelRequested: boolean;
  startedAt: string;
  finishedAt: string | null;
  assistantText: string;
  lastEventSeq: number;
  error: string | null;
}

/** Inputs needed to start a visible Harness task. */
export interface StartRunInput {
  task: string;
  workspace: string;
  sessionId?: string | undefined;
  openBrowser?: boolean | undefined;
  allowedWritePaths?: string[] | undefined;
}

/** Inputs needed to start or reuse a local Harness Web service. */
export interface StartServiceInput {
  workspace: string;
  openBrowser?: boolean | undefined;
}
