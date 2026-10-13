import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionSetup, type SetupInputHandler } from "../src/setup.js";

describe("connection setup", () => {
  let dataDirectory: string;
  let setup: ConnectionSetup;
  beforeEach(async () => {
    vi.stubEnv("DSH_MCP_WEB_URL", "");
    vi.stubEnv("DSH_MCP_AUTO_ARCHIVE", "");
    dataDirectory = await mkdtemp(join(tmpdir(), "deepseek-harness-setup-"));
    setup = new ConnectionSetup(dataDirectory);
  });
  afterEach(async () => {
    await setup.close();
    await rm(dataDirectory, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const managed: SetupInputHandler = async () => ({ action: "accept", content: { mode: "managed", autoArchiveSuccessfulRuns: true } });

  it("persists the native form choice and reloads it without another prompt", async () => {
    expect(await setup.open(false, managed)).toMatchObject({ status: "configured", mode: "managed", autoArchiveSuccessfulRuns: true, setupUrl: null });
    expect(JSON.parse(await readFile(join(dataDirectory, "connection.json"), "utf8"))).toEqual({ mode: "managed", autoArchiveSuccessfulRuns: true });
    const restarted = new ConnectionSetup(dataDirectory);
    expect(await restarted.open()).toMatchObject({ status: "configured", mode: "managed", autoArchiveSuccessfulRuns: true });
  });

  it("keeps the auto-archive environment override without overwriting the saved form value", async () => {
    setup = new ConnectionSetup(dataDirectory, undefined, false);
    expect(await setup.open(false, managed)).toMatchObject({ autoArchiveSuccessfulRuns: false });
    expect(JSON.parse(await readFile(join(dataDirectory, "connection.json"), "utf8"))).toMatchObject({ autoArchiveSuccessfulRuns: true });
  });

  it.each(["cancel", "decline"] as const)("does not save or configure when the form returns %s", async (action) => {
    const opening = setup.open(false, async () => ({ action }));
    if (action === "decline") await expect(opening).rejects.toThrow("declined");
    else expect(await opening).toMatchObject({ status: "required", mode: null });
    await expect(readFile(join(dataDirectory, "connection.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await setup.open(false, managed)).toMatchObject({ status: "configured" });
  });

  it.each(["cancel", "decline"] as const)("reports %s instead of claiming reconfiguration succeeded", async (action) => {
    await writeFile(join(dataDirectory, "connection.json"), JSON.stringify({ mode: "external", url: "http://localhost:3080/?token=fixture-secret" }));
    const requests: unknown[] = [];
    await expect(setup.open(true, async (request) => { requests.push(request); return { action }; })).rejects.toThrow(action === "decline" ? "declined" : "cancelled");
    expect(await setup.state()).toMatchObject({ status: "configured", mode: "external", externalWebUrl: "http://localhost:3080", autoArchiveSuccessfulRuns: false });
    expect(JSON.stringify(requests)).not.toContain("fixture-secret");
    expect(await readFile(join(dataDirectory, "connection.json"), "utf8")).toContain("fixture-secret");
    expect(await setup.open(true, managed)).toMatchObject({ status: "configured", mode: "managed" });
  });

  it.each([
    "https://example.com/?token=fixture-secret",
    "not-a-url?token=fixture-secret",
    "http://localhost:3080/?token=fixture-secret&extra=1",
    "http://localhost:3080/?token=fixture-secret&token=duplicate",
    "http://localhost:3080/",
  ])("re-prompts without echoing a rejected URL: %s", async (url) => {
    const messages: unknown[] = [];
    const requestInput: SetupInputHandler = async (request) => {
      messages.push(request);
      return messages.length === 1 ? { action: "accept", content: { mode: "external", url, autoArchiveSuccessfulRuns: false } } : { action: "cancel" };
    };
    expect(await setup.open(false, requestInput)).toMatchObject({ status: "required" });
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages)).not.toContain("fixture-secret");
    expect(messages[1]).toMatchObject({ message: expect.stringContaining("设置未保存") });
    await expect(readFile(join(dataDirectory, "connection.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("shares one pending form and lets wait_setup observe it", async () => {
    let respond!: () => void;
    const input = vi.fn<SetupInputHandler>(() => new Promise((resolve) => { respond = () => resolve({ action: "accept", content: { mode: "managed", autoArchiveSuccessfulRuns: false } }); }));
    const first = setup.open(false, input);
    const second = setup.open(true, input);
    await vi.waitFor(() => expect(input).toHaveBeenCalledTimes(1));
    expect(await setup.wait(0)).toMatchObject({ status: "pending" });
    respond();
    expect(await first).toMatchObject({ status: "configured" });
    expect(await second).toMatchObject({ status: "configured" });
  });

  it("aborts an open form on close without saving", async () => {
    const input = vi.fn<SetupInputHandler>((_request, signal) => new Promise((resolve) => { signal.addEventListener("abort", () => resolve({ action: "cancel" }), { once: true }); }));
    const opening = setup.open(false, input);
    await vi.waitFor(() => expect(input).toHaveBeenCalledOnce());
    await setup.close();
    expect(await opening).toMatchObject({ status: "required" });
    await expect(readFile(join(dataDirectory, "connection.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the URL environment override and refuses to replace it through a form", async () => {
    setup = new ConnectionSetup(dataDirectory, "http://localhost:3080/?token=fixture-secret");
    const input = vi.fn(managed);
    expect(await setup.open(false, input)).toMatchObject({ status: "configured", externalWebUrl: "http://localhost:3080" });
    await expect(setup.open(true, input)).rejects.toThrow("Remove DSH_MCP_WEB_URL");
    expect(input).not.toHaveBeenCalled();
  });

  it("does not save when the calling tool is cancelled during URL authentication", async () => {
    const controller = new AbortController();
    let finishAuthentication!: () => void;
    const authentication = new Promise<Response>((resolve) => { finishAuthentication = () => resolve(new Response(null, { status: 303, headers: { "set-cookie": "auth=fixture-cookie" } })); });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => authentication).mockResolvedValue(new Response(null, { status: 200 }));
    const opening = setup.open(false, async () => ({ action: "accept", content: { mode: "external", url: "http://localhost:3080/?token=fixture-secret", autoArchiveSuccessfulRuns: false } }), controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    controller.abort();
    finishAuthentication();
    expect(await opening).toMatchObject({ status: "required" });
    await expect(readFile(join(dataDirectory, "connection.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
