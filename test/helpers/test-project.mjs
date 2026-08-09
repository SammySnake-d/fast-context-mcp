/**
 * Temporary test project factory.
 *
 * Creates isolated temp directories with controlled file structures
 * for testing repo-map generation, file search, and caching logic.
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Create a temporary project directory with given file structure.
 *
 * @param {Object<string, string>} files - Map of relative path → content
 * @returns {{ root: string, cleanup: () => void }}
 *
 * @example
 * const { root, cleanup } = createTestProject({
 *   "src/index.mjs": "export const main = () => {};",
 *   "src/utils.mjs": "export const helper = () => {};",
 *   "package.json": JSON.stringify({ name: "test" }),
 * });
 * // ... run tests using `root` as projectRoot
 * cleanup();
 */
export function createTestProject(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "deepgrep-test-"));

  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(root, relPath);
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content);
  }

  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Create a minimal Node.js project for testing.
 *
 * @param {Object} [overrides] - Additional files to include
 * @returns {{ root: string, cleanup: () => void }}
 */
export function createMinimalNodeProject(overrides = {}) {
  return createTestProject({
    "package.json": JSON.stringify({ name: "test-project", type: "module" }),
    "src/index.mjs": 'export function main() { return "hello"; }',
    "src/utils.mjs": 'export function add(a, b) { return a + b; }',
    "README.md": "# Test Project",
    ...overrides,
  });
}

/**
 * Create a larger project structure for tree/depth testing.
 *
 * @param {number} [depth=3] - Nesting depth
 * @param {number} [filesPerDir=3] - Files per directory
 * @returns {{ root: string, cleanup: () => void }}
 */
export function createDeepProject(depth = 3, filesPerDir = 3) {
  const files = {};
  files["package.json"] = JSON.stringify({ name: "deep-project" });

  function addLevel(prefix, currentDepth) {
    for (let i = 0; i < filesPerDir; i++) {
      files[`${prefix}/file${i}.mjs`] = `// ${prefix}/file${i}\nexport const val${i} = ${i};`;
    }
    if (currentDepth < depth) {
      addLevel(`${prefix}/sub`, currentDepth + 1);
    }
  }

  addLevel("src", 1);
  return createTestProject(files);
}
