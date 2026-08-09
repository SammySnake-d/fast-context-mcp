import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatHealthReport } from "../deepgrep/src/health.mjs";

/**
 * Build a baseline health report object that can be overridden per test.
 */
function makeReport(overrides = {}) {
  return {
    keyPresent: true,
    keyValid: true,
    keyStatus: "ok",
    endpointReachable: true,
    endpoint: "https://router.chainlens.net/v1",
    models: [{ id: "deep-search", status: "ok" }],
    devinDetected: false,
    config: { fastBackend: "windsurf", fastModel: "", deepModel: "deep-search", apiUrl: "https://router.chainlens.net/v1" },
    signupUrl: "https://deepgrep.chainlens.net",
    ...overrides,
  };
}

describe("formatHealthReport — API key states", () => {
  it("shows valid key", () => {
    const out = formatHealthReport(makeReport());
    assert(out.includes("✅ API key: valid"));
  });

  it("shows not-set key with signup URL", () => {
    const out = formatHealthReport(makeReport({ keyValid: false, keyPresent: false, keyStatus: "no_key" }));
    assert(out.includes("❌ API key: not set"));
    assert(out.includes("deepgrep.chainlens.net"));
  });

  it("shows invalid (unauthorized) key", () => {
    const out = formatHealthReport(makeReport({ keyValid: false, keyStatus: "unauthorized" }));
    assert(out.includes("invalid (unauthorized)"));
  });

  it("shows unverifiable key when endpoint unreachable", () => {
    const out = formatHealthReport(makeReport({
      keyValid: false, keyStatus: "error:timeout", endpointReachable: false,
    }));
    assert(out.includes("could not verify"));
    assert(out.includes("unreachable"));
  });

  it("shows generic unverifiable key for other statuses", () => {
    const out = formatHealthReport(makeReport({
      keyValid: false, keyStatus: "error:500", endpointReachable: true,
    }));
    assert(out.includes("could not verify"));
  });
});

describe("formatHealthReport — endpoint states", () => {
  it("shows reachable endpoint", () => {
    const out = formatHealthReport(makeReport({ endpointReachable: true }));
    assert(out.includes("✅ Endpoint:"));
  });

  it("shows unreachable endpoint", () => {
    const out = formatHealthReport(makeReport({
      keyValid: false, keyStatus: "error:timeout", endpointReachable: false,
    }));
    assert(out.includes("❌ Endpoint:"));
    assert(out.includes("(unreachable)"));
  });

  it("shows not-checked endpoint when no key", () => {
    const out = formatHealthReport(makeReport({
      keyPresent: false, keyValid: false, keyStatus: "no_key", endpointReachable: null, models: [],
    }));
    assert(out.includes("not checked"));
  });
});

describe("formatHealthReport — model statuses", () => {
  it("shows available model", () => {
    const out = formatHealthReport(makeReport({ models: [{ id: "deep-search", status: "ok" }] }));
    assert(out.includes("✅ deep-search: available"));
  });

  it("shows rate-limited model", () => {
    const out = formatHealthReport(makeReport({ models: [{ id: "deep-search", status: "rate_limited" }] }));
    assert(out.includes("rate limited (429)"));
  });

  it("shows unauthorized model", () => {
    const out = formatHealthReport(makeReport({ models: [{ id: "deep-search", status: "unauthorized" }] }));
    assert(out.includes("unauthorized (403/401)"));
  });

  it("shows generic error model status", () => {
    const out = formatHealthReport(makeReport({ models: [{ id: "deep-search", status: "error:500" }] }));
    assert(out.includes("deep-search: error:500"));
  });
});

describe("formatHealthReport — Devin Desktop detection", () => {
  it("windsurf backend + detected = auto-key OK", () => {
    const out = formatHealthReport(makeReport({
      devinDetected: true,
      config: { fastBackend: "windsurf", fastModel: "", deepModel: "deep-search", apiUrl: "x" },
    }));
    assert(out.includes("✅ Devin Desktop: detected"));
  });

  it("windsurf backend + not detected = warning", () => {
    const out = formatHealthReport(makeReport({
      devinDetected: false,
      config: { fastBackend: "windsurf", fastModel: "", deepModel: "deep-search", apiUrl: "x" },
    }));
    assert(out.includes("⚠️  Devin Desktop: not detected"));
    assert(out.includes("DEEPGREP_FAST_BACKEND=openai"));
  });

  it("openai backend + detected = informational", () => {
    const out = formatHealthReport(makeReport({
      devinDetected: true,
      config: { fastBackend: "openai", fastModel: "gpt-5", deepModel: "deep-search", apiUrl: "x" },
    }));
    assert(out.includes("not used"));
  });

  it("openai backend + not detected = informational", () => {
    const out = formatHealthReport(makeReport({
      devinDetected: false,
      config: { fastBackend: "openai", fastModel: "", deepModel: "deep-search", apiUrl: "x" },
    }));
    assert(out.includes("fast mode using openai backend"));
  });
});

describe("formatHealthReport — config summary & signup hint", () => {
  it("includes config summary line", () => {
    const out = formatHealthReport(makeReport({
      config: { fastBackend: "openai", fastModel: "gpt-5", deepModel: "deep-search", apiUrl: "x" },
    }));
    assert(out.includes("fast_backend=openai"));
    assert(out.includes("fast_model=gpt-5"));
    assert(out.includes("deep_model=deep-search"));
  });

  it("omits fast_model from summary when empty", () => {
    const out = formatHealthReport(makeReport({
      config: { fastBackend: "windsurf", fastModel: "", deepModel: "deep-search", apiUrl: "x" },
    }));
    assert(!out.includes("fast_model="));
  });

  it("shows signup hint when key missing", () => {
    const out = formatHealthReport(makeReport({
      keyPresent: false, keyValid: false, keyStatus: "no_key", models: [],
    }));
    assert(out.includes("💡 Get a free API key"));
  });

  it("shows signup hint when key unauthorized", () => {
    const out = formatHealthReport(makeReport({ keyValid: false, keyStatus: "unauthorized" }));
    assert(out.includes("💡 Get a free API key"));
  });

  it("omits signup hint when key valid", () => {
    const out = formatHealthReport(makeReport());
    assert(!out.includes("💡 Get a free API key"));
  });

  it("always starts with header", () => {
    const out = formatHealthReport(makeReport());
    assert(out.startsWith("deepgrep status"));
  });
});
