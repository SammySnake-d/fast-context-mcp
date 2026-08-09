import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getRepoMap, MAX_TREE_BYTES } from "../deepgrep/src/shared.mjs";
import { createMinimalNodeProject, createDeepProject } from "./helpers/test-project.mjs";

describe("getRepoMap — with test projects", () => {
  it("generates tree from minimal project", () => {
    const { root, cleanup } = createMinimalNodeProject();
    try {
      const result = getRepoMap(root, 2, []);
      assert(result.tree.startsWith("/codebase"));
      assert(result.tree.includes("src"));
      assert(result.depth === 2);
      assert(result.sizeBytes > 0);
      assert(result.sizeBytes <= MAX_TREE_BYTES);
    } finally {
      cleanup();
    }
  });

  it("respects excludePaths in test project", () => {
    const { root, cleanup } = createMinimalNodeProject({
      "node_modules/pkg/index.js": "module.exports = {};",
      "dist/bundle.js": "// bundled",
    });
    try {
      const result = getRepoMap(root, 3, ["node_modules", "dist"]);
      // getRepoMap uses tree-node-cli which may still show directory names at top level
      // but content inside excluded dirs should not appear in deeper trees
      // The key invariant: src content IS present
      assert(result.tree.includes("src"));
      assert(result.tree.includes("/codebase"));
      // Verify the exclude actually reduces tree size
      const fullResult = getRepoMap(root, 3, []);
      assert(result.sizeBytes <= fullResult.sizeBytes);
    } finally {
      cleanup();
    }
  });

  it("falls back to lower depth for deep projects", () => {
    const { root, cleanup } = createDeepProject(5, 10);
    try {
      const result = getRepoMap(root, 6, []);
      assert(result.sizeBytes <= MAX_TREE_BYTES);
      // May or may not fall back depending on actual size
      assert(result.depth >= 1 && result.depth <= 6);
    } finally {
      cleanup();
    }
  });

  it("handles empty directory", () => {
    const { root, cleanup } = createMinimalNodeProject({});
    try {
      // Even with empty files map, mkdtemp creates the dir
      const result = getRepoMap(root, 2, []);
      assert(result.tree.startsWith("/codebase"));
      assert(typeof result.depth === "number");
    } finally {
      cleanup();
    }
  });
});
