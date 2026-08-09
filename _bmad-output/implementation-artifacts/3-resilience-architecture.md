---
baseline_commit: d7e9f343dac21f856d9c87b4161448c814d53e54
---

# Story 3: Resilience, Testing & Unified Architecture

Status: review

## Story

As a maintainer positioning fast-context-mcp for long-term stability,
I want a test suite, secure TLS defaults, and a unified backend abstraction,
so that the project is resilient, testable, and easy to extend with new providers.

## Acceptance Criteria (BDD)

### AC1: Unit tests pass
- **Given** chưa có test
- **When** thêm test framework + tests
- **Then** `npm test` pass; tests cover: protobuf round-trip, answer XML parsing + path-traversal guard, extract-key fallback priority

### AC2: TLS verification secure by default
- **Given** code hiện auto-disable TLS verification khi fetch lỗi
- **When** sửa
- **Then** TLS KHÔNG tự tắt; chỉ tắt khi `FC_ALLOW_INSECURE_TLS=1`; stderr cảnh báo rõ khi tắt

### AC3: Unified backend interface
- **Given** 2 backend (Windsurf + OpenAI) tách rời, server.mjs biết chi tiết cả 2
- **When** refactor thành interface chung
- **Then** `Backend.search(opts)` là API duy nhất server.mjs gọi; thêm provider mới = implement interface + đăng ký, KHÔNG sửa server.mjs
- **And** README định vị "multi-backend AI code search" (Windsurf = free fallback)

### AC4: No regression
- **Given** cả fast_context_search + deep_context_search hoạt động trước refactor
- **When** chạy lại
- **Then** vẫn hoạt động + kết quả tương đương

## Tasks

- [x] **T1. Unit test setup** — `test/` folder, `package.json scripts.test = "node --test"`.
- [x] **T2. Test protobuf.mjs** — ProtobufEncoder round-trip (writeString/writeVarint/writeMessage → extractStrings), connectFrameEncode → connectFrameDecode (gzip round-trip), decodeVarint edge cases.
- [x] **T3. Test _parseAnswer** — valid XML → correct files + ranges; path traversal `../` rejected; absolute path outside root rejected; empty `<ANSWER></ANSWER>` → 0 files.
- [x] **T4. Test extract-key** — `getDbPath()` priority Devin > Windsurf; missing DB → error with hint.
- [x] **T5. TLS hardening** — Sửa `_applyTlsFallback`: chỉ `NODE_TLS_REJECT_UNAUTHORIZED="0"` khi `FC_ALLOW_INSECURE_TLS=1`. Bỏ auto-fallback. Cập nhật error classify cho TLS failures. Thêm env var doc trong README.
- [x] **T6. Backend interface** — Tạo `src/backends/index.mjs` (registry/factory), `src/backends/windsurf.mjs` (wrap core.mjs#search), `src/backends/openai.mjs` (wrap openai-backend.mjs#searchOpenAI). Interface: `async search(opts) → {files, rg_patterns, _meta, error?}`.
- [x] **T7. Refactor server.mjs** — dùng registry: `getBackend(mode)` → `backend.search(...)` + `_formatResult`. server.mjs mỏng đi, không biết chi tiết backend.
- [x] **T8. README reposition** — Tiêu đề + overview = "multi-backend AI code search". Windsurf = 1 provider (free). Nhấn mạnh extensible.
- [x] **T9. Verify** — `npm test` pass + fast query + deep query hoạt động.

## Dev Notes

- **Thứ tự tasks quan trọng:** T1-T4 (tests) trước, vì tests sẽ guard T5-T7 (refactor). T6-T7 là restructure lớn nhất — cần tests sẵn sàng.
- **Backend interface (T6):**
  - Chữ ký đã gần giống nhau giữa `search()` (core) và `searchOpenAI()` (openai-backend). Khác: Windsurf cần apiKey/jwt (tự discover). Bọc vào class để giấu.
  - `_meta` chuẩn hoá: luôn có `{backend, model, treeDepth, treeSizeKB, fellBack}`. Windsurf thêm `errorCode`, OpenAI thêm `model` cụ thể.
  - Giữ export cũ (`searchWithContent`, `searchOpenAI`) làm thin wrapper cho backward compat (ai đang import trực tiếp sẽ không hỏng).
- **TLS (T5):**
  - `_applyTlsFallback` gọi ở 2 nơi trong core.mjs: catch của `_unaryRequest` (line ~380) và `_streamingRequest` attempt 0 (line ~430).
  - Sau sửa: TLS errors propagate → `_classifyError` → NETWORK_ERROR. Error message nên gợi ý: "If behind corporate proxy, set FC_ALLOW_INSECURE_TLS=1".
  - `openai-backend.mjs` dùng fetch trực tiếp, không có TLS fallback — OK, không cần sửa.
- **Test _parseAnswer (T3):** sau Story 1, hàm này nằm ở `shared.mjs` và đã export → test thẳng. Nếu làm story này TRƯỚC story 1, cần thêm export tạm từ core.mjs.
- **Structure target:**
  ```
  src/
  ├── server.mjs (mỏng: dispatch + format)
  ├── shared.mjs (prompts, getRepoMap, parseAnswer) [từ Story 1]
  ├── cache.mjs [từ Story 2]
  ├── backends/
  │   ├── index.mjs (registry)
  │   ├── windsurf.mjs
  │   └── openai.mjs
  ├── executor.mjs (giữ nguyên)
  ├── extract-key.mjs (giữ nguyên)
  └── protobuf.mjs (giữ nguyên)
  test/
  ├── protobuf.test.mjs
  ├── parse-answer.test.mjs
  └── extract-key.test.mjs
  ```

### References

- [Source: architecture.md#5-Backend-Abstraction] — interface definition
- [Source: architecture.md#7-Security-Architecture] — ADR-5: TLS opt-in
- [Source: architecture.md#9-Testing-Strategy] — node:test, unit scope
- [Source: architecture.md#3-Source-Structure] — target structure
- [Source: architecture.md#12-ADR-3] — multi-backend rationale
- [Source: src/core.mjs#_applyTlsFallback] — TLS auto-disable (to fix)
- [Source: src/protobuf.mjs] — all exports testable

## Dev Agent Record

### Agent Model Used
Auto (Claude via Kiro CLI)

### Completion Notes List
- T1-T4: Test suite (18 tests) using node:test — covers protobuf encode/decode/frames, _parseAnswer XML + path-traversal guard, extract-key getDbPath priority + missing DB error handling.
- T5: TLS hardening — _applyTlsFallback now opt-in only (FC_ALLOW_INSECURE_TLS=1). No auto-disable. Added env var to README.
- T6: Backend interface — src/backends/{index,windsurf,openai}.mjs. Registry pattern: getBackend(name) → {search(opts)}. New provider = new class + register, no server.mjs edit.
- T7: server.mjs refactored to use getBackend("windsurf") and getBackend("openai") for routing. Direct searchOpenAI import kept for backward compat but called through registry.
- T8: README repositioned as "Multi-backend AI-driven semantic code search".
- T9: npm test 18/18, node --check all files OK, MCP E2E init + live search returns results.

### File List
- `test/protobuf.test.mjs` — NEW
- `test/parse-answer.test.mjs` — NEW
- `test/extract-key.test.mjs` — NEW
- `src/backends/index.mjs` — NEW (registry)
- `src/backends/windsurf.mjs` — NEW
- `src/backends/openai.mjs` — NEW
- `src/core.mjs` — MODIFIED (TLS hardening)
- `src/server.mjs` — MODIFIED (backend registry routing)
- `package.json` — MODIFIED (test script)
- `README.md` — MODIFIED (multi-backend positioning + FC_ALLOW_INSECURE_TLS)

## Change Log
- 2026-06-06: Story 3 Resilience implemented — test suite (18 tests, node:test), TLS opt-in only, backend registry abstraction, server.mjs routes through getBackend(), README repositioned as multi-backend.
