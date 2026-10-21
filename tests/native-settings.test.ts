import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionSetup } from "../src/setup.js";

describe("native connection settings", () => {
  let directory: string;
  let setup: ConnectionSetup;
  beforeEach(async () => {
    vi.stubEnv("DSH_MCP_WEB_URL", "");
    vi.stubEnv("DSH_MCP_AUTO_ARCHIVE", "");
    directory = await mkdtemp(join(tmpdir(), "dsh-native-settings-"));
    setup = new ConnectionSetup(directory);
  });
  afterEach(async () => {
    await setup.close();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function storeExternal() {
    await writeFile(join(directory, "connection.json"), JSON.stringify({ mode: "external", url: "http://localhost:3080/?token=fixture-old", autoArchiveSuccessfulRuns: false }));
  }

  it("refreshes settings saved by another MCP process", async () => {
    await storeExternal();
    expect((await setup.getChoice())?.mode).toBe("external");
    await writeFile(join(directory, "connection.json"), JSON.stringify({ mode: "managed", autoArchiveSuccessfulRuns: true }));
    expect(await setup.state()).toMatchObject({ mode: "managed", autoArchiveSuccessfulRuns: true });
  });

  it("authenticates a new URL before saving without returning its token", async () => {
    await storeExternal();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 303, headers: { "set-cookie": "auth=fixture-cookie" } }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const response = await setup.updateSettings({ url: "http://localhost:3080/?token=fixture-new" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(response)).not.toContain("fixture-new");
    expect(JSON.parse(await readFile(join(directory, "connection.json"), "utf8"))).toMatchObject({ url: "http://localhost:3080/?token=fixture-new" });
  });

  it("preserves the previous settings and redacts failed authentication", async () => {
    await storeExternal();
    const saved = await readFile(join(directory, "connection.json"), "utf8");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));
    const updating = setup.updateSettings({ url: "http://localhost:3080/?token=fixture-rejected" });
    await expect(updating).rejects.toThrow("认证");
    await expect(updating).rejects.not.toThrow("fixture-rejected");
    expect(await readFile(join(directory, "connection.json"), "utf8")).toBe(saved);
  });

  it.each([
    { kind: "rejected token", response: () => Promise.resolve(new Response(null, { status: 401 })), hint: /token.*失效/, detail: "HTTP 401" },
    { kind: "unavailable service", response: () => Promise.reject(new TypeError("fetch failed: fixture-secret")), hint: /无法连接.*DSH/, detail: "端口" },
    { kind: "timeout", response: () => Promise.reject(new DOMException("fixture-secret", "TimeoutError")), hint: /超时/, detail: "服务状态" },
    { kind: "server error", response: () => Promise.resolve(new Response(null, { status: 503 })), hint: /认证响应/, detail: "HTTP 503" },
    { kind: "missing cookie", response: () => Promise.resolve(new Response(null, { status: 303 })), hint: /认证响应/, detail: "HTTP 303" },
  ])("explains $kind without leaking credentials or replacing the saved connection", async ({ response, hint, detail }) => {
    await storeExternal();
    const saved = await readFile(join(directory, "connection.json"), "utf8");
    vi.spyOn(globalThis, "fetch").mockImplementation(response);
    const updating = setup.updateSettings({ url: "http://localhost:3080/?token=fixture-secret" });
    await expect(updating).rejects.toThrow(hint);
    await expect(updating).rejects.toThrow(detail);
    await expect(updating).rejects.toThrow("原配置未更改");
    await expect(updating).rejects.not.toThrow("fixture-secret");
    expect(await readFile(join(directory, "connection.json"), "utf8")).toBe(saved);
  });

  it.each(["not-a-url-fixture-secret", "https://example.com/?token=fixture-secret", "http://localhost:3080/"])("explains an invalid authentication URL without echoing it", async (url) => {
    await storeExternal();
    const saved = await readFile(join(directory, "connection.json"), "utf8");
    const updating = setup.updateSettings({ url });
    await expect(updating).rejects.toThrow(/完整.*本机.*认证 URL/);
    await expect(updating).rejects.toThrow("token");
    await expect(updating).rejects.not.toThrow("fixture-secret");
    expect(await readFile(join(directory, "connection.json"), "utf8")).toBe(saved);
  });

  it("distinguishes local write failures from authentication failures", async () => {
    const blockedDirectory = join(directory, "blocked");
    await writeFile(blockedDirectory, "not a directory");
    setup = new ConnectionSetup(blockedDirectory);
    const updating = setup.updateSettings({ mode: "managed" });
    await expect(updating).rejects.toThrow(/本地.*写入失败/);
    await expect(updating).rejects.toThrow("目录权限");
  });

  it("never requests a non-loopback URL", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(setup.updateSettings({ url: "https://example.com/?token=fixture-rejected" })).rejects.toThrow("认证");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(readFile(join(directory, "connection.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("updates archive settings without re-authenticating or dropping the stored URL", async () => {
    await storeExternal();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    expect(await setup.updateSettings({ autoArchiveSuccessfulRuns: true })).toMatchObject({ mode: "external", autoArchiveSuccessfulRuns: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(directory, "connection.json"), "utf8"))).toMatchObject({ url: "http://localhost:3080/?token=fixture-old" });
  });

  it("connects to an existing service when its URL is entered from managed mode", async () => {
    await writeFile(join(directory, "connection.json"), JSON.stringify({ mode: "managed", autoArchiveSuccessfulRuns: true }));
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 303, headers: { "set-cookie": "auth=fixture-cookie" } }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect(await setup.updateSettings({ url: "http://localhost:3080/?token=fixture-new" })).toMatchObject({ mode: "external", autoArchiveSuccessfulRuns: true });
  });

  it("does not clear an existing credential when the write-only input is blank", async () => {
    await storeExternal();
    const saved = await readFile(join(directory, "connection.json"), "utf8");
    await setup.updateSettings({ url: "  " });
    expect(await readFile(join(directory, "connection.json"), "utf8")).toBe(saved);
  });

  it("refuses to overwrite environment-controlled settings", async () => {
    setup = new ConnectionSetup(directory, "http://localhost:3080/?token=fixture-env");
    await expect(setup.updateSettings({ mode: "managed" })).rejects.toThrow("DSH_MCP_WEB_URL");
    setup = new ConnectionSetup(directory, undefined, true);
    await expect(setup.updateSettings({ autoArchiveSuccessfulRuns: false })).rejects.toThrow("DSH_MCP_AUTO_ARCHIVE");
    await expect(readFile(join(directory, "connection.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([true, false])("does not persist the archive environment override %s when changing connection mode", async (override) => {
    await writeFile(join(directory, "connection.json"), JSON.stringify({ mode: "external", url: "http://localhost:3080/?token=fixture-old", autoArchiveSuccessfulRuns: !override }));
    setup = new ConnectionSetup(directory, undefined, override);
    expect(await setup.updateSettings({ mode: "managed" })).toMatchObject({ autoArchiveSuccessfulRuns: override });
    expect(JSON.parse(await readFile(join(directory, "connection.json"), "utf8"))).toEqual({ mode: "managed", autoArchiveSuccessfulRuns: !override });
  });

  it("does not save when the UI request is cancelled during authentication", async () => {
    await storeExternal();
    const saved = await readFile(join(directory, "connection.json"), "utf8");
    const controller = new AbortController();
    let respond!: () => void;
    const authenticating = new Promise<Response>((resolve) => { respond = () => resolve(new Response(null, { status: 303, headers: { "set-cookie": "auth=fixture-cookie" } })); });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => authenticating).mockResolvedValue(new Response(null, { status: 200 }));
    const updating = setup.updateSettings({ url: "http://localhost:3080/?token=fixture-new" }, controller.signal);
    const rejected = expect(updating).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    controller.abort();
    respond();
    await rejected;
    expect(await readFile(join(directory, "connection.json"), "utf8")).toBe(saved);
  });
});
