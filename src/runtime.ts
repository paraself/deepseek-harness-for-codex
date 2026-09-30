import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import spawn from "cross-spawn";

export const DEFAULT_HARNESS_PACKAGE = "@deepseek-ai/dsh@0.1.7-rc.2";

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

/** Resolves the npx command without enabling Node's shell mode. */
function resolveNpxCommand(env: NodeJS.ProcessEnv): string {
  const command = env.DSH_MCP_NPX_COMMAND?.trim() || "npx";
  if (/[\r\n]/u.test(command)) {
    throw new Error("DSH_MCP_NPX_COMMAND must not contain line breaks.");
  }
  return command;
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

/** Verifies an existing Web service and returns its session cookie without exposing the token. */
export async function authenticateExternalWebService(external: ExternalWebService): Promise<string | null> {
  let cookie: string | null = null;
  if (external.authenticationUrl !== null) {
    let authentication: Response;
    try {
      authentication = await fetch(external.authenticationUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error("Could not authenticate with the existing Harness Web service.");
    }
    cookie = authentication.headers.get("set-cookie")?.split(";", 1)[0]?.trim() || null;
    await authentication.body?.cancel();
    if (authentication.status !== 303 || cookie === null) {
      throw new Error("The existing Harness Web authentication URL was rejected.");
    }
  }

  let response: Response;
  try {
    response = await fetch(external.webUrl, {
      ...(cookie === null ? {} : { headers: { cookie } }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Could not connect to the existing Harness Web service.");
  }
  await response.body?.cancel();
  if (response.status === 401) {
    throw new Error("Existing Harness Web requires the full authentication URL printed by dsh web.");
  }
  if (!response.ok) throw new Error(`Existing Harness Web service returned HTTP ${String(response.status)}.`);
  return cookie;
}

/** Builds the argv and environment for the published Harness Web UI. */
export function buildHarnessWebCommand(
  input: HarnessWebCommandInput,
  env: NodeJS.ProcessEnv = process.env,
): HarnessCommand {
  const command = resolveNpxCommand(env);
  const harnessPackage = env.DSH_MCP_HARNESS_PACKAGE?.trim() || DEFAULT_HARNESS_PACKAGE;
  if (harnessPackage.startsWith("-")) {
    throw new Error("DSH_MCP_HARNESS_PACKAGE must be an npm package specifier, not an option.");
  }
  if (/[\r\n]/u.test(harnessPackage)) {
    throw new Error("DSH_MCP_HARNESS_PACKAGE must not contain line breaks.");
  }

  return {
    command,
    args: ["--yes", `--package=${harnessPackage}`, "--", "dsh", "web", "--port", "0", "--no-open"],
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
  const warnings: Array<{ code: string; message: string }> = [];
  let externalWebService: ExternalWebService | undefined;
  let externalWebServiceValid = true;
  try {
    externalWebService = resolveExternalWebService(env);
  } catch (error) {
    externalWebServiceValid = false;
    warnings.push({
      code: "external_web_url_invalid",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const command = resolveNpxCommand(env);
  const probe = externalWebService === undefined
    ? spawn.sync(command, ["--version"], { encoding: "utf8", shell: false, timeout: 5_000 })
    : null;
  const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
  const nodeSupported = (nodeMajor === 22 && nodeMinor >= 19) || nodeMajor >= 24;
  const allowedWorkspaceRoots = resolveAllowedRoots(env);
  const relativeRoots = allowedWorkspaceRoots.filter((root) => !isAbsolute(root));
  if (allowedWorkspaceRoots.length === 0) {
    warnings.push({
      code: "workspace_roots_unrestricted",
      message: "DSH_MCP_WORKSPACE_ROOTS is empty; any absolute workspace path is allowed.",
    });
  }
  for (const root of relativeRoots) {
    warnings.push({
      code: "workspace_root_not_absolute",
      message: `Workspace root must be absolute: ${root}`,
    });
  }
  const harnessPackage = env.DSH_MCP_HARNESS_PACKAGE?.trim() || DEFAULT_HARNESS_PACKAGE;
  const windowsSandboxRiskPackages = new Set([
    "@deepseek-ai/dsh@0.1.5-rc.2",
    "@deepseek-ai/dsh@0.1.7-rc.2",
    "@deepseek-ai/dsh@0.2.0-rc.1",
  ]);
  if (process.platform === "win32" && windowsSandboxRiskPackages.has(harnessPackage)) {
    warnings.push({
      code: "known_windows_sandbox_risk",
      message: `${harnessPackage} has reproduced a Windows workspace-write ACL initialization failure on some hosts; use doctor deep mode to verify this workspace.`,
    });
  }
  const runtimeReady = nodeSupported
    && externalWebServiceValid
    && relativeRoots.length === 0
    && (externalWebService !== undefined || probe?.status === 0);

  return {
    mode: "quick",
    ready: runtimeReady,
    runtimeReady,
    credentialReady: null,
    serviceReady: null,
    sandboxReady: null,
    warnings,
    nodeVersion: process.versions.node,
    nodeSupported,
    nodeRequirement: "^22.19.0 || >=24.0.0",
    platform: process.platform,
    architecture: process.arch,
    externalWebUrl: externalWebService?.webUrl ?? null,
    externalWebAuthenticationConfigured: Boolean(externalWebService?.authenticationUrl),
    npxRequired: externalWebService === undefined,
    npxCommand: command,
    npxAvailable: probe === null ? null : probe.status === 0,
    npxVersion: probe?.status === 0 ? probe.stdout.trim() : null,
    harnessPackage,
    credentialConfigured: Boolean(env.DEEPSEEK_API_KEY?.trim()),
    apiKeyInEnvironment: Boolean(env.DEEPSEEK_API_KEY?.trim()),
    dataDirectory: resolveDataDirectory(env),
    allowedWorkspaceRoots,
    workspaceRootsRestricted: allowedWorkspaceRoots.length > 0,
    surface: "web",
  };
}
