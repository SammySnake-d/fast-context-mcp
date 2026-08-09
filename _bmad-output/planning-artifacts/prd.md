---
title: "deepgrep v1.1/v1.2 — PRD"
status: living-document
created: 2026-06-07
updated: 2026-06-07
owner: Luisphan
inputDocuments:
  - "deepgrep/ROADMAP-v1.1.md"
  - "_bmad-output/planning-artifacts/research-deepgrep-v1.2.md"
---

# deepgrep v1.1 — Product Requirements Document

## 1. Bối cảnh

deepgrep v1.0 đã ship: MCP server semantic code search với 2 mode (fast SWE-1.6/Windsurf, deep combo qua 9router). Benchmark chứng minh **giá trị cốt lõi = deep multi-hop reasoning**.

**v1.1** (done): Khuếch đại core value, giảm friction hằng ngày, tăng độ tin cậy — auto-escalation, cache, error UX, deepgrep_status, binary build.

**v1.2** (planning): Token-efficient retrieval — đóng gap với Augment Context Engine theo cách nhẹ hơn, zero-index, không cần enterprise setup. Insight: Augment nổi bật vì assembled context, deepgrep v1.2 thêm `deepgrep_get` để agent không phải `read_file` toàn bộ.

**Positioning:** deepgrep = zero-setup semantic code search, no index, BYOM, token-efficient. Cho individual dev và team nhỏ — không cạnh tranh trực tiếp Augment enterprise ($60+/dev/tháng).

## 2. Mục tiêu v1.1

- G1. User không phải tự chọn quick vs deep (auto-routing).
- G2. Query lặp không tốn token (cache hoạt động đúng).
- G3. Lỗi rõ ràng, actionable (429/403/no-key).
- G4. Setup self-verifiable (health check).

## 3. Non-goals

- v1.1: Port Rust; embedding index; multi-repo/GitHub; thêm model provider mới; streaming progress.
- v1.2: Index-based search; symbol-aware AST parsing (phá moat zero-index); cross-repo (hoãn v1.3).

## 4. Functional Requirements

> ✅ v1.1 (done) · 🔲 v1.2 (backlog)

### ✅ FR1 — Auto-escalation quick → deep
- WHEN query có dấu hiệu multi-hop (≥3 mệnh đề / keywords "trace/flow/across/from...to") OR quick trả 0 results, THE system SHALL tự dùng deep mode (retry 1 lần).
- THE system SHALL có param `auto_escalate` (default true) để tắt.
- THE output SHALL ghi rõ mode thực tế đã dùng (vd "[escalated to deep]").

### ✅ FR2 — Cache verify & hoàn thiện
- WHEN query + project_path + model giống hệt và codebase chưa đổi, THE system SHALL trả kết quả từ cache không gọi API.
- WHEN file trong project thay đổi (mtime), THE system SHALL invalidate cache liên quan.
- THE output metadata SHALL chứa `cache_hit: true|false`.
- THE system SHALL hỗ trợ `DEEPGREP_CACHE_DISABLED` và `DEEPGREP_CACHE_TTL_MS`.

### ✅ FR3 — Better error UX
- WHEN nhận HTTP 429, THE system SHALL trả message: model bị rate limit + gợi ý đổi model/đợi.
- WHEN nhận HTTP 403, THE system SHALL gợi ý dùng combo `deep-search` hoặc model khác.
- WHEN deep model fail, THE system SHALL suggest fallback model cụ thể.

### ✅ FR4 — Health-check tool `deepgrep_status`
- THE system SHALL cung cấp tool `deepgrep_status` trả về: key hợp lệ?, models available, Devin Desktop có cài?, config hiện tại (URL/model/fast backend).

### ✅ FR5 — Query refinement (quick mode)
- WHEN query không phải tiếng Anh hoặc quá mơ hồ, THE system SHALL gợi ý rephrase bằng code terms tiếng Anh, HOẶC tự nâng lên deep (liên kết FR1).

### ✅ FR6 — Single binary build
- THE build SHALL hỗ trợ tạo standalone binary (`bun build --compile`) cho macOS/Linux/Windows.

### 🔲 FR7 — Token-efficient two-stage retrieval (`deepgrep_get`)
- THE system SHALL cung cấp tool `deepgrep_get` nhận `{file, ranges}[]` và trả code snippets với line numbers.
- THE tool SHALL KHÔNG gọi API (pure local file read).
- THE tool SHALL tôn trọng `FC_SNIPPET_MAX_LINES` / `FC_LINE_MAX_CHARS`.
- THE tool SHALL handle binary files gracefully.
- THE tool SHALL bỏ qua out-of-bounds ranges mà không crash.
- **Rationale:** Augment Context Engine assembled context là killer feature. deepgrep_get là phiên bản token-efficient: agent chọn chủ động file nào cần, không phải đọc toàn bộ. Tái dụng `snippets.mjs` đã có.

### 🔲 FR8 — Warm cache (optional)
- THE system SHALL cung cấp lệnh/tool để precompute repo map và warm cache trước khi query.
- **Priority:** P1 optional, ship kèm FR7 nếu còn budget.

### 🔲 FR9 — Stable structured output contract (v1.3)
- WHEN `output_format=json` truyền vào `deepgrep_search`/`deepgrep_deep`/`deepgrep_get`, THE system SHALL trả schema ổn định gồm `schema_version`, `files[]`, `grep_keywords[]`, `meta{backend,mode,cache_hit,retrieval,index_used,...}` (xem ADR-8).
- THE forward-looking fields `retrieval` và `index_used` SHALL có mặt trong v1.3 với giá trị mặc định `"lexical"` / `false` (reserved cho v2.0 indexed tier — non-breaking).
- THE existing text mode SHALL là default và unchanged (backward compat).
- ALL serialization SHALL đi qua một module duy nhất `src/contract.mjs` — không có nhánh JSON rải rác per-tool.

### 🔲 FR10 — Context Pack tool `deepgrep_pack` (v1.3)
- THE system SHALL cung cấp tool `deepgrep_pack` nhận `{query?, files?, ranges?, max_chars, max_lines?}` và trả snippets nhóm theo role + ordered theo rank, trong budget.
- WHEN `files`/`ranges` truyền trực tiếp, THE tool SHALL hoạt động pure local (không gọi API, không cần key).
- THE tool SHALL reuse `readSnippets` + `formatSnippetToolOutput` (Story 3.1) — KHÔNG duplicate snippet I/O.
- THE tool description SHALL nêu rõ workflow: `deepgrep_search` → `deepgrep_pack` (xem ADR-9).

### 🔲 FR11 — Result ranking & dedup (v1.3)
- WHEN nhiều results trả về, THE system SHALL merge duplicate file paths và overlapping ranges trong cùng file.
- WHEN query không yêu cầu test, THE system SHALL ưu tiên source files over test/docs (path heuristic: `/test/`, `.test.`, `__tests__/`).
- WHEN deep-mode trả results đã được LLM order, THE system SHALL chỉ rerank khi multi-file results hoặc explicit `rerank=true` — default trust LLM order.
- THE ranking logic SHALL nằm trong pure module `src/rank.mjs` (testable in isolation).

### 🔒 FR12 (gated, v2.0) — Optional indexed tier
- IF gate ADR-10 passes (≥2/4 conditions trong §9), THEN THE system MAY cung cấp opt-in local index `.deepgrep/` qua command `deepgrep index`.
- THE indexed mode SHALL trả cùng output contract như zero-index (hidden backend).
- THE zero-index mode SHALL vẫn là default, non-breaking khi không có index.
- BYOM embeddings, no lock-in. KHÔNG symbol graph / refactor (Serena territory).

## 5. NFRs

- NFR1. Cache hit trả < 100ms.
- NFR2. Auto-escalation không tăng latency cho query đơn giản (heuristic local, ~0ms).
- NFR3. Không thêm dependency nặng (giữ zero system-level dep).
- NFR4. Backward compatible — config v1.0 vẫn chạy.
- NFR5. `deepgrep_get` không gọi API, latency < 50ms cho file thông thường.
- NFR6 (v1.3). `deepgrep_pack` output KHÔNG vượt `max_chars` budget; dropped snippets được report rõ ràng.
- NFR7 (v1.3). Role labeling heuristic-bounded — KHÔNG AST / language server / symbol graph (preserves zero-index moat). Mỗi heuristic case phải có test fixture (guards heuristic creep).

## 6. Success Metrics

- M1. Tỉ lệ query trả kết quả đúng tăng (nhờ auto-escalation cho multi-hop). ✅ v1.1
- M2. Token cost giảm (nhờ cache hit cho query lặp). ✅ v1.1
- M3. Token cost per task giảm khi dùng deepgrep_get thay read_file. 🔲 v1.2
- Counter: latency query đơn giản không tăng.

## 7. Rủi ro

- R1. Heuristic auto-escalation sai (escalate query đơn giản → tốn token). Mitigant: param tắt + conservative threshold. ✅ mitigated
- R2. Cache invalidation miss → trả stale. Mitigant: mtime hash + TTL. ✅ mitigated
- R3. deepgrep_get ranges sai (từ AI hallucinate) → trả code không đúng. Mitigant: luôn hiển thị line numbers, user/agent verify được.

## 8. Competitive Positioning (v1.2 context)

**Augment Context Engine** là điểm tham chiếu chính cho Epic 3. Key insights:
- Augment mạnh ở scale (400k+ files), temporal context (commit history), cross-repo — enterprise $60+/dev/tháng
- deepgrep KHÔNG cạnh tranh trực tiếp. deepgrep = zero-setup, zero-index, BYOM cho individual dev/team nhỏ
- Gap cần đóng: deepgrep thiếu assembled context (agent phải read_file thêm sau search)
- `deepgrep_get` (FR7) đóng gap này theo cách token-efficient: agent chủ động chọn đoạn cần đọc
- Xem đầy đủ: `_bmad-output/planning-artifacts/research-deepgrep-v1.2.md`

---

## 9. Vision Update (2026-06-08): Zero-index Context Engine

### Positioning (updated)

> **deepgrep is a zero-index context engine for AI agents.**
>
> It assembles task-specific code context from any repo without indexing, language servers, or enterprise setup — returning precise snippets under an explicit token budget via MCP or CLI.

**Tagline:** Context without indexing.

**Previous positioning** ("zero-setup semantic code search") remains true but is now a subset of the broader vision: deepgrep evolves from search tool → context engine.

### Relationship to Augment Context Engine

Augment and deepgrep solve the same job-to-be-done (assemble relevant coding context) but with fundamentally different architectures:

| Dimension | Augment | deepgrep |
|---|---|---|
| Context model | Persistent indexed context engine | On-demand zero-index context engine |
| Target | Enterprise complex codebases | Agents, OSS, small teams, local repos |
| Setup | Platform deployment + indexing | MCP/CLI, immediate |
| Output | IDE/assistant context | Structured snippets/context packs |
| Model | Proprietary/managed | BYOM |
| Strength | Scale + integrated automation | Portability + token efficiency + composability |

deepgrep does NOT compete on enterprise infra. It competes on the **job**: "give me the right context for this task."

### North Star — v2.0 Indexed Tier (gated, aspirational)

v2.0 MAY add an optional indexed tier for large repos where zero-index hits measurable recall/perf limits. This is gated:

**Conditions to open (at least 2 must be true):**
1. Real users report zero-index too slow/recall-poor on large repos (measured)
2. Repeated need for multi-repo or persistent project memory
3. Agent flows need context across sessions, not just per-query
4. Repo size exceeds threshold where on-demand embedding is impractical

**If opened, architecture:**
- Local-first index (`.deepgrep/` dir), not cloud service
- Opt-in, incremental (`deepgrep index` command)
- BYOM embeddings, no lock-in
- Same output contract — index is hidden backend, agents don't care
- Still no symbol graph / refactor (Serena territory)

**If gate never passes:** deepgrep stays pure zero-index. That's fine — the moat is preserved.

### What deepgrep explicitly does NOT do

- Symbol graph / language server indexing (→ Serena)
- Refactoring / editing / debugging tools (→ Serena)
- Persistent agent memory (→ Serena)
- Enterprise multi-tenant platform (→ Augment/Sourcegraph)
- Org governance / dashboard / SSO
- Managed cloud indexing service
- Vector DB as default (breaks zero-index moat)

## 10. Metrics (updated for Context Engine)

- M1. deepgrep_search response time < 10s median (zero-index). ✅ v1.1
- M2. Cache hit < 100ms. ✅ v1.1
- M3. Token cost per task reduced when using deepgrep_get vs read_file. ✅ v1.2
- M4. Context Pack returns relevant snippets within budget (recall@3 ≥ 70% on internal benchmark). 🔲 v1.3
- M5. Agent integration recipes adopted by ≥ 3 distinct MCP clients. 🔲 v1.5

