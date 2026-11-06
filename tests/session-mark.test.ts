import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  SESSION_MARK_TITLE,
  SESSION_TITLE_PREFIX,
  detectSessionMark,
  installHomePatch,
  installSessionMarkFiles,
  removeHomePatch,
  resolveExternalSessionMark,
  resolveSessionMarkSource,
  sessionTitle,
  supportsSessionMark,
} from "../src/session-mark.js";

const source = fileURLToPath(new URL("../plugins/deepseek-harness/mark", import.meta.url));
const roots: string[] = [];
let server: Server | null = null;

afterEach(async () => {
  if (server !== null) {
    await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
    server = null;
  }
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-session-mark-"));
  roots.push(root);
  return root;
}

describe("session mark title", () => {
  it("uses the invisible marker only when the browser plugin is available", () => {
    expect(sessionTitle(true, "Fix login")).toBe(`${SESSION_MARK_TITLE}Fix login`);
    expect(sessionTitle(false, "Fix login")).toBe(`${SESSION_TITLE_PREFIX}Fix login`);
  });

  it("gates the feature on a DSH release with the leading seat", () => {
    expect(supportsSessionMark("0.2.2-rc.1")).toBe(true);
    expect(supportsSessionMark("0.2.0")).toBe(true);
    expect(supportsSessionMark("1.0.0")).toBe(true);
    expect(supportsSessionMark("0.1.9")).toBe(false);
    expect(supportsSessionMark("unknown")).toBe(false);
  });

  it("lets an existing DSH installation opt out", () => {
    expect(resolveExternalSessionMark({})).toBe(true);
    expect(resolveExternalSessionMark({ DSH_MCP_EXTERNAL_SESSION_MARK: "false" })).toBe(false);
    expect(resolveExternalSessionMark({ DSH_MCP_EXTERNAL_SESSION_MARK: "true" })).toBe(true);
    expect(() => resolveExternalSessionMark({ DSH_MCP_EXTERNAL_SESSION_MARK: "yes" })).toThrow();
  });
});

describe("companion files", () => {
  it("finds the shipped companion beside the package root", () => {
    expect(resolveSessionMarkSource()).toBe(source);
  });

  it("copies the browser plugin into a stable content-addressed directory", async () => {
    const home = await temporaryRoot();
    const files = await installSessionMarkFiles(source, home);
    expect(files).not.toBeNull();
    expect(existsSync(files!.entryPath)).toBe(true);
    expect(existsSync(join(files!.directory, "client.js"))).toBe(true);
    expect(files!.directory).toBe(join(home, "codex-session-mark", "current"));

    const manifest = JSON.parse(await readFile(join(files!.directory, "package.json"), "utf8")) as {
      name: string;
      dsh: { client: { platform: string } };
    };
    expect(manifest.name).toBe("dsh-codex-session-mark");
    expect(manifest.dsh.client.platform).toBe("web");

    const again = await installSessionMarkFiles(source, home);
    expect(again?.directory).toBe(files!.directory);
  });

  it("removes older revisions after installing the current one", async () => {
    const home = await temporaryRoot();
    await mkdir(join(home, "codex-session-mark", "aaaaaaaaaaaa"), { recursive: true });
    await writeFile(join(home, "codex-session-mark", "aaaaaaaaaaaa", "index.js"), "old");
    const files = await installSessionMarkFiles(source, home);
    expect(files).not.toBeNull();
    expect(existsSync(join(home, "codex-session-mark", "aaaaaaaaaaaa"))).toBe(false);
  });

  it("refreshes a modified stable copy on the next install", async () => {
    const home = await temporaryRoot();
    const files = await installSessionMarkFiles(source, home);
    expect(files).not.toBeNull();
    await writeFile(join(files!.directory, "client.js"), "stale");
    const again = await installSessionMarkFiles(source, home);
    expect(again?.directory).toBe(files!.directory);
    const client = await readFile(join(files!.directory, "client.js"), "utf8");
    expect(client).toContain("data-codex-session-mark-title");
    expect(client).toContain("data:image/png;base64,");
  });

  it("returns null when the shipped package is missing", async () => {
    const home = await temporaryRoot();
    expect(await installSessionMarkFiles(join(home, "missing"), home)).toBeNull();
  });
});

describe("home patch", () => {
  it("creates a managed insert in a new home patch", async () => {
    const home = await temporaryRoot();
    const files = await installSessionMarkFiles(source, home);
    expect(await installHomePatch(home, files!.entryPath)).toBe(true);
    const patch = await readFile(join(home, "cordis.patch.yml"), "utf8");
    expect(patch).toContain("session mark (managed)");
    expect(patch).toContain("id: codex-session-mark");
    expect(patch).toContain("name: 'file://");
  });

  it("preserves an existing user patch and is idempotent", async () => {
    const home = await temporaryRoot();
    const patchPath = join(home, "cordis.patch.yml");
    await writeFile(patchPath, "- id: mine\n  name: '@example/plugin'\n");
    const files = await installSessionMarkFiles(source, home);
    expect(await installHomePatch(home, files!.entryPath)).toBe(true);
    const first = await readFile(patchPath, "utf8");
    expect(first).toContain("- id: mine");
    expect(first.match(/id: codex-session-mark/g)).toHaveLength(1);
    expect(await installHomePatch(home, files!.entryPath)).toBe(true);
    expect(await readFile(patchPath, "utf8")).toBe(first);
  });

  it("replaces an empty patch list instead of appending after it", async () => {
    const home = await temporaryRoot();
    const patchPath = join(home, "cordis.patch.yml");
    await writeFile(patchPath, "[]\n");
    const files = await installSessionMarkFiles(source, home);
    expect(await installHomePatch(home, files!.entryPath)).toBe(true);
    const patch = await readFile(patchPath, "utf8");
    expect(patch.startsWith("[]")).toBe(false);
    expect(patch).toContain("id: codex-session-mark");
  });

  it("updates the entry without duplicating the block", async () => {
    const home = await temporaryRoot();
    const first = await installSessionMarkFiles(source, home);
    expect(await installHomePatch(home, first!.entryPath)).toBe(true);
    const second = join(home, "other", "index.js");
    expect(await installHomePatch(home, second)).toBe(true);
    const patch = await readFile(join(home, "cordis.patch.yml"), "utf8");
    expect(patch.match(/session mark \(managed\) >>>/g)).toHaveLength(1);
    expect(patch).toContain("other/index.js");
  });

  it("removes only the managed block", async () => {
    const home = await temporaryRoot();
    const patchPath = join(home, "cordis.patch.yml");
    await writeFile(patchPath, "- id: mine\n  name: '@example/plugin'\n");
    const files = await installSessionMarkFiles(source, home);
    expect(await installHomePatch(home, files!.entryPath)).toBe(true);
    await removeHomePatch(home);
    const patch = await readFile(patchPath, "utf8");
    expect(patch).toContain("- id: mine");
    expect(patch).not.toContain("codex-session-mark");
  });

  it("does not touch a malformed managed block", async () => {
    const home = await temporaryRoot();
    const patchPath = join(home, "cordis.patch.yml");
    const malformed = "# >>> deepseek-harness-for-codex session mark (managed) >>>\n- insert:\n";
    await writeFile(patchPath, malformed);
    const files = await installSessionMarkFiles(source, home);
    expect(await installHomePatch(home, files!.entryPath)).toBe(false);
    expect(await readFile(patchPath, "utf8")).toBe(malformed);
  });
});

describe("boot graph detection", () => {
  it("waits for the companion entry in a supported release", async () => {
    server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end('<script>window.__DSH_BOOT__={"release":{"version":"0.2.2-rc.1"},"entries":[{"id":"dsh-codex-session-mark"}]}</script>');
    });
    await new Promise<void>((resolveListen) => server!.listen(0, "127.0.0.1", () => resolveListen()));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no server address");
    expect(await detectSessionMark(`http://127.0.0.1:${String(address.port)}/`, null, 1_000)).toBe(true);
  });

  it("refuses an unsupported release", async () => {
    server = createServer((_request, response) => {
      response.end('<script>window.__DSH_BOOT__={"release":{"version":"0.1.9"},"entries":[{"id":"dsh-codex-session-mark"}]}</script>');
    });
    await new Promise<void>((resolveListen) => server!.listen(0, "127.0.0.1", () => resolveListen()));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no server address");
    expect(await detectSessionMark(`http://127.0.0.1:${String(address.port)}/`, null, 1_000)).toBe(false);
  });
});
