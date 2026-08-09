/**
 * Snippet reader for deepgrep search results.
 * Reads file content for given line ranges and formats for output.
 *
 * Env vars:
 *   FC_SNIPPET_MAX_LINES — total snippet lines budget (default: 200)
 *   FC_LINE_MAX_CHARS    — max characters per snippet line (default: 250)
 */

import { readFileSync } from "node:fs";

function _getMaxLines() {
  const raw = parseInt(process.env.FC_SNIPPET_MAX_LINES, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 200;
}

function _getLineMaxChars() {
  const raw = parseInt(process.env.FC_LINE_MAX_CHARS, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 250;
}

/** Heuristic: treat content with a NUL byte in the first 8KB as binary. */
function _isBinary(content) {
  return content.slice(0, 8192).includes("\u0000");
}

/** Truncate a single line to the per-line char cap with an ellipsis marker. */
function _capLine(line, maxChars) {
  return line.length > maxChars ? line.slice(0, maxChars) + " …[truncated]" : line;
}

/**
 * Read code snippets for search result files.
 * @param {Array<{ full_path: string, ranges: [number, number][] }>} files
 * @returns {Map<string, string>} Map of full_path → formatted snippet text
 */
export function readSnippets(files) {
  const maxLines = _getMaxLines();
  const lineMaxChars = _getLineMaxChars();
  let totalLines = 0;
  const snippets = new Map();

  for (const file of files) {
    if (totalLines >= maxLines) break;
    let content;
    try {
      content = readFileSync(file.full_path, "utf-8");
    } catch {
      continue;
    }
    if (_isBinary(content)) {
      snippets.set(file.full_path, "[binary file — snippet omitted]");
      continue;
    }
    const lines = content.split("\n");
    const parts = [];

    for (const [start, end] of file.ranges) {
      if (totalLines >= maxLines) break;
      if (start > end) continue; // skip inverted ranges
      const s = Math.max(0, start - 1); // 1-indexed → 0-indexed
      const e = Math.min(lines.length, end);
      if (s >= e) continue; // out-of-bounds / empty range
      const remaining = maxLines - totalLines;
      const truncated = (e - s) > remaining;
      const slice = lines.slice(s, Math.min(e, s + remaining));
      totalLines += slice.length;
      let block = slice.map((l, i) => `${s + i + 1} | ${_capLine(l, lineMaxChars)}`).join("\n");
      if (truncated) {
        block += `\n…[range truncated: snippet line budget (${maxLines}) reached]`;
      }
      parts.push(block);
    }

    if (parts.length) {
      snippets.set(file.full_path, parts.join("\n...\n"));
    }
  }

  return snippets;
}
