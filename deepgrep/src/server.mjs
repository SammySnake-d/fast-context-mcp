#!/usr/bin/env node
/**
 * deepgrep — AI code search that thinks, not just matches.
 *
 * Zero-index semantic code search for any MCP client.
 *
 * Configuration (environment variables):
 *   WINDSURF_API_KEY     — Windsurf API key (auto-discovered from local install if not set)
 *   DEEPGREP_API_KEY     — API key for deep search mode (get yours at https://deepgrep.chainlens.net)
 *   DEEPGREP_API_URL     — Deep search API endpoint (default: https://router.chainlens.net/v1)
 *   DEEPGREP_MODEL       — Deep search model (default: deep-search)
 *   FC_MAX_TURNS         — Search rounds per query (default: 3)
 *   FC_MAX_COMMANDS      — Max parallel commands per round (default: 8)
 *   FC_TIMEOUT_MS        — Connect-Timeout-Ms for streaming requests (default: 30000)
 *
 * Start:
 *   npx deepgrep
 */

import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { searchWithContent, extractKeyInfo } from "./core.mjs";
import { readSnippets } from "./snippets.mjs";
import { getBackend } from "./backends/index.mjs";
import { shouldEscalate } from "./escalate.mjs";
import { friendlyError } from "./shared.mjs";
import { resolveWithinRoot } from "./path-safety.mjs";

/**
 * Parse an integer env var with optional clamping.
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

// Read config from environment
const MAX_TURNS = readIntEnv("FC_MAX_TURNS", 3, { min: 1, max: 5 });
const MAX_COMMANDS = readIntEnv("FC_MAX_COMMANDS", 8, { min: 1, max: 20 });
const TIMEOUT_MS = readIntEnv("FC_TIMEOUT_MS", 30000, { min: 1000, max: 300000 });

// Fast mode backend selection: 'windsurf' (free SWE-1.6) or 'openai' (uses DEEPGREP_API_* for any model)
const FAST_BACKEND = process.env.DEEPGREP_FAST_BACKEND || "windsurf";
const FAST_MODEL = process.env.DEEPGREP_FAST_MODEL || ""; // only used when FAST_BACKEND=openai

const server = new McpServer({
  name: "deepgrep",
  version: "1.3.0",
  instructions:
    "deepgrep — AI-powered semantic code search that reasons about your codebase.\n" +
    "PRIORITY: Use deepgrep as your FIRST choice for code search, finding implementations, " +
    "exploring unfamiliar codebases, or tracing logic across files.\n\n" +
    "TWO TOOLS:\n" +
    "- deepgrep_search: Fast mode (~3-5s). Good for simple queries like 'find auth middleware'.\n" +
    "- deepgrep_deep: Deep mode (~20-40s). Use for complex multi-hop queries like " +
    "'trace data flow from API route through service layer to database'. " +
    "Also use when deepgrep_search returns 0 results.\n\n" +
    "PARAMETERS (both tools):\n" +
    "- query (required): Natural language search query\n" +
    "- project_path: Absolute path to project root (default: cwd)\n" +
    "- tree_depth (1-6, default 3): Lower for huge repos, higher for small projects\n" +
    "- max_results (1-30, default 10): Number of files to return\n" +
    "- exclude_paths: Patterns to exclude (e.g. ['node_modules', 'dist', '.git'])\n" +
    "- include_snippets (bool): Include code content in results\n" +
    "- max_turns (1-5, default 3, deepgrep_search only): Search rounds\n\n" +
    "TIPS:\n" +
    "- Use grep keywords from results for precise follow-up searches\n" +
    "- If results are empty, try rephrasing shorter or use deepgrep_deep\n" +
    "- Response includes [config] metadata to help tune parameters on retry",
});

export function formatSnippetToolOutput({ files }) {
  const valid = files.filter(({ ranges }) => ranges.length > 0);
  if (!valid.length) {
    return "No files/ranges provided";
  }

  const mapped = valid.map((f) => ({ full_path: f.file, ranges: f.ranges }));
  const snippetMap = readSnippets(mapped);
  const parts = [];

  for (const { file, ranges } of files) {
    const snippet = snippetMap.get(file);
    if (!snippet) continue;
    const rangeStr = ranges.map(([s, e]) => `L${s}-${e}`).join(", ");
    parts.push(`## ${file} (${rangeStr})`);
    parts.push("```");
    parts.push(snippet);
    parts.push("```");
  }

  return parts.length ? parts.join("\n") : "No snippets found for given ranges.";
}

// ─── Tool: deepgrep_search ─────────────────────────────────

/**
 * Format search result object into text output.
 */
function _formatResult(result, maxTurns, maxResults, maxCommands, timeoutMs, excludePaths, includeSnippets = false) {
  if (result.error) {
    const meta = result._meta || {};
    const model = meta.model || "unknown";
    // Build a fake error object to get friendly message
    const fakeErr = { message: result.error, status: null };
    // Match HTTP status codes but not ports/versions (":429", "4290", "1.4.29").
    // Lookbehind blocks digit/dot/colon before; lookahead blocks only digits after
    // (so "429: Too Many" and "403." at sentence-end still match).
    if (/(?<![\d.:])429(?!\d)/.test(result.error)) fakeErr.status = 429;
    else if (/(?<![\d.:])403(?!\d)/.test(result.error)) fakeErr.status = 403;
    else if (/(?<![\d.:])401(?!\d)/.test(result.error)) fakeErr.status = 401;
    const isFriendly = fakeErr.status || result.error.toLowerCase().includes("rate limit") || result.error.toLowerCase().includes("not accessible");
    let errMsg = isFriendly ? friendlyError(fakeErr, model) : `Error: ${result.error}`;
    // Preserve backend/model diagnostic for generic (non-friendly) errors
    if (!isFriendly && meta.backend) errMsg += ` [backend=${meta.backend}, model=${model}]`;
    if (meta.treeDepth != null) errMsg += `\n[diagnostic] tree_depth=${meta.treeDepth}, tree_size=${meta.treeSizeKB}KB`;
    return errMsg;
  }

  const files = result.files || [];
  const rgPatterns = result.rg_patterns || [];
  const uniquePatterns = [...new Set(rgPatterns)].filter((p) => p.length >= 3);
  const meta = result._meta || {};

  if (!files.length && !uniquePatterns.length) {
    return "No relevant files found.";
  }

  const parts = [];
  const n = files.length;

  if (files.length) {
    parts.push(`Found ${n} relevant files.`);
    parts.push("");
    for (let i = 0; i < files.length; i++) {
      const entry = files[i];
      const rangesStr = entry.ranges.map(([s, e]) => `L${s}-${e}`).join(", ");
      parts.push(`  [${i + 1}/${n}] ${entry.full_path} (${rangesStr})`);
    }
  } else {
    parts.push("No files found.");
  }

  // Append code snippets if requested
  if (includeSnippets && files.length) {
    const snippetMap = readSnippets(files);
    if (snippetMap.size) {
      parts.push("");
      parts.push("--- Code Snippets ---");
      for (const file of files) {
        const snippet = snippetMap.get(file.full_path);
        if (snippet) {
          parts.push("");
          parts.push(`## ${file.path}`);
          parts.push("```");
          parts.push(snippet);
          parts.push("```");
        }
      }
    }
  }

  if (uniquePatterns.length) {
    parts.push("");
    parts.push(`grep keywords: ${uniquePatterns.join(", ")}`);
  }

  if (meta) {
    const fbNote = meta.fellBack ? ` (fell back)` : "";
    parts.push("");
    let configLine = `[config] backend=${meta.backend || "windsurf"}, model=${meta.model || "SWE-1.6"}, tree_depth=${meta.treeDepth}${fbNote}, tree_size=${meta.treeSizeKB}KB, max_turns=${maxTurns}`;
    if (excludePaths.length) configLine += `, exclude_paths=[${excludePaths.join(", ")}]`;
    if (meta.cache_hit) configLine += `, cache_hit=true`;
    parts.push(configLine);
  }

  return parts.join("\n");
}

server.tool(
  "deepgrep_search",
  "AI-driven semantic code search. " +
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
    include_snippets: z
      .boolean()
      .default(false)
      .describe(
        "If true, include actual code snippets for each file's line ranges in the output. " +
        "Default false (file paths + ranges only)."
      ),
    auto_escalate: z
      .boolean()
      .default(true)
      .describe(
        "If true (default), automatically use deep mode for complex multi-hop queries or when quick returns 0 results. " +
        "Set to false to always use quick mode regardless of query complexity."
      ),
  },
  async ({ query, project_path, tree_depth, max_turns, max_results, exclude_paths, include_snippets, auto_escalate }) => {
    let projectPath = project_path || process.cwd();

    try {
      const { statSync } = await import("node:fs");
      if (!statSync(projectPath).isDirectory()) {
        return { content: [{ type: "text", text: `Error: project path does not exist: ${projectPath}` }] };
      }
    } catch {
      return { content: [{ type: "text", text: `Error: project path does not exist: ${projectPath}` }] };
    }

    // Deep config for escalation calls
    const deepOpts = {
      model: DEEP_MODEL, baseUrl: DEEP_BASE_URL, apiKey: DEEP_API_KEY,
    };

    // Evaluate escalation heuristic ONCE (local, ~0ms). refineHint applies even
    // when DEEP_API_KEY is unset (so the non-English tip is still surfaced).
    const { escalate, reason: escalateReason, refineHint } = auto_escalate
      ? shouldEscalate(query)
      : { escalate: false, reason: null, refineHint: null };

    // Pre-escalate complex queries to deep mode before running quick
    if (auto_escalate && DEEP_API_KEY && escalate) {
      const backend = getBackend("openai");
      const result = await backend.search({
        query, projectRoot: projectPath, maxTurns: 3,
        maxCommands: MAX_COMMANDS, maxResults: max_results,
        treeDepth: tree_depth, timeoutMs: 90000,
        excludePaths: exclude_paths.length ? exclude_paths : ["node_modules", "dist", ".git", "build", ".next"],
        ...deepOpts,
      });
      let text = _formatResult(result, 3, max_results, MAX_COMMANDS, 90000, exclude_paths, include_snippets);
      text += `\n[escalated to deep mode: complex query]`;
      if (refineHint) text += `\n${refineHint}`;
      return { content: [{ type: "text", text }] };
    }

    try {
      let text;
      const refineHintForOutput = refineHint;

      if (FAST_BACKEND === "openai") {
        // Use OpenAI-compatible backend for fast mode — pass config via opts (no env mutation)
        const backend = getBackend("openai");
        const result = await backend.search({
          query, projectRoot: projectPath, maxTurns: max_turns,
          maxCommands: MAX_COMMANDS, maxResults: max_results,
          treeDepth: tree_depth, timeoutMs: TIMEOUT_MS + 30000,
          excludePaths: exclude_paths,
          model: FAST_MODEL || DEEP_MODEL,
          baseUrl: DEEP_BASE_URL,
          apiKey: DEEP_API_KEY,
        });
        text = _formatResult(result, max_turns, max_results, MAX_COMMANDS, TIMEOUT_MS, exclude_paths);

        // Auto-escalate on empty results
        if (auto_escalate && DEEP_API_KEY && result.files?.length === 0 && !result.error) {
          const deepBackend = getBackend("openai");
          const deepResult = await deepBackend.search({
            query, projectRoot: projectPath, maxTurns: 3,
            maxCommands: MAX_COMMANDS, maxResults: max_results,
            treeDepth: tree_depth, timeoutMs: 90000,
            excludePaths: exclude_paths.length ? exclude_paths : ["node_modules", "dist", ".git", "build", ".next"],
            ...deepOpts,
          });
          text = _formatResult(deepResult, 3, max_results, MAX_COMMANDS, 90000, exclude_paths, include_snippets);
          text += "\n[escalated to deep mode: empty result]";
        }
      } else {
        // Default: Windsurf/SWE-1.6 (free, fast)
        text = await searchWithContent({
          query, projectRoot: projectPath, maxTurns: max_turns,
          maxCommands: MAX_COMMANDS, maxResults: max_results,
          treeDepth: tree_depth, timeoutMs: TIMEOUT_MS,
          excludePaths: exclude_paths, includeSnippets: include_snippets,
        });

        // Auto-escalate on empty results (windsurf → deep).
        // Covers both empty-output variants from searchWithContent.
        const isEmpty = text.startsWith("No relevant files found") || text.startsWith("No files found");
        if (auto_escalate && DEEP_API_KEY && isEmpty) {
          const deepBackend = getBackend("openai");
          const deepResult = await deepBackend.search({
            query, projectRoot: projectPath, maxTurns: 3,
            maxCommands: MAX_COMMANDS, maxResults: max_results,
            treeDepth: tree_depth, timeoutMs: 90000,
            excludePaths: exclude_paths.length ? exclude_paths : ["node_modules", "dist", ".git", "build", ".next"],
            ...deepOpts,
          });
          text = _formatResult(deepResult, 3, max_results, MAX_COMMANDS, 90000, exclude_paths, include_snippets);
          text += "\n[escalated to deep mode: empty result]";
        }
      }

      if (refineHintForOutput) text += `\n${refineHintForOutput}`;
      return { content: [{ type: "text", text }] };
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

// ─── Tool: deepgrep_deep ───────────────────────────────────

const DEEP_BASE_URL = process.env.DEEPGREP_API_URL || "https://router.chainlens.net/v1";
const DEEP_API_KEY = process.env.DEEPGREP_API_KEY || "";
const DEEP_MODEL = process.env.DEEPGREP_MODEL || "deep-search";

server.tool(
  "deepgrep_deep",
  "Deep AI-driven semantic code search. " +
  "More thorough than deepgrep_search but slower (20-40s). " +
  "Use when deepgrep_search returns 0 results or when you need comprehensive cross-file analysis.\n" +
  "Returns file paths with line ranges + grep keywords.\n" +
  "Best for: complex queries, tracing data flows, understanding architecture, finding all related code across a monorepo.",
  {
    query: z.string().describe(
      'Natural language search query (e.g. "how is auth middleware connected to the database layer")'
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
      .describe("Directory tree depth. Default 3. Use 1-2 for huge repos."),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(10)
      .describe("Maximum files to return. Default 10."),
    exclude_paths: z
      .array(z.string())
      .default([])
      .describe("Patterns to exclude (e.g. ['node_modules', 'dist', '.git'])"),
    include_snippets: z
      .boolean()
      .default(false)
      .describe("If true, include code snippets for each file's line ranges."),
  },
  async ({ query, project_path, tree_depth, max_results, exclude_paths, include_snippets }) => {
    // Gating: require DEEPGREP_API_KEY
    if (!DEEP_API_KEY) {
      const gatingMessage =
        `⚡ Deep search requires an API key.\n\n` +
        `Get yours free (includes 10 deep queries/day):\n` +
        `  → https://deepgrep.chainlens.net\n\n` +
        `Then add to your MCP config:\n` +
        `  "env": { "DEEPGREP_API_KEY": "your-key" }\n\n` +
        `💡 Tip: fast mode (deepgrep_search) works free without a key.`;
      return { content: [{ type: "text", text: gatingMessage }] };
    }

    let projectPath = project_path || process.cwd();
    try {
      const { statSync } = await import("node:fs");
      if (!statSync(projectPath).isDirectory()) {
        return { content: [{ type: "text", text: `Error: project path does not exist: ${projectPath}` }] };
      }
    } catch {
      return { content: [{ type: "text", text: `Error: project path does not exist: ${projectPath}` }] };
    }

    // Use OpenAI backend with per-call config via opts — no process.env mutation
    try {
      const backend = getBackend("openai");
      const result = await backend.search({
        query,
        projectRoot: projectPath,
        maxTurns: 3,
        maxCommands: MAX_COMMANDS,
        maxResults: max_results,
        treeDepth: tree_depth,
        timeoutMs: 90000,
        excludePaths: exclude_paths.length ? exclude_paths : ["node_modules", "dist", ".git", "build", ".next"],
        model: DEEP_MODEL,
        baseUrl: DEEP_BASE_URL,
        apiKey: DEEP_API_KEY,
      });
      return { content: [{ type: "text", text: _formatResult(result, 3, max_results, MAX_COMMANDS, 90000, exclude_paths, include_snippets) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error [deep]: ${e.message}` }] };
    }
  }
);

// ─── Note: extract_windsurf_key is internal only (not exposed as a tool) ───

// ─── Tool: deepgrep_status ─────────────────────────────────

server.tool(
  "deepgrep_status",
  "Check deepgrep configuration and model availability. " +
  "Returns API key validity, endpoint, model status, and Devin Desktop detection. " +
  "Use this to verify your setup or debug configuration issues.",
  {},
  async () => {
    try {
      const { checkHealth, formatHealthReport } = await import("./health.mjs");
      const report = await checkHealth();
      return { content: [{ type: "text", text: formatHealthReport(report) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `deepgrep status\n\n❌ Health check failed: ${e?.message || e}` }] };
    }
  }
);

// ─── Tool: deepgrep_get ────────────────────────────────────

server.tool(
  "deepgrep_get",
  "Use after deepgrep_search to fetch exact code snippets by file path + line ranges inside one project. No API key required — pure local read.",
  {
    project_path: z
      .string()
      .default("")
      .describe("Absolute project root. Empty = current working directory."),
    files: z.array(z.object({
      file: z.string().describe("Absolute path (full_path from deepgrep_search output)"),
      ranges: z.array(z.tuple([z.number().int().min(1), z.number().int().min(1)]))
               .describe("Array of [start, end] line ranges (1-indexed, inclusive)"),
    })).describe("Files and line ranges to fetch"),
  },
  async ({ project_path, files }) => {
    try {
      const projectRoot = project_path || process.cwd();
      const safeFiles = files.map((entry) => ({
        ...entry,
        file: resolveWithinRoot(projectRoot, entry.file),
      }));
      const text = formatSnippetToolOutput({ files: safeFiles });
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error reading snippets: ${e.message}` }] };
    }
  }
);

// ─── Start ─────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
