import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getBackend, listBackends, registerBackend } from "../deepgrep/src/backends/index.mjs";

describe("Backend Registry", () => {
  it("lists windsurf and openai", () => {
    const names = listBackends();
    assert(names.includes("windsurf"));
    assert(names.includes("openai"));
  });

  it("getBackend('windsurf') returns object with search method", () => {
    const b = getBackend("windsurf");
    assert.equal(b.name, "windsurf");
    assert.equal(typeof b.search, "function");
  });

  it("getBackend('openai') returns object with search method", () => {
    const b = getBackend("openai");
    assert.equal(b.name, "openai");
    assert.equal(typeof b.search, "function");
  });

  it("getBackend throws for unknown backend", () => {
    assert.throws(() => getBackend("nonexistent"), /Unknown backend/);
  });

  it("registerBackend adds a new backend", () => {
    registerBackend({ name: "test-backend", model: "test", search: async () => ({}) });
    const b = getBackend("test-backend");
    assert.equal(b.name, "test-backend");
  });
});
