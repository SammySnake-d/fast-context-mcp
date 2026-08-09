import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { _parseAnswer } from "../src/shared.mjs";

const ROOT = process.cwd();

describe("_parseAnswer", () => {
  it("parses valid XML with files and ranges", () => {
    const xml = `<ANSWER>
  <file path="/codebase/src/core.mjs"><range>10-60</range><range>100-120</range></file>
  <file path="/codebase/README.md"><range>1-5</range></file>
</ANSWER>`;
    const result = _parseAnswer(xml, ROOT);
    assert.equal(result.files.length, 2);
    assert.equal(result.files[0].path, "src/core.mjs");
    assert.deepEqual(result.files[0].ranges, [[10, 60], [100, 120]]);
    assert.equal(result.files[1].path, "README.md");
  });

  it("rejects path traversal (../)", () => {
    const xml = `<ANSWER><file path="/codebase/../../etc/passwd"><range>1-10</range></file></ANSWER>`;
    const result = _parseAnswer(xml, ROOT);
    assert.equal(result.files.length, 0);
  });

  it("rejects absolute path outside root", () => {
    const xml = `<ANSWER><file path="/codebase/../../../etc/shadow"><range>1-5</range></file></ANSWER>`;
    const result = _parseAnswer(xml, ROOT);
    assert.equal(result.files.length, 0);
  });

  it("handles empty ANSWER", () => {
    const result = _parseAnswer("<ANSWER></ANSWER>", ROOT);
    assert.equal(result.files.length, 0);
  });

  it("handles no ANSWER tag at all", () => {
    const result = _parseAnswer("no xml here", ROOT);
    assert.equal(result.files.length, 0);
  });
});
