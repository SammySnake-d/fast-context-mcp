/**
 * OpenAI-compatible backend for deepgrep search.
 *
 * Allows using any OpenAI-compatible API (9router, Anthropic via proxy, etc.)
 * instead of Windsurf's proprietary protobuf protocol.
 *
 * Env vars (defaults, can be overridden per-call via opts):
 *   DEEPGREP_API_URL    — API endpoint (default: https://router.chainlens.net/v1)
 *   DEEPGREP_API_KEY    — API key for deep/fast mode
 *   DEEPGREP_MODEL      — Model ID (default: deep-search)
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ToolExecutor } from "./executor.mjs";
import {
  getRepoMap,
  _parseAnswer,
  FINAL_FORCE_ANSWER_OPENAI,
  buildOpenAIPrompt,
} from "./shared.mjs";
import { buildCacheKey, getCachedResult, setCachedResult, computeMtimeHash } from "./cache.mjs";

// ─── Config ────────────────────────────────────────────────

function _getOpenAIBaseUrl() { return process.env.DEEPGREP_API_URL || process.env.FC_OPENAI_BASE_URL || "https://router.chainlens.net/v1"; }
function _getOpenAIApiKey() { return process.env.DEEPGREP_API_KEY || process.env.FC_OPENAI_API_KEY || ""; }
function _getOpenAIModel() { return process.env.DEEPGREP_MODEL || process.env.FC_OPENAI_MODEL || "deep-search"; }

/**
 * Check if OpenAI backend is configured.
 * @returns {boolean}
 */
export function isOpenAIBackendConfigured() {
  return !!(_getOpenAIBaseUrl() && _getOpenAIApiKey());
}

// ─── Tool Schema for OpenAI function calling ───────────────

function _buildOpenAITools(maxCommands) {
  const commandProps = {};
  for (let i = 1; i <= maxCommands; i++) {
    commandProps[`command${i}`] = {
      type: "object",
      description: `Command ${i}. Must have a "type" field of rg, readfile, or tree.`,
      properties: {
        type: { type: "string", enum: ["rg", "readfile", "tree", "ls", "glob"] },
        pattern: { type: "string" },
        path: { type: "string" },
        file: { type: "string" },
        start_line: { type: "integer" },
        end_line: { type: "integer" },
        levels: { type: "integer" },
        include: { type: "array", items: { type: "string" } },
        exclude: { type: "array", items: { type: "string" } },
        long_format: { type: "boolean" },
        all: { type: "boolean" },
        type_filter: { type: "string" },
      },
      required: ["type"],
    };
  }

  return [
    {
      type: "function",
      function: {
        name: "restricted_exec",
        description: "Execute restricted commands (rg, readfile, tree, ls, glob) in parallel.",
        parameters: { type: "object", properties: commandProps, required: ["command1"] },
      },
    },
    {
      type: "function",
      function: {
        name: "answer",
        description: "Final answer with relevant files and line ranges in XML format.",
        parameters: {
          type: "object",
          properties: { answer: { type: "string", description: "The final answer in XML format." } },
          required: ["answer"],
        },
      },
    },
  ];
}

// ─── OpenAI API Call ───────────────────────────────────────

/**
 * Validate that a response from the OpenAI-compatible endpoint has correct shape.
 * Defense-in-depth for cases where proxy returns 200 but malformed body.
 * @param {Object} body - parsed JSON response
 * @returns {boolean}
 */
function _isValidResponse(body) {
  const c = body?.choices?.[0];
  if (!c) return false;
  if (c.finish_reason === undefined || c.finish_reason === null) return false;
  if (c.message?.tool_calls) {
    for (const tc of c.message.tool_calls) {
      try { JSON.parse(tc.function.arguments); } catch { return false; }
    }
  }
  return true;
}

/**
 * Call OpenAI-compatible chat completions endpoint.
 * @param {Array} messages - OpenAI format messages
 * @param {Object[]} tools - OpenAI tools array
 * @param {number} timeoutMs
 * @param {boolean} forceAnswer - Force model to call answer tool
 * @returns {Promise<Object>} response choice
 */
/**
 * Parse a retry-after delay (ms) from a 429 error body.
 * Handles "reset after 2s", "reset after 1m 30s".
 * @param {string} text
 * @returns {number|null} delay in ms, or null if not found
 */
function _parseRetryDelayMs(text) {
  if (!text) return null;
  const m = text.match(/reset after\s+(?:(\d+)m\s*)?(?:(\d+)s)?/i);
  if (m && (m[1] || m[2])) {
    const mins = parseInt(m[1] || "0", 10);
    const secs = parseInt(m[2] || "0", 10);
    const ms = (mins * 60 + secs) * 1000;
    if (ms > 0) return ms;
  }
  return null;
}

function _doFetch(url, body, timeoutMs, apiKey) {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * @param {Object} callConfig - { baseUrl, apiKey, model } — resolved per-call config
 */
async function _callOpenAI(messages, tools, timeoutMs = 60000, forceAnswer = false, callConfig = {}) {
  const baseUrl = callConfig.baseUrl || _getOpenAIBaseUrl();
  const apiKey = callConfig.apiKey || _getOpenAIApiKey();
  const model = callConfig.model || _getOpenAIModel();

  const url = `${baseUrl}/chat/completions`;
  const body = {
    model,
    messages,
    tools,
    tool_choice: forceAnswer
      ? { type: "function", function: { name: "answer" } }
      : "auto",
    max_tokens: 4096,
    stream: false,
  };

  const MAX_RETRIES = 4;          // total attempts = MAX_RETRIES + 1
  const MAX_BACKOFF_MS = 30000;   // cap a single wait
  let lastErr;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let resp;
    try {
      resp = await _doFetch(url, body, timeoutMs, apiKey);
    } catch (e) {
      // Network/timeout — retry with linear backoff
      lastErr = e;
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, Math.min(2000 * (attempt + 1), MAX_BACKOFF_MS)));
        continue;
      }
      throw new Error(`OpenAI API error: ${e.message}`);
    }

    // Rate limited — back off and retry (honor server "reset after" hint)
    if (resp.status === 429) {
      const text = await resp.text().catch(() => "");
      lastErr = new Error(`OpenAI API error: HTTP 429 - ${text.slice(0, 200)}`);
      lastErr.status = 429;
      if (attempt < MAX_RETRIES) {
        const hinted = _parseRetryDelayMs(text);
        const backoff = hinted != null
          ? Math.min(hinted + 500, MAX_BACKOFF_MS)
          : Math.min(2000 * Math.pow(2, attempt), MAX_BACKOFF_MS);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      throw lastErr;
    }

    // Other non-OK — do not retry (4xx client errors etc.)
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const err = new Error(`OpenAI API error: HTTP ${resp.status} - ${text.slice(0, 200)}`);
      err.status = resp.status;
      throw err;
    }

    const data = await resp.json();
    // Validate response shape — retry on malformed (defense-in-depth)
    if (!_isValidResponse(data)) {
      lastErr = new Error("OpenAI API error: malformed response");
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, Math.min(2000 * (attempt + 1), MAX_BACKOFF_MS)));
        continue;
      }
      throw lastErr;
    }

    return data.choices?.[0] || null;
  }

  throw lastErr || new Error("OpenAI API error: exhausted retries");
}

// ─── Search with OpenAI Backend ────────────────────────────

/**
 * Execute search using OpenAI-compatible backend.
 * Accepts optional per-call config (model/baseUrl/apiKey) to avoid process.env mutation.
 * Falls back to env vars if opts not provided.
 */
export async function searchOpenAI({
  query,
  projectRoot,
  maxTurns = 3,
  maxCommands = 8,
  maxResults = 10,
  treeDepth = 3,
  timeoutMs = 60000,
  excludePaths = [],
  onProgress = null,
  // Per-call config — avoids process.env mutation race conditions
  model: optsModel = null,
  baseUrl: optsBaseUrl = null,
  apiKey: optsApiKey = null,
}) {
  const log = (msg) => onProgress?.(msg);
  projectRoot = resolve(projectRoot);

  // Resolve config once at call time — no env mutation
  const callConfig = {
    model: optsModel || _getOpenAIModel(),
    baseUrl: optsBaseUrl || _getOpenAIBaseUrl(),
    apiKey: optsApiKey || _getOpenAIApiKey(),
  };
  const resolvedModel = callConfig.model;

  // Cache hits avoid repo-map generation and all backend I/O.
  const mtimeHash = computeMtimeHash(projectRoot, excludePaths);
  const cacheKey = buildCacheKey({ query, model: resolvedModel, maxTurns, maxResults, treeDepth, mtimeHash, excludePaths });
  const cached = getCachedResult(cacheKey);
  if (cached) {
    log?.("[openai] Cache hit");
    return { ...cached, _meta: { ...cached._meta, cache_hit: true } };
  }

  const executor = new ToolExecutor(projectRoot);
  const tools = _buildOpenAITools(maxCommands);
  const systemPrompt = buildOpenAIPrompt(maxTurns, maxCommands, maxResults);

  const { tree: repoTree, depth: actualDepth, sizeBytes: treeSizeBytes, fellBack } = getRepoMap(projectRoot, treeDepth, excludePaths);

  log?.(`[openai] Repo map: tree -L ${actualDepth} (${(treeSizeBytes / 1024).toFixed(1)}KB), model=${resolvedModel}`);

  const userContent = `Problem Statement: ${query}\n\nRepo Map (tree -L ${actualDepth} /codebase):\n\`\`\`text\n${repoTree}\n\`\`\``;

  // OpenAI format messages
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  const totalRounds = maxTurns + 2; // +1 for search, +1 for forced answer

  for (let turn = 0; turn < totalRounds; turn++) {
    const isLastTurn = turn >= totalRounds - 1;
    const isSecondLast = turn >= totalRounds - 2;
    const forceAnswer = isLastTurn;
    log?.(`[openai] Turn ${turn + 1}/${totalRounds}${forceAnswer ? " (forcing answer)" : ""}`);

    // On second-to-last turn, add a user message nudging for answer
    if (isSecondLast && !forceAnswer) {
      messages.push({ role: "user", content: FINAL_FORCE_ANSWER_OPENAI });
    }

    let choice;
    try {
      choice = await _callOpenAI(messages, tools, timeoutMs, forceAnswer, callConfig);
    } catch (e) {
      // _callOpenAI already handles 429/network retries with backoff internally.
      return {
        files: [],
        error: `OpenAI backend error: ${e.message}`,
        _meta: { treeDepth: actualDepth, treeSizeKB: +(treeSizeBytes / 1024).toFixed(1), fellBack, projectRoot, backend: "openai", model: resolvedModel },
      };
    }

    if (!choice) {
      return { files: [], error: "No response from OpenAI backend", _meta: { backend: "openai", model: resolvedModel } };
    }

    const msg = choice.message;

    // If model wants to call tools
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      // Add assistant message with tool_calls
      messages.push(msg);

      for (const tc of msg.tool_calls) {
        const fnName = tc.function?.name || "";
        let args;
        try {
          args = JSON.parse(tc.function?.arguments || "{}");
        } catch {
          args = {};
        }

        if (fnName === "answer") {
          const answerXml = args.answer || "";
          log?.("[openai] Received final answer");
          const result = _parseAnswer(answerXml, projectRoot);
          result.rg_patterns = [...new Set(executor.collectedRgPatterns)];
          result._meta = { treeDepth: actualDepth, treeSizeKB: +(treeSizeBytes / 1024).toFixed(1), fellBack, backend: "openai", model: resolvedModel, cache_hit: false };
          // Only cache non-empty results (AC#3: don't cache empty to preserve escalation)
          if (result.files?.length > 0) {
            setCachedResult(cacheKey, result);
          }
          return result;
        }

        if (fnName === "restricted_exec") {
          const cmds = Object.keys(args).filter((k) => k.startsWith("command"));
          log?.(`[openai] Executing ${cmds.length} local commands`);
          const results = await executor.execToolCallAsync(args);

          // Add tool result
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: results,
          });
        }
      }
    } else {
      // No tool calls — check if content contains answer XML
      const content = msg.content || "";
      if (content.includes("<ANSWER>")) {
        log?.("[openai] Received inline answer");
        const result = _parseAnswer(content, projectRoot);
        result.rg_patterns = [...new Set(executor.collectedRgPatterns)];
        result._meta = { treeDepth: actualDepth, treeSizeKB: +(treeSizeBytes / 1024).toFixed(1), fellBack, backend: "openai", model: resolvedModel, cache_hit: false };
        if (result.files?.length > 0) {
          setCachedResult(cacheKey, result);
        }
        return result;
      }

      // Model responded with text but no tool call — add and continue
      messages.push(msg);
    }
  }

  return {
    files: [],
    error: "Max turns reached without answer (OpenAI backend)",
    rg_patterns: [...new Set(executor.collectedRgPatterns)],
    _meta: { treeDepth: actualDepth, treeSizeKB: +(treeSizeBytes / 1024).toFixed(1), fellBack, projectRoot, backend: "openai", model: resolvedModel },
  };
}
