import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldEscalate } from "../deepgrep/src/escalate.mjs";

describe("shouldEscalate", () => {
  describe("returns false for simple queries", () => {
    it("single-concept query", () => {
      const { escalate } = shouldEscalate("find auth middleware");
      assert.equal(escalate, false);
    });

    it("short query", () => {
      const { escalate } = shouldEscalate("database config");
      assert.equal(escalate, false);
    });

    it("empty query", () => {
      const { escalate } = shouldEscalate("");
      assert.equal(escalate, false);
    });

    it("null input", () => {
      const { escalate } = shouldEscalate(null);
      assert.equal(escalate, false);
    });

    it("two clauses (below threshold)", () => {
      const { escalate } = shouldEscalate("find auth and logging");
      assert.equal(escalate, false);
    });
  });

  describe("returns true for multi-hop keywords", () => {
    it("trace keyword", () => {
      const { escalate, reason } = shouldEscalate("trace the data flow");
      assert.equal(escalate, true);
      assert(reason.includes("multi-hop"));
    });

    it("flow keyword", () => {
      const { escalate } = shouldEscalate("show me the credit flow");
      assert.equal(escalate, true);
    });

    it("through keyword", () => {
      const { escalate } = shouldEscalate("how requests pass through middleware");
      assert.equal(escalate, true);
    });

    it("end-to-end keyword", () => {
      const { escalate } = shouldEscalate("end-to-end auth pipeline");
      assert.equal(escalate, true);
    });

    it("from...to pattern", () => {
      const { escalate } = shouldEscalate("data from API to database");
      assert.equal(escalate, true);
    });

    it("walk me through pattern", () => {
      const { escalate } = shouldEscalate("walk me through the payment process");
      assert.equal(escalate, true);
    });

    it("how does...work pattern", () => {
      const { escalate } = shouldEscalate("how does the cache system work");
      assert.equal(escalate, true);
    });
  });

  describe("returns true for complex multi-clause queries", () => {
    it("3 clauses with 'and' + comma", () => {
      const { escalate, reason } = shouldEscalate("fallback logic, cooldown timer and retry mechanism");
      assert.equal(escalate, true);
      assert(reason.includes("clauses"));
    });

    it("3 clauses with 'plus'", () => {
      const { escalate } = shouldEscalate("auth check plus rate limiting plus logging");
      assert.equal(escalate, true);
    });

    it("mixed separators", () => {
      const { escalate } = shouldEscalate("token refresh, then retry and notify user");
      assert.equal(escalate, true);
    });
  });

  describe("refineHint for non-English queries", () => {
    it("provides hint for Vietnamese", () => {
      const { refineHint } = shouldEscalate("tìm hàm xử lý credit");
      assert(refineHint !== null);
      assert(refineHint.includes("English code terms"));
    });

    it("provides hint for Chinese", () => {
      const { refineHint } = shouldEscalate("查找认证中间件");
      assert(refineHint !== null);
    });

    it("no hint for English-only", () => {
      const { refineHint } = shouldEscalate("find auth middleware");
      assert.equal(refineHint, null);
    });
  });

  describe("does not false-positive on edge cases", () => {
    it("'from' inside a word (transform)", () => {
      const { escalate } = shouldEscalate("get config from the token");
      // "from...to" needs standalone "to" — "token" contains "to" but regex uses \b
      assert.equal(escalate, false);
    });

    it("single 'and' separator = 2 clauses (below threshold)", () => {
      const { escalate } = shouldEscalate("find controllers and services");
      assert.equal(escalate, false);
    });
  });
});
