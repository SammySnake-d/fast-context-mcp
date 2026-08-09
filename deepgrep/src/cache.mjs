/**
 * In-memory result cache with TTL for deepgrep search results.
 *
 * Env vars:
 *   DEEPGREP_CACHE_DISABLED  — "1"/"true"/"yes"/"on" disables caching entirely (legacy: FC_CACHE_DISABLED)
 *   DEEPGREP_CACHE_TTL_MS    — cache TTL in milliseconds (default: 300000 = 5 min; <=0 disables) (legacy: FC_CACHE_TTL_MS)
 *   DEEPGREP_CACHE_MAX_ENTRIES — max cached entries before oldest is evicted (default: 200) (legacy: FC_CACHE_MAX_ENTRIES)
 */

import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { _excludePatternToRegex } from "./shared.mjs";

// ─── Config ────────────────────────────────────────────────

function _isDisabled() {
  const v = (process.env.DEEPGREP_CACHE_DISABLED || process.env.FC_CACHE_DISABLED || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Resolve TTL. Returns 0 if caching should be treated as disabled
 * (explicit 0/negative), the configured value if > 0, or the default.
 * @returns {number}
 */
function _getTtlMs() {
  const raw = process.env.DEEPGREP_CACHE_TTL_MS || process.env.FC_CACHE_TTL_MS;
  if (raw === undefined || raw.trim() === "") return 300000;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return 300000; // non-numeric → default
  return n; // 0 or negative → treated as disabled by callers
}

function _getMaxEntries() {
  const raw = process.env.DEEPGREP_CACHE_MAX_ENTRIES || process.env.FC_CACHE_MAX_ENTRIES;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 200;
}

// ─── Cache Store ───────────────────────────────────────────

/** @type {Map<string, { result: Object, expiresAt: number }>} */
const _store = new Map();

/**
 * Compute an aggregate hash of file mtimes + sizes under projectRoot.
 * Detects file CONTENT changes (mtime) that the tree structure alone misses.
 * Bounded by a max file count to keep the walk cheap on huge repos.
 * @param {string} projectRoot
 * @param {string[]} [excludePaths=[]]
 * @returns {string}
 */
export function computeMtimeHash(projectRoot, excludePaths = []) {
  const excludeRegexes = excludePaths.length ? excludePaths.map(_excludePatternToRegex) : [];
  const hash = createHash("sha256");
  let count = 0;
  const MAX_FILES = 5000;

  const walk = (dir) => {
    if (count >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (count >= MAX_FILES) return;
      if (excludeRegexes.some((rx) => rx.test(e.name))) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        try {
          const st = statSync(full);
          hash.update(`${full}:${st.mtimeMs}:${st.size}\n`);
          count++;
        } catch {
          // skip unreadable file
        }
      }
    }
  };

  walk(projectRoot);
  return hash.digest("hex");
}

/**
 * Build a deterministic cache key from search parameters.
 * @param {{ query: string, model: string, maxTurns: number, maxResults: number, treeDepth: number, repoMapHash?: string, mtimeHash?: string, excludePaths?: string[] }} params
 * @returns {string}
 */
export function buildCacheKey({ query, model, maxTurns, maxResults, treeDepth, repoMapHash = "", mtimeHash = "", excludePaths = [] }) {
  const excl = [...excludePaths].sort().join(",");
  const input = `${query}|${model}|${maxTurns}|${maxResults}|${treeDepth}|${repoMapHash}|${mtimeHash}|${excl}`;
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Get a cached result if it exists and is not expired.
 * @param {string} key
 * @returns {Object|null}
 */
export function getCachedResult(key) {
  if (_isDisabled() || _getTtlMs() <= 0) return null;
  const entry = _store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _store.delete(key);
    return null;
  }
  return entry.result;
}

/**
 * Store a result in cache. Evicts the oldest entry if at capacity.
 * @param {string} key
 * @param {Object} result
 */
export function setCachedResult(key, result) {
  const ttl = _getTtlMs();
  if (_isDisabled() || ttl <= 0) return;

  const maxEntries = _getMaxEntries();
  // Evict oldest entries (insertion order) until under capacity.
  while (_store.size >= maxEntries) {
    const oldestKey = _store.keys().next().value;
    if (oldestKey === undefined) break;
    _store.delete(oldestKey);
  }

  _store.set(key, { result, expiresAt: Date.now() + ttl });
}

/**
 * Clear all cached entries. Useful for testing.
 */
export function clearCache() {
  _store.clear();
}
