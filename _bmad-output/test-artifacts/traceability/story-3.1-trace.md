# Traceability Matrix — Story 3.1: `deepgrep_get`

Generated: 2026-06-08
Story: `3-token-efficient-retrieval` | Status: done

## AC → Test Coverage

| AC | Requirement | Test file → case | Level |
|----|-------------|------------------|-------|
| AC1 | Range hợp lệ → code đúng + line numbers, không đọc ngoài range | `snippets-tool.test.mjs` → "AC1: returns correct output format with line numbers" · `mcp-integration.test.mjs` → "deepgrep_get returns formatted snippet" | Unit + Integration |
| AC2 | `FC_SNIPPET_MAX_LINES` → tổng lines ≤ budget | `snippets-tool.test.mjs` → "AC2: respects FC_SNIPPET_MAX_LINES budget" | Unit |
| AC3 | Binary file → `[binary file — snippet omitted]`, không crash | `snippets-tool.test.mjs` → "AC3: binary file produces..." | Unit |
| AC4 | Range out-of-bounds → bỏ qua gracefully | `snippets-tool.test.mjs` → "AC4: out-of-bounds range returns..." | Unit |
| AC5 | `files: []` / `ranges: []` → "No files/ranges provided", không crash | `snippets-tool.test.mjs` → "AC5: empty files array" + "AC5: file with empty ranges" · `mcp-integration.test.mjs` → "empty files returns..." | Unit + Integration |
| AC6 | Pure local — không check DEEPGREP_API_KEY | `snippets-tool.test.mjs` → "AC6: does not read DEEPGREP_API_KEY" | Unit |
| AC7 | Format `## {file} (L{s}-{e})` + `{lineNo} \| {content}` | `snippets-tool.test.mjs` → "AC1" (assert format) · `mcp-integration.test.mjs` → snippet regex assert | Unit + Integration |

## Coverage Summary

- **7/7 ACs covered** (100%)
- Every AC has ≥1 unit test; AC1, AC5, AC7 also verified end-to-end qua MCP stdio
- Supporting: `formatSnippetToolOutput` (8 tests) + `readSnippets` (10 tests in `snippets.test.mjs`) underpin the tool handler

## Gaps

- None for story 3.1 ACs. All acceptance criteria traced to passing tests.
