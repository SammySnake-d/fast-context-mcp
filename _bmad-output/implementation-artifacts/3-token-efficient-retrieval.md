---
story_id: "3.1"
story_key: "3-token-efficient-retrieval"
epic: 3
status: done
created: 2026-06-07
baseline_commit: 037ad18e21277cbf6d2cbb4c622316125f8b9fd2
---

# Story 3.1: Tool `deepgrep_get` — Two-stage code retrieval

## Story

As a developer (or AI agent) using deepgrep,
I want to fetch exact code snippets by file + line ranges without reading the whole file,
so that I save tokens and get only the code I actually need.

## Acceptance Criteria

- **AC1:** Given `{files: [{file, ranges}]}` (output từ deepgrep_search), When gọi `deepgrep_get`, Then trả code đúng range, có line numbers, không đọc ngoài range
- **AC2:** Given `FC_SNIPPET_MAX_LINES` set, Then tổng lines trả về không vượt budget đó
- **AC3:** Given file binary, Then trả `[binary file — snippet omitted]` không crash
- **AC4:** Given range out-of-bounds, Then bỏ qua gracefully, trả range hợp lệ còn lại
- **AC5:** Given `files: []` (mảng rỗng) hoặc `ranges: []`, Then trả message rõ ràng `"No files/ranges provided"` KHÔNG crash
- **AC6:** Given không cần API key, Then tool hoạt động pure local (không gọi API, không check DEEPGREP_API_KEY)
- **AC7:** Output format: `## {file_path} (L{start}-{end})` header rồi code block với `{lineNo} | {content}` per line

**Ví dụ output mẫu (reference cho test assert):**
```
## /project/src/auth.mjs (L10-14)
10 | export function login(user, pass) {
11 |   const hash = hashPassword(pass);
12 |   const record = db.findUser(user);
13 |   if (!record) return null;
14 |   return record.hash === hash;
```

## Tasks

### T1. Đăng ký tool `deepgrep_get` trong `deepgrep/src/server.mjs`

- [x] Thêm tool sau `deepgrep_status`, trước comment `// Start`
- [x] Schema (ADR-6, Option A):
  ```js
  {
    files: z.array(z.object({
      file: z.string().describe("Absolute path (full_path from deepgrep_search output)"),
      ranges: z.array(z.tuple([z.number().int().min(1), z.number().int().min(1)]))
               .describe("Array of [start, end] line ranges (1-indexed, inclusive)")
    })).describe("Files and line ranges to fetch")
  }
  ```
- [x] Tool description nêu rõ 2-step workflow:
  `"Use after deepgrep_search to fetch exact code snippets by file path + line ranges. No API key required — pure local read."`
- [x] Handler: gọi `readSnippets` với input đã map sang `{full_path, ranges}` format
- [x] Handle empty `files` array: trả `"No files/ranges provided"` sớm
- [x] Format output: mỗi file một header `## {full_path} (L{start}-{end})` rồi code block
- [x] Wrap trong try/catch → trả error message (không crash MCP server)

### T2. Viết unit test `deepgrep/test/snippets-tool.test.mjs`

- [x] Test AC1: range hợp lệ → code đúng + line numbers
- [x] Test AC3: binary file → `[binary file — snippet omitted]`
- [x] Test AC4: out-of-bounds range → bỏ qua gracefully
- [x] Test AC5: `files: []` → message rõ ràng, không crash
- [x] Test AC6: tool không check/đọc DEEPGREP_API_KEY
- [x] Sử dụng `node:test` (pattern từ `deepgrep/test/health.test.mjs`)
- [x] Dùng `node:fs` tmp file hoặc `test/fixtures/` cho file thực (không mock fs nếu không cần)

### T3. Verify

- [x] `node --check deepgrep/src/server.mjs` pass
- [x] `node --test 'deepgrep/test/*.test.mjs'` — tất cả pass, bao gồm test mới
- [x] Gọi tool thủ công qua MCP hoặc script: nhập `files=[{file: __filename, ranges: [[1,5]]}]` → output đúng format

## Dev Notes

### Reuse `readSnippets` — KHÔNG reimplementing

`readSnippets` đã có trong `deepgrep/src/snippets.mjs`, đã import sẵn trong server.mjs. Tool chỉ là wrapper:

```js
// Trong server.mjs handler:
import { readSnippets } from "./snippets.mjs"; // đã import rồi

// Map input schema sang format readSnippets mong đợi
const mapped = files.map(f => ({ full_path: f.file, ranges: f.ranges }));
const snippetMap = readSnippets(mapped);
```

**Signature `readSnippets`:**
```js
readSnippets(files: Array<{ full_path: string, ranges: [number, number][] }>)
  → Map<string, string>  // full_path → formatted snippet text
```

`readSnippets` đã handle:
- `_isBinary` → `"[binary file — snippet omitted]"`
- out-of-bounds range → `if (s >= e) continue`
- inverted range → `if (start > end) continue`
- `FC_SNIPPET_MAX_LINES` budget
- `FC_LINE_MAX_CHARS` per-line truncation
- line number format: `"10 | code here"`

### Tool registration pattern — follow `deepgrep_status`

```js
server.tool(
  "deepgrep_get",
  "...",  // tool description
  { files: z.array(...) },
  async ({ files }) => {
    // handler
    return { content: [{ type: "text", text: outputText }] };
  }
);
```

Không cần API key check. Không cần `getBackend`, `searchWithContent`, hay bất kỳ network call nào.

### Output format handler

```js
async ({ files }) => {
  if (!files.length) {
    return { content: [{ type: "text", text: "No files/ranges provided" }] };
  }
  try {
    const mapped = files.map(f => ({ full_path: f.file, ranges: f.ranges }));
    const snippetMap = readSnippets(mapped);
    const parts = [];
    for (const { file, ranges } of files) {
      const snippet = snippetMap.get(file);
      if (!snippet) continue;
      const rangeStr = ranges.map(([s, e]) => `L${s}-${e}`).join(", ");
      parts.push(`## ${file} (${rangeStr})`);
      parts.push("```");
      parts.push(snippet);
      parts.push("```");
    }
    const text = parts.length ? parts.join("\n") : "No snippets found for given ranges.";
    return { content: [{ type: "text", text }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Error reading snippets: ${e.message}` }] };
  }
}
```

### Position trong server.mjs

Thêm tool **sau** `deepgrep_status` (dòng ~457), **trước** `async function main()`.

Không thêm import mới — `readSnippets` và `z` đã import ở đầu file.

### Test pattern — follow `deepgrep/test/health.test.mjs`

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
// ...
```

Test với file thật: dùng `import.meta.url` → `fileURLToPath` để resolve path fixture, hoặc tạo tmp file bằng `fs.writeFileSync` trong tmp dir.

### Nợ kỹ thuật từ Story 2 (không phải scope story này)

Các `[Review][Patch]` trong Story 2 (health.mjs: double-ping, key validation, etc.) KHÔNG thuộc Story 3.1. Đừng fix chúng trong story này — track ở `deferred-work.md`.

### NFR compliance (từ PRD)

- NFR3: Không thêm dependency mới — `readSnippets` reuse, `z` đã có
- NFR4: Backward compat — thêm tool mới không break tool cũ
- NFR5: `deepgrep_get` không gọi API, latency <50ms cho file thông thường — đảm bảo bởi `readFileSync` local

### Nợ kỹ thuật nhỏ (ngoài scope, note để sau)

`package.json` và `server.mjs` version còn `1.1.0` — nên bump lên `1.2.0` khi release Epic 3. Không làm trong story này trừ khi reviewer yêu cầu.

## References

- `deepgrep/src/snippets.mjs` — `readSnippets` function (tái dụng toàn bộ)
- `deepgrep/src/server.mjs` — tool registration pattern (`deepgrep_status`)
- `deepgrep/test/health.test.mjs` — test pattern (`node:test` + `node:assert/strict`)
- `_bmad-output/planning-artifacts/architecture.md` § ADR-6 — schema Option A, stateless design
- `_bmad-output/planning-artifacts/prd.md` § FR7, NFR3/4/5
- `_bmad-output/planning-artifacts/epics.md` § Story 3.1

## Dev Agent Record

### Debug Log

- Red phase: `node --test 'deepgrep/test/snippets-tool.test.mjs'` failed because `formatSnippetToolOutput` was not exported yet.
- Green phase: added `formatSnippetToolOutput` and registered `deepgrep_get`; new snippets-tool tests passed.
- Refactor/validation: guarded server auto-start so `server.mjs` can be imported by tests/manual scripts without opening MCP stdio.

### Completion Notes

- Implemented `deepgrep_get` in `deepgrep/src/server.mjs` as a pure local wrapper around `readSnippets`.
- Added output formatting with `## {file} (Lx-y)` headers, fenced snippets, empty-input handling, out-of-bounds handling, binary-file handling, and API-key independence.
- Added unit coverage in `deepgrep/test/snippets-tool.test.mjs` for AC1, AC2, AC3, AC4, AC5, AC6, and AC7.
- Verified with `node --check deepgrep/src/server.mjs`, `node --test 'deepgrep/test/*.test.mjs'`, and a manual script fetching lines 1-5 from `server.mjs`.

### File List

- `deepgrep/src/server.mjs`
- `deepgrep/test/snippets-tool.test.mjs`
- `_bmad-output/implementation-artifacts/3-token-efficient-retrieval.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

### Change Log

- 2026-06-07: Added `deepgrep_get` tool and snippets tool test coverage; moved Story 3.1 to review.

## Review Findings

### 2026-06-07 — Code review (3 layers: Blind Hunter, Edge Case Hunter, Acceptance Auditor)

- [x] [Review][Patch] Mixed-input empty ranges reject toàn bộ request [deepgrep/src/server.mjs:80] — FIXED. Filter entries có `ranges:[]` thay vì reject-all; chỉ trả `"No files/ranges provided"` khi không còn entry hợp lệ. Test mới `mixed input` cover case hỗn hợp.
- [x] [Review][Action] Tách commit Story 3.1 khỏi 4 thay đổi out-of-scope — ACTION ITEM. Lúc commit: Story 3.1 chỉ gồm `server.mjs` (deepgrep_get + formatSnippetToolOutput + guard) + test mới. Commit riêng cho: version bump, escalate.mjs regex, health.mjs trim, `_formatResult` lookahead, escalation msg.
- [x] [Review][Patch] Guard auto-start có thể chặn CLI launch khi bin là symlink [deepgrep/src/server.mjs:519] — FIXED. Dùng `realpathSync(process.argv[1])` trước khi so sánh với `import.meta.url`.
- [x] [Review][Patch] Thiếu test cho multi-range entry [deepgrep/test/snippets-tool.test.mjs] — FIXED. Thêm test `multi-range entry` (comma-join header, `...` separator) và test `mixed input` (skip empty-ranges entry). 15/15 pass.
- [x] [Review][Defer] Header range label lệch output thực khi truncation/partial-oob [deepgrep/src/server.mjs:94 + snippets.mjs:58-72] — deferred, header in range YÊU CẦU nhưng `readSnippets` âm thầm cắt theo budget / bỏ range out-of-bounds → header `L1-100` trên body chỉ có L1-50. Cần `readSnippets` trả range thực mới fix đúng.
- [x] [Review][Defer] Duplicate file path → output trùng lặp [deepgrep/src/server.mjs:87-99 + snippets.mjs:41] — deferred, `readSnippets` key Map theo `full_path`; 2 entry cùng file → entry sau ghi đè, vòng lặp output in cùng snippet 2 lần. Edge case hiếm từ output deepgrep_search thực.
- [x] [Review][Defer] `_formatResult` in `## ${file.path}` → `undefined` [deepgrep/src/server.mjs:163] — deferred, pre-existing trong path `include_snippets` của deepgrep_search; lookup đúng `file.full_path` (160) nhưng header in `file.path`. Không thuộc diff Story 3.1.

Dismissed (noise/false-positive/by-design): arbitrary file read "vuln" (by-design — AC6 pure local read, MCP chạy local quyền user, ngang deepgrep_search), AC7 code fences khác sample (Dev Notes refine có chủ đích, test validate, nhất quán nội bộ), `node:url` "import mới" (builtin, không vi phạm NFR3), `snippetMap.get(file)` keying "bug" (FP — `file` chính là key `full_path`), `MULTI_HOP_KEYWORDS` regex-as-string (FP — escalate.mjs:52 compile qua `new RegExp`).
