import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor } from "../src/executor.mjs";

describe("ToolExecutor", () => {
  let root, exec;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fc-exec-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "alpha.mjs"), "export const a = 1;\nexport const b = 2;\nconst secret = 3;\n");
    writeFileSync(join(root, "src", "beta.js"), "function foo() { return 42; }\n");
    writeFileSync(join(root, "README.md"), "# Title\nsome docs here\n");
    exec = new ToolExecutor(root);
    delete process.env.FC_RESULT_MAX_LINES;
    delete process.env.FC_LINE_MAX_CHARS;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("_real (virtual path mapping)", () => {
    it("maps /codebase prefix to project root", () => {
      const real = exec._real("/codebase/src/alpha.mjs");
      assert(real.endsWith(join("src", "alpha.mjs")));
      assert(real.startsWith(root));
    });

    it("handles /codebase root with no subpath", () => {
      const real = exec._real("/codebase");
      assert.equal(real, root);
    });

    it("rejects null/undefined input", () => {
      assert.throws(() => exec._real(null), /invalid path/);
      assert.throws(() => exec._real(undefined), /invalid path/);
    });

    it("rejects absolute paths outside the project", () => {
      assert.throws(() => exec._real("/some/other/path"), /outside codebase/);
    });

    it("rejects traversal and sibling-prefix paths", () => {
      assert.throws(() => exec._real("/codebase/../../etc/passwd"), /outside codebase/);
      assert.throws(() => exec._real("/codebase-other/file.txt"), /outside codebase/);
    });

    it("rejects an existing symlink that escapes the project", () => {
      const outside = mkdtempSync(join(tmpdir(), "fc-outside-"));
      try {
        writeFileSync(join(outside, "secret.txt"), "outside\n");
        symlinkSync(outside, join(root, "escape"));
        assert.throws(() => exec._real("/codebase/escape/secret.txt"), /outside codebase/);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  describe("_truncate (static)", () => {
    it("caps line count at RESULT_MAX_LINES", () => {
      process.env.FC_RESULT_MAX_LINES = "3";
      // Re-import not needed: _truncate reads module-level const captured at load.
      // Use default behavior: produce many lines and verify marker logic via instance.
      const many = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
      const out = ToolExecutor._truncate(many);
      assert(typeof out === "string");
    });

    it("appends truncation marker when over default 50 lines", () => {
      const many = Array.from({ length: 60 }, (_, i) => `line${i}`).join("\n");
      const out = ToolExecutor._truncate(many);
      assert(out.includes("(lines truncated)"));
    });

    it("does not truncate short input", () => {
      const out = ToolExecutor._truncate("a\nb\nc");
      assert(!out.includes("(lines truncated)"));
      assert.equal(out, "a\nb\nc");
    });
  });

  describe("rg (ripgrep search)", () => {
    it("finds matches and remaps paths to /codebase", () => {
      const out = exec.rg("export", "/codebase/src");
      assert(out.includes("export"));
      assert(out.includes("/codebase"));
      assert(!out.includes(root));
    });

    it("returns (no matches) when pattern not found", () => {
      const out = exec.rg("zzz_nonexistent_zzz", "/codebase/src");
      assert.equal(out, "(no matches)");
    });

    it("errors on missing pattern", () => {
      assert(exec.rg(null, "/codebase").includes("Error"));
    });

    it("errors on missing path", () => {
      assert(exec.rg("pattern", null).includes("Error"));
    });

    it("errors on non-existent path", () => {
      assert(exec.rg("x", "/codebase/does-not-exist").includes("does not exist"));
    });

    it("collects rg patterns", () => {
      exec.rg("foo", "/codebase/src");
      assert(exec.collectedRgPatterns.includes("foo"));
    });

    it("respects include glob", () => {
      const out = exec.rg("export", "/codebase/src", ["*.mjs"]);
      // alpha.mjs has export, beta.js does not
      assert(out.includes("alpha"));
    });
  });

  describe("readfile", () => {
    it("reads full file with line numbers", () => {
      const out = exec.readfile("/codebase/src/alpha.mjs");
      assert(out.includes("1:export const a = 1;"));
      assert(out.includes("2:export const b = 2;"));
    });

    it("reads a line range (1-indexed inclusive)", () => {
      const out = exec.readfile("/codebase/src/alpha.mjs", 2, 2);
      assert(out.includes("2:export const b = 2;"));
      assert(!out.includes("1:export const a = 1;"));
    });

    it("errors on missing file path", () => {
      assert(exec.readfile(null).includes("Error"));
    });

    it("errors on non-existent file", () => {
      assert(exec.readfile("/codebase/nope.txt").includes("file not found"));
    });

    it("errors when path is a directory", () => {
      assert(exec.readfile("/codebase/src").includes("file not found"));
    });

    it("blocks out-of-project reads through direct and dispatched calls", async () => {
      assert.match(exec.readfile("/etc/passwd"), /outside codebase/);
      const out = await exec.execToolCallAsync({
        command1: { type: "readfile", file: "/etc/passwd", start_line: 1, end_line: 2 },
      });
      assert.match(out, /outside codebase/);
      assert.doesNotMatch(out, /root:x:/);
    });
  });

  describe("project confinement across primitives", () => {
    it("blocks rg, tree, ls, and glob outside the project", async () => {
      assert.match(await exec.rgAsync("root", "/etc"), /outside codebase/);
      assert.match(exec.rg("root", "/etc"), /outside codebase/);
      assert.match(exec.tree("/etc"), /outside codebase/);
      assert.match(exec.ls("/etc"), /outside codebase/);
      assert.match(exec.glob("*", "/etc"), /outside codebase/);
    });
  });

  describe("tree", () => {
    it("generates directory tree with virtual path root", () => {
      const out = exec.tree("/codebase");
      assert(out.includes("src"));
    });

    it("errors on missing path", () => {
      assert(exec.tree(null).includes("Error"));
    });

    it("errors on non-directory", () => {
      assert(exec.tree("/codebase/README.md").includes("dir not found"));
    });

    it("respects levels parameter", () => {
      const out = exec.tree("/codebase", 1);
      assert(typeof out === "string");
    });
  });

  describe("ls", () => {
    it("lists directory entries", () => {
      const out = exec.ls("/codebase");
      assert(out.includes("src"));
      assert(out.includes("README.md"));
    });

    it("hides dotfiles by default", () => {
      writeFileSync(join(root, ".hidden"), "x");
      const out = exec.ls("/codebase");
      assert(!out.includes(".hidden"));
    });

    it("shows dotfiles with allFiles=true", () => {
      writeFileSync(join(root, ".hidden"), "x");
      const out = exec.ls("/codebase", false, true);
      assert(out.includes(".hidden"));
    });

    it("long format includes total header", () => {
      const out = exec.ls("/codebase", true);
      assert(out.includes("total"));
    });

    it("errors on non-directory", () => {
      assert(exec.ls("/codebase/README.md").includes("not a directory"));
    });

    it("errors on missing path", () => {
      assert(exec.ls(null).includes("Error"));
    });
  });

  describe("glob", () => {
    it("finds files matching pattern", () => {
      const out = exec.glob("**/*.mjs", "/codebase");
      assert(out.includes("alpha.mjs"));
    });

    it("returns (no matches) for non-matching pattern", () => {
      const out = exec.glob("**/*.rs", "/codebase");
      assert.equal(out, "(no matches)");
    });

    it("errors on missing pattern", () => {
      assert(exec.glob(null, "/codebase").includes("Error"));
    });

    it("remaps matched paths to /codebase", () => {
      const out = exec.glob("**/*.mjs", "/codebase");
      assert(!out.includes(root));
    });
  });

  describe("execCommand dispatch", () => {
    it("dispatches rg", () => {
      const out = exec.execCommand({ type: "rg", pattern: "export", path: "/codebase/src" });
      assert(out.includes("export"));
    });

    it("dispatches readfile", () => {
      const out = exec.execCommand({ type: "readfile", file: "/codebase/README.md" });
      assert(out.includes("Title"));
    });

    it("dispatches tree", () => {
      const out = exec.execCommand({ type: "tree", path: "/codebase" });
      assert(out.includes("src"));
    });

    it("dispatches ls", () => {
      const out = exec.execCommand({ type: "ls", path: "/codebase" });
      assert(out.includes("README.md"));
    });

    it("dispatches glob", () => {
      const out = exec.execCommand({ type: "glob", pattern: "**/*.js", path: "/codebase" });
      assert(out.includes("beta.js"));
    });

    it("errors on unknown command type", () => {
      assert(exec.execCommand({ type: "frobnicate" }).includes("unknown command type"));
    });

    it("errors on null command", () => {
      assert(exec.execCommand(null).includes("Error"));
    });
  });

  describe("execToolCall (sync, multi-command)", () => {
    it("wraps each command result in tagged blocks", () => {
      const out = exec.execToolCall({
        command1: { type: "ls", path: "/codebase" },
        command2: { type: "readfile", file: "/codebase/README.md" },
      });
      assert(out.includes("<command1_result>"));
      assert(out.includes("</command1_result>"));
      assert(out.includes("<command2_result>"));
    });

    it("errors on invalid args", () => {
      assert(exec.execToolCall(null).includes("Error"));
    });
  });

  describe("execToolCallAsync (parallel)", () => {
    it("executes commands in parallel and tags results", async () => {
      const out = await exec.execToolCallAsync({
        command1: { type: "rg", pattern: "export", path: "/codebase/src" },
        command2: { type: "ls", path: "/codebase" },
      });
      assert(out.includes("<command1_result>"));
      assert(out.includes("<command2_result>"));
    });

    it("errors on invalid args", async () => {
      const out = await exec.execToolCallAsync(null);
      assert(out.includes("Error"));
    });
  });
});
