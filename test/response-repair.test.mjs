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

  it("repairs a key/value separator collapsed into an underscore", () => {
    const parsed = parseJsonWithRepair(
      '{"type":"readfile","file":"/codebase/src/a.mjs","start_4, "end_9}',
    );
    assert.deepEqual(parsed, {
      type: "readfile",
      file: "/codebase/src/a.mjs",
      start_line: 4,
      end_line: 9,
    });
  });

  it("keeps a real-world collapsed-separator payload executable", () => {
    // Captured from a live remote search (2026-10): the backend model dropped
    // the `": ` separators from every readfile line range in one turn.
    const raw =
      '[TOOL_CALLS]restricted_exec[ARGS]{"command1": {"type": "readfile", ' +
      '"file": "/codebase/src/orient.py", "start_350, "end_450}, ' +
      '"command2": {"type": "rg", "pattern": "line.*score", "path": "/codebase/src"}, ' +
      '"command3": {"type": "rg", "pattern": "perspective", "path": "/codebase/tests"}}';
    const parsed = _parseToolCall(raw);
    assert.equal(parsed[1], "restricted_exec");
    const commands = Object.values(parsed[2]);
    assert.equal(commands.length, 3);
    assert.equal(commands[0].type, "readfile");
    assert.equal(commands[0].file, "/codebase/src/orient.py");
    assert.equal(commands[0].start_line, 350);
    assert.equal(commands[0].end_line, 450);
    assert.equal(commands[2].pattern, "perspective");
  });

  it("does not let a loose readfile clobber a salvaged structured command", () => {
    // command2 is unparseable and dropped, so the loose readfile must take a
    // free key instead of overwriting the salvaged command3.
    const raw =
      '[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"rg","pattern":"a","path":"/codebase/src"},' +
      '"command2":{"type":"readfile","file":"/codebase/src/broken.mjs","start_x}, ' +
      '"command3":{"type":"rg","pattern":"c","path":"/codebase/tests"}, ' +
      '"command4":{"type":"readfile","file":"/codebase/src/loose.mjs"}}';
    const args = salvageRestrictedExecArgs(raw);
    assert.equal(args.command1.pattern, "a");
    assert.equal(args.command3.pattern, "c");
    assert.equal(args.command4.file, "/codebase/src/loose.mjs");
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
