#!/usr/bin/env node
/**
 * Windsurf Fast Context MCP Server (Node.js)
 *
 * AI-driven semantic code search via reverse-engineered Windsurf protocol.
 *
 * Configuration (environment variables):
 *   WINDSURF_API_KEY     — Windsurf API key (auto-discovered from local install if not set)
 *   FC_MAX_TURNS         — Search rounds per query (default: 3)
 *   FC_MAX_COMMANDS      — Max parallel commands per round (default: 8)
 *
 * Start:
 *   node src/server.mjs
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { searchWithContent, extractKeyInfo } from "./core.mjs";

// Read config from environment
const MAX_TURNS = parseInt(process.env.FC_MAX_TURNS || "3", 10);
const MAX_COMMANDS = parseInt(process.env.FC_MAX_COMMANDS || "8", 10);
const TIMEOUT_MS = parseInt(process.env.FC_TIMEOUT_MS || "30000", 10);

const server = new McpServer({
  name: "windsurf-fast-context",
  version: "1.1.0",
  instructions:
    "Windsurf Fast Context — AI-driven semantic code search. " +
    "Returns file paths with line ranges and grep keywords.\n" +
    "Tunable parameters:\n" +
    "- tree_depth (1-6, default 3): How much directory structure the remote AI sees. " +
    "REDUCE if you get payload/size errors. INCREASE for small projects where deeper structure helps.\n" +
    "- max_turns (1-5, default 3): How many search rounds. " +
    "INCREASE if results are incomplete. Use 1 for quick lookups.\n" +
    "The response includes [config] and [diagnostic] lines — read them to decide if you should retry with different parameters.",
});

// ─── Tool: fast_context_search ─────────────────────────────

server.tool(
  "fast_context_search",
  "AI-driven semantic code search using Windsurf's Devstral model. " +
    "Searches a codebase with natural language and returns relevant file paths with line ranges, " +
    "plus suggested grep keywords for follow-up searches.\n" +
    "Parameter tuning guide:\n" +
    "- tree_depth: Controls how much directory structure the remote AI sees before searching. " +
    "If you get a payload/size error, REDUCE this value. " +
    "If search results are too shallow (missing files in deep subdirectories), INCREASE this value.\n" +
    "- max_turns: Controls how many search-execute-feedback rounds the remote AI gets. " +
    "If results are incomplete or the AI didn't find enough files, INCREASE this value. " +
    "If you want a quick rough answer, use 1.\n" +
    "Response includes a [config] line showing actual parameters used — use this to decide adjustments on retry.",
  {
    query: z.string().describe(
      'Natural language search query (e.g. "where is auth handled", "database connection pool")'
    ),
    project_path: z
      .string()
      .default("")
      .describe("Absolute path to project root. Empty = current working directory."),
    tree_depth: z
      .number()
      .int()
      .min(1)
      .max(6)
      .default(3)
      .describe(
        "Directory tree depth for the initial repo map sent to the remote AI. " +
        "Default 3. Use 1-2 for huge monorepos (>5000 files) or if you get payload size errors. " +
        "Use 4-6 for small projects (<200 files) where you want the AI to see deeper structure. " +
        "Auto falls back to a lower depth if tree output exceeds 250KB."
      ),
    max_turns: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(MAX_TURNS)
      .describe(
        "Number of search rounds. Each round: remote AI generates search commands → local execution → results sent back. " +
        "Default 3. Use 1 for quick simple lookups. Use 4-5 for complex queries requiring deep tracing across many files. " +
        "More rounds = better results but slower and uses more API quota."
      ),
  },
  async ({ query, project_path, tree_depth, max_turns }) => {
    let projectPath = project_path || process.cwd();

    try {
      const { statSync } = await import("node:fs");
      if (!statSync(projectPath).isDirectory()) {
        return { content: [{ type: "text", text: `Error: project path does not exist: ${projectPath}` }] };
      }
    } catch {
      return { content: [{ type: "text", text: `Error: project path does not exist: ${projectPath}` }] };
    }

    try {
      const result = await searchWithContent({
        query,
        projectRoot: projectPath,
        maxTurns: max_turns,
        maxCommands: MAX_COMMANDS,
        treeDepth: tree_depth,
        timeoutMs: TIMEOUT_MS,
      });
      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}\n\n[hint] If this is a payload size error, try reducing tree_depth (current: ${tree_depth}).` }] };
    }
  }
);

// ─── Tool: extract_windsurf_key ────────────────────────────

server.tool(
  "extract_windsurf_key",
  "Extract Windsurf API Key from local installation. " +
    "Auto-detects OS (macOS/Windows/Linux) and reads the API key from " +
    "Windsurf's local database. Set the result as WINDSURF_API_KEY env var.",
  {},
  async () => {
    const result = extractKeyInfo();

    if (result.error) {
      const text = `Error: ${result.error}\n${result.hint || ""}\nDB path: ${result.db_path || "N/A"}`;
      return { content: [{ type: "text", text }] };
    }

    const key = result.api_key;
    const text =
      `Windsurf API Key extracted successfully\n\n` +
      `  Key: ${key.slice(0, 30)}...${key.slice(-10)}\n` +
      `  Length: ${key.length}\n` +
      `  Source: ${result.db_path}\n\n` +
      `Usage:\n` +
      `  export WINDSURF_API_KEY="${key}"`;

    return { content: [{ type: "text", text }] };
  }
);

// ─── Start ─────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
