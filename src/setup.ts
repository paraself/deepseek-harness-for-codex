import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElicitRequestFormParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { authenticateExternalWebService, resolveAutoArchiveSuccessfulRuns, resolveExternalWebService } from "./runtime.js";

export type ConnectionChoice =
  | { mode: "managed"; autoArchiveSuccessfulRuns: boolean }
  | { mode: "external"; url: string; autoArchiveSuccessfulRuns: boolean };
export type SetupInputHandler = (request: ElicitRequestFormParams, signal: AbortSignal) => Promise<ElicitResult>;

export interface SetupSnapshot {
  status: "required" | "pending" | "configured";
  mode: ConnectionChoice["mode"] | null;
  externalWebUrl: string | null;
  setupUrl: null;
  browserError: null;
  autoArchiveSuccessfulRuns: boolean;
}

/** 通过客户端表单收取设置；原始认证 URL 只进入本机配置，不进入工具结果。 */
export class ConnectionSetup {
  private readonly configPath: string;
  private readonly environmentUrl: string | undefined;
  private choice: ConnectionChoice | null | undefined;
  private opening: Promise<void> | null = null;
  private controller: AbortController | null = null;

  public constructor(
    private readonly dataDirectory: string,
    environmentUrl: string | undefined = process.env.DSH_MCP_WEB_URL,
    private readonly environmentAutoArchiveSuccessfulRuns: boolean | undefined = resolveAutoArchiveSuccessfulRuns(),
  ) {
    this.configPath = join(dataDirectory, "connection.json");
    this.environmentUrl = environmentUrl?.trim() || undefined;
  }

  public async getChoice(): Promise<ConnectionChoice | null> {
    if (this.environmentUrl !== undefined) return { mode: "external", url: this.environmentUrl, autoArchiveSuccessfulRuns: this.environmentAutoArchiveSuccessfulRuns ?? false };
    if (this.choice !== undefined) return this.choice;
    try {
      const stored: unknown = JSON.parse(await readFile(this.configPath, "utf8"));
      if (typeof stored === "object" && stored !== null) {
        const value = stored as Record<string, unknown>;
        const autoArchiveSuccessfulRuns = this.environmentAutoArchiveSuccessfulRuns ?? value.autoArchiveSuccessfulRuns === true;
        if (value.mode === "managed") return this.choice = { mode: "managed", autoArchiveSuccessfulRuns };
        if (value.mode === "external" && typeof value.url === "string") {
          resolveExternalWebService({ DSH_MCP_WEB_URL: value.url });
          return this.choice = { mode: "external", url: value.url, autoArchiveSuccessfulRuns };
        }
      }
    } catch {
      // 旧配置不可用时重新询问，不启动未经用户选择的服务。
    }
    return this.choice = null;
  }

  public async state(): Promise<SetupSnapshot> {
    const choice = await this.getChoice();
    return {
      status: this.opening !== null ? "pending" : choice === null ? "required" : "configured",
      mode: choice?.mode ?? null,
      externalWebUrl: choice?.mode === "external" ? resolveExternalWebService({ DSH_MCP_WEB_URL: choice.url })?.webUrl ?? null : null,
      // 保留旧结果字段，避免旧客户端依赖的返回结构变化。
      setupUrl: null,
      browserError: null,
      autoArchiveSuccessfulRuns: choice?.autoArchiveSuccessfulRuns ?? this.environmentAutoArchiveSuccessfulRuns ?? false,
    };
  }

  public async open(force = false, requestInput?: SetupInputHandler, toolSignal?: AbortSignal): Promise<SetupSnapshot> {
    if (this.environmentUrl !== undefined) {
      if (force) throw new Error("Remove DSH_MCP_WEB_URL from the MCP environment before changing this setting.");
      return this.state();
    }
    if (!force && await this.getChoice() !== null) return this.state();
    if (this.opening === null) {
      if (requestInput === undefined) throw new Error("This MCP client must support form elicitation to configure DeepSeek Harness. Update the client or configure DSH_MCP_WEB_URL locally.");
      const controller = new AbortController();
      this.controller = controller;
      const signal = toolSignal === undefined ? controller.signal : AbortSignal.any([controller.signal, toolSignal]);
      this.opening = this.collect(requestInput, signal).finally(() => { this.opening = null; this.controller = null; });
    }
    await this.opening;
    return this.state();
  }

  private async collect(requestInput: SetupInputHandler, signal: AbortSignal): Promise<void> {
    let message = "设置 DeepSeek Harness：选择连接方式。复用已有服务时填写启动时输出的完整本机认证 URL；由插件启动时留空。";
    while (!signal.aborted) {
      const current = await this.getChoice();
      const response = await requestInput({
        mode: "form", message,
        requestedSchema: {
          type: "object",
          properties: {
            mode: { type: "string", title: "连接方式", enum: ["external", "managed"], enumNames: ["复用已有 DSH", "由插件启动新服务（自动选端口）"], default: current?.mode ?? "external" },
            url: { type: "string", title: "已有 DSH 的完整认证 URL", description: "仅复用已有服务时填写，例如 http://127.0.0.1:3080/?token=...", maxLength: 4096 },
            autoArchiveSuccessfulRuns: { type: "boolean", title: "成功后自动归档新建会话，并清理插件新建的空工作区", default: current?.autoArchiveSuccessfulRuns ?? false },
          },
          required: ["mode", "autoArchiveSuccessfulRuns"],
        },
      }, signal);
      if (signal.aborted || response.action !== "accept") return;
      let choice: ConnectionChoice;
      try {
        const content = response.content;
        if (typeof content?.autoArchiveSuccessfulRuns !== "boolean") throw new Error("Invalid archive choice.");
        const autoArchiveSuccessfulRuns = content.autoArchiveSuccessfulRuns;
        if (content.mode === "managed") choice = { mode: "managed", autoArchiveSuccessfulRuns };
        else if (content.mode === "external" && typeof content.url === "string") {
          const url = content.url.trim();
          if (url.length > 4096) throw new Error("URL too long.");
          const external = resolveExternalWebService({ DSH_MCP_WEB_URL: url });
          if (external?.authenticationUrl === null || external === undefined) throw new Error("Authentication URL required.");
          await authenticateExternalWebService(external, signal);
          choice = { mode: "external", url, autoArchiveSuccessfulRuns };
        } else throw new Error("Unknown connection mode.");
      } catch {
        // 不把原始输入或认证错误回显到下一次表单请求。
        message = "设置未保存。请检查完整的本机认证 URL 和 DSH 服务状态后重试，或取消。";
        continue;
      }
      if (signal.aborted) return;
      try { await this.save(choice); } catch { throw new Error("Could not save DeepSeek Harness settings locally."); }
      this.choice = this.environmentAutoArchiveSuccessfulRuns === undefined ? choice : { ...choice, autoArchiveSuccessfulRuns: this.environmentAutoArchiveSuccessfulRuns };
      return;
    }
  }

  public async wait(timeoutMs: number): Promise<SetupSnapshot> {
    if (this.opening !== null) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.opening, new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.min(Math.max(timeoutMs, 0), 30_000)); })]);
      } finally { clearTimeout(timer); }
    }
    return this.state();
  }

  public async close(): Promise<void> { this.controller?.abort(); }

  private async save(choice: ConnectionChoice): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.configPath}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(choice), { mode: 0o600, flag: "wx" });
      await rename(temporaryPath, this.configPath);
    } finally { await rm(temporaryPath, { force: true }); }
  }
}
