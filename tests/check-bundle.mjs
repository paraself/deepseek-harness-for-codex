import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

test("bundled MCP starts without installed dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-mcp-bundle-"));
  const binary = join(directory, "bin.mjs");
  await copyFile(new URL("../plugins/deepseek-harness/dist/bin.mjs", import.meta.url), binary);
  const server = spawn(process.execPath, [binary], { cwd: directory, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: server.stdout })[Symbol.asyncIterator]();
  let error = "";
  server.stderr.on("data", (chunk) => { error += chunk; });

  async function receive() {
    let timeout;
    try {
      const line = await Promise.race([
        lines.next(),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`MCP handshake timed out: ${error}`)), 5000); }),
      ]);
      assert.equal(line.done, false, error);
      return JSON.parse(line.value);
    } finally {
      clearTimeout(timeout);
    }
  }

  try {
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bundle-check", version: "1" } } }) + "\n");
    assert.equal((await receive()).id, 1);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    const tools = await receive();
    assert.deepEqual(["doctor", "start_run", "wait_run"].filter((name) => !tools.result.tools.some((tool) => tool.name === name)), []);
  } finally {
    if (server.exitCode === null) {
      const closed = once(server, "close");
      server.kill();
      await closed;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
