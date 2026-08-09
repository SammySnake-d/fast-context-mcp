import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WindsurfBackend } from "../deepgrep/src/backends/windsurf.mjs";
import { OpenAIBackend } from "../deepgrep/src/backends/openai.mjs";

describe("WindsurfBackend", () => {
  it("has name 'windsurf'", () => {
    assert.equal(new WindsurfBackend().name, "windsurf");
  });

  it("has model 'SWE-1.6'", () => {
    assert.equal(new WindsurfBackend().model, "SWE-1.6");
  });

  it("exposes async search method", () => {
    const b = new WindsurfBackend();
    assert.equal(typeof b.search, "function");
    // search returns a promise (delegates to core.search)
    const ret = b.search({ query: "x", projectRoot: "/nonexistent-xyz" }).catch(() => {});
    assert(ret instanceof Promise);
  });
});

describe("OpenAIBackend", () => {
  it("has name 'openai'", () => {
    assert.equal(new OpenAIBackend().name, "openai");
  });

  it("exposes async search method", () => {
    const b = new OpenAIBackend();
    assert.equal(typeof b.search, "function");
    const ret = b.search({ query: "x", projectRoot: "/nonexistent-xyz", apiKey: "fake" }).catch(() => {});
    assert(ret instanceof Promise);
  });
});
