# Test Suite — deepgrep

## Setup

Không cần cài thêm dependency — project sử dụng `node:test` (built-in Node.js 18+).

```bash
# Cài dependencies (chỉ cần lần đầu)
npm install

# Chạy toàn bộ test
npm test
```

## Chạy Tests

```bash
# Toàn bộ test (recursive)
npm test

# Chỉ test ở root level (unit tests cũ)
npm run test:unit

# CI mode (có JUnit reporter output)
npm run test:ci

# Chạy 1 file cụ thể
node --test test/escalate.test.mjs

# Chạy với pattern filter
node --test --test-name-pattern="shouldEscalate" test/escalate.test.mjs

# Chạy parallel (Node 20+)
node --test --test-concurrency=4 'test/**/*.test.mjs'
```

## Cấu trúc

```
test/
├── README.md                    ← bạn đang đọc file này
├── .env.example                 ← template env cho integration tests
│
├── helpers/                     ← shared test utilities
│   ├── test-project.mjs         ← factory tạo temp project directories
│   ├── mock-backends.mjs        ← mock search backends (windsurf/openai)
│   ├── assertions.mjs           ← custom assertions cho search results
│   └── env.mjs                  ← safe env var manipulation
│
├── fixtures/                    ← test data & mock responses
│   └── search-responses.mjs     ← sample search result objects
│
├── backends.test.mjs            ← backend registry (getBackend, listBackends)
├── cache.test.mjs               ← caching logic (buildCacheKey, TTL, eviction)
├── escalate.test.mjs            ← auto-escalation heuristic (shouldEscalate)
├── extract-key.test.mjs         ← Windsurf API key extraction
├── parse-answer.test.mjs        ← XML answer parsing + path security
├── protobuf.test.mjs            ← protobuf encode/decode + Connect framing
├── repo-map.test.mjs            ← getRepoMap with real temp directories
├── server-format.test.mjs       ← friendlyError + output formatting
├── shared.test.mjs              ← shared utilities (prompts, regex, constants)
└── snippets.test.mjs            ← code snippet extraction
```

## Architecture

### Helpers

| File | Mục đích |
|------|----------|
| `test-project.mjs` | Factory tạo temp project directories với file structure tuỳ chỉnh. Auto-cleanup. |
| `mock-backends.mjs` | Mock backends cho test không cần network. Track call history. |
| `assertions.mjs` | Domain-specific assertions: `assertValidSearchResult`, `assertFormattedOutput`, etc. |
| `env.mjs` | Safe env manipulation: `setEnv()` + `withEnv()` với auto-restore. |

### Fixtures

| File | Mục đích |
|------|----------|
| `search-responses.mjs` | Sample response objects matching actual API response structure. |

## Best Practices

### 1. Isolation

- Mỗi test tự tạo và cleanup resources (temp dirs, env vars)
- Dùng `createTestProject()` thay vì dùng project thật
- Dùng `setEnv()` / `withEnv()` thay vì trực tiếp `process.env`

### 2. No Network Calls trong Unit Tests

- Dùng `createMockBackend()` cho backend tests
- Integration tests cần API key nằm trong test riêng (gated by env)

### 3. Naming Convention

- File: `<module-name>.test.mjs`
- Describe blocks: tên module/function
- It blocks: mô tả behavior, bắt đầu bằng verb

### 4. Import Pattern

Vì source code nằm trong `deepgrep/` (open source, không modify):

```js
// ✅ Đúng — import từ deepgrep/src/
import { shouldEscalate } from "../deepgrep/src/escalate.mjs";

// ❌ Sai — path cũ (src/ ở root đã không còn)
import { shouldEscalate } from "../src/escalate.mjs";
```

## CI Integration

Test script cho CI pipeline:

```yaml
- name: Run tests
  run: npm run test:ci

- name: Upload test results
  uses: actions/upload-artifact@v4
  if: always()
  with:
    name: test-results
    path: test-results.xml
```

JUnit XML output tự động tạo bởi `test:ci` script tại `test-results.xml`.

## Thêm Test Mới

1. Tạo file `test/<module>.test.mjs`
2. Import module từ `../deepgrep/src/<module>.mjs`
3. Dùng helpers từ `./helpers/` nếu cần
4. Chạy `node --test test/<module>.test.mjs` để verify
5. Đảm bảo `npm test` vẫn pass toàn bộ
