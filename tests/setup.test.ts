import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConnectionSetup } from "../src/setup.js";

describe("connection setup", () => {
  it("persists the auto-archive choice from the setup page", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "deepseek-harness-setup-"));
    const openBrowser = vi.fn(async () => undefined);
    const setup = new ConnectionSetup(dataDirectory, openBrowser);
    try {
      const pending = await setup.open();
      const page = await fetch(pending.setupUrl!);
      expect(await page.text()).toContain('name="autoArchiveSuccessfulRuns"');
      const saved = await fetch(pending.setupUrl!, {
        method: "POST",
        headers: { origin: new URL(pending.setupUrl!).origin, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ mode: "managed", autoArchiveSuccessfulRuns: "true" }),
      });

      expect(saved.status).toBe(200);
      expect(await setup.getChoice()).toEqual({ mode: "managed", autoArchiveSuccessfulRuns: true });
      expect(JSON.parse(await readFile(join(dataDirectory, "connection.json"), "utf8"))).toMatchObject({
        mode: "managed",
        autoArchiveSuccessfulRuns: true,
      });
    } finally {
      await setup.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("lets the environment override the setup-page choice", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "deepseek-harness-setup-"));
    const setup = new ConnectionSetup(dataDirectory, vi.fn(async () => undefined), undefined, false);
    try {
      const pending = await setup.open();
      const saved = await fetch(pending.setupUrl!, {
        method: "POST",
        headers: { origin: new URL(pending.setupUrl!).origin, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ mode: "managed", autoArchiveSuccessfulRuns: "true" }),
      });

      expect(saved.status).toBe(200);
      expect(await setup.getChoice()).toEqual({ mode: "managed", autoArchiveSuccessfulRuns: false });
    } finally {
      await setup.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});
