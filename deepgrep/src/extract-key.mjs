/**
 * Windsurf/Devin API Key extraction from local installation.
 *
 * Cross-platform: macOS / Windows / Linux.
 * Uses sql.js (pure JS/WASM) to read state.vscdb — no native compilation needed.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import initSqlJs from "sql.js";

const TOML_API_KEY_FIELDS = [
  "api_key",
  "apiKey",
  "devin_api_key",
  "devinApiKey",
  "windsurf_api_key",
  "windsurfApiKey",
  "access_token",
  "accessToken",
  "token",
];

/**
 * Get platform-specific candidate paths to Windsurf/Devin's state.vscdb.
 * Devin is the current app name. Deviv and Windsurf are compatibility fallbacks.
 * @param {{ platformName?: string, homeDir?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {string[]}
 */
export function getDbPathCandidates(opts = {}) {
  const plat = opts.platformName || platform();
  const home = opts.homeDir || homedir();
  const env = opts.env || process.env;

  if (plat === "darwin") {
    return ["Devin", "Deviv", "Windsurf"].map((appName) =>
      join(home, "Library", "Application Support", appName, "User", "globalStorage", "state.vscdb")
    );
  }

  if (plat === "win32") {
    const appdata = env.APPDATA || "";
    if (!appdata) throw new Error("Cannot determine APPDATA path");
    return ["Devin", "Deviv", "Windsurf"].map((appName) =>
      join(appdata, appName, "User", "globalStorage", "state.vscdb")
    );
  }

  const config = env.XDG_CONFIG_HOME || join(home, ".config");
  return ["Devin", "Deviv", "Windsurf"].map((appName) =>
    join(config, appName, "User", "globalStorage", "state.vscdb")
  );
}

/**
 * Get the preferred platform-specific path to Windsurf/Devin's state.vscdb.
 * @returns {string}
 */
export function getDbPath() {
  return getDbPathCandidates()[0];
}

/**
 * Get platform-specific Devin CLI credential candidates.
 * WSL runs as Linux, so it uses the Linux Devin CLI login path.
 * @param {{ platformName?: string, homeDir?: string }} [opts]
 * @returns {string[]}
 */
export function getCliCredentialPathCandidates(opts = {}) {
  const plat = opts.platformName || platform();
  const home = opts.homeDir || homedir();

  if (plat !== "linux") return [];
  return [join(home, ".local", "share", "devin", "credentials.toml")];
}

/**
 * Get credential sources in lookup order.
 * @param {{ platformName?: string, homeDir?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ type: "toml" | "sqlite", path: string }[]}
 */
export function getCredentialSources(opts = {}) {
  const tomlSources = getCliCredentialPathCandidates(opts).map((path) => ({ type: "toml", path }));
  const sqliteSources = getDbPathCandidates(opts).map((path) => ({ type: "sqlite", path }));
  return [...tomlSources, ...sqliteSources];
}

/**
 * Extract an API key from Devin CLI credentials.toml content.
 * @param {string} text
 * @returns {string}
 */
export function extractApiKeyFromToml(text) {
  for (const field of TOML_API_KEY_FIELDS) {
    const match = text.match(new RegExp(`^\\s*${field}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s#]+))`, "m"));
    const value = (match?.[1] || match?.[2] || match?.[3] || "").trim();
    if (value) return value;
  }

  const fallback = text.match(/\bsk-[A-Za-z0-9_-]+\b/);
  return fallback ? fallback[0] : "";
}

/**
 * Extract API Key from a Devin CLI credentials.toml file.
 * @param {string} credentialsPath
 * @returns {{ api_key?: string, db_path: string, source_type: string, error?: string, hint?: string }}
 */
function extractKeyFromToml(credentialsPath) {
  if (!existsSync(credentialsPath)) {
    return {
      error: `Devin CLI credentials not found: ${credentialsPath}`,
      hint: "Run devin login inside WSL/Linux, then retry.",
      db_path: credentialsPath,
      source_type: "devin_cli_credentials",
    };
  }

  let text;
  try {
    text = readFileSync(credentialsPath, "utf8");
  } catch (e) {
    return {
      error: `Failed to read Devin CLI credentials: ${e.message}`,
      db_path: credentialsPath,
      source_type: "devin_cli_credentials",
    };
  }

  const apiKey = extractApiKeyFromToml(text);
  if (!apiKey) {
    return {
      error: "Devin CLI credentials did not contain an API key",
      hint: "Run devin login inside WSL/Linux, then retry.",
      db_path: credentialsPath,
      source_type: "devin_cli_credentials",
    };
  }

  return { api_key: apiKey, db_path: credentialsPath, source_type: "devin_cli_credentials" };
}

/**
 * Extract API Key from a Windsurf/Devin state.vscdb file.
 * @param {string} dbPath
 * @returns {Promise<{ api_key?: string, db_path: string, error?: string, hint?: string }>}
 */
async function extractKeyFromDb(dbPath) {
  if (!existsSync(dbPath)) {
    return {
      error: `Windsurf/Devin database not found: ${dbPath}`,
      hint: "Ensure Windsurf or Devin is installed and logged in.",
      db_path: dbPath,
    };
  }

  let db;
  try {
    const SQL = await initSqlJs();
    const buf = readFileSync(dbPath);
    db = new SQL.Database(buf);
  } catch (e) {
    return { error: `Failed to open database: ${e.message}`, db_path: dbPath };
  }

  try {
    const stmt = db.prepare("SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus'");
    if (!stmt.step()) {
      stmt.free();
      return {
        error: "windsurfAuthStatus record not found",
        hint: "Ensure Windsurf or Devin is logged in.",
        db_path: dbPath,
      };
    }

    const row = stmt.getAsObject();
    stmt.free();

    let data;
    try {
      data = JSON.parse(row.value);
    } catch {
      return { error: "windsurfAuthStatus data parse failed", db_path: dbPath };
    }

    const apiKey = data.apiKey || "";
    if (!apiKey) {
      return { error: "apiKey field is empty", db_path: dbPath };
    }

    return { api_key: apiKey, db_path: dbPath };
  } catch (e) {
    return { error: `Extraction failed: ${e.message}`, db_path: dbPath };
  } finally {
    db.close();
  }
}

/**
 * Extract API Key from the first available Windsurf/Devin state.vscdb.
 * @param {string} [dbPath]
 * @returns {Promise<{ api_key?: string, db_path: string, error?: string, hint?: string, tried_paths?: string[] }>}
 */
export async function extractKey(dbPath) {
  const sources = dbPath
    ? [{ type: dbPath.endsWith(".toml") ? "toml" : "sqlite", path: dbPath }]
    : getCredentialSources();
  const triedPaths = [];
  let firstExistingError = null;

  for (const source of sources) {
    triedPaths.push(source.path);
    if (!existsSync(source.path)) continue;

    const result = source.type === "toml"
      ? extractKeyFromToml(source.path)
      : await extractKeyFromDb(source.path);
    if (result.api_key) return result;
    if (!firstExistingError) firstExistingError = result;
  }

  if (firstExistingError) {
    return { ...firstExistingError, tried_paths: triedPaths };
  }

  return {
    error: "Windsurf/Devin credential source not found",
    hint: "Ensure Devin or Windsurf is installed and logged in.",
    db_path: sources[0]?.path || "",
    tried_paths: triedPaths,
  };
}
