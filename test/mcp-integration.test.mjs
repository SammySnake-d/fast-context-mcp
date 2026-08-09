/**
 * MCP stdio integration test.
 *
 * Spawns the real Fast Context server and verifies the public contract:
 * initialize, tools/list, and a deterministic tools/call error path.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const SERVER_PATH = new URL("../src/server.mjs", import.meta.url).pathname;

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

  it("initialize preserves the Fast Context server identity", async () => {
    const c = new McpClient();
    try {
      const res = await c.initialize();
      assert.equal(res.result?.serverInfo?.name, "windsurf-fast-context");
      assert.equal(res.result?.serverInfo?.version, "1.3.1");
    } finally {
      c.close();
    }
  });

  it("tools/list preserves the two public tool names", async () => {
    const res = await client.request(2, "tools/list");
    const names = (res.result?.tools || []).map((tool) => tool.name).sort();
    assert.deepEqual(names, ["extract_windsurf_key", "fast_context_search"]);
  });

  it("fast_context_search keeps the locator-only schema", async () => {
    const res = await client.request(3, "tools/list");
    const search = (res.result?.tools || []).find((tool) => tool.name === "fast_context_search");
    assert.ok(search);
    const properties = Object.keys(search.inputSchema?.properties || {}).sort();
    assert.deepEqual(properties, ["exclude_paths", "max_results", "max_turns", "project_path", "query", "tree_depth"]);
  });

  it("fast_context_search handles an invalid project without network access", async () => {
    const res = await client.request(4, "tools/call", {
      name: "fast_context_search",
      arguments: {
        query: "find auth",
        project_path: "/definitely/not/a/real/fast-context-project",
      },
    });
    const text = res.result?.content?.[0]?.text;
    assert.match(text, /^Error: project path does not exist:/);
  });
});
