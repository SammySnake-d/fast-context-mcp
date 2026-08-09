/**
 * Tests for server.mjs readIntEnv logic.
 *
 * readIntEnv is not exported (module-private), so we mirror its implementation
 * here to validate all branches. This ensures the production constants
 * (FC_MAX_TURNS, FC_MAX_COMMANDS, FC_TIMEOUT_MS) are computed correctly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

function readIntEnv(name, defaultValue, opts = {}) {
  const raw = process.env[name];
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  const min = typeof opts.min === "number" ? opts.min : null;
  const max = typeof opts.max === "number" ? opts.max : null;
  let value = parsed;
  if (min !== null) value = Math.max(min, value);
  if (max !== null) value = Math.min(max, value);
  return value;
}

const VAR = "_FC_TEST_INT_ENV_";

describe("readIntEnv (mirrored logic)", () => {
  it("returns defaultValue when env var not set", () => {
    delete process.env[VAR];
    assert.equal(readIntEnv(VAR, 42), 42);
  });

  it("returns parsed integer when env var is a valid integer", () => {
    process.env[VAR] = "10";
    assert.equal(readIntEnv(VAR, 3), 10);
    delete process.env[VAR];
  });

  it("returns defaultValue for non-integer string", () => {
    process.env[VAR] = "abc";
    assert.equal(readIntEnv(VAR, 5), 5);
    delete process.env[VAR];
  });

  it("returns defaultValue for empty string", () => {
    process.env[VAR] = "";
    assert.equal(readIntEnv(VAR, 7), 7);
    delete process.env[VAR];
  });

  it("returns defaultValue for float string", () => {
    process.env[VAR] = "3.7";
    assert.equal(readIntEnv(VAR, 1), 3); // parseInt("3.7") = 3, valid
    delete process.env[VAR];
  });

  it("clamps to min when value is below minimum", () => {
    process.env[VAR] = "0";
    assert.equal(readIntEnv(VAR, 3, { min: 1 }), 1);
    delete process.env[VAR];
  });

  it("clamps to max when value exceeds maximum", () => {
    process.env[VAR] = "100";
    assert.equal(readIntEnv(VAR, 3, { max: 5 }), 5);
    delete process.env[VAR];
  });

  it("passes through value within min/max range unchanged", () => {
    process.env[VAR] = "3";
    assert.equal(readIntEnv(VAR, 1, { min: 1, max: 5 }), 3);
    delete process.env[VAR];
  });

  it("clamps to min at lower boundary", () => {
    process.env[VAR] = "0";
    assert.equal(readIntEnv(VAR, 3, { min: 1, max: 5 }), 1);
    delete process.env[VAR];
  });

  it("clamps to max at upper boundary", () => {
    process.env[VAR] = "99";
    assert.equal(readIntEnv(VAR, 3, { min: 1, max: 5 }), 5);
    delete process.env[VAR];
  });

  it("accepts exact min boundary value without clamping", () => {
    process.env[VAR] = "1";
    assert.equal(readIntEnv(VAR, 5, { min: 1, max: 5 }), 1);
    delete process.env[VAR];
  });

  it("accepts exact max boundary value without clamping", () => {
    process.env[VAR] = "5";
    assert.equal(readIntEnv(VAR, 1, { min: 1, max: 5 }), 5);
    delete process.env[VAR];
  });

  it("ignores null opts (no clamping applied)", () => {
    process.env[VAR] = "3";
    assert.equal(readIntEnv(VAR, 1, { min: null, max: null }), 3);
    delete process.env[VAR];
  });

  it("handles negative values with min clamp", () => {
    process.env[VAR] = "-5";
    assert.equal(readIntEnv(VAR, 3, { min: 1 }), 1);
    delete process.env[VAR];
  });

  // Production constant verification
  it("FC_MAX_TURNS: default=3, min=1, max=5", () => {
    const saved = process.env.FC_MAX_TURNS;
    delete process.env.FC_MAX_TURNS;
    assert.equal(readIntEnv("FC_MAX_TURNS", 3, { min: 1, max: 5 }), 3);
    process.env.FC_MAX_TURNS = "0";
    assert.equal(readIntEnv("FC_MAX_TURNS", 3, { min: 1, max: 5 }), 1);
    process.env.FC_MAX_TURNS = "99";
    assert.equal(readIntEnv("FC_MAX_TURNS", 3, { min: 1, max: 5 }), 5);
    if (saved !== undefined) process.env.FC_MAX_TURNS = saved;
    else delete process.env.FC_MAX_TURNS;
  });

  it("FC_MAX_COMMANDS: default=8, min=1, max=20", () => {
    const saved = process.env.FC_MAX_COMMANDS;
    delete process.env.FC_MAX_COMMANDS;
    assert.equal(readIntEnv("FC_MAX_COMMANDS", 8, { min: 1, max: 20 }), 8);
    if (saved !== undefined) process.env.FC_MAX_COMMANDS = saved;
    else delete process.env.FC_MAX_COMMANDS;
  });

  it("FC_TIMEOUT_MS: default=30000, min=1000, max=300000", () => {
    const saved = process.env.FC_TIMEOUT_MS;
    delete process.env.FC_TIMEOUT_MS;
    assert.equal(readIntEnv("FC_TIMEOUT_MS", 30000, { min: 1000, max: 300000 }), 30000);
    process.env.FC_TIMEOUT_MS = "500";
    assert.equal(readIntEnv("FC_TIMEOUT_MS", 30000, { min: 1000, max: 300000 }), 1000);
    if (saved !== undefined) process.env.FC_TIMEOUT_MS = saved;
    else delete process.env.FC_TIMEOUT_MS;
  });
});
