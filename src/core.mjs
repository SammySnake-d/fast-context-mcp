/**
 * Windsurf Fast Context — core protocol implementation (Node.js).
 *
 * Reverse-engineered Windsurf SWE-grep Connect-RPC/Protobuf protocol
 * for standalone AI-driven semantic code search.
 *
 * Flow:
 *   query + tree → Windsurf Devstral API
 *   → Devstral returns tool_calls (rg/readfile/tree/ls/glob, up to 8 parallel)
 *   → execute locally → send results back → repeat for N rounds
 *   → ANSWER: file paths + line ranges + suggested rg patterns
 */

import { readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join, relative, sep, isAbsolute } from "node:path";
import { gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { platform, arch, release, version as osVersion, hostname, cpus, totalmem } from "node:os";
import treeNodeCli from "tree-node-cli";

import {
  ProtobufEncoder,
  extractStrings,
  connectFrameEncode,
  connectFrameDecode,
} from "./protobuf.mjs";
import { ToolExecutor } from "./executor.mjs";
import { extractKey } from "./extract-key.mjs";
import { scoreDirectories, tokenize as tokenizeBM25 } from "./directory-scorer.mjs";

// ─── Error Classification ──────────────────────────────────

/**
 * Classified error for fetch failures with structured error codes.
 */
class FastContextError extends Error {
  /**
   * @param {string} message
   * @param {string} code - TIMEOUT | PAYLOAD_TOO_LARGE | RATE_LIMITED | AUTH_ERROR | SERVER_ERROR | NETWORK_ERROR
   * @param {Object} [details]
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = "FastContextError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Classify a raw fetch/HTTP error into a FastContextError.
 * @param {Error} err
 * @returns {FastContextError}
 */
function _classifyError(err) {
  if (err instanceof FastContextError) return err;

  // HTTP status-based classification
  if (err.status) {
    const s = err.status;
    if (s === 413) return new FastContextError(err.message, "PAYLOAD_TOO_LARGE", { status: s });
    if (s === 429) return new FastContextError(err.message, "RATE_LIMITED", { status: s });
    if (s === 401 || s === 403) return new FastContextError(err.message, "AUTH_ERROR", { status: s });
    return new FastContextError(err.message, "SERVER_ERROR", { status: s });
  }

  // Timeout (AbortSignal.timeout throws AbortError or TimeoutError)
  if (err.name === "AbortError" || err.name === "TimeoutError" || /timeout/i.test(err.message)) {
    return new FastContextError(err.message, "TIMEOUT");
  }

  // Everything else is a network-level issue
  return new FastContextError(err.message, "NETWORK_ERROR");
}

// ─── Protocol Constants ────────────────────────────────────

const API_BASE = "https://server.self-serve.windsurf.com/exa.api_server_pb.ApiServerService";
const AUTH_BASE = "https://server.self-serve.windsurf.com/exa.auth_pb.AuthService";
const WS_APP = "windsurf";
const WS_APP_VER = process.env.WS_APP_VER || "1.48.2";
const WS_LS_VER = process.env.WS_LS_VER || "1.9544.35";
const WS_MODEL = process.env.WS_MODEL || "MODEL_SWE_1_6_FAST";
const DEBUG_MODE = process.env.FAST_CONTEXT_DEBUG === "1" || process.env.FAST_CONTEXT_DEBUG === "true";

// Default excludes aligned with Windsurf fast-search guidance.
// Minimal defaults — only dirs that are almost never source code.
// Users can add more via the exclude_paths parameter.
const DEFAULT_EXCLUDE_PATHS = [
  "node_modules",
  ".git",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "*.min.*",
];

// Repo-map optimization defaults (tunable via MCP params).
const REPO_MAP_OPTIMIZER_DEFAULTS = {
  mode: "bootstrap_hotspot", // classic | bootstrap_hotspot
  bootstrapTreeDepth: 1,
  hotspotTopK: 4,
  hotspotTreeDepth: 2,
  maxBytes: 120 * 1024,
};

function _mergeExcludePaths(excludePaths = []) {
  const merged = [...DEFAULT_EXCLUDE_PATHS];
  for (const p of excludePaths || []) {
    if (typeof p === "string" && p && !merged.includes(p)) {
      merged.push(p);
    }
  }
  return merged;
}

// ─── System Prompt Template ────────────────────────────────

const SYSTEM_PROMPT_TEMPLATE = `You are an expert software engineer, responsible for providing context \
to another engineer to solve a code issue in the current codebase. \
The user will present you with a description of the issue, and it is \
your job to provide a series of file paths with associated line ranges \
that contain ALL the information relevant to understand and correctly \
address the issue.

# IMPORTANT:
- A relevant file does not mean only the files that must be modified to \
solve the task. It means any file that contains information relevant to \
planning and implementing the fix, such as the definitions of classes \
and functions that are relevant to the pieces of code that will have to \
be modified.
- You should include enough context around the relevant lines to allow \
the engineer to understand the task correctly. You must include ENTIRE \
semantic blocks (functions, classes, definitions, etc). For example:
If addressing the issue requires modifying a method within a class, then \
you should include the entire class definition, not just the lines around \
the method we want to modify.
- NEVER truncate these blocks unless they are very large (hundreds of \
lines or more, in which case providing only a relevant portion of the \
block is acceptable).
- Your job is to essentially alleviate the job of the other engineer by \
giving them a clean starting context from which to start working. More \
precisely, you should minimize the number of files the engineer has to \
read to understand and solve the task correctly (while not providing \
irrelevant code snippets).

# ENVIRONMENT
- Working directory: /codebase. Make sure to run commands in this \
directory, not \`.
- Tool access: use the restricted_exec tool ONLY
- Allowed sub-commands (schema-enforced):
  - rg: Search for patterns in files using ripgrep
    - Required: pattern (string), path (string)
    - Optional: include (array of globs), exclude (array of globs)
  - readfile: Read contents of a file with optional line range
    - Required: file (string)
    - Optional: start_line (int), end_line (int) — 1-indexed, inclusive
  - tree: Display directory structure as a tree
    - Required: path (string)
    - Optional: levels (int)

# THINKING RULES
- Think step-by-step. Plan, reason, and reflect before each tool call.
- Use tool calls liberally and purposefully to ground every conclusion \
in real code, not assumptions.
- If a command fails, rethink and try something different; do not \
complain to the user.
- AVOID REDUNDANT SEARCHES: Do not search for the same pattern multiple \
times with slightly different paths or excludes. One well-targeted search \
is better than multiple overlapping ones.
- PRIORITIZE READING over searching: Once you find a file path, read it \
directly instead of searching for more variations of the same pattern.

# FAST-SEARCH DEFAULTS (optimize rg/tree on large repos)
- Start NARROW, then widen only if needed. Prefer searching likely code \
roots first (e.g., \`src/\`, \`lib/\`, \`app/\`, \`packages/\`, \`services/\`) \
instead of \`/codebase\`.
- Prefer fixed-string search for literals: escape patterns or keep regex \
simple. Use smart case; avoid case-insensitive unless necessary.
- Prefer file-type filters and globs (in include) over full-repo scans.
- Default EXCLUDES for speed (apply via the exclude array): \
node_modules, .git, dist, build, coverage, .venv, venv, target, out, \
.cache, __pycache__, vendor, deps, third_party, logs, data, *.min.*
- Skip huge files where possible; when opening files, prefer reading \
only relevant ranges with readfile.
- Limit directory traversal with tree levels to quickly orient before \
deeper inspection.

# SOME EXAMPLES OF WORKFLOWS
- MAP – Use \`tree\` with small levels; \`rg\` on likely roots to grasp \
structure and hotspots.
- ANCHOR – \`rg\` for problem keywords and anchor symbols; restrict by \
language globs via include.
- TRACE – Follow imports with targeted \`rg\` in narrowed roots; open \
files with \`readfile\` scoped to entire semantic blocks.
- VERIFY – Confirm each candidate path exists by reading or additional \
searches; drop false positives (tests, vendored, generated) unless they \
must change.

# TOOL USE GUIDELINES
- You must use a SINGLE restricted_exec call in your answer, that lets \
you execute at most {max_commands} commands in a single turn. Each command must be \
an object with a \`type\` field of \`rg\`, \`readfile\`, or \`tree\` and the appropriate fields for that type.
- Example restricted_exec usage:
[TOOL_CALLS]restricted_exec[ARGS]{{
  "command1": {{
    "type": "rg",
    "pattern": "Controller",
    "path": "/codebase/slime",
    "include": ["**/*.py"],
    "exclude": ["**/node_modules/**", "**/.git/**", "**/dist/**", \
"**/build/**", "**/.venv/**", "**/__pycache__/**"]
  }},
  "command2": {{
    "type": "readfile",
    "file": "/codebase/slime/train.py",
    "start_line": 1,
    "end_line": 200
  }},
  "command3": {{
    "type": "tree",
    "path": "/codebase/slime/",
    "levels": 2
  }}
}}
- You have at most {max_turns} turns to interact with the environment by calling \
tools, so issuing multiple commands at once is necessary and encouraged \
to speed up your research.
- Each command result may be truncated to 50 lines; prefer multiple \
targeted reads/searches to build complete context.
- DO NOT EVER USE MORE THAN {max_commands} commands in a single turn, or you will \
be penalized.

# ANSWER FORMAT (strict format, including tags)
- You will output an XML structure with a root element "ANSWER" \
containing "file" elements. Each "file" element will have a "path" \
attribute and contain "range" elements.
- You will output this as your final response.
- The line ranges must be inclusive.

Output example inside the "answer" tool argument:
<ANSWER>
  <file path="/codebase/info_theory/formulas/entropy.py">
    <range>10-60</range>
    <range>150-210</range>
  </file>
  <file path="/codebase/info_theory/data_structures/bits.py">
    <range>1-40</range>
    <range>110-170</range>
  </file>
</ANSWER>


Remember: Prefer narrow, fixed-string, and type-filtered searches with \
aggressive excludes and size/depth limits. Widen scope only as needed. \
Use the restricted tools available to you, and output your answer in \
exactly the specified format.

# NO RESULTS POLICY
If after thorough searching you are confident that NO relevant files exist \
for the given query (e.g., the function/class/concept does not exist in the \
codebase), you MUST return an empty ANSWER:
<ANSWER></ANSWER>
Do NOT return irrelevant files (such as entry points or config files) just \
to provide some output. An empty answer is always better than a misleading one.

# RESULT COUNT
Aim to return at most {max_results} files in your answer. Focus on the most \
relevant files first. If fewer files are relevant, return fewer.
`;

const FINAL_FORCE_ANSWER =
  "You have no turns left. Now you MUST provide your final ANSWER, even if it's not complete.";

const BOOTSTRAP_PROMPT_TEMPLATE = `You are a bootstrap planning agent for codebase hotspot discovery.
Your ONLY goal is to discover high-signal search keywords and hotspot directories for a later full search phase.

# OUTPUT CONTRACT
- Use the restricted_exec tool ONLY.
- Prefer rg + tree commands. Avoid deep readfile unless absolutely necessary.
- Do NOT output final <ANSWER> for code fixes in this phase.
- Keep commands focused and broad enough to identify likely relevant modules quickly.

# TOOL BUDGET
- You have at most {max_turns} turns.
- You may use up to {max_commands} commands per turn.

# STRATEGY
1) Start from the provided mini repo map.
2) Use targeted rg patterns derived from the user problem.
3) Use tree on likely top-level directories to identify hotspots.
4) Stop once you have enough keyword and hotspot coverage for phase-2.
`;

/**
 * Smart trim accumulated messages to reduce payload size.
 *
 * Why this is needed:
 * - Proto size grows quickly across turns (messages + tool results).
 * - Keeping only the last N messages naively may drop the tool-call ↔ tool-result
 *   linkage (tool_call_id/ref_call_id) and remove useful progress context.
 *
 * Strategy:
 * - Keep system prompt (index 0).
 * - Keep user problem statement, but compact the repo map when trimming.
 * - Keep the latest tool-call + tool-result pair (plus any trailing prompts).
 * - Insert a compact progress summary so the model doesn't lose the thread.
 *
 * @param {Array} messages
 * @param {Object} [state]
 * @param {string} [state.query]
 * @param {string[]} [state.recentFiles]
 * @param {string[]} [state.recentPatterns]
 * @param {Array<{type:string, desc:string}>} [state.recentCommands]
 * @param {number} [state.turn]
 * @returns {boolean} true if messages were actually trimmed/compacted
 */
function _trimMessages(messages, state = {}) {
  if (!Array.isArray(messages) || messages.length < 2) return false;

  const systemMsg = messages[0];
  const userMsg = messages[1];

  const truncateToolResultsPreserve = (text, maxPerBlock = 4000, maxTotal = 20000) => {
    if (typeof text !== "string" || text.length <= maxTotal) return text;
    const re = /<(command\d+)_result>\n([\s\S]*?)\n<\/\1_result>/g;
    let m;
    const parts = [];
    let matched = false;
    while ((m = re.exec(text)) !== null) {
      matched = true;
      const key = m[1];
      let body = m[2] || "";
      if (body.length > maxPerBlock) {
        body = body.slice(0, maxPerBlock) + "\n...[truncated]...";
      }
      parts.push(`<${key}_result>\n${body}\n</${key}_result>`);
      if (parts.join("").length > maxTotal) break;
    }
    if (!matched) {
      return text.slice(0, maxTotal) + "\n...[tool results truncated]...";
    }
    const out = parts.join("");
    return out.length <= maxTotal ? out : out.slice(0, maxTotal) + "\n...[tool results truncated]...";
  };

  // Find the most recent tool-result message and its matching tool-call message (if present).
  let lastToolResultIdx = -1;
  let refId = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 4 && typeof m.ref_call_id === "string" && m.ref_call_id) {
      lastToolResultIdx = i;
      refId = m.ref_call_id;
      break;
    }
  }

  let lastToolCallIdx = -1;
  if (refId) {
    for (let i = lastToolResultIdx - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === 2 && m.tool_call_id === refId) {
        lastToolCallIdx = i;
        break;
      }
    }
  }

  // Tail: keep tool-call + tool-result pair, plus anything after it (e.g., force-answer).
  let tailStart = -1;
  if (lastToolResultIdx !== -1) {
    tailStart = lastToolCallIdx !== -1 ? lastToolCallIdx : Math.max(2, lastToolResultIdx - 1);
  } else {
    // No tool results yet: keep the last few messages only.
    tailStart = Math.max(2, messages.length - 4);
  }
  const tail = messages.slice(tailStart);

  // Compact the user message (repo map) when trimming, since it's usually the largest chunk.
  let compactedUser = userMsg;
  let didCompactUser = false;
  if (userMsg && typeof userMsg.content === "string" && userMsg.content.includes("Repo Map")) {
    const q =
      (typeof state.query === "string" && state.query) ||
      userMsg.content.match(/Problem Statement:\s*([^\n]+)/)?.[1]?.trim() ||
      "";
    const compact = `Problem Statement: ${q}\n\nRepo Map: (omitted to reduce payload). Use tree/rg to explore structure if needed.`;
    if (compact.length < userMsg.content.length) {
      compactedUser = { ...userMsg, content: compact };
      didCompactUser = true;
    }
  }

  // Build a compact progress summary to preserve important context across trims.
  const recentCommands = Array.isArray(state.recentCommands) ? state.recentCommands : [];
  const recentFiles = Array.isArray(state.recentFiles) ? state.recentFiles : [];
  const recentPatterns = Array.isArray(state.recentPatterns) ? state.recentPatterns : [];
  const turnNote = Number.isInteger(state.turn) ? ` turn=${state.turn}` : "";

  const summaryLines = [
    `[Context trimmed to reduce payload size.${turnNote}]`,
    recentCommands.length ? `recent_commands: ${recentCommands.slice(-6).map((c) => c.desc).join(" | ")}` : "",
    recentFiles.length ? `recent_files: ${recentFiles.slice(-12).join(", ")}` : "",
    recentPatterns.length ? `rg_patterns: ${recentPatterns.slice(-20).join(", ")}` : "",
    "Continue from the most recent tool results kept below.",
  ].filter(Boolean);

  const summaryMsg = { role: 1, content: summaryLines.join("\n") };

  // If trimming doesn't actually reduce anything, bail.
  // We consider it "useful" if we either compact the user message or drop history.
  const willDropHistory = tailStart > 2;
  if (!didCompactUser && !willDropHistory) return false;

  // Reduce oversized assistant/tool messages in the tail to avoid immediate re-overflow.
  for (const m of tail) {
    if (m && typeof m.content === "string") {
      if (m.role === 2 && m.content.length > 8000) {
        m.content = m.content.slice(0, 8000) + "\n...[assistant content truncated]...";
      }
      if (m.role === 4 && m.content.length > 20000) {
        m.content = truncateToolResultsPreserve(m.content, 4000, 20000);
      }
    }
  }

  messages.length = 0;
  messages.push(systemMsg);
  // Avoid duplicating user message if it's already within the kept tail.
  if (tailStart > 1) {
    messages.push(compactedUser);
  }
  messages.push(summaryMsg, ...tail);
  return true;
}

/**
 * @param {number} maxTurns
 * @param {number} maxCommands
 * @param {number} maxResults
 * @returns {string}
 */
function buildSystemPrompt(maxTurns = 3, maxCommands = 8, maxResults = 10) {
  return SYSTEM_PROMPT_TEMPLATE
    .replaceAll("{max_turns}", String(maxTurns))
    .replaceAll("{max_commands}", String(maxCommands))
    .replaceAll("{max_results}", String(maxResults));
}

function buildBootstrapPrompt(maxTurns = 2, maxCommands = 6) {
  return BOOTSTRAP_PROMPT_TEMPLATE
    .replaceAll("{max_turns}", String(maxTurns))
    .replaceAll("{max_commands}", String(maxCommands));
}

function _extractTopDirFromCodebasePath(path = "") {
  const p = String(path || "").replace(/\\/g, "/");
  if (!p.startsWith("/codebase")) return null;
  const rel = p.replace(/^\/codebase\/?/, "");
  if (!rel) return null;
  return rel.split("/")[0] || null;
}

async function _runBootstrapPhase({
  query,
  projectRoot,
  apiKey,
  jwt,
  timeoutMs,
  excludePaths,
  bootstrapTreeDepth,
  bootstrapMaxTurns,
  bootstrapMaxCommands,
  onProgress,
}) {
  const log = (msg) => onProgress?.(`[bootstrap] ${msg}`);
  const hints = { rgPatterns: [], hotDirs: [] };

  try {
    const { tree: miniMap, depth } = getRepoMap(projectRoot, bootstrapTreeDepth, excludePaths);
    const systemPrompt = buildBootstrapPrompt(bootstrapMaxTurns, bootstrapMaxCommands);
    const userContent = `Problem Statement: ${query}\n\nRepo Map (tree -L ${depth} /codebase):\n\`\`\`text\n${miniMap}\n\`\`\``;

    const messages = [
      { role: 5, content: systemPrompt },
      { role: 1, content: userContent },
    ];

    const toolDefs = getToolDefinitions(bootstrapMaxCommands);
    const executor = new ToolExecutor(projectRoot);

    for (let turn = 0; turn < bootstrapMaxTurns; turn++) {
      log(`Turn ${turn + 1}/${bootstrapMaxTurns}`);
      const proto = _buildRequest(apiKey, jwt, messages, toolDefs);
      let respData;
      try {
        respData = await _streamingRequest(proto, timeoutMs);
      } catch (e) {
        log(`request failed: ${e.code || "UNKNOWN"}`);
        break;
      }

      const [thinking, toolInfo] = _parseResponse(respData);
      if (!toolInfo) break;

      const [toolName, toolArgs] = toolInfo;
      if (toolName !== "restricted_exec") break;

      const callId = randomUUID();
      const argsJson = JSON.stringify(toolArgs);
      const cmds = Object.keys(toolArgs).filter((k) => k.startsWith("command"));

      for (const cmdKey of cmds) {
        const cmd = toolArgs[cmdKey];
        if (!cmd || typeof cmd !== "object") continue;
        if (cmd.type === "rg" && typeof cmd.pattern === "string" && cmd.pattern) {
          hints.rgPatterns.push(cmd.pattern);
        }
        if (cmd.type === "tree" && typeof cmd.path === "string") {
          const top = _extractTopDirFromCodebasePath(cmd.path);
          if (top) hints.hotDirs.push(top);
        }
      }

      const results = await executor.execToolCallAsync(toolArgs);
      messages.push({
        role: 2,
        content: thinking,
        tool_call_id: callId,
        tool_name: "restricted_exec",
        tool_args_json: argsJson,
      });
      messages.push({ role: 4, content: results, ref_call_id: callId });
    }
  } catch {
    // Bootstrap is best-effort. Fall back silently.
  }

  return {
    rgPatterns: [...new Set(hints.rgPatterns)].slice(-30),
    hotDirs: [...new Set(hints.hotDirs)].slice(-12),
  };
}

// ─── Tool Schema ───────────────────────────────────────────

function _buildCommandSchema(n) {
  return {
    type: "object",
    description: `Command ${n} to execute. Must be one of: rg, readfile, or tree.`,
    oneOf: [
      {
        properties: {
          type: { type: "string", const: "rg", description: "Search for patterns in files using ripgrep." },
          pattern: { type: "string", description: "The regex pattern to search for." },
          path: { type: "string", description: "The path to search in." },
          include: { type: "array", items: { type: "string" }, description: "File patterns to include." },
          exclude: { type: "array", items: { type: "string" }, description: "File patterns to exclude." },
        },
        required: ["type", "pattern", "path"],
      },
      {
        properties: {
          type: { type: "string", const: "readfile", description: "Read contents of a file with optional line range." },
          file: { type: "string", description: "Path to the file to read." },
          start_line: { type: "integer", description: "Starting line number (1-indexed)." },
          end_line: { type: "integer", description: "Ending line number (1-indexed)." },
        },
        required: ["type", "file"],
      },
      {
        properties: {
          type: { type: "string", const: "tree", description: "Display directory structure as a tree." },
          path: { type: "string", description: "Path to the directory." },
          levels: { type: "integer", description: "Number of directory levels." },
        },
        required: ["type", "path"],
      },
      {
        properties: {
          type: { type: "string", const: "ls", description: "List files in a directory." },
          path: { type: "string", description: "Path to the directory." },
          long_format: { type: "boolean" },
          all: { type: "boolean" },
        },
        required: ["type", "path"],
      },
      {
        properties: {
          type: { type: "string", const: "glob", description: "Find files matching a glob pattern." },
          pattern: { type: "string" },
          path: { type: "string" },
          type_filter: { type: "string", enum: ["file", "directory", "all"] },
        },
        required: ["type", "pattern", "path"],
      },
    ],
  };
}

/**
 * @param {number} maxCommands
 * @returns {string}
 */
function getToolDefinitions(maxCommands = 8) {
  const props = {};
  for (let i = 1; i <= maxCommands; i++) {
    props[`command${i}`] = _buildCommandSchema(i);
  }
  const tools = [
    {
      type: "function",
      function: {
        name: "restricted_exec",
        description: "Execute restricted commands (rg, readfile, tree, ls, glob) in parallel.",
        parameters: { type: "object", properties: props, required: ["command1"] },
      },
    },
    {
      type: "function",
      function: {
        name: "answer",
        description: "Final answer with relevant files and line ranges.",
        parameters: {
          type: "object",
          properties: { answer: { type: "string", description: "The final answer in XML format." } },
          required: ["answer"],
        },
      },
    },
  ];
  return JSON.stringify(tools);
}

// ─── Credentials ───────────────────────────────────────────

/**
 * Auto-discover Windsurf API key from local installation.
 * @returns {Promise<string|null>}
 */
async function autoDiscoverApiKey() {
  try {
    const result = await extractKey();
    if (result.api_key && result.api_key.startsWith("sk-")) {
      return result.api_key;
    }
  } catch {
    // Extraction failed
  }
  return null;
}

/**
 * Get API key from env var or auto-discovery.
 * @returns {Promise<string>}
 */
async function getApiKey() {
  const key = process.env.WINDSURF_API_KEY;
  if (key) return key;
  const discovered = await autoDiscoverApiKey();
  if (discovered) return discovered;
  throw new Error(
    "Windsurf API Key not found. Set WINDSURF_API_KEY env var or ensure Windsurf is logged in. " +
    "Run extract-key.mjs to see extraction methods."
  );
}

// ─── JWT Cache ──────────────────────────────────────────────

/** @type {Map<string, { token: string, expiresAt: number }>} */
const _jwtCache = new Map();

/**
 * Decode JWT payload and extract expiration time.
 * @param {string} jwt
 * @returns {number} expiration timestamp in seconds
 */
function _getJwtExp(jwt) {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return 0;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    return payload.exp || 0;
  } catch {
    return 0;
  }
}

/**
 * Get a cached or fresh JWT token.
 * Refreshes when token expires or is within 60s of expiration.
 * @param {string} apiKey
 * @returns {Promise<string>}
 */
async function getCachedJwt(apiKey) {
  const now = Math.floor(Date.now() / 1000);
  const cached = _jwtCache.get(apiKey);
  if (cached && cached.expiresAt > now + 60) return cached.token;
  const token = await fetchJwt(apiKey);
  const exp = _getJwtExp(token);
  _jwtCache.set(apiKey, { token, expiresAt: exp || now + 3600 });
  return token;
}

// ─── TLS Fallback ──────────────────────────────────────────
// Match Python's SSL fallback: if NODE_TLS_REJECT_UNAUTHORIZED is not set
// and the first fetch fails with a TLS error, disable cert verification.
let _tlsFallbackApplied = false;

function _applyTlsFallback() {
  if (!_tlsFallbackApplied && !process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    _tlsFallbackApplied = true;
    process.stderr.write(
      "[fast-context] WARNING: TLS certificate verification disabled due to connection failure. " +
      "Set NODE_TLS_REJECT_UNAUTHORIZED=0 explicitly to suppress this warning.\n"
    );
  }
}

// ─── Network Layer ─────────────────────────────────────────

/**
 * Standard unary HTTP POST with proto content type.
 * @param {string} url
 * @param {Buffer} protoBytes
 * @param {boolean} [compress=true]
 * @returns {Promise<Buffer>}
 */
async function _unaryRequest(url, protoBytes, compress = true) {
  const headers = {
    "Content-Type": "application/proto",
    "Connect-Protocol-Version": "1",
    "User-Agent": "connect-go/1.18.1 (go1.25.5)",
    "Accept-Encoding": "gzip",
  };

  let body;
  if (compress) {
    body = gzipSync(protoBytes);
    headers["Content-Encoding"] = "gzip";
  } else {
    body = protoBytes;
  }

  const doFetch = () => fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(30000),
  });

  let resp;
  try {
    resp = await doFetch();
  } catch (e) {
    // TLS or network error — try with cert verification disabled
    _applyTlsFallback();
    try {
      resp = await doFetch();
    } catch (e2) {
      throw _classifyError(e2);
    }
  }

  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status}`);
    err.status = resp.status;
    throw _classifyError(err);
  }

  const arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/**
 * Connect-RPC streaming POST to GetDevstralStream with retry.
 * @param {Buffer} protoBytes
 * @param {number} [timeoutMs=30000]
 * @param {number} [maxRetries=2]
 * @returns {Promise<Buffer>}
 */
async function _streamingRequest(protoBytes, timeoutMs = 30000, maxRetries = 2) {
  const frame = connectFrameEncode(protoBytes);
  const url = `${API_BASE}/GetDevstralStream`;
  const traceId = randomUUID().replace(/-/g, "");
  const spanId = randomUUID().replace(/-/g, "").slice(0, 16);
  const baseTimeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : 30000;
  const abortMs = baseTimeoutMs + 5000;

  const headers = {
    "Content-Type": "application/connect+proto",
    "Connect-Protocol-Version": "1",
    "Connect-Accept-Encoding": "gzip",
    "Connect-Content-Encoding": "gzip",
    "Connect-Timeout-Ms": String(baseTimeoutMs),
    "User-Agent": "connect-go/1.18.1 (go1.25.5)",
    "Accept-Encoding": "identity",
    "Baggage": `sentry-release=language-server-windsurf@${WS_LS_VER},` +
      `sentry-environment=stable,sentry-sampled=false,` +
      `sentry-trace_id=${traceId},` +
      `sentry-public_key=b813f73488da69eedec534dba1029111`,
    "Sentry-Trace": `${traceId}-${spanId}-0`,
  };

  const doFetch = () => fetch(url, {
    method: "POST",
    headers,
    body: frame,
    signal: AbortSignal.timeout(abortMs),
  });

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      let resp;
      try {
        resp = await doFetch();
      } catch (e) {
        if (attempt === 0) {
          _applyTlsFallback();
          resp = await doFetch();
        } else {
          throw e;
        }
      }

      if (!resp.ok) {
        const err = new Error(`HTTP ${resp.status}`);
        err.status = resp.status;
        // Don't retry on 4xx client errors (except 429)
        if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
          throw err;
        }
        lastErr = err;
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw err;
      }

      const arrayBuf = await resp.arrayBuffer();
      return Buffer.from(arrayBuf);
    } catch (e) {
      lastErr = e;
      // Don't retry on 4xx client errors (except 429)
      if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) {
        throw _classifyError(e);
      }
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
    }
  }
  throw _classifyError(lastErr);
}

/**
 * Authenticate with API key to get JWT token.
 * @param {string} apiKey
 * @returns {Promise<string>}
 */
async function fetchJwt(apiKey) {
  const meta = new ProtobufEncoder();
  meta.writeString(1, WS_APP);
  meta.writeString(2, WS_APP_VER);
  meta.writeString(3, apiKey);
  meta.writeString(4, "zh-cn");
  meta.writeString(7, WS_LS_VER);
  meta.writeString(12, WS_APP);
  meta.writeBytes(30, Buffer.from([0x00, 0x01]));

  const outer = new ProtobufEncoder();
  outer.writeMessage(1, meta);

  const resp = await _unaryRequest(`${AUTH_BASE}/GetUserJwt`, outer.toBuffer(), false);
  for (const s of extractStrings(resp)) {
    if (s.startsWith("eyJ") && s.includes(".")) {
      return s;
    }
  }
  throw new Error("Failed to extract JWT from GetUserJwt response");
}

/**
 * Check rate limit. Returns true if OK, false if rate-limited.
 * @param {string} apiKey
 * @param {string} jwt
 * @returns {Promise<boolean>}
 */
async function checkRateLimit(apiKey, jwt) {
  const req = new ProtobufEncoder();
  req.writeMessage(1, _buildMetadata(apiKey, jwt));
  req.writeString(3, WS_MODEL);

  try {
    await _unaryRequest(`${API_BASE}/CheckUserMessageRateLimit`, req.toBuffer(), true);
    return true;
  } catch (e) {
    if (e.status === 429) return false;
    return true; // Don't block on network issues
  }
}

// ─── Request Building ──────────────────────────────────────

/**
 * Build protobuf metadata with app info, system info, JWT, etc.
 * @param {string} apiKey
 * @param {string} jwt
 * @returns {ProtobufEncoder}
 */
function _buildMetadata(apiKey, jwt) {
  const meta = new ProtobufEncoder();
  meta.writeString(1, WS_APP);
  meta.writeString(2, WS_APP_VER);
  meta.writeString(3, apiKey);
  meta.writeString(4, "zh-cn");

  const plat = platform();
  const sysInfo = {
    Os: plat,
    Arch: arch(),
    Release: release(),
    Version: osVersion(),
    Machine: arch(),
    Nodename: hostname(),
    Sysname: plat === "darwin" ? "Darwin" : plat === "win32" ? "Windows_NT" : "Linux",
    ProductVersion: "",
  };
  meta.writeString(5, JSON.stringify(sysInfo));
  meta.writeString(7, WS_LS_VER);

  const cpuList = cpus();
  const ncpu = cpuList.length || 4;
  const mem = totalmem();
  const cpuInfo = {
    NumSockets: 1,
    NumCores: ncpu,
    NumThreads: ncpu,
    VendorID: "",
    Family: "0",
    Model: "0",
    ModelName: cpuList[0]?.model || "Unknown",
    Memory: mem,
  };
  meta.writeString(8, JSON.stringify(cpuInfo));
  meta.writeString(12, WS_APP);
  meta.writeString(21, jwt);
  meta.writeBytes(30, Buffer.from([0x00, 0x01]));
  return meta;
}

/**
 * Build a chat message protobuf.
 * @param {number} role - 1=user, 2=assistant, 4=tool_result, 5=system
 * @param {string} content
 * @param {Object} [opts]
 * @param {string} [opts.toolCallId]
 * @param {string} [opts.toolName]
 * @param {string} [opts.toolArgsJson]
 * @param {string} [opts.refCallId]
 * @returns {ProtobufEncoder}
 */
function _buildChatMessage(role, content, opts = {}) {
  const msg = new ProtobufEncoder();
  msg.writeVarint(2, role);
  msg.writeString(3, content);

  if (opts.toolCallId && opts.toolName && opts.toolArgsJson) {
    const tc = new ProtobufEncoder();
    tc.writeString(1, opts.toolCallId);
    tc.writeString(2, opts.toolName);
    tc.writeString(3, opts.toolArgsJson);
    msg.writeMessage(6, tc);
  }

  if (opts.refCallId) {
    msg.writeString(7, opts.refCallId);
  }

  return msg;
}

/**
 * Build a full request with metadata, messages, and tool definitions.
 * @param {string} apiKey
 * @param {string} jwt
 * @param {Array} messages
 * @param {string} toolDefs
 * @returns {Buffer}
 */
function _buildRequest(apiKey, jwt, messages, toolDefs) {
  const req = new ProtobufEncoder();
  req.writeMessage(1, _buildMetadata(apiKey, jwt));

  for (const m of messages) {
    const msgEnc = _buildChatMessage(m.role, m.content, {
      toolCallId: m.tool_call_id,
      toolName: m.tool_name,
      toolArgsJson: m.tool_args_json,
      refCallId: m.ref_call_id,
    });
    req.writeMessage(2, msgEnc);
  }

  req.writeString(3, toolDefs);
  return req.toBuffer();
}

// ─── Response Parsing ──────────────────────────────────────

/**
 * Strip invalid UTF-8 bytes from a Buffer → clean string.
 * Matches Python's bytes.decode("utf-8", errors="ignore").
 * @param {Buffer} buf
 * @returns {string}
 */
function stripInvalidUtf8(buf) {
  return buf.toString("utf-8").replace(/\ufffd/g, "");
}

/**
 * Parse tool call from [TOOL_CALLS]name[ARGS]{json} format.
 * @param {string} text
 * @returns {[string, string, Object]|null} [thinking, name, args] or null
 */
function _parseToolCall(text) {
  text = text.replace(/<\/s>/g, "");
  const m = text.match(/\[TOOL_CALLS\](\w+)\[ARGS\](\{.+)/s);
  if (!m) return null;

  const name = m[1];
  const raw = m[2].trim();

  // Find matching closing brace
  let depth = 0;
  let end = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === 0) end = raw.length;

  let args;
  const jsonCandidate = raw.slice(0, end);
  try {
    args = JSON.parse(jsonCandidate);
  } catch {
    // Attempt lenient fix: unquoted keys like  exclude":  →  "exclude":
    try {
      const fixed = jsonCandidate.replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');
      args = JSON.parse(fixed);
    } catch {
      return null;
    }
  }

  const thinking = text.slice(0, m.index).trim();
  return [thinking, name, args];
}

/**
 * Parse streaming response: decode frames, extract text, parse tool calls.
 * @param {Buffer} data
 * @returns {[string, [string, Object]|null]} [text, toolInfo]
 */
function _parseResponse(data) {
  const frames = connectFrameDecode(data);
  let allText = "";

  for (const frameData of frames) {
    // Check for error JSON
    try {
      const textCandidate = frameData.toString("utf-8");
      if (textCandidate.startsWith("{")) {
        const errObj = JSON.parse(textCandidate);
        if (errObj.error) {
          const code = errObj.error.code || "unknown";
          const msg = errObj.error.message || "";
          return [`[Error] ${code}: ${msg}`, null];
        }
      }
    } catch {
      // Not JSON, continue
    }

    // Extract text from frame — strip invalid UTF-8 (matches Python errors="ignore")
    const rawText = stripInvalidUtf8(frameData);
    if (rawText.includes("[TOOL_CALLS]")) {
      allText = rawText;
      break;
    }

    for (const s of extractStrings(frameData)) {
      if (s.length > 10) {
        allText += s;
      }
    }
  }

  const parsed = _parseToolCall(allText);
  if (parsed) {
    const [thinking, name, args] = parsed;
    return [thinking, [name, args]];
  }
  return [allText, null];
}

// ─── Core Search ───────────────────────────────────────────

// Max safe tree size in bytes (server payload limit ~346KB, fixed overhead ~26KB,
// leave room for conversation accumulation across rounds)
const MAX_TREE_BYTES = 250 * 1024;

/**
 * Convert an exclude pattern (directory/file name or simple glob) to RegExp
 * for tree-node-cli's exclude option.
 * @param {string} pattern - e.g. "node_modules", "dist", "*.min.*"
 * @returns {RegExp}
 */
function _excludePatternToRegex(pattern) {
  if (!/[*?]/.test(pattern)) {
    // Simple name — exact match
    return new RegExp("^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$");
  }
  // Glob → regex
  let regex = "^";
  for (const c of pattern) {
    if (c === "*") regex += ".*";
    else if (c === "?") regex += ".";
    else if (".+^${}()|[]\\".includes(c)) regex += "\\" + c;
    else regex += c;
  }
  regex += "$";
  return new RegExp(regex);
}

/**
 * Count files in a directory (non-recursive, fast estimate).
 * @param {string} dir
 * @returns {number}
 */
function _countFilesQuick(dir) {
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}

/**
 * Estimate project size and suggest optimal tree depth.
 * - Small project (< 500 entries): depth 4
 * - Medium project (500-5000 entries): depth 3
 * - Large project (> 5000 entries): depth 2
 * @param {string} projectRoot
 * @returns {number}
 */
function _suggestTreeDepth(projectRoot) {
  const count = _countFilesQuick(projectRoot);
  if (count < 500) return 4;
  if (count <= 5000) return 3;
  return 2;
}

function _normalizeTreeRoot(treeStr, absRoot, virtualRoot = "/codebase") {
  const rootPattern = new RegExp(absRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  let out = String(treeStr || "").replace(rootPattern, virtualRoot);
  const lines = out.split("\n");
  const dirName = absRoot.split("/").pop() || absRoot.split("\\").pop() || absRoot;
  if (lines[0] === dirName) {
    lines[0] = virtualRoot;
    out = lines.join("\n");
  }
  return out;
}

/**
 * Get a directory tree of the project with adaptive depth fallback.
 *
 * Tries the requested depth first. If the tree output exceeds MAX_TREE_BYTES,
 * automatically falls back to lower depths until it fits.
 *
 * @param {string} projectRoot
 * @param {number} [targetDepth=3] - Desired tree depth (0-6), 0 means auto
 * @param {string[]} [excludePaths=[]] - Patterns to exclude from tree
 * @returns {{ tree: string, depth: number, sizeBytes: number, fellBack: boolean, autoDepth: boolean }}
 */
function getRepoMap(projectRoot, targetDepth = 3, excludePaths = []) {
  // Auto depth: if targetDepth is 0, use heuristic
  const autoDepth = targetDepth === 0;
  if (autoDepth) {
    targetDepth = _suggestTreeDepth(projectRoot);
  }
  const excludeRegexes = excludePaths.length ? excludePaths.map(_excludePatternToRegex) : [];

  for (let L = targetDepth; L >= 1; L--) {
    try {
      const opts = { maxDepth: L };
      if (excludeRegexes.length) opts.exclude = excludeRegexes;
      const stdout = treeNodeCli(projectRoot, opts);
      // Normalize root to /codebase consistently.
      let treeStr = _normalizeTreeRoot(stdout, projectRoot, "/codebase");
      const sizeBytes = Buffer.byteLength(treeStr, "utf-8");

      if (sizeBytes <= MAX_TREE_BYTES) {
        return { tree: treeStr, depth: L, sizeBytes, fellBack: L < targetDepth, autoDepth };
      }
      // Too large, try lower depth
    } catch {
      // tree failed at this level, try lower
    }
  }

  // Ultimate fallback: simple ls (also respects excludePaths)
  try {
    let entries = readdirSync(projectRoot).sort();
    if (excludeRegexes.length) {
      entries = entries.filter((e) => !excludeRegexes.some((rx) => rx.test(e)));
    }
    const treeStr = ["/codebase", ...entries.map((e) => `├── ${e}`)].join("\n");
    return { tree: treeStr, depth: 0, sizeBytes: Buffer.byteLength(treeStr, "utf-8"), fellBack: true, autoDepth };
  } catch {
    const treeStr = "/codebase\n(empty or inaccessible)";
    return { tree: treeStr, depth: 0, sizeBytes: treeStr.length, fellBack: true, autoDepth };
  }
}

function _tokenizeQuery(query = "") {
  return [...new Set(
    String(query)
      .toLowerCase()
      .split(/[^a-z0-9_\-]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3)
  )];
}

function _scoreTopLevelDir(dirName, queryTokens = []) {
  const name = String(dirName || "").toLowerCase();
  let score = 0;

  const commonRoots = ["src", "app", "lib", "packages", "services", "server", "backend", "frontend", "api"];
  if (commonRoots.includes(name)) score += 2;

  for (const token of queryTokens) {
    if (name.includes(token)) score += 4;
  }

  return score;
}

function _listTopLevelDirs(projectRoot, excludePaths = []) {
  const excludeRegexes = excludePaths.length ? excludePaths.map(_excludePatternToRegex) : [];
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(projectRoot).sort();
  } catch {
    return out;
  }

  for (const e of entries) {
    if (excludeRegexes.some((rx) => rx.test(e))) continue;
    const abs = join(projectRoot, e);
    try {
      if (statSync(abs).isDirectory()) out.push(e);
    } catch {
      // ignore
    }
  }
  return out;
}

function _buildSubtreeForDir(projectRoot, dir, levels = 2) {
  const abs = join(projectRoot, dir);
  const vRoot = `/codebase/${dir}`;
  try {
    const stdout = treeNodeCli(abs, { maxDepth: levels });
    return _normalizeTreeRoot(stdout, abs, vRoot);
  } catch {
    return `${vRoot}\n  (failed to generate subtree)`;
  }
}

function buildOptimizedRepoMap({
  query,
  projectRoot,
  treeDepth,
  excludePaths,
  optimizer = {},
  bootstrapHints = null,
  onProgress = null,
}) {
  const log = (msg) => onProgress?.(msg);
  const cfg = { ...REPO_MAP_OPTIMIZER_DEFAULTS, ...(optimizer || {}) };
  if (cfg.mode === "classic") {
    const base = getRepoMap(projectRoot, treeDepth, excludePaths);
    return {
      ...base,
      strategy: "classic",
      hotDirs: [],
    };
  }

  const bootstrapDepth = Math.max(1, Math.min(3, Number(cfg.bootstrapTreeDepth) || 1));
  const hotspotTopK = Math.max(0, Math.min(8, Number(cfg.hotspotTopK) || 4));
  const hotspotTreeDepth = Math.max(1, Math.min(4, Number(cfg.hotspotTreeDepth) || 2));
  const maxBytes = Math.max(16 * 1024, Number(cfg.maxBytes) || REPO_MAP_OPTIMIZER_DEFAULTS.maxBytes);

  const bootstrap = getRepoMap(projectRoot, bootstrapDepth, excludePaths);
  const topDirs = _listTopLevelDirs(projectRoot, excludePaths);

  // Extract keywords from bootstrap hints (rgPatterns)
  const keywords = bootstrapHints?.rgPatterns || [];

  // Use BM25F + Probe + RRF for directory scoring
  // This replaces the old token-based scoring + commonRoots approach
  let hotDirs = [];
  let pathSpines = [];
  try {
    const results = scoreDirectories(query, projectRoot, topDirs, excludePaths, {
      topK: hotspotTopK,
      useProbe: true, // Enable probe grep signal
      keywords, // Bootstrap keywords
      minReturn: 2, // Always return at least 2 directories for coverage
    });
    hotDirs = results.hotDirs;
    pathSpines = results.pathSpines;
    log(`BM25F scoring: hotDirs=[${hotDirs.join(",")}] pathSpines=${pathSpines.length} signals=${JSON.stringify(results.signals)}`);
  } catch (e) {
    // Lightweight fallback: use quick scoring without commonRoots
    log(`BM25F failed, using quick token scoring: ${e.message}`);
    const queryTerms = tokenizeBM25(query);
    const scored = topDirs.map((d) => {
      const dirTerms = tokenizeBM25(d);
      let score = 0;
      for (const qt of queryTerms) {
        if (dirTerms.some(dt => dt.includes(qt) || qt.includes(dt))) score += 1;
      }
      return { dir: d, score };
    }).sort((a, b) => b.score - a.score);

    // Always return at least topK directories (no score > 0 filter)
    hotDirs = scored.slice(0, hotspotTopK).map((x) => x.dir);
    if (hotDirs.length === 0) hotDirs = topDirs.slice(0, hotspotTopK);
    log(`Quick scoring fallback: ${hotDirs.join(",")}`);
  }

  const hotspotSections = [];
  for (const d of hotDirs) {
    hotspotSections.push(_buildSubtreeForDir(projectRoot, d, hotspotTreeDepth));
  }

  // Build path spines section for deep file visibility
  const pathSpineSection = pathSpines.length > 0
    ? "# Relevant File Paths (from BM25F path spine extraction)\n" + pathSpines.map(p => `- /codebase/${p}`).join("\n")
    : "";

  let tree = bootstrap.tree;
  const sections = [];
  if (hotspotSections.length) {
    sections.push("# Hotspot Subtrees\n" + hotspotSections.join("\n\n"));
  }
  if (pathSpineSection) {
    sections.push(pathSpineSection);
  }
  if (sections.length) {
    tree = `${bootstrap.tree}\n\n${sections.join("\n\n")}`;
  }

  // Keep map under configurable budget.
  let sizeBytes = Buffer.byteLength(tree, "utf-8");
  if (sizeBytes > maxBytes && (hotspotSections.length || pathSpineSection)) {
    // First try removing path spines
    if (pathSpineSection) {
      const withoutSpines = sections.length > 1
        ? `${bootstrap.tree}\n\n${sections[0]}`
        : bootstrap.tree;
      sizeBytes = Buffer.byteLength(withoutSpines, "utf-8");
      if (sizeBytes <= maxBytes) {
        tree = withoutSpines;
      }
    }

    // If still too large, progressively remove hotspot sections
    if (sizeBytes > maxBytes && hotspotSections.length) {
      let kept = [...hotspotSections];
      while (kept.length > 0) {
        kept.pop();
        tree = kept.length
          ? `${bootstrap.tree}\n\n# Hotspot Subtrees\n${kept.join("\n\n")}`
          : bootstrap.tree;
        sizeBytes = Buffer.byteLength(tree, "utf-8");
        if (sizeBytes <= maxBytes) break;
      }
    }
  }

  return {
    tree,
    depth: bootstrap.depth,
    sizeBytes: Buffer.byteLength(tree, "utf-8"),
    fellBack: bootstrap.fellBack,
    autoDepth: bootstrap.autoDepth,
    strategy: "bootstrap_hotspot",
    hotDirs,
  };
}

/**
 * Parse answer XML into structured file + range data.
 * @param {string} xmlText
 * @param {string} projectRoot
 * @returns {{ files: Array }}
 */
function _parseAnswer(xmlText, projectRoot) {
  const files = [];
  const resolvedRoot = resolve(projectRoot);
  const fileRegex = /<file\s+path=(["'])([^"']+)\1>([\s\S]*?)<\/file>/g;
  let fm;
  while ((fm = fileRegex.exec(xmlText)) !== null) {
    const vpath = fm[2];
    let rel = vpath.replace(/^\/codebase[\/\\]?/, "");
    rel = rel.replace(/^[\/\\]+/, "");

    // Path safety: reject traversal attempts (../) and paths outside project root
    const fullPath = resolve(projectRoot, rel);
    const relToRoot = relative(resolvedRoot, fullPath);
    if (relToRoot === ".." || relToRoot.startsWith(`..${sep}`) || isAbsolute(relToRoot)) {
      continue;
    }

    const ranges = [];
    const rangeRegex = /<range>(\d+)-(\d+)<\/range>/g;
    let rm;
    while ((rm = rangeRegex.exec(fm[3])) !== null) {
      ranges.push([parseInt(rm[1], 10), parseInt(rm[2], 10)]);
    }

    files.push({ path: rel, full_path: fullPath, ranges });
  }
  return { files };
}

/**
 * Execute Fast Context search.
 *
 * @param {Object} opts
 * @param {string} opts.query - Natural language search query
 * @param {string} opts.projectRoot - Project root directory
 * @param {string} [opts.apiKey] - Windsurf API key (auto-discovered if not set)
 * @param {string} [opts.jwt] - JWT token (auto-fetched if not set)
 * @param {number} [opts.maxTurns=3] - Search rounds
 * @param {number} [opts.maxCommands=8] - Max commands per round
 * @param {number} [opts.maxResults=10] - Max number of files to return
 * @param {number} [opts.treeDepth=3] - Directory tree depth for repo map (1-6, auto fallback)
 * @param {number} [opts.timeoutMs=30000] - Connect-Timeout-Ms for streaming requests
 * @param {string[]} [opts.excludePaths=[]] - Patterns to exclude from tree
 * @param {function} [opts.onProgress] - Progress callback
 * @returns {Promise<Object>}
 */
export async function search({
  query,
  projectRoot,
  apiKey = null,
  jwt = null,
  maxTurns = 3,
  maxCommands = 8,
  maxResults = 10,
  treeDepth = 3,
  timeoutMs = 30000,
  excludePaths = [],
  repoMapMode = "bootstrap_hotspot",
  bootstrapTreeDepth = 1,
  hotspotTopK = 4,
  hotspotTreeDepth = 2,
  hotspotMaxBytes = 120 * 1024,
  bootstrapEnabled = true,
  bootstrapMaxTurns = 2,
  bootstrapMaxCommands = 6,
  onProgress = null,
}) {
  const log = (msg) => onProgress?.(msg);
  projectRoot = resolve(projectRoot);
  const effectiveExcludePaths = _mergeExcludePaths(excludePaths);

  // Get credentials
  if (!apiKey) {
    apiKey = await getApiKey();
  }
  if (!jwt) {
    log("Fetching JWT...");
    jwt = await getCachedJwt(apiKey);
  }

  // Check rate limit
  log("Checking rate limit...");
  if (!(await checkRateLimit(apiKey, jwt))) {
    return { files: [], error: "Rate limited, please try again later" };
  }

  const executor = new ToolExecutor(projectRoot);
  const toolDefs = getToolDefinitions(maxCommands);
  const systemPrompt = buildSystemPrompt(maxTurns, maxCommands, maxResults);

  let bootstrapHints = null;
  if (bootstrapEnabled) {
    bootstrapHints = await _runBootstrapPhase({
      query,
      projectRoot,
      apiKey,
      jwt,
      timeoutMs,
      excludePaths: effectiveExcludePaths,
      bootstrapTreeDepth,
      bootstrapMaxTurns,
      bootstrapMaxCommands,
      onProgress,
    });
    log(`Bootstrap hints: patterns=${bootstrapHints.rgPatterns.length}, hot_dirs=${bootstrapHints.hotDirs.length}`);
  }

  const { tree: repoMap, depth: actualDepth, sizeBytes: treeSizeBytes, fellBack, autoDepth, strategy: repoMapStrategy, hotDirs = [] } = buildOptimizedRepoMap({
    query,
    projectRoot,
    treeDepth,
    excludePaths: effectiveExcludePaths,
    optimizer: {
      mode: repoMapMode,
      bootstrapTreeDepth,
      hotspotTopK,
      hotspotTreeDepth,
      maxBytes: hotspotMaxBytes,
    },
    bootstrapHints,
    onProgress,
  });
  log(`Repo map: tree -L ${actualDepth} (${(treeSizeBytes / 1024).toFixed(1)}KB)${fellBack ? ` [fell back from L=${treeDepth}]` : ""}${autoDepth ? " [auto]" : ""} [strategy=${repoMapStrategy}]${hotDirs.length ? ` [hot=${hotDirs.join(",")}]` : ""}`);
  const userContent = `Problem Statement: ${query}\n\nRepo Map (tree -L ${actualDepth} /codebase):\n\`\`\`text\n${repoMap}\n\`\`\``;

  const messages = [
    { role: 5, content: systemPrompt },
    { role: 1, content: userContent },
  ];

  // Trim state for smart context trimming
  const trimState = {
    query,
    turn: 0,
    recentFiles: [],
    recentPatterns: [],
    recentCommands: [],
  };

  // Total API calls = maxTurns + 1 (last round for answer)
  const totalApiCalls = maxTurns + 1;
  let compensatedTurns = 0;
  const MAX_COMPENSATIONS = 2;
  let forceAnswerInjected = false;

  for (let turn = 0; turn < totalApiCalls + compensatedTurns; turn++) {
    log(`Turn ${turn + 1}/${totalApiCalls}`);
    trimState.turn = turn + 1;

    let proto = _buildRequest(apiKey, jwt, messages, toolDefs);

    // Debug logging
    if (DEBUG_MODE) {
      console.error(`\n[DEBUG] ===== Turn ${turn + 1} Request =====`);
      console.error(`[DEBUG] Messages count: ${messages.length}`);
      console.error(`[DEBUG] Last message role: ${messages[messages.length - 1]?.role}`);
      console.error(`[DEBUG] Proto size: ${proto.length} bytes`);
    }

    // Preflight trim: proactively reduce payload if proto is already large.
    const MAX_PROTO_BYTES = 320 * 1024;
    if (proto.length > MAX_PROTO_BYTES && messages.length > 1) {
      log(`Proto size ${proto.length} bytes > ${MAX_PROTO_BYTES}. Trimming context before request...`);
      if (_trimMessages(messages, trimState)) {
        proto = _buildRequest(apiKey, jwt, messages, toolDefs);
        if (DEBUG_MODE) console.error(`[DEBUG] Proto size after trim: ${proto.length} bytes`);
      }
    }

    let respData;
    try {
      respData = await _streamingRequest(proto, timeoutMs);
    } catch (e) {
      const errCode = e.code || "UNKNOWN";
      const baseMeta = {
        treeDepth: actualDepth,
        treeSizeKB: +(treeSizeBytes / 1024).toFixed(1),
        fellBack,
        projectRoot,
        errorCode: errCode,
        repoMapStrategy,
        hotDirs,
      };

      // Auto-retry with trimmed context on payload/timeout errors
      if ((errCode === "PAYLOAD_TOO_LARGE" || errCode === "TIMEOUT") && messages.length > 1) {
        log(`${errCode} on turn ${turn + 1}: trimming context and retrying...`);
        _trimMessages(messages, trimState);
        const retryProto = _buildRequest(apiKey, jwt, messages, toolDefs);
        try {
          respData = await _streamingRequest(retryProto, timeoutMs);
        } catch (retryErr) {
          const retryCode = retryErr.code || errCode;
          return {
            files: [],
            error: `${retryCode}: ${retryErr.message} (retry after context trim also failed)`,
            _meta: { ...baseMeta, errorCode: retryCode, contextTrimmed: true },
          };
        }
      } else {
        return {
          files: [],
          error: `${errCode}: ${e.message}`,
          _meta: baseMeta,
        };
      }
    }

    const [thinking, toolInfo] = _parseResponse(respData);

    // Debug logging
    if (DEBUG_MODE) {
      console.error(`\n[DEBUG] ===== Turn ${turn + 1} Response =====`);
      console.error(`[DEBUG] Response size: ${respData.length} bytes`);
      console.error(`[DEBUG] Thinking: ${thinking.slice(0, 500)}${thinking.length > 500 ? '...' : ''}`);
      console.error(`[DEBUG] Tool info: ${toolInfo ? `${toolInfo[0]}` : 'null'}`);
    }

    if (toolInfo === null) {
      if (thinking.startsWith("[Error]")) {
        return { files: [], error: thinking };
      }
      return { files: [], raw_response: thinking };
    }

    const [toolName, toolArgs] = toolInfo;

    if (toolName === "answer") {
      const answerXml = toolArgs.answer || "";
      log("Received final answer");
      const result = _parseAnswer(answerXml, projectRoot);
      result.rg_patterns = [...new Set(executor.collectedRgPatterns)];
      result._meta = {
        treeDepth: actualDepth,
        treeSizeKB: +(treeSizeBytes / 1024).toFixed(1),
        fellBack,
        repoMapStrategy,
        hotDirs,
      };
      return result;
    }

    if (toolName === "restricted_exec") {
      const callId = randomUUID();
      const argsJson = JSON.stringify(toolArgs);

      const cmds = Object.keys(toolArgs).filter((k) => k.startsWith("command"));
      log(`Executing ${cmds.length} local commands`);

      // Debug logging
      if (DEBUG_MODE) {
        console.error(`\n[DEBUG] ===== Tool Calls =====`);
        for (const cmdKey of cmds) {
          const cmd = toolArgs[cmdKey];
          console.error(`[DEBUG] ${cmdKey}: ${JSON.stringify(cmd)}`);
        }
      }

      // Check for valid commands (those with a type field)
      const validCommands = cmds.filter((k) => {
        const cmd = toolArgs[k];
        return cmd && typeof cmd === "object" && cmd.type;
      });
      if (validCommands.length === 0 && compensatedTurns < MAX_COMPENSATIONS) {
        compensatedTurns++;
        log(`Turn compensation: no valid commands, extending search by 1 turn (${compensatedTurns}/${MAX_COMPENSATIONS})`);
      } else if (validCommands.length === 0) {
        log(`Turn compensation skipped: max compensations (${MAX_COMPENSATIONS}) reached, forcing turn advance`);
      }

      const results = await executor.execToolCallAsync(toolArgs);

      // Update trim state with a compact summary of what we executed
      try {
        const tailUnique = (arr, n) => {
          const out = [];
          const seen = new Set();
          for (let i = arr.length - 1; i >= 0 && out.length < n; i--) {
            const v = arr[i];
            if (typeof v !== "string" || !v) continue;
            if (seen.has(v)) continue;
            seen.add(v);
            out.push(v);
          }
          return out.reverse();
        };

        const newCommands = [];
        const newFiles = [];
        const newPatterns = [];

        for (const cmdKey of cmds) {
          const cmd = toolArgs[cmdKey];
          if (!cmd || typeof cmd !== "object") continue;
          const t = cmd.type;
          if (t === "rg" && cmd.pattern) {
            newPatterns.push(cmd.pattern);
            newCommands.push({ type: "rg", desc: `rg ${cmd.pattern}` });
          } else if (t === "readfile" && cmd.file) {
            const shortFile = cmd.file.replace(/^\/codebase\//, "");
            newFiles.push(shortFile);
            newCommands.push({ type: "readfile", desc: `read ${shortFile}` });
          } else if (t === "tree" && cmd.path) {
            newCommands.push({ type: "tree", desc: `tree ${cmd.path}` });
          }
        }

        trimState.recentCommands = [...trimState.recentCommands, ...newCommands].slice(-12);
        trimState.recentFiles = tailUnique([...trimState.recentFiles, ...newFiles], 20);
        trimState.recentPatterns = tailUnique([...trimState.recentPatterns, ...newPatterns], 30);
      } catch {
        // Ignore errors in trim state update
      }

      messages.push({
        role: 2,
        content: thinking,
        tool_call_id: callId,
        tool_name: "restricted_exec",
        tool_args_json: argsJson,
      });
      messages.push({ role: 4, content: results, ref_call_id: callId });

      // Inject force-answer after last effective search round
      const effectiveTurn = turn - compensatedTurns;
      if (effectiveTurn >= maxTurns - 1 && !forceAnswerInjected) {
        messages.push({ role: 1, content: FINAL_FORCE_ANSWER });
        forceAnswerInjected = true;
        log("Injected force-answer prompt");
      }
    }
  }

  return {
    files: [],
    error: "Max turns reached without getting an answer",
    rg_patterns: [...new Set(executor.collectedRgPatterns)],
    _meta: {
      treeDepth: actualDepth,
      treeSizeKB: +(treeSizeBytes / 1024).toFixed(1),
      fellBack,
      projectRoot,
      repoMapStrategy,
      hotDirs,
    },
  };
}

/**
 * Search and return formatted result suitable for MCP tool response.
 *
 * @param {Object} opts
 * @param {string} opts.query
 * @param {string} opts.projectRoot
 * @param {string} [opts.apiKey]
 * @param {number} [opts.maxTurns=3]
 * @param {number} [opts.maxCommands=8]
 * @param {number} [opts.maxResults=10]
 * @param {number} [opts.treeDepth=3]
 * @param {number} [opts.timeoutMs=30000]
 * @param {string[]} [opts.excludePaths=[]]
 * @returns {Promise<string>}
 */
export async function searchWithContent({
  query,
  projectRoot,
  apiKey = null,
  maxTurns = 3,
  maxCommands = 8,
  maxResults = 10,
  treeDepth = 3,
  timeoutMs = 30000,
  excludePaths = [],
  repoMapMode = "bootstrap_hotspot",
  bootstrapTreeDepth = 1,
  hotspotTopK = 4,
  hotspotTreeDepth = 2,
  hotspotMaxBytes = 120 * 1024,
  bootstrapEnabled = true,
  bootstrapMaxTurns = 2,
  bootstrapMaxCommands = 6,
}) {
  const result = await search({
    query,
    projectRoot,
    apiKey,
    maxTurns,
    maxCommands,
    maxResults,
    treeDepth,
    timeoutMs,
    excludePaths,
    repoMapMode,
    bootstrapTreeDepth,
    hotspotTopK,
    hotspotTreeDepth,
    hotspotMaxBytes,
    bootstrapEnabled,
    bootstrapMaxTurns,
    bootstrapMaxCommands,
  });

  if (result.error) {
    const meta = result._meta;
    let errMsg = `Error: ${result.error}`;
    if (meta) {
      errMsg += `\n\n[diagnostic] error_type=${meta.errorCode || "unknown"}, tree_depth_used=${meta.treeDepth}, tree_size=${meta.treeSizeKB}KB`;
      if (meta.fellBack) errMsg += ` (auto fell back from requested depth)`;
      if (meta.contextTrimmed) errMsg += `, context_trimmed=true`;
      if (meta.projectRoot) errMsg += `\n[diagnostic] project_path=${meta.projectRoot}`;
      errMsg += `\n[config] max_turns=${maxTurns}, max_results=${maxResults}, max_commands=${maxCommands}, timeout_ms=${timeoutMs}`;
      if (excludePaths.length) errMsg += `, exclude_paths=[${excludePaths.join(", ")}]`;
      // Targeted hints based on error type
      if (meta.errorCode === "PAYLOAD_TOO_LARGE" || meta.errorCode === "TIMEOUT") {
        errMsg += `\n[hint] Payload/timeout error. Try: reduce tree_depth, reduce max_turns, add exclude_paths, or narrow project_path to a subdirectory.`;
      } else if (meta.errorCode === "AUTH_ERROR") {
        errMsg += `\n[hint] Authentication error. The API key may be expired or revoked. Try re-extracting with extract_windsurf_key, or set a fresh WINDSURF_API_KEY.`;
      } else if (meta.errorCode === "RATE_LIMITED") {
        errMsg += `\n[hint] Rate limited. Wait a moment and retry.`;
      } else {
        errMsg += `\n[hint] If the error is payload-related, try a lower tree_depth value or add exclude_paths.`;
      }
    }
    return errMsg;
  }

  const files = result.files || [];
  const rgPatterns = result.rg_patterns || [];
  // Deduplicate + filter short patterns
  const uniquePatterns = [...new Set(rgPatterns)].filter((p) => p.length >= 3);

  if (!files.length && !uniquePatterns.length) {
    const raw = result.raw_response || "";
    if (!raw) return "No relevant files found.";
    const MAX_RAW = 500;
    const truncated = raw.length > MAX_RAW ? raw.slice(0, MAX_RAW) + "\n...[raw_response truncated]..." : raw;
    return `No relevant files found.\n\nRaw response:\n${truncated}`;
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

  if (uniquePatterns.length) {
    parts.push("");
    parts.push(`grep keywords: ${uniquePatterns.join(", ")}`);
  }

  // Append diagnostic metadata so the calling AI knows what happened
  const meta = result._meta;
  if (meta) {
    const fbNote = meta.fellBack ? ` (fell back from requested depth)` : "";
    parts.push("");
    let configLine = `[config] tree_depth=${meta.treeDepth}${fbNote}, tree_size=${meta.treeSizeKB}KB, max_turns=${maxTurns}, max_results=${maxResults}, timeout_ms=${timeoutMs}`;
    if (excludePaths.length) configLine += `, exclude_paths=[${excludePaths.join(", ")}]`;
    parts.push(configLine);
  }

  return parts.join("\n");
}

/**
 * Extract Windsurf API Key info (for MCP tool use).
 * @returns {Promise<Object>}
 */
export async function extractKeyInfo() {
  return extractKey();
}
