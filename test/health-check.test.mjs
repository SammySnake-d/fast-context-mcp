/**
 * Tests for health.mjs checkHealth() — the network-facing health check.
 *
 * Uses node:test mock API to stub global fetch.
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { checkHealth } from "../deepgrep/src/health.mjs";
import { setEnv } from "./helpers/env.mjs";

describe("checkHealth — with mocked fetch", () => {
  let originalFetch, envRestore;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    envRestore = setEnv({
      DEEPGREP_API_KEY: "test-key-123",
      DEEPGREP_API_URL: "https://fake.api/v1",
      DEEPGREP_MODEL: "test-model",
      DEEPGREP_FAST_BACKEND: "windsurf",
      DEEPGREP_FAST_MODEL: "",
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    envRestore.restore();
  });

  it("returns keyValid=true when API responds 200", async () => {
    globalThis.fetch = mock.fn(async () => ({ status: 200 }));

    const report = await checkHealth();
    assert.equal(report.keyPresent, true);
    assert.equal(report.keyValid, true);
    assert.equal(report.keyStatus, "ok");
    assert.equal(report.endpointReachable, true);
  });

  it("returns keyValid=true when API responds 429 (rate limited but key valid)", async () => {
    globalThis.fetch = mock.fn(async () => ({ status: 429 }));

    const report = await checkHealth();
    assert.equal(report.keyValid, true);
    assert.equal(report.keyStatus, "rate_limited");
    assert.equal(report.endpointReachable, true);
  });

  it("returns keyValid=false when API responds 401", async () => {
    globalThis.fetch = mock.fn(async () => ({ status: 401 }));

    const report = await checkHealth();
    assert.equal(report.keyValid, false);
    assert.equal(report.keyStatus, "unauthorized");
    assert.equal(report.endpointReachable, true);
  });

  it("returns endpointReachable=false on timeout", async () => {
    globalThis.fetch = mock.fn(async () => {
      const err = new Error("timeout");
      err.name = "AbortError";
      throw err;
    });

    const report = await checkHealth();
    assert.equal(report.keyValid, false);
    assert.equal(report.keyStatus, "error:timeout");
    assert.equal(report.endpointReachable, false);
  });

  it("returns endpointReachable=false on network error", async () => {
    globalThis.fetch = mock.fn(async () => {
      throw new Error("fetch failed");
    });

    const report = await checkHealth();
    assert.equal(report.keyValid, false);
    assert(report.keyStatus.startsWith("error:"));
    assert.equal(report.endpointReachable, false);
  });

  it("returns endpointReachable=true on server error (500)", async () => {
    globalThis.fetch = mock.fn(async () => ({ status: 500 }));

    const report = await checkHealth();
    assert.equal(report.keyValid, false);
    assert.equal(report.keyStatus, "error:500");
    // Server responded with a code, so endpoint IS reachable
    assert.equal(report.endpointReachable, true);
  });

  it("returns keyPresent=false and null endpoint when no key", async () => {
    envRestore.restore();
    envRestore = setEnv({
      DEEPGREP_API_KEY: "",
      DEEPGREP_API_URL: "https://fake.api/v1",
      DEEPGREP_MODEL: "test-model",
      DEEPGREP_FAST_BACKEND: "windsurf",
      DEEPGREP_FAST_MODEL: "",
    });
    globalThis.fetch = mock.fn(async () => ({ status: 200 }));

    const report = await checkHealth();
    assert.equal(report.keyPresent, false);
    assert.equal(report.keyValid, false);
    assert.equal(report.endpointReachable, null);
    assert.equal(report.models.length, 0);
    // fetch should NOT have been called
    assert.equal(globalThis.fetch.mock.calls.length, 0);
  });

  it("includes correct config in report", async () => {
    globalThis.fetch = mock.fn(async () => ({ status: 200 }));

    const report = await checkHealth();
    assert.equal(report.config.fastBackend, "windsurf");
    assert.equal(report.config.deepModel, "test-model");
    assert.equal(report.endpoint, "https://fake.api/v1");
    assert.equal(report.signupUrl, "https://deepgrep.chainlens.net");
  });

  it("reports model with correct id and status", async () => {
    globalThis.fetch = mock.fn(async () => ({ status: 200 }));

    const report = await checkHealth();
    assert.equal(report.models.length, 1);
    assert.equal(report.models[0].id, "test-model");
    assert.equal(report.models[0].status, "ok");
  });

  it("trims trailing slashes from API URL", async () => {
    envRestore.restore();
    envRestore = setEnv({
      DEEPGREP_API_KEY: "key",
      DEEPGREP_API_URL: "https://fake.api/v1///",
      DEEPGREP_MODEL: "m",
      DEEPGREP_FAST_BACKEND: "windsurf",
      DEEPGREP_FAST_MODEL: "",
    });
    globalThis.fetch = mock.fn(async (url) => {
      // Verify the URL doesn't have double slashes
      assert(!url.includes("//chat"), `URL should not have // before chat: ${url}`);
      return { status: 200 };
    });

    const report = await checkHealth();
    assert.equal(report.endpoint, "https://fake.api/v1");
  });

  it("treats whitespace-only key as not present", async () => {
    envRestore.restore();
    envRestore = setEnv({
      DEEPGREP_API_KEY: "   ",
      DEEPGREP_API_URL: "https://fake.api/v1",
      DEEPGREP_MODEL: "m",
      DEEPGREP_FAST_BACKEND: "windsurf",
      DEEPGREP_FAST_MODEL: "",
    });
    globalThis.fetch = mock.fn(async () => ({ status: 200 }));

    const report = await checkHealth();
    assert.equal(report.keyPresent, false);
    assert.equal(globalThis.fetch.mock.calls.length, 0);
  });
});
