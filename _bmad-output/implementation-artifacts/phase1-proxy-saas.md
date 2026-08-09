# Phase 1: Proxy-as-a-Service MVP — Implementation Plan

**Timeline:** 3 ngày
**Goal:** User `npx install` → nhập API key → fast search free + deep search qua router bạn (paid)
**Revenue model:** Free tier (fast mode, $0 cost) → Pro tier (deep mode, $9-15/tháng)

---

## Ngày 1: Sản phẩm (Tool + Config)

### Task 1.1: Fork package dưới brand riêng

**Tại sao:** Không publish dưới `@sammysnake` (không phải của bạn). Cần scope riêng.

```bash
# Đổi trong package.json:
"name": "@chainlens/code-search"   # hoặc tên khác bạn own
"version": "1.0.0"
"description": "AI-driven semantic code search — free fast mode + deep mode via chainlens API"
"homepage": "https://codesearch.chainlens.net"   # landing page
"repository": "https://github.com/deptrai/chainlens-code-search"  # repo mới (private)
```

**Tạo npm org:**
```bash
npm login
```

Tạo organization `chainlens` trên npmjs.com, sau đó dùng `npm org set`,
`npm org ls`, hoặc `npm org rm` để quản lý thành viên từ CLI.

### Task 1.2: Đổi default config hướng về router bạn

Sửa `src/server.mjs`:

```javascript
// Deep mode mặc định trỏ về router bạn (user chỉ cần set FC_DEEP_API_KEY)
const DEEP_BASE_URL = process.env.FC_DEEP_BASE_URL || "https://router.chainlens.net/v1";
const DEEP_API_KEY = process.env.FC_DEEP_API_KEY || "";  // PHẢI có key → gating point
const DEEP_MODEL = process.env.FC_DEEP_MODEL || "deep-search";
```

Sửa behavior khi không có key:
```javascript
// Trong deep_context_search handler:
if (!DEEP_API_KEY) {
  return { content: [{ type: "text", text: 
    "⚡ deep_context_search requires an API key.\n\n" +
    "Get your free key at: https://codesearch.chainlens.net/signup\n" +
    "Then set: FC_DEEP_API_KEY=your-key-here\n\n" +
    "💡 Tip: fast_context_search works without a key (uses free SWE-1.6 model)."
  }] };
}
```

### Task 1.3: Bỏ phần Windsurf reverse-engineer khỏi package published

**Quyết định quan trọng:** Giữ fast mode (SWE-1.6 free) HAY bỏ?

**Option A (khuyến nghị):** Giữ nhưng KHÔNG quảng cáo. Fast mode dùng Windsurf free → user được giá trị ngay không cần key → conversion funnel sang deep (paid).

**Option B (safe):** Bỏ Windsurf backend hoàn toàn. Fast mode cũng qua router bạn nhưng dùng model rẻ (Haiku). Chi phí bạn ~$0.005/query cho fast. An toàn pháp lý 100%.

→ **Chọn Option A cho MVP** (validate nhanh). Chuyển sang B sau nếu cần.

### Task 1.4: README mới (marketing-oriented)

```markdown
# Chainlens Code Search

AI-powered semantic code search for your IDE.
Ask your codebase questions in plain language. Get precise file + line answers.

## Quick Start (30 seconds)

1. Get your free API key: https://codesearch.chainlens.net/signup
2. Add to your IDE:

### Kiro / Claude Desktop / Cursor
{
  "code-search": {
    "command": "npx",
    "args": ["-y", "@chainlens/code-search"],
    "env": { "FC_DEEP_API_KEY": "your-key-here" }
  }
}

## Features

| Mode | Speed | Quality | Cost |
|------|-------|---------|------|
| fast_context_search | ~3s | Good | Free (no key needed) |
| deep_context_search | ~20s | Excellent (100% accuracy) | API key required |

## Pricing
- Free: fast mode unlimited + 20 deep queries/day
- Pro ($15/mo): unlimited deep queries, priority routing
```

---

## Ngày 2: Backend (9router tiering)

### Task 2.1: API key tiering trong 9router

Bạn cần phân biệt `free key` vs `pro key` ở tầng 9router. 2 cách:

**Cách đơn giản (recommend cho MVP):**
- Tạo 2 loại key prefix: `fc-free-xxx` và `fc-pro-xxx`
- 9router check prefix → áp rate limit khác nhau:
  - `fc-free-*`: 20 requests/ngày
  - `fc-pro-*`: unlimited (hoặc 5000/ngày)

**Cách DB (Phase 2):**
- Key lookup trong DB → get tier → enforce quota
- Cần thêm middleware vào 9router

### Task 2.2: Signup endpoint

Tối thiểu cho MVP:

```
POST https://router.chainlens.net/api/signup
Body: { "email": "user@example.com" }
Response: { "api_key": "fc-free-abc123", "tier": "free" }
```

Hoặc đơn giản hơn: Google Form / Typeform → bạn tự generate key → email cho user. Manual nhưng đủ validate demand.

### Task 2.3: Rate limit enforcement

9router đã có rate limiter (bạn gặp 429 trong benchmark). Cần config:

```
fc-free-* keys: 20 requests/day (reset midnight UTC)
fc-pro-* keys: no limit (hoặc 5000/day safety cap)
```

---

## Ngày 3: Publish + Landing page

### Task 3.1: Publish npm package

```bash
# Tạo repo mới (private)
gh repo create deptrai/chainlens-code-search --private

# Copy source (bỏ file internal: 9ROUTER_BUG_REPORT, SONNET_ISSUES, _bmad-output)
# Chỉ giữ: src/, package.json, README.md, LICENSE, .github/

# Publish
npm publish --access public
```

### Task 3.2: Landing page (tối thiểu)

1 trang tại `https://codesearch.chainlens.net` — có thể dùng bất kỳ:
- Vercel + Next.js (nhanh)
- GitHub Pages + static HTML (free)
- Hoặc 1 route trên 9router dashboard

**Nội dung trang:**
- Hero: "Ask your code anything. Get answers in seconds."
- 3-step setup (30 giây)
- Pricing table (Free vs Pro)
- "Get API Key" button → signup form
- MCP config snippet (copy button)
- Demo GIF/video

### Task 3.3: Test end-to-end

```bash
# Simulate user journey:
# 1. Get key (manual hoặc qua endpoint)
# 2. Install
npx @chainlens/code-search
# 3. Config trong Kiro
# 4. Test fast (free, no key needed)
# 5. Test deep (với key)
# 6. Test rate limit (hit 20/day trên free key)
```

---

## Checklist MVP Done

- [ ] Package published dưới brand riêng (`@chainlens/code-search`)
- [ ] Deep mode mặc định trỏ `router.chainlens.net` 
- [ ] Không có key → hiển thị signup URL (không crash)
- [ ] Free key: fast unlimited + deep 20/day
- [ ] Pro key: unlimited deep
- [ ] Rate limit hoạt động (free key bị 429 sau 20 deep queries)
- [ ] Landing page live với signup + pricing + config snippet
- [ ] README hướng dẫn đủ rõ cho user mới (30s setup)
- [ ] End-to-end test: install → config → fast query → deep query → rate limit

---

## Sau MVP: Metrics cần theo dõi

| Metric | Tool | Target tuần 1 |
|---|---|---|
| Signups | Form/DB | 20+ |
| npm installs | npm stats | 50+ |
| Queries/day (free) | 9router logs | Growing |
| Conversion free→pro | Manual track | 5-10% |
| Churn (pro cancel) | Stripe | <10%/mo |

---

## Decision Log

- **Brand:** `@chainlens/code-search` (bạn own org chainlens)
- **Pricing:** Free (fast unlimited + deep 20/day) / Pro $15/mo (deep unlimited)
- **Windsurf backend:** Giữ cho fast mode (free, validate nhanh). Nếu Devin chặn → chuyển Haiku qua router.
- **Signup MVP:** Đơn giản nhất có thể (form/endpoint). Không cần full auth system cho tuần 1.
- **Repo:** Private. Không open source (bảo vệ business logic + combo model config).
