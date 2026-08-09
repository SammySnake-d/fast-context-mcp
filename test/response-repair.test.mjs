import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _parseToolCall } from "../src/core.mjs";
import {
  parseJsonWithRepair,
  salvageRestrictedExecArgs,
  salvageSearchEvidence,
} from "../src/response-repair.mjs";

describe("malformed restricted_exec response repair", () => {
  it("repairs a missing opening quote on a key and trailing commas", () => {
    const parsed = parseJsonWithRepair('{"path":"/codebase/system",exclude":[],}');
    assert.deepEqual(parsed, { path: "/codebase/system", exclude: [] });
  });

  it("keeps a malformed restricted_exec turn executable", () => {
    const raw = '[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"rg","pattern":"PROTONET_LOG","path":"/codebase/system",exclude":[]}}';
    const parsed = _parseToolCall(raw);
    assert.equal(parsed[1], "restricted_exec");
    assert.equal(parsed[2].command1.type, "rg");
    assert.deepEqual(parsed[2].command1.exclude, []);
  });

  it("salvages readfile commands when the outer JSON is truncated", () => {
    const args = salvageRestrictedExecArgs('[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"readfile","file":"/codebase/src/a.mjs","start_line":4,"end_line":9}');
    assert.equal(args.command1.file, "/codebase/src/a.mjs");
    assert.equal(args.command1.start_line, 4);
  });

  it("salvages safe file hits, line ranges, and rg patterns", () => {
    const root = mkdtempSync(join(tmpdir(), "fc-salvage-"));
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "a.mjs"), "export const a = 1;\n");
      const raw = '"type":"readfile","file":"/codebase/src/a.mjs","start_line":4,"end_line":9, "pattern":"PROTONET_LOG"';
      const result = salvageSearchEvidence(raw, root);
      assert.equal(result.files.length, 1);
      assert.equal(result.files[0].full_path, join(root, "src", "a.mjs"));
      assert.deepEqual(result.files[0].ranges, [[4, 9]]);
      assert.deepEqual(result.rg_patterns, ["PROTONET_LOG"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("drops salvaged paths outside the project", () => {
    const result = salvageSearchEvidence('"file":"/codebase/../../etc/passwd"', process.cwd());
    assert.equal(result.files.length, 0);
  });
});
