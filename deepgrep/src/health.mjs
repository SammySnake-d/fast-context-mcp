/**
 * Health check for deepgrep — validates API key, models, and Devin Desktop.
 *
 * Used by the deepgrep_status MCP tool.
 */

import { existsSync } from "node:fs";
import { getDbPath } from "./extract-key.mjs";

const SIGNUP_URL = "https://deepgrep.chainlens.net";

/**
 * Ping a single model via chat completions to check availability.
 * Returns "ok", "rate_limited" (429), "unauthorized" (403/401),
 * "error:<httpStatus>" (server responded with another code), or
 * "error:<msg>" / "error:timeout" (no response — network/timeout).
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {string} model
 * @returns {Promise<string>}
 */
async function _pingModel(baseUrl, apiKey, model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 3,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.status === 200) return "ok";
    if (resp.status === 429) return "rate_limited";
    if (resp.status === 403 || resp.status === 401) return "unauthorized";
    return `error:${resp.status}`;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") return "error:timeout";
    return `error:${e.message?.slice(0, 40) || "unknown"}`;
  }
}

/**
 * Whether the ping status implies the HTTP server actually responded
 * (even with an error code) vs. no response at all (network/timeout).
 * Used to distinguish an invalid key from an unreachable endpoint.
 * @param {string} status
 * @returns {boolean}
 */
function _serverResponded(status) {
  if (status === "ok" || status === "rate_limited" || status === "unauthorized") return true;
  if (status.startsWith("error:")) {
    // "error:<digits>" = an HTTP error code (server replied); anything else
    // (e.g. "error:timeout", "error:fetch failed") = no response.
    return /^\d+$/.test(status.slice("error:".length));
  }
  return false;
}

/**
 * Check whether the Devin Desktop (or legacy Windsurf) local DB exists.
 * @returns {boolean}
 */
function _detectDevin() {
  try {
    return existsSync(getDbPath());
  } catch {
    return false;
  }
}

/**
 * Run a full health check of the deepgrep configuration.
 *
 * @returns {Promise<{
 *   keyPresent: boolean,
 *   keyValid: boolean,
 *   keyStatus: string,
 *   endpointReachable: boolean|null,
 *   endpoint: string,
 *   models: Array<{id: string, status: string}>,
 *   devinDetected: boolean,
 *   config: { fastBackend: string, fastModel: string, deepModel: string, apiUrl: string },
 *   signupUrl: string
 * }>}
 */
export async function checkHealth() {
  // Normalize endpoint: trim whitespace, then strip trailing slash(es) so we never build "//chat/completions".
  const apiUrl = (process.env.DEEPGREP_API_URL || "https://router.chainlens.net/v1").trim().replace(/\/+$/, "");
  // Trim the key so a whitespace-only value is treated as "not set", not "invalid".
  const apiKey = (process.env.DEEPGREP_API_KEY || "").trim();
  const deepModel = process.env.DEEPGREP_MODEL || "deep-search";
  const fastBackend = process.env.DEEPGREP_FAST_BACKEND || "windsurf";
  const fastModel = process.env.DEEPGREP_FAST_MODEL || "";

  const keyPresent = apiKey.length > 0;

  // Ping the CONFIGURED deep model exactly once. This single round-trip serves
  // both key validation and model-availability reporting — no duplicate ping,
  // and no hardcoded "deep-search" that would mislabel a valid custom-model key.
  let keyStatus = "no_key";
  const models = [];
  if (keyPresent) {
    keyStatus = await _pingModel(apiUrl, apiKey, deepModel);
    models.push({ id: deepModel, status: keyStatus });
  }

  const keyValid = keyStatus === "ok" || keyStatus === "rate_limited"; // rate_limited = key valid but throttled
  // null = not checked (no key); true = server replied; false = unreachable.
  const endpointReachable = keyPresent ? _serverResponded(keyStatus) : null;

  const devinDetected = _detectDevin();

  return {
    keyPresent,
    keyValid,
    keyStatus,
    endpointReachable,
    endpoint: apiUrl,
    models,
    devinDetected,
    config: { fastBackend, fastModel, deepModel, apiUrl },
    signupUrl: SIGNUP_URL,
  };
}

/**
 * Format a HealthReport into a human-readable string for MCP output.
 * Reads only from the passed `report` (never process.env) so it is pure/testable.
 * @param {Object} report
 * @returns {string}
 */
export function formatHealthReport(report) {
  const lines = ["deepgrep status", ""];

  // Key — distinguish valid / not-set / invalid / unverifiable (network).
  if (report.keyValid) {
    lines.push("✅ API key: valid");
  } else if (!report.keyPresent) {
    lines.push(`❌ API key: not set — get a free key at ${report.signupUrl}`);
  } else if (report.keyStatus === "unauthorized") {
    lines.push(`❌ API key: invalid (unauthorized) — get a free key at ${report.signupUrl}`);
  } else if (report.endpointReachable === false) {
    lines.push("⚠️  API key: could not verify — endpoint unreachable (network/timeout)");
  } else {
    lines.push(`⚠️  API key: could not verify — ${report.keyStatus}`);
  }

  // Endpoint — reflect whether it actually responded.
  if (report.endpointReachable === true) {
    lines.push(`✅ Endpoint: ${report.endpoint}`);
  } else if (report.endpointReachable === false) {
    lines.push(`❌ Endpoint: ${report.endpoint} (unreachable)`);
  } else {
    lines.push(`ℹ️  Endpoint: ${report.endpoint} (not checked — no key)`);
  }

  // Models
  for (const m of report.models) {
    if (m.status === "ok") {
      lines.push(`✅ ${m.id}: available`);
    } else if (m.status === "rate_limited") {
      lines.push(`⚠️  ${m.id}: rate limited (429)`);
    } else if (m.status === "unauthorized") {
      lines.push(`❌ ${m.id}: unauthorized (403/401)`);
    } else {
      lines.push(`⚠️  ${m.id}: ${m.status}`);
    }
  }

  // Devin Desktop — only relevant to the windsurf fast backend (auto-key).
  // When fast mode runs on the openai backend, Devin is informational only.
  if (report.config.fastBackend === "openai") {
    lines.push(report.devinDetected
      ? "ℹ️  Devin Desktop: detected (not used — fast mode on openai backend)"
      : "ℹ️  Devin Desktop: not detected (fast mode using openai backend)");
  } else {
    lines.push(report.devinDetected
      ? "✅ Devin Desktop: detected (fast mode auto-key OK)"
      : "⚠️  Devin Desktop: not detected — set DEEPGREP_FAST_BACKEND=openai for fast mode");
  }

  // Config summary
  lines.push("");
  lines.push(`Config: fast_backend=${report.config.fastBackend}` +
    (report.config.fastModel ? `, fast_model=${report.config.fastModel}` : "") +
    `, deep_model=${report.config.deepModel}`);

  // Signup hint when the key is missing OR present-but-invalid.
  if (!report.keyPresent || report.keyStatus === "unauthorized") {
    lines.push("");
    lines.push(`💡 Get a free API key: ${report.signupUrl}`);
  }

  return lines.join("\n");
}
