/**
 * Tests for server.mjs _formatResult — mirrored logic.
 *
 * _formatResult is not exported (module-private). We mirror its implementation
 * here, importing the same friendlyError + readSnippets it uses, to validate
 * all formatting branches: error paths, file listing, grep patterns, config line.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { friendlyError } from "../deepgrep/src/shared.mjs";
import { readSnippets } from "../deepgrep/src/snippets.mjs";

// ─── Mirror of server.mjs _formatResult ────────────────────
function _formatResult(result, maxTurns, maxResults, maxCommands, timeoutMs, excludePaths, includeSnippets = false) {
  if (result.error) {
    const meta = result._meta || {};
    const model = meta.model || "unknown";
    const fakeErr = { message: result.error, status: null };
    if (/(?<![\d.:])429(?!\d)/.test(result.error)) fakeErr.status = 429;
    else if (/(?<![\d.:])403(?!\d)/.test(result.error)) fakeErr.status = 403;
    else if (/(?<![\d.:])401(?!\d)/.test(result.error)) fakeErr.status = 401;
    const isFriendly = fakeErr.status || result.error.toLowerCase().includes("rate limit") || result.error.toLowerCase().includes("not accessible");
    let errMsg = isFriendly ? friendlyError(fakeErr, model) : `Error: ${result.error}`;
    if (!isFriendly && meta.backend) errMsg += ` [backend=${meta.backend}, model=${model}]`;
    if (meta.treeDepth != null) errMsg += `\n[diagnostic] tree_depth=${meta.treeDepth}, tree_size=${meta.treeSizeKB}KB`;
    return errMsg;
  }

  const files = result.files || [];
  const rgPatterns = result.rg_patterns || [];
  const uniquePatterns = [...new Set(rgPatterns)].filter((p) => p.length >= 3);
  const meta = result._meta || {};

  if (!files.length && !uniquePatterns.length) {
    return "No relevant files found.";
  }

  const parts = [];
  const n = files.length;

  if (files.length) {
    parts.push(`Found ${n} relevant files.`);
    parts.push("");
    for (let i = 0; i < files.length; i++) {
      const entry = files[i];
      const rangesStr = entry.ranges.map(([s, e]) => `L${s}-${e}`).join(", ");
      parts.push(`  [${i + 1}/${n}] ${entry.full_path} (${rangesStr})`);
    }
  } else {
    parts.push("No files found.");
  }

  if (includeSnippets && files.length) {
    const snippetMap = readSnippets(files);
    if (snippetMap.size) {
      parts.push("");
      parts.push("--- Code Snippets ---");
      for (const file of files) {
        const snippet = snippetMap.get(file.full_path);
        if (snippet) {
          parts.push("");
          parts.push(`## ${file.path}`);
          parts.push("```");
          parts.push(snippet);
          parts.push("```");
        }
      }
    }
  }

  if (uniquePatterns.length) {
    parts.push("");
    parts.push(`grep keywords: ${uniquePatterns.join(", ")}`);
  }

  if (meta) {
    const fbNote = meta.fellBack ? ` (fell back)` : "";
    parts.push("");
    let configLine = `[config] backend=${meta.backend || "windsurf"}, model=${meta.model || "SWE-1.6"}, tree_depth=${meta.treeDepth}${fbNote}, tree_size=${meta.treeSizeKB}KB, max_turns=${maxTurns}`;
    if (excludePaths.length) configLine += `, exclude_paths=[${excludePaths.join(", ")}]`;
    if (meta.cache_hit) configLine += `, cache_hit=true`;
    parts.push(configLine);
  }

  return parts.join("\n");
}

describe("_formatResult — error branches", () => {
  it("formats 429 error as friendly message", () => {
    const out = _formatResult({ error: "HTTP 429 Too Many Requests" }, 3, 10, 8, 30000, []);
    assert.ok(typeof out === "string" && out.length > 0);
    assert.ok(!out.startsWith("Error:"), "429 should be friendly, not raw");
  });

  it("formats 401 error as friendly message", () => {
    const out = _formatResult({ error: "HTTP 401 Unauthorized" }, 3, 10, 8, 30000, []);
    assert.ok(typeof out === "string" && out.length > 0);
  });

  it("formats 403 error as friendly message", () => {
    const out = _formatResult({ error: "HTTP 403 Forbidden" }, 3, 10, 8, 30000, []);
    assert.ok(typeof out === "string" && out.length > 0);
  });

  it("formats 'rate limit' text as friendly message", () => {
    const out = _formatResult({ error: "You hit the rate limit" }, 3, 10, 8, 30000, []);
    assert.ok(!out.startsWith("Error:"), "rate limit text should be friendly");
  });

  it("formats generic error with 'Error:' prefix", () => {
    const out = _formatResult({ error: "something broke" }, 3, 10, 8, 30000, []);
    assert.equal(out, "Error: something broke");
  });

  it("appends backend/model diagnostic for generic errors with meta", () => {
    const out = _formatResult(
      { error: "weird failure", _meta: { backend: "openai", model: "deep-search" } },
      3, 10, 8, 30000, []
    );
    assert.match(out, /\[backend=openai, model=deep-search\]/);
  });

  it("appends tree diagnostic when meta.treeDepth present", () => {
    const out = _formatResult(
      { error: "boom", _meta: { treeDepth: 3, treeSizeKB: 12.5 } },
      3, 10, 8, 30000, []
    );
    assert.match(out, /\[diagnostic\] tree_depth=3, tree_size=12\.5KB/);
  });

  it("does NOT treat port :429 as HTTP 429 (regex guard)", () => {
    const out = _formatResult({ error: "connect failed on host:429" }, 3, 10, 8, 30000, []);
    assert.ok(out.startsWith("Error:"), "port :429 should stay generic");
  });
});

describe("_formatResult — success branches", () => {
  it("returns 'No relevant files found.' when no files and no patterns", () => {
    const out = _formatResult({ files: [], rg_patterns: [] }, 3, 10, 8, 30000, []);
    assert.equal(out, "No relevant files found.");
  });

  it("lists found files with ranges (numbered)", () => {
    const out = _formatResult({
      files: [
        { full_path: "/p/a.mjs", path: "a.mjs", ranges: [[1, 5], [10, 12]] },
        { full_path: "/p/b.mjs", path: "b.mjs", ranges: [[3, 8]] },
      ],
    }, 3, 10, 8, 30000, []);
    assert.match(out, /Found 2 relevant files\./);
    assert.match(out, /\[1\/2\] \/p\/a\.mjs \(L1-5, L10-12\)/);
    assert.match(out, /\[2\/2\] \/p\/b\.mjs \(L3-8\)/);
  });

  it("appends grep keywords (deduped, length >= 3)", () => {
    const out = _formatResult({
      files: [{ full_path: "/p/a.mjs", path: "a.mjs", ranges: [[1, 2]] }],
      rg_patterns: ["auth", "auth", "db", "login"],
    }, 3, 10, 8, 30000, []);
    assert.match(out, /grep keywords: auth, login/);
    assert.ok(!/\bdb\b/.test(out.split("grep keywords:")[1] || ""), "short 'db' filtered out");
  });

  it("appends [config] line from meta", () => {
    const out = _formatResult({
      files: [{ full_path: "/p/a.mjs", path: "a.mjs", ranges: [[1, 2]] }],
      _meta: { backend: "windsurf", model: "SWE-1.6", treeDepth: 3, treeSizeKB: 20.1 },
    }, 4, 10, 8, 30000, []);
    assert.match(out, /\[config\] backend=windsurf, model=SWE-1\.6, tree_depth=3, tree_size=20\.1KB, max_turns=4/);
  });

  it("includes exclude_paths and cache_hit in config line", () => {
    const out = _formatResult({
      files: [{ full_path: "/p/a.mjs", path: "a.mjs", ranges: [[1, 2]] }],
      _meta: { treeDepth: 2, treeSizeKB: 5, cache_hit: true },
    }, 3, 10, 8, 30000, ["node_modules", "dist"]);
    assert.match(out, /exclude_paths=\[node_modules, dist\]/);
    assert.match(out, /cache_hit=true/);
  });

  it("marks fell back in config line", () => {
    const out = _formatResult({
      files: [{ full_path: "/p/a.mjs", path: "a.mjs", ranges: [[1, 2]] }],
      _meta: { treeDepth: 1, treeSizeKB: 5, fellBack: true },
    }, 3, 10, 8, 30000, []);
    assert.match(out, /tree_depth=1 \(fell back\)/);
  });

  it("shows only grep keywords when files empty but patterns present", () => {
    const out = _formatResult({ files: [], rg_patterns: ["handler", "router"] }, 3, 10, 8, 30000, []);
    assert.match(out, /No files found\./);
    assert.match(out, /grep keywords: handler, router/);
  });
});

describe("_formatResult — includeSnippets", () => {
  let dir, file;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fc-fmtres-"));
    file = join(dir, "code.mjs");
    writeFileSync(file, "line1\nline2\nline3\nline4\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("appends code snippets section when includeSnippets=true", () => {
    const out = _formatResult({
      files: [{ full_path: file, path: "code.mjs", ranges: [[1, 2]] }],
    }, 3, 10, 8, 30000, [], true);
    assert.match(out, /--- Code Snippets ---/);
    assert.match(out, /## code\.mjs/);
    assert.match(out, /1 \| line1/);
  });

  it("omits snippets section when includeSnippets=false", () => {
    const out = _formatResult({
      files: [{ full_path: file, path: "code.mjs", ranges: [[1, 2]] }],
    }, 3, 10, 8, 30000, [], false);
    assert.ok(!out.includes("--- Code Snippets ---"));
  });
});


