import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export const DEFAULT_HARNESS_PACKAGE = "@deepseek-ai/dsh@0.1.5-rc.2";

/** A shell-free command specification for one local Harness process. */
export interface HarnessCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Values required to construct a local Harness Web command. */
export interface HarnessWebCommandInput {
  workspace: string;
  serviceHome: string;
}

/** Existing Harness Web endpoint and its optional one-time browser authentication URL. */
export interface ExternalWebService {
  webUrl: string;
  authenticationUrl: string | null;
}

/** Resolves the persistent data directory used for local Web service state. */
export function resolveDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_MCP_DATA_DIR?.trim() || env.PLUGIN_DATA?.trim();
  return configured || join(homedir(), ".deep-seek-harness-mcp");
}

/** Resolves optional workspace roots that the MCP server may modify. */
export function resolveAllowedRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.DSH_MCP_WORKSPACE_ROOTS ?? "")
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Resolves an optional existing loopback Harness Web service. */
export function resolveExternalWebService(env: NodeJS.ProcessEnv = process.env): ExternalWebService | undefined {
  const configured = env.DSH_MCP_WEB_URL?.trim();
  if (!configured) return undefined;

  const url = new URL(configured);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("DSH_MCP_WEB_URL must use http or https.");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("DSH_MCP_WEB_URL must point to a loopback host.");
  }
  if (url.username || url.password || url.hash) {
    throw new Error("DSH_MCP_WEB_URL must not include credentials or a fragment.");
  }
  const tokens = url.searchParams.getAll("token");
  if ([...url.searchParams.keys()].some((key) => key !== "token") || tokens.length > 1 || tokens[0] === "") {
    throw new Error("DSH_MCP_WEB_URL may only include one non-empty token query parameter.");
  }
  const authenticationUrl = tokens.length === 1 ? url.href : null;
  url.search = "";
  return { webUrl: url.toString().replace(/\/$/, ""), authenticationUrl };
}

/** Builds the argv and environment for the published Harness Web UI. */
export function buildHarnessWebCommand(
  input: HarnessWebCommandInput,
  env: NodeJS.ProcessEnv = process.env,
): HarnessCommand {
  const command = env.DSH_MCP_NPX_COMMAND?.trim() || (process.platform === "win32" ? "npx.cmd" : "npx");
  const harnessPackage = env.DSH_MCP_HARNESS_PACKAGE?.trim() || DEFAULT_HARNESS_PACKAGE;
  if (harnessPackage.startsWith("-")) {
    throw new Error("DSH_MCP_HARNESS_PACKAGE must be an npm package specifier, not an option.");
  }

  return {
    command,
    args: ["--yes", `--package=${harnessPackage}`, "--", "dsh", "web", "--port", "0"],
    cwd: input.workspace,
    env: {
      ...env,
      DSH_CWD: input.workspace,
      DSH_HOME: input.serviceHome,
      DSH_PERMISSION_MODE: env.DSH_PERMISSION_MODE?.trim() || "workspace-write",
      DSH_TELEMETRY_DISABLED: env.DSH_TELEMETRY_DISABLED?.trim() || "1",
      NO_COLOR: "1",
      npm_config_yes: "true",
    },
  };
}

/** Returns local prerequisites without making a network request. */
export function inspectRuntime(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const externalWebService = resolveExternalWebService(env);
  const command = env.DSH_MCP_NPX_COMMAND?.trim() || (process.platform === "win32" ? "npx.cmd" : "npx");
  const probe = externalWebService === undefined
    ? spawnSync(command, ["--version"], { encoding: "utf8", shell: false, timeout: 5_000 })
    : null;
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);

  return {
    ready: nodeMajor >= 22 && (externalWebService !== undefined || probe?.status === 0),
    nodeVersion: process.versions.node,
    nodeSupported: nodeMajor >= 22,
    platform: process.platform,
    architecture: process.arch,
    externalWebUrl: externalWebService?.webUrl ?? null,
    externalWebAuthenticationConfigured: Boolean(externalWebService?.authenticationUrl),
    npxRequired: externalWebService === undefined,
    npxCommand: command,
    npxAvailable: probe === null ? null : probe.status === 0,
    npxVersion: probe?.status === 0 ? probe.stdout.trim() : null,
    harnessPackage: env.DSH_MCP_HARNESS_PACKAGE?.trim() || DEFAULT_HARNESS_PACKAGE,
    apiKeyInEnvironment: Boolean(env.DEEPSEEK_API_KEY?.trim()),
    dataDirectory: resolveDataDirectory(env),
    allowedWorkspaceRoots: resolveAllowedRoots(env),
    surface: "web",
  };
}
