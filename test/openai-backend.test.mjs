/**
 * Tests for openai-backend.mjs — the OpenAI-compatible search backend.
 *
 * Uses node:test mock API to stub global fetch for network isolation.
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { isOpenAIBackendConfigured, searchOpenAI } from "../deepgrep/src/openai-backend.mjs";
import { createMinimalNodeProject } from "./helpers/test-project.mjs";
import { setEnv } from "./helpers/env.mjs";

describe("isOpenAIBackendConfigured", () => {
  let restore;

  afterEach(() => {
    if (restore) restore();
  });

  it("returns true when both URL and key are set", () => {
    ({ restore } = setEnv({
      DEEPGREP_API_URL: "https://example.com/v1",
      DEEPGREP_API_KEY: "test-key-123",
    }));
    assert.equal(isOpenAIBackendConfigured(), true);
  });

  it("returns false when key is empty", () => {
    ({ restore } = setEnv({
      DEEPGREP_API_URL: "https://example.com/v1",
      DEEPGREP_API_KEY: "",
    }));
    assert.equal(isOpenAIBackendConfigured(), false);
  });

  it("returns false when key is not set", () => {
    ({ restore } = setEnv({
      DEEPGREP_API_URL: "https://example.com/v1",
      DEEPGREP_API_KEY: undefined,
      FC_OPENAI_API_KEY: undefined,
    }));
    assert.equal(isOpenAIBackendConfigured(), false);
  });
});

describe("searchOpenAI — with mocked fetch", () => {
  let project, originalFetch;

  beforeEach(() => {
    project = createMinimalNodeProject();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    project.cleanup();
    globalThis.fetch = originalFetch;
  });

  it("returns error when API returns 401", async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    }));

    const result = await searchOpenAI({
      query: "find auth",
      projectRoot: project.root,
      maxTurns: 1,
      apiKey: "bad-key",
      baseUrl: "https://fake.api/v1",
      model: "test-model",
    });

    assert(result.error);
    assert(result.error.includes("401"));
  });

  it("returns error when API returns 403", async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => "Forbidden",
    }));

    const result = await searchOpenAI({
      query: "find auth",
      projectRoot: project.root,
      maxTurns: 1,
      apiKey: "bad-key",
      baseUrl: "https://fake.api/v1",
      model: "test-model",
    });

    assert(result.error);
    assert(result.error.includes("403"));
  });

  it("returns files when API provides answer tool call", async () => {
    const answerXml = `<ANSWER><file path="/codebase/src/index.mjs"><range>1-5</range></file></ANSWER>`;

    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            tool_calls: [{
              id: "call_123",
              type: "function",
              function: { name: "answer", arguments: JSON.stringify({ answer: answerXml }) },
            }],
          },
        }],
      }),
    }));

    const result = await searchOpenAI({
      query: "find main entry",
      projectRoot: project.root,
      maxTurns: 1,
      apiKey: "test-key",
      baseUrl: "https://fake.api/v1",
      model: "test-model",
    });

    assert(!result.error);
    assert(result.files.length >= 1);
    assert.equal(result.files[0].path, "src/index.mjs");
    assert.deepEqual(result.files[0].ranges, [[1, 5]]);
    assert.equal(result._meta.backend, "openai");
    assert.equal(result._meta.model, "test-model");
  });

  it("handles inline answer (no tool_calls)", async () => {
    const answerXml = `<ANSWER><file path="/codebase/README.md"><range>1-2</range></file></ANSWER>`;

    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          finish_reason: "stop",
          message: { role: "assistant", content: answerXml },
        }],
      }),
    }));

    const result = await searchOpenAI({
      query: "find readme",
      projectRoot: project.root,
      maxTurns: 1,
      apiKey: "test-key",
      baseUrl: "https://fake.api/v1",
      model: "test-model",
    });

    assert(!result.error);
    assert(result.files.length >= 1);
    assert.equal(result.files[0].path, "README.md");
  });

  it("executes restricted_exec tool calls and continues", async () => {
    let callCount = 0;

    globalThis.fetch = mock.fn(async () => {
      callCount++;
      if (callCount === 1) {
        // First call: model wants to run rg
        return {
          ok: true, status: 200,
          json: async () => ({
            choices: [{
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                tool_calls: [{
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "restricted_exec",
                    arguments: JSON.stringify({ command1: { type: "rg", pattern: "main", path: "/codebase" } }),
                  },
                }],
              },
            }],
          }),
        };
      }
      // Subsequent calls: model provides answer
      const answerXml = `<ANSWER><file path="/codebase/src/index.mjs"><range>1-1</range></file></ANSWER>`;
      return {
        ok: true, status: 200,
        json: async () => ({
          choices: [{
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              tool_calls: [{
                id: "call_2",
                type: "function",
                function: { name: "answer", arguments: JSON.stringify({ answer: answerXml }) },
              }],
            },
          }],
        }),
      };
    });

    const result = await searchOpenAI({
      query: "find main",
      projectRoot: project.root,
      maxTurns: 2,
      apiKey: "test-key",
      baseUrl: "https://fake.api/v1",
      model: "test-model",
    });

    assert(!result.error);
    assert(result.files.length >= 1);
    assert(callCount >= 2, "Should have made at least 2 API calls");
  });

  it("returns max-turns error when no answer received", async () => {
    // Model always responds with text, never with answer tool
    globalThis.fetch = mock.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        choices: [{
          finish_reason: "stop",
          message: { role: "assistant", content: "I'm thinking about this..." },
        }],
      }),
    }));

    const result = await searchOpenAI({
      query: "impossible query",
      projectRoot: project.root,
      maxTurns: 1,
      apiKey: "test-key",
      baseUrl: "https://fake.api/v1",
      model: "test-model",
    });

    assert(result.error);
    assert(result.error.includes("Max turns"));
  });

  it("uses cache on second identical call", async () => {
    const answerXml = `<ANSWER><file path="/codebase/src/utils.mjs"><range>1-3</range></file></ANSWER>`;
    let fetchCount = 0;

    globalThis.fetch = mock.fn(async () => {
      fetchCount++;
      return {
        ok: true, status: 200,
        json: async () => ({
          choices: [{
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              tool_calls: [{
                id: "call_x",
                type: "function",
                function: { name: "answer", arguments: JSON.stringify({ answer: answerXml }) },
              }],
            },
          }],
        }),
      };
    });

    const opts = {
      query: "find utils unique-cache-test-" + Date.now(),
      projectRoot: project.root,
      maxTurns: 1,
      apiKey: "test-key",
      baseUrl: "https://fake.api/v1",
      model: "cache-test-model",
    };

    const result1 = await searchOpenAI(opts);
    assert(!result1.error);
    assert.equal(result1._meta.cache_hit, false);

    const result2 = await searchOpenAI(opts);
    assert(!result2.error);
    assert.equal(result2._meta.cache_hit, true);
    assert.equal(fetchCount, 1, "Second call should use cache, no fetch");
  });
});
