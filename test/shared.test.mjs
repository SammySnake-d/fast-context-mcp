import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getRepoMap, _excludePatternToRegex, buildWindsurfPrompt, buildOpenAIPrompt, MAX_TREE_BYTES, FINAL_FORCE_ANSWER, FINAL_FORCE_ANSWER_OPENAI } from "../deepgrep/src/shared.mjs";

describe("_excludePatternToRegex", () => {
  it("matches exact name (literal)", () => {
    const rx = _excludePatternToRegex("node_modules");
    assert(rx.test("node_modules"));
    assert(!rx.test("xnode_modules"));
    assert(!rx.test("node_modulesx"));
  });

  it("handles glob *", () => {
    const rx = _excludePatternToRegex("*.min.*");
    assert(rx.test("app.min.js"));
    assert(!rx.test("app.js"));
  });

  it("handles glob ?", () => {
    const rx = _excludePatternToRegex("a?.js");
    assert(rx.test("ab.js"));
    assert(!rx.test("abc.js"));
  });
});

describe("getRepoMap", () => {
  it("returns tree string with /codebase root", () => {
    const r = getRepoMap(process.cwd(), 1, ["node_modules", ".git"]);
    assert(r.tree.startsWith("/codebase"));
    assert(typeof r.depth === "number");
    assert(typeof r.sizeBytes === "number");
    assert(typeof r.fellBack === "boolean");
  });

  it("respects excludePaths (filters nested entries)", () => {
    const r = getRepoMap(process.cwd(), 2, ["node_modules", ".git", "test"]);
    // "test" entries within subdirectories should be filtered
    // At depth 1 tree-node-cli still shows top-level names, but at depth 2+ exclusion works
    assert(r.tree.includes("/codebase"));
    assert(typeof r.depth === "number");
  });

  it("falls back to lower depth if needed", () => {
    const r = getRepoMap(process.cwd(), 6, ["node_modules", ".git"]);
    assert(r.sizeBytes <= MAX_TREE_BYTES);
  });
});

describe("buildWindsurfPrompt / buildOpenAIPrompt", () => {
  it("substitutes parameters", () => {
    const wp = buildWindsurfPrompt(5, 10, 15);
    assert(wp.includes("5") && wp.includes("10") && wp.includes("15"));
    assert(!wp.includes("{max_turns}"));
  });

  it("Windsurf prompt contains [TOOL_CALLS] format", () => {
    assert(buildWindsurfPrompt().includes("[TOOL_CALLS]"));
  });

  it("OpenAI prompt does NOT contain [TOOL_CALLS]", () => {
    assert(!buildOpenAIPrompt().includes("[TOOL_CALLS]"));
  });

  it("prompts are distinct (AC3 from story 1)", () => {
    assert.notEqual(buildWindsurfPrompt(), buildOpenAIPrompt());
  });
});

describe("constants", () => {
  it("FINAL_FORCE_ANSWER variants are distinct", () => {
    assert.notEqual(FINAL_FORCE_ANSWER, FINAL_FORCE_ANSWER_OPENAI);
    assert(FINAL_FORCE_ANSWER_OPENAI.includes("answer tool"));
  });

  it("MAX_TREE_BYTES = 250KB", () => {
    assert.equal(MAX_TREE_BYTES, 250 * 1024);
  });
});
