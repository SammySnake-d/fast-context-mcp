---
title: "deepgrep v1.2 — Research, Competitive Deep-Dive & Đề xuất tính năng"
author: "Mary (Business Analyst)"
date: 2026-06-07
status: approved
baseline: "v1.1 done (auto-escalation, cache, error UX, deepgrep_status, binary build)"
---

# deepgrep v1.2 — Research & Đề xuất tính năng

---

## Phần 1: Competitive Deep-Dive — Augment Context Engine

### 1.1 Cơ chế kỹ thuật

Augment Context Engine là một **semantic index + live knowledge graph** chứ không chỉ là RAG thông thường:

| Layer | Chi tiết |
|-------|----------|
| Vector DB | Embedding các chunk (function/class/block), HNSW index, sub-200ms retrieval |
| Knowledge Graph | Map relationship: call sites, imports, db usage, cross-service dependency |
| Commit history | "Context Lineage" — mỗi commit được tóm tắt bằng Gemini 2.0 Flash → embed → searchable |
| External sources | GitHub, Jira, Confluence, Notion, Linear, Sentry, Stripe, Glean |

**Scale:** Có thể index 400,000–500,000 files. Update trong vài giây sau commit. Processing speed: thousands of files/second trên Google Cloud + NVIDIA GPU.

**Hai mode:**
- **Local** (`auggie` CLI chạy MCP stdio) — index working directory, real-time uncommitted changes
- **Remote** (`https://api.augmentcode.com/mcp`) — hosted, default branches, cross-repo, CI/server

### 1.2 Token Efficiency

Augment giải quyết token budget qua 3 cơ chế:
1. **Smart retrieval** — chỉ lấy chunk liên quan, không dump cả repo vào prompt
2. **Commit compression** — raw diff → tóm tắt ngắn gọn (Gemini Flash), tiết kiệm token giữ ý
3. **Multi-stage ranking** — vector search shortlist → rerank → top-K vào context

Kết quả benchmark họ tự công bố:
- 71% improvement trên Cursor (Claude Opus 4.5), completeness +60%, correctness +5×
- 80% improvement trên Claude Code (Opus 4.5)
- **Ít tool call hơn → token cost thấp hơn** (nghịch lý: chất lượng cao hơn mà token ít hơn)
- SWE-bench: 70.6% vs đối thủ ~54%

### 1.3 Pricing (credit-based, 2025-2026)

| Plan | Giá | Credits |
|------|-----|---------|
| Indie | ~$20/tháng | 40,000 credits |
| Standard | $60/dev/tháng | 130,000 credits/seat |
| Max | $200/dev/tháng | 450,000 credits/seat |
| Enterprise | Custom | Custom |

**Per-query cost (Context Engine MCP):** ~40–70 credits/query  
**Top-up:** $15 per 24,000 credits (~$0.000625/credit)

**Ví dụ task cost (Intent multi-agent):**
- Fix 500 error: 88 credits (Haiku) → 293 credits (Sonnet) → 488 credits (Opus)
- Multi-tenant billing system: 976 credits (Opus)

### 1.4 Điểm mạnh thật sự của Augment

1. **Scale thật** — 400k+ files, sub-200ms retrieval. Không tool nào zero-index làm được điều này ở scale này.
2. **Temporal context** — Context Lineage là khác biệt độc đáo. Augment trả lời được "tại sao code này như vậy?" và "feature flag này implement như thế nào trước đây?"
3. **Cross-repo** — Multiple repos, cross-service dependency map. Thứ deepgrep chưa có.
4. **MCP ecosystem** — Expose Context Engine qua MCP standard → ai cũng dùng được (Claude Code, Cursor, Kiro).
5. **"Infinite context" UX** — User không phải nghĩ về context window hay token budget.

### 1.5 Điểm yếu / Giới hạn của Augment

| Giới hạn | Chi tiết |
|----------|---------|
| **Setup nặng** | Cần cài Auggie CLI, cấu hình GitHub App, chờ index build (hàng trăm nghìn file = nhiều phút lần đầu) |
| **Vendor lock-in** | Index proprietary, không export được. Đổi tool = mất hết context |
| **Chi phí** | $60+/tháng/dev. Enterprise cần negotiate |
| **Không local-first** | Mode remote cần connect Augment cloud, không fully offline |
| **Stale branch issue** | Remote mode chỉ index default branch, feature branch chưa push không được thấy |
| **Hallucination vẫn còn** | Báo cáo 1.5-4.6% hallucination rate ngay cả với Context Engine |
| **Dependency nặng** | Google Cloud infrastructure — không self-host dễ dàng |

---

## Phần 2: So sánh định vị deepgrep vs Augment

```
                    deepgrep              Augment Context Engine
─────────────────────────────────────────────────────────────────
Setup               ✅ npx deepgrep       ❌ CLI + GitHub App + chờ index
Zero-index          ✅ Không cần index    ❌ Cần build index trước
Local-first         ✅ Chạy offline       ⚠️ Mode local có, remote cần cloud
Cost                ✅ Free (Windsurf)    ❌ $60+/dev/tháng
BYOM                ✅ OpenAI-compat      ⚠️ Chọn model nhưng qua Augment proxy
Scale (file count)  ⚠️ Giới hạn tree     ✅ 400k+ files
Cross-repo          ❌ Chưa có            ✅ Có
Temporal context    ❌ Chưa có            ✅ Context Lineage (commit history)
Token retrieval UX  ⚠️ Chỉ trả file+range ✅ Full context assembled
MCP standard        ✅ Có                 ✅ Có
```

### Phân tích cạnh tranh thật

**Augment KHÔNG phải đối thủ trực tiếp của deepgrep.** Họ đang đánh vào enterprise với đội phát triển lớn (400k+ files, cross-service, $60+/dev/tháng). deepgrep đánh vào:
- Individual dev / solo/team nhỏ (không muốn/không có ngân sách Augment)
- Repo nhỏ-vừa cần search nhanh không muốn setup
- BYOM use case (tự bring key, không bị lock vào vendor)
- "Tôi muốn search ngay, không cần chờ index 10 phút"

**Insight quan trọng từ Augment benchmark:** Bài blog của Augment có trích bài `jxnl.co` — "Why grep beat embeddings in our SWE-bench agent." Augment đang giải quyết vấn đề tương tự deepgrep nhưng từ góc enterprise. **Zero-index reasoning (cách deepgrep hoạt động) thực ra là approach phù hợp với mid-size repos** — điều Augment cũng ngầm thừa nhận khi họ dùng retrieval + reasoning thay vì chỉ embedding.

---

## Phần 3: Đề xuất tính năng v1.2

### F1 — `deepgrep_get`: Token-efficient two-stage retrieval ⭐ ƯU TIÊN SỐ 1

**Insight từ Augment:** Augment nổi bật vì **assembled context** — agent không phải tự đọc thêm file. deepgrep hiện chỉ trả file + ranges, buộc agent phải `read_file` lại → tốn token.

**Giải pháp:** Tool `deepgrep_get(file, ranges)` — trả **chính xác đoạn code** theo ranges, đã có line numbers. Tái dùng `snippets.mjs` đã viết sẵn (`readSnippets`).

```
Workflow 2 bước (token-efficient):
1. deepgrep_search → file paths + ranges [rẻ: không kèm code]
2. deepgrep_get → lấy đúng đoạn code [chính xác: không đọc thừa]

So với Augment: Augment làm bước 1+2 trong 1 call (tiện hơn nhưng tốn token hơn).
deepgrep tách ra → agent chọn file nào cần đọc thêm → tiết kiệm hơn cho repo nhỏ.
```

**Marketing positioning:** "Get the exact code, not the whole file. 10x token savings vs read_file."

**Effort:** Thấp — `readSnippets()` đã có, chỉ cần wrap thành MCP tool.

**Acceptance (nháp):**
- Input: `file` (path) + `ranges` ([[start, end], ...]) hoặc `files` array (output format từ deepgrep_search)
- Output: code với line numbers, đúng format `snippets.mjs`
- Tôn trọng `FC_SNIPPET_MAX_LINES`, `FC_LINE_MAX_CHARS`
- Bỏ qua range out-of-bounds, handle binary file
- Không cần API key (pure local file read)

---

### F2 — Cross-repo search (`project_paths: string[]`)

**Insight từ Augment:** Cross-repo là killer feature của họ. Deepgrep cần có phiên bản đơn giản hơn (không cần index, chỉ cần chạy search parallel trên N paths).

**Giải pháp:** `project_paths: string[]` thay cho `project_path`. Chạy song song, merge + dedup kết quả.

**Đánh giá:** Giá trị thật. Effort trung bình (parallel execution + merge logic + tree size bùng nổ khi nhiều repo lớn). **Để v1.2 sau F1** hoặc v1.3.

---

### F3 — Warm cache command

**Giải pháp:** CLI/tool hâm nóng cache cho các query phổ biến hoặc precompute repo map.

**Đánh giá:** Nice-to-have. Ship kèm F1 nếu còn budget. Không phải differentiator chính.

---

### F4 — Symbol-aware mode (KHÔNG làm)

**Lý do loại bỏ:** Phá moat zero-index. Đụng sân index-based tools đã mature. Không nên làm.

---

## Phần 4: Kết luận & Hành động tiếp theo

### Positioning statement sau v1.2

> deepgrep: **Zero-setup semantic code search. No index. BYOM. Token-efficient.**  
> For teams who want AI-level code understanding without the enterprise setup tax.

### Scope v1.2 được đề xuất

| Priority | Feature | Effort | Decision |
|----------|---------|--------|----------|
| P0 | F1 — `deepgrep_get` two-stage retrieval | Thấp | ✅ Làm |
| P1 | F3 — Warm cache | Thấp | Optional, ship kèm |
| P2 | F2 — Cross-repo | Trung-Cao | Hoãn v1.3 |
| — | F4 — Symbol-aware | Cao | ❌ Loại bỏ |

### Next steps

1. Update **epics.md** thêm Epic 3 (v1.2 features) — không tạo file mới
2. Update **prd.md** thêm FR7/FR8 — không tạo file mới
3. Khi sẵn sàng dev: tạo Story 3.1 (deepgrep_get) trong implementation-artifacts
