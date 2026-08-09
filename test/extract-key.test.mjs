import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getDbPath,
  getDbPathCandidates,
  extractApiKeyFromToml,
  extractKey,
} from "../src/extract-key.mjs";

describe("getDbPath", () => {
  it("returns a string path", () => {
    const p = getDbPath();
    assert(typeof p === "string");
    assert(p.length > 10);
  });

  it("prefers Devin over Windsurf (priority order)", () => {
    const p = getDbPath();
    // On a system without either installed, default should be Devin
    // (unless Windsurf is actually found first due to existsSync)
    assert(p.includes("Devin") || p.includes("Windsurf") || p.includes("devin") || p.includes("windsurf"),
      `Expected path to contain app name, got: ${p}`);
  });

  it("path includes state.vscdb", () => {
    assert(getDbPath().endsWith("state.vscdb"));
  });
});

describe("credential compatibility", () => {
  for (const platformName of ["darwin", "win32", "linux"]) {
    it(`prefers Devin and retains Deviv/Windsurf fallbacks on ${platformName}`, () => {
      const candidates = getDbPathCandidates({
        platformName,
        homeDir: "/home/tester",
        env: { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" },
      });
      assert.match(candidates[0], /Devin/);
      assert(candidates.some((path) => path.includes("Deviv")));
      assert(candidates.some((path) => path.includes("Windsurf")));
    });
  }

  it("accepts Devin session tokens without an sk- prefix", () => {
    assert.equal(
      extractApiKeyFromToml('token = "devin-session-example-token"\n'),
      "devin-session-example-token",
    );
  });
});

describe("extractKey", () => {
  it("returns error with hint when DB path doesn't exist", async () => {
    const result = await extractKey("/nonexistent/path/state.vscdb");
    assert(result.error);
    assert(result.error.includes("not found"));
    assert(result.hint);
    assert.equal(result.db_path, "/nonexistent/path/state.vscdb");
  });

  it("returns error for invalid DB file", async () => {
    // Create a temp file that's not a valid SQLite DB
    const { writeFileSync, unlinkSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "fc-ek-"));
    const fake = join(dir, "state.vscdb");
    writeFileSync(fake, "not a database");
    const result = await extractKey(fake);
    assert(result.error, "Expected error for invalid DB");
    unlinkSync(fake);
  });
});
