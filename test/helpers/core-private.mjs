/**
 * Test-only specification implementations of core.mjs private helpers.
 *
 * These are NOT copies of the implementation — they are independent
 * spec-faithful re-implementations used to:
 *   1. Document exact expected behavior
 *   2. Allow testing edge cases of the logic without touching open-source code
 *   3. Serve as a contract: if core.mjs changes, these must stay in sync
 *
 * WHY: _parseToolCall, _trimMessages, stripInvalidUtf8, _parseResponse
 * are private (not exported) in core.mjs (open-source, cannot modify).
 *
 * APPROACH: spec-faithful re-implementation + behavioral test suite.
 * We test the BEHAVIOR spec these functions must satisfy.
 */

import { connectFrameEncode, connectFrameDecode, extractStrings } from "../../deepgrep/src/protobuf.mjs";

// ─── stripInvalidUtf8 ─────────────────────────────────────
// Spec: strip \ufffd replacement chars from UTF-8 decoded buffer.

export function stripInvalidUtf8(buf) {
  return buf.toString("utf-8").replace(/\ufffd/g, "");
}

// ─── _parseToolCall ───────────────────────────────────────
// Spec: parse [TOOL_CALLS]name[ARGS]{json} format from Windsurf response.
// Returns [thinking, name, args] or null if no match.

export function parseToolCall(text) {
  text = text.replace(/<\/s>/g, "");
  const m = text.match(/\[TOOL_CALLS\](\w+)\[ARGS\](\{.+)/s);
  if (!m) return null;

  const name = m[1];
  const raw = m[2].trim();

  // Find matching closing brace
  let depth = 0;
  let end = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === 0) end = raw.length;

  let args;
  try {
    args = JSON.parse(raw.slice(0, end));
  } catch {
    return null;
  }

  const thinking = text.slice(0, m.index).trim();
  return [thinking, name, args];
}

// ─── _trimMessages ────────────────────────────────────────
// Spec: keep head (0,1) + bridge note + tail (-2,-1), mutate array in place.
// Returns true if trimmed, false if ≤4 messages (no action).

export function trimMessages(messages) {
  if (messages.length <= 4) return false;
  const head = messages.slice(0, 2);
  const tail = messages.slice(-2);
  messages.length = 0;
  messages.push(
    ...head,
    { role: 1, content: "[Prior search rounds omitted to reduce payload. Provide your best answer based on available context.]" },
    ...tail,
  );
  return true;
}

// ─── _parseResponse ───────────────────────────────────────
// Spec: decode Connect frames, extract text, parse tool calls.
// Returns [text, [name, args]] or [text, null].

export function parseResponse(data) {
  const frames = connectFrameDecode(data);
  let allText = "";

  for (const frameData of frames) {
    try {
      const textCandidate = frameData.toString("utf-8");
      if (textCandidate.startsWith("{")) {
        const errObj = JSON.parse(textCandidate);
        if (errObj.error) {
          const code = errObj.error.code || "unknown";
          const msg = errObj.error.message || "";
          return [`[Error] ${code}: ${msg}`, null];
        }
      }
    } catch { /* not JSON, continue */ }

    const rawText = stripInvalidUtf8(frameData);
    if (rawText.includes("[TOOL_CALLS]")) {
      allText = rawText;
      break;
    }

    for (const s of extractStrings(frameData)) {
      if (s.length > 10) allText += s;
    }
  }

  const parsed = parseToolCall(allText);
  if (parsed) {
    const [thinking, name, args] = parsed;
    return [thinking, [name, args]];
  }
  return [allText, null];
}
