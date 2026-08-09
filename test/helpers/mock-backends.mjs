/**
 * Mock backend factories for deepgrep tests.
 *
 * Provides controllable mock implementations of search backends
 * (windsurf, openai) for unit/integration testing without network calls.
 */

/**
 * Create a mock search backend that returns a predetermined result.
 *
 * @param {string} name - Backend name (e.g. "windsurf", "openai")
 * @param {Object} [options]
 * @param {Object} [options.result] - The search result to return
 * @param {Error} [options.error] - Error to throw instead of returning result
 * @param {number} [options.delay=0] - Artificial delay in ms
 * @returns {{ name: string, model: string, search: Function, calls: Array }}
 */
export function createMockBackend(name, options = {}) {
  const { result = { files: [], rg_patterns: [] }, error = null, delay = 0 } = options;
  const calls = [];

  return {
    name,
    model: `mock-${name}`,
    calls,
    async search(opts) {
      calls.push({ ...opts, timestamp: Date.now() });
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      if (error) throw error;
      return structuredClone(result);
    },
  };
}

/**
 * Create a mock backend that returns file results.
 *
 * @param {string} name
 * @param {Array<{ path: string, ranges: number[][] }>} files
 * @returns {{ name: string, model: string, search: Function, calls: Array }}
 */
export function createMockBackendWithFiles(name, files) {
  const result = {
    files: files.map(f => ({
      path: f.path,
      full_path: `/codebase/${f.path}`,
      ranges: f.ranges || [[1, 50]],
    })),
    rg_patterns: ["pattern1", "pattern2"],
    _meta: { backend: name, model: `mock-${name}`, treeDepth: 3, treeSizeKB: 10, fellBack: false },
  };
  return createMockBackend(name, { result });
}

/**
 * Create a mock backend that simulates rate limiting.
 *
 * @param {string} name
 * @param {number} [failCount=1] - Number of calls that fail before succeeding
 * @returns {{ name: string, model: string, search: Function, calls: Array }}
 */
export function createRateLimitedBackend(name, failCount = 1) {
  const calls = [];
  let callIndex = 0;

  return {
    name,
    model: `mock-${name}`,
    calls,
    async search(opts) {
      calls.push({ ...opts, timestamp: Date.now() });
      callIndex++;
      if (callIndex <= failCount) {
        const err = new Error("Rate limited");
        err.status = 429;
        throw err;
      }
      return { files: [], rg_patterns: [] };
    },
  };
}
