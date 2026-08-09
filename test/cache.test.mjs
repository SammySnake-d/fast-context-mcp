import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCacheKey, getCachedResult, setCachedResult, clearCache, computeMtimeHash } from "../deepgrep/src/cache.mjs";

describe("buildCacheKey", () => {
  it("produces deterministic 64-char hex", () => {
    const k = buildCacheKey({ query: "q", model: "m", maxTurns: 3, maxResults: 10, treeDepth: 3, repoMapHash: "t", mtimeHash: "h" });
    assert.equal(k.length, 64);
    assert.equal(k, buildCacheKey({ query: "q", model: "m", maxTurns: 3, maxResults: 10, treeDepth: 3, repoMapHash: "t", mtimeHash: "h" }));
  });

  it("different query → different key", () => {
    const k1 = buildCacheKey({ query: "a", model: "m", maxTurns: 3, maxResults: 10, treeDepth: 3, repoMapHash: "t", mtimeHash: "h" });
    const k2 = buildCacheKey({ query: "b", model: "m", maxTurns: 3, maxResults: 10, treeDepth: 3, repoMapHash: "t", mtimeHash: "h" });
    assert.notEqual(k1, k2);
  });

  it("different mtimeHash → different key", () => {
    const k1 = buildCacheKey({ query: "q", model: "m", maxTurns: 3, maxResults: 10, treeDepth: 3, repoMapHash: "t", mtimeHash: "h1" });
    const k2 = buildCacheKey({ query: "q", model: "m", maxTurns: 3, maxResults: 10, treeDepth: 3, repoMapHash: "t", mtimeHash: "h2" });
    assert.notEqual(k1, k2);
  });

  it("excludePaths affects key", () => {
    const k1 = buildCacheKey({ query: "q", model: "m", maxTurns: 3, maxResults: 10, treeDepth: 3, repoMapHash: "t", excludePaths: ["a"] });
    const k2 = buildCacheKey({ query: "q", model: "m", maxTurns: 3, maxResults: 10, treeDepth: 3, repoMapHash: "t", excludePaths: ["b"] });
    assert.notEqual(k1, k2);
  });
});

describe("getCachedResult / setCachedResult", () => {
  beforeEach(() => {
    clearCache();
    delete process.env.FC_CACHE_DISABLED;
    delete process.env.FC_CACHE_TTL_MS;
    delete process.env.FC_CACHE_MAX_ENTRIES;
    delete process.env.DEEPGREP_CACHE_DISABLED;
    delete process.env.DEEPGREP_CACHE_TTL_MS;
    delete process.env.DEEPGREP_CACHE_MAX_ENTRIES;
  });

  it("returns null on miss", () => {
    assert.equal(getCachedResult("nope"), null);
  });

  it("round-trips a stored result", () => {
    setCachedResult("k", { files: [{ path: "x" }] });
    const r = getCachedResult("k");
    assert.equal(r.files[0].path, "x");
  });

  it("FC_CACHE_DISABLED=true disables", () => {
    process.env.FC_CACHE_DISABLED = "true";
    setCachedResult("k", { a: 1 });
    assert.equal(getCachedResult("k"), null);
  });

  it("FC_CACHE_DISABLED=yes disables", () => {
    process.env.FC_CACHE_DISABLED = "yes";
    setCachedResult("k", { a: 1 });
    assert.equal(getCachedResult("k"), null);
  });

  it("FC_CACHE_TTL_MS=0 disables", () => {
    process.env.FC_CACHE_TTL_MS = "0";
    setCachedResult("k", { a: 1 });
    assert.equal(getCachedResult("k"), null);
  });

  it("DEEPGREP_CACHE_DISABLED=true disables (new env name)", () => {
    process.env.DEEPGREP_CACHE_DISABLED = "true";
    setCachedResult("k", { a: 1 });
    assert.equal(getCachedResult("k"), null);
  });

  it("DEEPGREP_CACHE_DISABLED takes precedence over legacy FC_CACHE_DISABLED", () => {
    process.env.DEEPGREP_CACHE_DISABLED = "true";
    process.env.FC_CACHE_DISABLED = "false";
    setCachedResult("k", { a: 1 });
    assert.equal(getCachedResult("k"), null);
  });

  it("DEEPGREP_CACHE_TTL_MS=0 disables (new env name)", () => {
    process.env.DEEPGREP_CACHE_TTL_MS = "0";
    setCachedResult("k", { a: 1 });
    assert.equal(getCachedResult("k"), null);
  });

  it("DEEPGREP_CACHE_MAX_ENTRIES caps entries (new env name)", () => {
    process.env.DEEPGREP_CACHE_MAX_ENTRIES = "2";
    setCachedResult("a", { n: 1 });
    setCachedResult("b", { n: 2 });
    setCachedResult("c", { n: 3 });
    assert.equal(getCachedResult("a"), null);
    assert.notEqual(getCachedResult("c"), null);
  });

  it("TTL expiry evicts entry", async () => {
    process.env.FC_CACHE_TTL_MS = "1";
    setCachedResult("k", { a: 1 });
    await new Promise(r => setTimeout(r, 10));
    assert.equal(getCachedResult("k"), null);
  });

  it("max entries cap evicts oldest", () => {
    process.env.FC_CACHE_MAX_ENTRIES = "2";
    setCachedResult("a", { n: 1 });
    setCachedResult("b", { n: 2 });
    setCachedResult("c", { n: 3 });
    assert.equal(getCachedResult("a"), null);
    assert.notEqual(getCachedResult("c"), null);
  });
});

describe("computeMtimeHash", () => {
  it("changes when file content changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fc-mtime-"));
    const f = join(dir, "x.js");
    writeFileSync(f, "v1");
    const h1 = computeMtimeHash(dir, []);
    await new Promise(r => setTimeout(r, 15));
    writeFileSync(f, "v2");
    const h2 = computeMtimeHash(dir, []);
    assert.notEqual(h1, h2);
    rmSync(dir, { recursive: true });
  });

  it("respects excludePaths", () => {
    const dir = mkdtempSync(join(tmpdir(), "fc-excl-"));
    writeFileSync(join(dir, "a.js"), "a");
    writeFileSync(join(dir, "b.js"), "b");
    const hAll = computeMtimeHash(dir, []);
    const hExcl = computeMtimeHash(dir, ["b.js"]);
    assert.notEqual(hAll, hExcl);
    rmSync(dir, { recursive: true });
  });
});
