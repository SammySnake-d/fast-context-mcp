import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSnippetToolOutput } from "../deepgrep/src/server.mjs";

describe("formatSnippetToolOutput", () => {
  let dir, file;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fc-sft-"));
    file = join(dir, "auth.mjs");
    writeFileSync(file, [
      "export function login(user, pass) {",
      "  const hash = hashPassword(pass);",
      "  const record = db.findUser(user);",
      "  if (!record) return null;",
      "  return record.hash === hash;",
      "}",
    ].join("\n") + "\n");
    delete process.env.FC_SNIPPET_MAX_LINES;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("AC1: returns correct output format with line numbers (AC7 format)", () => {
    const out = formatSnippetToolOutput({ files: [{ file, ranges: [[1, 3]] }] });
    assert.match(out, /^## .+ \(L1-3\)/);
    assert.match(out, /```/);
    assert.match(out, /1 \| export function login/);
    assert.match(out, /2 \| /);
    assert.match(out, /3 \| /);
  });

  it("AC5: empty files array returns 'No files/ranges provided'", () => {
    const out = formatSnippetToolOutput({ files: [] });
    assert.equal(out, "No files/ranges provided");
  });

  it("AC5: file with empty ranges array is skipped → 'No files/ranges provided'", () => {
    const out = formatSnippetToolOutput({ files: [{ file, ranges: [] }] });
    assert.equal(out, "No files/ranges provided");
  });

  it("AC4: out-of-bounds range returns 'No snippets found for given ranges.'", () => {
    const out = formatSnippetToolOutput({ files: [{ file, ranges: [[999, 1000]] }] });
    assert.equal(out, "No snippets found for given ranges.");
  });

  it("AC6: does not read DEEPGREP_API_KEY (pure local, no API call)", () => {
    const original = process.env.DEEPGREP_API_KEY;
    delete process.env.DEEPGREP_API_KEY;
    const out = formatSnippetToolOutput({ files: [{ file, ranges: [[1, 2]] }] });
    assert.match(out, /1 \| /);
    if (original !== undefined) process.env.DEEPGREP_API_KEY = original;
  });

  it("multiple ranges in one file → comma-separated in header", () => {
    const out = formatSnippetToolOutput({ files: [{ file, ranges: [[1, 2], [4, 5]] }] });
    assert.match(out, /L1-2, L4-5/);
  });

  it("AC3: binary file produces '[binary file — snippet omitted]'", () => {
    const binFile = join(dir, "binary.bin");
    writeFileSync(binFile, Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const out = formatSnippetToolOutput({ files: [{ file: binFile, ranges: [[1, 1]] }] });
    assert.match(out, /binary file/i);
  });

  it("AC2: respects FC_SNIPPET_MAX_LINES budget", () => {
    process.env.FC_SNIPPET_MAX_LINES = "2";
    const out = formatSnippetToolOutput({ files: [{ file, ranges: [[1, 6]] }] });
    const lines = out.split("\n").filter(l => /^\d+ \|/.test(l));
    assert.ok(lines.length <= 2, `expected ≤2 code lines, got ${lines.length}`);
    delete process.env.FC_SNIPPET_MAX_LINES;
  });
});
