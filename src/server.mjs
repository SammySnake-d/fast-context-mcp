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

const server = new McpServer({
  name: "windsurf-fast-context",
  version: "1.0.0",
  instructions:
    "Windsurf Fast Context — AI-driven semantic code search. " +
    "Returns file paths with line ranges and grep keywords.",
});

// ─── Tool: fast_context_search ─────────────────────────────

server.tool(
  "fast_context_search",
  "AI-driven semantic code search. " +
    "Returns file paths with line ranges and grep keywords.",
  {
    query: z.string().describe(
      'Natural language search query (e.g. "where is auth handled", "database connection pool")'
    ),
    project_path: z
      .string()
      .default("")
      .describe("Absolute path to project root. Empty = current working directory."),
  },
  async ({ query, project_path }) => {
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
        maxTurns: MAX_TURNS,
        maxCommands: MAX_COMMANDS,
      });
      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
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
