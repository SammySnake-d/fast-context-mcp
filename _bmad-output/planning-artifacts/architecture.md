---
title: "deepgrep v1.1 — Architecture"
status: draft
created: 2026-06-07
updated: 2026-06-07
author: Winston (System Architect)
inputDocuments:
  - "_bmad-output/planning-artifacts/prd.md"
  - "_bmad-output/planning-artifacts/epics.md"
---

# deepgrep v1.1 — Architecture

> Triết lý: boring tech, dev productivity, không scope creep. v1.1 mở rộng v1.0 bằng cách thêm 1 lớp routing + cache, KHÔNG đổi kiến trúc nền.

## 1. As-built (v1.0)

deepgrep là MCP stdio server (Node ESM, ~3300 LOC) với 2 backend chia sẻ chung shared layer.

```
server.mjs (MCP entry, 2 tools)
   ├── deepgrep_search → backends/windsurf.mjs (SWE-1.6, protobuf) ──┐
   └── deepgrep_deep   → backends/openai.mjs (9router combo) ────────┤
                                                                      ▼
                          shared.mjs (prompts, getRepoMap, _parseAnswer)
                          executor.mjs (rg/readfile/tree, local)
                          cache.mjs (in-memory, scaffold)
                          snippets.mjs (code content reader)
                          protobuf.mjs (Windsurf wire format)
                          extract-key.mjs (Devin/Windsurf key)
```

| Module | Vai trò |
|--------|---------|
| `server.mjs` | MCP entry, đăng ký tools, dispatch, format output |
| `backends/index.mjs` | Registry: `getBackend(name)` |
| `backends/windsurf.mjs` | Wrap core.mjs (protobuf SWE-1.6) |
| `backends/openai.mjs` | Wrap openai-backend.mjs (OpenAI-compatible) |
| `core.mjs` | Windsurf protocol + search loop |
| `openai-backend.mjs` | OpenAI chat completions loop + 429 retry |
| `shared.mjs` | prompts, getRepoMap, _parseAnswer (dùng chung) |
| `executor.mjs` | ToolExecutor: rg/readfile/tree local |
| `cache.mjs` | computeMtimeHash, buildCacheKey, get/setCachedResult, clearCache |
| `snippets.mjs` | readSnippets (FR include_snippets) |
| `protobuf.mjs` | Protobuf encoder/decoder |
| `extract-key.mjs` | Trích key Devin/Windsurf |

## 2. v1.1 thay đổi gì (delta)

v1.1 thêm **1 module mới** (`escalate.mjs`, `health.mjs`) + **hoàn thiện cache** + **cải thiện error layer**. KHÔNG đổi backend abstraction.

```
server.mjs
   ├── deepgrep_search ──► escalate.mjs (NEW) ──► quick OR deep
   │                         shouldEscalate(query) heuristic
   ├── deepgrep_deep   ──► openai backend
   └── deepgrep_status ──► health.mjs (NEW)

cache.mjs (verify + wire vào CẢ 2 backend)
openai-backend.mjs (friendlyError layer)
```

## 3. Decisions cho v1.1

### ADR-1: Auto-escalation là LOCAL heuristic, không gọi AI
- `escalate.mjs#shouldEscalate(query)` chạy local (~0ms): đếm mệnh đề, match multi-hop keywords, detect non-ASCII.
- **Trade-off:** Heuristic đơn giản có thể false-negative (query phức tạp viết ngắn gọn). Chấp nhận — conservative để tránh tốn token oan (NFR2). User vẫn gọi `deepgrep_deep` trực tiếp được.
- **Vì sao không dùng AI để quyết định:** thêm 1 round-trip API chỉ để route = phản tác dụng (chậm + tốn token).

### ADR-2: Cache là in-memory per-process, áp dụng CẢ 2 backend
- v1.0 cache scaffold chỉ wire vào openai backend. v1.1 wire vào cả windsurf path (core.mjs).
- Key = hash(query + model + maxTurns + maxResults + treeDepth + repoMap + mtimeHash).
- **Trade-off:** không persistent → cache mất khi restart MCP. Chấp nhận: MCP stdio sống suốt session, đủ cho query lặp trong 1 phiên làm việc. Persistent = over-engineering.
- Invalidation: mtimeHash của top-level files. **Giới hạn đã biết:** đổi file sâu mà mtime thư mục không đổi có thể miss — chấp nhận cho v1.1, TTL là safety net.

### ADR-3: Escalation flow ưu tiên cache
- Thứ tự: `shouldEscalate` → chọn mode → `computeMtimeHash` → `buildCacheKey` → check cache → (hit return / miss → `getRepoMap` → call → setCache).
- Cache key dùng query/config + recursive mtime/size/path fingerprint; repo-map chỉ được tạo sau cache miss. Cache hit không làm auth/network I/O, giữ NFR1 <100ms trên repo mục tiêu.
- Escalated deep call cũng đi qua cache → query phức tạp lặp lại vẫn được cache.

### ADR-4: Error UX là presentation layer, không đổi retry logic
- Retry 429 (exponential backoff + reset-after hint) đã có ở `_callOpenAI` — GIỮ NGUYÊN.
- v1.1 chỉ thêm `_friendlyError(err, model)` ở tầng format → dịch error code thành message actionable. Tách biệt concern: retry (network) vs message (UX).

### ADR-5: Single binary KHÔNG đổi source, chỉ thêm build target
- `bun build --compile` — source giữ nguyên ESM.
- **Rủi ro:** `@vscode/ripgrep` (binary) + `sql.js` (WASM) có thể không bundle. Nếu fail → defer sang v1.2, giữ npx primary. KHÔNG block các story khác.

### ADR-6 (v1.2): `deepgrep_get` là stateless local-read tool, tách biệt search pipeline
- Tool nhận `{file, ranges}[]` → đọc file local → format snippets → trả về. KHÔNG gọi API, KHÔNG ghi cache, KHÔNG giữ session search→get.
- **Thiết kế theo MCP best practices:**
  - **Structured schema (Option A):** `files: z.array(z.object({ file: z.string(), ranges: z.array(z.tuple([z.number(), z.number()])) }))`. Self-documenting, type-safe. Field `file` = absolute path, khớp `full_path` mà `deepgrep_search` trả về.
  - **Stateless:** MCP tool call stateless by design. Không liên kết session với search trước → giảm complexity & bug surface. Agent tự truyền ranges (copy từ output search).
  - **Graceful degradation:** file không tồn tại/binary/range out-of-bounds → annotation rõ ràng, KHÔNG throw. `readSnippets` đã handle sẵn.
  - **Token-aware:** tôn trọng `FC_SNIPPET_MAX_LINES` / `FC_LINE_MAX_CHARS`, đánh dấu khi truncate.
  - **Tool description nêu rõ 2-step workflow:** "Use after deepgrep_search to fetch exact code without reading whole files" — để LLM consumer biết khi nào gọi.
  - **Consistent:** đăng ký theo pattern `deepgrep_status` (server.tool + async handler), không thêm dependency.
- **Trade-off:** Không có session liên kết search→get → agent phải tự truyền ranges. Chấp nhận: đổi lấy zero-state, zero-coupling. Đúng triết lý boring tech.

### ADR-7 (v1.2): Warm cache là MCP tool, KHÔNG phải CLI subcommand
- deepgrep là stdio MCP server, không phải CLI app. Thêm CLI arg-parsing vào entry point = over-engineering + 2 code path.
- Nếu làm FR8: expose `deepgrep_warm` tool (pattern giống status) thay vì `deepgrep warm` command.
- **Khuyến nghị:** DEFER FR8 trừ khi đo được repo-map computation là bottleneck thật (hiện ~100ms cho medium repo — chưa phải vấn đề). Ship Story 3.1 trước, đánh giá lại sau.

### ADR-8 (v1.3): Output contract is a single serialization module, not per-tool formatting

**Context:** Epic 4 introduces JSON output alongside the existing text format. Without discipline this fans out into N tools × M formats, each drifting independently.

**Decision:**
- Add `output_format: "text" | "json"` param (default `"text"`) to `deepgrep_search`, `deepgrep_deep`, `deepgrep_get`. NO new tool for JSON.
- All serialization lives in ONE new module `src/contract.mjs`:
  ```
  serializeSearchResult(result, opts, format) → string
    ├─ "text" → existing _formatResult(...)  (unchanged, backward compat)
    └─ "json" → toJsonContract(result, opts)
  ```
- Backend code (`core.mjs`, `openai-backend.mjs`) is NOT touched. The internal shape `{files, rg_patterns, _meta, error?}` already exists; contract.mjs only serializes it.

**JSON contract (v1.0) — forward-compatible by design:**
```js
{
  schema_version: "1.0",
  files: [{ path, full_path, ranges, role?, score? }],
  grep_keywords: [...],
  meta: {
    backend: "windsurf|openai",
    mode: "quick|deep|escalated",
    cache_hit: false,
    retrieval: "lexical",      // forward-looking: "lexical|semantic|hybrid" in v2.0
    index_used: false,         // forward-looking: true when Epic 5 indexed tier active
    tree_depth, tree_size_kb, fell_back
  }
}
```

**Why `retrieval` + `index_used` now:** they are always `"lexical"`/`false` today, but reserving them means the v2.0 indexed tier (Epic 5) is a non-breaking addition, not a contract bump. Cheap to add now, expensive to retrofit after agents depend on the schema.

**Trade-off:** one extra module + a versioned schema upfront. Accepted — it is the single seam every present and future backend serializes through. `schema_version` is the escape hatch if a breaking change ever becomes unavoidable.

### ADR-9 (v1.3): `deepgrep_pack` is a thin orchestrator over readSnippets, with 4 binding constraints

**Context:** Context Pack (Story 4.2) is the highest architectural-risk item in Epic 4 — easy to implement, easy to design into long-term debt. These four decisions are binding before code.

**1. New tool, not a hidden mode.** `deepgrep_pack` is registered as a 5th tool (pattern like `deepgrep_get`). It MUST reuse `readSnippets` + `formatSnippetToolOutput` (Story 3.1) — wrapping with role/ranking/budget, NEVER duplicating snippet I/O. If pack reimplements file reading, the design is wrong.

**2. Budget unit is `max_chars` (deterministic).** `max_lines` is accepted as a UX hint but `max_chars` is the enforced budget — it does not depend on a tokenizer and is reproducible across models. Output never exceeds `max_chars`; dropped snippets are reported explicitly (e.g. `[N snippets omitted to fit budget]`).

**3. Role labeling lives in `src/roles.mjs` — pure function, heuristic-bounded.**
   ```
   labelRole({ path, content, query, matches }) → "implementation|caller|config|test|docs|type"
   ```
   Heuristics allowed: path patterns (`/test/`, `.test.`, `__tests__/`, `config`, `routes/`), filename, match density. STRICTLY FORBIDDEN: tree-sitter, AST parsing, import/call graph resolution. The moment pack parses symbols it has entered Serena territory and broken the zero-index moat. Every heuristic case MUST ship with a test fixture proving its value — no fixture, no case (guards against heuristic creep).

**4. Stateless (inherits ADR-6).** Input is `{query?, files?, ranges?, max_chars, max_lines?}`. No session linkage search→pack. When `files/ranges` supplied directly, pack is pure-local (no API key) — same posture as `deepgrep_get`.

**Trade-off:** a 5th tool grows the surface agents must learn. Accepted because pack's job (budgeted multi-file assembly + roles) is genuinely distinct from `deepgrep_get`'s job (verbatim range read). If it were merely "get with labels" it would be a param, not a tool — the budget+ranking+role composition justifies the separation.

### ADR-10 (v2.0, gated): Indexed tier needs a lifecycle ADR before any code

**Context:** Epic 5 is not "add an index" — it introduces filesystem-level state where today there is none. This ADR is a placeholder reminder, NOT a decision.

**When the Epic 5 gate passes, a dedicated ADR MUST answer before implementation:**
- Who triggers indexing — user (`deepgrep index`), agent, or auto? (recommendation: explicit user command, never auto)
- Staleness detection — mtime hash measured ~45ms (see Story 3.2 decision record); is it sufficient, or is a content hash / watch needed?
- Cleanup & orphans — `.deepgrep/` must be gitignored by default; what removes it when the repo is deleted?
- Multiprocess ownership — two MCP clients on the same repo: who owns/locks the index?
- Security — index contains code embeddings; never commit, warn on creation.

**Binding now (so Epic 4 doesn't block Epic 5):** the ADR-8 contract already reserves `retrieval` + `index_used` meta fields. The indexed tier is a hidden backend behind the SAME contract and the SAME tools — agents must not need to know whether retrieval was indexed or on-demand.

## 4. Module mới (target)

```
src/
├── escalate.mjs   [NEW] shouldEscalate(query) → {escalate: bool, reason, refineHint}
├── health.mjs     [NEW] checkHealth() → {keyValid, models, devinDetected, config}
├── cache.mjs      [COMPLETE] wire vào core.mjs + openai-backend.mjs
└── (rest unchanged)
```

## 5. Data flow v1.1 (deepgrep_search với auto-escalation)

```
query → shouldEscalate(query)?
  ├─ YES (multi-hop) → deep backend ──┐
  └─ NO → quick backend                │
            └─ 0 results + auto_escalate? → deep backend ─┤
                                                           ▼
                              getRepoMap → buildCacheKey → cache?
                                ├─ hit → return (cache_hit: true)
                                └─ miss → search loop → setCache → return
```

## 6. NFR compliance

| NFR | Cách đạt |
|-----|----------|
| NFR1 (cache <100ms) | In-memory Map lookup |
| NFR2 (no latency cho query đơn giản) | shouldEscalate local heuristic ~0ms |
| NFR3 (no heavy deps) | escalate/health thuần JS, không thêm package |
| NFR4 (backward compat) | env v1.0 vẫn chạy; auto_escalate default true nhưng non-breaking |

## 7. Story → Module map

| Story | Module touched |
|-------|----------------|
| 1.1 Verify cache | cache.mjs, core.mjs, openai-backend.mjs, server.mjs |
| 1.2 Auto-escalation | escalate.mjs (new), server.mjs |
| 1.3 Better error UX | openai-backend.mjs / shared.mjs, server.mjs |
| 2.1 Status tool | health.mjs (new), server.mjs |
| 2.2 Single binary | package.json, .github/workflows |
| 3.1 deepgrep_get (v1.2) | server.mjs (tool mới), snippets.mjs (tái dụng, no change) |
| 3.2 Warm cache (v1.2, defer) | server.mjs (tool mới), cache.mjs, shared.mjs (getRepoMap) |

## 8. Risks

| Risk | Mức | Mitigant |
|------|-----|----------|
| Heuristic escalate sai | TB | Conservative threshold + `auto_escalate=false` |
| Cache stale (mtime miss) | Thấp | TTL safety net + DISABLED flag |
| Binary không bundle rg/wasm | TB | Defer v1.2, npx vẫn primary |
| Windsurf protocol đổi | Cao (kế thừa v1.0) | OpenAI backend là đường chính, windsurf free fallback |
