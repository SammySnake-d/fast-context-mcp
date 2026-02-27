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
 *   FC_TIMEOUT_MS        — Connect-Timeout-Ms for streaming requests (default: 30000)
 *
 * Start:
 *   node src/server.mjs
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { searchWithContent, extractKeyInfo } from "./core.mjs";

/**
 * Parse an integer env var with optional clamping.
 * @param {string} name
 * @param {number} defaultValue
 * @param {{ min?: number, max?: number }} [opts]
 * @returns {number}
 */
function readIntEnv(name, defaultValue, opts = {}) {
  const raw = process.env[name];
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  const min = typeof opts.min === "number" ? opts.min : null;
  const max = typeof opts.max === "number" ? opts.max : null;
  let value = parsed;
  if (min !== null) value = Math.max(min, value);
  if (max !== null) value = Math.min(max, value);
  return value;
}

/**
 * Parse a boolean env var.
 * @param {string} name
 * @param {boolean} defaultValue
 * @returns {boolean}
 */
function readBoolEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  const v = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return defaultValue;
}

// Read config from environment
const MAX_TURNS = readIntEnv("FC_MAX_TURNS", 3, { min: 1, max: 5 });
const MAX_COMMANDS = readIntEnv("FC_MAX_COMMANDS", 8, { min: 1, max: 20 });
const TIMEOUT_MS = readIntEnv("FC_TIMEOUT_MS", 30000, { min: 1000, max: 300000 });

// Repo-map optimizer defaults
const DEFAULT_REPO_MAP_MODE = process.env.FC_REPO_MAP_MODE === "classic" ? "classic" : "bootstrap_hotspot";
const DEFAULT_BOOTSTRAP_TREE_DEPTH = readIntEnv("FC_BOOTSTRAP_TREE_DEPTH", 1, { min: 1, max: 3 });
const DEFAULT_HOTSPOT_TOP_K = readIntEnv("FC_HOTSPOT_TOP_K", 4, { min: 0, max: 8 });
const DEFAULT_HOTSPOT_TREE_DEPTH = readIntEnv("FC_HOTSPOT_TREE_DEPTH", 2, { min: 1, max: 4 });
const DEFAULT_HOTSPOT_MAX_BYTES = readIntEnv("FC_HOTSPOT_MAX_BYTES", 122880, { min: 16384, max: 262144 });
const DEFAULT_BOOTSTRAP_ENABLED = readBoolEnv("FC_BOOTSTRAP_ENABLED", true);
const DEFAULT_BOOTSTRAP_MAX_TURNS = readIntEnv("FC_BOOTSTRAP_MAX_TURNS", 2, { min: 1, max: 3 });
const DEFAULT_BOOTSTRAP_MAX_COMMANDS = readIntEnv("FC_BOOTSTRAP_MAX_COMMANDS", 6, { min: 1, max: 8 });

const server = new McpServer({
  name: "windsurf-fast-context",
  version: "1.2.0",
  instructions:
    "Windsurf Fast Context — AI-driven semantic code search. " +
    "Returns file paths with line ranges and grep keywords.\n" +
    "Tunable parameters:\n" +
    "- tree_depth (0-6, default 3; 0=auto): How much directory structure the remote AI sees. " +
    "REDUCE if you get payload/size errors. INCREASE for small projects where deeper structure helps.\n" +
    "- max_turns (1-5, default 3): How many search rounds. " +
    "INCREASE if results are incomplete. Use 1 for quick lookups.\n" +
    "- max_results (1-30, default 10): Maximum number of files to return.\n" +
    "- exclude_paths (string array, default []): Directory/file patterns to exclude from tree. " +
    "Use for large repos to reduce payload size (e.g. ['node_modules', 'dist', '.git']).\n" +
    "- repo_map_mode (classic | bootstrap_hotspot, default bootstrap_hotspot): Repo-map build strategy.\n" +
    "- bootstrap_tree_depth (1-3, default 1): Bootstrap tree depth used by bootstrap_hotspot mode.\n" +
    "- hotspot_top_k (0-8, default 4): Number of hotspot top-level directories to include.\n" +
    "- hotspot_tree_depth (1-4, default 2): Tree depth for each hotspot subtree.\n" +
    "- hotspot_max_bytes (16384-262144, default 122880): Repo-map byte budget in bootstrap_hotspot mode.\n" +
    "- bootstrap_enabled (default true): Enable standalone bootstrap phase for hotspot hint collection.\n" +
    "- bootstrap_max_turns (1-3, default 2): Bootstrap phase turns.\n" +
    "- bootstrap_max_commands (1-8, default 6): Bootstrap commands per turn.\n" +
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
  "If search results are too shallow (missing files in deep subdirectories), INCREASE this value. " +
  "Use 0 for auto depth based on project size.\n" +
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
      .min(0)
      .max(6)
      .default(3)
      .describe(
        "Directory tree depth for the initial repo map sent to the remote AI. " +
        "Use 0 for auto depth based on project size. " +
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
    max_results: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(10)
      .describe(
        "Maximum number of files to return. Default 10. " +
        "Use a smaller value (3-5) for focused queries. " +
        "Use a larger value (15-30) for broad exploration queries."
      ),
    exclude_paths: z
      .array(z.string())
      .default([])
      .describe(
        "Directory/file patterns to exclude from tree and search context. " +
        "Useful for reducing payload size on large repos. " +
        "Examples: ['node_modules', 'dist', '.git', 'build', 'coverage', '*.min.*']"
      ),
    repo_map_mode: z
      .enum(["classic", "bootstrap_hotspot"])
      .default(DEFAULT_REPO_MAP_MODE)
      .describe(
        "Repo map strategy. classic = single tree map. bootstrap_hotspot = bootstrap mini-tree + query-scored hotspot subtrees."
      ),
    bootstrap_tree_depth: z
      .number()
      .int()
      .min(1)
      .max(3)
      .default(DEFAULT_BOOTSTRAP_TREE_DEPTH)
      .describe("Bootstrap tree depth used when repo_map_mode=bootstrap_hotspot."),
    hotspot_top_k: z
      .number()
      .int()
      .min(0)
      .max(8)
      .default(DEFAULT_HOTSPOT_TOP_K)
      .describe("Maximum number of hotspot top-level directories to append in repo map."),
    hotspot_tree_depth: z
      .number()
      .int()
      .min(1)
      .max(4)
      .default(DEFAULT_HOTSPOT_TREE_DEPTH)
      .describe("Tree depth for each hotspot subtree in repo map."),
    hotspot_max_bytes: z
      .number()
      .int()
      .min(16384)
      .max(262144)
      .default(DEFAULT_HOTSPOT_MAX_BYTES)
      .describe("Maximum bytes budget for optimized repo map output."),
    bootstrap_enabled: z
      .boolean()
      .default(DEFAULT_BOOTSTRAP_ENABLED)
      .describe("Enable standalone bootstrap phase before main search phase."),
    bootstrap_max_turns: z
      .number()
      .int()
      .min(1)
      .max(3)
      .default(DEFAULT_BOOTSTRAP_MAX_TURNS)
      .describe("Max turns for bootstrap phase (independent from main max_turns)."),
    bootstrap_max_commands: z
      .number()
      .int()
      .min(1)
      .max(8)
      .default(DEFAULT_BOOTSTRAP_MAX_COMMANDS)
      .describe("Max commands per turn for bootstrap phase."),
  },
  async ({
    query,
    project_path,
    tree_depth,
    max_turns,
    max_results,
    exclude_paths,
    repo_map_mode,
    bootstrap_tree_depth,
    hotspot_top_k,
    hotspot_tree_depth,
    hotspot_max_bytes,
    bootstrap_enabled,
    bootstrap_max_turns,
    bootstrap_max_commands,
  }) => {
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
        maxResults: max_results,
        treeDepth: tree_depth,
        timeoutMs: TIMEOUT_MS,
        excludePaths: exclude_paths,
        repoMapMode: repo_map_mode,
        bootstrapTreeDepth: bootstrap_tree_depth,
        hotspotTopK: hotspot_top_k,
        hotspotTreeDepth: hotspot_tree_depth,
        hotspotMaxBytes: hotspot_max_bytes,
        bootstrapEnabled: bootstrap_enabled,
        bootstrapMaxTurns: bootstrap_max_turns,
        bootstrapMaxCommands: bootstrap_max_commands,
      });
      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      const code = e.code || "UNKNOWN";
      return {
        content: [{
          type: "text", text:
            `Error [${code}]: ${e.message}\n\n` +
            `[hint] Suggestions based on error type:\n` +
            `  - Reduce tree_depth (current: ${tree_depth})\n` +
            `  - Add exclude_paths to filter large directories (e.g. ['node_modules', 'dist'])\n` +
            `  - Narrow project_path to a subdirectory\n` +
            `  - Reduce max_turns (current: ${max_turns})`
        }]
      };
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
    const result = await extractKeyInfo();

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
