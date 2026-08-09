/**
 * Query complexity heuristic for auto-escalation from quick to deep mode.
 *
 * All evaluation is LOCAL (~0ms), no API calls.
 * Conservative by design: prefer under-escalation over over-escalation
 * to avoid wasting tokens on simple queries.
 */

// Multi-hop keywords that strongly indicate cross-file tracing.
// Entries containing ".*" are treated as regex. Word boundaries (\b) keep a
// multi-word pattern from firing inside unrelated words — e.g. unbounded
// "from.*to" matches "get config from the token" ("to" inside "token"),
// whereas "\bfrom\b.*\bto\b" requires standalone words. Apply \b consistently
// to every ".*" entry. (Plain-string entries below still match as substrings.)
const MULTI_HOP_KEYWORDS = [
  "trace", "flow", "across", "through", "pipeline", "end-to-end", "end to end",
  "data flow", "call chain", "\\bfrom\\b.*\\bto\\b", "\\bhow\\b does.*\\bwork(s|ing)?\\b", "walk me through",
  "full path", "all the way", "step by step", "entire flow",
];

// Clause separators that indicate multiple requirements in one query.
// Ordered longest-first so overlapping separators (", and " ⊃ " and ") are
// consumed once and not double-counted.
const CLAUSE_SEPARATORS = [" as well as ", ", and ", " then ", " also ", " plus ", " and ", " + ", " & "];

// Non-ASCII range used to detect non-English queries (Vietnamese, Chinese, etc.)
const NON_ASCII_RE = /[^\x00-\x7F]/;

/**
 * Determine whether a query should be escalated from quick to deep mode.
 *
 * @param {string} query
 * @returns {{ escalate: boolean, reason: string, refineHint: string|null }}
 */
export function shouldEscalate(query) {
  if (!query || typeof query !== "string") {
    return { escalate: false, reason: "empty query", refineHint: null };
  }

  const q = query.trim().toLowerCase();

  // Check for non-English (non-ASCII) characters
  const isNonEnglish = NON_ASCII_RE.test(query);
  const refineHint = isNonEnglish
    ? "💡 Tip: try rephrasing with specific English code terms (e.g. function names, file names) for better results."
    : null;

  // 1. Multi-hop keyword detection (highest signal)
  for (const kw of MULTI_HOP_KEYWORDS) {
    if (kw.includes(".*")) {
      // Simple regex pattern
      const re = new RegExp(kw, "i");
      if (re.test(q)) {
        return { escalate: true, reason: `multi-hop keyword: "${kw}"`, refineHint };
      }
    } else if (q.includes(kw)) {
      return { escalate: true, reason: `multi-hop keyword: "${kw}"`, refineHint };
    }
  }

  // 2. Clause count (3+ clauses = complex query).
  // Consume separators longest-first, replacing each match with a space so an
  // overlapping shorter separator (e.g. " and " inside ", and ") isn't re-counted.
  let work = q;
  let boundaries = 0;
  for (const sep of CLAUSE_SEPARATORS) {
    const before = work.split(sep);
    if (before.length > 1) {
      boundaries += before.length - 1;
      work = before.join(" ");
    }
  }
  // Count remaining commas that separate distinct concepts (after separators consumed).
  const commas = (work.match(/,\s*[a-z]/g) || []).length;
  const clauses = 1 + boundaries + commas;

  if (clauses >= 3) {
    return { escalate: true, reason: `complex query: ${clauses} clauses detected`, refineHint };
  }

  // Non-English alone is not enough to escalate, but we still provide refineHint
  return { escalate: false, reason: "simple query", refineHint };
}
