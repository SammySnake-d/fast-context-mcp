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
import { resolve, join, relative } from "node:path";
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

// ─── Protocol Constants ────────────────────────────────────

const API_BASE = "https://server.self-serve.windsurf.com/exa.api_server_pb.ApiServerService";
const AUTH_BASE = "https://server.self-serve.windsurf.com/exa.auth_pb.AuthService";
const WS_APP = "windsurf";
const WS_APP_VER = process.env.WS_APP_VER || "1.48.2";
const WS_LS_VER = process.env.WS_LS_VER || "1.9544.35";
const WS_MODEL = process.env.WS_MODEL || "MODEL_SWE_1_6_FAST";

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
 * @returns {string|null}
 */
function autoDiscoverApiKey() {
  try {
    const result = extractKey();
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
 * @returns {string}
 */
function getApiKey() {
  const key = process.env.WINDSURF_API_KEY;
  if (key) return key;
  const discovered = autoDiscoverApiKey();
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
    resp = await doFetch();
  }

  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
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
        throw e;
      }
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
    }
  }
  throw lastErr;
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
  try {
    args = JSON.parse(raw.slice(0, end));
  } catch {
    return null;
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
 * Get a directory tree of the project with adaptive depth fallback.
 *
 * Tries the requested depth first. If the tree output exceeds MAX_TREE_BYTES,
 * automatically falls back to lower depths until it fits.
 *
 * @param {string} projectRoot
 * @param {number} [targetDepth=3] - Desired tree depth (1-6)
 * @returns {{ tree: string, depth: number, sizeBytes: number, fellBack: boolean }}
 */
function getRepoMap(projectRoot, targetDepth = 3) {
  const rootPattern = new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  const dirName = projectRoot.split("/").pop() || projectRoot.split("\\").pop() || projectRoot;

  for (let L = targetDepth; L >= 1; L--) {
    try {
      const stdout = treeNodeCli(projectRoot, { maxDepth: L });
      // tree-node-cli outputs basename as root line; replace with /codebase
      let treeStr = stdout.replace(rootPattern, "/codebase");
      // Also replace the basename root line (first line) if full path wasn't matched
      const lines = treeStr.split("\n");
      if (lines[0] === dirName) {
        lines[0] = "/codebase";
        treeStr = lines.join("\n");
      }
      const sizeBytes = Buffer.byteLength(treeStr, "utf-8");

      if (sizeBytes <= MAX_TREE_BYTES) {
        return { tree: treeStr, depth: L, sizeBytes, fellBack: L < targetDepth };
      }
      // Too large, try lower depth
    } catch {
      // tree failed at this level, try lower
    }
  }

  // Ultimate fallback: simple ls
  try {
    const entries = readdirSync(projectRoot).sort();
    const treeStr = ["/codebase", ...entries.map((e) => `├── ${e}`)].join("\n");
    return { tree: treeStr, depth: 0, sizeBytes: Buffer.byteLength(treeStr, "utf-8"), fellBack: true };
  } catch {
    const treeStr = "/codebase\n(empty or inaccessible)";
    return { tree: treeStr, depth: 0, sizeBytes: treeStr.length, fellBack: true };
  }
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
  const fileRegex = /<file\s+path="([^"]+)">([\s\S]*?)<\/file>/g;
  let fm;
  while ((fm = fileRegex.exec(xmlText)) !== null) {
    const vpath = fm[1];
    const rel = vpath.replace(/^\/codebase\/?/, "");

    // Path safety: reject traversal attempts (../) and paths outside project root
    const fullPath = resolve(projectRoot, rel);
    if (!fullPath.startsWith(resolvedRoot + "/") && fullPath !== resolvedRoot) {
      continue;
    }

    const ranges = [];
    const rangeRegex = /<range>(\d+)-(\d+)<\/range>/g;
    let rm;
    while ((rm = rangeRegex.exec(fm[2])) !== null) {
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
  onProgress = null,
}) {
  const log = (msg) => onProgress?.(msg);
  projectRoot = resolve(projectRoot);

  // Get credentials
  if (!apiKey) {
    apiKey = getApiKey();
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

  const { tree: repoMap, depth: actualDepth, sizeBytes: treeSizeBytes, fellBack } = getRepoMap(projectRoot, treeDepth);
  log(`Repo map: tree -L ${actualDepth} (${(treeSizeBytes / 1024).toFixed(1)}KB)${fellBack ? ` [fell back from L=${treeDepth}]` : ""}`);
  const userContent = `Problem Statement: ${query}\n\nRepo Map (tree -L ${actualDepth} /codebase):\n\`\`\`text\n${repoMap}\n\`\`\``;

  const messages = [
    { role: 5, content: systemPrompt },
    { role: 1, content: userContent },
  ];

  // Total API calls = maxTurns + 1 (last round for answer)
  const totalApiCalls = maxTurns + 1;

  for (let turn = 0; turn < totalApiCalls; turn++) {
    log(`Turn ${turn + 1}/${totalApiCalls}`);

    const proto = _buildRequest(apiKey, jwt, messages, toolDefs);
    let respData;
    try {
      respData = await _streamingRequest(proto, timeoutMs);
    } catch (e) {
      return { files: [], error: `Request failed: ${e.message}`, httpStatus: e.status || null };
    }

    const [thinking, toolInfo] = _parseResponse(respData);

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
      result._meta = { treeDepth: actualDepth, treeSizeKB: +(treeSizeBytes / 1024).toFixed(1), fellBack };
      return result;
    }

    if (toolName === "restricted_exec") {
      const callId = randomUUID();
      const argsJson = JSON.stringify(toolArgs);

      const cmds = Object.keys(toolArgs).filter((k) => k.startsWith("command"));
      log(`Executing ${cmds.length} local commands`);

      const results = await executor.execToolCallAsync(toolArgs);

      messages.push({
        role: 2,
        content: thinking,
        tool_call_id: callId,
        tool_name: "restricted_exec",
        tool_args_json: argsJson,
      });
      messages.push({ role: 4, content: results, ref_call_id: callId });

      // Inject force-answer after last search round
      if (turn >= maxTurns - 1) {
        messages.push({ role: 1, content: FINAL_FORCE_ANSWER });
        log("Injected force-answer prompt");
      }
    }
  }

  return {
    files: [],
    error: "Max turns reached without getting an answer",
    rg_patterns: [...new Set(executor.collectedRgPatterns)],
    _meta: { treeDepth: actualDepth, treeSizeKB: +(treeSizeBytes / 1024).toFixed(1), fellBack },
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
}) {
  const result = await search({ query, projectRoot, apiKey, maxTurns, maxCommands, maxResults, treeDepth, timeoutMs });

  if (result.error) {
    const meta = result._meta;
    const status = result.httpStatus;
    let errMsg = `Error: ${result.error}`;

    // HTTP status-specific hints
    if (status === 403) {
      errMsg += `\n\n[hint] 403 Forbidden: Authentication failed. The API key may be expired or revoked. ` +
        `Try re-extracting with extract_windsurf_key, or set a fresh WINDSURF_API_KEY env var.`;
    } else if (status === 401) {
      errMsg += `\n\n[hint] 401 Unauthorized: Invalid API key or JWT. ` +
        `Re-extract the key with extract_windsurf_key or set WINDSURF_API_KEY.`;
    } else if (status === 429) {
      errMsg += `\n\n[hint] 429 Rate limited: Too many requests. Wait a moment and retry.`;
    } else if (status === 413 || (status >= 400 && meta)) {
      errMsg += `\n\n[diagnostic] tree_depth_used=${meta.treeDepth}, tree_size=${meta.treeSizeKB}KB`;
      if (meta.fellBack) {
        errMsg += ` (auto fell back from requested depth)`;
      }
      errMsg += `\n[config] max_turns=${maxTurns}, max_results=${maxResults}, max_commands=${maxCommands}, timeout_ms=${timeoutMs}`;
      errMsg += `\n[hint] If the error is payload-related, try a lower tree_depth value.`;
    } else if (meta) {
      errMsg += `\n\n[diagnostic] tree_depth_used=${meta.treeDepth}, tree_size=${meta.treeSizeKB}KB`;
      if (meta.fellBack) {
        errMsg += ` (auto fell back from requested depth)`;
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
    return raw ? `No relevant files found.\n\nRaw response:\n${raw}` : "No relevant files found.";
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
    parts.push(`[config] tree_depth=${meta.treeDepth}${fbNote}, tree_size=${meta.treeSizeKB}KB, max_turns=${maxTurns}, max_results=${maxResults}, timeout_ms=${timeoutMs}`);
  }

  return parts.join("\n");
}

/**
 * Extract Windsurf API Key info (for MCP tool use).
 * @returns {Object}
 */
export function extractKeyInfo() {
  return extractKey();
}
