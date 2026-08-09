import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSnippets } from "../deepgrep/src/snippets.mjs";

describe("readSnippets", () => {
  let dir, file;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fc-snip-"));
    file = join(dir, "code.js");
    writeFileSync(file, "line1\nline2\nline3\nline4\nline5\n");
    delete process.env.FC_SNIPPET_MAX_LINES;
    delete process.env.FC_LINE_MAX_CHARS;
  });

  it("reads correct line range (1-indexed inclusive)", () => {
    const m = readSnippets([{ full_path: file, ranges: [[2, 4]] }]);
    const s = m.get(file);
    assert(s.includes("2 | line2"));
    assert(s.includes("4 | line4"));
    assert(!s.includes("1 | line1"));
    assert(!s.includes("5 | line5"));
  });

  it("returns empty Map for empty files array", () => {
    assert.equal(readSnippets([]).size, 0);
  });

  it("skips non-existent files", () => {
    const m = readSnippets([{ full_path: "/no/such/file", ranges: [[1, 5]] }]);
    assert.equal(m.size, 0);
  });

  it("detects binary files and skips with message", () => {
    const bin = join(dir, "img.png");
    writeFileSync(bin, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]));
    const m = readSnippets([{ full_path: bin, ranges: [[1, 5]] }]);
    assert(m.get(bin).includes("binary"));
  });

  it("caps long lines with FC_LINE_MAX_CHARS", () => {
    const longFile = join(dir, "long.js");
    writeFileSync(longFile, "A".repeat(500) + "\n");
    process.env.FC_LINE_MAX_CHARS = "50";
    const m = readSnippets([{ full_path: longFile, ranges: [[1, 1]] }]);
    assert(m.get(longFile).includes("[truncated]"));
  });

  it("respects FC_SNIPPET_MAX_LINES budget", () => {
    process.env.FC_SNIPPET_MAX_LINES = "2";
    const m = readSnippets([{ full_path: file, ranges: [[1, 5]] }]);
    const lines = m.get(file).split("\n").filter(l => /^\d+ \|/.test(l));
    assert(lines.length <= 2);
  });

  it("adds truncation marker when budget reached", () => {
    process.env.FC_SNIPPET_MAX_LINES = "2";
    const m = readSnippets([{ full_path: file, ranges: [[1, 5]] }]);
    assert(m.get(file).includes("[range truncated"));
  });

  it("skips inverted range (start > end)", () => {
    const m = readSnippets([{ full_path: file, ranges: [[5, 2]] }]);
    assert(!m.has(file));
  });

  it("handles OOB range gracefully", () => {
    const m = readSnippets([{ full_path: file, ranges: [[100, 200]] }]);
    assert(!m.has(file));
  });

  it("handles range [1,1] (single line)", () => {
    const m = readSnippets([{ full_path: file, ranges: [[1, 1]] }]);
    const s = m.get(file);
    assert(s.includes("1 | line1"));
    assert(!s.includes("2 |"));
  });
});
