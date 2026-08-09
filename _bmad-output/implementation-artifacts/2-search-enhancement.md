---
baseline_commit: 6bd9dea85c6f38b4a4baa149fba56132b27f3a3f
---

# Story 2: Search Enhancement — Caching & Code Snippets

Status: done

## Story

As an AI agent and developer,
I want search results cached for repeated queries and optionally include actual code snippets,
so that I save time/tokens and avoid extra round-trips reading files.

## Acceptance Criteria (BDD)

### AC1: Result caching works
- **Given** một query đã chạy trên codebase chưa thay đổi
- **When** chạy lại cùng query + cùng project_path
- **Then** kết quả trả từ cache, KHÔNG gọi API model
- **And** output có `cache_hit: true` trong metadata

### AC2: Cache key sound
- **Given** cache key = hash(query + model + maxTurns + maxResults + treeDepth + tree snapshot)
- **When** file trong project thay đổi (mtime đổi)
- **Then** cache miss → gọi API lại

### AC3: Cache configurable
- **Given** env vars `FC_CACHE_DISABLED=1` hoặc `FC_CACHE_TTL_MS=60000`
- **When** thiết lập
- **Then** cache tắt hoặc TTL thay đổi tương ứng

### AC4: Code snippets optional
- **Given** tham số `include_snippets: true`
- **When** search trả kết quả
- **Then** mỗi file kèm nội dung dòng trong range (truncate hợp lý)
- **And** mặc định `include_snippets: false`

### AC5: No regression
- **Given** `include_snippets: false` (default)
- **When** chạy query
- **Then** output format giống hệt trước (backward compatible)

## Tasks

- [x] **T1. Tạo `src/cache.mjs`** — export `getCachedResult(key)`, `setCachedResult(key, result)`, `buildCacheKey({query, model, maxTurns, maxResults, treeDepth, repoMapHash})`. In-memory Map + TTL (default 5 min). Respect `FC_CACHE_DISABLED`, `FC_CACHE_TTL_MS`.
- [x] **T2. Compute cache key** — hash = crypto.createHash('sha256').update(query + model + params + repoMap string).digest('hex'). repoMap string đã available từ getRepoMap.
- [x] **T3. Integrate cache vào search path** — check cache TRƯỚC gọi API ở cả `searchWithContent` (core) và `searchOpenAI` (openai-backend). Lưu kết quả thành công (KHÔNG cache error). Thêm `cache_hit: true/false` vào `_meta`.
- [x] **T4. Thêm param `include_snippets`** — zod boolean default false, thêm vào cả `fast_context_search` + `deep_context_search` tool schema.
- [x] **T5. Snippet reader** — sau khi có `files[].ranges`, nếu include_snippets=true: đọc từng range qua `ToolExecutor.readfile(full_path, start, end)`, append vào output. Giới hạn tổng snippet (`FC_SNIPPET_MAX_LINES`, default 200).
- [x] **T6. Format output** — cập nhật `_formatResult` (server.mjs) và `searchWithContent` (core.mjs) để render snippet dưới mỗi file entry khi enabled.
- [x] **T7. Verify** — test caching round-trip + test snippet output.

### Review Findings

_Code review (2026-06-06) — Acceptance Auditor + Edge Case Hunter (Blind Hunter layer failed/empty). Auditor verdict: AC1=FAIL, AC2=FAIL, AC3=PASS, AC4=PASS, AC5=PASS. 1 decision-needed, 5 patch, 2 defer, ~4 dismissed. **Decision resolved (option 1: fix per ADR-4); all 6 patches APPLIED & verified (9/9 unit + MCP E2E).**_

- [x] [Review][Decision→Patch] AC2 — cache does NOT invalidate on file content change [src/cache.mjs, src/core.mjs, src/openai-backend.mjs] → **FIXED**. Added `computeMtimeHash(projectRoot, excludePaths)` (walks files, aggregates mtime+size, capped 5000 files) folded into the cache key. Verified: editing file content changes the key → cache miss.

- [x] [Review][Patch] AC1 — cache_hit not surfaced in tool output → **FIXED**. Renders `cache_hit=true` in the [config] line of both core.mjs (searchWithContent) and server.mjs (_formatResult), only when true (preserves AC5). MCP E2E confirmed: 2nd identical query shows cache_hit=true.
- [x] [Review][Patch] Snippet output unsafe: binary files + missing per-line char cap → **FIXED**. snippets.mjs now detects binary (NUL byte) → "[binary file — snippet omitted]"; applies FC_LINE_MAX_CHARS (default 250) per-line cap.
- [x] [Review][Patch] Unbounded cache growth → **FIXED**. cache.mjs evicts oldest entry when at FC_CACHE_MAX_ENTRIES (default 200).
- [x] [Review][Patch] Env var parsing edge cases → **FIXED**. FC_CACHE_TTL_MS<=0 now disables cache; FC_CACHE_DISABLED accepts 1/true/yes/on (case-insensitive).
- [x] [Review][Patch] Snippet truncation marker + cache key omits excludePaths → **FIXED**. Added "[range truncated]" marker when budget reached; excludePaths folded into cache key (sorted).

- [x] [Review][Defer] Cache returns shared mutable object references [src/cache.mjs getCachedResult] — deferred, latent (no current mutator; future in-place edits would poison cache)
- [x] [Review][Defer] Large file fully read before slicing [src/snippets.mjs:29] — deferred, perf-only (budget bounds output not input)

## Dev Notes

- **Cache placement:** Sau Story 1 (shared.mjs tồn tại), cache helper đặt riêng `src/cache.mjs` cho sạch.
- **Tích hợp:** cache nằm SAU getRepoMap (cần repoMap string cho key) nhưng TRƯỚC gọi model. Flow: `getRepoMap → buildCacheKey → check cache → (hit? return) : (call model → save cache → return)`.
- **Snippet tái dụng `ToolExecutor.readfile`** — đã truncate 50 dòng / 250 ký tự. Nếu range > 50 dòng, readfile tự cắt. Có thể muốn tăng giới hạn cho snippet output (`FC_SNIPPET_MAX_LINES` riêng).
- **Invalidation đơn giản:** repoMap string thay đổi khi tree thay đổi. Để bắt file content đổi mà tree không đổi: thêm aggregate mtime top-level. Cho v1, tree snapshot là proxy đủ tốt.
- Đây là tính năng mới, nên phải GIỮ BACKWARD COMPAT: default include_snippets=false + default cache enabled nhưng transparent.

### References

- [Source: architecture.md#8-Performance-Caching] — ADR-4: in-memory, TTL, no persistent
- [Source: architecture.md#4-Agentic-Search-Loop] — result shape {files, ranges}
- [Source: src/executor.mjs#readfile] — existing range reader, reusable for snippets
- [Source: src/core.mjs#getRepoMap] — provides tree string for cache key

## Dev Agent Record

### Agent Model Used
Auto (Claude via Kiro CLI)

### Completion Notes List
- T1: Created `src/cache.mjs` (68 lines) — in-memory Map store with TTL, `buildCacheKey` (sha256), `getCachedResult`, `setCachedResult`, `clearCache`. Respects FC_CACHE_DISABLED and FC_CACHE_TTL_MS.
- T2-T3: Integrated cache into both `search()` (core.mjs) and `searchOpenAI()` (openai-backend.mjs). Cache check after getRepoMap, before API call. Only successful results cached. `_meta.cache_hit` added to all responses.
- T4: Added `include_snippets` (z.boolean default false) to both `fast_context_search` and `deep_context_search` tool schemas in server.mjs.
- T5: Created `src/snippets.mjs` (52 lines) — `readSnippets(files)` reads file content for given ranges, respects `FC_SNIPPET_MAX_LINES` (default 200), returns Map<path, formatted_text>.
- T6: Updated `searchWithContent` (core.mjs) and `_formatResult` (server.mjs) to render code snippets in output when include_snippets=true.
- T7: All tests pass — 12/12 unit tests (cache TTL, disabled, round-trip, determinism; snippet reading, limits, missing files). MCP E2E: server init OK, tools list has include_snippets param, 3 tools verified.

### File List
- `src/cache.mjs` — NEW: in-memory result cache with TTL
- `src/snippets.mjs` — NEW: file range snippet reader
- `src/core.mjs` — MODIFIED: cache integration + snippet rendering in searchWithContent
- `src/openai-backend.mjs` — MODIFIED: cache integration
- `src/server.mjs` — MODIFIED: include_snippets param + _formatResult snippet rendering + readSnippets import

## Change Log
- 2026-06-06: Story 2 Search Enhancement implemented — added result caching (in-memory, TTL, configurable) and optional code snippets (include_snippets param, FC_SNIPPET_MAX_LINES). Backward compatible (default: snippets off, cache on).
- 2026-06-06: Code review — resolved 1 decision + 5 patches (best practice): AC2 mtime-aggregate cache key (computeMtimeHash), AC1 cache_hit rendered in output, snippet binary guard + per-line char cap, cache size cap, env var hardening, truncation marker + excludePaths in key. 2 deferred (see deferred-work.md). Verified 9/9 unit + MCP E2E. Status → done.
