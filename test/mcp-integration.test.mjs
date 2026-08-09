/**
 * MCP stdio integration test.
 *
 * Spawns the real server (deepgrep/src/server.mjs) as a child process and
 * communicates over the MCP stdio transport (newline-delimited JSON-RPC).
 * Verifies the full stack: initialize handshake, tools/list, and tools/call
 * for the pure-local deepgrep_get tool (no network needed).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const SERVER_PATH = new URL("../deepgrep/src/server.mjs", import.meta.url).pathname;

/**
 * Minimal MCP client over stdio. Sends newline-delimited JSON-RPC,
 * resolves responses by matching `id`.
 */
class McpClient {
  constructor() {
    this.proc = spawn(process.execPath, [SERVER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, WINDSURF_API_KEY: "test-key-integration" },
    });
    this.pending = new Map();
    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return;
      let msg;
      try { msg = JSON.parse(trimmed); } catch { return; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    });
  }

  request(id, method, params = {}, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for response id=${id} (${method})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method, params = {}) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async initialize() {
    const res = await this.request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "integration-test", version: "1.0.0" },
    });
    this.notify("notifications/initialized");
    return res;
  }

  close() {
    this.rl.close();
    this.proc.kill();
  }
}

describe("MCP stdio integration", () => {
  let client;
  before(async () => {
    client = new McpClient();
    await client.initialize();
  });
  after(() => client.close());

  it("initialize returns serverInfo with name 'deepgrep'", async () => {
    // re-init on a fresh client to assert handshake shape
    const c = new McpClient();
    try {
      const res = await c.initialize();
      assert.equal(res.jsonrpc, "2.0");
      assert.equal(res.id, 1);
      assert.equal(res.result?.serverInfo?.name, "deepgrep");
    } finally {
      c.close();
    }
  });

  it("tools/list returns all 4 tools", async () => {
    const res = await client.request(2, "tools/list");
    const names = (res.result?.tools || []).map((t) => t.name).sort();
    assert.deepEqual(names, ["deepgrep_deep", "deepgrep_get", "deepgrep_search", "deepgrep_status"]);
  });

  it("deepgrep_get returns formatted snippet with line numbers", async () => {
    const res = await client.request(3, "tools/call", {
      name: "deepgrep_get",
      arguments: { files: [{ file: SERVER_PATH, ranges: [[1, 3]] }] },
    });
    const text = res.result?.content?.[0]?.text;
    assert.ok(text, "expected content text");
    assert.match(text, /## .+server\.mjs \(L1-3\)/);
    assert.match(text, /1 \| /);
  });

  it("deepgrep_get with empty files returns 'No files/ranges provided'", async () => {
    const res = await client.request(4, "tools/call", {
      name: "deepgrep_get",
      arguments: { files: [] },
    });
    assert.equal(res.result?.content?.[0]?.text, "No files/ranges provided");
  });

  it("deepgrep_status returns a status report", async () => {
    const res = await client.request(5, "tools/call", {
      name: "deepgrep_status",
      arguments: {},
    }, 15000);
    const text = res.result?.content?.[0]?.text;
    assert.ok(text, "expected status text");
    assert.match(text, /deepgrep status/i);
  });
});

