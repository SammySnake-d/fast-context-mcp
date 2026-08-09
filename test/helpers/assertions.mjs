/**
 * Custom assertion helpers for deepgrep tests.
 *
 * Extends node:assert/strict with domain-specific assertions
 * for search results, file ranges, and error structures.
 */

import assert from "node:assert/strict";

/**
 * Assert a search result contains expected files.
 *
 * @param {Object} result - Search result with .files array
 * @param {string[]} expectedPaths - Paths that must be present
 */
export function assertResultContainsFiles(result, expectedPaths) {
  assert(result.files, "Result should have files array");
  const paths = result.files.map(f => f.path);
  for (const expected of expectedPaths) {
    assert(
      paths.some(p => p.includes(expected)),
      `Expected result to contain file matching "${expected}", got: [${paths.join(", ")}]`
    );
  }
}

/**
 * Assert a search result has valid structure.
 *
 * @param {Object} result
 */
export function assertValidSearchResult(result) {
  assert(typeof result === "object", "Result must be an object");
  if (result.error) {
    assert(typeof result.error === "string", "Error must be a string");
    return; // Error results don't need files
  }
  assert(Array.isArray(result.files), "Result.files must be an array");
  for (const file of result.files) {
    assert(typeof file.path === "string", "file.path must be string");
    assert(Array.isArray(file.ranges), "file.ranges must be array");
    for (const range of file.ranges) {
      assert(Array.isArray(range), "Each range must be an array");
      assert(range.length === 2, "Each range must have [start, end]");
      assert(range[0] <= range[1], `Range start (${range[0]}) must be <= end (${range[1]})`);
    }
  }
}

/**
 * Assert that a formatted text output contains expected sections.
 *
 * @param {string} text - Formatted output text
 * @param {Object} [expectations]
 * @param {boolean} [expectations.hasFiles=true] - Expect file listings
 * @param {boolean} [expectations.hasConfig=true] - Expect [config] line
 * @param {boolean} [expectations.hasGrep=false] - Expect grep keywords
 */
export function assertFormattedOutput(text, expectations = {}) {
  const { hasFiles = true, hasConfig = true, hasGrep = false } = expectations;

  assert(typeof text === "string", "Output must be a string");

  if (hasFiles) {
    assert(text.includes("Found") || text.includes("relevant files"), "Should mention found files");
  }
  if (hasConfig) {
    assert(text.includes("[config]"), "Should contain [config] metadata line");
  }
  if (hasGrep) {
    assert(text.includes("grep keywords:"), "Should contain grep keywords");
  }
}

/**
 * Assert error result has proper structure.
 *
 * @param {Object} result
 * @param {string} [expectedCode] - Expected error code substring
 */
export function assertErrorResult(result, expectedCode) {
  assert(result.error, "Result should have error");
  if (expectedCode) {
    assert(
      result.error.includes(expectedCode),
      `Error should contain "${expectedCode}", got: "${result.error}"`
    );
  }
}
