/**
 * Test fixtures: sample search responses for deepgrep tests.
 *
 * Provides realistic mock data matching the actual response structures
 * returned by windsurf and openai backends.
 */

/**
 * Successful search result with multiple files.
 */
export const SUCCESSFUL_SEARCH = {
  files: [
    { path: "src/core.mjs", full_path: "/codebase/src/core.mjs", ranges: [[10, 60], [100, 120]] },
    { path: "src/shared.mjs", full_path: "/codebase/src/shared.mjs", ranges: [[1, 30]] },
    { path: "src/cache.mjs", full_path: "/codebase/src/cache.mjs", ranges: [[5, 25]] },
  ],
  rg_patterns: ["searchWithContent", "buildCacheKey", "getRepoMap"],
  _meta: {
    backend: "windsurf",
    model: "SWE-1.6",
    treeDepth: 3,
    treeSizeKB: 12.5,
    fellBack: false,
    cache_hit: false,
  },
};

/**
 * Empty search result (no files found).
 */
export const EMPTY_SEARCH = {
  files: [],
  rg_patterns: [],
  _meta: {
    backend: "windsurf",
    model: "SWE-1.6",
    treeDepth: 3,
    treeSizeKB: 8.0,
    fellBack: false,
    cache_hit: false,
  },
};

/**
 * Search result from deep mode (openai backend).
 */
export const DEEP_SEARCH_RESULT = {
  files: [
    { path: "src/server.mjs", full_path: "/codebase/src/server.mjs", ranges: [[1, 50], [80, 130]] },
    { path: "src/core.mjs", full_path: "/codebase/src/core.mjs", ranges: [[200, 280]] },
    { path: "src/escalate.mjs", full_path: "/codebase/src/escalate.mjs", ranges: [[1, 90]] },
    { path: "src/backends/openai.mjs", full_path: "/codebase/src/backends/openai.mjs", ranges: [[10, 100]] },
  ],
  rg_patterns: ["shouldEscalate", "DEEP_API_KEY", "auto_escalate"],
  _meta: {
    backend: "openai",
    model: "deep-search",
    treeDepth: 3,
    treeSizeKB: 15.2,
    fellBack: false,
    cache_hit: false,
  },
};

/**
 * Error response: rate limited.
 */
export const RATE_LIMITED_ERROR = {
  files: [],
  error: "Rate limited, please try again later",
  _meta: {
    backend: "windsurf",
    model: "SWE-1.6",
    treeDepth: 3,
    treeSizeKB: 10,
    fellBack: false,
    errorCode: "RATE_LIMITED",
  },
};

/**
 * Error response: payload too large.
 */
export const PAYLOAD_TOO_LARGE_ERROR = {
  files: [],
  error: "PAYLOAD_TOO_LARGE: HTTP 413",
  _meta: {
    backend: "windsurf",
    model: "SWE-1.6",
    treeDepth: 5,
    treeSizeKB: 280,
    fellBack: false,
    errorCode: "PAYLOAD_TOO_LARGE",
  },
};

/**
 * Error response: auth failure.
 */
export const AUTH_ERROR = {
  files: [],
  error: "AUTH_ERROR: HTTP 401",
  _meta: {
    backend: "windsurf",
    model: "SWE-1.6",
    treeDepth: 3,
    treeSizeKB: 10,
    fellBack: false,
    errorCode: "AUTH_ERROR",
  },
};

/**
 * Cache hit result (identical to SUCCESSFUL_SEARCH but with cache_hit=true).
 */
export const CACHED_RESULT = {
  ...SUCCESSFUL_SEARCH,
  _meta: { ...SUCCESSFUL_SEARCH._meta, cache_hit: true },
};
