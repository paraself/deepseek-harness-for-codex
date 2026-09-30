import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

describe("packaged Codex plugin", () => {
  it("starts the bundled MCP server without fetching source from GitHub", async () => {
    const manifest = JSON.parse(await readFile("plugins/deepseek-harness/.mcp.json", "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[]; cwd?: string }>;
    };
    const server = manifest.mcpServers["deepseek-harness"];

    expect(server).toEqual(expect.objectContaining({
      command: "node",
      args: ["./dist/bin.mjs"],
      cwd: ".",
    }));
    expect(JSON.stringify(server)).not.toMatch(/github:|#main/u);

    const bundledServer = await readFile("plugins/deepseek-harness/dist/bin.mjs", "utf8");
    const imports = bundledServer.match(/^import .*$/gmu) ?? [];
    expect(imports.every((line) => /from\s+["']node:/u.test(line))).toBe(true);
    expect(bundledServer).toContain("deepseek-harness-for-codex");

    const isolatedDirectory = await mkdtemp(join(tmpdir(), "deepseek-harness-plugin-"));
    temporaryDirectories.push(isolatedDirectory);
    const isolatedServer = join(isolatedDirectory, "bin.mjs");
    await copyFile("plugins/deepseek-harness/dist/bin.mjs", isolatedServer);
    const client = new Client({ name: "package-test", version: "1.0.0" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [isolatedServer] });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("doctor");
    } finally {
      await client.close();
    }
  });
});
