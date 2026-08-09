/**
 * Fast Context MCP — core protocol implementation (Node.js).
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

import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { platform, arch, release, version as osVersion, hostname, cpus, totalmem } from "node:os";

import {
  ProtobufEncoder,
  extractStrings,
  connectFrameEncode,
  connectFrameDecode,
} from "./protobuf.mjs";
import { ToolExecutor } from "./executor.mjs";
import {
  parseJsonWithRepair,
  salvageRestrictedExecArgs,
  salvageSearchEvidence,
} from "./response-repair.mjs";
import { extractKey } from "./extract-key.mjs";
import {
  getRepoMap,
  _parseAnswer,
  FINAL_FORCE_ANSWER,
  buildWindsurfPrompt,
} from "./shared.mjs";
import { buildCacheKey, getCachedResult, setCachedResult, computeMtimeHash } from "./cache.mjs";

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
// FAST is available to the same free-tier accounts as the legacy package.
// SLOW can return permission_denied for otherwise valid credentials.
const WS_MODEL = process.env.WS_MODEL || "MODEL_SWE_1_6_FAST";

// ─── System Prompt ─────────────────────────────────────────

// System prompt is built via buildWindsurfPrompt() from shared.mjs

/**
 * Trim accumulated messages to reduce payload size for retry.
 * Keeps: system prompt (index 0), user query (index 1), and last 2 messages.
 * Inserts a bridge note so the AI knows context was truncated.
 * @param {Array} messages
 * @returns {boolean} true if messages were actually trimmed
 */
function _trimMessages(messages) {
  if (messages.length <= 4) return false;
  const head = messages.slice(0, 2);
  const tail = messages.slice(-2);
  messages.length = 0;
  messages.push(
    ...head,
    { role: 1, content: "[Prior search rounds omitted to reduce payload. Provide your best answer based on available context.]" },
    ...tail,
  );
  return true;
}

// buildSystemPrompt is now buildWindsurfPrompt from shared.mjs

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
    if (result.api_key && result.api_key.length > 10) {
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

// ─── TLS Security ──────────────────────────────────────────
// TLS certificate verification is ALWAYS enabled by default.
// Only disabled when FC_ALLOW_INSECURE_TLS=1 (e.g. corporate proxy).
let _tlsFallbackApplied = false;

function _applyTlsFallback() {
  if (_tlsFallbackApplied) return;
  const allowed = process.env.FC_ALLOW_INSECURE_TLS === "1";
  if (allowed && !process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    _tlsFallbackApplied = true;
    process.stderr.write(
      "[fast-context] WARNING: TLS certificate verification disabled (FC_ALLOW_INSECURE_TLS=1). " +
      "Remove this env var to restore secure defaults.\n"
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
  meta.writeString(4, "en");
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
  meta.writeString(4, "en");

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
export function _parseToolCall(text) {
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

  const jsonText = raw.slice(0, end);
  let args = parseJsonWithRepair(jsonText);
  if (!args && name === "restricted_exec") {
    args = salvageRestrictedExecArgs(jsonText);
  }
  if (!args) return null;

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

// getRepoMap, _parseAnswer, _excludePatternToRegex, MAX_TREE_BYTES
// are imported from shared.mjs

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
  onProgress = null,
}) {
  const log = (msg) => onProgress?.(msg);
  projectRoot = resolve(projectRoot);

  // Cache hits must avoid auth/network and repo-map work. The recursive mtime
  // fingerprint includes file paths, sizes, and mtimes, so it also invalidates
  // when the searchable tree changes.
  const mtimeHash = computeMtimeHash(projectRoot, excludePaths);
  const cacheKey = buildCacheKey({ query, model: WS_MODEL, maxTurns, maxResults, treeDepth, mtimeHash, excludePaths });
  const cached = getCachedResult(cacheKey);
  if (cached) {
    log("Cache hit");
    return { ...cached, _meta: { ...cached._meta, cache_hit: true } };
  }

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
  const systemPrompt = buildWindsurfPrompt(maxTurns, maxCommands, maxResults);

  const { tree: repoMap, depth: actualDepth, sizeBytes: treeSizeBytes, fellBack } = getRepoMap(projectRoot, treeDepth, excludePaths);
  log(`Repo map: tree -L ${actualDepth} (${(treeSizeBytes / 1024).toFixed(1)}KB)${fellBack ? ` [fell back from L=${treeDepth}]` : ""}`);

  const userContent = `Problem Statement: ${query}\n\nRepo Map (tree -L ${actualDepth} /codebase):\n\`\`\`text\n${repoMap}\n\`\`\``;

  const messages = [
    { role: 5, content: systemPrompt },
    { role: 1, content: userContent },
  ];

  // Total API calls = maxTurns + 1 (last round for answer)
  const totalApiCalls = maxTurns + 1;
  let compensatedTurns = 0; // compensated turn count
  const MAX_COMPENSATIONS = 2; // max compensations to prevent infinite loops
  let forceAnswerInjected = false;

  for (let turn = 0; turn < totalApiCalls + compensatedTurns; turn++) {
    log(`Turn ${turn + 1}/${totalApiCalls}`);

    const proto = _buildRequest(apiKey, jwt, messages, toolDefs);
    let respData;
    try {
      respData = await _streamingRequest(proto, timeoutMs);
    } catch (e) {
      const errCode = e.code || "UNKNOWN";
      const baseMeta = { treeDepth: actualDepth, treeSizeKB: +(treeSizeBytes / 1024).toFixed(1), fellBack, projectRoot, errorCode: errCode };

      // Auto-retry with trimmed context on payload/timeout errors
      if ((errCode === "PAYLOAD_TOO_LARGE" || errCode === "TIMEOUT") && messages.length > 4) {
        log(`${errCode} on turn ${turn + 1}: trimming context and retrying...`);
        _trimMessages(messages);
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

    if (toolInfo === null) {
      if (thinking.startsWith("[Error]")) {
        return { files: [], error: thinking };
      }
      const salvaged = salvageSearchEvidence(thinking, projectRoot);
      if (salvaged.files.length || salvaged.rg_patterns.length) {
        return {
          ...salvaged,
          raw_response: thinking,
          _meta: {
            treeDepth: actualDepth,
            treeSizeKB: +(treeSizeBytes / 1024).toFixed(1),
            fellBack,
            projectRoot,
            salvaged_response: true,
          },
        };
      }
      return { files: [], raw_response: thinking };
    }

    const [toolName, toolArgs] = toolInfo;

    if (toolName === "answer") {
      const answerXml = toolArgs.answer || "";
      log("Received final answer");
      const result = _parseAnswer(answerXml, projectRoot);
      result.rg_patterns = [...new Set(executor.collectedRgPatterns)];
      result._meta = { treeDepth: actualDepth, treeSizeKB: +(treeSizeBytes / 1024).toFixed(1), fellBack, cache_hit: false, projectRoot };
      // AC#3: skip caching empty results so auto-escalation can retry next time
      if (result.files?.length > 0) {
        setCachedResult(cacheKey, result);
      }
      return result;
    }

    if (toolName === "restricted_exec") {
      const callId = randomUUID();
      const argsJson = JSON.stringify(toolArgs);

      const cmds = Object.keys(toolArgs).filter((k) => k.startsWith("command"));
      log(`Executing ${cmds.length} local commands`);

      const results = await executor.execToolCallAsync(toolArgs);

      // Detect all commands invalid → don't count as effective turn
      const validCommands = cmds.filter(k => {
        const c = toolArgs[k];
        return c && c.type; // at least has a type field
      });

      if (validCommands.length === 0 && compensatedTurns < MAX_COMPENSATIONS) {
        compensatedTurns++; // compensate: this turn doesn't count as effective
        log(`Turn compensation: no valid commands, extending search by 1 turn (${compensatedTurns}/${MAX_COMPENSATIONS})`);
      } else if (validCommands.length === 0) {
        log(`Turn compensation skipped: max compensations (${MAX_COMPENSATIONS}) reached, forcing turn advance`);
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
      // Use effective turn count (excluding compensated turns) to avoid premature injection
      const effectiveTurn = turn - compensatedTurns;
      if (effectiveTurn >= maxTurns - 1 && !forceAnswerInjected) {
        messages.push({ role: 1, content: FINAL_FORCE_ANSWER });
        forceAnswerInjected = true;
        log("Injected force-answer prompt");
      }
    }
  }

  const conversationText = messages
    .flatMap((message) => [message.content, message.tool_args_json])
    .filter(Boolean)
    .join("\n");
  const salvaged = salvageSearchEvidence(conversationText, projectRoot);
  if (salvaged.files.length || salvaged.rg_patterns.length) {
    return {
      ...salvaged,
      _meta: {
        treeDepth: actualDepth,
        treeSizeKB: +(treeSizeBytes / 1024).toFixed(1),
        fellBack,
        projectRoot,
        salvaged_response: true,
      },
    };
  }

  return {
    files: [],
    error: "Max turns reached without getting an answer",
    rg_patterns: [...new Set(executor.collectedRgPatterns)],
    _meta: { treeDepth: actualDepth, treeSizeKB: +(treeSizeBytes / 1024).toFixed(1), fellBack, projectRoot },
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
}) {
  const result = await search({ query, projectRoot, apiKey, maxTurns, maxCommands, maxResults, treeDepth, timeoutMs, excludePaths });

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
    let configLine = `[config] tree_depth=${meta.treeDepth}${fbNote}, tree_size=${meta.treeSizeKB}KB, max_turns=${maxTurns}, max_results=${maxResults}, timeout_ms=${timeoutMs}`;
    if (excludePaths.length) configLine += `, exclude_paths=[${excludePaths.join(", ")}]`;
    if (meta.cache_hit) configLine += `, cache_hit=true`;
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
