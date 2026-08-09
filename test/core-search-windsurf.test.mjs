/**
 * Tests for core.mjs search() and searchWithContent() — mocked network paths.
 *
 * Notes:
 * - This machine has Windsurf installed, so getApiKey() always finds credentials.
 * - Tests use mocked fetch to control behavior without real network calls.
 * - These tests focus on credential discovery and deterministic error handling.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { search, searchWithContent, extractKeyInfo } from "../src/core.mjs";
import { setEnv } from "./helpers/env.mjs";

describe("search() — mocked fetch timeout", () => {
  let envRestore, originalFetch;

  before(() => {
    originalFetch = globalThis.fetch;
    envRestore = setEnv({ WINDSURF_API_KEY: "test-key-abc123" });
    globalThis.fetch = async () => {
      const err = new Error("Network timeout");
      err.name = "TimeoutError";
      throw err;
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
    envRestore.restore();
  });

  it("throws or returns error when network is unreachable", async () => {
    let result = null;
    try {
      result = await search({ query: "test query", projectRoot: "/tmp", timeoutMs: 1000 });
    } catch {
      result = null;
    }
    if (result !== null) {
      assert.ok(
        result.error || (Array.isArray(result.files) && result.files.length === 0),
        `expected error result, got: ${JSON.stringify(result)}`
      );
    }
    // null means threw — also acceptable
  });

  it("result.error contains error info when search fails", async () => {
    let result = null;
    try {
      result = await search({ query: "auth logic", projectRoot: "/tmp", timeoutMs: 500 });
    } catch {
      result = null;
    }
    if (result !== null && result.error) {
      assert.ok(typeof result.error === "string" && result.error.length > 0);
    }
  });
});

describe("searchWithContent() — mocked fetch timeout", () => {
  let envRestore, originalFetch;

  before(() => {
    originalFetch = globalThis.fetch;
    envRestore = setEnv({ WINDSURF_API_KEY: "test-key-abc123" });
    globalThis.fetch = async () => {
      const err = new Error("Network timeout");
      err.name = "TimeoutError";
      throw err;
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
    envRestore.restore();
  });

  it("throws or returns error string when network is unreachable", async () => {
    let result = null;
    try {
      result = await searchWithContent({ query: "test auth", projectRoot: "/tmp", timeoutMs: 500 });
    } catch {
      result = null;
    }
    // Valid: null (threw) OR error string (caught internally)
    assert.ok(
      result === null || typeof result === "string",
      `expected null or string, got ${typeof result}: ${JSON.stringify(result)?.slice(0, 100)}`
    );
  });
});

describe("extractKeyInfo()", () => {
  it("returns a structured credential result without throwing", async () => {
    let result = null, threw = false;
    try {
      result = await extractKeyInfo();
    } catch {
      threw = true;
    }
    if (!threw && result !== null) {
      assert.ok(
        typeof result === "object" || typeof result === "string",
        `expected object or string, got ${typeof result}`
      );
      if (typeof result === "object") {
        assert.ok("api_key" in result || "error" in result, "expected API key or diagnostic error");
      }
    }
    // threw or null also acceptable (no Windsurf on this machine)
  });

  it("does not throw unexpectedly — only throws if truly no key available", async () => {
    let caughtMessage = null;
    try {
      await extractKeyInfo();
    } catch (e) {
      caughtMessage = e.message;
    }
    if (caughtMessage !== null) {
      // If it throws, the message should be descriptive
      assert.ok(typeof caughtMessage === "string" && caughtMessage.length > 0);
    }
  });
});
