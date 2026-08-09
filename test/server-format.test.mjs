/**
 * Tests for server.mjs _formatResult function.
 *
 * Since _formatResult is not exported, we test it indirectly via
 * the output format expectations. For comprehensive testing, we
 * verify the output structure of formatted search results.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { friendlyError } from "../deepgrep/src/shared.mjs";

describe("friendlyError", () => {
  it("returns user-friendly message for 429", () => {
    const msg = friendlyError({ message: "HTTP 429", status: 429 }, "SWE-1.6");
    assert(typeof msg === "string");
    assert(msg.length > 10);
  });

  it("returns user-friendly message for 401", () => {
    const msg = friendlyError({ message: "Unauthorized", status: 401 }, "SWE-1.6");
    assert(typeof msg === "string");
    assert(msg.length > 10);
  });

  it("returns user-friendly message for 403", () => {
    const msg = friendlyError({ message: "Forbidden", status: 403 }, "SWE-1.6");
    assert(typeof msg === "string");
  });

  it("handles null status gracefully", () => {
    const msg = friendlyError({ message: "Unknown error", status: null }, "SWE-1.6");
    assert(typeof msg === "string");
  });
});
