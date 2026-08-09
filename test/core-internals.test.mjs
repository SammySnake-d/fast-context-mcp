/**
 * Tests for core.mjs private helpers.
 *
 * These functions are not exported from core.mjs (open-source, unmodifiable).
 * We test them via spec-faithful re-implementations in test/helpers/core-private.mjs.
 * Any behavior change in core.mjs MUST be reflected here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  stripInvalidUtf8,
  parseToolCall,
  trimMessages,
  parseResponse,
} from "./helpers/core-private.mjs";
import {
  connectFrameEncode,
  ProtobufEncoder,
} from "../deepgrep/src/protobuf.mjs";

// ─── stripInvalidUtf8 ─────────────────────────────────────

describe("stripInvalidUtf8", () => {
  it("returns clean string unchanged", () => {
    const buf = Buffer.from("hello world", "utf-8");
    assert.equal(stripInvalidUtf8(buf), "hello world");
  });

  it("strips \\ufffd replacement characters", () => {
    // Simulate invalid UTF-8 decoded bytes appearing as replacement chars
    const withReplacement = "hello\ufffdworld\ufffd";
    const buf = Buffer.from(withReplacement, "utf-8");
    const result = stripInvalidUtf8(buf);
    assert(!result.includes("\ufffd"));
    assert(result.includes("hello"));
    assert(result.includes("world"));
  });

  it("handles empty buffer", () => {
    assert.equal(stripInvalidUtf8(Buffer.alloc(0)), "");
  });

  it("preserves ASCII + unicode mix", () => {
    const buf = Buffer.from("auth → login", "utf-8");
    const result = stripInvalidUtf8(buf);
    assert(result.includes("auth"));
    assert(result.includes("login"));
  });

  it("handles buffer with only replacement chars", () => {
    const buf = Buffer.from("\ufffd\ufffd\ufffd", "utf-8");
    assert.equal(stripInvalidUtf8(buf), "");
  });
});

// ─── parseToolCall ────────────────────────────────────────

describe("parseToolCall (_parseToolCall spec)", () => {
  it("parses restricted_exec with simple args", () => {
    const text = '[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"rg","pattern":"foo","path":"/codebase"}}';
    const result = parseToolCall(text);
    assert(result !== null);
    const [thinking, name, args] = result;
    assert.equal(name, "restricted_exec");
    assert.equal(thinking, "");
    assert.equal(args.command1.type, "rg");
    assert.equal(args.command1.pattern, "foo");
  });

  it("parses answer tool call", () => {
    const answerXml = "<ANSWER><file path='/codebase/src/index.mjs'><range>1-10</range></file></ANSWER>";
    const text = `[TOOL_CALLS]answer[ARGS]{"answer":${JSON.stringify(answerXml)}}`;
    const result = parseToolCall(text);
    assert(result !== null);
    const [, name, args] = result;
    assert.equal(name, "answer");
    assert(args.answer.includes("<ANSWER>"));
  });

  it("captures thinking text before [TOOL_CALLS]", () => {
    const text = "Let me search for this file.\n[TOOL_CALLS]restricted_exec[ARGS]{\"command1\":{\"type\":\"ls\",\"path\":\"/codebase\"}}";
    const result = parseToolCall(text);
    assert(result !== null);
    const [thinking] = result;
    assert.equal(thinking, "Let me search for this file.");
  });

  it("strips </s> token before parsing", () => {
    const text = "[TOOL_CALLS]restricted_exec[ARGS]{\"command1\":{\"type\":\"tree\",\"path\":\"/codebase\"}}</s>";
    const result = parseToolCall(text);
    assert(result !== null);
    assert.equal(result[1], "restricted_exec");
  });

  it("returns null when no [TOOL_CALLS] marker", () => {
    assert.equal(parseToolCall("just some text"), null);
    assert.equal(parseToolCall(""), null);
    assert.equal(parseToolCall("<ANSWER><file/></ANSWER>"), null);
  });

  it("returns null for invalid JSON args", () => {
    const text = "[TOOL_CALLS]answer[ARGS]{invalid json here}";
    assert.equal(parseToolCall(text), null);
  });

  it("handles nested braces in args correctly", () => {
    const args = { command1: { type: "rg", pattern: "foo", path: "/codebase", include: ["*.mjs"] } };
    const text = `[TOOL_CALLS]restricted_exec[ARGS]${JSON.stringify(args)}`;
    const result = parseToolCall(text);
    assert(result !== null);
    assert.deepEqual(result[2], args);
  });

  it("handles multi-command args", () => {
    const args = {
      command1: { type: "rg", pattern: "auth", path: "/codebase" },
      command2: { type: "readfile", file: "/codebase/src/index.mjs" },
      command3: { type: "tree", path: "/codebase/src" },
    };
    const text = `[TOOL_CALLS]restricted_exec[ARGS]${JSON.stringify(args)}`;
    const result = parseToolCall(text);
    assert(result !== null);
    assert.equal(Object.keys(result[2]).length, 3);
  });
});

// ─── trimMessages ─────────────────────────────────────────

describe("trimMessages (_trimMessages spec)", () => {
  it("returns false and does nothing for ≤4 messages", () => {
    const msgs = [
      { role: 5, content: "system" },
      { role: 1, content: "user" },
      { role: 2, content: "assistant" },
      { role: 1, content: "result" },
    ];
    const original = [...msgs];
    const result = trimMessages(msgs);
    assert.equal(result, false);
    assert.deepEqual(msgs, original);
  });

  it("returns false for exactly 4 messages (boundary)", () => {
    const msgs = Array.from({ length: 4 }, (_, i) => ({ role: i, content: `msg${i}` }));
    assert.equal(trimMessages(msgs), false);
    assert.equal(msgs.length, 4);
  });

  it("returns true and trims to 5 messages for 5+ inputs", () => {
    const msgs = Array.from({ length: 8 }, (_, i) => ({ role: i % 3, content: `msg${i}` }));
    const result = trimMessages(msgs);
    assert.equal(result, true);
    assert.equal(msgs.length, 5);
  });

  it("preserves head (first 2) and tail (last 2) after trim", () => {
    const msgs = [
      { role: 5, content: "system" },
      { role: 1, content: "user-query" },
      { role: 2, content: "round1-assistant" },
      { role: 1, content: "round1-result" },
      { role: 2, content: "round2-assistant" },
      { role: 1, content: "round2-result" },
    ];
    trimMessages(msgs);
    assert.equal(msgs[0].content, "system");
    assert.equal(msgs[1].content, "user-query");
    assert.equal(msgs[3].content, "round2-assistant");
    assert.equal(msgs[4].content, "round2-result");
  });

  it("inserts bridge note at index 2 after trim", () => {
    const msgs = Array.from({ length: 6 }, (_, i) => ({ role: i % 3, content: `msg${i}` }));
    trimMessages(msgs);
    assert(msgs[2].content.includes("Prior search rounds omitted"));
    assert.equal(msgs[2].role, 1); // role=1 = user
  });

  it("mutates array in place (same reference)", () => {
    const msgs = Array.from({ length: 6 }, (_, i) => ({ role: i, content: `msg${i}` }));
    const ref = msgs;
    trimMessages(msgs);
    assert.equal(msgs, ref); // same array reference
  });

  it("handles large message arrays correctly", () => {
    const msgs = Array.from({ length: 20 }, (_, i) => ({ role: i % 3, content: `msg${i}` }));
    const head0 = msgs[0].content;
    const head1 = msgs[1].content;
    const tail0 = msgs[18].content;
    const tail1 = msgs[19].content;

    trimMessages(msgs);
    assert.equal(msgs.length, 5);
    assert.equal(msgs[0].content, head0);
    assert.equal(msgs[1].content, head1);
    assert.equal(msgs[3].content, tail0);
    assert.equal(msgs[4].content, tail1);
  });
});

// ─── parseResponse ────────────────────────────────────────

describe("parseResponse (_parseResponse spec)", () => {
  /**
   * Build a Connect-framed buffer containing the given text as a protobuf string field.
   */
  function buildFrameWithText(text) {
    const enc = new ProtobufEncoder();
    enc.writeString(1, text);
    return connectFrameEncode(enc.toBuffer(), false); // uncompressed for simplicity
  }

  it("returns [text, null] when response contains no tool call", () => {
    const buf = buildFrameWithText("I need to analyze this more.");
    const [text, toolInfo] = parseResponse(buf);
    assert.equal(toolInfo, null);
  });

  it("parses restricted_exec tool call from framed response", () => {
    const toolText = '[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"rg","pattern":"auth","path":"/codebase"}}';
    const buf = buildFrameWithText(toolText);
    const [thinking, toolInfo] = parseResponse(buf);
    assert(toolInfo !== null);
    const [name, args] = toolInfo;
    assert.equal(name, "restricted_exec");
    assert.equal(args.command1.pattern, "auth");
  });

  it("parses answer tool call from framed response", () => {
    const answerXml = "<ANSWER><file path='/codebase/x.mjs'><range>1-5</range></file></ANSWER>";
    const toolText = `[TOOL_CALLS]answer[ARGS]${JSON.stringify({ answer: answerXml })}`;
    const buf = buildFrameWithText(toolText);
    const [, toolInfo] = parseResponse(buf);
    assert(toolInfo !== null);
    const [name, args] = toolInfo;
    assert.equal(name, "answer");
    assert(args.answer.includes("<ANSWER>"));
  });

  it("returns error text when frame contains JSON error object", () => {
    const errJson = JSON.stringify({ error: { code: "rate_limited", message: "too many requests" } });
    const buf = connectFrameEncode(Buffer.from(errJson), false);
    const [text, toolInfo] = parseResponse(buf);
    assert.equal(toolInfo, null);
    assert(text.includes("[Error]"));
    assert(text.includes("rate_limited"));
    assert(text.includes("too many requests"));
  });

  it("returns [text, null] for empty-ish buffer", () => {
    // Empty protobuf encoded buffer wrapped in Connect frame
    const enc = new ProtobufEncoder();
    const buf = connectFrameEncode(enc.toBuffer(), false);
    const [text, toolInfo] = parseResponse(buf);
    assert.equal(toolInfo, null);
    assert(typeof text === "string");
  });
});
