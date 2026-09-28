import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { authenticateExternalWebService, resolveExternalWebService } from "./runtime.js";

export type ConnectionChoice = { mode: "managed" } | { mode: "external"; url: string };

export interface SetupSnapshot {
  status: "required" | "pending" | "configured";
  mode: ConnectionChoice["mode"] | null;
  externalWebUrl: string | null;
  setupUrl: string | null;
  browserError: string | null;
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>设置 DeepSeek Harness</title><style>
body{font:16px system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;line-height:1.5}
input{box-sizing:border-box;width:100%;padding:.7rem;font:inherit}button{font:inherit;padding:.7rem 1rem;margin:.8rem .6rem 0 0}
.note{color:#555}.error{color:#a00}
</style></head><body><h1>设置 DeepSeek Harness</h1>
<p>选择如何使用 DSH Web。已有服务请粘贴启动时输出的完整认证 URL（包含 <code>?token=...</code>）。你粘贴的 URL 只保存在本机插件目录，不会发送给 Codex。</p>
<form method="post"><label for="url">已有 DSH Web 的认证 URL</label>
<input id="url" name="url" type="url" placeholder="http://127.0.0.1:端口/?token=..." autocomplete="off">
<button name="mode" value="external">连接已有服务</button>
<button name="mode" value="managed" formnovalidate>由插件启动新服务</button></form>
<p class="note">选择会在下次启动 Codex 时继续生效。需要修改时，让 Codex 重新打开此设置页。</p>
</body></html>`;

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    // no-referrer makes Chrome send Origin: null for this page's form POST.
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
  });
  response.end(html);
}

/** Owns the local, one-time browser form and its private persisted connection choice. */
export class ConnectionSetup {
  private readonly configPath: string;
  private readonly environmentUrl: string | undefined;
  private choice: ConnectionChoice | null | undefined;
  private server: Server | null = null;
  private opening: Promise<SetupSnapshot> | null = null;
  private setupUrl: string | null = null;
  private browserError: string | null = null;
  private readonly waiters = new Set<() => void>();

  public constructor(
    private readonly dataDirectory: string,
    private readonly openBrowser: (url: string) => Promise<void>,
    environmentUrl: string | undefined = process.env.DSH_MCP_WEB_URL,
  ) {
    this.configPath = join(dataDirectory, "connection.json");
    this.environmentUrl = environmentUrl?.trim() || undefined;
  }

  public async getChoice(): Promise<ConnectionChoice | null> {
    if (this.environmentUrl !== undefined) return { mode: "external", url: this.environmentUrl };
    if (this.choice !== undefined) return this.choice;
    try {
      const stored: unknown = JSON.parse(await readFile(this.configPath, "utf8"));
      if (typeof stored === "object" && stored !== null) {
        const value = stored as Record<string, unknown>;
        if (value.mode === "managed") return this.choice = { mode: "managed" };
        if (value.mode === "external" && typeof value.url === "string") {
          resolveExternalWebService({ DSH_MCP_WEB_URL: value.url });
          return this.choice = { mode: "external", url: value.url };
        }
      }
    } catch {
      // Missing or invalid local config opens setup instead of starting an unintended service.
    }
    return this.choice = null;
  }

  public async state(): Promise<SetupSnapshot> {
    const choice = await this.getChoice();
    return {
      status: this.server !== null ? "pending" : choice === null ? "required" : "configured",
      mode: choice?.mode ?? null,
      externalWebUrl: choice?.mode === "external"
        ? resolveExternalWebService({ DSH_MCP_WEB_URL: choice.url })?.webUrl ?? null : null,
      setupUrl: this.setupUrl,
      browserError: this.browserError,
    };
  }

  public async open(force = false): Promise<SetupSnapshot> {
    if (this.environmentUrl !== undefined) {
      if (force) throw new Error("Remove DSH_MCP_WEB_URL from the MCP environment before changing this setting.");
      return this.state();
    }
    if (!force && await this.getChoice() !== null) return this.state();
    if (this.server !== null) return this.state();
    if (this.opening !== null) return this.opening;
    this.opening = this.openPage().finally(() => { this.opening = null; });
    return this.opening;
  }

  private async openPage(): Promise<SetupSnapshot> {
    const nonce = randomBytes(24).toString("hex");
    const path = `/setup/${nonce}`;
    const server = createServer((request, response) => void this.handle(request, response, path));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    this.server = server;
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Could not open local setup page.");
    this.setupUrl = `http://127.0.0.1:${String(address.port)}${path}`;
    this.browserError = null;
    try { await this.openBrowser(this.setupUrl); } catch {
      this.browserError = "Could not open the browser; open setupUrl manually.";
    }
    return this.state();
  }

  public async wait(timeoutMs: number): Promise<SetupSnapshot> {
    if (this.server === null) return this.state();
    await new Promise<void>((resolve) => {
      const finish = (): void => { clearTimeout(timer); this.waiters.delete(finish); resolve(); };
      const timer = setTimeout(finish, Math.min(Math.max(timeoutMs, 0), 30_000));
      this.waiters.add(finish);
    });
    return this.state();
  }

  public async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.setupUrl = null;
    for (const finish of this.waiters) finish();
    if (server !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    const address = this.server?.address();
    const origin = address !== null && address !== undefined && typeof address !== "string"
      ? `http://127.0.0.1:${String(address.port)}` : null;
    if (origin === null || request.headers.host !== new URL(origin).host || request.url !== path) {
      sendHtml(response, 404, "Not found");
      return;
    }
    if (request.method === "GET") {
      sendHtml(response, 200, PAGE);
      return;
    }
    if (request.method !== "POST" || request.headers.origin !== origin ||
        request.headers["content-type"]?.split(";", 1)[0] !== "application/x-www-form-urlencoded") {
      sendHtml(response, 403, "Forbidden");
      return;
    }
    try {
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > 4_096) throw new Error("Form too large.");
      }
      const form = new URLSearchParams(body);
      const mode = form.get("mode");
      let choice: ConnectionChoice;
      if (mode === "managed") {
        choice = { mode };
      } else if (mode === "external") {
        const url = form.get("url")?.trim() ?? "";
        const external = resolveExternalWebService({ DSH_MCP_WEB_URL: url });
        if (external === undefined || external.authenticationUrl === null) throw new Error("Authentication URL required.");
        await authenticateExternalWebService(external);
        choice = { mode, url };
      } else {
        throw new Error("Unknown connection mode.");
      }
      await this.save(choice);
      this.choice = choice;
      if (choice.mode === "external") {
        response.writeHead(303, {
          location: choice.url,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        });
        response.end();
      } else {
        sendHtml(response, 200, "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>设置完成</title><h1>设置完成</h1><p>回到 Codex 继续任务。</p></html>");
      }
      void this.close();
    } catch {
      sendHtml(response, 400, PAGE.replace("<form method=\"post\">", "<p class=\"error\">设置失败。请检查完整认证 URL 和 DSH Web 状态后重试。</p><form method=\"post\">"));
    }
  }

  private async save(choice: ConnectionChoice): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.configPath}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(choice), { mode: 0o600, flag: "wx" });
      await rename(temporaryPath, this.configPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}
