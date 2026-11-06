import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Package identity of the browser plugin that draws the Session-row mark. */
export const SESSION_MARK_PACKAGE = "dsh-codex-session-mark";
/** Loader id of the companion plugin row. */
export const SESSION_MARK_ROW_ID = "codex-session-mark";
/** Invisible marker DSH keeps in the title; the browser plugin turns it into the icon. */
export const SESSION_MARK_TITLE = "\u200C";
/** Visible fallback used when the browser plugin is not mounted. */
export const SESSION_TITLE_PREFIX = "[codex] ";

const MANAGED_START = "# >>> deepseek-harness-for-codex session mark (managed) >>>";
const MANAGED_END = "# <<< deepseek-harness-for-codex session mark (managed) <<<";
const MARK_HASH = /^[a-f0-9]{12}$/;
const PATCH_FILE = "cordis.patch.yml";

/** A prepared companion directory and the host entry the Loader should mount. */
export interface SessionMarkFiles {
  directory: string;
  entryPath: string;
}

/** Whether a Session title carries the icon marker instead of the visible prefix. */
export function sessionTitle(sessionMark: boolean, title: string): string {
  return `${sessionMark ? SESSION_MARK_TITLE : SESSION_TITLE_PREFIX}${title}`;
}

/** Resolves the external DSH home where the shared browser plugin is installed. */
export function resolveExternalDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_MCP_DSH_HOME?.trim();
  return configured || join(homedir(), ".dsh");
}

/** Whether connecting to an existing DSH may install the browser plugin into that DSH home. */
export function resolveExternalSessionMark(env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = env.DSH_MCP_EXTERNAL_SESSION_MARK?.trim();
  if (!configured) return true;
  if (configured === "true") return true;
  if (configured === "false") return false;
  throw new Error("DSH_MCP_EXTERNAL_SESSION_MARK must be true or false.");
}

/**
 * Locates the companion package shipped beside this module. Walking up to the
 * package root works both for the bundled dist entry and for source launch.
 */
export function resolveSessionMarkSource(moduleUrl: string = import.meta.url): string | null {
  let current = dirname(fileURLToPath(moduleUrl));
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };
        if (parsed.name === "deepseek-harness-for-codex") {
          const source = join(current, "plugins", "deepseek-harness", "mark");
          return existsSync(join(source, "client.js")) ? source : null;
        }
      } catch {
        // 继续向上查找；损坏的 manifest 不应阻止启动。
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Copies the companion package into a stable directory under the DSH home.
 * Keeping the entry path stable means a plugin upgrade only refreshes the
 * files; the home patch (and its loader row) never has to change, which the
 * Loader would otherwise ignore because the row id already exists.
 */
export async function installSessionMarkFiles(sourceDirectory: string, home: string): Promise<SessionMarkFiles | null> {
  let files: Array<{ name: string; body: string }>;
  try {
    files = await Promise.all(["package.json", "index.js", "client.js"].map(async (name) => ({
      name,
      body: await readFile(join(sourceDirectory, name), "utf8"),
    })));
  } catch {
    return null;
  }
  const parent = join(home, "codex-session-mark");
  const directory = join(parent, "current");
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await Promise.all(files.map(async (file) => {
      const target = join(directory, file.name);
      if (existsSync(target) && await readFile(target, "utf8") === file.body) return;
      const temporary = `${target}.tmp-${String(process.pid)}-${String(Date.now())}`;
      await writeFile(temporary, file.body, { mode: 0o600 });
      await rename(temporary, target);
    }));
    await removeRevisionDirectories(parent);
    return { directory, entryPath: join(directory, "index.js") };
  } catch {
    return null;
  }
}

/** Removes earlier content-addressed revisions; unknown sibling entries are left alone. */
async function removeRevisionDirectories(parent: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch {
    return;
  }
  await Promise.all(entries.filter((entry) => entry !== "current" && MARK_HASH.test(entry)).map(async (entry) => {
    try {
      await rm(join(parent, entry), { recursive: true, force: true });
    } catch {
      // 旧版本清理失败不影响当前图标。
    }
  }));
}

/**
 * Adds or refreshes the managed Loader row in a DSH home patch. Existing user
 * content is preserved; the previous file is backed up beside it. Returns false
 * when the home is not writable or the patch cannot be composed safely.
 */
export async function installHomePatch(home: string, entryPath: string): Promise<boolean> {
  const patchPath = join(home, PATCH_FILE);
  const block = managedBlock(entryPath);
  let existing = "";
  try {
    existing = await readFile(patchPath, "utf8");
  } catch {
    // 文件不存在时创建新的用户层。
  }

  const next = composePatch(existing, block);
  if (next === null) return false;
  if (next === existing) return true;

  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
    if (existing.length > 0) {
      await writeFile(`${patchPath}.bak-${String(Date.now())}`, existing, { mode: 0o600 });
    }
    const temporary = `${patchPath}.tmp-${String(process.pid)}-${String(Date.now())}`;
    await writeFile(temporary, next, { mode: 0o600 });
    await rename(temporary, patchPath);
    return true;
  } catch {
    return false;
  }
}

/** Removes the managed Loader row, preserving every other line in the home patch. */
export async function removeHomePatch(home: string): Promise<void> {
  const patchPath = join(home, PATCH_FILE);
  let existing: string;
  try {
    existing = await readFile(patchPath, "utf8");
  } catch {
    return;
  }
  const start = existing.indexOf(MANAGED_START);
  const end = existing.indexOf(MANAGED_END);
  if (start < 0 || end < start) return;
  const next = `${existing.slice(0, start)}${existing.slice(end + MANAGED_END.length)}`.trim();
  const body = next.length === 0 ? "[]\n" : `${next}\n`;
  try {
    const temporary = `${patchPath}.tmp-${String(process.pid)}-${String(Date.now())}`;
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, patchPath);
  } catch {
    // 保持现状；调用方会回退到可见前缀。
  }
}

/** Composes the patch list without touching unrelated entries. */
function composePatch(existing: string, block: string): string | null {
  const start = existing.indexOf(MANAGED_START);
  const end = existing.indexOf(MANAGED_END);
  if (start >= 0) {
    if (end < start) return null;
    return `${existing.slice(0, start)}${block}${existing.slice(end + MANAGED_END.length)}`;
  }
  const meaningful = existing.replace(/^\s*(?:#.*)?$/gm, "").trim();
  if (meaningful === "" || meaningful === "[]") return `${block}\n`;
  return `${existing.trimEnd()}\n\n${block}\n`;
}

/** One managed block: a root insert row pointing at the installed host entry. */
function managedBlock(entryPath: string): string {
  const url = pathToFileURL(entryPath).href.replaceAll("'", "%27");
  // The warning stays inside the managed span so removeHomePatch() removes it too.
  return `${MANAGED_START}\n# Remove this block before deleting the companion directory; DSH fails to boot\n# when the inserted host entry cannot be imported.\n- insert:\n    - id: ${SESSION_MARK_ROW_ID}\n      name: '${url}'\n${MANAGED_END}`;
}

/** Reads the DSH release and whether the companion plugin is in its boot graph. */
export async function readSessionMarkSupport(webUrl: string, cookie: string | null): Promise<{ version: string | null; loaded: boolean } | null> {
  let response: Response;
  try {
    response = await fetch(webUrl, {
      headers: cookie === null ? {} : { cookie },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const html = await response.text();
  const version = /"release":\{"version":"([^"]+)"/.exec(html)?.[1] ?? /"version":"([^"]+)"/.exec(html)?.[1] ?? null;
  return { version, loaded: html.includes(`"${SESSION_MARK_PACKAGE}"`) };
}

/** Waits briefly for the browser plugin to appear; the external home patch reloads live. */
export async function detectSessionMark(
  webUrl: string,
  cookie: string | null,
  timeoutMs = 8_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const support = await readSessionMarkSupport(webUrl, cookie);
    if (support === null) return false;
    if (support.version === null || !supportsSessionMark(support.version)) return false;
    if (support.loaded) return true;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 500));
  }
  return false;
}

/** Whether a DSH release has the Session-row leading seat and client-module graph. */
export function supportsSessionMark(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || (major === 0 && minor >= 2);
}
