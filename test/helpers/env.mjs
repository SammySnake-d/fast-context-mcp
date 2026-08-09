/**
 * Environment variable helpers for tests.
 *
 * Provides safe env manipulation with automatic cleanup
 * to prevent test pollution.
 */

/**
 * Temporarily set environment variables for a test scope.
 * Returns a restore function that resets all changes.
 *
 * @param {Object<string, string|undefined>} vars - Variables to set (undefined = delete)
 * @returns {{ restore: () => void }}
 *
 * @example
 * const { restore } = setEnv({ DEEPGREP_API_KEY: "test-key", FC_CACHE_DISABLED: "true" });
 * // ... run test
 * restore(); // resets all env changes
 */
export function setEnv(vars) {
  const original = {};

  for (const [key, value] of Object.entries(vars)) {
    original[key] = process.env[key]; // may be undefined
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return {
    restore: () => {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    },
  };
}

/**
 * Run a function with temporary environment variables.
 * Automatically restores env after the function completes (or throws).
 *
 * @param {Object<string, string|undefined>} vars
 * @param {Function} fn - Function to execute (can be async)
 * @returns {Promise<*>}
 */
export async function withEnv(vars, fn) {
  const { restore } = setEnv(vars);
  try {
    return await fn();
  } finally {
    restore();
  }
}
